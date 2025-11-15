import express from 'express';
import { authenticateToken } from './auth.js';
import { query } from '../config/database.js';
import { IBRewardClaim } from '../models/IBRewardClaim.js';

const router = express.Router();

// Reward milestones configuration
const REWARD_MILESTONES = [
  {
    id: 1,
    value: '800',
    description: '$300,000 Cash',
    target: 800, // 800 MLN USD
    type: 'cash'
  },
  {
    id: 2,
    value: '300',
    description: 'Luxury Sports Car',
    target: 300, // 300 MLN USD
    type: 'item'
  },
  {
    id: 3,
    value: '100',
    description: '$40,000 Cash',
    target: 100, // 100 MLN USD
    type: 'cash'
  },
  {
    id: 4,
    value: '50',
    description: 'A Luxury Watch',
    target: 50, // 50 MLN USD
    type: 'item'
  },
  {
    id: 5,
    value: '25',
    description: 'Luxury International Trip for 2',
    target: 25, // 25 MLN USD
    type: 'trip'
  },
  {
    id: 6,
    value: '10',
    description: 'Luxury City Break for 2',
    target: 10, // 10 MLN USD
    type: 'trip'
  },
  {
    id: 7,
    value: '5',
    description: 'High-end Electronics',
    target: 5, // 5 MLN USD
    type: 'item'
  },
  {
    id: 8,
    value: '1.5',
    description: 'Smartphone',
    target: 1.5, // 1.5 MLN USD
    type: 'item'
  },
  {
    id: 9,
    value: '0.5',
    description: '$500 Cash',
    target: 0.5, // 0.5 MLN USD
    type: 'cash'
  }
];

/**
 * GET /api/user/rewards/volume
 * Get total lifetime trading volume in MLN USD for the authenticated IB user
 */
router.get('/volume', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;

    // Get IB request ID from user email
    const ibResult = await query(
      `SELECT id FROM ib_requests WHERE LOWER(email) = LOWER($1) AND status = 'approved' LIMIT 1`,
      [userEmail]
    );

    if (ibResult.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          totalVolumeMln: 0,
          totalVolumeLots: 0
        }
      });
    }

    const ibRequestId = ibResult.rows[0].id;

    // Calculate total volume from ib_trade_history
    // Include ALL trades for this IB (both IB's own trades and referred users' trades)
    // Formula: SUM(volume_lots) * 0.1 = total volume in millions USD
    // (1 lot = 100,000 USD, so lots * 0.1 = MLN USD)
    // Note: volume_lots is already divided by 100 when saved from API
    const volumeResult = await query(
      `SELECT 
         COALESCE(SUM(volume_lots), 0) as total_lots,
         COUNT(*) as trade_count
       FROM ib_trade_history
       WHERE ib_request_id = $1
         AND volume_lots > 0`,
      [ibRequestId]
    );

    const totalLots = Number(volumeResult.rows[0]?.total_lots || 0);
    const tradeCount = Number(volumeResult.rows[0]?.trade_count || 0);
    const totalVolumeMln = totalLots * 0.1; // Convert to millions USD
    
    console.log(`[REWARDS] Volume calculation for IB ${ibRequestId}: totalLots=${totalLots}, tradeCount=${tradeCount}, totalVolumeMln=${totalVolumeMln}`);

    res.json({
      success: true,
      data: {
        totalVolumeMln: Number(totalVolumeMln.toFixed(2)),
        totalVolumeLots: Number(totalLots.toFixed(4))
      }
    });
  } catch (error) {
    console.error('Error fetching volume:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch trading volume',
      error: error.message
    });
  }
});

