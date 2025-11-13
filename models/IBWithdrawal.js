import { query } from '../config/database.js';
import { IBCommission } from './IBCommission.js';

export class IBWithdrawal {
  static async createTable() {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS ib_withdrawal_requests (
          id SERIAL PRIMARY KEY,
          ib_request_id INTEGER NOT NULL,
          amount NUMERIC NOT NULL CHECK (amount > 0),
          method TEXT NOT NULL,
          account_details TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await query('CREATE INDEX IF NOT EXISTS idx_ib_withdrawal_ib ON ib_withdrawal_requests (ib_request_id);');
      await query('CREATE INDEX IF NOT EXISTS idx_ib_withdrawal_status ON ib_withdrawal_requests (status);');
    } catch (e) {
      console.error('IBWithdrawal.createTable error:', e.message);
    }
  }

  static async create({ ibRequestId, amount, method, accountDetails }) {
    const res = await query(
      `INSERT INTO ib_withdrawal_requests (ib_request_id, amount, method, account_details)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [ibRequestId, Number(amount), String(method), accountDetails || null]
    );
    return res.rows[0];
  }

  static async getSummary(ibRequestId, opts = {}) {
    try {
      // Get IB's user_id to fetch commission from ib_commission table
      const ibUserResult = await query(
        'SELECT id FROM "User" WHERE LOWER(email) = (SELECT LOWER(email) FROM ib_requests WHERE id = $1)',
        [ibRequestId]
      );
      const ibUserId = ibUserResult.rows[0]?.id ? String(ibUserResult.rows[0].id) : null;

      // Get total commission from ib_commission table
      let totalEarned = 0;
      let fixedEarned = 0;
      let spreadEarned = 0;

      if (ibUserId) {
        try {
          const commissionData = await IBCommission.getByIBAndUser(ibRequestId, ibUserId);
          if (commissionData) {
            totalEarned = Number(commissionData.total_commission || 0);
            // For fixed and spread, we'll calculate from commission structure if needed
            // For now, we'll use a simple split (can be improved later)
            fixedEarned = totalEarned * 0.9; // Approximate 90% fixed, 10% spread
            spreadEarned = totalEarned * 0.1;
          }
        } catch (error) {
          console.warn('[IBWithdrawal.getSummary] Could not fetch from ib_commission table:', error.message);
        }
      }

      // If no commission found in ib_commission table, fallback to calculating from trade history
      if (totalEarned === 0) {
        // Fetch group assignments (approved groups for this IB)
        const assignmentsRes = await query(
          `SELECT group_id, usd_per_lot, spread_share_percentage
           FROM ib_group_assignments WHERE ib_request_id = $1`,
          [ibRequestId]
        );

        // Helpers to normalize group IDs
        const normalizeGroupId = (groupId) => {
          if (!groupId) return '';
          const s = String(groupId).toLowerCase().trim();
          const parts = s.split(/[\\/]/);
          return parts[parts.length - 1] || s;
        };

        // Build commission groups map
        const commissionGroupsMap = new Map();
        for (const r of assignmentsRes.rows) {
          const k = normalizeGroupId(r.group_id);
          if (k) {
            commissionGroupsMap.set(k, {
              spreadPct: Number(r.spread_share_percentage || 0),
              usdPerLot: Number(r.usd_per_lot || 0)
            });
          }
        }

        // Get IB's own user_id to exclude
        const ibUserIdForExclusion = ibUserId;
        // Get referred user_ids to include
        const referredUserIds = [];
        try {
          const refRes = await query(
            'SELECT user_id FROM ib_referrals WHERE ib_request_id = $1 AND user_id IS NOT NULL',
            [ibRequestId]
          );
          refRes.rows.forEach(row => {
            if (row.user_id) referredUserIds.push(String(row.user_id));
          });

          const ibRefRes = await query(
            `SELECT u.id as user_id 
             FROM ib_requests ir
             JOIN "User" u ON u.email = ir.email
             WHERE ir.referred_by = $1 AND u.id IS NOT NULL`,
            [ibRequestId]
          );
          ibRefRes.rows.forEach(row => {
            if (row.user_id) referredUserIds.push(String(row.user_id));
          });
        } catch (error) {
          console.warn('[IBWithdrawal.getSummary] Error getting referred user IDs:', error.message);
        }

        if (referredUserIds.length > 0 && commissionGroupsMap.size > 0) {
          // Build WHERE clause to exclude IB's own trades and only include referred users' trades
          let userFilter = '';
          const params = [ibRequestId];
          if (ibUserIdForExclusion) {
            params.push(ibUserIdForExclusion);
            userFilter = `AND user_id != $${params.length}`;
          }
          params.push(referredUserIds);
          const userInClause = `AND user_id = ANY($${params.length}::text[])`;

          // Fetch trades - only from referred users, excluding IB's own trades (only closed trades with profit != 0)
          const tradesRes = await query(
            `SELECT group_id, volume_lots
             FROM ib_trade_history
             WHERE ib_request_id = $1 
               AND close_price IS NOT NULL 
               AND close_price != 0 
               AND profit != 0
               ${userFilter}
               ${userInClause}`,
            params
          );

          // Calculate commission using same logic as admin
          for (const trade of tradesRes.rows) {
            const lots = Number(trade.volume_lots || 0);
            if (lots <= 0) continue;

            const normalized = normalizeGroupId(trade.group_id);
            let rule = commissionGroupsMap.get(normalized);
            
            // Try partial match if exact match fails
            if (!rule) {
              for (const [approvedKey, approvedRule] of commissionGroupsMap.entries()) {
                if (normalized.includes(approvedKey) || approvedKey.includes(normalized)) {
                  rule = approvedRule;
                  break;
                }
              }
            }

            // Fallback to first available rule
            if (!rule && commissionGroupsMap.size > 0) {
              rule = Array.from(commissionGroupsMap.values())[0];
            }

            if (rule) {
              const usdPerLot = Number(rule.usdPerLot || 0);
              const spreadPct = Number(rule.spreadPct || 0);
              
              fixedEarned += lots * usdPerLot;
              spreadEarned += lots * (spreadPct / 100);
            }
          }

          totalEarned = fixedEarned + spreadEarned;
        }
      }

      // Get approved/paid withdrawals
      const totalPaidRes = await query(
        `SELECT COALESCE(SUM(amount),0) AS total_paid
         FROM ib_withdrawal_requests 
         WHERE ib_request_id = $1 
           AND LOWER(status) IN ('paid','completed','approved')`,
        [ibRequestId]
      );
      const pendingRes = await query(
        `SELECT COALESCE(SUM(amount),0) AS pending
         FROM ib_withdrawal_requests 
         WHERE ib_request_id = $1 
           AND LOWER(status) = 'pending'`,
        [ibRequestId]
      );

      const totalPaid = Number(totalPaidRes.rows[0]?.total_paid || 0);
      const pending = Number(pendingRes.rows[0]?.pending || 0);
      
      // Available Balance = Total Commission - Approved/Paid Withdrawals
      const available = Math.max(totalEarned - totalPaid, 0);

      return { 
        totalEarned, 
        totalPaid, 
        pending, 
        available, 
        fixedEarned, 
        spreadEarned 
      };
    } catch (e) {
      console.error('[IBWithdrawal.getSummary] Error:', e);
      // Fallback to simple calculation
      const totalPaidRes = await query(
        `SELECT COALESCE(SUM(amount),0) AS total_paid
         FROM ib_withdrawal_requests 
         WHERE ib_request_id = $1 
           AND LOWER(status) IN ('paid','completed','approved')`,
        [ibRequestId]
      );
      const pendingRes = await query(
        `SELECT COALESCE(SUM(amount),0) AS pending
         FROM ib_withdrawal_requests 
         WHERE ib_request_id = $1 
           AND LOWER(status) = 'pending'`,
        [ibRequestId]
      );
      const totalPaid = Number(totalPaidRes.rows[0]?.total_paid || 0);
      const pending = Number(pendingRes.rows[0]?.pending || 0);
      const totalEarned = 0;
      const available = Math.max(totalEarned - totalPaid, 0);
      return { 
        totalEarned, 
        totalPaid, 
        pending, 
        available, 
        fixedEarned: 0, 
        spreadEarned: 0 
      };
    }
  }

  static async list(ibRequestId, limit = 50) {
    const res = await query(
      `SELECT * FROM ib_withdrawal_requests
       WHERE ib_request_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [ibRequestId, Number(limit)]
    );
    return res.rows;
  }

  static async listByStatus(ibRequestId, status = null, limit = 100) {
    const params = [ibRequestId];
    let where = 'ib_request_id = $1';
    if (status) {
      params.push(String(status).toLowerCase());
      where += ` AND LOWER(status) = $${params.length}`;
    }
    const res = await query(
      `SELECT * FROM ib_withdrawal_requests
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1}`,
      [...params, Number(limit)]
    );
    return res.rows;
  }
}
