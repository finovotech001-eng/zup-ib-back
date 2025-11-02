 import express from 'express';
 import { IBRequest, IB_REQUEST_TYPE_VALUES, IB_REQUEST_STATUS_VALUES } from '../models/IBRequest.js';
 import { MT5Groups } from '../models/MT5Groups.js';
import { GroupCommissionStructures } from '../models/GroupCommissionStructures.js';
import { IBGroupAssignment } from '../models/IBGroupAssignment.js';
import { IBTradeHistory } from '../models/IBTradeHistory.js';
 import { authenticateAdminToken } from './adminAuth.js';
 import { query } from '../config/database.js';

const router = express.Router();
const ALLOWED_IB_TYPES = IB_REQUEST_TYPE_VALUES;


// Get all IB requests with pagination
router.get('/', authenticateAdminToken, async (req, res) => {
  try {
    const { status } = req.query;
    const page = Number.parseInt(req.query.page ?? '1', 10) || 1;
    const limit = Number.parseInt(req.query.limit ?? '50', 10) || 50;
    const offset = (page - 1) * limit;

    let requests;
    if (status && status !== 'all') {
      const result = await query(
        `SELECT * FROM ib_requests WHERE status = $1 ORDER BY submitted_at DESC LIMIT $2 OFFSET $3`,
        [status, limit, offset]
      );
      requests = result.rows.map(record => IBRequest.stripSensitiveFields(record));
    } else {
      requests = await IBRequest.findAll(limit, offset);
    }

    const countResult = await query('SELECT COUNT(*) FROM ib_requests');
    const totalCount = Number.parseInt(countResult.rows[0].count, 10) || 0;

    res.json({
      success: true,
      data: {
        requests,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / (limit || 1))
        }
      }
    });
  } catch (error) {
    console.error('Fetch IB requests error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch IB requests', error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined });
  }
});

// Get MT5 groups (all without pagination)
router.get('/groups', authenticateAdminToken, async (req, res) => {
  try {
    const groups = await MT5Groups.getAllWithoutPagination();
    res.json({
      success: true,
      data: {
        groups,
        pagination: {
          page: 1,
          limit: groups.length,
          total: groups.length,
          totalPages: 1
        }
      }
    });
  } catch (error) {
    console.error('Fetch groups error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch groups', error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined });
  }
});

// Sync MT5 groups from API
router.post('/groups/sync', authenticateAdminToken, async (req, res) => {
  try {
    const result = await MT5Groups.syncFromAPI();
    res.json({
      success: true,
      message: result.message
    });
  } catch (error) {
    console.error('Sync groups error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to sync groups from API'
    });
  }
});

// Regenerate all group names based on group IDs
router.post('/groups/regenerate-names', authenticateAdminToken, async (req, res) => {
  try {
    const result = await MT5Groups.regenerateAllNames();
    res.json({
      success: true,
      message: result.message
    });
  } catch (error) {
    console.error('Regenerate group names error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to regenerate group names'
    });
  }
});

// Get individual group details
router.get('/groups/:groupId', authenticateAdminToken, async (req, res) => {
  try {
    const { groupId } = req.params;
    const group = await MT5Groups.findById(groupId);

    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    res.json({
      success: true,
      data: { group }
    });
  } catch (error) {
    console.error('Fetch group error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch group'
    });
  }
});

// Update individual group name
router.put('/groups/*/name', authenticateAdminToken, async (req, res) => {
  try {
    const rawGroupId = req.params[0];
    const groupId = decodeURIComponent(rawGroupId || '');
    const { name } = req.body;

    console.log('Updating group name:', { groupId, name });

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Group name is required'
      });
    }

    if (!groupId) {
      return res.status(400).json({
        success: false,
        message: 'Group ID is required'
      });
    }

    const result = await MT5Groups.updateGroupName(groupId, name.trim());
    console.log('Update result:', result);

    res.json({
      success: true,
      message: result.message,
      data: { groupId, name: name.trim() }
    });
  } catch (error) {
    console.error('Update group name error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Unable to update group name'
    });
  }
});

// Get all commission structures across all groups
router.get('/commission-structures', authenticateAdminToken, async (req, res) => {
  try {
    const page = Number.parseInt(req.query.page ?? '1', 10) || 1;
    const limit = Number.parseInt(req.query.limit ?? '10', 10) || 10;
    const result = await GroupCommissionStructures.getAllStructures(page, limit);

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Fetch all commission structures error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch commission structures', error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined });
  }
});

