import express from 'express';
import { Symbols } from '../models/Symbols.js';
import { authenticateAdminToken } from './adminAuth.js';

const router = express.Router();

// Get all symbols with pagination
router.get('/', authenticateAdminToken, async (req, res) => {
  try {
    const page = Number.parseInt(req.query.page ?? '1', 10) || 1;
    const limit = Number.parseInt(req.query.limit ?? '100', 10) || 100;
    const search = (req.query.search || '').toString().trim();

    let result;
    if (search) {
      result = await Symbols.search(search, page, limit);
    } else {
      result = await Symbols.findAll(page, limit);
    }

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Fetch symbols error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch symbols', error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined });
  }
});

// Sync symbols from external API
router.post('/sync', authenticateAdminToken, async (req, res) => {
  try {
    const result = await Symbols.syncFromAPI();

    res.json({
      success: true,
      message: result.message,
      data: {
        synced: result.synced
      }
    });
  } catch (error) {
    console.error('Sync symbols error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to sync symbols from API',
      error: error.message
    });
  }
});

// Get symbols statistics
router.get('/stats', authenticateAdminToken, async (req, res) => {
  try {
    const stats = await Symbols.getStats();
    res.json({ success: true, data: { stats } });
  } catch (error) {
    console.error('Fetch symbols stats error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch symbols statistics', error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined });
  }
});

// Get single symbol by ID
router.get('/:id', authenticateAdminToken, async (req, res) => {
  try {
    const { id } = req.params;
    const symbol = await Symbols.findById(id);

    if (!symbol) {
      return res.status(404).json({ success: false, message: 'Symbol not found' });
    }

    res.json({ success: true, data: { symbol } });
  } catch (error) {
    console.error('Fetch symbol error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch symbol', error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined });
  }
});

export default router;
