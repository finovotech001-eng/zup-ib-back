import express from 'express';
import { authenticateAdminToken } from './adminAuth.js';
import { query } from '../config/database.js';
import { IBRewardClaim } from '../models/IBRewardClaim.js';

const router = express.Router();

/**
 * GET /api/admin/rewards/claims
 * Get all reward claims with filters
 */
router.get('/claims', authenticateAdminToken, async (req, res) => {
  try {
    const {
      status,
      ibRequestId,
      dateFrom,
      dateTo,
      page = 1,
      pageSize = 50
    } = req.query;

    const filters = {
      status: status || null,
      ibRequestId: ibRequestId ? parseInt(ibRequestId) : null,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      page: parseInt(page),
      pageSize: parseInt(pageSize)
    };

    const result = await IBRewardClaim.getAll(filters);

    // Join with ib_requests and User tables for IB details
    const claimsWithDetails = await Promise.all(
      result.claims.map(async (claim) => {
        // Get IB details
        const ibResult = await query(
          `SELECT id, full_name, email, referral_code, ib_type 
           FROM ib_requests 
           WHERE id = $1`,
          [claim.ib_request_id]
        );
        const ib = ibResult.rows[0] || {};

        // Get User details
        const userResult = await query(
          `SELECT id, email, name 
           FROM "User" 
           WHERE id = $1`,
          [claim.user_id]
        );
        const user = userResult.rows[0] || {};

        // Format address
        const addressParts = [];
        if (claim.claimant_address_street) addressParts.push(claim.claimant_address_street);
        if (claim.claimant_address_city) addressParts.push(claim.claimant_address_city);
        if (claim.claimant_address_state) addressParts.push(claim.claimant_address_state);
        if (claim.claimant_address_country) addressParts.push(claim.claimant_address_country);
        if (claim.claimant_address_postal_code) addressParts.push(claim.claimant_address_postal_code);
        const formattedAddress = addressParts.join(', ') || 'N/A';

        return {
          id: claim.id,
          ibRequestId: claim.ib_request_id,
          ibName: ib.full_name || 'N/A',
          ibEmail: ib.email || 'N/A',
          ibReferralCode: ib.referral_code || 'N/A',
          ibType: ib.ib_type || 'N/A',
          userId: claim.user_id,
          userEmail: user.email || 'N/A',
          userName: user.name || 'N/A',
          rewardId: claim.reward_id,
          rewardValue: claim.reward_value,
          rewardDescription: claim.reward_description,
          rewardType: claim.reward_type,
          claimantName: claim.claimant_name,
          claimantPhone: claim.claimant_phone,
          claimantEmail: claim.claimant_email,
          address: {
            street: claim.claimant_address_street,
            city: claim.claimant_address_city,
            state: claim.claimant_address_state,
            country: claim.claimant_address_country,
            postalCode: claim.claimant_address_postal_code,
            formatted: formattedAddress
          },
          status: claim.status,
          totalVolumeMln: Number(claim.total_volume_mln || 0),
          adminNotes: claim.admin_notes,
          claimedAt: claim.claimed_at,
          updatedAt: claim.updated_at,
          createdAt: claim.created_at
        };
      })
    );

    res.json({
      success: true,
      data: {
        claims: claimsWithDetails,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: result.totalPages
      }
    });
  } catch (error) {
    console.error('Error fetching claims:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch reward claims',
      error: error.message
    });
  }
});

/**
 * GET /api/admin/rewards/claims/:id
 * Get single claim details
 */