// Get groups with their commission structures for approval
router.get('/approval-options', authenticateAdminToken, async (req, res) => {
  try {
    // Get all groups
    const groups = await MT5Groups.getAllWithoutPagination();

    // Get all commission structures with group names
    const structuresResult = await GroupCommissionStructures.getAllStructures(1, 1000); // Get all structures
    const structures = structuresResult.structures;

    // Group structures by group_id
    const groupsWithStructures = groups.map(group => {
      const groupStructures = structures.filter(structure => structure.group_id === group.group_id);
      return {
        ...group,
        commissionStructures: groupStructures
      };
    });

    res.json({
      success: true,
      data: {
        groups: groupsWithStructures,
        totalGroups: groups.length
      }
    });
  } catch (error) {
    console.error('Fetch approval options error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch approval options'
    });
  }
});

// Get single IB request by ID
router.get('/:id', authenticateAdminToken, async (req, res) => {
  try {
    const { id } = req.params;
    const request = await IBRequest.findById(id);

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'IB request not found'
      });
    }

    res.json({
      success: true,
      data: {
        request: IBRequest.stripSensitiveFields(request)
      }
    });
  } catch (error) {
    console.error('Fetch IB request error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch IB request', error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined });
  }
});

  // Update IB request status (approve/reject/ban)
  router.put('/:id/status', authenticateAdminToken, async (req, res) => {
    try {
      const { id } = req.params;
      const { status, adminComments, usdPerLot, spreadPercentagePerLot, spreadSharePercentage, ibType, groupId, structureId, groups } = req.body;

      // Validate status
      const validStatuses = IB_REQUEST_STATUS_VALUES;
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid status. Must be one of: ' + validStatuses.join(', ')
        });
      }

      let normalizedIbType = null;
      if (typeof ibType === 'string' && ibType.trim()) {
        const trimmedType = ibType.trim().toLowerCase();
        if (!ALLOWED_IB_TYPES.includes(trimmedType)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid IB type supplied.'
          });
        }
        normalizedIbType = trimmedType;
      }

      // Handle multiple groups approval (new format)
      if (status === 'approved' && groups && Array.isArray(groups)) {
        // Validate groups data
        if (groups.length === 0) {
          return res.status(400).json({
            success: false,
            message: 'At least one group must be selected for approval'
          });
        }

        for (let i = 0; i < groups.length; i++) {
          const group = groups[i];
          const usdValue = Number(group.usdPerLot);
          const spreadValue = Number(group.spreadSharePercentage);

          if (!Number.isFinite(usdValue) || !Number.isFinite(spreadValue)) {
            return res.status(400).json({
              success: false,
              message: `Invalid commission values for group ${group.groupName || `at index ${i + 1}`}`
            });
          }

          if (usdValue < 0 || spreadValue < 0 || spreadValue > 100) {
            return res.status(400).json({
              success: false,
              message: `Invalid commission values for group ${group.groupName || `at index ${i + 1}`}`
            });
          }
        }

        // For multiple groups, we'll use the first group's data for the main IB record
        // and store additional groups data separately
        const firstGroup = groups[0];
        const updatedRequest = await IBRequest.updateStatus(
          id,
          status,
          adminComments,
          firstGroup.usdPerLot,
          firstGroup.spreadSharePercentage,
          normalizedIbType,
          firstGroup.groupId,
          structureId
        );

        if (!updatedRequest) {
          return res.status(404).json({
            success: false,
            message: 'IB request not found'
          });
        }

        await IBGroupAssignment.replaceAssignments(id, groups.map((group) => ({
          groupId: group.groupId,
          groupName: group.groupName,
          structureId: group.structureId,
          structureName: group.structureName,
          usdPerLot: group.usdPerLot,
          spreadSharePercentage: group.spreadSharePercentage
        })));

        res.json({
          success: true,
          message: `IB request ${status} successfully for ${groups.length} group${groups.length !== 1 ? 's' : ''}`,
          data: {
            request: updatedRequest
          }
        });
      }
      // Handle legacy single group approval (backward compatibility)
      else if (status === 'approved') {
        // Validate commission fields for approved status
        let parsedUsdPerLot = Number(usdPerLot);
        let parsedSpreadPercentage = Number(spreadPercentagePerLot || spreadSharePercentage);

        const hasMissingCommissionValues =
          usdPerLot === undefined ||
          usdPerLot === null ||
          parsedSpreadPercentage === undefined ||
          parsedSpreadPercentage === null;

        if (hasMissingCommissionValues) {
          return res.status(400).json({
            success: false,
            message: 'USD per lot and spread percentage are required for approval'
          });
        }

        if (!Number.isFinite(parsedUsdPerLot) || !Number.isFinite(parsedSpreadPercentage)) {
          return res.status(400).json({
            success: false,
            message: 'Commission values must be valid numbers'
          });
        }

        if (parsedUsdPerLot < 0 || parsedSpreadPercentage < 0 || parsedSpreadPercentage > 100) {
          return res.status(400).json({
            success: false,
            message: 'Invalid commission values'
          });
        }

        const updatedRequest = await IBRequest.updateStatus(
          id,
          status,
          adminComments,
          parsedUsdPerLot,
          parsedSpreadPercentage,
          normalizedIbType,
          groupId,
          structureId
        );

        if (!updatedRequest) {
          return res.status(404).json({
            success: false,
            message: 'IB request not found'
          });
        }

        await IBGroupAssignment.replaceAssignments(id, [{
          groupId,
          groupName: null,
          structureId,
          structureName: null,
          usdPerLot: parsedUsdPerLot,
          spreadSharePercentage: parsedSpreadPercentage
        }]);

        res.json({
          success: true,
          message: `IB request ${status} successfully`,
          data: {
            request: updatedRequest
          }
        });
      }
      // Handle rejection/ban (no commission validation needed)
      else {
        const updatedRequest = await IBRequest.updateStatus(
          id,
          status,
          adminComments,
          null,
          null,
          normalizedIbType,
          groupId,
          structureId
        );

        if (!updatedRequest) {
          return res.status(404).json({
            success: false,
            message: 'IB request not found'
          });
        }

        await IBGroupAssignment.clearAssignments(id);

        res.json({
          success: true,
          message: `IB request ${status} successfully`,
          data: {
            request: updatedRequest
          }
        });
      }
    } catch (error) {
      console.error('Update IB request status error:', error);
      res.status(500).json({
        success: false,
        message: 'Unable to update IB request status',
        error: error?.message ?? null
      });
    }
  });

