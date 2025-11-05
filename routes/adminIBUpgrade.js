import express from 'express';
import { authenticateAdminToken } from './adminAuth.js';
import { checkAndUpgradeIB, checkAllIBsForUpgrade, calculateIBTradingVolume, calculateIBActiveClients } from '../services/ibAutoUpgrade.js';

const router = express.Router();

// Check and upgrade a specific IB
router.post('/check/:ibRequestId', authenticateAdminToken, async (req, res) => {
  try {
    const { ibRequestId } = req.params;
    const result = await checkAndUpgradeIB(parseInt(ibRequestId));

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Check IB upgrade error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to check IB upgrade',
      error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined
    });
  }
});

// Check all IBs for upgrade
router.post('/check-all', authenticateAdminToken, async (req, res) => {
  try {
    const result = await checkAllIBsForUpgrade();

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Check all IBs upgrade error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to check all IBs for upgrade',
      error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined
    });
  }
});

// Get IB metrics (trading volume and active clients)
router.get('/metrics/:ibRequestId', authenticateAdminToken, async (req, res) => {
  try {
    const { ibRequestId } = req.params;
    const tradingVolume = await calculateIBTradingVolume(parseInt(ibRequestId));
    const activeClients = await calculateIBActiveClients(parseInt(ibRequestId));

    res.json({
      success: true,
      data: {
        tradingVolume: tradingVolume / 1000000, // Convert to millions
        tradingVolumeUSD: tradingVolume,
        activeClients
      }
    });
  } catch (error) {
    console.error('Get IB metrics error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch IB metrics',
      error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined
    });
  }
});

export default router;



