import express from 'express';
import { SymbolsWithCategories } from '../models/SymbolsWithCategories.js';
import { authenticateAdminToken } from './adminAuth.js';
import { query } from '../config/database.js';

const router = express.Router();

// Get all symbols with filters and pagination
router.get('/', authenticateAdminToken, async (req, res) => {
  try {
    const filters = {
      page: req.query.page || 1,
      limit: parseInt(req.query.limit) || 100,
      category: req.query.category || 'all',
      group: req.query.group || 'all',
      status: req.query.status || 'all',
      search: req.query.search || '',
      sortBy: req.query.sortBy || 'symbol',
      sortDir: req.query.sortDir || 'ASC'
    };

    const result = await SymbolsWithCategories.findAll(filters);

    res.json({ 
      success: true, 
      data: result 
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

// Sync symbols from external API (optionally by category)
router.post('/sync', authenticateAdminToken, async (req, res) => {
  try {
    const { category } = req.body; // Optional category filter
    
    const result = await SymbolsWithCategories.syncFromAPI(category || null);

    res.json({
      success: true,
      message: result.message,
      data: {
        synced: result.synced,
        updated: result.updated,
        total: result.total,
        category: result.category || 'all'
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
    const stats = await SymbolsWithCategories.getStats();
    const total = await SymbolsWithCategories.getTotalCount();
    
    res.json({ 
      success: true, 
      data: { 
        stats: {
          ...stats,
          total_symbols: parseInt(stats.total_symbols) || total
        }
      } 
    });
  } catch (error) {
    console.error('Fetch symbols stats error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Unable to fetch symbols statistics', 
      error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined 
    });
  }
});

// Get total count
router.get('/total', authenticateAdminToken, async (req, res) => {
  try {
    const total = await SymbolsWithCategories.getTotalCount();
    res.json({ 
      success: true, 
      data: { total } 
    });
  } catch (error) {
    console.error('Get total count error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Unable to get total count' 
    });
  }
});

// Get categories
router.get('/categories', authenticateAdminToken, async (req, res) => {
  try {
    const result = await query(`
      SELECT DISTINCT category 
      FROM symbols_with_categories 
      WHERE category IS NOT NULL 
      ORDER BY category
    `);
    
    const categories = result.rows.map(r => r.category);
    
    res.json({ 
      success: true, 
      data: { categories } 
    });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Unable to fetch categories' 
    });
  }
});

// Get groups
router.get('/groups', authenticateAdminToken, async (req, res) => {
  try {
    const result = await query(`
      SELECT DISTINCT group_name 
      FROM symbols_with_categories 
      WHERE group_name IS NOT NULL 
      ORDER BY group_name
    `);
    
    const groups = result.rows.map(r => r.group_name);
    
    res.json({ 
      success: true, 
      data: { groups } 
    });
  } catch (error) {
    console.error('Get groups error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Unable to fetch groups' 
    });
  }
});

// Update symbol
router.put('/:id', authenticateAdminToken, async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    
    // Mark as override if any pip/commission values are changed
    if (updateData.pip_value || updateData.commission || updateData.pip_per_lot) {
      updateData.is_override = true;
    }

    const symbol = await SymbolsWithCategories.updateSymbol(id, updateData);

    res.json({ 
      success: true, 
      data: { symbol } 
    });
  } catch (error) {
    console.error('Update symbol error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Unable to update symbol', 
      error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined 
    });
  }
});

// Delete symbol
router.delete('/:id', authenticateAdminToken, async (req, res) => {
  try {
    const { id } = req.params;
    await SymbolsWithCategories.deleteSymbol(id);

    res.json({ 
      success: true, 
      message: 'Symbol deleted successfully' 
    });
  } catch (error) {
    console.error('Delete symbol error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Unable to delete symbol', 
      error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined 
    });
  }
});

// Test database connection
router.get('/test/connection', authenticateAdminToken, async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ 
      success: true, 
      data: { 
        connection: 'OK' 
      } 
    });
  } catch (error) {
    res.json({ 
      success: false, 
      data: { 
        connection: 'ERROR',
        error: error.message 
      } 
    });
  }
});

export default router;