// Get commission structures for a group
router.get('/groups/*/commissions', authenticateAdminToken, async (req, res) => {
  try {
    const groupId = req.params[0];
    const page = Number.parseInt(req.query.page ?? '1', 10) || 1;
    const limit = Number.parseInt(req.query.limit ?? '10', 10) || 10;
    const result = await GroupCommissionStructures.getByGroupId(groupId, page, limit);

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Fetch group commissions error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch group commission structures', error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined });
  }
});

// Get IB requests statistics
router.get('/stats/overview', authenticateAdminToken, async (req, res) => {
  try {
    const stats = await IBRequest.getStats();
    res.json({ success: true, data: { stats } });
  } catch (error) {
    console.error('Fetch IB requests stats error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch IB requests statistics', error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined });
  }
});

// Get recent activity (for dashboard)
router.get('/activity/recent', authenticateAdminToken, async (req, res) => {
  try {
    const result = await query(
      `
        SELECT id, full_name, email, status, approved_at, submitted_at
        FROM ib_requests
        ORDER BY COALESCE(approved_at, submitted_at) DESC
        LIMIT 10
      `
    );

    const activities = result.rows.map((row) => ({
      id: row.id,
      type: (row.status || '').toLowerCase().trim() === 'approved' ? 'ib_approved' : `ib_${(row.status || '').toLowerCase().trim()}`,
      message:
        (row.status || '').toLowerCase().trim() === 'approved'
          ? `IB approved: ${row.full_name || row.email}`
          : `IB ${row.status}: ${row.full_name || row.email}`,
      timestamp: (row.approved_at || row.submitted_at || new Date()).toISOString(),
      icon: (row.status || '').toLowerCase().trim() === 'approved' ? 'green' : (row.status || '').toLowerCase().trim() === 'rejected' ? 'red' : 'blue'
    }));

    res.json({ success: true, data: { activities } });
  } catch (error) {
    console.error('Fetch recent activity error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch recent activity', error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined });
  }
});

// Get approved IB profiles
router.get('/profiles/approved', authenticateAdminToken, async (req, res) => {
  try {
    const result = await query(
      `
        SELECT
          id,
          full_name,
          email,
          status,
          ib_type,
          submitted_at as join_date,
          approved_at,
          usd_per_lot,
          spread_percentage_per_lot,
          admin_comments
        FROM ib_requests
        WHERE LOWER(TRIM(status)) = 'approved'
        ORDER BY approved_at DESC NULLS LAST, submitted_at DESC
      `
    );

    const profiles = result.rows.map(record => ({
      id: record.id,
      name: record.full_name,
      email: record.email,
      status: record.status,
      ibType: record.ib_type,
      joinDate: record.join_date,
      approvedDate: record.approved_at,
      usdPerLot: Number(record.usd_per_lot || 0),
      spreadPercentagePerLot: Number(record.spread_percentage_per_lot || 0),
      adminComments: record.admin_comments,
      totalClients: 0,
      totalVolume: 0,
      commission: Number(record.usd_per_lot || 0),
      performance: null
    }));

    res.json({ success: true, data: { profiles } });
  } catch (error) {
    console.error('Fetch approved IB profiles error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch approved IB profiles', error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined });
  }
});

