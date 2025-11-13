import express from 'express';
import { authenticateToken } from './auth.js';
import { query } from '../config/database.js';
import { IBTradeHistory } from '../models/IBTradeHistory.js';
import { IBCommission } from '../models/IBCommission.js';

const router = express.Router();
// Lightweight in-memory cache for hot analytics responses (60s TTL)
const analyticsCache = new Map(); // key -> { expires:number, payload:any }

/**
 * Normalize group ID by extracting the last segment from path
 * Example: 'real\Bbook\Standard\dynamic-2000x-20Pips' -> 'dynamic-2000x-20pips'
 */
function normalizeGroupId(groupId) {
  if (!groupId) return '';
  const s = String(groupId).toLowerCase().trim();
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

/**
 * Find matching commission rule for a normalized group ID
 * Uses flexible matching: exact -> partial -> first available
 */
function findMatchingRule(normalizedGroupId, commissionGroupsMap) {
  if (!normalizedGroupId || !commissionGroupsMap || commissionGroupsMap.size === 0) {
    return null;
  }

  // Try exact match first
  let rule = commissionGroupsMap.get(normalizedGroupId);
  if (rule) return rule;

  // Try partial match (check if normalized key contains any approved key or vice versa)
  for (const [approvedKey, approvedRule] of commissionGroupsMap.entries()) {
    if (normalizedGroupId.includes(approvedKey) || approvedKey.includes(normalizedGroupId)) {
      return approvedRule;
    }
  }

  // Fallback to first available group assignment
  if (commissionGroupsMap.size > 0) {
    return Array.from(commissionGroupsMap.values())[0];
  }

  return null;
}

/**
 * Calculate commission from trades using commission structure
 * @param {Array} trades - Array of trade objects with { group_id, volume_lots }
 * @param {Map} commissionGroupsMap - Map of normalized group_id -> { usdPerLot, spreadPct }
 * @returns {Object} { fixed, spread, total, totalLots, totalTrades }
 */
function calculateCommissionFromTrades(trades, commissionGroupsMap) {
  let fixed = 0;
  let spread = 0;
  let totalLots = 0;
  let totalTrades = 0;

  if (!Array.isArray(trades) || trades.length === 0) {
    return { fixed: 0, spread: 0, total: 0, totalLots: 0, totalTrades: 0 };
  }

  for (const trade of trades) {
    const lots = Number(trade.volume_lots || 0);
    if (lots <= 0) continue;

    totalLots += lots;
    totalTrades += 1;

    // Match group to commission structure (flexible matching)
    const normalized = normalizeGroupId(trade.group_id);
    const rule = findMatchingRule(normalized, commissionGroupsMap);

    if (rule) {
      const usdPerLot = Number(rule.usdPerLot || 0);
      const spreadPct = Number(rule.spreadPct || 0);
      
      fixed += lots * usdPerLot;
      spread += lots * (spreadPct / 100);
    }
  }

  return {
    fixed,
    spread,
    total: fixed + spread,
    totalLots,
    totalTrades
  };
}

const MT5_API_BASE = 'http://18.130.5.209:5003';

// Helper: fetch MT5 client profile with small retry and timeout
async function fetchMt5Profile(accountId) {
  const url = `${MT5_API_BASE}/api/Users/${accountId}/getClientProfile`;
  const attempt = async (timeoutMs) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers: { accept: '*/*' }, signal: controller.signal });
      if (r.ok) {
        const j = await r.json();
        return j?.Data || j?.data || null;
      }
    } catch {}
    finally { clearTimeout(t); }
    return null;
  };
  return (await attempt(8000)) || (await attempt(12000));
}

