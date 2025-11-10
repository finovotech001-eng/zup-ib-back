import express from 'express';
import { authenticateToken } from './auth.js';
import { query } from '../config/database.js';
import { IBWithdrawal } from '../models/IBWithdrawal.js';

const router = express.Router();

router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;
    
    // Get IB request by email
    const ibResult = await query(
      `SELECT id, full_name, email, referral_code, ib_type, approved_at 
       FROM ib_requests 
       WHERE LOWER(email) = LOWER($1) AND status = 'approved'`,
      [userEmail]
    );
    
    if (ibResult.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          balance: 0,
          totalProfit: 0,
          commissionStructures: [],
          referralCode: null,
          referralLink: null
        }
      });
    }
    
    const ib = ibResult.rows[0];
    
    // Get commission structures (groups) - same as commission-analytics
    const groupsResult = await query(
      `SELECT group_id, group_name, structure_name, usd_per_lot, spread_share_percentage
       FROM ib_group_assignments
       WHERE ib_request_id = $1`,
      [ib.id]
    );
    
    // Use same earning logic as Overview/Analytics (approved groups + real accounts)
    const summary = await IBWithdrawal.getSummary(ib.id, { periodDays: Number(process.env.DASHBOARD_PERIOD_DAYS || 30) });
    const balance = Number(summary?.totalEarned || 0);
    const fixedCommission = Number(summary?.fixedEarned || 0);
    const spreadCommission = Number(summary?.spreadEarned || 0);
    
    // Get referral link
    const referralLink = ib.referral_code 
      ? `${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?referralCode=${ib.referral_code}`
      : null;
    
    // Format commission structures
    const structures = groupsResult.rows.map(g => ({
      groupId: g.group_id,
      groupName: g.group_name,
      name: g.structure_name,
      usdPerLot: Number(g.usd_per_lot || 0),
      spreadShare: Number(g.spread_share_percentage || 0)
    }));
    
    res.json({
      success: true,
      data: {
        balance,
        totalProfit: balance,
        fixedCommission,
        spreadCommission,
        ibType: ib.ib_type,
        commissionStructures: structures,
        referralCode: ib.referral_code,
        referralLink,
        approvedDate: ib.approved_at
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch dashboard data'
    });
  }
});

export default router;

// Quick reports: day-wise IB commission and registrations with range filters
router.get('/quick-reports', authenticateToken, async (req, res) => {
  try {
    const email = req.user.email;
    const ibRes = await query('SELECT id, approved_at FROM ib_requests WHERE LOWER(email)=LOWER($1) AND status = \"approved\"', [email]);
    if (!ibRes.rows.length) return res.json({ success: true, data: { commission: [], registrations: [] } });
    const ibId = ibRes.rows[0].id;

    const range = String(req.query.range || 'month').toLowerCase();
    const now = new Date();
    let from = req.query.from ? new Date(req.query.from) : null;
    let to = req.query.to ? new Date(req.query.to) : now;
    if (!from || isNaN(from.getTime())) {
      if (range === 'day') from = new Date(now.getTime() - 1 * 24*60*60*1000);
      else if (range === 'week') from = new Date(now.getTime() - 7 * 24*60*60*1000);
      else if (range === 'year') from = new Date(now.getTime() - 365 * 24*60*60*1000);
      else from = new Date(now.getTime() - 30 * 24*60*60*1000); // month default
    }

    // Build approved group map for spread share calculation
    const assignments = await query(
      `SELECT group_id, group_name, spread_share_percentage
       FROM ib_group_assignments WHERE ib_request_id = $1`,
      [ibId]
    );
    const norm = (gid) => {
      if (!gid) return '';
      const s = String(gid).toLowerCase();
      const parts = s.split(/[\\/]/);
      return parts[parts.length-1] || s;
    };
    const spreadPct = new Map();
    for (const r of assignments.rows) {
      const keys = [String(r.group_id||'').toLowerCase(), String(r.group_name||'').toLowerCase(), norm(r.group_id)];
      for (const k of keys) { if (k) spreadPct.set(k, Number(r.spread_share_percentage || 0)); }
    }

    // Commission per day: aggregate lots and fixed by day and group then compute spread by JS to honor normalized match
    const trades = await query(
      `SELECT date_trunc('day', synced_at)::date AS day, group_id,
              COALESCE(SUM(volume_lots),0) AS lots,
              COALESCE(SUM(ib_commission),0) AS fixed
       FROM ib_trade_history
       WHERE ib_request_id = $1
         AND close_price IS NOT NULL AND close_price != 0 AND profit != 0
         AND synced_at >= $2 AND synced_at <= $3
       GROUP BY day, group_id
       ORDER BY day`,
      [ibId, from.toISOString(), to.toISOString()]
    );
    const byDay = new Map();
    for (const r of trades.rows) {
      const k = norm(r.group_id) || String(r.group_id || '').toLowerCase();
      const pct = spreadPct.get(k) || 0;
      const spread = Number(r.lots || 0) * (pct / 100);
      const fixed = Number(r.fixed || 0);
      const key = String(r.day);
      const prev = byDay.get(key) || { day: key, fixed: 0, spread: 0, total: 0 };
      prev.fixed += fixed; prev.spread += spread; prev.total += (fixed + spread);
      byDay.set(key, prev);
    }
    const commissionSeries = Array.from(byDay.values()).sort((a,b)=> new Date(a.day)-new Date(b.day));

    // Registrations per day (referrals)
    const regs = await query(
      `SELECT date_trunc('day', submitted_at)::date AS day, COUNT(*)::int AS count
       FROM ib_requests
       WHERE referred_by = $1 AND submitted_at >= $2 AND submitted_at <= $3
       GROUP BY day ORDER BY day`,
      [ibId, from.toISOString(), to.toISOString()]
    );
    const registrationSeries = regs.rows.map(r => ({ day: String(r.day), count: Number(r.count || 0) }));

    res.json({ success: true, data: { commission: commissionSeries, registrations: registrationSeries } });
  } catch (e) {
    console.error('Quick reports error:', e);
    res.status(500).json({ success: false, message: 'Unable to fetch quick reports' });
  }
});