// Get single IB profile by ID
router.get('/profiles/:id', authenticateAdminToken, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await query(
      `
        SELECT
          id,
          full_name,
          email,
          status,
          ib_type,
          submitted_at,
          approved_at,
          usd_per_lot,
          spread_percentage_per_lot,
          admin_comments,
          group_id,
          structure_id
        FROM ib_requests
        WHERE id = $1 AND LOWER(TRIM(status)) = 'approved'
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Approved IB profile not found'
      });
    }

    const record = result.rows[0];
    const phone = await getUserPhone(record.email);
    const groups = await getGroupAssignments(record);

    const profile = {
      id: record.id,
      status: record.status,
      fullName: record.full_name,
      email: record.email,
      phone,
      ibType: record.ib_type,
      usdPerLot: Number(record.usd_per_lot || 0),
      spreadPercentagePerLot: Number(record.spread_percentage_per_lot || 0),
      approvedDate: record.approved_at,
      adminComments: record.admin_comments,
      groups,
      accountStats: await getAccountStats(record.id),
      tradingAccounts: await getTradingAccounts(record.id),
      tradeHistory: await getTradeHistory(record.id),
      treeStructure: await getTreeStructure(record.id)
    };

    res.json({
      success: true,
      data: {
        profile
      }
    });
  } catch (error) {
    console.error('Fetch IB profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch IB profile'
    });
  }
});

// Account statistics (live MT5 balances)
router.get('/profiles/:id/account-stats', authenticateAdminToken, async (req, res) => {
  try {
    const { id } = req.params;
    const ibResult = await query('SELECT email FROM ib_requests WHERE id = $1', [id]);
    if (ibResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'IB not found' });
    }

    const email = ibResult.rows[0].email;
    const userResult = await query('SELECT id FROM "User" WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          totals: { totalAccounts: 0, totalBalance: 0, totalEquity: 0 },
          accounts: []
        }
      });
    }

    const userId = userResult.rows[0].id;
    const accountsResult = await query('SELECT "accountId" FROM "MT5Account" WHERE "userId" = $1', [userId]);

    const totals = {
      totalAccounts: accountsResult.rows.length,
      totalBalance: 0,
      totalEquity: 0
    };

    // Fetch profiles in parallel for speed, each with timeout + one retry
    const fetchOne = async (accountId) => {
      let payload = null;
      const profileUrl = `http://18.175.242.21:5003/api/Users/${accountId}/getClientProfile`;
      const attempt = async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
          const res = await fetch(profileUrl, { headers: { accept: '*/*' }, signal: controller.signal });
          if (res.ok) {
            const data = await res.json();
            if (data?.Success && (data?.Data || data?.data)) payload = data.Data || data.data;
          }
        } catch {}
        clearTimeout(timer);
      };
      await attempt();
      if (!payload) await attempt();

      const balance = Number(payload?.Balance ?? payload?.balance ?? 0);
      const equity = Number(payload?.Equity ?? payload?.equity ?? 0);
      let groupName = payload?.Group ?? payload?.group ?? payload?.GroupName ?? payload?.group_name ?? 'Unknown';
      if (typeof groupName === 'string') {
        // Prefer extracting the segment after 'Bbook\'
        const match = groupName.match(/Bbook\\([^\\/]+)/i) || groupName.match(/Bbook\\\\([^\\/]+)/i);
        if (match && match[1]) {
          groupName = match[1];
        } else if (groupName.includes('\\')) {
          const parts = groupName.split('\\');
          groupName = parts.length >= 3 ? parts[2] : parts[parts.length - 1];
        } else if (groupName.includes('/')) {
          const parts = groupName.split('/');
          groupName = parts[parts.length - 1];
        }
      }

      return {
        accountId,
        balance,
        equity,
        margin: Number(payload?.Margin ?? payload?.margin ?? 0),
        profit: Number(payload?.Profit ?? payload?.profit ?? 0),
        currencyDigits: payload?.CurrencyDigits ?? payload?.currencyDigits ?? 2,
        marginFree: Number(payload?.MarginFree ?? payload?.marginFree ?? 0),
        group: groupName,
        groupId: payload?.Group || payload?.group || null,
        raw: payload
      };
    };

    const accounts = await Promise.all(accountsResult.rows.map(r => fetchOne(r.accountId)));
    for (const acc of accounts) {
      totals.totalBalance += acc.balance;
      totals.totalEquity += acc.equity;
    }

    const tradeMetrics = await IBTradeHistory.getAccountStats(userId);
    const summary = tradeMetrics.reduce((acc, row) => {
      acc.totalTrades += Number(row.trade_count || 0);
      acc.totalVolume += Number(row.total_volume || 0);
      acc.totalProfit += Number(row.total_profit || 0);
      acc.totalIbCommission += Number(row.total_ib_commission || 0);
      return acc;
    }, { totalTrades: 0, totalVolume: 0, totalProfit: 0, totalIbCommission: 0 });

    res.json({ success: true, data: { totals, accounts, trades: tradeMetrics, tradeSummary: summary } });
  } catch (error) {
    console.error('Fetch account stats error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch account statistics' });
  }
});

