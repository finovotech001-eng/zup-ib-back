import express from 'express';
import { query } from '../config/database.js';
import { authenticateAdminToken } from './adminAuth.js';

const router = express.Router();

// Get commission distribution data with stats
router.get('/', authenticateAdminToken, async (req, res) => {
  try {
    const { search = '', rate_filter = 'all', sort_by = 'approved_at', page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Build search condition
    let searchCondition = '';
    let params = [];
    let paramIndex = 1;

    if (search) {
      searchCondition = `AND (full_name ILIKE $${paramIndex} OR email ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    // Rate filter
    let rateCondition = '';
    if (rate_filter !== 'all') {
      rateCondition = `AND usd_per_lot = $${paramIndex}`;
      params.push(parseFloat(rate_filter));
      paramIndex++;
    }

    // Sort order
    let orderBy = 'approved_at DESC NULLS LAST, submitted_at DESC';
    if (sort_by === 'name') {
      orderBy = 'full_name ASC';
    } else if (sort_by === 'email') {
      orderBy = 'email ASC';
    } else if (sort_by === 'rate') {
      orderBy = 'usd_per_lot DESC';
    }

    // First, get the base approved IBs
    const baseQuery = `
      SELECT 
        id,
        full_name,
        email,
        ib_type,
        approved_at,
        usd_per_lot,
        spread_percentage_per_lot
      FROM ib_requests
      WHERE LOWER(TRIM(status)) = 'approved'
      ${searchCondition}
      ${rateCondition}
      ORDER BY ${orderBy}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    
    params.push(parseInt(limit), offset);
    const ibsResult = await query(baseQuery, params);
    
    // Get IB IDs for aggregations
    const ibIds = ibsResult.rows.map(row => row.id);
    
    // Get direct clients count
    const directClientsMap = {};
    if (ibIds.length > 0) {
      const directClientsQuery = `
        SELECT assigned_ib_id, COUNT(*) as count
        FROM ib_client_linking
        WHERE status = 'active' AND assigned_ib_id = ANY($1::int[])
        GROUP BY assigned_ib_id
      `;
      const directClientsResult = await query(directClientsQuery, [ibIds]);
      directClientsResult.rows.forEach(row => {
        directClientsMap[row.assigned_ib_id] = parseInt(row.count);
      });
    }
    
    // Get sub-IBs count
    const subIbsMap = {};
    if (ibIds.length > 0) {
      const subIbsQuery = `
        SELECT icl.assigned_ib_id, COUNT(*) as count
        FROM ib_client_linking icl
        INNER JOIN ib_requests ir2 ON ir2.id = icl.user_id AND LOWER(TRIM(ir2.status)) = 'approved'
        WHERE icl.status = 'active' AND icl.assigned_ib_id = ANY($1::int[])
        GROUP BY icl.assigned_ib_id
      `;
      const subIbsResult = await query(subIbsQuery, [ibIds]);
      subIbsResult.rows.forEach(row => {
        subIbsMap[row.assigned_ib_id] = parseInt(row.count);
      });
    }
    
    // Get commission data from ib_commission table
    const commissionMap = {};
    if (ibIds.length > 0) {
      // Get IB user_ids first
      const ibUsersResult = await query(`
        SELECT ir.id as ib_request_id, u.id as user_id
        FROM ib_requests ir
        LEFT JOIN "User" u ON LOWER(u.email) = LOWER(ir.email)
        WHERE ir.id = ANY($1::int[])
      `, [ibIds]);
      
      const ibUserMap = {};
      ibUsersResult.rows.forEach(row => {
        if (row.user_id) {
          ibUserMap[row.ib_request_id] = String(row.user_id);
        }
      });

      // Get commission from ib_commission table
      if (Object.keys(ibUserMap).length > 0) {
        const userIds = Object.values(ibUserMap);
        const commissionQuery = `
          SELECT 
            ic.ib_request_id,
            COALESCE(SUM(ic.total_commission), 0) as total_commission,
            COALESCE(SUM(ic.total_trades), 0) as total_trades,
            COALESCE(SUM(ic.total_lots), 0) as total_lots
          FROM ib_commission ic
          WHERE ic.ib_request_id = ANY($1::int[])
            AND ic.user_id = ANY($2::text[])
          GROUP BY ic.ib_request_id
        `;
        const commissionResult = await query(commissionQuery, [ibIds, userIds]);
        commissionResult.rows.forEach(row => {
          const totalCommission = parseFloat(row.total_commission || 0);
          // For fixed and spread, we'll calculate from commission structure if needed
          // For now, approximate split (can be improved later)
          commissionMap[row.ib_request_id] = {
            total_commission: totalCommission,
            fixed_commission: totalCommission * 0.9, // Approximate 90% fixed
            spread_share_commission: totalCommission * 0.1, // Approximate 10% spread
            total_trades: parseInt(row.total_trades || 0),
            total_lots: parseFloat(row.total_lots || 0)
          };
        });
      }

      // Fallback: if no commission in ib_commission table, calculate from trade history
      for (const ibId of ibIds) {
        if (!commissionMap[ibId]) {
          const fallbackQuery = `
            SELECT 
              COALESCE(SUM(ith.ib_commission), 0) as total_commission,
              COALESCE(SUM(ith.ib_commission * (ir_comm.spread_percentage_per_lot / 100.0)), 0) as spread_share_commission
            FROM ib_trade_history ith
            LEFT JOIN ib_requests ir_comm ON ir_comm.id = ith.ib_request_id
            WHERE ith.ib_request_id = $1
          `;
          const fallbackResult = await query(fallbackQuery, [ibId]);
          if (fallbackResult.rows.length > 0) {
            const row = fallbackResult.rows[0];
            const totalCommission = parseFloat(row.total_commission || 0);
            commissionMap[ibId] = {
              total_commission: totalCommission,
              fixed_commission: totalCommission - parseFloat(row.spread_share_commission || 0),
              spread_share_commission: parseFloat(row.spread_share_commission || 0),
              total_trades: 0,
              total_lots: 0
            };
          } else {
            commissionMap[ibId] = {
              total_commission: 0,
              fixed_commission: 0,
              spread_share_commission: 0,
              total_trades: 0,
              total_lots: 0
            };
          }
        }
      }
    }
    
    // Get balance data
    const balanceMap = {};
    if (ibIds.length > 0) {
      const balanceQuery = `
        SELECT 
          icl.assigned_ib_id,
          COALESCE(SUM(ith.ib_commission), 0) as total_balance
        FROM ib_client_linking icl
        LEFT JOIN ib_trade_history ith ON ith.user_id::text = icl.user_id::text AND ith.ib_request_id = icl.assigned_ib_id
        WHERE icl.status = 'active' AND icl.assigned_ib_id = ANY($1::int[])
        GROUP BY icl.assigned_ib_id
      `;
      const balanceResult = await query(balanceQuery, [ibIds]);
      balanceResult.rows.forEach(row => {
        balanceMap[row.assigned_ib_id] = parseFloat(row.total_balance || 0);
      });
    }

    // Get total count
    const countParams = [];
    let countParamIndex = 1;
    let countSearchCondition = '';
    let countRateCondition = '';
    
    if (search) {
      countSearchCondition = `AND (full_name ILIKE $${countParamIndex} OR email ILIKE $${countParamIndex})`;
      countParams.push(`%${search}%`);
      countParamIndex++;
    }
    
    if (rate_filter !== 'all') {
      countRateCondition = `AND usd_per_lot = $${countParamIndex}`;
      countParams.push(parseFloat(rate_filter));
    }
    
    const countQuery = `
      SELECT COUNT(*) as total
      FROM ib_requests
      WHERE LOWER(TRIM(status)) = 'approved'
      ${countSearchCondition}
      ${countRateCondition}
    `;
    const countResult = await query(countQuery, countParams);

    // Format the data
    const ibs = ibsResult.rows.map(row => {
      const ibId = row.id;
      const directClients = directClientsMap[ibId] || 0;
      const subIbs = subIbsMap[ibId] || 0;
      const commission = commissionMap[ibId] || { total_commission: 0, fixed_commission: 0, spread_share_commission: 0 };
      const balance = balanceMap[ibId] || 0;
      
      return {
        id: ibId,
        name: row.full_name || '',
        email: row.email || '',
        ib_type: row.ib_type || '',
        approved_at: row.approved_at,
        ib_rate: parseFloat(row.usd_per_lot || 0),
        direct_clients: directClients,
        sub_ibs: subIbs,
        total_referrals: directClients + subIbs,
        total_balance: balance,
        commission: commission.total_commission,
        fixed_commission: commission.fixed_commission,
        spread_share_commission: commission.spread_share_commission
      };
    });

    res.json({
      success: true,
      data: {
        ibs,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(countResult.rows[0]?.total || 0),
          totalPages: Math.ceil(parseInt(countResult.rows[0]?.total || 0) / parseInt(limit))
        }
      }
    });
  } catch (error) {
    console.error('Error fetching commission distribution:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch commission distribution data',
      error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined
    });
  }
});

