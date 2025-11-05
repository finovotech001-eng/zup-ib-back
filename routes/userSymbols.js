import express from 'express';
import { SymbolsWithCategories } from '../models/SymbolsWithCategories.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

// Get all active symbols for user (no authentication needed for symbol list, but we'll keep it for consistency)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const filters = {
      page: 1,
      limit: 1000, // Get all symbols for dropdown
      category: req.query.category || 'all',
      status: 'active', // Only active symbols
      search: req.query.search || '',
      sortBy: 'symbol',
      sortDir: 'ASC'
    };

    const result = await SymbolsWithCategories.findAll(filters);

    res.json({ 
      success: true, 
      data: result.symbols || []
    });
  } catch (error) {
    console.error('Fetch symbols error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Unable to fetch symbols', 
      error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined 
    });
  }
});

export default router;


