import express from 'express';
import { authenticateAdminToken } from './adminAuth.js';
import { query } from '../config/database.js';

const router = express.Router();

// GET /api/admin/traders?search=&page=&limit=
router.get('/traders', authenticateAdminToken, async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const offset = (page - 1) * limit;

    const params = [];
    let where = '';
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      params.push(`%${search.toLowerCase()}%`);
      params.push(`%${search.toLowerCase()}%`);
      where = `WHERE LOWER(r.email) LIKE $1 OR LOWER(ib.full_name) LIKE $2 OR LOWER(ib.referral_code) LIKE $3`;
    }

    const sql = `
      SELECT r.id AS ref_id, r.ib_request_id, r.user_id, r.email AS trader_email,
             r.referral_code, r.source, r.created_at,
             ib.full_name AS referred_by_name, ib.email AS referred_by_email, ib.referral_code AS referred_by_code
      FROM ib_referrals r
      JOIN ib_requests ib ON ib.id = r.ib_request_id
      ${where}
      ORDER BY r.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const rows = await query(sql, params);

    // Count for pagination
    const countSql = `SELECT COUNT(*)::int AS cnt FROM ib_referrals r JOIN ib_requests ib ON ib.id = r.ib_request_id ${where}`;
    const countRes = await query(countSql, params);
    const total = Number(countRes.rows?.[0]?.cnt || 0);

    res.json({ success: true, data: { items: rows.rows, page, limit, total } });
  } catch (e) {
    console.error('Admin traders list error:', e);
    res.status(500).json({ success: false, message: 'Unable to fetch traders' });
  }
});

export default router;

