import express from 'express';
import { authenticateAdminToken } from './adminAuth.js';
import { IBWithdrawal } from '../models/IBWithdrawal.js';
import { query } from '../config/database.js';

const router = express.Router();

// Get all withdrawal requests with pagination
router.get('/', authenticateAdminToken, async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let whereClause = '';
    const params = [];

    if (status && status !== 'all') {
      whereClause = 'WHERE LOWER(status) = LOWER($1)';
      params.push(status);
    }

    const result = await query(
      `SELECT w.*, i.full_name, i.email 
       FROM ib_withdrawal_requests w
       LEFT JOIN ib_requests i ON w.ib_request_id = i.id
       ${whereClause}
       ORDER BY w.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, Number(limit), offset]
    );

    const countResult = await query(
      `SELECT COUNT(*) FROM ib_withdrawal_requests ${whereClause}`,
      params
    );

    res.json({
      success: true,
      data: {
        withdrawals: result.rows,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total: Number(countResult.rows[0].count),
          totalPages: Math.ceil(Number(countResult.rows[0].count) / Number(limit))
        }
      }
    });
  } catch (error) {
    console.error('Fetch withdrawals error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch withdrawals' });
  }
});

// Get withdrawal statistics
router.get('/stats', authenticateAdminToken, async (req, res) => {
  try {
    const statsResult = await query(`
      SELECT 
        COUNT(*) as total_withdrawals,
        COUNT(*) FILTER (WHERE LOWER(status) = 'pending') as pending,
        COUNT(*) FILTER (WHERE LOWER(status) IN ('approved', 'paid', 'completed')) as approved,
        COUNT(*) FILTER (WHERE LOWER(status) = 'rejected') as rejected,
        COALESCE(SUM(amount), 0) as total_amount
      FROM ib_withdrawal_requests
    `);

    res.json({
      success: true,
      data: { stats: statsResult.rows[0] }
    });
  } catch (error) {
    console.error('Fetch withdrawal stats error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch withdrawal statistics' });
  }
});

// Approve withdrawal
router.put('/:id/approve', authenticateAdminToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await query(
      `UPDATE ib_withdrawal_requests 
       SET status = 'approved' 
       WHERE id = $1 
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Withdrawal request not found' });
    }

    res.json({
      success: true,
      message: 'Withdrawal approved successfully',
      data: { withdrawal: result.rows[0] }
    });
  } catch (error) {
    console.error('Approve withdrawal error:', error);
    res.status(500).json({ success: false, message: 'Unable to approve withdrawal' });
  }
});

// Reject withdrawal
router.put('/:id/reject', authenticateAdminToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await query(
      `UPDATE ib_withdrawal_requests 
       SET status = 'rejected' 
       WHERE id = $1 
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Withdrawal request not found' });
    }

    res.json({
      success: true,
      message: 'Withdrawal rejected successfully',
      data: { withdrawal: result.rows[0] }
    });
  } catch (error) {
    console.error('Reject withdrawal error:', error);
    res.status(500).json({ success: false, message: 'Unable to reject withdrawal' });
  }
});

export default router;
