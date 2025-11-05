import express from 'express';
import { MT5Groups } from '../models/MT5Groups.js';
import { authenticateAdminToken } from './adminAuth.js';

const router = express.Router();

// Get all trading groups with pagination and search
router.get('/', authenticateAdminToken, async (req, res) => {
  try {
    const page = Number.parseInt(req.query.page ?? '1', 10) || 1;
    const limit = Number.parseInt(req.query.limit ?? '50', 10) || 50;
    const search = req.query.search || '';

    console.log('[GET /trading-groups] Request:', { page, limit, search });

    const result = await MT5Groups.searchGroups(search, page, limit);

    console.log('[GET /trading-groups] Success:', { 
      groupsCount: result.groups?.length || 0,
      total: result.pagination?.total || 0
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('[GET /trading-groups] Error:', {
      message: error.message,
      stack: error.stack
    });
    res.status(500).json({
      success: false,
      message: 'Unable to fetch trading groups',
      error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined
    });
  }
});

// Get stats for trading groups
router.get('/stats', authenticateAdminToken, async (req, res) => {
  try {
    const stats = await MT5Groups.getStats();
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error fetching trading groups stats:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch trading groups stats',
      error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined
    });
  }
});

// Get single group by database ID
router.get('/:id', authenticateAdminToken, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid group ID'
      });
    }

    const group = await MT5Groups.findByIdDbId(id);
    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Trading group not found'
      });
    }

    res.json({
      success: true,
      data: group
    });
  } catch (error) {
    console.error('Error fetching trading group:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch trading group',
      error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined
    });
  }
});

// Sync groups from external API
router.post('/sync', authenticateAdminToken, async (req, res) => {
  try {
    // Default to simple /api/Groups endpoint
    const apiUrl = req.body.apiUrl || '/api/Groups';
    
    console.log('[SYNC ROUTE] Sync request received');
    console.log('[SYNC ROUTE] API URL:', apiUrl);
    console.log('[SYNC ROUTE] Request body:', req.body);
    
    const result = await MT5Groups.syncFromAPI(apiUrl);
    
    console.log('[SYNC ROUTE] Sync successful:', result.message);
    
    res.json({
      success: true,
      message: result.message,
      data: result
    });
  } catch (error) {
    console.error('[SYNC ROUTE] Error syncing trading groups:');
    console.error('[SYNC ROUTE] Error message:', error.message);
    console.error('[SYNC ROUTE] Error stack:', error.stack);
    console.error('[SYNC ROUTE] Error details:', {
      code: error.code,
      response: error.response?.data,
      status: error.response?.status,
      statusText: error.response?.statusText
    });
    
    // Provide detailed error message
    let errorMessage = 'Unable to sync trading groups from API';
    if (error.code === 'ECONNREFUSED') {
      errorMessage = `Cannot connect to API server. Please check if the API is running at http://18.175.242.21:3000`;
    } else if (error.code === 'ETIMEDOUT') {
      errorMessage = `API request timed out. The server may be slow or unreachable.`;
    } else if (error.response) {
      errorMessage = `API returned error: ${error.response.status} - ${error.response.statusText}`;
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    res.status(500).json({
      success: false,
      message: errorMessage,
      error: process.env.NODE_ENV !== 'production' ? {
        message: error.message,
        code: error.code,
        details: error.response?.data
      } : undefined
    });
  }
});

// Delete trading group
router.delete('/:id', authenticateAdminToken, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid group ID'
      });
    }

    const { query } = await import('../config/database.js');
    const result = await query('DELETE FROM mt5_groups WHERE id = $1', [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Trading group not found'
      });
    }

    res.json({
      success: true,
      message: 'Trading group deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting trading group:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to delete trading group',
      error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined
    });
  }
});

export default router;

