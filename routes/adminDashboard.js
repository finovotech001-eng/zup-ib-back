import express from 'express';
import { authenticateAdminToken } from './adminAuth.js';
import { query } from '../config/database.js';

const router = express.Router();

// Helper to coerce a numeric from a row value
const num = (v) => Number(v || 0);

// GET /api/admin/dashboard/summary
router.get('/summary', authenticateAdminToken, async (req, res) => {
  try {
    const [ibTotals, lotsTotals, withdrawTotals] = await Promise.all([
      query(`
        SELECT 
          COUNT(*)::int AS total_ibs,
          COUNT(*) FILTER (WHERE LOWER(TRIM(status)) = 'approved')::int AS active_ibs
        FROM ib_requests
      `),
      query(`
        SELECT 
          COALESCE(SUM(volume_lots),0) AS lots,
          COALESCE(SUM(ib_commission),0) AS commission
        FROM ib_trade_history
        WHERE close_price IS NOT NULL AND close_price != 0 AND profit != 0
      `),
      query(`
        SELECT 
          COALESCE(SUM(amount),0) AS total_withdrawal,
          COALESCE(SUM(amount) FILTER (WHERE LOWER(status) = 'pending'),0) AS withdrawal_pending,
          COALESCE(SUM(amount) FILTER (WHERE LOWER(status) IN ('paid','completed')),0) AS commission_paid
        FROM ib_withdrawal_requests
      `)
    ]);

    const totalIBs = Number(ibTotals.rows?.[0]?.total_ibs || 0);
    const activeIBs = Number(ibTotals.rows?.[0]?.active_ibs || 0);
    const overallLotsTraded = num(lotsTotals.rows?.[0]?.lots);
    const totalCommissionGenerated = num(lotsTotals.rows?.[0]?.commission);
    const totalWithdrawal = num(withdrawTotals.rows?.[0]?.total_withdrawal);
    const withdrawalPending = num(withdrawTotals.rows?.[0]?.withdrawal_pending);
    const totalCommissionPaid = num(withdrawTotals.rows?.[0]?.commission_paid);

    // Approximate traded notional volume in USD (1 lot ≈ 100k)
    const totalVolumeUSD = overallLotsTraded * 100000;
    const totalRevenue = totalCommissionGenerated; // treat IB commission as revenue for dashboard

    res.json({
      success: true,
      data: {
        totalIBs,
        activeIBs,
        totalVolume: totalVolumeUSD,
        totalRevenue,
        totalCommissionGenerated,
        totalCommissionPaid,
        withdrawalPending,
        totalWithdrawal,
        overallLotsTraded
      }
    });
  } catch (error) {
    console.error('Admin dashboard summary error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch dashboard summary' });
  }
});

// GET /api/admin/dashboard/activity/recent
router.get('/activity/recent', authenticateAdminToken, async (req, res) => {
  try {
    const result = await query(
      `
        SELECT id, full_name, email, status, approved_at, submitted_at
        FROM ib_requests
        ORDER BY COALESCE(approved_at, submitted_at) DESC
        LIMIT 10
      `
    );

    const activities = result.rows.map((row) => ({
      id: row.id,
      type: (row.status || '').toLowerCase().trim() === 'approved' ? 'ib_approved' : `ib_${(row.status || '').toLowerCase().trim()}`,
      message:
        (row.status || '').toLowerCase().trim() === 'approved'
          ? `IB approved: ${row.full_name || row.email}`
          : `IB ${row.status}: ${row.full_name || row.email}`,
      timestamp: (row.approved_at || row.submitted_at || new Date()).toISOString(),
      icon: (row.status || '').toLowerCase().trim() === 'approved' ? 'green' : (row.status || '').toLowerCase().trim() === 'rejected' ? 'red' : 'blue'
    }));

    res.json({ success: true, data: { activities } });
  } catch (error) {
    console.error('Admin dashboard recent activity error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch recent activity' });
  }
});

export default router;

