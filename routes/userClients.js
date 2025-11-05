import express from 'express';
import { authenticateToken } from './auth.js';
import { query } from '../config/database.js';

const router = express.Router();

// Get clients for logged-in IB user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get IB request ID for this user
    const ibResult = await query(
      `SELECT id FROM ib_requests WHERE email = (SELECT email FROM "User" WHERE id = $1) AND status = 'approved'`,
      [userId]
    );

    if (ibResult.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          clients: [],
          stats: {
            totalClients: 0,
            totalVolume: 0,
            totalCommission: 0,
            activeTraders: 0
          }
        }
      });
    }

    const ibRequestId = ibResult.rows[0].id;

    // Get clients linked to this IB
    const clientsResult = await query(`
      SELECT 
        icl.user_id,
        icl.user_name,
        icl.user_email,
        icl.user_account_id,
        icl.linked_at,
        icl.direct_volume_lots,
        icl.direct_commission,
        COUNT(DISTINCT ma."accountId") as account_count
      FROM ib_client_linking icl
      LEFT JOIN "User" u ON u.id = icl.user_id
      LEFT JOIN "MT5Account" ma ON ma."userId" = icl.user_id
      WHERE icl.assigned_ib_id = $1 AND icl.status = 'active'
      GROUP BY icl.user_id, icl.user_name, icl.user_email, icl.user_account_id, icl.linked_at, icl.direct_volume_lots, icl.direct_commission
      ORDER BY icl.linked_at DESC
    `, [ibRequestId]);

    const clients = clientsResult.rows.map(row => ({
      userId: row.user_id,
      name: row.user_name,
      email: row.user_email,
      accountId: row.user_account_id,
      joinDate: row.linked_at,
      totalLots: Number(row.direct_volume_lots || 0),
      commission: Number(row.direct_commission || 0),
      accountCount: parseInt(row.account_count || 0),
      lastTrade: null // Will be populated from trade history
    }));

    // Get last trade date for each client
    for (const client of clients) {
      const lastTradeResult = await query(`
        SELECT MAX(created_at) as last_trade
        FROM ib_trade_history
        WHERE user_id::text = $1 AND ib_request_id = $2
      `, [String(client.userId), ibRequestId]);

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


