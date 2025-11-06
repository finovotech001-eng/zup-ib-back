import express from 'express';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import { IBAdmin } from '../models/IBAdmin.js';

const router = express.Router();

const loginValidation = [
  body('email')
    .isEmail().withMessage('Valid email is required')
    .normalizeEmail({ all_lowercase: true })
    .isLength({ max: 254 }).withMessage('Email is too long'),
  body('password')
    .isLength({ min: 6, max: 100 }).withMessage('Password must be between 6 and 100 characters')
    .matches(/^[\S]+$/).withMessage('Password must not contain spaces')
];

// Helper to get the primary JWT secret and dev fallback (non-production only)
const getJwtSecrets = () => {
  const secrets = [];
  if (process.env.JWT_SECRET) secrets.push(process.env.JWT_SECRET);
  if (process.env.NODE_ENV !== 'production') secrets.push('dev-secret');
  return secrets;
};

const getPrimaryJwtSecret = () => {
  const secrets = getJwtSecrets();
  // Always sign with the first available secret
  return secrets[0];
};

const verifyWithAnySecret = (token) => {
  const secrets = getJwtSecrets();
  let lastError;
  for (const s of secrets) {
    try {
      if (!s) continue;
      return jwt.verify(token, s);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('JWT verification failed');
};

const generateAdminToken = (admin) => {
  const secret = getPrimaryJwtSecret();
  return jwt.sign(
    {
      id: admin.id,
      email: admin.email,
      role: 'admin'
    },
    secret,
    { expiresIn: process.env.JWT_EXPIRE || '12h' }
  );
};

// Development fallback (for local use only)
const devFallbackEnabled = process.env.NODE_ENV !== 'production';
const DEV_FALLBACK_EMAIL = process.env.ADMIN_FALLBACK_EMAIL || 'admin_ib@zuperior.com';
const DEV_FALLBACK_PASSWORD = process.env.ADMIN_FALLBACK_PASSWORD || 'Admin@000';

function maybeDevFallbackLogin(email, password) {
  if (!devFallbackEnabled) return null;
  if (email?.toLowerCase() === DEV_FALLBACK_EMAIL.toLowerCase() && password === DEV_FALLBACK_PASSWORD) {
    // Minimal admin shape for token and response
    const admin = {
      id: 'dev-admin',
      email: DEV_FALLBACK_EMAIL,
      full_name: 'Developer Admin',
      is_active: true
    };
    const token = generateAdminToken(admin);
    return { admin, token };
  }
  return null;
}

const authenticateAdminToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access token required'
      });
    }

    const decoded = verifyWithAnySecret(token);

    // Allow dev fallback admin token without DB lookup
    if (devFallbackEnabled && decoded?.role === 'admin' && decoded?.id === 'dev-admin') {
      req.admin = {
        id: 'dev-admin',
        email: DEV_FALLBACK_EMAIL,
        full_name: 'Developer Admin',
        is_active: true,
        role: 'admin'
      };
      return next();
    }

    const admin = await IBAdmin.findById(decoded.id);

    if (!admin || !admin.is_active) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or inactive admin'
      });
    }

    req.admin = admin;
    next();
  } catch (error) {
    console.error('Admin token verification error:', error);
    res.status(401).json({
      success: false,
      message: 'Invalid token'
    });
  }
};

router.post('/login', loginValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation errors',
        errors: errors.array()
      });
    }

    const { email, password } = req.body;
    const admin = await IBAdmin.findByEmail(email);

    if (!admin) {
      const fallback = maybeDevFallbackLogin(email, password);
      if (fallback) {
        return res.json({
          success: true,
          message: 'Admin login successful (dev fallback)',
          data: {
            admin: { id: fallback.admin.id, email: fallback.admin.email },
            token: fallback.token
          }
        });
      }
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const passwordValid = await IBAdmin.verifyPassword(password, admin.password_hash);
    if (!passwordValid) {
      const fallback = maybeDevFallbackLogin(email, password);
      if (fallback) {
        return res.json({
          success: true,
          message: 'Admin login successful (dev fallback)',
          data: {
            admin: { id: fallback.admin.id, email: fallback.admin.email },
            token: fallback.token
          }
        });
      }
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const token = generateAdminToken(admin);

    res.json({
      success: true,
      message: 'Admin login successful',
      data: {
        admin: {
          id: admin.id,
          email: admin.email
        },
        token
      }
    });
  } catch (error) {
    console.error('Admin login error:', error);
    // If DB is unavailable, allow dev fallback in non-production
    const { email, password } = req.body || {};
    const fallback = maybeDevFallbackLogin(email, password);
    if (fallback) {
      return res.json({
        success: true,
        message: 'Admin login successful (dev fallback)',
        data: {
          admin: { id: fallback.admin.id, email: fallback.admin.email },
          token: fallback.token
        }
      });
    }
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Admin logout endpoint
router.post('/logout', async (req, res) => {
  try {
    // Clear the httpOnly cookie
    res.clearCookie('adminToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    });

    res.json({
      success: true,
      message: 'Admin logout successful'
    });
  } catch (error) {
    console.error('Admin logout error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Get current admin info
router.get('/me', authenticateAdminToken, async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        admin: req.admin
      }
    });
  } catch (error) {
    console.error('Get admin info error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Set cookie endpoint (for client-side token storage)
router.post('/set-cookie', authenticateAdminToken, async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1] || req.cookies?.adminToken;

    if (token) {
      res.cookie('adminToken', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 12 * 60 * 60 * 1000 // 12 hours
      });
    }

    res.json({
      success: true,
      message: 'Cookie set successfully'
    });
  } catch (error) {
    console.error('Set cookie error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// Admin recent activity (alias for convenience)
router.get('/activity/recent', authenticateAdminToken, async (req, res) => {
  try {
    // Mirror adminIBRequests recent activity using real data
    const { query } = await import('../config/database.js');
    const result = await query(
      `
        SELECT id, full_name, email, status, approved_at, submitted_at
        FROM ib_requests
        ORDER BY COALESCE(approved_at, submitted_at) DESC
        LIMIT 10
      `
    );

    const activities = result.rows.map((row) => ({
      id: row.id,
      type: (row.status || '').toLowerCase().trim() === 'approved' ? 'ib_approved' : `ib_${(row.status || '').toLowerCase().trim()}`,
      message:
        (row.status || '').toLowerCase().trim() === 'approved'
          ? `IB approved: ${row.full_name || row.email}`
          : `IB ${row.status}: ${row.full_name || row.email}`,
      timestamp: (row.approved_at || row.submitted_at || new Date()).toISOString(),
      icon: (row.status || '').toLowerCase().trim() === 'approved' ? 'green' : (row.status || '').toLowerCase().trim() === 'rejected' ? 'red' : 'blue'
    }));

    res.json({ success: true, data: { activities } });
  } catch (error) {
    console.error('Fetch recent activity (alias) error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch recent activity' });
  }
});

export default router;
export { authenticateAdminToken };