/**
 * GET /api/user/rewards/profile
 * Get user profile data for pre-filling claim form
 */
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user?.email;

    if (!userEmail) {
      return res.status(400).json({
        success: false,
        message: 'User email not found',
        data: {
          name: '',
          email: '',
          phone: '',
          address: {
            street: '',
            city: '',
            state: '',
            country: '',
            postalCode: ''
          }
        }
      });
    }

    // Get IB request data
    const ibResult = await query(
      `SELECT id, full_name, email FROM ib_requests WHERE LOWER(email) = LOWER($1) AND status = 'approved' LIMIT 1`,
      [userEmail]
    );

    if (ibResult.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          name: '',
          email: userEmail || '',
          phone: '',
          address: {
            street: '',
            city: '',
            state: '',
            country: '',
            postalCode: ''
          }
        }
      });
    }

    const ib = ibResult.rows[0];
    
    // Get phone and address from User table (single query, try multiple column names)
    let phone = null;
    let address = {
      street: '',
      city: '',
      state: '',
      country: '',
      postalCode: ''
    };
    
    try {
      const userResult = await query('SELECT * FROM "User" WHERE LOWER(email) = LOWER($1) LIMIT 1', [userEmail]);
      if (userResult.rows.length > 0) {
        const u = userResult.rows[0];
        // Try multiple column names for phone
        phone = u.phone || u.phone_number || u.phonenumber || u.mobile || u.mobile_number || u.contact_number || null;
        // Try multiple column names for address fields
        address = {
          street: u.address || u.address_street || u.street || u.street_address || '',
          city: u.city || '',
          state: u.state || u.state_province || '',
          country: u.country || '',
          postalCode: u.postal_code || u.postalcode || u.zip_code || u.zip || ''
        };
      }
    } catch (error) {
      console.warn('[REWARDS] Error fetching user data from User table:', error.message);
      // Continue with empty values - not critical
    }

    res.json({
      success: true,
      data: {
        name: ib.full_name || '',
        email: ib.email || userEmail || '',
        phone: phone || '',
        address: address
      }
    });
  } catch (error) {
    console.error('[REWARDS] Error fetching user profile:', error);
    console.error('[REWARDS] Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user profile',
      error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined
    });
  }
});

/**
 * GET /api/user/rewards/milestones
 * Get reward milestones with unlock status
 */
router.get('/milestones', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;

    // Get IB request ID
    const ibResult = await query(
      `SELECT id FROM ib_requests WHERE LOWER(email) = LOWER($1) AND status = 'approved' LIMIT 1`,
      [userEmail]
    );

    if (ibResult.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          milestones: REWARD_MILESTONES.map(r => ({
            ...r,
            unlocked: false,
            claimed: false,
            status: 'locked'
          })),
          totalVolumeMln: 0
        }
      });
    }

    const ibRequestId = ibResult.rows[0].id;

    // Get total volume - include ALL trades for this IB
    const volumeResult = await query(
      `SELECT 
         COALESCE(SUM(volume_lots), 0) as total_lots,
         COUNT(*) as trade_count
       FROM ib_trade_history
       WHERE ib_request_id = $1
         AND volume_lots > 0`,
      [ibRequestId]
    );

    const totalLots = Number(volumeResult.rows[0]?.total_lots || 0);
    const tradeCount = Number(volumeResult.rows[0]?.trade_count || 0);
    const totalVolumeMln = totalLots * 0.1; // Convert to millions USD (1 lot = 100k USD, so lots * 0.1 = MLN)

    console.log(`[REWARDS] IB ${ibRequestId}: totalLots=${totalLots}, tradeCount=${tradeCount}, totalVolumeMln=${totalVolumeMln}`);

    // Get claimed rewards (model handles table creation and errors)
    const claimedRewards = await IBRewardClaim.getByIB(ibRequestId);
    const claimedRewardIds = new Set(claimedRewards.map(c => c.reward_id));

    // Build milestones with status
    const milestones = REWARD_MILESTONES.map(reward => {
      const unlocked = totalVolumeMln >= reward.target;
      const claimed = claimedRewardIds.has(reward.id);
      
      let status = 'locked';
      if (claimed) {
        status = 'claimed';
      } else if (unlocked) {
        status = 'unlocked';
      }

      console.log(`[REWARDS] Reward ${reward.id} (${reward.value} MLN): volume=${totalVolumeMln.toFixed(2)}, target=${reward.target}, unlocked=${unlocked}, claimed=${claimed}, status=${status}`);

      return {
        ...reward,
        unlocked,
        claimed,
        status
      };
    });

    res.json({
      success: true,
      data: {
        milestones,
        totalVolumeMln: Number(totalVolumeMln.toFixed(2))
      }
    });
  } catch (error) {
    console.error('Error fetching milestones:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch reward milestones',
      error: error.message
    });
  }
});

/**
 * POST /api/user/rewards/claim
 * Submit a reward claim
 */
