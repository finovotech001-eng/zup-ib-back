import express from 'express';
import { authenticateToken } from './auth.js';
import { IBWithdrawal } from '../models/IBWithdrawal.js';

const router = express.Router();

// Ensure table exists
IBWithdrawal.createTable().catch(() => {});

// GET /api/user/withdrawals/summary
router.get('/withdrawals/summary', authenticateToken, async (req, res) => {
  try {
    const ibId = req.user.id;
    const summary = await IBWithdrawal.getSummary(ibId);
    const recent = await IBWithdrawal.list(ibId, 10);
    res.json({ success: true, data: { summary, recent } });
  } catch (e) {
    console.error('Withdrawals summary error:', e);
    res.status(500).json({ success: false, message: 'Unable to fetch withdrawal summary' });
  }
});

// POST /api/user/withdrawals
router.post('/withdrawals', authenticateToken, async (req, res) => {
  try {
    const ibId = req.user.id;
    const { amount, paymentMethod, accountDetails } = req.body || {};
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Valid amount required' });
    }
    if (!paymentMethod) {
      return res.status(400).json({ success: false, message: 'Payment method required' });
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

