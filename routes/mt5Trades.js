import express from 'express';
import { IBTradeHistory } from '../models/IBTradeHistory.js';
import { query } from '../config/database.js';
import { authenticateAdminToken } from './adminAuth.js';

const router = express.Router();
const MT5_API_BASE = 'http://18.175.242.21:5003';

// Sync trades from MT5 API for a specific account
router.post('/sync/:accountId', authenticateAdminToken, async (req, res) => {
  try {
    const { accountId } = req.params;
    const { fromDate, toDate, ibRequestId } = req.body;
    
    // Default date range: last 90 days
    const to = toDate || new Date().toISOString();
    const from = fromDate || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    
    // Get userId for this account
    const accountResult = await query(
      'SELECT "userId" FROM "MT5Account" WHERE "accountId" = $1',
      [String(accountId)]
    );
    
    if (accountResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'MT5 account not found'
      });
    }
    
    const userId = accountResult.rows[0].userId;
    
    // Fetch trades from MT5 API
    const apiUrl = `${MT5_API_BASE}/api/client/tradehistory/trades?accountId=${accountId}&page=1&pageSize=1000&fromDate=${from}&toDate=${to}`;
    console.log('Fetching trades from:', apiUrl);
    
    const response = await fetch(apiUrl, {
      headers: { 'accept': '*/*' }
    });
    
    if (!response.ok) {
      throw new Error(`MT5 API returned ${response.status}`);
    }
    
    const data = await response.json();
    const trades = data.Items || [];
    
    // Resolve group id for this account
    let groupId = null;
    try {
      const profRes = await fetch(`${MT5_API_BASE}/api/Users/${accountId}/getClientProfile`, { headers: { accept: '*/*' } });
      if (profRes.ok) {
        const prof = await profRes.json();
        groupId = (prof?.Data || prof?.data)?.Group || null;
      }
    } catch {}

    // Save trades to database
    const savedTrades = await IBTradeHistory.upsertTrades(trades, { accountId, userId, ibRequestId, groupId });
    
    // Calculate IB commissions
    await IBTradeHistory.calculateIBCommissions(accountId, ibRequestId);
    
    res.json({
      success: true,
      message: `Synced ${savedTrades.length} trades`,
      data: {
        syncedCount: savedTrades.length,
        totalFromAPI: trades.length,
        lastSyncTime: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Sync trades error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to sync trades',
      error: error.message
    });
  }
});

// Sync all accounts for an IB user
router.post('/sync-user/:ibRequestId', authenticateAdminToken, async (req, res) => {
  try {
    const { ibRequestId } = req.params;
    const { fromDate, toDate } = req.body;
    
    // Get IB user email
    const ibResult = await query('SELECT email FROM ib_requests WHERE id = $1', [ibRequestId]);
    if (ibResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'IB request not found' });
    }
    
    const email = ibResult.rows[0].email;
    
    // Get user UUID
    const userResult = await query('SELECT id FROM "User" WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    const userId = userResult.rows[0].id;
    
    // Get all MT5 accounts for this user
    const accountsResult = await query(
      'SELECT "accountId" FROM "MT5Account" WHERE "userId" = $1',
      [userId]
    );
    
    const accounts = accountsResult.rows;
    let totalSynced = 0;
    const results = [];
    
    // Sync each account
    for (const account of accounts) {
      try {
        const accountId = account.accountId;
        const to = toDate || new Date().toISOString();
        const from = fromDate || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
        
        const apiUrl = `${MT5_API_BASE}/api/client/tradehistory/trades?accountId=${accountId}&page=1&pageSize=1000&fromDate=${from}&toDate=${to}`;
        const response = await fetch(apiUrl, { headers: { 'accept': '*/*' } });
        
        if (response.ok) {
          const data = await response.json();
          const trades = data.Items || [];
          // get group id per account
          let groupId = null;
          try {
            const profRes = await fetch(`${MT5_API_BASE}/api/Users/${accountId}/getClientProfile`, { headers: { accept: '*/*' } });
            if (profRes.ok) {
              const prof = await profRes.json();
              groupId = (prof?.Data || prof?.data)?.Group || null;
            }
          } catch {}
          const savedTrades = await IBTradeHistory.upsertTrades(trades, { accountId, userId, ibRequestId, groupId });
          
          // Calculate IB commissions
          await IBTradeHistory.calculateIBCommissions(accountId, ibRequestId);
          
          totalSynced += savedTrades.length;
          results.push({
            accountId,
            synced: savedTrades.length,
            total: trades.length
          });
        }
      } catch (error) {
        console.error(`Error syncing account ${account.accountId}:`, error.message);
        results.push({
          accountId: account.accountId,
          error: error.message
        });
      }
    }
    
    res.json({
      success: true,
      message: `Synced ${totalSynced} trades across ${accounts.length} accounts`,
      data: {
        totalSynced,
        accountCount: accounts.length,
        results
      }
    });
  } catch (error) {
    console.error('Sync user trades error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to sync user trades',
      error: error.message
    });
  }
});

// Get trades for an IB user (for admin view)
router.get('/user/:ibRequestId', authenticateAdminToken, async (req, res) => {
  try {
    const { ibRequestId } = req.params;
    const { accountId, fromDate, toDate, page = 1, limit = 50 } = req.query;
    
    // Get IB user email
    const ibResult = await query('SELECT email FROM ib_requests WHERE id = $1', [ibRequestId]);
    if (ibResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'IB request not found' });
    }
    
    const email = ibResult.rows[0].email;
    
    // Get user UUID
    const userResult = await query('SELECT id FROM "User" WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    const userId = userResult.rows[0].id;
    
    // Get trades
    const trades = await IBTradeHistory.getTradesByIB(ibRequestId, accountId);
    
    const result = {
      trades,
      total: trades.length,
      page: parseInt(page),
      pageSize: parseInt(limit)
    };
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Get user trades error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch trades',
      error: error.message
    });
  }
});

// Get trade statistics for an IB user
router.get('/stats/:ibRequestId', authenticateAdminToken, async (req, res) => {
  try {
    const { ibRequestId } = req.params;
    const { accountId } = req.query;
    
    // Get IB user email
    const ibResult = await query('SELECT email FROM ib_requests WHERE id = $1', [ibRequestId]);
    if (ibResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'IB request not found' });
    }
    
    const email = ibResult.rows[0].email;
    
    // Get user UUID
    const userResult = await query('SELECT id FROM "User" WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    const userId = userResult.rows[0].id;
    
    // Get stats from ib_trade_history
    const stats = await IBTradeHistory.getTradeStats(ibRequestId, accountId);
    const lastSync = accountId ? await IBTradeHistory.getLastSyncTime(accountId) : null;
    
    res.json({
      success: true,
      data: {
        totalTrades: Number(stats.total_trades || 0),
        totalLots: Number(stats.total_lots || 0),
        totalProfit: Number(stats.total_profit || 0),
        totalIBCommission: Number(stats.total_ib_commission || 0),
        lastSync
      }
    });
  } catch (error) {
    console.error('Get trade stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch trade statistics',
      error: error.message
    });
  }
});

export default router;
