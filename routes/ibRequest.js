import express from 'express';
import { IBRequest } from '../models/IBRequest.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const record = await IBRequest.findById(req.user.id);

    if (!record) {
      return res.status(404).json({
        success: false,
        message: 'IB request not found'
      });
    }

    res.json({
      success: true,
      data: {
        request: IBRequest.stripSensitiveFields(record)
      }
    });
  } catch (error) {
    console.error('IBRequest self fetch error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch IB request'
    });
  }
});

export default router;
