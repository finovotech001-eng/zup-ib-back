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

// Normalize a payment-method row into a common shape for all approved methods
function normalizePaymentRow(row) {
  const status = String(row.status || '').toLowerCase();
  const isApproved = status === 'approved';
  if (!isApproved) return null;

  const methodType = String(row.methodType || '').toLowerCase();
  
  if (methodType === 'crypto') {
    const address = row.address || '';
    const currency = String(row.currency || 'USDT').toUpperCase();
    const network = String(row.network || 'TRC20').toUpperCase();
    if (!address) return null;
    return { 
      id: row.id, 
      type: 'crypto',
      method: `${currency} (${network})`,
      details: address,
      currency,
      network
    };
  } else if (methodType === 'bank') {
    const bankName = row.bankName || '';
    const accountName = row.accountName || '';
    const accountNumber = row.accountNumber || '';
    const accountType = row.accountType || '';
    if (!accountNumber) return null;
    return {
      id: row.id,
      type: 'bank',
      method: `Bank - ${bankName}`,
      details: `${accountName} - ${accountNumber}`,
      bankName,
      accountName,
      accountNumber,
      accountType
    };
  }
  return null;
}

// Helper: fetch all approved payment methods for a user
async function getApprovedPaymentMethodsForUser(userEmail) {
  try {
    // Fetch using a robust join to avoid relying on a non-existent email column
    // and to be case-insensitive on both sides.
    const res = await query(
      `SELECT p.*
         FROM "PaymentMethod" p
         JOIN "User" u ON u.id = p."userId"
        WHERE LOWER(u.email) = LOWER($1)
          AND LOWER(COALESCE(p.status, '')) = 'approved'`,
      [userEmail]
    );

    const results = [];
    for (const row of (res.rows || [])) {
      const norm = normalizePaymentRow(row);
      if (norm) results.push(norm);
    }
    return results;
  } catch (e) {
    console.error('Error in getApprovedPaymentMethodsForUser:', e);
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
    const paymentMethods = await getApprovedPaymentMethodsForUser(req.user.email);
    res.json({ success: true, data: { summary, recent, paymentMethods } });
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
    // Resolve method label/details using user's approved methods
    const approved = await getApprovedPaymentMethodsForUser(req.user.email);
    let methodLabel = String(paymentMethod);
    const chosen = approved.find(m => String(m.id) === String(paymentMethod));
    if (chosen) {
      methodLabel = chosen.method;
      if (!accountDetails) accountDetails = chosen.details || '';
    } else if (!accountDetails) {
      // If the provided value isn't an approved id and no details provided,
      // fall back to the first approved method's details.
      accountDetails = approved?.[0]?.details || '';
    }
    if (!accountDetails) {
      return res.status(400).json({ success: false, message: 'No approved payment method on file' });
    }
    const created = await IBWithdrawal.create({
      ibRequestId: ibId,
      amount,
      method: methodLabel,
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