// GET /api/user/overview -> totals, accounts, commission structures
router.get('/overview', authenticateToken, async (req, res) => {
  try {
    const ib = req.user; // from authenticateToken
    // Time window alignment with admin (default last 30 days)
    const period = Math.max(parseInt(req.query.period || '30', 10), 1);
    const hasWindow = Number.isFinite(period) && period > 0;
    const windowSql = hasWindow ? ` AND (synced_at >= NOW() - INTERVAL '${period} days')` : '';
    const userResult = await query('SELECT id FROM "User" WHERE LOWER(email) = LOWER($1)', [ib.email]);
    if (!userResult.rows.length) {
      return res.json({ success: true, data: { stats: { totalAccounts: 0, totalBalance: 0, totalEquity: 0, accountStatus: ib.status }, accounts: [], commissionInfo: { standard: `$${Number(ib.usd_per_lot || 0).toFixed(2)} per lot`, commissionType: 'Commission per lot' }, groups: [] } });
    }

    const userId = userResult.rows[0].id;
    // Real accounts only (accountType: live/real) and package not demo when present
    const accountsRes = await query(
      `SELECT "accountId", "accountType", "package" 
       FROM "MT5Account" 
       WHERE "userId" = $1 
         AND (LOWER("accountType") IN ('live','real') OR LOWER(COALESCE("accountType", 'live')) IN ('live','real'))
         AND ("package" IS NULL OR LOWER("package") NOT LIKE '%demo%')`,
      [userId]
    );

    const accountsRaw = await Promise.all(
      accountsRes.rows.map(async (r) => {
        const payload = await fetchMt5Profile(r.accountId);
        const balance = Number(payload?.Balance ?? payload?.balance ?? 0);
        const equity = Number(payload?.Equity ?? payload?.equity ?? 0);
        const margin = Number(payload?.Margin ?? payload?.margin ?? 0);
        const profit = Number(payload?.Profit ?? payload?.profit ?? 0);
        const groupFull = payload?.Group || payload?.group || '';
        let groupName = groupFull;
        if (typeof groupName === 'string') {
          const parts = groupName.split(/[\\/]/);
          groupName = parts[parts.length - 1] || groupName;
        }
        return { accountId: String(r.accountId), balance, equity, margin, profit, group: groupName, groupId: groupFull, isDemo: false };
      })
    );

    let accounts = accountsRaw;
    const totals = accounts.reduce((t, a) => ({ totalAccounts: (t.totalAccounts || 0) + 1, totalBalance: (t.totalBalance || 0) + a.balance, totalEquity: (t.totalEquity || 0) + a.equity }), { totalAccounts: 0, totalBalance: 0, totalEquity: 0 });

    // Group assignments with simple aggregates from ib_trade_history
    const assignments = await query(
      `SELECT group_id, group_name, structure_name, usd_per_lot, spread_share_percentage
       FROM ib_group_assignments WHERE ib_request_id = $1`,
      [ib.id]
    );
    // Aggregates per account and per group (filter to approved groups + real accounts only)
    const perAccGroupRes = await query(
      `SELECT account_id, group_id, COALESCE(SUM(volume_lots),0) AS lots, COALESCE(SUM(ib_commission),0) AS commission
       FROM ib_trade_history 
       WHERE ib_request_id = $1 
         AND close_price IS NOT NULL AND close_price != 0 AND profit != 0 AND profit IS NOT NULL${windowSql}
       GROUP BY account_id, group_id`,
      [ib.id]
    );

    // Build helper sets/maps for filtering
    const realAccountIds = new Set(accounts.map(a => String(a.accountId)));
    const normalize = (gid) => {
      if (!gid) return '';
      const s = String(gid).toLowerCase().trim();
      const parts = s.split(/[\\/]/);
      return parts[parts.length - 1] || s;
    };

    // Build assignment map BEFORE applying aggregates
    const assignmentMap = assignments.rows.reduce((m, r) => {
      const k = normalize(r.group_id);
      if (!k) return m;
      m[k] = {
        usdPerLot: Number(r.usd_per_lot || 0),
        spreadPct: Number(r.spread_share_percentage || 0)
      };
      return m;
    }, {});

    // Aggregate rows for real accounts with approved groups only
    const groupAgg = {}; // keyed by normalized group id
    const perAccountMap = {}; // account -> fixed sum (approved groups only)
    const lotsByAccount = {}; // account -> lots sum (approved groups only)
    for (const row of perAccGroupRes.rows) {
      const accId = String(row.account_id);
      if (!realAccountIds.has(accId)) continue;
      
      // Skip demo groups
      const groupIdLower = String(row.group_id || '').toLowerCase();
      if (groupIdLower.includes('demo')) continue;
      
      const normGroup = normalize(row.group_id);
      const hasAssignment = !!assignmentMap[normGroup];

      // Only process if group has assignment (approved group)
      if (!hasAssignment) continue;

      // Sum by group for the Groups section
      if (!groupAgg[normGroup]) groupAgg[normGroup] = { lots: 0, commission: 0 };
      groupAgg[normGroup].lots += Number(row.lots || 0);
      groupAgg[normGroup].commission += Number(row.commission || 0);

      // Sum per account (only approved groups)
      perAccountMap[accId] = (perAccountMap[accId] || 0) + Number(row.commission || 0);
      lotsByAccount[accId] = (lotsByAccount[accId] || 0) + Number(row.lots || 0);
    }

    // assignmentMap already defined above

    accounts = accounts.map(a => {
      const key = normalize(a.groupId);
      const assignment = assignmentMap[key] || null;
      const lots = Number(lotsByAccount[a.accountId] || 0);
      const fixed = Number(perAccountMap[a.accountId] || 0);
      const spreadAmt = assignment ? lots * (assignment.spreadPct / 100) : 0;
      const total = assignment ? fixed + spreadAmt : 0;
      return {
        ...a,
        ibCommission: fixed,
        spreadCommissionAmount: assignment ? spreadAmt : 0,
        commissionTotal: total,
        usdPerLot: assignment?.usdPerLot || 0,
        spreadSharePercentage: assignment?.spreadPct || 0,
        isEligibleForCommission: !!assignment
      };
    });
    // Normalize to two user-visible types: Standard and Pro
    const detectType = (nameOrId) => {
      const s = (nameOrId || '').toString().toLowerCase();
      return s.includes('pro') ? 'Pro' : 'Standard';
    };

    const byType = {};
    for (const g of assignments.rows) {
      const label = detectType(g.group_name || g.group_id);
      const key = String(g.group_id || '').toLowerCase();
      if (!byType[label]) {
        byType[label] = {
          groupId: label,
          groupName: label,
          structureName: g.structure_name || null,
          usdPerLot: Number(g.usd_per_lot || 0),
          spreadSharePercentage: Number(g.spread_share_percentage || 0),
          totalLots: 0,
          totalCommission: 0,
          spreadCommission: 0,
          commissionTotal: 0,
          totalBalance: 0
        };
      } else {
        // If multiple assignments map to same label, prefer higher usdPerLot
        byType[label].usdPerLot = Math.max(byType[label].usdPerLot, Number(g.usd_per_lot || 0));
        byType[label].spreadSharePercentage = Math.max(byType[label].spreadSharePercentage, Number(g.spread_share_percentage || 0));
      }
      byType[label].totalLots += Number(groupAgg[key]?.lots || 0);
      byType[label].totalCommission += Number(groupAgg[key]?.commission || 0);
      // Spread commission is based on lots and spread share %
      const spread = Number(groupAgg[key]?.lots || 0) * (byType[label].spreadSharePercentage / 100);
      byType[label].spreadCommission += spread;
    }

    // Group balances by mapping accounts to Standard/Pro and summing balances
    const groups = Object.values(byType).map((grp) => {
      const label = grp.groupName; // 'Standard' or 'Pro'
      const sumBalance = accounts
        .filter(a => detectType(a.groupId || a.group) === label)
        .reduce((s, a) => s + Number(a.balance || 0), 0);
      const commissionTotal = Number(grp.totalCommission || 0) + Number(grp.spreadCommission || 0);
      return {
        ...grp,
        totalBalance: sumBalance,
        commissionTotal
      };
    });

    // Commission summary per visible type (for Commission Info UI)
    const standardEntry = groups.find(g => g.groupName === 'Standard');
    const proEntry = groups.find(g => g.groupName === 'Pro');
    const commissionByType = {
      Standard: standardEntry ? { usdPerLot: standardEntry.usdPerLot, spreadShare: standardEntry.spreadSharePercentage } : null,
      Pro: proEntry ? { usdPerLot: proEntry.usdPerLot, spreadShare: proEntry.spreadSharePercentage } : null
    };

    // Build approved-groups summary for overview cards
    let summary = { totalTrades: 0, totalLots: 0, totalProfit: 0, fixedCommission: 0, spreadCommission: 0, totalCommission: 0 };
    try {
      // Restrict to real account ids only
      const allowedAccountIds = Array.from(realAccountIds);
      const grpRes = await query(
        `SELECT group_id, COUNT(*)::int AS trades, COALESCE(SUM(volume_lots),0) AS lots, COALESCE(SUM(profit),0) AS profit, COALESCE(SUM(ib_commission),0) AS fixed
         FROM ib_trade_history 
         WHERE ib_request_id = $1 
           AND close_price IS NOT NULL AND close_price != 0 AND profit != 0 AND profit IS NOT NULL${windowSql}
           ${allowedAccountIds.length ? 'AND account_id = ANY($2)' : ''}
         GROUP BY group_id`,
        allowedAccountIds.length ? [ib.id, allowedAccountIds] : [ib.id]
      );
      // Build assignment map
      const makeKeys = (gid) => {
        if (!gid) return [];
        const s = String(gid).trim().toLowerCase();
        const fwd = s.replace(/\\\\/g, '/');
        const bwd = s.replace(/\//g, '\\');
        const parts = s.split(/[\\\\/]/);
        const last = parts[parts.length - 1] || s;
        const idx = parts.findIndex(p => p === 'bbook');
        const keys = new Set([s, fwd, bwd, last]);
        if (idx >= 0 && idx + 1 < parts.length) keys.add(parts[idx + 1]);
        return Array.from(keys);
      };
      const assignmentMap = assignments.rows.reduce((m, r) => {
        const pct = Number(r.spread_share_percentage || 0);
        for (const k of makeKeys(r.group_id)) m[k] = { spreadPct: pct };
        return m;
      }, {});

      for (const row of grpRes.rows) {
        // Skip demo groups
        const groupIdLower = String(row.group_id || '').toLowerCase();
        if (groupIdLower.includes('demo')) continue;
        
        const candidates = makeKeys(row.group_id);
        const k = candidates.find((x) => assignmentMap[x]);
        if (!k) continue; // Only approved groups
        const lots = Number(row.lots || 0);
        const fixed = Number(row.fixed || 0);
        const profit = Number(row.profit || 0);
        const trades = Number(row.trades || 0);
        
        const spread = lots * (assignmentMap[k].spreadPct / 100);
        
        summary.totalTrades += trades;
        summary.totalLots += lots;
        summary.totalProfit += profit;
        summary.fixedCommission += fixed;
        summary.spreadCommission += spread;
      }
      summary.totalCommission = summary.fixedCommission + summary.spreadCommission;
    } catch {}

    // IB information - get phone from ib_requests table
    let phone = null;
    try {
      const phoneRes = await query('SELECT phone FROM ib_requests WHERE id = $1', [ib.id]);
      phone = phoneRes.rows[0]?.phone || null;
    } catch {}

    res.json({
      success: true,
      data: {
        stats: { ...totals, accountStatus: ib.status },
        accounts,
        commissionInfo: { standard: `$${Number(ib.usd_per_lot || 0).toFixed(2)} per lot`, commissionType: 'Commission per lot' },
        groups,
        commissionByType,
        summary,
        ibInfo: {
          fullName: ib.full_name || ib.fullName || null,
          email: ib.email,
          phone: phone || ib.phone || null,
          approvedDate: ib.approved_at || null,
          referralCode: ib.referral_code || null,
          commissionStructure: (standardEntry?.structureName || proEntry?.structureName || ib.ib_type || null)
        }
      }
    });
  } catch (e) {
    console.error('Overview error:', e);
    res.status(500).json({ success: false, message: 'Unable to fetch overview' });
  }
});

// GET /api/user/commission-analytics - Fetch from ib_trade_history table with pagination
router.get('/commission-analytics', authenticateToken, async (req, res) => {
  try {
    const ib = req.user;
    const ibId = ib.id;
    const period = Math.max(parseInt(req.query.period || '30', 10), 1);
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const offset = (page - 1) * limit;

    // Cache key: IB ID + period + page + limit (5 minute cache)
    const cacheKey = `analytics:${ibId}:${period}:${page}:${limit}`;
    const cached = analyticsCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return res.json({ success: true, data: cached.payload });
    }

    // Calculate date range for period
    const now = new Date();
    const periodStart = new Date(now.getTime() - period * 24 * 60 * 60 * 1000);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Get approved group assignments for spread calculation
    const assignments = await query(
      `SELECT group_id, group_name, structure_name, usd_per_lot, spread_share_percentage
       FROM ib_group_assignments WHERE ib_request_id = $1`,
      [ibId]
    );

    // Normalize group IDs for matching
    const normalize = (gid) => {
      if (!gid) return '';
      const s = String(gid).toLowerCase().trim();
      const parts = s.split(/[\\/]/);
      return parts[parts.length - 1] || s;
    };

    // Build assignment map for spread calculation
    const assignmentMap = new Map();
    for (const row of assignments.rows) {
      const keys = [
        String(row.group_id || '').toLowerCase(),
        String(row.group_name || '').toLowerCase(),
        normalize(row.group_id)
      ].filter(k => k);
      for (const k of keys) {
        assignmentMap.set(k, {
          spreadSharePercentage: Number(row.spread_share_percentage || 0),
          usdPerLot: Number(row.usd_per_lot || 0)
        });
      }
    }

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

    // Get IB's own user_id to exclude
    const ibUserId = await getIBUserId(ibId);
    // Get referred user_ids to include
    const referredUserIds = await getReferredUserIds(ibId);

    // Build WHERE clause to exclude IB's own trades and only include referred users' trades
    let userFilter = '';
    const baseParams = [ibId, periodStart.toISOString()];
    if (ibUserId) {
      baseParams.push(ibUserId);
      userFilter = `AND user_id != $${baseParams.length}`;
    }
    if (referredUserIds.length > 0) {
      baseParams.push(referredUserIds);
      const userInClause = `AND user_id = ANY($${baseParams.length}::text[])`;
      userFilter = userFilter ? `${userFilter} ${userInClause}` : userInClause;
    } else {
      // No referred users, return empty result
      return res.json({
        success: true,
        data: {
          totalCount: 0,
          totalCommission: 0,
          fixedCommission: 0,
          spreadCommission: 0,
          totalProfit: 0,
          totalVolume: 0,
          totalTrades: 0,
          thisMonth: 0,
          averageDaily: 0,
          ledger: [],
          page: page,
          limit: limit
        }
      });
    }

    // Fetch total count for pagination
    // Only show DEALS OUT: closed positions where profit exists (profit != 0)
    // Only from referred users, excluding IB's own trades
    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM ib_trade_history
      WHERE ib_request_id = $1
        AND close_price IS NOT NULL 
        AND close_price != 0
        AND profit IS NOT NULL
        AND profit != 0
        AND synced_at >= $2
        ${userFilter}
    `;
    const countResult = await query(countQuery, baseParams);
    const totalCount = countResult.rows[0]?.total || 0;

    // Fetch ALL trades for this IB from ib_trade_history
    // Only DEALS OUT: closed positions where profit exists (profit != 0)
    // Only from referred users, excluding IB's own trades
    const allTradesQuery = `
      SELECT 
        id, order_id, account_id, symbol, order_type, volume_lots, 
        open_price, close_price, profit, ib_commission, group_id,
        created_at, synced_at, updated_at
      FROM ib_trade_history
      WHERE ib_request_id = $1
        AND close_price IS NOT NULL 
        AND close_price != 0
        AND profit IS NOT NULL
        AND profit != 0
        AND synced_at >= $2
        ${userFilter}
      ORDER BY synced_at DESC
    `;

    const allTradesResult = await query(allTradesQuery, baseParams);
    const allTrades = allTradesResult.rows;

    // Calculate spread commission for each trade
    const enrichedTrades = allTrades.map(trade => {
      const groupId = trade.group_id || '';
      const normGroup = normalize(groupId);
      const assignment = assignmentMap.get(normGroup) || assignmentMap.get(String(groupId).toLowerCase()) || { spreadSharePercentage: 0 };
      const spreadCommission = Number(trade.volume_lots || 0) * (assignment.spreadSharePercentage / 100);
      const totalCommission = Number(trade.ib_commission || 0) + spreadCommission;

      return {
        ...trade,
        spreadCommission,
        totalCommission,
        profit: Number(trade.profit || 0),
        volumeLots: Number(trade.volume_lots || 0),
        ibCommission: Number(trade.ib_commission || 0)
      };
    });

    // Calculate statistics
    const totalCommission = enrichedTrades.reduce((sum, t) => sum + t.totalCommission, 0);
    const fixedCommission = enrichedTrades.reduce((sum, t) => sum + t.ibCommission, 0);
    const spreadCommission = enrichedTrades.reduce((sum, t) => sum + t.spreadCommission, 0);
    const totalProfit = enrichedTrades.reduce((sum, t) => sum + t.profit, 0);
    const totalVolume = enrichedTrades.reduce((sum, t) => sum + t.volumeLots, 0);
    const totalTrades = enrichedTrades.length;

    // This month's commission
    const thisMonthTrades = enrichedTrades.filter(t => new Date(t.synced_at) >= startOfMonth);
    const thisMonth = thisMonthTrades.reduce((sum, t) => sum + t.totalCommission, 0);

    // Average daily commission
    const avgDaily = period > 0 ? totalCommission / period : 0;

    // Active clients (distinct account IDs)
    const activeClients = new Set(enrichedTrades.map(t => String(t.account_id))).size;

    // Top 7 symbols by commission
    const symbolStats = new Map();
    enrichedTrades.forEach(trade => {
      const symbol = trade.symbol;
      if (!symbolStats.has(symbol)) {
        symbolStats.set(symbol, {
            symbol,
          commission: 0,
          trades: 0,
          volume: 0,
          profit: 0,
          fixedCommission: 0,
          spreadCommission: 0
        });
      }
      const stats = symbolStats.get(symbol);
      stats.commission += trade.totalCommission;
      stats.fixedCommission += trade.ibCommission;
      stats.spreadCommission += trade.spreadCommission;
      stats.trades += 1;
      stats.volume += trade.volumeLots;
      stats.profit += trade.profit;
    });

    const topSymbols = Array.from(symbolStats.values())
      .sort((a, b) => b.commission - a.commission)
      .slice(0, 7)
      .map(s => ({
        symbol: s.symbol,
        category: detectCategory(s.symbol),
        commission: s.commission,
        trades: s.trades,
        volume: s.volume,
        profit: s.profit,
        fixedCommission: s.fixedCommission,
        spreadCommission: s.spreadCommission
      }));

    // Monthly trend (last 12 months)
    const monthlyTrendMap = new Map();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    enrichedTrades.forEach(trade => {
      const date = new Date(trade.synced_at);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      const monthLabel = months[date.getMonth()];
      if (!monthlyTrendMap.has(monthKey)) {
        monthlyTrendMap.set(monthKey, { month: monthLabel, commission: 0 });
      }
      monthlyTrendMap.get(monthKey).commission += trade.totalCommission;
    });

    const monthlyTrend = Array.from(monthlyTrendMap.values())
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-12);

    // Commission by category
    const categoryMap = new Map();
    enrichedTrades.forEach(trade => {
      const category = detectCategory(trade.symbol);
      if (!categoryMap.has(category)) {
        categoryMap.set(category, 0);
      }
      categoryMap.set(category, categoryMap.get(category) + trade.totalCommission);
    });

    const categoryData = Array.from(categoryMap.entries()).map(([name, value]) => ({
      name,
      value
    }));

    // Paginated recent ledger (only DEALS OUT from ib_trade_history)
    // Only show closed positions where profit exists (profit != 0)
    // Use database-level pagination for better performance
    const ledgerQuery = `
      SELECT 
        id, order_id, account_id, symbol, order_type, volume_lots, 
        open_price, close_price, profit, ib_commission, group_id,
        created_at, synced_at, updated_at
      FROM ib_trade_history
      WHERE ib_request_id = $1
        AND close_price IS NOT NULL 
        AND close_price != 0
        AND profit IS NOT NULL
        AND profit != 0
        AND synced_at >= $2
      ORDER BY synced_at DESC
      LIMIT $3 OFFSET $4
    `;

    const ledgerResult = await query(ledgerQuery, [ibId, periodStart.toISOString(), limit, offset]);
    const ledgerTrades = ledgerResult.rows;

    // Enrich paginated ledger trades with spread commission
    const recentLedger = ledgerTrades.map(trade => {
      const groupId = trade.group_id || '';
      const normGroup = normalize(groupId);
      const assignment = assignmentMap.get(normGroup) || assignmentMap.get(String(groupId).toLowerCase()) || { spreadSharePercentage: 0 };
      const spreadCommission = Number(trade.volume_lots || 0) * (assignment.spreadSharePercentage / 100);
      const totalCommission = Number(trade.ib_commission || 0) + spreadCommission;

      return {
        id: trade.id,
        orderId: trade.order_id,
        date: trade.synced_at || trade.updated_at || trade.created_at,
        accountId: trade.account_id,
        symbol: trade.symbol,
        orderType: trade.order_type,
        volumeLots: Number(trade.volume_lots || 0),
        openPrice: Number(trade.open_price || 0),
        closePrice: Number(trade.close_price || 0),
        profit: Number(trade.profit || 0),
        commission: Number(trade.ib_commission || 0),
        spreadCommission,
        totalCommission,
        groupId: trade.group_id || 'N/A'
      };
    });

    const totalPages = Math.ceil(totalCount / limit);

    // Comprehensive report data
    const reportData = {
      totalTrades,
      totalVolume,
      avgCommissionPerTrade: totalTrades > 0 ? totalCommission / totalTrades : 0,
      totalProfit,
      bestPerformingSymbol: topSymbols.length > 0 ? topSymbols[0] : null,
      mostActiveSymbol: Array.from(symbolStats.values())
        .sort((a, b) => b.trades - a.trades)[0] || null,
      commissionToProfitRatio: totalProfit !== 0 ? totalCommission / Math.abs(totalProfit) : 0
    };

    const payload = { 
      stats: {
        totalCommission,
        fixedCommission,
        spreadCommission,
        thisMonth,
        avgDaily,
      activeClients,
        totalTrades,
        totalVolume,
        totalProfit
      },
      topSymbols,
      recentLedger,
      monthlyTrend,
      categoryData,
      reportData,
      pagination: {
        currentPage: page,
        totalPages,
        totalItems: totalCount,
        itemsPerPage: limit,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      }
    };

    // Cache for 5 minutes (300,000 ms)
    analyticsCache.set(cacheKey, { expires: Date.now() + 300_000, payload });
    res.json({ success: true, data: payload });
  } catch (e) {
    console.error('Commission analytics error:', e);
    res.status(500).json({ success: false, message: 'Unable to fetch commission analytics', error: process.env.NODE_ENV !== 'production' ? String(e) : undefined });
  }
});

// Helper function to detect symbol category
function detectCategory(symbol) {
  if (!symbol) return 'Other';
  const s = String(symbol).toUpperCase();
  if (/^[A-Z]{3}USD$/.test(s) || /^USD[A-Z]{3}$/.test(s) || /^XAUUSD$/.test(s) || /^XAGUSD$/.test(s)) {
    return 'Forex';
  }
  if (/^BTC|^ETH|^LTC|^XRP|^DOGE/.test(s)) {
    return 'Crypto';
  }
  if (/^[A-Z]{2,4}$/.test(s) && (s.includes('US') || s.includes('EU'))) {
    return 'Indices';
  }
  return 'Other';
}

// GET /api/user/commission -> totals and history
router.get('/commission', authenticateToken, async (req, res) => {
  try {
    const ib = req.user;
    const ibId = ib.id;

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

    // Get IB's own user_id to exclude
    const ibUserId = await getIBUserId(ibId);
    // Get referred user_ids to include
    const referredUserIds = await getReferredUserIds(ibId);

    if (referredUserIds.length === 0) {
      return res.json({ success: true, data: { total: 0, fixed: 0, spreadShare: 0, pending: 0, paid: 0, history: [] } });
    }

    // Try to get from ib_commission table first (if less than 4 hours old)
    let total = 0;
    let fixed = 0;
    let spreadShare = 0;
    let useCached = false;

    if (ibUserId) {
      try {
        const cachedCommission = await IBCommission.getByIBAndUser(ibId, ibUserId);
        if (cachedCommission && cachedCommission.last_updated) {
          const lastUpdated = new Date(cachedCommission.last_updated);
          const now = new Date();
          const hoursDiff = (now - lastUpdated) / (1000 * 60 * 60);
          
          if (hoursDiff < 4) {
            total = Number(cachedCommission.total_commission || 0);
            useCached = true;
            console.log(`[User Commission] Using cached commission from ib_commission table: ${total}`);
          }
        }
      } catch (error) {
        console.warn('[User Commission] Could not fetch from ib_commission table:', error.message);
      }
    }

    // Get commission groups map
    const groupsResult = await query(
      `SELECT group_id, usd_per_lot, spread_share_percentage
       FROM ib_group_assignments WHERE ib_request_id = $1`,
      [ibId]
    );

    // Build commission groups map
    const commissionGroupsMap = new Map();
    for (const r of groupsResult.rows) {
      const k = normalizeGroupId(r.group_id);
      if (k) {
        commissionGroupsMap.set(k, {
          spreadPct: Number(r.spread_share_percentage || 0),
          usdPerLot: Number(r.usd_per_lot || 0)
        });
      }
    }

    // If not using cached, calculate from trade history
    if (!useCached && commissionGroupsMap.size > 0) {
      // Build WHERE clause to exclude IB's own trades and only include referred users' trades
      let userFilter = '';
      const params = [ibId];
      if (ibUserId) {
        params.push(ibUserId);
        userFilter = `AND user_id != $${params.length}`;
      }
      params.push(referredUserIds);
      const userInClause = `AND user_id = ANY($${params.length}::text[])`;

      // Fetch trades - only from referred users, excluding IB's own trades (only closed trades with profit != 0)
      const tradesRes = await query(
        `SELECT group_id, volume_lots
         FROM ib_trade_history
         WHERE ib_request_id = $1 
           AND close_price IS NOT NULL 
           AND close_price != 0 
           AND profit != 0
           ${userFilter}
           ${userInClause}`,
        params
      );

      // Calculate commission using helper function
      const commissionResult = calculateCommissionFromTrades(tradesRes.rows, commissionGroupsMap);
      total = commissionResult.total;
      fixed = commissionResult.fixed;
      spreadShare = commissionResult.spread;

      // Save to ib_commission table
      if (ibUserId) {
        try {
          await IBCommission.upsertCommission(ibId, ibUserId, {
            totalCommission: total,
            totalTrades: commissionResult.totalTrades,
            totalLots: commissionResult.totalLots
          });
        } catch (error) {
          console.warn('[User Commission] Could not save to ib_commission table:', error.message);
        }
      }
    } else if (useCached) {
      // If using cached, we still need to calculate fixed and spread for display
      // We'll fetch a sample of trades to calculate the ratio
      let userFilter = '';
      const params = [ibId];
      if (ibUserId) {
        params.push(ibUserId);
        userFilter = `AND user_id != $${params.length}`;
      }
      params.push(referredUserIds);
      const userInClause = `AND user_id = ANY($${params.length}::text[])`;

      const tradesRes = await query(
        `SELECT group_id, volume_lots
         FROM ib_trade_history
         WHERE ib_request_id = $1 
           AND close_price IS NOT NULL 
           AND close_price != 0 
           AND profit != 0
           ${userFilter}
           ${userInClause}
         LIMIT 1000`,
        params
      );

      const commissionResult = calculateCommissionFromTrades(tradesRes.rows, commissionGroupsMap);
      if (commissionResult.total > 0) {
        const ratio = total / commissionResult.total;
        fixed = commissionResult.fixed * ratio;
        spreadShare = commissionResult.spread * ratio;
      }
    }

    // Fetch full trade history for display (only closed trades with profit != 0)
    let userFilter = '';
    const params = [ibId];
    if (ibUserId) {
      params.push(ibUserId);
      userFilter = `AND user_id != $${params.length}`;
    }
    params.push(referredUserIds);
    const userInClause = `AND user_id = ANY($${params.length}::text[])`;

    const historyRes = await query(
      `SELECT account_id, order_id, symbol, group_id, volume_lots, profit, synced_at, updated_at
       FROM ib_trade_history
       WHERE ib_request_id = $1 
         AND close_price IS NOT NULL 
         AND close_price != 0 
         AND profit != 0
         ${userFilter}
         ${userInClause}
       ORDER BY synced_at DESC, updated_at DESC
       LIMIT 200`,
      params
    );

    // Build history with proper commission calculation
    const history = historyRes.rows.map((r, idx) => {
      const normalized = normalizeGroupId(r.group_id);
      const rule = findMatchingRule(normalized, commissionGroupsMap);
      
      let fixedCommission = 0;
      let spreadCommission = 0;
      
      if (rule) {
        const lots = Number(r.volume_lots || 0);
        fixedCommission = lots * Number(rule.usdPerLot || 0);
        spreadCommission = lots * (Number(rule.spreadPct || 0) / 100);
      }
      
      const totalIb = fixedCommission + spreadCommission;
      
      const detectTypeName = (nameOrId) => {
        const s = (nameOrId || '').toString().toLowerCase();
        return s.includes('pro') ? 'Pro' : 'Standard';
      };
      const groupDisplay = detectTypeName(r.group_id);
      
      return {
        id: String(r.order_id || idx+1),
        dealId: String(r.order_id || ''),
        accountId: String(r.account_id || ''),
        symbol: r.symbol || '-',
        lots: Number(r.volume_lots || 0),
        profit: Number(r.profit || 0),
        commission: fixedCommission,
        spreadCommission: spreadCommission,
        ibCommission: totalIb,
        group: groupDisplay,
        closeTime: r.updated_at || r.synced_at,
        status: 'Accrued'
      };
    });

    res.json({ success: true, data: { total, fixed, spreadShare, pending: 0, paid: 0, history } });
  } catch (e) {
    console.error('Commission summary error:', e);
    res.status(500).json({ success: false, message: 'Unable to fetch commission summary' });
  }
});

// GET /api/user/trades -> paginated trade history from DB with spread pct enriched
// Only shows trades from referred users, excluding IB's own trades
router.get('/trades', authenticateToken, async (req, res) => {
  try {
    const ib = req.user;
    const ibId = ib.id;
    const { accountId = null, page = 1, pageSize = 50 } = req.query;

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

    // Get IB's own user_id to exclude
    const ibUserId = await getIBUserId(ibId);
    // Get referred user_ids to include
    const referredUserIds = await getReferredUserIds(ibId);

    if (referredUserIds.length === 0) {
      return res.json({ success: true, data: { trades: [], total: 0, page: Number(page), pageSize: Number(pageSize) } });
    }

    const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

    // Simple 30s cache for paginated responses
    const cacheKey = `user-trades:${ibId}:${accountId||'*'}:${limit}:${offset}`;
    const cached = analyticsCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return res.json({ success: true, data: cached.payload });
    }

    // Build WHERE clause to exclude IB's own trades and only include referred users' trades
    let userFilter = '';
    const params = [ibId];
    if (ibUserId) {
      params.push(ibUserId);
      userFilter = `AND user_id != $${params.length}`;
    }
    params.push(referredUserIds);
    const userInClause = `AND user_id = ANY($${params.length}::text[])`;

    let accountFilter = '';
    if (accountId) {
      params.push(String(accountId));
      accountFilter = `AND account_id = $${params.length}`;
    }

    // Count total trades
    const countQuery = `
      SELECT COUNT(*)::int AS count 
      FROM ib_trade_history 
      WHERE ib_request_id = $1 
        AND close_price IS NOT NULL 
        AND close_price != 0 
        AND profit != 0
        ${userFilter}
        ${userInClause}
        ${accountFilter}
    `;
    const countRes = await query(countQuery, params);
    const total = Number(countRes.rows?.[0]?.count || 0);

    // Fetch trades from all referred users, excluding IB's own trades
    params.push(Number(limit), Number(offset));
    const listQuery = `
      SELECT *
      FROM ib_trade_history
      WHERE ib_request_id = $1 
        AND close_price IS NOT NULL 
        AND close_price != 0 
        AND profit != 0
        ${userFilter}
        ${userInClause}
        ${accountFilter}
      ORDER BY synced_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const listRes = await query(listQuery, params);
    
    const trades = listRes.rows.map((row) => ({
      account_id: row.account_id,
      mt5_deal_id: row.order_id,
      order_id: row.order_id,
      symbol: row.symbol,
      volume_lots: Number(row.volume_lots || 0),
      lots: Number(row.volume_lots || 0),
      profit: Number(row.profit || 0),
      commission: 0,
      ib_commission: Number(row.ib_commission || 0),
      group_id: row.group_id || null,
      close_time: row.updated_at || row.synced_at || null,
      synced_at: row.synced_at,
      updated_at: row.updated_at
    }));

    let result = {
      trades,
      total,
      page: Math.floor(Number(offset) / (Number(limit) || 1)) + 1,
      pageSize: Number(limit)
    };

    // Enrich with commission calculation using approved group assignments
    try {
      const assignments = await query(
        `SELECT group_id, usd_per_lot, spread_share_percentage
         FROM ib_group_assignments WHERE ib_request_id = $1`,
        [ibId]
      );

      // Build commission groups map
      const commissionGroupsMap = new Map();
      for (const r of assignments.rows) {
        const k = normalizeGroupId(r.group_id);
        if (k) {
          commissionGroupsMap.set(k, {
            spreadPct: Number(r.spread_share_percentage || 0),
            usdPerLot: Number(r.usd_per_lot || 0)
          });
        }
      }

      // Calculate commission for each trade using the same logic as admin
      result.trades = result.trades.map(t => {
        const normalized = normalizeGroupId(t.group_id);
        const rule = findMatchingRule(normalized, commissionGroupsMap);
        
        let fixedCommission = 0;
        let spreadCommission = 0;
        let spreadPct = 0;
        
        if (rule) {
          const lots = Number(t.volume_lots || t.lots || 0);
          const usdPerLot = Number(rule.usdPerLot || 0);
          spreadPct = Number(rule.spreadPct || 0);
          
          fixedCommission = lots * usdPerLot;
          spreadCommission = lots * (spreadPct / 100);
        }
        
        return {
          ...t,
          ib_commission: fixedCommission,
          fixed_commission: fixedCommission,
          spread_commission: spreadCommission,
          spread_pct: spreadPct
        };
      });
    } catch (error) {
      console.error('Error enriching trades with commission:', error);
    }

    // cache 30s
    analyticsCache.set(cacheKey, { expires: Date.now() + 30_000, payload: result });
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('User trades error:', e);
    res.status(500).json({ success: false, message: 'Unable to fetch trades' });
  }
});