// Trade history for IB profile
router.get('/profiles/:id/trades', authenticateAdminToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { accountId, page = 1, pageSize = 50, sync } = req.query;

    const ibResult = await query('SELECT email FROM ib_requests WHERE id = $1', [id]);
    if (ibResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'IB not found' });
    }

    const email = ibResult.rows[0].email;
    const userResult = await query('SELECT id FROM "User" WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.json({ success: true, data: { trades: [], total: 0, page: Number(page), pageSize: Number(pageSize) } });
    }

    const userId = userResult.rows[0].id;

    if (sync === '1' && accountId) {
      await syncTradesForAccount({ ibId: id, userId, accountId });
    }

    const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

    const { groupId } = req.query;
    const result = await IBTradeHistory.getTrades({ userId, accountId, groupId, limit, offset });
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Fetch trade history error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch trade history' });
  }
});

async function getUserPhone(email) {
  try {
    const result = await query('SELECT * FROM "User" WHERE email = $1 LIMIT 1', [email]);
    if (!result.rows.length) {
      return null;
    }
    const user = result.rows[0];
    return (
      user.phone ||
      user.phone_number ||
      user.phonenumber ||
      user.mobile ||
      user.mobile_number ||
      user.contact_number ||
      null
    );
  } catch (error) {
    console.warn('Fetch user phone error:', error.message);
    return null;
  }
}

async function getGroupAssignments(record) {
  try {
    const savedAssignments = await IBGroupAssignment.getByIbRequestId(record.id);
    if (savedAssignments.length) {
      const groups = savedAssignments.map((assignment) => ({
        groupId: assignment.group_id,
        groupName: assignment.group_name || assignment.group_id,
        structureId: assignment.structure_id,
        structureName: assignment.structure_name,
        usdPerLot: Number(assignment.usd_per_lot || 0),
        spreadSharePercentage: Number(assignment.spread_share_percentage || 0),
        totalCommission: 0,
        totalLots: 0,
        totalVolume: 0
      }));
      // Enrich with live totals from ib_trade_history aggregated by current account groups
      const aggregates = await computeGroupAggregates(record.id, record.email);
      return groups.map(g => ({
        ...g,
        totalCommission: Number(aggregates[g.groupId]?.totalCommission || 0),
        totalLots: Number(aggregates[g.groupId]?.totalLots || 0),
        totalVolume: Number(aggregates[g.groupId]?.totalLots || 0)
      }));
    }

    if (!record.group_id) {
      return [];
    }

    const groupRes = await query('SELECT group_id, name FROM mt5_groups WHERE group_id = $1', [record.group_id]);
    const structureRes = record.structure_id
      ? await query(
          'SELECT id, structure_name, usd_per_lot, spread_share_percentage FROM group_commission_structures WHERE id = $1',
          [record.structure_id]
        )
      : { rows: [] };

    const group = groupRes.rows[0];
    if (!group) {
      return [];
    }

    const structure = structureRes.rows[0];

    const groups = [
      {
        groupId: group.group_id,
        groupName: group.name || group.group_id,
        structureId: structure?.id || null,
        structureName: structure?.structure_name || null,
        usdPerLot: Number(record.usd_per_lot || structure?.usd_per_lot || 0),
        spreadSharePercentage: Number(record.spread_percentage_per_lot || structure?.spread_share_percentage || 0),
        totalCommission: 0,
        totalLots: 0,
        totalVolume: 0
      }
    ];
    const aggregates = await computeGroupAggregates(record.id, record.email);
    return groups.map(g => ({
      ...g,
      totalCommission: Number(aggregates[g.groupId]?.totalCommission || 0),
      totalLots: Number(aggregates[g.groupId]?.totalLots || 0),
      totalVolume: Number(aggregates[g.groupId]?.totalLots || 0)
    }));
  } catch (error) {
    console.error('Error fetching group assignments:', error);
    return [];
  }
}

