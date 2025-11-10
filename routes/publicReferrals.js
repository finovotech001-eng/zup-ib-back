import express from 'express';
import { IBReferral } from '../models/IBReferral.js';

const router = express.Router();

// Ensure table exists on boot
IBReferral.createTable().catch(() => {});

// POST /api/public/referrals/resolve { referralCode }
router.post('/resolve', async (req, res) => {
  try {
    const { referralCode } = req.body || {};
    const ref = await IBReferral.resolveReferralCode(referralCode);
    if (!ref) return res.status(404).json({ success: false, message: 'Invalid or inactive referral code' });
    res.json({ success: true, data: { ib: ref } });
  } catch (e) {
    console.error('Referral resolve error:', e);
    res.status(500).json({ success: false, message: 'Unable to resolve referral code' });
  }
});

// POST /api/public/referrals/attach { referralCode, email, source? }
router.post('/attach', async (req, res) => {
  try {
    const { referralCode, email, source } = req.body || {};
    const result = await IBReferral.attachByEmail({ referralCode, email, source: source || 'crm' });
    if (!result.ok) {
      const message = result.reason === 'invalid_email' ? 'Valid email required' : 'Invalid referral code';
      return res.status(400).json({ success: false, message });
    }
    res.json({ success: true, message: 'Referral attached', data: { referral: result.referral, ib: result.ib } });
  } catch (e) {
    console.error('Referral attach error:', e);
    res.status(500).json({ success: false, message: 'Unable to attach referral' });
  }
});

export default router;