router.get('/claims/:id', authenticateAdminToken, async (req, res) => {
  try {
    const { id } = req.params;
    const claim = await IBRewardClaim.getById(parseInt(id));

    if (!claim) {
      return res.status(404).json({
        success: false,
        message: 'Claim not found'
      });
    }

    // Get IB details
    const ibResult = await query(
      `SELECT id, full_name, email, referral_code, ib_type, status 
       FROM ib_requests 
       WHERE id = $1`,
      [claim.ib_request_id]
    );
    const ib = ibResult.rows[0] || {};

    // Get User details
    const userResult = await query(
      `SELECT id, email, name 
       FROM "User" 
       WHERE id = $1`,
      [claim.user_id]
    );
    const user = userResult.rows[0] || {};

    // Format address
    const addressParts = [];
    if (claim.claimant_address_street) addressParts.push(claim.claimant_address_street);
    if (claim.claimant_address_city) addressParts.push(claim.claimant_address_city);
    if (claim.claimant_address_state) addressParts.push(claim.claimant_address_state);
    if (claim.claimant_address_country) addressParts.push(claim.claimant_address_country);
    if (claim.claimant_address_postal_code) addressParts.push(claim.claimant_address_postal_code);
    const formattedAddress = addressParts.join(', ') || 'N/A';

    res.json({
      success: true,
      data: {
        id: claim.id,
        ibRequestId: claim.ib_request_id,
        ib: {
          id: ib.id,
          name: ib.full_name,
          email: ib.email,
          referralCode: ib.referral_code,
          ibType: ib.ib_type,
          status: ib.status
        },
        user: {
          id: user.id,
          email: user.email,
          name: user.name
        },
        reward: {
          id: claim.reward_id,
          value: claim.reward_value,
          description: claim.reward_description,
          type: claim.reward_type
        },
        claimant: {
          name: claim.claimant_name,
          phone: claim.claimant_phone,
          email: claim.claimant_email,
          address: {
            street: claim.claimant_address_street,
            city: claim.claimant_address_city,
            state: claim.claimant_address_state,
            country: claim.claimant_address_country,
            postalCode: claim.claimant_address_postal_code,
            formatted: formattedAddress
          }
        },
        status: claim.status,
        totalVolumeMln: Number(claim.total_volume_mln || 0),
        adminNotes: claim.admin_notes,
        claimedAt: claim.claimed_at,
        updatedAt: claim.updated_at,
        createdAt: claim.created_at
      }
    });
  } catch (error) {
    console.error('Error fetching claim details:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch claim details',
      error: error.message
    });
  }
});

/**
 * PUT /api/admin/rewards/claims/:id/status
 * Update claim status
 */
router.put('/claims/:id/status', authenticateAdminToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminNotes } = req.body;

    // Validate status
    const validStatuses = ['pending', 'approved', 'fulfilled', 'rejected'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    const claim = await IBRewardClaim.updateStatus(
      parseInt(id),
      status,
      adminNotes || null
    );

    if (!claim) {
      return res.status(404).json({
        success: false,
        message: 'Claim not found'
      });
    }

    res.json({
      success: true,
      message: 'Claim status updated successfully',
      data: {
        id: claim.id,
        status: claim.status,
        adminNotes: claim.admin_notes,
        updatedAt: claim.updated_at
      }
    });
  } catch (error) {
    console.error('Error updating claim status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update claim status',
      error: error.message
    });
  }
});

/**
 * GET /api/admin/rewards/stats
 * Get reward claims statistics
 */
router.get('/stats', authenticateAdminToken, async (req, res) => {
  try {
    // Get total claims
    const totalResult = await query('SELECT COUNT(*) as total FROM ib_reward_claims');
    const total = Number(totalResult.rows[0]?.total || 0);

    // Get claims by status
    const statusResult = await query(
      `SELECT status, COUNT(*) as count 
       FROM ib_reward_claims 
       GROUP BY status`
    );
    const byStatus = {};
    statusResult.rows.forEach(row => {
      byStatus[row.status] = Number(row.count || 0);
    });

    // Get total volume claimed
    const volumeResult = await query(
      `SELECT COALESCE(SUM(total_volume_mln), 0) as total_volume 
       FROM ib_reward_claims`
    );
    const totalVolumeMln = Number(volumeResult.rows[0]?.total_volume || 0);

    // Get claims by reward type
    const typeResult = await query(
      `SELECT reward_type, COUNT(*) as count 
       FROM ib_reward_claims 
       GROUP BY reward_type`
    );
    const byType = {};
    typeResult.rows.forEach(row => {
      byType[row.reward_type] = Number(row.count || 0);
    });

    // Get recent claims (last 30 days)
    const recentResult = await query(
      `SELECT COUNT(*) as count 
       FROM ib_reward_claims 
       WHERE claimed_at >= NOW() - INTERVAL '30 days'`
    );
    const recentClaims = Number(recentResult.rows[0]?.count || 0);

    res.json({
      success: true,
      data: {
        total,
        byStatus,
        byType,
        totalVolumeMln: Number(totalVolumeMln.toFixed(2)),
        recentClaims
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch statistics',
      error: error.message
    });
  }
});

export default router;