// PUT /api/user/referral-code -> update referral code
router.put('/referral-code', authenticateToken, async (req, res) => {
  try {
    const ibId = req.user.id;
    const { referralCode } = req.body;

    if (!referralCode || typeof referralCode !== 'string') {
      return res.status(400).json({ success: false, message: 'Referral code is required' });
    }

    const trimmedCode = referralCode.trim().toUpperCase();
    
    if (trimmedCode.length > 8) {
      return res.status(400).json({ success: false, message: 'Referral code must be 8 characters or less' });
    }

    if (trimmedCode.length === 0) {
      return res.status(400).json({ success: false, message: 'Referral code cannot be empty' });
    }

    if (!/^[A-Z0-9]+$/.test(trimmedCode)) {
      return res.status(400).json({ success: false, message: 'Referral code must contain only uppercase letters and numbers' });
    }

    // Check if code already exists (excluding current IB)
    const existing = await query(
      'SELECT id FROM ib_requests WHERE referral_code = $1 AND id != $2',
      [trimmedCode, ibId]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'Referral code already exists. Please choose a different code.' });
    }

    // Update the referral code
    const result = await query(
      'UPDATE ib_requests SET referral_code = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING referral_code',
      [trimmedCode, ibId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'IB not found' });
    }

    res.json({ success: true, message: 'Referral code updated successfully', data: { referralCode: result.rows[0].referral_code } });
  } catch (e) {
    console.error('Update referral code error:', e);
    res.status(500).json({ success: false, message: 'Unable to update referral code' });
  }
});

