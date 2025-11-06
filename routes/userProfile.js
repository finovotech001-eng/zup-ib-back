import express from 'express';
import { authenticateToken } from './auth.js';
import { query } from '../config/database.js';

const router = express.Router();

const MT5_API_BASE = 'http://18.175.242.21:5003';

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
    const userResult = await query('SELECT id FROM "User" WHERE email = $1', [ib.email]);
    if (!userResult.rows.length) {
      return res.json({ success: true, data: { stats: { totalAccounts: 0, totalBalance: 0, totalEquity: 0, accountStatus: ib.status }, accounts: [], commissionInfo: { standard: `$${Number(ib.usd_per_lot || 0).toFixed(2)} per lot`, commissionType: 'Commission per lot' }, groups: [] } });
    }

    const userId = userResult.rows[0].id;
    const accountsRes = await query('SELECT "accountId" FROM "MT5Account" WHERE "userId" = $1', [userId]);

    const accountsRaw = await Promise.all(
      accountsRes.rows.map(async (r) => {
        const payload = await fetchMt5Profile(r.accountId);
        const balance = Number(payload?.Balance ?? payload?.balance ?? 0);
        const equity = Number(payload?.Equity ?? payload?.equity ?? 0);
        const margin = Number(payload?.Margin ?? payload?.margin ?? 0);
        const profit = Number(payload?.Profit ?? payload?.profit ?? 0);
        const groupFull = payload?.Group || payload?.group || '';
        const accountType = payload?.AccountType ?? payload?.accountType ?? payload?.AccountTypeText ?? payload?.accountTypeText ?? '';
        const isDemo = String(groupFull).toLowerCase().includes('demo') || String(accountType).toLowerCase().includes('demo');
        let groupName = groupFull;
        if (typeof groupName === 'string') {
          const parts = groupName.split(/[\\/]/);
          groupName = parts[parts.length - 1] || groupName;
        }
        return { accountId: String(r.accountId), balance, equity, margin, profit, group: groupName, groupId: groupFull, isDemo };
      })
    );

    let accounts = accountsRaw.filter(a => !a.isDemo);
    const totals = accounts.reduce((t, a) => ({ totalAccounts: (t.totalAccounts || 0) + 1, totalBalance: (t.totalBalance || 0) + a.balance, totalEquity: (t.totalEquity || 0) + a.equity }), { totalAccounts: 0, totalBalance: 0, totalEquity: 0 });

    // Group assignments with simple aggregates from ib_trade_history
    const assignments = await query(
      `SELECT group_id, group_name, structure_name, usd_per_lot, spread_share_percentage
       FROM ib_group_assignments WHERE ib_request_id = $1`,
      [ib.id]
    );
    // Aggregates per account (for card display)
    const tradesRes = await query(
      `SELECT account_id, COALESCE(SUM(volume_lots),0) AS lots, COALESCE(SUM(ib_commission),0) AS commission
       FROM ib_trade_history WHERE ib_request_id = $1 AND close_price IS NOT NULL AND close_price != 0 AND profit != 0
       GROUP BY account_id`,
      [ib.id]
    );
    const accountToGroup = Object.fromEntries(accounts.map(a => [a.accountId, (a.groupId || '').toLowerCase()]));
    const groupAgg = {};
    for (const row of tradesRes.rows) {
      const key = (accountToGroup[row.account_id] || '').toLowerCase();
      if (!key) continue;
      if (!groupAgg[key]) groupAgg[key] = { lots: 0, commission: 0 };
      groupAgg[key].lots += Number(row.lots || 0);
      groupAgg[key].commission += Number(row.commission || 0);
    }

    // Attach per-account totals (fixed + lots) and commission eligibility by group assignment
    const perAccountMap = tradesRes.rows.reduce((m, r) => {
      m[String(r.account_id)] = Number(r.commission || 0);
      return m;
    }, {});
    const lotsByAccount = tradesRes.rows.reduce((m, r) => {
      m[String(r.account_id)] = Number(r.lots || 0);
      return m;
    }, {});

    // Build assignment map by normalized group id/name for quick lookup
    const normalize = (gid) => {
      if (!gid) return '';
      const s = String(gid).toLowerCase().trim();
      const parts = s.split(/[\\/]/);
      return parts[parts.length - 1] || s;
    };
    const assignmentMap = assignments.rows.reduce((m, r) => {
      const k = normalize(r.group_id);
      if (!k) return m;
      m[k] = {
        usdPerLot: Number(r.usd_per_lot || 0),
        spreadPct: Number(r.spread_share_percentage || 0)
      };
      return m;
    }, {});

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
      const grpRes = await query(
        `SELECT group_id, COUNT(*)::int AS trades, COALESCE(SUM(volume_lots),0) AS lots, COALESCE(SUM(profit),0) AS profit, COALESCE(SUM(ib_commission),0) AS fixed
         FROM ib_trade_history WHERE ib_request_id = $1 AND close_price IS NOT NULL AND close_price != 0 AND profit != 0
         GROUP BY group_id`,
        [ib.id]
      );
      // Build assignment map
      const normalize = (gid) => {
        if (!gid) return '';
        const s = String(gid).toLowerCase().trim();
        const parts = s.split(/[\\/]/);
        return parts[parts.length - 1] || s;
      };
      const assignmentMap = assignments.rows.reduce((m, r) => {
        const k = normalize(r.group_id);
        if (!k) return m;
        m[k] = { spreadPct: Number(r.spread_share_percentage || 0) };
        return m;
      }, {});

      for (const row of grpRes.rows) {
        const k = normalize(row.group_id);
        if (!assignmentMap[k]) continue; // only approved groups
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

// GET /api/user/commission-analytics
router.get('/commission-analytics', authenticateToken, async (req, res) => {
  try {
    const ib = req.user; // has id and email
    const ibId = ib.id;
    const period = Math.max(parseInt(req.query.period || '30', 10), 1);

    // 1) Resolve this user's real MT5 accounts (exclude demos)
    const userResult = await query('SELECT id FROM "User" WHERE email = $1', [ib.email]);
    const allowedAccounts = new Set();
    let hasRealAccounts = false;
    if (userResult.rows.length) {
      const userId = userResult.rows[0].id;
      const accountsRes = await query('SELECT "accountId" FROM "MT5Account" WHERE "userId" = $1', [userId]);
      const profiles = await Promise.all(accountsRes.rows.map(async r => ({ id: String(r.accountId), prof: await fetchMt5Profile(r.accountId) })));
      for (const { id, prof } of profiles) {
        const group = prof?.Group || prof?.group || '';
        const accountType = prof?.AccountType ?? prof?.accountType ?? prof?.AccountTypeText ?? prof?.accountTypeText ?? '';
        const isDemo = String(group).toLowerCase().includes('demo') || String(accountType).toLowerCase().includes('demo');
        if (!isDemo) { allowedAccounts.add(id); hasRealAccounts = true; }
      }
    }

    // 2) Build approved group map from assignments
    const assignments = await query(
      `SELECT group_id, group_name, structure_name, usd_per_lot, spread_share_percentage
       FROM ib_group_assignments WHERE ib_request_id = $1`,
      [ibId]
    );
    const normalize = (gid) => {
      if (!gid) return '';
      const s = String(gid).toLowerCase().trim();
      const parts = s.split(/[\\/]/);
      return parts[parts.length - 1] || s;
    };
    const approvedMap = new Map();
    for (const row of assignments.rows) {
      const keys = new Set();
      const gid = String(row.group_id || '').toLowerCase();
      const gname = String(row.group_name || '').toLowerCase();
      if (gid) keys.add(gid);
      if (gname) keys.add(gname);
      const shortKey = normalize(gid);
      if (shortKey) keys.add(shortKey);
      for (const k of keys) {
        approvedMap.set(k, {
          structureName: row.structure_name,
          usdPerLot: Number(row.usd_per_lot || 0),
          spreadSharePercentage: Number(row.spread_share_percentage || 0)
        });
      }
    }

    // 3) Fetch trades and filter to allowed accounts + approved groups
    const tradesRes = await query(
      `SELECT account_id, symbol, volume_lots, ib_commission, group_id, profit, synced_at
       FROM ib_trade_history
       WHERE ib_request_id = $1 AND close_price IS NOT NULL AND close_price != 0 AND profit != 0`,
      [ibId]
    );

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodStart = new Date(now.getTime() - period * 24 * 60 * 60 * 1000);

    const filtered = tradesRes.rows.filter((r) => {
      const accOk = hasRealAccounts ? allowedAccounts.has(String(r.account_id)) : false;
      const key = normalize(r.group_id);
      const groupOk = approvedMap.size > 0 ? (approvedMap.has(key) || approvedMap.has(String(r.group_id || '').toLowerCase())) : false;
      return accOk && groupOk;
    });

    // Aggregations
    const sumFixed = (arr) => arr.reduce((s, x) => s + Number(x.ib_commission || 0), 0);
    const sumSpread = (arr) => arr.reduce((s, x) => {
      const key = normalize(x.group_id);
      const m = approvedMap.get(key) || approvedMap.get(String(x.group_id || '').toLowerCase());
      const pct = Number(m?.spreadSharePercentage || 0);
      return s + (Number(x.volume_lots || 0) * (pct / 100));
    }, 0);

    const fixedTotal = sumFixed(filtered);
    const spreadTotal = sumSpread(filtered);
    const totalCommission = fixedTotal + spreadTotal;

    const thisMonthArr = filtered.filter(r => new Date(r.synced_at) >= startOfMonth);
    const thisMonth = sumFixed(thisMonthArr) + sumSpread(thisMonthArr);

    const periodArr = filtered.filter(r => new Date(r.synced_at) >= periodStart);
    const periodTotal = sumFixed(periodArr) + sumSpread(periodArr);
    const avgDaily = periodTotal / period;

    // Top symbols
    const bySymbol = new Map();
    for (const r of filtered) {
      const key = r.symbol;
      const grpKey = normalize(r.group_id);
      const m = approvedMap.get(grpKey) || approvedMap.get(String(r.group_id || '').toLowerCase());
      const pct = Number(m?.spreadSharePercentage || 0);
      const spread = Number(r.volume_lots || 0) * (pct / 100);
      const entry = bySymbol.get(key) || { symbol: key, trades: 0, lots: 0, fixed: 0, spread: 0, commission: 0 };
      entry.trades += 1;
      entry.lots += Number(r.volume_lots || 0);
      entry.fixed += Number(r.ib_commission || 0);
      entry.spread += spread;
      entry.commission = entry.fixed + entry.spread;
      bySymbol.set(key, entry);
    }
    const topSymbols = Array.from(bySymbol.values())
      .sort((a,b)=> b.commission - a.commission)
      .slice(0,20)
      .map(x => ({ symbol: x.symbol, category: '—', pips: 0, commission: x.commission, fixedCommission: x.fixed, spreadCommission: x.spread, trades: x.trades }));

    // Recent ledger
    const recentLedger = [...filtered]
      .sort((a,b)=> new Date(b.synced_at) - new Date(a.synced_at))
      .slice(0,200)
      .map(r => ({
        date: r.synced_at,
        client: '—',
        mt5Account: r.account_id,
        group: (function(){
          const s = String(r.group_id || '').toLowerCase();
          return s.includes('pro') ? 'Pro' : 'Standard';
        })(),
        symbol: r.symbol,
        lots: Number(r.volume_lots || 0),
        commission: Number(r.ib_commission || 0),
        spreadCommission: (function(){
          const key = normalize(r.group_id);
          const m = approvedMap.get(key) || approvedMap.get(String(r.group_id || '').toLowerCase());
          const pct = Number(m?.spreadSharePercentage || 0);
          return Number(r.volume_lots || 0) * (pct / 100);
        })(),
        totalCommission: (function(){
          const key = normalize(r.group_id);
          const m = approvedMap.get(key) || approvedMap.get(String(r.group_id || '').toLowerCase());
          const pct = Number(m?.spreadSharePercentage || 0);
          const spread = Number(r.volume_lots || 0) * (pct / 100);
          return Number(r.ib_commission || 0) + spread;
        })()
      }));

    // Monthly trend for current year
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const trendMap = new Map();
    for (const r of filtered) {
      const d = new Date(r.synced_at);
      if (d.getFullYear() !== now.getFullYear()) continue;
      const label = months[d.getMonth()];
      const key = normalize(r.group_id);
      const m = approvedMap.get(key) || approvedMap.get(String(r.group_id || '').toLowerCase());
      const pct = Number(m?.spreadSharePercentage || 0);
      const spread = Number(r.volume_lots || 0) * (pct / 100);
      const total = Number(r.ib_commission || 0) + spread;
      trendMap.set(label, (trendMap.get(label) || 0) + total);
    }
    const monthlyTrend = months.map(m => ({ month: m, commission: Number(trendMap.get(m) || 0) }))
      .filter(x => x.commission > 0 || months.indexOf(x.month) === now.getMonth());

    // Basic category split by symbol prefix (fallback when no mapping table)
    const catMap = {};
    for (const t of topSymbols) {
      const cat = /^[A-Z]{3}USD|^XAU|^XAG/.test(t.symbol) ? 'Forex' : 'Other';
      catMap[cat] = (catMap[cat] || 0) + Number(t.commission || 0);
    }
    const categoryData = Object.entries(catMap).map(([name, value]) => ({ name, value }));

    // Active clients = distinct MT5 accounts contributing commission
    const activeClients = new Set(filtered.map(r => String(r.account_id))).size;

    res.json({ success: true, data: { 
      stats: { totalCommission, fixedCommission: fixedTotal, spreadCommission: spreadTotal, thisMonth, avgDaily },
      activeClients,
      topSymbols,
      recentLedger,
      monthlyTrend,
      categoryData
    } });
  } catch (e) {
    console.error('Commission analytics error:', e);
    res.status(500).json({ success: false, message: 'Unable to fetch commission analytics' });
  }
});

// GET /api/user/commission -> totals and history
router.get('/commission', authenticateToken, async (req, res) => {
  try {
    const ib = req.user;
    const ibId = ib.id;

    // Resolve allowed real (non-demo) MT5 accounts for this user
    const userResult = await query('SELECT id FROM "User" WHERE email = $1', [ib.email]);
    const allowedAccounts = new Set();
    if (userResult.rows.length) {
      const userId = userResult.rows[0].id;
      const accountsRes = await query('SELECT "accountId" FROM "MT5Account" WHERE "userId" = $1', [userId]);
      const profiles = await Promise.all(accountsRes.rows.map(async r => ({ id: String(r.accountId), prof: await fetchMt5Profile(r.accountId) })));
      for (const { id, prof } of profiles) {
        const group = prof?.Group || prof?.group || '';
        const accountType = prof?.AccountType ?? prof?.accountType ?? prof?.AccountTypeText ?? prof?.accountTypeText ?? '';
        const isDemo = String(group).toLowerCase().includes('demo') || String(accountType).toLowerCase().includes('demo');
        if (!isDemo) allowedAccounts.add(id);
      }
    }

    // Approved groups map from assignments
    const assignments = await query(
      `SELECT group_id, group_name, spread_share_percentage
       FROM ib_group_assignments WHERE ib_request_id = $1`,
      [ibId]
    );
    const normalize = (gid) => {
      if (!gid) return '';
      const s = String(gid).toLowerCase().trim();
      const parts = s.split(/[\\/]/);
      return parts[parts.length - 1] || s;
    };
    const approvedMap = new Map();
    for (const row of assignments.rows) {
      const keys = new Set();
      const gid = String(row.group_id || '').toLowerCase();
      const gname = String(row.group_name || '').toLowerCase();
      if (gid) keys.add(gid);
      if (gname) keys.add(gname);
      const shortKey = normalize(gid);
      if (shortKey) keys.add(shortKey);
      for (const k of keys) {
        approvedMap.set(k, Number(row.spread_share_percentage || 0));
      }
    }

    // Fetch trades and filter to allowed accounts + approved groups
    const tradesRes = await query(
      `SELECT account_id, order_id, symbol, group_id, volume_lots, profit, ib_commission, synced_at, updated_at
       FROM ib_trade_history
       WHERE ib_request_id = $1 AND close_price IS NOT NULL AND close_price != 0 AND profit != 0`,
      [ibId]
    );
    const filtered = tradesRes.rows.filter((r) => {
      const accOk = allowedAccounts.size ? allowedAccounts.has(String(r.account_id)) : false;
      const key = normalize(r.group_id);
      const groupOk = approvedMap.size ? (approvedMap.has(key) || approvedMap.has(String(r.group_id || '').toLowerCase())) : false;
      return accOk && groupOk;
    });

    // Totals
    let fixed = 0, spreadShare = 0;
    for (const r of filtered) {
      fixed += Number(r.ib_commission || 0);
      const key = normalize(r.group_id);
      const pct = approvedMap.get(key) || approvedMap.get(String(r.group_id || '').toLowerCase()) || 0;
      spreadShare += Number(r.volume_lots || 0) * (Number(pct) / 100);
    }
    const total = fixed + spreadShare;

    // History: keep fixed items (UI expects a single number per row)
    const history = filtered
      .sort((a,b)=> new Date(b.synced_at || b.updated_at) - new Date(a.synced_at || a.updated_at))
      .slice(0,200)
      .map((r, idx) => {
        const key = normalize(r.group_id);
        const pct = approvedMap.get(key) || approvedMap.get(String(r.group_id || '').toLowerCase()) || 0;
        const spread = Number(r.volume_lots || 0) * (Number(pct) / 100);
        const totalIb = Number(r.ib_commission || 0) + spread;
        const detectTypeName = (nameOrId) => {
          const s = (nameOrId || '').toString().toLowerCase();
          return s.includes('pro') ? 'Pro' : 'Standard';
        };
        const groupDisplay = detectTypeName(r.group_id);
        return {
          id: String(r.order_id || idx+1),
          dealId: String(r.order_id || ''),
          accountId: String(r.account_id || ''),
          symbol: r.symbol || '- ',
          lots: Number(r.volume_lots || 0),
          profit: Number(r.profit || 0),
          commission: Number(r.ib_commission || 0),
          spreadCommission: spread,
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

// GET /api/user/ib-tree -> simplified tree built from referrals
router.get('/ib-tree', authenticateToken, async (req, res) => {
  try {
    const rootId = req.user.id;

    const getOwnStats = async (ibId) => {
      const r = await query(
        `SELECT COALESCE(SUM(volume_lots),0) as own_lots, COUNT(*)::int as trade_count
         FROM ib_trade_history WHERE ib_request_id = $1 AND close_price IS NOT NULL AND close_price != 0 AND profit != 0`,
        [ibId]
      );
      const row = r.rows[0] || {};
      return { ownLots: Number(row.own_lots || 0), tradeCount: Number(row.trade_count || 0) };
    };

    const getIb = async (ibId) => {
      const r = await query('SELECT id, full_name, email, status FROM ib_requests WHERE id = $1', [ibId]);
      return r.rows[0] || null;
    };

    const getChildren = async (ibId) => {
      const r = await query('SELECT id FROM ib_requests WHERE referred_by = $1', [ibId]);
      return r.rows.map(x => x.id);
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
      return { id: ib.id, name: ib.full_name, email: ib.email, status: ib.status, ownLots, tradeCount, teamLots, children };
    };

    const root = await build(rootId);
    const totalTrades = (function count(n) { if (!n) return 0; return Number(n.tradeCount || 0) + (n.children || []).reduce((s,c)=> s+count(c),0); })(root);
    res.json({ success: true, data: { ownLots: Number(root?.ownLots || 0), teamLots: Number(root?.teamLots || 0), totalTrades, root } });
  } catch (e) {
    console.error('IB tree error:', e);
    res.status(500).json({ success: false, message: 'Unable to fetch IB tree' });
  }
});

export default router;
