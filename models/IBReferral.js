import { query } from '../config/database.js';

export class IBReferral {
  static async createTable() {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS ib_referrals (
          id SERIAL PRIMARY KEY,
          ib_request_id INTEGER NOT NULL REFERENCES ib_requests(id) ON DELETE CASCADE,
          user_id INTEGER REFERENCES "User"(id) ON DELETE SET NULL,
          email TEXT NOT NULL,
          referral_code VARCHAR(16) NOT NULL,
          source TEXT DEFAULT 'crm',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Unique index to keep one row per IB + email (case-insensitive)
      await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_ib_referrals_ib_email
          ON ib_referrals (ib_request_id, LOWER(email));
      `);

      // Helpful indexes
      await query(`CREATE INDEX IF NOT EXISTS ix_ib_referrals_ib ON ib_referrals (ib_request_id);`);
      await query(`CREATE INDEX IF NOT EXISTS ix_ib_referrals_user ON ib_referrals (user_id);`);
      await query(`CREATE INDEX IF NOT EXISTS ix_ib_referrals_code ON ib_referrals (referral_code);`);
    } catch (e) {
      console.error('IBReferral.createTable error:', e.message);
    }
  }

  static async resolveReferralCode(referralCode) {
    const code = String(referralCode || '').trim().toUpperCase();
    if (!code) return null;
    const res = await query(
      `SELECT id, full_name, email, status FROM ib_requests WHERE referral_code = $1`,
      [code]
    );
    const row = res.rows[0];
    if (!row || String(row.status).toLowerCase().trim() !== 'approved') return null;
    return { id: row.id, name: row.full_name, email: row.email };
  }

  // Upsert a referral row by email for a given IB (id resolved from code)
  static async attachByEmail({ referralCode, email, source = 'crm' }) {
    const ref = await IBReferral.resolveReferralCode(referralCode);
    if (!ref) return { ok: false, reason: 'invalid_code' };
    const cleanEmail = String(email || '').trim();
    if (!cleanEmail) return { ok: false, reason: 'invalid_email' };

    // Try to resolve user_id immediately if the user already exists
    const ures = await query('SELECT id FROM "User" WHERE LOWER(email) = LOWER($1) LIMIT 1', [cleanEmail]);
    const userId = ures.rows[0]?.id || null;

    const sql = `
      INSERT INTO ib_referrals (ib_request_id, user_id, email, referral_code, source)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (ib_request_id, LOWER(email))
      DO UPDATE SET user_id = COALESCE(EXCLUDED.user_id, ib_referrals.user_id), source = EXCLUDED.source
      RETURNING *
    `;
    const result = await query(sql, [ref.id, userId, cleanEmail, String(referralCode).toUpperCase(), source]);
    return { ok: true, referral: result.rows[0], ib: ref };
  }

  static async listReferredUsers(ibRequestId) {
    const res = await query('SELECT * FROM ib_referrals WHERE ib_request_id = $1', [ibRequestId]);
    return res.rows;
  }
}

