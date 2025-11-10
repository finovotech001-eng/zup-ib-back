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

  static async getSummary(ibRequestId, opts = {}) {
    const periodDays = Number(opts.periodDays || 0);
    // Compute earnings only from approved groups and include spread share
    try {
      // Fetch group assignments (approved groups for this IB)
      const assignmentsRes = await query(
        `SELECT group_id, spread_share_percentage
         FROM ib_group_assignments WHERE ib_request_id = $1`,
        [ibRequestId]
      );

      // Helpers to normalize and generate multiple matching keys for group ids
      const makeKeys = (gid) => {
        if (!gid) return [];
        const s = String(gid).trim().toLowerCase();
        const fwd = s.replace(/\\\\/g, '/');
        const bwd = s.replace(/\//g, '\\');
        const parts = s.split(/[\\\\/]/);
        const last = parts[parts.length - 1] || s;
        let afterBbook = null;
        for (let i = 0; i < parts.length; i++) {
          if (parts[i] === 'bbook' && i + 1 < parts.length) { afterBbook = parts[i + 1]; break; }
        }
        const keys = new Set([s, fwd, bwd, last]);
        if (afterBbook) keys.add(afterBbook);
        return Array.from(keys);
      };

      const approvedMap = assignmentsRes.rows.reduce((m, r) => {
        for (const k of makeKeys(r.group_id)) {
          m[k] = Number(r.spread_share_percentage || 0);
        }
        return m;
      }, {});

      let fixed = 0;
      let spread = 0;

      if (Object.keys(approvedMap).length) {
        // Resolve allowed real account IDs for this IB (from MT5Account)
        let allowed = [];
        try {
          const u = await query('SELECT id FROM "User" WHERE email = (SELECT email FROM ib_requests WHERE id = $1)', [ibRequestId]);
          if (u.rows.length) {
            const userId = u.rows[0].id;
            const acc = await query(
              `SELECT "accountId" FROM "MT5Account" 
               WHERE "userId" = $1 
                 AND (LOWER("accountType") IN ('live','real') OR LOWER(COALESCE("accountType", 'live')) IN ('live','real'))
                 AND ("package" IS NULL OR LOWER("package") NOT LIKE '%demo%')`,
              [userId]
            );
            allowed = acc.rows.map(r => String(r.accountId));
          }
        } catch {}
        // Aggregate trades by group id
        // Optional time window for earnings (e.g., last 30 days)
        const hasWindow = Number.isFinite(periodDays) && periodDays > 0;
        const whereWindow = hasWindow ? ` AND (synced_at >= NOW() - INTERVAL '${periodDays} days')` : '';
        const tradesRes = await query(
          `SELECT group_id, COALESCE(SUM(volume_lots),0) AS lots, COALESCE(SUM(ib_commission),0) AS fixed
           FROM ib_trade_history 
           WHERE ib_request_id = $1 
             AND close_price IS NOT NULL AND close_price != 0 AND profit != 0${whereWindow}
             AND (group_id IS NULL OR LOWER(group_id) NOT LIKE '%demo%')
             ${Array.isArray(allowed) && allowed.length ? 'AND account_id = ANY($2)' : ''}
           GROUP BY group_id`,
          Array.isArray(allowed) && allowed.length ? [ibRequestId, allowed] : [ibRequestId]
        );
        for (const row of tradesRes.rows) {
          // Try multiple keys derived from this trade's group id
          const candidates = makeKeys(row.group_id);
          const k = candidates.find((x) => approvedMap.hasOwnProperty(x));
          if (!k) continue; // skip non-approved groups
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

      return { totalEarned, totalPaid, pending, available, fixedEarned: fixed, spreadEarned: spread };
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
      return { totalEarned, totalPaid, pending, available, fixedEarned: totalEarned, spreadEarned: 0 };
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
