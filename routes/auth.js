import express from 'express';
import jwt from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import { IBRequest } from '../models/IBRequest.js';
import { User } from '../models/User.js';

const router = express.Router();

const generateToken = (request) => {
  return jwt.sign(
    {
      id: request.id,
      email: request.email,
      role: 'ib_partner'
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '12h' }
  );
};

const loginValidation = [
  body('email')
    .isEmail().withMessage('Valid email is required')
    .normalizeEmail({ all_lowercase: true })
    .isLength({ max: 254 }).withMessage('Email is too long'),
  body('password')
    .isLength({ min: 6, max: 100 }).withMessage('Password must be between 6 and 100 characters')
    .matches(/^[\S]+$/).withMessage('Password must not contain spaces')
];

const applyPartnerValidation = [
  body('fullName')
    .trim()
    .notEmpty().withMessage('Full name is required')
    .isLength({ max: 120 }).withMessage('Full name is too long')
    .matches(/^[a-zA-Z\s.'-]+$/).withMessage('Full name contains invalid characters'),
  body('email')
    .isEmail().withMessage('Valid email is required')
    .normalizeEmail({ all_lowercase: true })
    .isLength({ max: 254 }).withMessage('Email is too long'),
  body('password')
    .isLength({ min: 6, max: 100 }).withMessage('Password must be between 6 and 100 characters')
    .matches(/^[\S]+$/).withMessage('Password must not contain spaces'),
  body('ibType')
    .optional({ checkFalsy: true })
    .isIn(['normal', 'master']).withMessage('Invalid IB type')
];

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
    const request = await IBRequest.findByEmail(email);

    if (!request) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const passwordValid = await IBRequest.verifyPassword(password, request.password_hash);
    if (!passwordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    if (request.status === 'pending') {
      return res.status(403).json({
        success: false,
        message: 'Your IB application is still under review',
        requestStatus: 'pending'
      });
    }

    if (request.status === 'rejected') {
      return res.status(403).json({
        success: false,
        message: 'Your IB application has been rejected. Please submit a new application.',
        requestStatus: 'rejected'
      });
    }

    if (request.status === 'banned') {
      return res.status(403).json({
        success: false,
        message: 'Your IB account has been banned',
        requestStatus: 'banned'
      });
    }

    if (request.status !== 'approved') {
      return res.status(403).json({
        success: false,
        message: 'Your IB application must be approved before you can log in.',
        requestStatus: request.status
      });
    }

    const sanitizedRequest = IBRequest.stripSensitiveFields(request);
    const token = generateToken(sanitizedRequest);

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        request: sanitizedRequest,
        token
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

router.post('/apply-partner', applyPartnerValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation errors',
        errors: errors.array()
      });
    }

    const { fullName, email, password, ibType } = req.body;
    const trimmedFullName = fullName.trim();
    const sanitizedFullName = trimmedFullName.replace(/[\r\n<>]/g, ' ').replace(/\s{2,}/g, ' ').trim();
    const normalizedType = (ibType || 'normal').toLowerCase();

    const existingUser = await User.findByEmail(email);
    if (!existingUser) {
      return res.status(404).json({
        success: false,
        message: 'No user account found for this email. Please register first.'
      });
    }

    const passwordMatches = await User.verifyPassword(password, existingUser.password);
    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const existingRequest = await IBRequest.findByEmail(email);

    if (existingRequest) {
      if (existingRequest.status === 'approved') {
        return res.status(400).json({
          success: false,
          message: 'You are already an approved IB partner',
          requestStatus: 'approved'
        });
      }

      if (existingRequest.status === 'pending') {
        return res.status(400).json({
          success: false,
          message: 'An IB application is already under review for this email',
          requestStatus: 'pending'
        });
      }

      if (existingRequest.status === 'banned') {
        return res.status(403).json({
          success: false,
          message: 'This IB account has been banned. Contact support for assistance.',
          requestStatus: 'banned'
        });
      }

      const updatedRequest = await IBRequest.updateApplication(existingRequest.id, {
        fullName: sanitizedFullName,
        password,
        ibType: normalizedType
      });

      return res.status(200).json({
        success: true,
        message: 'IB partner application resubmitted successfully',
        data: {
          request: updatedRequest
        }
      });
    }

    const newRequest = await IBRequest.create({
      fullName: sanitizedFullName,
      email,
      password,
      ibType: normalizedType
    });

    res.status(201).json({
      success: true,
      message: 'IB partner application submitted successfully',
      data: {
        request: newRequest
      }
    });
  } catch (error) {
    console.error('Apply partner error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const request = await IBRequest.findById(req.user.id);

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'IB request not found'
      });
    }

    const sanitized = IBRequest.stripSensitiveFields(request);

    res.json({
      success: true,
      data: {
        request: sanitized
      }
    });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

export async function authenticateToken(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access token required'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const request = await IBRequest.findById(decoded.id);

    if (!request || request.status !== 'approved') {
      return res.status(401).json({
        success: false,
        message: 'Invalid or inactive IB partner'
      });
    }

    req.user = IBRequest.stripSensitiveFields(request);
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(401).json({
      success: false,
      message: 'Invalid token'
    });
  }
}

export default router;