// Build aggregates per MT5 group based on current account groups and ib_trade_history
async function computeGroupAggregates(ibId, ibEmail) {
  try {
    // Resolve userId from email
    const userResult = await query('SELECT id FROM "User" WHERE email = $1', [ibEmail]);
    if (!userResult.rows.length) return {};
    const userId = userResult.rows[0].id;

    // Fetch all accounts
    const accountsRes = await query('SELECT "accountId" FROM "MT5Account" WHERE "userId" = $1', [userId]);
    if (!accountsRes.rows.length) return {};

    // Build map accountId -> groupId (full path) via ClientProfile (parallel for speed)
    const accountToGroup = {};
    const profilePromises = accountsRes.rows.map(async (row) => {
      const accountId = row.accountId;
      try {
        const res = await fetch(`http://18.175.242.21:5003/api/Users/${accountId}/getClientProfile`, { headers: { accept: '*/*' } });
        if (res.ok) {
          const data = await res.json();
          const payload = data?.Data || data?.data || null;
          const groupId = payload?.Group || payload?.group || null;
          if (groupId) accountToGroup[String(accountId)] = groupId;
        }
      } catch {}
    });
    await Promise.allSettled(profilePromises);

    if (!Object.keys(accountToGroup).length) return {};

    // Sum lots and commissions per account from DB, then fold by groupId
    const tradesRes = await query(
      `SELECT account_id, COALESCE(SUM(volume_lots),0) AS total_lots, COALESCE(SUM(ib_commission),0) AS total_commission
       FROM ib_trade_history WHERE ib_request_id = $1 GROUP BY account_id`,
      [ibId]
    );

    const totals = tradesRes.rows.reduce((acc, row) => {
      const groupId = accountToGroup[row.account_id];
      if (!groupId) return acc; // skip if no mapping
      if (!acc[groupId]) acc[groupId] = { totalLots: 0, totalCommission: 0 };
      acc[groupId].totalLots += Number(row.total_lots || 0);
      acc[groupId].totalCommission += Number(row.total_commission || 0);
      return acc;
    }, {});

    return totals;
  } catch (e) {
    console.warn('computeGroupAggregates error:', e.message);
    return {};
  }
}

async function buildCommissionMap(ibId) {
  const assignments = await query(
    'SELECT group_id, usd_per_lot, spread_share_percentage FROM ib_group_assignments WHERE ib_request_id = $1',
    [ibId]
  );

  const map = assignments.rows.reduce((acc, row) => {
    if (!row.group_id) return acc;
    acc[row.group_id.toLowerCase()] = {
      usdPerLot: Number(row.usd_per_lot || 0),
      spreadPercentage: Number(row.spread_share_percentage || 0)
    };
    return acc;
  }, {});

  if (!Object.keys(map).length) {
    const fallback = await query('SELECT usd_per_lot, spread_percentage_per_lot FROM ib_requests WHERE id = $1', [ibId]);
    const row = fallback.rows[0];
    map['*'] = {
      usdPerLot: Number(row?.usd_per_lot || 0),
      spreadPercentage: Number(row?.spread_percentage_per_lot || 0)
    };
  }

  return map;
}

async function syncTradesForAccount({ ibId, userId, accountId }) {
  try {
    const commissionMap = await buildCommissionMap(ibId);
    const to = new Date().toISOString();
    // Fetch a wider window to ensure we capture existing trades
    const from = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const apiUrl = `http://18.175.242.21:5003/api/client/ClientTradeHistory/trades?accountId=${accountId}&page=1&pageSize=1000&fromDate=${from}&toDate=${to}`;

    const response = await fetch(apiUrl, { headers: { accept: '*/*' } });
    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    const trades = data.Items || [];

    // Resolve group id for this account
    let groupId = null;
    try {
      const profRes = await fetch(`http://18.175.242.21:5003/api/Users/${accountId}/getClientProfile`, { headers: { accept: '*/*' } });
      if (profRes.ok) {
        const prof = await profRes.json();
        groupId = (prof?.Data || prof?.data)?.Group || null;
      }
    } catch {}

    await IBTradeHistory.upsertTrades(trades, {
      accountId,
      ibRequestId: ibId,
      userId,
      commissionMap,
      groupId
    });
    return true;
  } catch (error) {
    console.error(`Trade sync failed for account ${accountId}:`, error.message);
    return false;
  }
}

