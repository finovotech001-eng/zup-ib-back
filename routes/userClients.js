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

    // Best-effort: fetch current IB phone from User table using flexible column mapping
    let currentIBPhone = null;
    if (currentIB?.email) {
      try {
        const phoneRes = await query('SELECT * FROM "User" WHERE LOWER(email) = LOWER($1) LIMIT 1', [currentIB.email]);
        if (phoneRes.rows.length) {
          const u = phoneRes.rows[0];
          currentIBPhone = u.phone || u.phone_number || u.phonenumber || u.mobile || u.mobile_number || u.contact_number || null;
        }
      } catch {}
    }

    // Get clients referred by this IB (from ib_requests.referred_by)
    // Include all referral details from database
    // Only count trades from referred users, excluding IB's own trades
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
        COALESCE(SUM(CASE WHEN th.user_id = u.id 
                          AND th.close_price IS NOT NULL 
                          AND th.close_price != 0 
                          AND th.profit != 0 
                     THEN th.volume_lots ELSE 0 END), 0) as direct_volume_lots,
        COALESCE(SUM(CASE WHEN th.user_id = u.id 
                          AND th.close_price IS NOT NULL 
                          AND th.close_price != 0 
                          AND th.profit != 0 
                     THEN th.ib_commission ELSE 0 END), 0) as direct_commission,
        COUNT(DISTINCT CASE WHEN ma."accountType" = 'real' THEN ma."accountId" END) as account_count
      FROM ib_requests ib
      LEFT JOIN "User" u ON u.email = ib.email
      LEFT JOIN "MT5Account" ma ON ma."userId" = u.id
      LEFT JOIN ib_trade_history th ON th.user_id = u.id AND th.ib_request_id = $1
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
      referredByPhone: currentIBPhone,
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
        referredByPhone: currentIBPhone,
        referredByCode: currentIB ? currentIB.referral_code : null,
        usdPerLot: 0,
        spreadPercentage: 0,
        lastTrade: null
      });
    }

    // Get last trade date for each client
    // Get IB's user_id to exclude from last trade query
    const ibUserResult = await query('SELECT id FROM "User" WHERE LOWER(email) = LOWER($1)', [currentIB?.email]);
    const ibUserId = ibUserResult.rows[0]?.id ? String(ibUserResult.rows[0].id) : null;
    
    for (const client of clients) {
      // Get user_id for this client
      const clientUserResult = await query('SELECT id FROM "User" WHERE LOWER(email) = LOWER($1)', [client.email]);
      if (clientUserResult.rows.length === 0) continue;
      const clientUserId = String(clientUserResult.rows[0].id);
      
      // Only get trades from this client (referred user), excluding IB's own trades
      let lastTradeQuery = `
        SELECT MAX(synced_at) as last_trade
        FROM ib_trade_history
        WHERE ib_request_id = $1
          AND user_id = $2
          AND close_price IS NOT NULL 
          AND close_price != 0 
          AND profit != 0
      `;
      const lastTradeParams = [ibRequestId, clientUserId];
      
      if (ibUserId && ibUserId !== clientUserId) {
        lastTradeQuery += ` AND user_id != $3`;
        lastTradeParams.push(ibUserId);
      }
      
      const lastTradeResult = await query(lastTradeQuery, lastTradeParams);

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

// Dedicated list of CRM-referred traders for the logged-in IB
router.get('/traders', authenticateToken, async (req, res) => {
  try {
    const ibRequestId = req.user.id;

    // Resolve current IB for contact details
    const ibRes = await query('SELECT id, full_name, email FROM ib_requests WHERE id = $1', [ibRequestId]);
    const currentIB = ibRes.rows[0] || null;

    // Pull traders from ib_referrals with best-effort name/phone from User
    const tradersRes = await query(`
      SELECT r.id AS ref_id, r.user_id, r.email AS trader_email, r.created_at,
             r.referral_code,
             u.*
      FROM ib_referrals r
      LEFT JOIN "User" u ON (u.id::text = r.user_id)
      WHERE r.ib_request_id = $1
      ORDER BY r.created_at DESC
    `, [ibRequestId]);

    const mapPhone = (u) => (u?.phone || u?.phone_number || u?.phonenumber || u?.mobile || u?.mobile_number || u?.contact_number || null);
    const mapName = (u) => (u?.name || u?.full_name || ((u?.first_name && u?.last_name) ? `${u.first_name} ${u.last_name}` : null) || ((u?.firstName && u?.lastName) ? `${u.firstName} ${u.lastName}` : null) || null);

    const traders = tradersRes.rows.map(r => ({
      id: r.ref_id,
      email: r.trader_email,
      name: mapName(r),
      phone: mapPhone(r),
      referralCode: r.referral_code,
      createdAt: r.created_at,
      referredByName: currentIB?.full_name || 'You',
      referredByEmail: currentIB?.email || null
    }));

    res.json({ success: true, data: { traders } });
  } catch (e) {
    console.error('Error fetching traders list:', e);
    res.status(500).json({ success: false, message: 'Unable to fetch traders' });
  }
});