// GET /api/user/ib-tree -> simplified tree built from referrals with full details
router.get('/ib-tree', authenticateToken, async (req, res) => {
  try {
    const rootId = req.user.id;

    const getOwnStats = async (ibId) => {
      const r = await query(
        `SELECT COALESCE(SUM(volume_lots),0) as own_lots, COUNT(*)::int as trade_count
         FROM ib_trade_history 
         WHERE ib_request_id = $1 
           AND close_price IS NOT NULL 
           AND close_price != 0 
           AND profit IS NOT NULL
           AND profit != 0`,
        [ibId]
      );
      const row = r.rows[0] || {};
      return { ownLots: Number(row.own_lots || 0), tradeCount: Number(row.trade_count || 0) };
    };

    const getIb = async (ibId) => {
      const r = await query(
        `SELECT 
          id, full_name, email, status, ib_type, referral_code, 
          referred_by, submitted_at, approved_at, usd_per_lot, 
          spread_percentage_per_lot
         FROM ib_requests 
         WHERE id = $1`, 
        [ibId]
      );
      return r.rows[0] || null;
    };

    const getReferrerDetails = async (referredById) => {
      if (!referredById) return null;
      const r = await query(
        `SELECT id, full_name, email, referral_code 
         FROM ib_requests 
         WHERE id = $1`,
        [referredById]
      );
      return r.rows[0] || null;
    };

    const getChildren = async (ibId) => {
      const r = await query('SELECT id FROM ib_requests WHERE referred_by = $1 ORDER BY submitted_at DESC', [ibId]);
      return r.rows.map(x => x.id);
    };

    // CRM-referred traders for this IB
    const getReferredTraders = async (ibId) => {
      const r = await query(
        'SELECT id AS ref_id, user_id, email, created_at FROM ib_referrals WHERE ib_request_id = $1 ORDER BY created_at DESC',
        [ibId]
      );
      return r.rows;
    };

    const build = async (ibId) => {
      const ib = await getIb(ibId);
      if (!ib) return null;
      
      const { ownLots, tradeCount } = await getOwnStats(ibId);
      const childIds = await getChildren(ibId);
      const children = [];
      let teamLots = 0;

      for (const cid of childIds) {
        const node = await build(cid);
        if (node) {
          children.push(node);
          teamLots += node.ownLots + (node.teamLots || 0);
        }
      }

      // Add CRM-referred traders as leaf nodes
      try {
        const traders = await getReferredTraders(ibId);
        for (const t of traders) {
          // Stats for this referred user under this IB
          const statsRes = await query(
            `SELECT COALESCE(SUM(volume_lots),0) AS lots, COUNT(*)::int AS trade_count
             FROM ib_trade_history
             WHERE ib_request_id = $1 AND user_id = $2
               AND close_price IS NOT NULL AND close_price != 0 AND profit != 0`,
            [ibId, t.user_id]
          );
          const lots = Number(statsRes.rows?.[0]?.lots || 0);
          const tradeCount = Number(statsRes.rows?.[0]?.trade_count || 0);
          children.push({
            id: `trader-${t.user_id || t.ref_id}`,
            name: t.email,
            email: t.email,
            status: 'trader',
            ibType: 'Trader',
            referralCode: null,
            referredBy: ibId,
            referredByName: (await getReferrerDetails(ibId))?.full_name || null,
            referredByEmail: (await getReferrerDetails(ibId))?.email || null,
            referredByCode: (await getReferrerDetails(ibId))?.referral_code || null,
            submittedAt: t.created_at,
            approvedAt: null,
            usdPerLot: 0,
            spreadPercentage: 0,
            ownLots: lots,
            tradeCount,
            teamLots: 0,
            children: []
          });
        }
      } catch {}
      
      // Get referrer details if this IB was referred by someone
      const referrer = ib.referred_by ? await getReferrerDetails(ib.referred_by) : null;
      
      return { 
        id: ib.id, 
        name: ib.full_name, 
        email: ib.email, 
        status: ib.status,
        ibType: ib.ib_type || 'N/A',
        referralCode: ib.referral_code || 'N/A',
        referredBy: ib.referred_by,
        referredByName: referrer ? referrer.full_name : null,
        referredByEmail: referrer ? referrer.email : null,
        referredByCode: referrer ? referrer.referral_code : null,
        submittedAt: ib.submitted_at,
        approvedAt: ib.approved_at,
        usdPerLot: Number(ib.usd_per_lot || 0),
        spreadPercentage: Number(ib.spread_percentage_per_lot || 0),
        ownLots, 
        tradeCount, 
        teamLots, 
        children 
      };
    };

    const root = await build(rootId);
    const totalTrades = (function count(n) { 
      if (!n) return 0; 
      return Number(n.tradeCount || 0) + (n.children || []).reduce((s,c)=> s+count(c),0); 
    })(root);
    
    res.json({ 
      success: true, 
      data: { 
        ownLots: Number(root?.ownLots || 0), 
        teamLots: Number(root?.teamLots || 0), 
        totalTrades, 
        root 
      } 
    });
  } catch (e) {
    console.error('IB tree error:', e);
    res.status(500).json({ success: false, message: 'Unable to fetch IB tree' });
  }
});

export default router;
