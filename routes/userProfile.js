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

    // IB information
    let phone = null;
    try {
      const phoneRes = await query('SELECT phone_number, phonenumber, mobile, mobile_number, contact_number FROM "User" WHERE email = $1', [ib.email]);
      const u = phoneRes.rows[0] || {};
      phone = u.phone_number || u.phonenumber || u.mobile || u.mobile_number || u.contact_number || null;
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
          phone,
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
    const ibId = req.user.id;
    const period = Math.max(parseInt(req.query.period || '30', 10), 1);

    // Totals
    const totalRes = await query(
      `SELECT COALESCE(SUM(ib_commission),0) AS total FROM ib_trade_history WHERE ib_request_id = $1`,
      [ibId]
    );
    const monthRes = await query(
      `SELECT COALESCE(SUM(ib_commission),0) AS total
       FROM ib_trade_history WHERE ib_request_id = $1 AND DATE_TRUNC('month', synced_at) = DATE_TRUNC('month', CURRENT_DATE)`,
      [ibId]
    );
    const periodRes = await query(
      `SELECT COALESCE(SUM(ib_commission),0) AS total
       FROM ib_trade_history WHERE ib_request_id = $1 AND synced_at >= NOW() - INTERVAL '${period} days'`,
      [ibId]
    );

    // Top symbols
    const topRes = await query(
      `SELECT symbol, COUNT(*)::int AS trades, COALESCE(SUM(volume_lots),0) AS lots, COALESCE(SUM(ib_commission),0) AS commission
       FROM ib_trade_history WHERE ib_request_id = $1 AND close_price IS NOT NULL AND close_price != 0 AND profit != 0
       GROUP BY symbol ORDER BY commission DESC LIMIT 20`,
      [ibId]
    );

    // Recent ledger
    const ledgerRes = await query(
      `SELECT account_id, symbol, volume_lots, ib_commission, group_id, synced_at
       FROM ib_trade_history WHERE ib_request_id = $1 AND close_price IS NOT NULL AND close_price != 0 AND profit != 0
       ORDER BY synced_at DESC LIMIT 200`,
      [ibId]
    );

    // Monthly trend (current year)
    const trendRes = await query(
      `SELECT TO_CHAR(DATE_TRUNC('month', synced_at), 'Mon') AS m, COALESCE(SUM(ib_commission),0) AS c
       FROM ib_trade_history WHERE ib_request_id = $1 AND DATE_PART('year', synced_at) = DATE_PART('year', CURRENT_DATE)
       GROUP BY 1 ORDER BY DATE_TRUNC('month', MIN(synced_at))`,
      [ibId]
    );

    const stats = {
      totalCommission: Number(totalRes.rows[0]?.total || 0),
      thisMonth: Number(monthRes.rows[0]?.total || 0),
      avgDaily: Number(periodRes.rows[0]?.total || 0) / period
    };

    const topSymbols = topRes.rows.map(r => ({ symbol: r.symbol, category: '—', pips: 0, commission: Number(r.commission || 0), trades: Number(r.trades || 0) }));
    const recentLedger = ledgerRes.rows.map(r => ({
      date: r.synced_at,
      client: '—',
      mt5Account: r.account_id,
      group: (r.group_id || '').split(/[\\/]/).pop() || r.group_id || '—',
      symbol: r.symbol,
      lots: Number(r.volume_lots || 0),
      commission: Number(r.ib_commission || 0)
    }));
    const monthlyTrend = trendRes.rows.map(r => ({ month: r.m, commission: Number(r.c || 0) }));

    // Basic category split by symbol prefix (fallback when no mapping table)
    const catMap = {};
    for (const t of topSymbols) {
      const cat = /^[A-Z]{3}USD|^XAU|^XAG/.test(t.symbol) ? 'Forex' : 'Other';
      catMap[cat] = (catMap[cat] || 0) + t.commission;
    }
    const categoryData = Object.entries(catMap).map(([name, value]) => ({ name, value }));

    res.json({ success: true, data: { stats, topSymbols, recentLedger, monthlyTrend, categoryData } });
  } catch (e) {
    console.error('Commission analytics error:', e);
    res.status(500).json({ success: false, message: 'Unable to fetch commission analytics' });
  }
});

// GET /api/user/commission -> totals and history
router.get('/commission', authenticateToken, async (req, res) => {
  try {
    const ibId = req.user.id;
    const totalsRes = await query(
      `SELECT COALESCE(SUM(ib_commission),0) AS fixed FROM ib_trade_history WHERE ib_request_id = $1`,
      [ibId]
    );
    const fixed = Number(totalsRes.rows[0]?.fixed || 0);
    // Spread share based on IB % (simple global % from ib_requests)
    const pctRes = await query('SELECT COALESCE(spread_percentage_per_lot,0) AS pct FROM ib_requests WHERE id = $1', [ibId]);
    const pct = Number(pctRes.rows[0]?.pct || 0);
    const spreadShare = fixed * (pct / 100);

    const historyRes = await query(
      `SELECT synced_at AS date, ib_commission FROM ib_trade_history
       WHERE ib_request_id = $1 AND close_price IS NOT NULL AND close_price != 0 AND profit != 0
       ORDER BY synced_at DESC LIMIT 200`,
      [ibId]
    );
    const history = historyRes.rows.map((r, idx) => ({ id: idx + 1, date: r.date, type: 'Fixed', amount: Number(r.ib_commission || 0), status: 'Accrued' }));

    res.json({ success: true, data: { total: fixed + spreadShare, fixed, spreadShare, pending: 0, paid: 0, history } });
  } catch (e) {
    console.error('Commission summary error:', e);
    res.status(500).json({ success: false, message: 'Unable to fetch commission summary' });
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
