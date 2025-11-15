import express from 'express';
import { IBTradeHistory } from '../models/IBTradeHistory.js';
import { IBCommission } from '../models/IBCommission.js';
import { query } from '../config/database.js';
import { authenticateAdminToken } from './adminAuth.js';

const router = express.Router();
const MT5_API_BASE = 'https://metaapi.zuperior.com';

// Helper function to normalize group IDs for commission mapping
function makeKeys(gid) {
  if (!gid) return [];
  const raw = String(gid).trim();
  const low = raw.toLowerCase();
  const fwd = low.replace(/\\\\/g, '/');
  const bwd = low.replace(/\//g, '\\');
  const parts = low.split(/[\\\\/]/);
  const last = parts[parts.length - 1] || low;
  // Prefer the segment after 'bbook' when present (e.g., 'standard')
  let afterBbook = null;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === 'bbook' && i + 1 < parts.length) { afterBbook = parts[i + 1]; break; }
  }
  const keys = new Set([low, fwd, bwd, last]);
  if (afterBbook) keys.add(afterBbook);
  return Array.from(keys);
}

// Helper function to get access token for an account
async function getAccessToken(accountId) {
  try {
    console.log(`[AUTH] Attempting to get access token for account ${accountId}`);
    
    // Get password from MT5Account table - try both quoted and unquoted column names
    let accountResult;
    try {
      accountResult = await query(
        'SELECT password, "userId" FROM "MT5Account" WHERE "accountId" = $1',
        [String(accountId)]
      );
    } catch (err) {
      // If quoted fails, try without quotes (for lowercase column names)
      console.log(`[AUTH] Quoted query failed, trying unquoted: ${err.message}`);
      accountResult = await query(
        'SELECT password, user_id FROM mt5_account WHERE account_id = $1',
        [String(accountId)]
      );
    }
    
    if (accountResult.rows.length === 0) {
      console.error(`[AUTH] MT5 account ${accountId} not found in database`);
      throw new Error(`MT5 account ${accountId} not found in database`);
    }
    
    const password = accountResult.rows[0].password;
    console.log(`[AUTH] Found account, password exists: ${!!password}`);
    
    if (!password) {
      console.error(`[AUTH] Password is null or empty for account ${accountId}`);
      throw new Error(`Password not found for MT5 account ${accountId}. Please ensure the account has a password set.`);
    }
    
    // Call ClientAuth/login to get access token
    const loginUrl = `${MT5_API_BASE}/api/client/ClientAuth/login`;
    console.log(`[AUTH] Calling login API: ${loginUrl}`);
    
    // MT5 API expects AccountId (capital A), Password (capital P), DeviceId, and DeviceType
    const loginPayload = {
      AccountId: parseInt(String(accountId), 10), // Convert to integer as API expects
      Password: password,
      DeviceId: `server_${accountId}_${Date.now()}`,
      DeviceType: "server"
    };
    
    console.log(`[AUTH] Login payload (without password):`, { AccountId: loginPayload.AccountId, DeviceId: loginPayload.DeviceId, DeviceType: loginPayload.DeviceType });
    
    const loginResponse = await fetch(loginUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'accept': '*/*'
      },
      body: JSON.stringify(loginPayload)
    });
    
    const responseText = await loginResponse.text().catch(() => '');
    console.log(`[AUTH] Login response status: ${loginResponse.status}`);
    console.log(`[AUTH] Login response body: ${responseText.substring(0, 200)}`);
    
    if (!loginResponse.ok) {
      throw new Error(`MT5 API login failed: ${loginResponse.status} - ${responseText}`);
    }
    
    let loginData;
    try {
      loginData = JSON.parse(responseText);
    } catch (parseError) {
      throw new Error(`Failed to parse login response: ${responseText.substring(0, 100)}`);
    }
    
    // Try multiple possible token field names (case-insensitive check)
    const accessToken = 
      loginData?.accessToken || 
      loginData?.AccessToken ||
      loginData?.token || 
      loginData?.Token ||
      loginData?.access_token ||
      loginData?.data?.accessToken || 
      loginData?.data?.AccessToken ||
      loginData?.data?.token || 
      loginData?.data?.Token ||
      loginData?.data?.access_token ||
      loginData?.result?.accessToken ||
      loginData?.result?.AccessToken ||
      loginData?.result?.token ||
      loginData?.result?.Token;
    
    if (!accessToken) {
      console.error(`[AUTH] Access token not found in response:`, JSON.stringify(loginData, null, 2));
      console.error(`[AUTH] Response keys:`, Object.keys(loginData || {}));
      if (loginData?.data) {
        console.error(`[AUTH] Data keys:`, Object.keys(loginData.data || {}));
      }
      throw new Error('Access token not found in login response. Response structure: ' + JSON.stringify(loginData, null, 2));
    }
    
    console.log(`[AUTH] Successfully obtained access token for account ${accountId}`);
    return accessToken;
  } catch (error) {
    console.error(`[AUTH] Error getting access token for account ${accountId}:`, error.message);
    console.error(`[AUTH] Full error:`, error);
    throw error;
  }
}

