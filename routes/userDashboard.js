import express from 'express';
import { authenticateToken } from './auth.js';
import { query } from '../config/database.js';
import { IBWithdrawal } from '../models/IBWithdrawal.js';

const router = express.Router();

router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;
    
    // Get IB request by email
    const ibResult = await query(
      `SELECT id, full_name, email, referral_code, ib_type, approved_at 
       FROM ib_requests 
       WHERE LOWER(email) = LOWER($1) AND status = 'approved'`,
      [userEmail]
    );
    
    if (ibResult.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          balance: 0,
          totalProfit: 0,
          commissionStructures: [],
          referralCode: null,
          referralLink: null
        }
      });
    }
    
    const ib = ibResult.rows[0];
    
    // Get commission structures (groups) - same as commission-analytics
    const groupsResult = await query(
      `SELECT group_id, group_name, structure_name, usd_per_lot, spread_share_percentage
       FROM ib_group_assignments
       WHERE ib_request_id = $1`,
      [ib.id]
    );
    
    // Use same earning logic as Overview/Analytics (approved groups + real accounts)
    const summary = await IBWithdrawal.getSummary(ib.id, { periodDays: Number(process.env.DASHBOARD_PERIOD_DAYS || 30) });
    const balance = Number(summary?.totalEarned || 0);
    
    // Get referral link
    const referralLink = ib.referral_code 
      ? `${process.env.FRONTEND_URL || 'http://localhost:5173'}/login?referralCode=${ib.referral_code}`
      : null;
    
    // Format commission structures
    const structures = groupsResult.rows.map(g => ({
      groupId: g.group_id,
      groupName: g.group_name,
      name: g.structure_name,
      usdPerLot: Number(g.usd_per_lot || 0),
      spreadShare: Number(g.spread_share_percentage || 0)
    }));
    
    res.json({
      success: true,
      data: {
        balance,
        totalProfit: balance,
        ibType: ib.ib_type,
        commissionStructures: structures,
        referralCode: ib.referral_code,
        referralLink,
        approvedDate: ib.approved_at
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard data:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch dashboard data'
    });
  }
});

export default router;