async function getAccountStats(ibId) {
  try {
    // First, get the email from the IB request
    const ibResult = await query('SELECT email FROM ib_requests WHERE id = $1', [ibId]);
    if (ibResult.rows.length === 0) {
      return { totalAccounts: 0, totalBalance: 0, totalEquity: 0 };
    }
    const email = ibResult.rows[0].email;

    // Get the User UUID from the User table
    const userResult = await query('SELECT id FROM "User" WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return { totalAccounts: 0, totalBalance: 0, totalEquity: 0 };
    }
    const userId = userResult.rows[0].id;

    // Step 1: Get all MT5 accounts from database first
    const result = await query(
      'SELECT "accountId" FROM "MT5Account" WHERE "userId" = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return {
        totalAccounts: 0,
        totalBalance: 0,
        totalEquity: 0
      };
    }

    console.log(`[Account Stats] Found ${result.rows.length} MT5 accounts for IB ${ibId}`);

    // Step 2: Fetch all account data in parallel
    const fetchPromises = result.rows.map(async (row) => {
      const accountId = row.accountId;
      
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000); // 15 second timeout
        
        const response = await fetch(
          `http://18.175.242.21:5003/api/Users/${accountId}/getClientProfile`,
          {
            headers: { 'accept': '*/*' },
            signal: controller.signal
          }
        );
        
        clearTimeout(timeout);

        if (response.ok) {
          const apiData = await response.json();
          if (apiData.Success && apiData.Data) {
            return {
              success: true,
              balance: Number(apiData.Data.Balance || 0),
              equity: Number(apiData.Data.Equity || 0)
            };
          }
        }
        return { success: false };
      } catch (error) {
        console.warn(`[Account Stats] Error fetching MT5 account ${accountId}:`, error.message);
        return { success: false };
      }
    });

    // Wait for all fetches to complete
    const results = await Promise.all(fetchPromises);
    
    // Calculate totals
    let totalBalance = 0;
    let totalEquity = 0;
    let successfulFetches = 0;

    results.forEach(result => {
      if (result.success) {
        totalBalance += result.balance;
        totalEquity += result.equity;
        successfulFetches++;
      }
    });

    console.log(`[Account Stats] Successfully fetched ${successfulFetches}/${result.rows.length} accounts`);

    return {
      totalAccounts: successfulFetches,
      totalBalance: totalBalance,
      totalEquity: totalEquity
    };
  } catch (error) {
    console.error('Error in getAccountStats:', error);
    return {
      totalAccounts: 0,
      totalBalance: 0,
      totalEquity: 0
    };
  }
}

async function getTradingAccounts(ibId) {
  try {
    // First, get the email from the IB request
    const ibResult = await query('SELECT email FROM ib_requests WHERE id = $1', [ibId]);
    if (ibResult.rows.length === 0) {
      return [];
    }
    const email = ibResult.rows[0].email;

    // Get the User UUID from the User table
    const userResult = await query('SELECT id FROM "User" WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return [];
    }
    const userId = userResult.rows[0].id;

    // Step 1: Get all MT5 accounts from database first
    const result = await query(
      'SELECT "accountId", leverage FROM "MT5Account" WHERE "userId" = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return [];
    }

    console.log(`[Trading Accounts] Found ${result.rows.length} MT5 accounts for IB ${ibId}`);

    // Step 2: Return accounts from database FIRST (don't wait for API)
    const tradingAccounts = result.rows.map(row => ({
      mtsId: row.accountId,
      accountId: row.accountId,
      balance: 0,
      equity: 0,
      group: 'Loading...',
      leverage: row.leverage || 1000,
      currency: 'USD',
      status: 1
    }));

    // Step 3: Optionally kick off background refresh but do not block response
    // This keeps the endpoint fast; the client will call account-stats for live values.
    (async () => {
      try {
        const fetchPromises = result.rows.map(async (row, index) => {
          const accountId = row.accountId;
          try {
            const response = await fetch(`http://18.175.242.21:5003/api/Users/${accountId}/getClientProfile`, { headers: { 'accept': '*/*' } });
            if (response.ok) {
              const apiData = await response.json();
              if (apiData.Success && apiData.Data) {
                const data = apiData.Data;
                let groupName = data.Group || 'Unknown';
                const match = groupName.match(/Bbook\\([^\\/]+)/i) || groupName.match(/Bbook\\\\([^\\/]+)/i);
                if (match && match[1]) {
                  groupName = match[1];
                } else if (groupName.includes('\\')) {
                  const parts = groupName.split('\\');
                  groupName = parts.length >= 3 ? parts[2] : parts[parts.length - 1];
                }
                tradingAccounts[index] = {
                  mtsId: data.Login || accountId,
                  accountId: data.Login || accountId,
                  balance: Number(data.Balance || 0),
                  equity: Number(data.Equity || 0),
                  group: groupName,
                  leverage: data.Leverage || row.leverage || 1000,
                  currency: 'USD',
                  status: data.IsEnabled ? 1 : 0
                };
              }
            }
          } catch {}
        });
        await Promise.allSettled(fetchPromises);
      } catch {}
    })();

    console.log(`[Trading Accounts] Returning ${tradingAccounts.length} accounts`);

    return tradingAccounts;
  } catch (error) {
    console.error('Error in getTradingAccounts:', error);
    return [];
  }
}