// Sync trades from MT5 API for a specific account
router.post('/sync/:accountId', authenticateAdminToken, async (req, res) => {
  try {
    const { accountId } = req.params;
    const { fromDate, toDate, ibRequestId } = req.body;
    
    // Use wide date range to capture all trades
    const to = toDate || '2085-12-31T23:59:59Z';
    const from = fromDate || '2024-12-01T00:00:00Z';
    
    console.log(`[SYNC] Starting sync for account ${accountId}, IB Request ${ibRequestId}`);
    console.log(`[SYNC] Date range: ${from} to ${to}`);
    
    // Get userId for this account - try both quoted and unquoted column names
    let accountResult;
    try {
      accountResult = await query(
        'SELECT "userId", password FROM "MT5Account" WHERE "accountId" = $1',
        [String(accountId)]
      );
    } catch (err) {
      // If quoted fails, try without quotes
      console.log(`[SYNC] Quoted query failed, trying unquoted: ${err.message}`);
      accountResult = await query(
        'SELECT user_id, password FROM mt5_account WHERE account_id = $1',
        [String(accountId)]
      );
    }
    
    if (accountResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `MT5 account ${accountId} not found in database`
      });
    }
    
    const userId = accountResult.rows[0].userId || accountResult.rows[0].user_id;
    
    // Get access token
    let accessToken;
    try {
      accessToken = await getAccessToken(accountId);
    } catch (authError) {
      console.error(`[SYNC] Authentication failed for account ${accountId}:`, authError.message);
      return res.status(401).json({
        success: false,
        message: 'Failed to authenticate with MT5 API',
        error: authError.message
      });
    }
    
    // Get commission structure for this IB
    const assignmentsRes = await query(
      'SELECT group_id, usd_per_lot, spread_share_percentage FROM ib_group_assignments WHERE ib_request_id = $1',
      [ibRequestId]
    );

    const commissionMap = assignmentsRes.rows.reduce((map, row) => {
      if (!row.group_id) return map;
      const payload = {
        usdPerLot: Number(row.usd_per_lot || 0),
        spreadPercentage: Number(row.spread_share_percentage || 0)
      };
      for (const k of makeKeys(row.group_id)) {
        map[k] = payload;
      }
      return map;
    }, {});
    
    // Fallback to default IB rates if no group assignments
    if (!Object.keys(commissionMap).length) {
      const ibRes = await query('SELECT usd_per_lot, spread_percentage_per_lot FROM ib_requests WHERE id = $1', [ibRequestId]);
      if (ibRes.rows.length > 0) {
        commissionMap['*'] = {
          usdPerLot: Number(ibRes.rows[0].usd_per_lot || 0),
          spreadPercentage: Number(ibRes.rows[0].spread_percentage_per_lot || 0)
        };
      }
    }
    
    // Fetch closed trades from MT5 API using trades-closed endpoint
    const apiUrl = `${MT5_API_BASE}/api/client/tradehistory/trades-closed?accountId=${accountId}&fromDate=${encodeURIComponent(from)}&toDate=${encodeURIComponent(to)}&page=1&pageSize=1000`;
    console.log('Fetching closed trades from:', apiUrl);
    
    const response = await fetch(apiUrl, {
      headers: {
        'accept': '*/*',
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`MT5 API returned ${response.status}: ${errorText}`);
    }
    
    const data = await response.json();
    const trades = data.Items || [];
    
    // Resolve group id for this account
    let groupId = null;
    try {
      const profRes = await fetch(`${MT5_API_BASE}/api/Users/${accountId}/getClientProfile`, {
        headers: {
          'accept': '*/*',
          'Authorization': `Bearer ${accessToken}`
        }
      });
      if (profRes.ok) {
        const prof = await profRes.json();
        groupId = (prof?.Data || prof?.data)?.Group || null;
      }
    } catch (err) {
      console.warn(`[SYNC] Could not fetch group ID: ${err.message}`);
    }

    // Save trades to database with commission map
    console.log(`[SYNC] Fetched ${trades.length} closed trades from MT5 API`);
    console.log(`[SYNC] Commission map:`, commissionMap);
    console.log(`[SYNC] Group ID: ${groupId}`);
    
    const savedTrades = await IBTradeHistory.upsertTrades(trades, { accountId, userId, ibRequestId, commissionMap, groupId });
    
    console.log(`[SYNC] Saved ${savedTrades.length} trades to database`);
    
    // Update IB commission calculations
    try {
      await IBTradeHistory.calculateIBCommissions(accountId, ibRequestId);
      console.log(`[SYNC] Updated IB commission calculations`);
    } catch (calcError) {
      console.error(`[SYNC] Error calculating IB commissions:`, calcError);
    }
    
    // Update IB Commission table with latest commission data
    try {
      // Get IB's email and user_id
      const ibRes = await query('SELECT email FROM ib_requests WHERE id = $1', [ibRequestId]);
      if (ibRes.rows.length > 0) {
        const ibEmail = ibRes.rows[0].email;
        const ibUserRes = await query('SELECT id FROM "User" WHERE LOWER(email) = LOWER($1)', [ibEmail]);
        const ibUserId = ibUserRes.rows[0]?.id ? String(ibUserRes.rows[0].id) : null;
        
        if (ibUserId) {
          // Get commission structures
          const groupsRes = await query(
            `SELECT group_id, group_name, usd_per_lot, spread_share_percentage
             FROM ib_group_assignments
             WHERE ib_request_id = $1`,
            [ibRequestId]
          );
          
          // Build commission map
          const normalizeGroupId = (gid) => {
            if (!gid) return '';
            const s = String(gid).toLowerCase().trim();
            const parts = s.split(/[\\/]/);
            return parts[parts.length - 1] || s;
          };
          
          const commissionGroupsMap = new Map();
          for (const r of groupsRes.rows) {
            const k = normalizeGroupId(r.group_id);
            if (k) {
              commissionGroupsMap.set(k, {
                spreadPct: Number(r.spread_share_percentage || 0),
                usdPerLot: Number(r.usd_per_lot || 0)
              });
            }
          }
          
          // Get IB's own user_id to exclude
          const ibUserIdForExclusion = ibUserId;
          
          // Get referred user_ids
          const referredUserIds = new Set();
          const refRes = await query(
            'SELECT user_id FROM ib_referrals WHERE ib_request_id = $1 AND user_id IS NOT NULL',
            [ibRequestId]
          );
          refRes.rows.forEach(row => {
            if (row.user_id) referredUserIds.add(String(row.user_id));
          });
          
          const ibRefRes = await query(
            `SELECT u.id as user_id 
             FROM ib_requests ir
             JOIN "User" u ON u.email = ir.email
             WHERE ir.referred_by = $1 AND u.id IS NOT NULL`,
            [ibRequestId]
          );
          ibRefRes.rows.forEach(row => {
            if (row.user_id) referredUserIds.add(String(row.user_id));
          });
          
          // Calculate commission from referred users' trades only
          if (referredUserIds.size > 0 && commissionGroupsMap.size > 0) {
            let userFilter = '';
            const params = [ibRequestId];
            if (ibUserIdForExclusion) {
              params.push(ibUserIdForExclusion);
              userFilter = `AND user_id != $${params.length}`;
            }
            params.push(Array.from(referredUserIds));
            const userInClause = `AND user_id = ANY($${params.length}::text[])`;
            
            const tradesRes = await query(
              `SELECT group_id, volume_lots
               FROM ib_trade_history
               WHERE ib_request_id = $1
                 AND close_price IS NOT NULL AND close_price != 0 AND profit != 0
                 ${userFilter}
                 ${userInClause}`,
              params
            );
            
            // Calculate commission
            let fixedCommission = 0;
            let spreadCommission = 0;
            let totalTrades = 0;
            let totalLots = 0;
            
            for (const trade of tradesRes.rows) {
              const lots = Number(trade.volume_lots || 0);
              if (lots <= 0) continue;
              
              totalLots += lots;
              totalTrades += 1;
              
              const normalized = normalizeGroupId(trade.group_id);
              const rule = commissionGroupsMap.get(normalized) || 
                           Array.from(commissionGroupsMap.values())[0] || 
                           { usdPerLot: 0, spreadPct: 0 };
              
              fixedCommission += lots * Number(rule.usdPerLot || 0);
              spreadCommission += lots * (Number(rule.spreadPct || 0) / 100);
            }
            
            const totalCommission = fixedCommission + spreadCommission;
            
            // Save to IB Commission table
            await IBCommission.upsertCommission(ibRequestId, ibUserId, {
              totalCommission: totalCommission,
              fixedCommission: fixedCommission,
              spreadCommission: spreadCommission,
              totalTrades: totalTrades,
              totalLots: totalLots
            });
            
            console.log(`[SYNC] Updated IB Commission table: total=${totalCommission}, fixed=${fixedCommission}, spread=${spreadCommission}`);
          }
        }
      }
    } catch (commissionError) {
      console.error(`[SYNC] Error updating IB Commission table:`, commissionError);
      // Don't fail the sync if commission update fails
    }
    
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
    
    // Get commission structure for this IB
    const assignmentsRes = await query(
      'SELECT group_id, usd_per_lot, spread_share_percentage FROM ib_group_assignments WHERE ib_request_id = $1',
      [ibRequestId]
    );

    const commissionMap = assignmentsRes.rows.reduce((map, row) => {
      if (!row.group_id) return map;
      const payload = {
        usdPerLot: Number(row.usd_per_lot || 0),
        spreadPercentage: Number(row.spread_share_percentage || 0)
      };
      for (const k of makeKeys(row.group_id)) {
        map[k] = payload;
      }
      return map;
    }, {});
    
    // Fallback to default IB rates if no group assignments
    if (!Object.keys(commissionMap).length) {
      const ibRes = await query('SELECT usd_per_lot, spread_percentage_per_lot FROM ib_requests WHERE id = $1', [ibRequestId]);
      if (ibRes.rows.length > 0) {
        commissionMap['*'] = {
          usdPerLot: Number(ibRes.rows[0].usd_per_lot || 0),
          spreadPercentage: Number(ibRes.rows[0].spread_percentage_per_lot || 0)
        };
      }
    }
    
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
          const savedTrades = await IBTradeHistory.upsertTrades(trades, { accountId, userId, ibRequestId, commissionMap, groupId });
          
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

// Get trade history for an account (with authentication)
router.get('/history/:accountId', authenticateAdminToken, async (req, res) => {
  try {
    const { accountId } = req.params;
    const { fromDate, toDate, page = 1, pageSize = 1000, ibRequestId } = req.query;
    
    // Use dynamic date range or defaults
    const to = toDate || new Date().toISOString();
    const from = fromDate || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(); // Default to 1 year ago
    
    console.log(`[TRADE HISTORY] Fetching for account ${accountId}, Date range: ${from} to ${to}, IB Request ID: ${ibRequestId}`);
    
    // Get userId from accountId
    let accountResult;
    try {
      accountResult = await query(
        'SELECT "userId", password FROM "MT5Account" WHERE "accountId" = $1',
        [String(accountId)]
      );
    } catch (err) {
      accountResult = await query(
        'SELECT user_id, password FROM mt5_account WHERE account_id = $1',
        [String(accountId)]
      );
    }
    
    if (accountResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `MT5 account ${accountId} not found in database`
      });
    }
    
    const userId = accountResult.rows[0].userId || accountResult.rows[0].user_id;
    
    // Get access token
    let accessToken;
    try {
      accessToken = await getAccessToken(accountId);
    } catch (authError) {
      console.error(`[TRADE HISTORY] Authentication error:`, authError);
      return res.status(401).json({
        success: false,
        message: 'Failed to authenticate with MT5 API',
        error: authError.message
      });
    }
    
    // Fetch closed trades from MT5 API
    const apiUrl = `${MT5_API_BASE}/api/client/tradehistory/trades-closed?accountId=${accountId}&fromDate=${encodeURIComponent(from)}&toDate=${encodeURIComponent(to)}&page=${page}&pageSize=${pageSize}`;
    
    const response = await fetch(apiUrl, {
      headers: {
        'accept': '*/*',
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`MT5 API returned ${response.status}: ${errorText}`);
    }
    
    const data = await response.json();
    const trades = data.Items || [];
    
    // Return response immediately, save trades in background
    const responseData = {
      success: true,
      data: {
        items: trades,
        page: data.Page || parseInt(page),
        pageSize: data.PageSize || parseInt(pageSize),
        totalCount: data.TotalCount || 0,
        totalPages: data.TotalPages || 1,
        hasNextPage: data.HasNextPage || false,
        hasPreviousPage: data.HasPreviousPage || false
      }
    };
    
    // Send response immediately
    res.json(responseData);
    
    // Save trades in background (don't block the response)
    // Use setImmediate or Promise.resolve().then() to run async without blocking
    Promise.resolve().then(async () => {
      try {
        if (trades.length > 0) {
          // If ibRequestId not provided, try to get it from the account's user
          let finalIbRequestId = ibRequestId;
          if (!finalIbRequestId && userId) {
            try {
              // Try to find ib_request_id from ib_referrals or ib_requests
              const ibRefRes = await query(
                `SELECT DISTINCT ir.ib_request_id 
                 FROM ib_referrals ir
                 WHERE ir.user_id = $1
                 LIMIT 1`,
                [userId]
              );
              if (ibRefRes.rows.length > 0) {
                finalIbRequestId = ibRefRes.rows[0].ib_request_id;
              } else {
                // Try from ib_requests where user email matches
                const ibReqRes = await query(
                  `SELECT ir.id as ib_request_id
                   FROM ib_requests ir
                   JOIN "User" u ON LOWER(u.email) = LOWER(ir.email)
                   WHERE u.id = $1 AND ir.status = 'approved'
                   LIMIT 1`,
                  [userId]
                );
                if (ibReqRes.rows.length > 0) {
                  finalIbRequestId = ibReqRes.rows[0].ib_request_id;
                }
              }
            } catch (err) {
              console.warn(`[TRADE HISTORY] Could not find ibRequestId for user ${userId}:`, err.message);
            }
          }
          
          if (finalIbRequestId) {
            // Get commission structure for this IB
            const assignmentsRes = await query(
              'SELECT group_id, usd_per_lot, spread_share_percentage FROM ib_group_assignments WHERE ib_request_id = $1',
              [finalIbRequestId]
            );

            const commissionMap = assignmentsRes.rows.reduce((map, row) => {
              if (!row.group_id) return map;
              const payload = {
                usdPerLot: Number(row.usd_per_lot || 0),
                spreadPercentage: Number(row.spread_share_percentage || 0)
              };
              for (const k of makeKeys(row.group_id)) {
                map[k] = payload;
              }
              return map;
            }, {});
            
            // Fallback to default IB rates if no group assignments
            if (!Object.keys(commissionMap).length) {
              const ibRes = await query('SELECT usd_per_lot, spread_percentage_per_lot FROM ib_requests WHERE id = $1', [finalIbRequestId]);
              if (ibRes.rows.length > 0) {
                commissionMap['*'] = {
                  usdPerLot: Number(ibRes.rows[0].usd_per_lot || 0),
                  spreadPercentage: Number(ibRes.rows[0].spread_percentage_per_lot || 0)
                };
              }
            }
            
            // Resolve group id for this account
            let groupId = null;
            try {
              const profRes = await fetch(`${MT5_API_BASE}/api/Users/${accountId}/getClientProfile`, {
                headers: {
                  'accept': '*/*',
                  'Authorization': `Bearer ${accessToken}`
                }
              });
              if (profRes.ok) {
                const prof = await profRes.json();
                groupId = (prof?.Data || prof?.data)?.Group || null;
              }
            } catch (err) {
              console.warn(`[TRADE HISTORY] Could not fetch group ID: ${err.message}`);
            }
            
            // Save trades to database
            console.log(`[TRADE HISTORY] Saving ${trades.length} trades to ib_trade_history for account ${accountId}, ibRequestId=${finalIbRequestId}`);
            const savedTrades = await IBTradeHistory.upsertTrades(trades, { accountId, userId, ibRequestId: finalIbRequestId, commissionMap, groupId });
            console.log(`[TRADE HISTORY] ✓ Successfully saved ${savedTrades.length} trades to database`);
            
            // Update IB commission calculations
            try {
              await IBTradeHistory.calculateIBCommissions(accountId, finalIbRequestId);
              console.log(`[TRADE HISTORY] Updated IB commission calculations`);
            } catch (calcError) {
              console.error(`[TRADE HISTORY] Error calculating IB commissions:`, calcError);
            }
          } else {
            // Save trades without ibRequestId (will still be saved but without commission)
            console.log(`[TRADE HISTORY] Saving ${trades.length} trades without ibRequestId for account ${accountId}`);
            const savedTrades = await IBTradeHistory.upsertTrades(trades, { accountId, userId, ibRequestId: null, commissionMap: {}, groupId: null });
            console.log(`[TRADE HISTORY] ✓ Saved ${savedTrades.length} trades to database (without IB commission)`);
          }
        }
      } catch (backgroundError) {
        console.error(`[TRADE HISTORY] ✗ Background save error:`, backgroundError);
        console.error(`[TRADE HISTORY] Error stack:`, backgroundError.stack);
        // Don't crash the server, just log the error
      }
    });
  } catch (error) {
    console.error('Get trade history error:', error);
    // Only send error response if we haven't sent a response yet
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Failed to fetch trade history',
        error: error.message
      });
    } else {
      // Log background save errors but don't fail the request
      console.error('[TRADE HISTORY] Background save error:', error);
    }
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
