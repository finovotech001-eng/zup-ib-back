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

    // Get clients referred by this IB (from ib_requests.referred_by)
    const clientsResult = await query(`
      SELECT 
        ib.id as ib_id,
        ib.full_name as user_name,
        ib.email as user_email,
        ib.submitted_at as linked_at,
        ib.ib_type,
        ib.status,
        COALESCE(SUM(th.volume_lots), 0) as direct_volume_lots,
        COALESCE(SUM(th.ib_commission), 0) as direct_commission,
        COUNT(DISTINCT ma."accountId") as account_count
      FROM ib_requests ib
      LEFT JOIN "User" u ON u.email = ib.email
      LEFT JOIN "MT5Account" ma ON ma."userId" = u.id
      LEFT JOIN ib_trade_history th ON th.ib_request_id = ib.id
      WHERE ib.referred_by = $1
      GROUP BY ib.id, ib.full_name, ib.email, ib.submitted_at, ib.ib_type, ib.status
      ORDER BY ib.submitted_at DESC
    `, [ibRequestId]);

    const clients = clientsResult.rows.map(row => ({
      userId: row.ib_id,
      name: row.user_name,
      email: row.user_email,
      accountId: '-',
      joinDate: row.linked_at,
      totalLots: Number(row.direct_volume_lots || 0),
      commission: Number(row.direct_commission || 0),
      accountCount: parseInt(row.account_count || 0),
      ibType: row.ib_type,
      status: row.status,
      lastTrade: null
    }));

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