async function getTradeHistory(ibId) {
  try {
    // Get recent trades from ib_trade_history
    const tradesResult = await query(`
      SELECT * FROM ib_trade_history
      WHERE ib_request_id = $1
      ORDER BY synced_at DESC
      LIMIT 100
    `, [ibId]);

    return tradesResult.rows.map(trade => ({
      id: trade.id,
      dealId: trade.order_id,
      accountId: trade.account_id,
      symbol: trade.symbol,
      action: trade.order_type,
      volumeLots: Number(trade.volume_lots || 0),
      openPrice: Number(trade.open_price || 0),
      closePrice: Number(trade.close_price || 0),
      profit: Number(trade.profit || 0),
      ibCommission: Number(trade.ib_commission || 0),
      takeProfit: Number(trade.take_profit || 0),
      stopLoss: Number(trade.stop_loss || 0)
    }));
  } catch (error) {
    console.error('Error in getTradeHistory:', error);
    return [];
  }
}

async function getTreeStructure() {
  return {
    ownLots: 0,
    teamLots: 0,
    totalTrades: 0
  };
}

// Helper function to get IB groups and commission data (legacy mock)
async function getIBGroupsData(ibId) {
  try {
    // For now, return mock data - in real implementation, this would query actual group assignments
    return [
      {
        groupId: 1,
        groupName: 'Standard Group',
        structureName: 'Premium Structure',
        usdPerLot: 15.00,
        spreadSharePercentage: 50.00,
        totalCommission: 1250.75,
        totalLots: 83.38,
        totalVolume: 833800.00
      },
      {
        groupId: 2,
        groupName: 'VIP Group',
        structureName: 'VIP Structure',
        usdPerLot: 20.00,
        spreadSharePercentage: 60.00,
        totalCommission: 850.50,
        totalLots: 42.53,
        totalVolume: 425250.00
      },
      {
        groupId: 3,
        groupName: 'Professional Group',
        structureName: 'Pro Structure',
        usdPerLot: 18.00,
        spreadSharePercentage: 55.00,
        totalCommission: 675.25,
        totalLots: 37.51,
        totalVolume: 375125.00
      }
    ];
  } catch (error) {
    console.error('Error fetching IB groups data:', error);
    return [];
  }
}

// Create new commission structure for a group
router.post('/groups/*/commissions', authenticateAdminToken, async (req, res) => {
  try {
    const groupId = req.params[0]; // For wildcard
    const structureData = req.body;
    const newStructure = await GroupCommissionStructures.create(groupId, structureData);

    res.status(201).json({
      success: true,
      message: 'Commission structure created successfully',
      data: {
        structure: newStructure
      }
    });
  } catch (error) {
    console.error('Create commission structure error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to create commission structure'
    });
  }
});

// Update commission structure
router.patch('/commissions/:id', authenticateAdminToken, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const updatedStructure = await GroupCommissionStructures.update(id, updates);

    if (!updatedStructure) {
      return res.status(404).json({
        success: false,
        message: 'Commission structure not found'
      });
    }

    res.json({
      success: true,
      message: 'Commission structure updated successfully',
      data: {
        structure: updatedStructure
      }
    });
  } catch (error) {
    console.error('Update commission structure error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to update commission structure'
    });
  }
});

// Delete commission structure
router.delete('/commissions/:id', authenticateAdminToken, async (req, res) => {
  try {
    const { id } = req.params;

    const deletedStructure = await GroupCommissionStructures.delete(id);

    if (!deletedStructure) {
      return res.status(404).json({
        success: false,
        message: 'Commission structure not found'
      });
    }

    res.json({
      success: true,
      message: 'Commission structure deleted successfully'
    });
  } catch (error) {
    console.error('Delete commission structure error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to delete commission structure'
    });
  }
});

// Get all commission structures across all groups
router.get('/commission-structures', authenticateAdminToken, async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const result = await GroupCommissionStructures.getAllStructures(parseInt(page), parseInt(limit));

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Fetch all commission structures error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch commission structures'
    });
  }
});


export default router;