router.post('/claim', authenticateToken, async (req, res) => {
  try {
    console.log('[REWARDS CLAIM] Claim request received');
    console.log('[REWARDS CLAIM] Request body:', JSON.stringify(req.body, null, 2));
    console.log('[REWARDS CLAIM] User:', req.user?.id, req.user?.email);
    
    const userId = req.user?.id;
    const userEmail = req.user?.email;
    
    if (!userId || !userEmail) {
      console.error('[REWARDS CLAIM] Missing user authentication');
      return res.status(401).json({
        success: false,
        message: 'User authentication required'
      });
    }
    
    const {
      rewardId,
      name,
      phone,
      email,
      address
    } = req.body;

    // Validate required fields
    if (!rewardId || !name || !phone || !email) {
      console.error('[REWARDS CLAIM] Missing required fields:', { rewardId, name, phone, email });
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: rewardId, name, phone, email'
      });
    }

    // Get IB request ID
    const ibResult = await query(
      `SELECT id FROM ib_requests WHERE LOWER(email) = LOWER($1) AND status = 'approved' LIMIT 1`,
      [userEmail]
    );

    if (ibResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'IB profile not found or not approved'
      });
    }

    const ibRequestId = ibResult.rows[0].id;

    // Get User table ID from email (for foreign key constraint)
    let userTableId = userId; // Default to userId from token
    try {
      const userResult = await query('SELECT id FROM "User" WHERE LOWER(email) = LOWER($1) LIMIT 1', [userEmail]);
      if (userResult.rows.length > 0) {
        userTableId = String(userResult.rows[0].id);
      } else {
        console.warn('[REWARDS CLAIM] User not found in User table for email:', userEmail);
        // If user doesn't exist in User table, we can't create the claim with foreign key
        // Either create the user or make user_id nullable
        return res.status(400).json({
          success: false,
          message: 'User account not found. Please contact support.'
        });
      }
    } catch (error) {
      console.error('[REWARDS CLAIM] Error fetching User ID:', error);
      return res.status(500).json({
        success: false,
        message: 'Error validating user account',
        error: process.env.NODE_ENV !== 'production' ? error.message : undefined
      });
    }

    // Find reward milestone
    const reward = REWARD_MILESTONES.find(r => r.id === rewardId);
    if (!reward) {
      return res.status(400).json({
        success: false,
        message: 'Invalid reward ID'
      });
    }

    // Get total volume
    const volumeResult = await query(
      `SELECT COALESCE(SUM(volume_lots), 0) as total_lots
       FROM ib_trade_history
       WHERE ib_request_id = $1`,
      [ibRequestId]
    );

    const totalLots = Number(volumeResult.rows[0]?.total_lots || 0);
    const totalVolumeMln = totalLots * 0.1;

    // Validate reward is unlocked
    if (totalVolumeMln < reward.target) {
      return res.status(400).json({
        success: false,
        message: `Reward not unlocked. Current volume: ${totalVolumeMln.toFixed(2)} MLN, Required: ${reward.target} MLN`
      });
    }

    // Check if already claimed
    const isAlreadyClaimed = await IBRewardClaim.isClaimed(ibRequestId, rewardId);
    if (isAlreadyClaimed) {
      return res.status(400).json({
        success: false,
        message: 'This reward has already been claimed'
      });
    }

    // Create claim
    console.log('[REWARDS CLAIM] Creating claim with:', {
      ibRequestId,
      userId: userTableId,
      rewardId: reward.id,
      totalVolumeMln
    });
    
    const claim = await IBRewardClaim.createClaim(
      ibRequestId,
      userTableId, // Use User table ID, not IB request ID
      reward,
      {
        name,
        phone,
        email,
        address: address || {}
      },
      totalVolumeMln
    );

    console.log('[REWARDS CLAIM] Claim created successfully:', claim.id);

    res.json({
      success: true,
      message: 'Reward claim submitted successfully',
      data: {
        claimId: claim.id,
        status: claim.status
      }
    });
  } catch (error) {
    console.error('[REWARDS CLAIM] Error submitting claim:', error);
    console.error('[REWARDS CLAIM] Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to submit reward claim',
      error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined
    });
  }
});

/**
 * GET /api/user/rewards/claims
 * Get user's claimed rewards history
 */
router.get('/claims', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;

    // Get IB request ID
    const ibResult = await query(
      `SELECT id FROM ib_requests WHERE LOWER(email) = LOWER($1) AND status = 'approved' LIMIT 1`,
      [userEmail]
    );

    if (ibResult.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          claims: []
        }
      });
    }

    const ibRequestId = ibResult.rows[0].id;

    // Get claims
    const claims = await IBRewardClaim.getByIB(ibRequestId);

    res.json({
      success: true,
      data: {
        claims: claims.map(claim => ({
          id: claim.id,
          rewardId: claim.reward_id,
          rewardValue: claim.reward_value,
          rewardDescription: claim.reward_description,
          rewardType: claim.reward_type,
          status: claim.status,
          totalVolumeMln: Number(claim.total_volume_mln || 0),
          claimedAt: claim.claimed_at,
          updatedAt: claim.updated_at
        }))
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

export default router;

