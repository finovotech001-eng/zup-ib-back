 import express from 'express';
 import { IBRequest, IB_REQUEST_TYPE_VALUES, IB_REQUEST_STATUS_VALUES } from '../models/IBRequest.js';
 import { MT5Groups } from '../models/MT5Groups.js';
 import { GroupCommissionStructures } from '../models/GroupCommissionStructures.js';
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

        // TODO: Store additional groups data in a separate table for multiple group assignments
        // For now, we'll just use the first group for the main record

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
      usdPerLot: record.usd_per_lot,
      spreadPercentagePerLot: record.spread_percentage_per_lot,
      adminComments: record.admin_comments,
      totalClients: 0,
      totalVolume: 0,
      commission: record.usd_per_lot || 0,
      performance: 'new'
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
          admin_comments
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

    // Real group/structure enrichment if available on request
    let groups = [];
    if (record.group_id) {
      const groupRes = await query('SELECT group_id, name FROM mt5_groups WHERE group_id = $1', [record.group_id]);
      const structureRes = record.structure_id
        ? await query('SELECT id, structure_name, usd_per_lot, spread_share_percentage FROM group_commission_structures WHERE id = $1', [record.structure_id])
        : { rows: [] };
      const group = groupRes.rows[0];
      const structure = structureRes.rows[0];
      if (group) {
        groups.push({
          groupId: group.group_id,
          groupName: group.name || group.group_id,
          structureId: structure?.id || null,
          structureName: structure?.structure_name || null,
          usdPerLot: Number(record.usd_per_lot || structure?.usd_per_lot || 0),
          spreadSharePercentage: Number(record.spread_percentage_per_lot || structure?.spread_share_percentage || 0)
        });
      }
    }

    const profile = {
      id: record.id,
      fullName: record.full_name,
      email: record.email,
      ibType: record.ib_type,
      usdPerLot: record.usd_per_lot || 0,
      spreadPercentagePerLot: record.spread_percentage_per_lot || 0,
      approvedDate: record.approved_at,
      groups
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

// Helper function to get IB groups and commission data
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