// Get commission distribution stats
router.get('/stats', authenticateAdminToken, async (req, res) => {
  try {
    // Total approved IBs
    const totalIbsResult = await query(`
      SELECT COUNT(*) as count
      FROM ib_requests
      WHERE LOWER(TRIM(status)) = 'approved'
    `);
    const totalApprovedIbs = parseInt(totalIbsResult.rows[0]?.count || 0);

    // Total direct clients
    const directClientsResult = await query(`
      SELECT COUNT(DISTINCT user_id) as count
      FROM ib_client_linking
      WHERE status = 'active'
      AND user_id NOT IN (SELECT id FROM ib_requests WHERE status = 'approved')
    `);
    const totalDirectClients = parseInt(directClientsResult.rows[0]?.count || 0);

    // Total Sub-IBs (IBs assigned to other IBs)
    const subIbsResult = await query(`
      SELECT COUNT(DISTINCT icl.user_id) as count
      FROM ib_client_linking icl
      JOIN ib_requests ir ON ir.id = icl.user_id
      WHERE icl.status = 'active'
      AND LOWER(TRIM(ir.status)) = 'approved'
    `);
    const totalSubIbs = parseInt(subIbsResult.rows[0]?.count || 0);

    // Total IB Balance from ib_commission table
    const balanceResult = await query(`
      SELECT COALESCE(SUM(ic.total_commission), 0) as total_balance
      FROM ib_commission ic
      WHERE ic.ib_request_id IN (SELECT id FROM ib_requests WHERE LOWER(TRIM(status)) = 'approved')
    `);
    const totalIBBalance = parseFloat(balanceResult.rows[0]?.total_balance || 0);

    res.json({
      success: true,
      data: {
        total_approved_ibs: totalApprovedIbs,
        total_direct_clients: totalDirectClients,
        total_sub_ibs: totalSubIbs,
        total_ib_balance: totalIBBalance
      }
    });
  } catch (error) {
    console.error('Error fetching commission distribution stats:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch commission distribution stats',
      error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined
    });
  }
});

// Get unique rates for filter dropdown
router.get('/rates', authenticateAdminToken, async (req, res) => {
  try {
    const result = await query(`
      SELECT DISTINCT usd_per_lot as rate
      FROM ib_requests
      WHERE LOWER(TRIM(status)) = 'approved'
      AND usd_per_lot IS NOT NULL
      ORDER BY usd_per_lot DESC
    `);

    const rates = result.rows.map(row => parseFloat(row.rate || 0));

    res.json({
      success: true,
      data: { rates }
    });
  } catch (error) {
    console.error('Error fetching rates:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch rates',
      error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined
    });
  }
});

export default router;

