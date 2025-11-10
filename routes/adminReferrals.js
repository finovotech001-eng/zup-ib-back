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

    // Build safe name/phone expressions depending on existing columns in "User"
    const colRes = await query(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('User','user')`);
    const cols = new Set((colRes.rows || []).map(r => r.column_name));
    const ref = (alias, c) => (/[A-Z]/.test(c) ? `${alias}."${c}"` : `${alias}.${c}`);

    const namePartsU = [];
    if (cols.has('name')) namePartsU.push(ref('u','name'));
    if (cols.has('full_name')) namePartsU.push(ref('u','full_name'));
    const fl1 = [];
    if (cols.has('first_name')) fl1.push(ref('u','first_name'));
    if (cols.has('last_name')) fl1.push(`' ' || ${ref('u','last_name')}`);
    if (fl1.length) namePartsU.push(`${fl1.join(' || ')}`);
    const fl2 = [];
    if (cols.has('firstName')) fl2.push(ref('u','firstName'));
    if (cols.has('lastName')) fl2.push(`' ' || ${ref('u','lastName')}`);
    if (fl2.length) namePartsU.push(`${fl2.join(' || ')}`);
    const traderNameExpr = namePartsU.length ? `COALESCE(${namePartsU.join(', ')})` : 'NULL';

    const phoneCandidates = ['phone','phone_number','phonenumber','mobile','mobile_number','contact_number'];
    const phoneListU = phoneCandidates.filter(c => cols.has(c)).map(c => ref('u', c));
    const phoneListUR = phoneCandidates.filter(c => cols.has(c)).map(c => ref('ur', c));
    const traderPhoneExpr = phoneListU.length ? `COALESCE(${phoneListU.join(', ')})` : 'NULL';
    const refPhoneExpr = phoneListUR.length ? `COALESCE(${phoneListUR.join(', ')})` : 'NULL';

    const sql = `
      SELECT 
        r.id AS ref_id,
        r.ib_request_id,
        r.user_id,
        r.email AS trader_email,
        ${traderNameExpr} AS trader_name,
        ${traderPhoneExpr} AS trader_phone,
        r.referral_code,
        r.source,
        r.created_at,
        ib.full_name AS referred_by_name,
        ib.email AS referred_by_email,
        ${refPhoneExpr} AS referred_by_phone,
        ib.referral_code AS referred_by_code
      FROM ib_referrals r
      JOIN ib_requests ib ON ib.id = r.ib_request_id
      LEFT JOIN "User" u ON (u.id::text = r.user_id)
      LEFT JOIN "User" ur ON (LOWER(ur.email) = LOWER(ib.email))
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
