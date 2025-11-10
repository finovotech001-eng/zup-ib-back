import express from 'express';
import bcrypt from 'bcryptjs';
import { IBReferral } from '../models/IBReferral.js';
import { IBRequest } from '../models/IBRequest.js';
import { query } from '../config/database.js';

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

// POST /api/public/referrals/register
// Body: { referralCode, email, fullName?, password?, source? }
// Behavior: resolve IB from code, ensure User row exists (create if needed with password when provided),
// then upsert into ib_referrals linking to the newly created/located user.
router.post('/register', async (req, res) => {
  try {
    const { referralCode, email, fullName, password, phone, source } = req.body || {};
    if (!referralCode || !email) {
      return res.status(400).json({ success: false, message: 'referralCode and email are required' });
    }

    // Resolve referrer via IBRequest to ensure status=approved and fetch name
    const referrer = await IBRequest.findByReferralCode(String(referralCode).trim());
    if (!referrer) {
      return res.status(404).json({ success: false, message: 'Invalid or inactive referral code' });
    }

    // Ensure a user exists in "User" table for this email
    let userId = null;
    try {
      const u1 = await query('SELECT id FROM "User" WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
      if (u1.rows.length) {
        userId = u1.rows[0].id;
      } else {
        // Create user if password is provided; otherwise create a placeholder with random password
        const rawPass = password && typeof password === 'string' && password.length >= 6
          ? password
          : Math.random().toString(36) + Math.random().toString(36);
        const hashed = await bcrypt.hash(rawPass, 12);

        // Try best-effort insert (only fields we are confident about)
        const ins = await query(
          'INSERT INTO "User" (email, password) VALUES ($1, $2) RETURNING id',
          [email, hashed]
        );
        userId = ins.rows[0]?.id || null;
      }
    } catch (e) {
      console.error('Ensure User failed:', e.message);
      // Proceed without failing hard; ib_referrals will still be created and can backfill user_id later
    }

    // Best-effort: update user profile details (name, phone) if columns exist
    if (userId && (fullName || phone)) {
      try {
        const cols = await query(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('User','user')`);
        const names = new Set(cols.rows.map(r => r.column_name));
        const sets = [];
        const vals = [];
        let idx = 1;
        if (fullName) {
          if (names.has('name')) { sets.push(`name = $${idx++}`); vals.push(fullName); }
          if (names.has('full_name')) { sets.push(`full_name = $${idx++}`); vals.push(fullName); }
          if (names.has('first_name')) { const fn = String(fullName).split(' ')[0] || fullName; sets.push(`first_name = $${idx++}`); vals.push(fn); }
          if (names.has('last_name')) { const parts = String(fullName).split(' '); const ln = parts.slice(1).join(' ') || parts[0]; sets.push(`last_name = $${idx++}`); vals.push(ln); }
          if (names.has('firstName')) { const fn = String(fullName).split(' ')[0] || fullName; sets.push(`"firstName" = $${idx++}`); vals.push(fn); }
          if (names.has('lastName')) { const parts = String(fullName).split(' '); const ln = parts.slice(1).join(' ') || parts[0]; sets.push(`"lastName" = $${idx++}`); vals.push(ln); }
        }
        if (phone) {
          const phoneCols = ['phone','phone_number','phonenumber','mobile','mobile_number','contact_number'];
          for (const c of phoneCols) { if (names.has(c)) { sets.push(`${c} = $${idx++}`); vals.push(phone); } }
        }
        if (sets.length) {
          vals.push(userId);
          await query(`UPDATE "User" SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
        }
      } catch (e) {
        console.warn('Optional User profile update failed:', e.message);
      }
    }

    // Upsert referral and backfill user_id
    const attach = await IBReferral.attachByEmail({ referralCode, email, source: source || 'crm' });
    if (!attach.ok) {
      const message = attach.reason === 'invalid_email' ? 'Valid email required' : 'Invalid referral code';
      return res.status(400).json({ success: false, message });
    }

    // If we created user after attach, ensure user_id is set (idempotent)
    if (userId) {
      try {
        await query(
          'UPDATE ib_referrals SET user_id = COALESCE(user_id, $1) WHERE id = $2',
          [userId, attach.referral.id]
        );
      } catch (e) {
        console.warn('Backfill user_id in ib_referrals failed:', e.message);
      }
    }

    res.json({
      success: true,
      message: 'Referral registered',
      data: {
        ib: { id: referrer.id, name: referrer.full_name || referrer.fullName || attach.ib?.name, referralCode: referrer.referral_code || String(referralCode).toUpperCase() },
        referral: attach.referral,
        userId: userId || null
      }
    });
  } catch (e) {
    console.error('Referral register error:', e);
    res.status(500).json({ success: false, message: 'Unable to register referral' });
  }
});

export default router;
