import express from 'express';
import { authenticateToken } from './auth.js';
import { IBWithdrawal } from '../models/IBWithdrawal.js';
import { query } from '../config/database.js';

const router = express.Router();

// Ensure table exists
IBWithdrawal.createTable().catch(() => {});

// Helper executes a safe select for a given table and candidate user id columns
async function selectPaymentRowsByUser(tableName, userId) {
  const candidates = [
    '"userId"', // quoted camelCase
    'user_id',
    'userid'
  ];
  for (const col of candidates) {
    try {
      const sql = `SELECT * FROM ${tableName} WHERE ${col} = $1`;
      const r = await query(sql, [userId]);
      return r.rows || [];
    } catch (e) {
      // try next candidate
    }
  }
  return [];
}

// Normalize a payment-method row into a common shape and filter to approved USDT
function normalizeUsdtRow(row) {
  const address = row.address || row.walletAddress || row.usdtAddress || row.crypto_address || row.wallet || null;
  const currency = String(row.currency || row.asset || 'usdt').toLowerCase();
  const methodStr = String(row.method || row.type || '').toLowerCase();
  const network = String(row.network || '').toLowerCase();
  const status = String(row.status || 'approved').toLowerCase();
  const isUSDT = currency === 'usdt' || methodStr.startsWith('usdt');
  const isNetworkOk = !network || ['trc20','erc20','bep20'].some(n => network.includes(n.replace('20','')) || network === n);
  const isApproved = ['approved','active'].includes(status);
  if (!address || !isUSDT || !isNetworkOk || !isApproved) return null;
  return { id: row.id, address, currency: 'usdt', network: network || 'trc20' };
}

// Helper: fetch approved USDT addresses for a user from known payment method tables
async function getApprovedUsdtAddressesForUser(userEmail) {
  try {
    // Resolve User.id by email (case-insensitive)
    const userRes = await query('SELECT id FROM "User" WHERE LOWER(email) = LOWER($1)', [userEmail]);
    if (!userRes.rows.length) return [];
    const userId = userRes.rows[0].id;

    const tables = ['"PaymentMethod"', '"PaymentMthod"', 'payment_methods'];
    const results = [];
    for (const tbl of tables) {
      const rows = await selectPaymentRowsByUser(tbl, userId);
      for (const row of rows) {
        const norm = normalizeUsdtRow(row);
        if (norm) results.push(norm);
      }
    }
    return results;
  } catch (_) {
    return [];
  }
}

// GET /api/user/withdrawals/summary
router.get('/withdrawals/summary', authenticateToken, async (req, res) => {
  try {
    const ibId = req.user.id;
    const period = Math.max(parseInt(req.query.period || '30', 10), 1);
    const summary = await IBWithdrawal.getSummary(ibId, { periodDays: period });
    const recent = await IBWithdrawal.list(ibId, 10);
    const usdtAddresses = await getApprovedUsdtAddressesForUser(req.user.email);
    res.json({ success: true, data: { summary, recent, usdtAddresses } });
  } catch (e) {
    console.error('Withdrawals summary error:', e);
    res.status(500).json({ success: false, message: 'Unable to fetch withdrawal summary' });
  }
});

// POST /api/user/withdrawals
router.post('/withdrawals', authenticateToken, async (req, res) => {
  try {
    const ibId = req.user.id;
    let { amount, paymentMethod, accountDetails } = req.body || {};
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Valid amount required' });
    }
    if (!paymentMethod) {
      return res.status(400).json({ success: false, message: 'Payment method required' });
    }
    // Auto-fill USDT address from approved payment methods if not provided
    if (String(paymentMethod).toLowerCase().startsWith('usdt') && !accountDetails) {
      const list = await getApprovedUsdtAddressesForUser(req.user.email);
      accountDetails = list?.[0]?.address || '';
      if (!accountDetails) {
        return res.status(400).json({ success: false, message: 'No approved USDT address on file' });
      }
    }
    const created = await IBWithdrawal.create({
      ibRequestId: ibId,
      amount,
      method: paymentMethod,
      accountDetails,
    });
    const summary = await IBWithdrawal.getSummary(ibId);
    res.status(201).json({ success: true, message: 'Withdrawal request submitted', data: { request: created, summary } });
  } catch (e) {
    console.error('Create withdrawal error:', e);
    res.status(500).json({ success: false, message: 'Unable to submit withdrawal request' });
  }
});

export default router;

// Additional: list withdrawals with optional status filter
router.get('/withdrawals', authenticateToken, async (req, res) => {
  try {
    const ibId = req.user.id;
    const status = (req.query.status || '').toString().trim().toLowerCase() || null;
    const limit = Math.max(parseInt(req.query.limit || '200', 10), 1);
    const rows = await IBWithdrawal.listByStatus(ibId, status, limit);
    res.json({ success: true, data: { withdrawals: rows } });
  } catch (e) {
    console.error('List withdrawals error:', e);
    res.status(500).json({ success: false, message: 'Unable to fetch withdrawals' });
  }
});
