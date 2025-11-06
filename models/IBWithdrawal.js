import { query } from '../config/database.js';

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

  static async getSummary(ibRequestId) {
    // Compute earnings only from approved groups and include spread share
    try {
      // Fetch group assignments (approved groups for this IB)
      const assignmentsRes = await query(
        `SELECT group_id, spread_share_percentage
         FROM ib_group_assignments WHERE ib_request_id = $1`,
        [ibRequestId]
      );

      // Helper to normalize a group id/path
      const normalize = (gid) => {
        if (!gid) return '';
        const s = String(gid).toLowerCase().trim();
        const parts = s.split(/[\\/]/);
        return parts[parts.length - 1] || s;
      };

      const approvedMap = assignmentsRes.rows.reduce((m, r) => {
        const k = normalize(r.group_id);
        if (!k) return m;
        m[k] = Number(r.spread_share_percentage || 0);
        return m;
      }, {});

      let fixed = 0;
      let spread = 0;

      if (Object.keys(approvedMap).length) {
        // Aggregate trades by group id
        const tradesRes = await query(
          `SELECT group_id, COALESCE(SUM(volume_lots),0) AS lots, COALESCE(SUM(ib_commission),0) AS fixed
           FROM ib_trade_history 
           WHERE ib_request_id = $1 AND close_price IS NOT NULL AND close_price != 0 AND profit != 0
           GROUP BY group_id`,
          [ibRequestId]
        );
        for (const row of tradesRes.rows) {
          const k = normalize(row.group_id);
          if (!approvedMap[k]) continue; // skip non-approved groups
          const lots = Number(row.lots || 0);
          const f = Number(row.fixed || 0);
          const pct = approvedMap[k] / 100;
          fixed += f;
          spread += lots * pct;
        }
      }

      const totalEarned = fixed + spread;

      const totalPaidRes = await query(
        `SELECT COALESCE(SUM(amount),0) AS total_paid
         FROM ib_withdrawal_requests WHERE ib_request_id = $1 AND LOWER(status) IN ('paid','completed')`,
        [ibRequestId]
      );
      const pendingRes = await query(
        `SELECT COALESCE(SUM(amount),0) AS pending
         FROM ib_withdrawal_requests WHERE ib_request_id = $1 AND LOWER(status) = 'pending'`,
        [ibRequestId]
      );

      const totalPaid = Number(totalPaidRes.rows[0]?.total_paid || 0);
      const pending = Number(pendingRes.rows[0]?.pending || 0);
      const available = Math.max(totalEarned - totalPaid - pending, 0);

      return { totalEarned, totalPaid, pending, available };
    } catch (e) {
      // Fallback to original logic if the above fails
      const totalEarnedRes = await query(
        `SELECT COALESCE(SUM(ib_commission),0) AS total_earned
         FROM ib_trade_history WHERE ib_request_id = $1`,
        [ibRequestId]
      );
      const totalPaidRes = await query(
        `SELECT COALESCE(SUM(amount),0) AS total_paid
         FROM ib_withdrawal_requests WHERE ib_request_id = $1 AND LOWER(status) IN ('paid','completed')`,
        [ibRequestId]
      );
      const pendingRes = await query(
        `SELECT COALESCE(SUM(amount),0) AS pending
         FROM ib_withdrawal_requests WHERE ib_request_id = $1 AND LOWER(status) = 'pending'`,
        [ibRequestId]
      );
      const totalEarned = Number(totalEarnedRes.rows[0]?.total_earned || 0);
      const totalPaid = Number(totalPaidRes.rows[0]?.total_paid || 0);
      const pending = Number(pendingRes.rows[0]?.pending || 0);
      const available = Math.max(totalEarned - totalPaid - pending, 0);
      return { totalEarned, totalPaid, pending, available };
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
