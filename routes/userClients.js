import express from 'express';
import { authenticateToken } from './auth.js';
import { query } from '../config/database.js';

const router = express.Router();

// Get clients for logged-in IB user
router.get('/', authenticateToken, async (req, res) => {
  try {
    // req.user.id is already the IB request ID from authenticateToken
    const ibRequestId = req.user.id;

    // Get current IB's details (the referrer for all clients)
    const currentIBResult = await query(
      `SELECT id, full_name, email, referral_code FROM ib_requests WHERE id = $1`,
      [ibRequestId]
    );
    const currentIB = currentIBResult.rows[0] || null;

    // Get clients referred by this IB (from ib_requests.referred_by)
    // Include all referral details from database
    const clientsResult = await query(`
      SELECT 
        ib.id as ib_id,
        ib.full_name as user_name,
        ib.email as user_email,
        ib.submitted_at,
        ib.approved_at,
        ib.ib_type,
        ib.status,
        ib.referral_code,
        ib.referred_by,
        ib.usd_per_lot,
        ib.spread_percentage_per_lot,
        COALESCE(SUM(th.volume_lots), 0) as direct_volume_lots,
        COALESCE(SUM(th.ib_commission), 0) as direct_commission,
        COUNT(DISTINCT CASE WHEN ma."accountType" = 'real' THEN ma."accountId" END) as account_count
      FROM ib_requests ib
      LEFT JOIN "User" u ON u.email = ib.email
      LEFT JOIN "MT5Account" ma ON ma."userId" = u.id
      LEFT JOIN ib_trade_history th ON th.ib_request_id = ib.id
        AND th.close_price IS NOT NULL 
        AND th.close_price != 0
        AND th.profit IS NOT NULL
        AND th.profit != 0
      WHERE ib.referred_by = $1
      GROUP BY ib.id, ib.full_name, ib.email, ib.submitted_at, ib.approved_at, 
               ib.ib_type, ib.status, ib.referral_code, ib.referred_by, 
               ib.usd_per_lot, ib.spread_percentage_per_lot
      ORDER BY ib.submitted_at DESC
    `, [ibRequestId]);

    const clients = clientsResult.rows.map(row => ({
      id: row.ib_id,
      userId: row.ib_id,
      name: row.user_name,
      email: row.user_email,
      accountId: '-',
      joinDate: row.submitted_at,
      approvedDate: row.approved_at,
      totalLots: Number(row.direct_volume_lots || 0),
      commission: Number(row.direct_commission || 0),
      accountCount: parseInt(row.account_count || 0),
      ibType: row.ib_type || 'N/A',
      status: row.status || 'pending',
      referralCode: row.referral_code || 'N/A',
      referredById: row.referred_by,
      referredByName: currentIB ? currentIB.full_name : 'You',
      referredByEmail: currentIB ? currentIB.email : null,
      referredByCode: currentIB ? currentIB.referral_code : null,
      usdPerLot: Number(row.usd_per_lot || 0),
      spreadPercentage: Number(row.spread_percentage_per_lot || 0),
      lastTrade: null
    }));

    // 2) Include CRM-referred traders from ib_referrals (non-IB clients)
    const crmResult = await query(`
      SELECT 
        r.id as ref_id,
        r.user_id,
        r.email as user_email,
        r.created_at as submitted_at,
        COUNT(DISTINCT CASE WHEN ma."accountType" = 'real' THEN ma."accountId" END) as account_count,
        COALESCE(SUM(th.volume_lots), 0) as direct_volume_lots,
        COALESCE(SUM(th.ib_commission), 0) as direct_commission
      FROM ib_referrals r
      -- Cast to text for compatibility when User.id is uuid
      LEFT JOIN "User" u ON (u.id::text = r.user_id)
      LEFT JOIN "MT5Account" ma ON ma."userId" = u.id
      LEFT JOIN ib_trade_history th ON th.ib_request_id = $1 AND th.user_id = r.user_id 
        AND th.close_price IS NOT NULL AND th.close_price != 0 AND th.profit IS NOT NULL AND th.profit != 0
      WHERE r.ib_request_id = $1
      GROUP BY r.id, r.user_id, r.email, r.created_at
      ORDER BY r.created_at DESC
    `, [ibRequestId]);

    for (const row of crmResult.rows) {
      // Avoid duplicating if the same email is already in IB applicants list
      const exists = clients.find(c => (c.email || '').toLowerCase() === (row.user_email || '').toLowerCase());
      if (exists) continue;
      clients.push({
        id: row.ref_id,
        userId: row.user_id || row.ref_id,
        name: row.user_email, // we may only have email; CRM can send name later if desired
        email: row.user_email,
        accountId: '-',
        joinDate: row.submitted_at,
        approvedDate: null,
        totalLots: Number(row.direct_volume_lots || 0),
        commission: Number(row.direct_commission || 0),
        accountCount: parseInt(row.account_count || 0),
        ibType: 'Trader',
        status: 'trader',
        referralCode: null,
        referredById: ibRequestId,
        referredByName: currentIB ? currentIB.full_name : 'You',
        referredByEmail: currentIB ? currentIB.email : null,
        referredByCode: currentIB ? currentIB.referral_code : null,
        usdPerLot: 0,
        spreadPercentage: 0,
        lastTrade: null
      });
    }

    // Get last trade date for each client
    for (const client of clients) {
      const lastTradeResult = await query(`
        SELECT MAX(synced_at) as last_trade
        FROM ib_trade_history
        WHERE ib_request_id = $1
      `, [client.userId]);

      if (lastTradeResult.rows[0]?.last_trade) {
        client.lastTrade = lastTradeResult.rows[0].last_trade;
      }
    }

    // Calculate stats
    const stats = {
      totalClients: clients.length,
      totalVolume: clients.reduce((sum, c) => sum + c.totalLots, 0),
      totalCommission: clients.reduce((sum, c) => sum + c.commission, 0),
      activeTraders: clients.filter(c => c.lastTrade !== null).length
    };

    res.json({
      success: true,
      data: {
        clients,
        stats
      }
    });
  } catch (error) {
    console.error('Error fetching user clients:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch clients',
      error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined
    });
  }
});

export default router;
