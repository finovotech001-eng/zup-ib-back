import express from 'express';
import { authenticateToken } from './auth.js';
import { query } from '../config/database.js';
import { IBWithdrawal } from '../models/IBWithdrawal.js';
import { IBCommission } from '../models/IBCommission.js';

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
          totalEarning: 0,
          totalEarnings: 0,
          fixedCommission: 0,
          spreadCommission: 0,
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
    
    // Helper: Get IB's own user_id to exclude
    const getIBUserId = async (ibId) => {
      try {
        const ibRes = await query('SELECT email FROM ib_requests WHERE id = $1', [ibId]);
        if (ibRes.rows.length === 0) return null;
        const userRes = await query('SELECT id FROM "User" WHERE email = $1', [ibRes.rows[0].email]);
        return userRes.rows.length > 0 ? String(userRes.rows[0].id) : null;
      } catch {
        return null;
      }
    };

    // Helper: Get list of referred user_ids (from ib_referrals and ib_requests)
    const getReferredUserIds = async (ibId) => {
      const userIds = new Set();
      try {
        // Get user_ids from ib_referrals
        const refRes = await query(
          'SELECT user_id FROM ib_referrals WHERE ib_request_id = $1 AND user_id IS NOT NULL',
          [ibId]
        );
        refRes.rows.forEach(row => {
          if (row.user_id) userIds.add(String(row.user_id));
        });

        // Get user_ids from ib_requests where referred_by = ibId
        const ibRefRes = await query(
          `SELECT u.id as user_id 
           FROM ib_requests ir
           JOIN "User" u ON u.email = ir.email
           WHERE ir.referred_by = $1 AND u.id IS NOT NULL`,
          [ibId]
        );
        ibRefRes.rows.forEach(row => {
          if (row.user_id) userIds.add(String(row.user_id));
        });
      } catch (error) {
        console.error('Error getting referred user IDs:', error);
      }
      return Array.from(userIds);
    };

    // Get IB's user_id for ib_commission table
    const ibUserResult = await query('SELECT id FROM "User" WHERE LOWER(email) = LOWER($1)', [ib.email]);
    const ibUserId = ibUserResult.rows[0]?.id ? String(ibUserResult.rows[0].id) : null;

    // Always calculate commission from trade history to ensure fresh data
    // Then update the database with the calculated values
    let balance = 0;
    let fixedCommission = 0;
    let spreadCommission = 0;
    
    // Get IB's own user_id to exclude
    const ibUserIdForExclusion = await getIBUserId(ib.id);
    // Get referred user_ids to include
    const referredUserIds = await getReferredUserIds(ib.id);

    // Always calculate from trades (don't use cache) to ensure accuracy
    if (referredUserIds.length > 0) {
        // Build WHERE clause to exclude IB's own trades and only include referred users' trades
        let userFilter = '';
        const params = [ib.id];
        if (ibUserIdForExclusion) {
          params.push(ibUserIdForExclusion);
          userFilter = `AND user_id != $${params.length}`;
        }
        params.push(referredUserIds);
        const userInClause = `AND user_id = ANY($${params.length}::text[])`;

        // Get approved groups map for spread calculation
        const normalize = (gid) => {
          if (!gid) return '';
          const s = String(gid).toLowerCase().trim();
          const parts = s.split(/[\\/]/);
          return parts[parts.length - 1] || s;
        };
        const approvedMap = new Map();
        for (const row of groupsResult.rows) {
          const keys = [
            String(row.group_id || '').toLowerCase(),
            String(row.group_name || '').toLowerCase(),
            normalize(row.group_id)
          ].filter(k => k);
          for (const k of keys) {
            approvedMap.set(k, {
              spreadSharePercentage: Number(row.spread_share_percentage || 0),
              usdPerLot: Number(row.usd_per_lot || 0)
            });
          }
        }

        // Fetch trades from referred users only
        const tradesRes = await query(
          `SELECT 
             group_id,
             COALESCE(SUM(volume_lots), 0) AS total_volume_lots,
             COALESCE(SUM(ib_commission), 0) AS total_ib_commission
           FROM ib_trade_history
           WHERE ib_request_id = $1 
             AND close_price IS NOT NULL 
             AND close_price != 0 
             AND profit != 0
             ${userFilter}
             ${userInClause}
           GROUP BY group_id`,
          params
        );

        // Calculate fixed and spread commission
        for (const row of tradesRes.rows) {
          const groupId = row.group_id || '';
          const normGroup = normalize(groupId);
          const assignment = approvedMap.get(normGroup) || approvedMap.get(String(groupId).toLowerCase()) || { spreadSharePercentage: 0, usdPerLot: 0 };
          
          const lots = Number(row.total_volume_lots || 0);
          const fixed = Number(row.total_ib_commission || 0);
          const spread = lots * (assignment.spreadSharePercentage / 100);
          
          fixedCommission += fixed;
          spreadCommission += spread;
        }
      }

    balance = fixedCommission + spreadCommission;

    // Always save/update commission in ib_commission table with fresh calculated values
    if (ibUserId) {
      try {
        // Calculate total trades and lots for complete data
        let totalTrades = 0;
        let totalLots = 0;
        if (referredUserIds.length > 0) {
          let userFilter = '';
          const params = [ib.id];
          if (ibUserIdForExclusion) {
            params.push(ibUserIdForExclusion);
            userFilter = `AND user_id != $${params.length}`;
          }
          params.push(referredUserIds);
          const userInClause = `AND user_id = ANY($${params.length}::text[])`;
          
          const statsRes = await query(
            `SELECT COUNT(*)::int AS total_trades, COALESCE(SUM(volume_lots), 0) AS total_lots
             FROM ib_trade_history
             WHERE ib_request_id = $1 
               AND close_price IS NOT NULL 
               AND close_price != 0 
               AND profit != 0
               ${userFilter}
               ${userInClause}`,
            params
          );
          
          if (statsRes.rows.length > 0) {
            totalTrades = Number(statsRes.rows[0].total_trades || 0);
            totalLots = Number(statsRes.rows[0].total_lots || 0);
          }
        }
        
        await IBCommission.upsertCommission(ib.id, ibUserId, {
          totalCommission: balance,
          fixedCommission: fixedCommission,
          spreadCommission: spreadCommission,
          totalTrades: totalTrades,
          totalLots: totalLots
        });
        console.log(`[Dashboard] Updated ib_commission table: total=${balance}, fixed=${fixedCommission}, spread=${spreadCommission}`);
      } catch (error) {
        console.error('Error saving commission to ib_commission table:', error);
        // Don't fail the request if table doesn't exist yet
      }
    }
    
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
        totalEarning: balance, // Add totalEarning field for clarity
        totalEarnings: balance, // Alternative field name
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
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch dashboard data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// POST /api/user/dashboard/sync - Force sync commission data
router.post('/sync', authenticateToken, async (req, res) => {
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
        success: false,
        message: 'IB profile not found'
      });
    }
    
    const ib = ibResult.rows[0];
    
    // Helper: Get IB's own user_id to exclude
    const getIBUserId = async (ibId) => {
      try {
        const ibRes = await query('SELECT email FROM ib_requests WHERE id = $1', [ibId]);
        if (ibRes.rows.length === 0) return null;
        const userRes = await query('SELECT id FROM "User" WHERE email = $1', [ibRes.rows[0].email]);
        return userRes.rows.length > 0 ? String(userRes.rows[0].id) : null;
      } catch {
        return null;
      }
    };

    // Helper: Get list of referred user_ids (from ib_referrals and ib_requests)
    const getReferredUserIds = async (ibId) => {
      const userIds = new Set();
      try {
        // Get user_ids from ib_referrals
        const refRes = await query(
          'SELECT user_id FROM ib_referrals WHERE ib_request_id = $1 AND user_id IS NOT NULL',
          [ibId]
        );
        refRes.rows.forEach(row => {
          if (row.user_id) userIds.add(String(row.user_id));
        });

        // Get user_ids from ib_requests where referred_by = ibId
        const ibRefRes = await query(
          `SELECT u.id as user_id 
           FROM ib_requests ir
           JOIN "User" u ON u.email = ir.email
           WHERE ir.referred_by = $1 AND u.id IS NOT NULL`,
          [ibId]
        );
        ibRefRes.rows.forEach(row => {
          if (row.user_id) userIds.add(String(row.user_id));
        });
      } catch (error) {
        console.error('Error getting referred user IDs:', error);
      }
      return Array.from(userIds);
    };

    // Get commission structures (groups)
    const groupsResult = await query(
      `SELECT group_id, group_name, structure_name, usd_per_lot, spread_share_percentage
       FROM ib_group_assignments
       WHERE ib_request_id = $1`,
      [ib.id]
    );

    // Get IB's user_id for ib_commission table
    const ibUserResult = await query('SELECT id FROM "User" WHERE LOWER(email) = LOWER($1)', [ib.email]);
    const ibUserId = ibUserResult.rows[0]?.id ? String(ibUserResult.rows[0].id) : null;

    // Get IB's own user_id to exclude
    const ibUserIdForExclusion = await getIBUserId(ib.id);
    // Get referred user_ids to include
    const referredUserIds = await getReferredUserIds(ib.id);

    // Calculate commission from referred users' trades only (excluding IB's own trades)
    let balance = 0;
    let fixedCommission = 0;
    let spreadCommission = 0;

    if (referredUserIds.length > 0) {
      // Build WHERE clause to exclude IB's own trades and only include referred users' trades
      let userFilter = '';
      const params = [ib.id];
      if (ibUserIdForExclusion) {
        params.push(ibUserIdForExclusion);
        userFilter = `AND user_id != $${params.length}`;
      }
      params.push(referredUserIds);
      const userInClause = `AND user_id = ANY($${params.length}::text[])`;

      // Get approved groups map for spread calculation
      const normalize = (gid) => {
        if (!gid) return '';
        const s = String(gid).toLowerCase().trim();
        const parts = s.split(/[\\/]/);
        return parts[parts.length - 1] || s;
      };
      const approvedMap = new Map();
      for (const row of groupsResult.rows) {
        const keys = [
          String(row.group_id || '').toLowerCase(),
          String(row.group_name || '').toLowerCase(),
          normalize(row.group_id)
        ].filter(k => k);
        for (const k of keys) {
          approvedMap.set(k, {
            spreadSharePercentage: Number(row.spread_share_percentage || 0),
            usdPerLot: Number(row.usd_per_lot || 0)
          });
        }
      }

      // Fetch trades from referred users only
      const tradesRes = await query(
        `SELECT 
           group_id,
           COALESCE(SUM(volume_lots), 0) AS total_volume_lots,
           COALESCE(SUM(ib_commission), 0) AS total_ib_commission
         FROM ib_trade_history
         WHERE ib_request_id = $1 
           AND close_price IS NOT NULL 
           AND close_price != 0 
           AND profit != 0
           ${userFilter}
           ${userInClause}
         GROUP BY group_id`,
        params
      );

      // Calculate fixed and spread commission
      for (const row of tradesRes.rows) {
        const groupId = row.group_id || '';
        const normGroup = normalize(groupId);
        const assignment = approvedMap.get(normGroup) || approvedMap.get(String(groupId).toLowerCase()) || { spreadSharePercentage: 0, usdPerLot: 0 };
        
        const lots = Number(row.total_volume_lots || 0);
        const fixed = Number(row.total_ib_commission || 0);
        const spread = lots * (assignment.spreadSharePercentage / 100);
        
        fixedCommission += fixed;
        spreadCommission += spread;
      }
    }

    balance = fixedCommission + spreadCommission;

    // Save/update commission in ib_commission table
    if (ibUserId) {
      try {
        await IBCommission.upsertCommission(ib.id, ibUserId, {
          totalCommission: balance,
          fixedCommission: fixedCommission,
          spreadCommission: spreadCommission
        });
      } catch (error) {
        console.error('Error saving commission to ib_commission table:', error);
        return res.status(500).json({
          success: false,
          message: 'Error saving commission data'
        });
      }
    }

    res.json({
      success: true,
      message: 'Commission synced successfully',
      data: {
        balance,
        totalProfit: balance,
        totalEarning: balance,
        totalEarnings: balance,
        fixedCommission,
        spreadCommission
      }
    });
  } catch (error) {
    console.error('Error syncing commission:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to sync commission'
    });
  }
});

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

export default router;
