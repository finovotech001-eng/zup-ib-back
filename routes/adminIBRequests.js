 import express from 'express';
 import { IBRequest, IB_REQUEST_TYPE_VALUES, IB_REQUEST_STATUS_VALUES } from '../models/IBRequest.js';
 import { MT5Groups } from '../models/MT5Groups.js';
import { GroupCommissionStructures } from '../models/GroupCommissionStructures.js';
import { IBGroupAssignment } from '../models/IBGroupAssignment.js';
import { IBTradeHistory } from '../models/IBTradeHistory.js';
// import { IBLevelUpHistory } from '../models/IBLevelUpHistory.js'; // File removed
 import { authenticateAdminToken } from './adminAuth.js';
 import { query } from '../config/database.js';
import { IBCommission } from '../models/IBCommission.js';

const router = express.Router();
const ALLOWED_IB_TYPES = IB_REQUEST_TYPE_VALUES;

/**
 * Normalize group ID by extracting the last segment from path
 * Example: 'real\Bbook\Standard\dynamic-2000x-20Pips' -> 'dynamic-2000x-20pips'
 */
function normalizeGroupId(groupId) {
  if (!groupId) return '';
  const s = String(groupId).toLowerCase().trim();
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

/**
 * Find matching commission rule for a normalized group ID
 * Uses flexible matching: exact -> partial -> first available
 */
function findMatchingRule(normalizedGroupId, commissionGroupsMap) {
  if (!normalizedGroupId || !commissionGroupsMap || commissionGroupsMap.size === 0) {
    return null;
  }

  // Try exact match first
  let rule = commissionGroupsMap.get(normalizedGroupId);
  if (rule) return rule;

  // Try partial match (check if normalized key contains any approved key or vice versa)
  for (const [approvedKey, approvedRule] of commissionGroupsMap.entries()) {
    if (normalizedGroupId.includes(approvedKey) || approvedKey.includes(normalizedGroupId)) {
      return approvedRule;
    }
  }

  // Fallback to first available group assignment
  if (commissionGroupsMap.size > 0) {
    return Array.from(commissionGroupsMap.values())[0];
  }

  return null;
}

/**
 * Calculate commission from trades using commission structure
 * @param {Array} trades - Array of trade objects with { group_id, volume_lots }
 * @param {Map} commissionGroupsMap - Map of normalized group_id -> { usdPerLot, spreadPct }
 * @returns {Object} { fixed, spread, total, totalLots, totalTrades }
 */
function calculateCommissionFromTrades(trades, commissionGroupsMap) {
  let fixed = 0;
  let spread = 0;
  let totalLots = 0;
  let totalTrades = 0;

  if (!Array.isArray(trades) || trades.length === 0) {
    return { fixed: 0, spread: 0, total: 0, totalLots: 0, totalTrades: 0 };
  }

  for (const trade of trades) {
    const lots = Number(trade.volume_lots || 0);
    if (lots <= 0) continue;

    totalLots += lots;
    totalTrades += 1;

    // Match group to commission structure (flexible matching)
    const normalized = normalizeGroupId(trade.group_id);
    const rule = findMatchingRule(normalized, commissionGroupsMap);

    if (rule) {
      const usdPerLot = Number(rule.usdPerLot || 0);
      const spreadPct = Number(rule.spreadPct || 0);
      
      fixed += lots * usdPerLot;
      spread += lots * (spreadPct / 100);
    }
  }

  return {
    fixed,
    spread,
    total: fixed + spread,
    totalLots,
    totalTrades
  };
}


// Get all IB requests with pagination
router.get('/', authenticateAdminToken, async (req, res) => {
  try {
    const { status } = req.query;
    const page = Number.parseInt(req.query.page ?? '1', 10) || 1;
    const limit = Number.parseInt(req.query.limit ?? '50', 10) || 50;
    const offset = (page - 1) * limit;

    let requests;
    let countResult;
    
    // Query with LEFT JOIN to get referrer information
    if (status && status !== 'all') {
      const result = await query(
        `
          SELECT 
            ir.*,
            ref.full_name as referrer_name,
            ref.email as referrer_email,
            ref.referral_code as referrer_code
          FROM ib_requests ir
          LEFT JOIN ib_requests ref ON ir.referred_by = ref.id
          WHERE ir.status = $1 
          ORDER BY ir.submitted_at DESC 
          LIMIT $2 OFFSET $3
        `,
        [status, limit, offset]
      );
      
      // Fetch commission structure names for each request
      const requestsWithStructures = await Promise.all(
        result.rows.map(async (record) => {
          const stripped = IBRequest.stripSensitiveFields(record);
          
          // Get commission structure names from group assignments
          let commissionStructures = [];
          if (record.status === 'approved') {
            const assignments = await IBGroupAssignment.getByIbRequestId(record.id);
            commissionStructures = assignments
              .filter(a => a.structure_name)
              .map(a => a.structure_name);
          }
          
          return {
            ...stripped,
            referrer: record.referred_by ? {
              name: record.referrer_name,
              email: record.referrer_email,
              referralCode: record.referrer_code
            } : null,
            commissionStructures: commissionStructures.length > 0 ? commissionStructures : null
          };
        })
      );
      
      requests = requestsWithStructures;
      countResult = await query('SELECT COUNT(*) FROM ib_requests WHERE status = $1', [status]);
    } else {
      const result = await query(
        `
          SELECT 
            ir.*,
            ref.full_name as referrer_name,
            ref.email as referrer_email,
            ref.referral_code as referrer_code
          FROM ib_requests ir
          LEFT JOIN ib_requests ref ON ir.referred_by = ref.id
          ORDER BY ir.submitted_at DESC 
          LIMIT $1 OFFSET $2
        `,
        [limit, offset]
      );
      
      // Fetch commission structure names for each request
      const requestsWithStructures = await Promise.all(
        result.rows.map(async (record) => {
          const stripped = IBRequest.stripSensitiveFields(record);
          
          // Get commission structure names from group assignments
          let commissionStructures = [];
          if (record.status === 'approved') {
            const assignments = await IBGroupAssignment.getByIbRequestId(record.id);
            commissionStructures = assignments
              .filter(a => a.structure_name)
              .map(a => a.structure_name);
          }
          
          return {
            ...stripped,
            referrer: record.referred_by ? {
              name: record.referrer_name,
              email: record.referrer_email,
              referralCode: record.referrer_code
            } : null,
            commissionStructures: commissionStructures.length > 0 ? commissionStructures : null
          };
        })
      );
      
      requests = requestsWithStructures;
      countResult = await query('SELECT COUNT(*) FROM ib_requests');
    }

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
      const groupStructures = structures
        .filter(structure => structure.group_id === group.group_id)
        .map(structure => ({
          ...structure,
          // Ensure structure_name is available (handle both snake_case and camelCase)
          structure_name: structure.structure_name || structure.structureName,
          structureName: structure.structure_name || structure.structureName
        }));
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

  // Update referral code for an IB
  router.put('/:id/referral-code', authenticateAdminToken, async (req, res) => {
    try {
      const { id } = req.params;
      const { referralCode } = req.body;

      if (!referralCode || typeof referralCode !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'Referral code is required'
        });
      }

      const updatedRequest = await IBRequest.updateReferralCode(id, referralCode);

      if (!updatedRequest) {
        return res.status(404).json({
          success: false,
          message: 'IB request not found'
        });
      }

      res.json({
        success: true,
        message: 'Referral code updated successfully',
        data: {
          request: updatedRequest
        }
      });
    } catch (error) {
      console.error('Update referral code error:', error);
      res.status(400).json({
        success: false,
        message: error.message || 'Unable to update referral code',
        error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined
      });
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
      // Only validate ibType if it's provided and we're not using commission structures
      // When groups are provided, we'll use commission structure names instead
      if (typeof ibType === 'string' && ibType.trim() && !groups) {
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
        
        // Extract commission structure names from all groups for ib_type
        // First, try to get structure names from the groups data
        let structureNames = groups
          .map(g => g.structureName)
          .filter(name => name && name !== 'Custom');
        
        // If structure names are missing, fetch them from database
        if (structureNames.length === 0 || structureNames.some(n => !n)) {
          const structureNamesPromises = groups.map(async (group) => {
            if (group.structureId) {
              try {
                const structureResult = await query(
                  'SELECT structure_name FROM group_commission_structures WHERE id = $1',
                  [group.structureId]
                );
                if (structureResult.rows.length > 0) {
                  return structureResult.rows[0].structure_name;
                }
              } catch (error) {
                console.error(`Error fetching structure name for structureId ${group.structureId}:`, error);
              }
            }
            return group.structureName;
          });
          
          structureNames = await Promise.all(structureNamesPromises);
          structureNames = structureNames.filter(name => name && name !== 'Custom');
        }
        
        // Use commission structure names for ib_type, or fallback to normalizedIbType
        // Note: finalIbType can be a comma-separated string like "Gold, Classic"
        // This is allowed even though it's not in ALLOWED_IB_TYPES - it's the actual structure names
        // If no structure names found, use null instead of 'common' to allow NULL in database
        const finalIbType = structureNames.length > 0 
          ? structureNames.join(', ') 
          : (normalizedIbType || null);
        
        console.log(`[APPROVE] Setting ib_type to: "${finalIbType}" for IB ${id}`);
        
        const updatedRequest = await IBRequest.updateStatus(
          id,
          status,
          adminComments,
          firstGroup.usdPerLot,
          firstGroup.spreadSharePercentage,
          finalIbType, // This can be "Gold, Classic" or any structure name(s)
          firstGroup.groupId,
          structureId
        );

        if (!updatedRequest) {
          return res.status(404).json({
            success: false,
            message: 'IB request not found'
          });
        }

        // Save group assignments with structure names
        const assignments = groups.map((group) => {
          // If structureName is not provided, fetch it from the database using structureId
          let structureName = group.structureName;
          
          // If structureName is missing or 'Custom', try to fetch from database
          if ((!structureName || structureName === 'Custom') && group.structureId) {
            // This will be handled async, but for now we'll use what's provided
            // The frontend should always send the structure name
          }
          
          console.log(`[APPROVE] Saving assignment for IB ${id}:`, {
            groupId: group.groupId,
            groupName: group.groupName,
            structureId: group.structureId,
            structureName: group.structureName,
            usdPerLot: group.usdPerLot,
            spreadSharePercentage: group.spreadSharePercentage
          });
          
          return {
            groupId: group.groupId,
            groupName: group.groupName,
            structureId: group.structureId,
            structureName: group.structureName || null, // Save null if not provided, we'll fetch it
            usdPerLot: group.usdPerLot,
            spreadSharePercentage: group.spreadSharePercentage
          };
        });
        
        await IBGroupAssignment.replaceAssignments(id, assignments);
        
        // If any assignments are missing structure names, fetch and update them
        const assignmentsToUpdate = await Promise.all(
          assignments.map(async (assignment) => {
            if (!assignment.structureName && assignment.structureId) {
              try {
                const structureResult = await query(
                  'SELECT structure_name FROM group_commission_structures WHERE id = $1',
                  [assignment.structureId]
                );
                if (structureResult.rows.length > 0) {
                  return {
                    ...assignment,
                    structureName: structureResult.rows[0].structure_name
                  };
                }
              } catch (error) {
                console.error(`Error fetching structure name for structureId ${assignment.structureId}:`, error);
              }
            }
            return assignment;
          })
        );
        
        // If any were updated, save again
        const needsUpdate = assignmentsToUpdate.some((a, idx) => a.structureName !== assignments[idx].structureName);
        if (needsUpdate) {
          await IBGroupAssignment.replaceAssignments(id, assignmentsToUpdate);
          
          // Also update ib_type in ib_requests if structure names were fetched
          const updatedStructureNames = assignmentsToUpdate
            .map(a => a.structureName)
            .filter(name => name);
          
          if (updatedStructureNames.length > 0) {
            const finalIbType = updatedStructureNames.join(', ');
            await query(
              'UPDATE ib_requests SET ib_type = $1 WHERE id = $2',
              [finalIbType, id]
            );
            console.log(`[APPROVE] Updated ib_type to: ${finalIbType} for IB ${id}`);
          }
        }

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
      console.error('Error stack:', error.stack);
      res.status(500).json({
        success: false,
        message: 'Unable to update IB request status',
        error: process.env.NODE_ENV !== 'production' ? (error?.message || String(error)) : undefined,
        details: process.env.NODE_ENV !== 'production' ? {
          stack: error?.stack,
          name: error?.name
        } : undefined
      });
    }
  });

// Update commission structures for an approved IB
router.put('/:id/commission-structures', authenticateAdminToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { groups } = req.body;

    // Check if IB is approved
    const ibCheck = await query('SELECT id, status FROM ib_requests WHERE id = $1', [id]);
    if (ibCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'IB request not found'
      });
    }

    if (ibCheck.rows[0].status !== 'approved') {
      return res.status(400).json({
        success: false,
        message: 'Commission structures can only be updated for approved IBs'
      });
    }

    // Validate groups data
    if (!groups || !Array.isArray(groups) || groups.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one group must be selected'
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

    // Extract commission structure names
    let structureNames = groups
      .map(g => g.structureName)
      .filter(name => name && name !== 'Custom');

    // If structure names are missing, fetch them from database
    if (structureNames.length === 0 || structureNames.some(n => !n)) {
      const structureNamesPromises = groups.map(async (group) => {
        if (group.structureId) {
          try {
            const structureResult = await query(
              'SELECT structure_name FROM group_commission_structures WHERE id = $1',
              [group.structureId]
            );
            if (structureResult.rows.length > 0) {
              return structureResult.rows[0].structure_name;
            }
          } catch (error) {
            console.error(`Error fetching structure name for structureId ${group.structureId}:`, error);
          }
        }
        return group.structureName;
      });

      structureNames = await Promise.all(structureNamesPromises);
      structureNames = structureNames.filter(name => name && name !== 'Custom');
    }

    // Update ib_type with commission structure names
    const finalIbType = structureNames.length > 0 
      ? structureNames.join(', ') 
      : null;

    if (finalIbType) {
      await query('UPDATE ib_requests SET ib_type = $1 WHERE id = $2', [finalIbType, id]);
      console.log(`[UPDATE COMMISSION] Updated ib_type to: "${finalIbType}" for IB ${id}`);
    }

    // Save group assignments with structure names
    const assignments = groups.map((group) => {
      return {
        groupId: group.groupId,
        groupName: group.groupName,
        structureId: group.structureId,
        structureName: group.structureName || null,
        usdPerLot: group.usdPerLot,
        spreadSharePercentage: group.spreadSharePercentage
      };
    });

    await IBGroupAssignment.replaceAssignments(id, assignments);

    // If any assignments are missing structure names, fetch and update them
    const assignmentsToUpdate = await Promise.all(
      assignments.map(async (assignment) => {
        if (!assignment.structureName && assignment.structureId) {
          try {
            const structureResult = await query(
              'SELECT structure_name FROM group_commission_structures WHERE id = $1',
              [assignment.structureId]
            );
            if (structureResult.rows.length > 0) {
              return {
                ...assignment,
                structureName: structureResult.rows[0].structure_name
              };
            }
          } catch (error) {
            console.error(`Error fetching structure name for structureId ${assignment.structureId}:`, error);
          }
        }
        return assignment;
      })
    );

    // If any were updated, save again
    const needsUpdate = assignmentsToUpdate.some((a, idx) => a.structureName !== assignments[idx].structureName);
    if (needsUpdate) {
      await IBGroupAssignment.replaceAssignments(id, assignmentsToUpdate);

      // Also update ib_type if structure names were fetched
      const updatedStructureNames = assignmentsToUpdate
        .map(a => a.structureName)
        .filter(name => name);

      if (updatedStructureNames.length > 0) {
        const finalIbType = updatedStructureNames.join(', ');
        await query('UPDATE ib_requests SET ib_type = $1 WHERE id = $2', [finalIbType, id]);
        console.log(`[UPDATE COMMISSION] Updated ib_type to: ${finalIbType} for IB ${id}`);
      }
    }

    // Get updated profile
    const updatedRequest = await IBRequest.findById(id);

    res.json({
      success: true,
      message: `Commission structures updated successfully for ${groups.length} group${groups.length !== 1 ? 's' : ''}`,
      data: {
        request: IBRequest.stripSensitiveFields(updatedRequest)
      }
    });
  } catch (error) {
    console.error('Update commission structures error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Unable to update commission structures',
      error: process.env.NODE_ENV !== 'production' ? (error?.message || String(error)) : undefined
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
    // Ensure numeric id for robust parameter typing across PG
    const { id: rawId } = req.params;
    const id = Number.parseInt(String(rawId), 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'Invalid IB profile id' });
    }

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
          structure_id,
          referral_code
        FROM ib_requests
        WHERE id = $1::int
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'IB profile not found'
      });
    }

    const record = result.rows[0];
    // Make all expensive fetches resilient so a single failure doesn't 500 the page
    let phone = null; let groups = []; let acctStats = null; let tradingAccounts = []; let tradeHistory = []; let treeStructure = null; let levelUpHistory = [];
    try { phone = await getUserPhone(record.email); } catch (e) { console.warn('getUserPhone error:', e.message); }
    try { groups = await getGroupAssignments(record); } catch (e) { console.warn('getGroupAssignments error:', e.message); groups = []; }

    // Level-up history removed in this build
    levelUpHistory = [];

    // Get commission structure names from groups
    const commissionStructures = groups
      .filter(g => g.structureName)
      .map(g => g.structureName);

    // Fetch additional sections defensively
    try { acctStats = await getAccountStats(record.id); } catch (e) { console.warn('getAccountStats error:', e.message); acctStats = { totalAccounts: 0, totalBalance: 0, totalEquity: 0 }; }
    try { tradingAccounts = await getTradingAccounts(record.id); } catch (e) { console.warn('getTradingAccounts error:', e.message); tradingAccounts = []; }
    try { tradeHistory = await getTradeHistory(record.id); } catch (e) { console.warn('getTradeHistory error:', e.message); tradeHistory = []; }
    try { treeStructure = await getTreeStructure(record.id); } catch (e) { console.warn('getTreeStructure error:', e.message); treeStructure = { ownLots: 0, teamLots: 0, totalTrades: 0, root: null }; }

    const profile = {
      id: record.id,
      status: record.status,
      fullName: record.full_name,
      email: record.email,
      phone,
      ibType: commissionStructures.length > 0 ? commissionStructures.join(', ') : (record.ib_type || 'Common'),
      commissionStructures: commissionStructures.length > 0 ? commissionStructures : null,
      usdPerLot: Number(record.usd_per_lot || 0),
      spreadPercentagePerLot: Number(record.spread_percentage_per_lot || 0),
      approvedDate: record.approved_at,
      adminComments: record.admin_comments,
      referralCode: record.referral_code,
      groups,
      accountStats: acctStats,
      tradingAccounts,
      tradeHistory,
      treeStructure,
      levelUpHistory: levelUpHistory.map(h => ({
        id: h.id,
        fromStructure: h.from_structure_name,
        toStructure: h.to_structure_name,
        tradingVolume: Number(h.trading_volume_at_upgrade || 0),
        activeClients: h.active_clients_at_upgrade,
        upgradedAt: h.upgraded_at
      }))
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

// Get referred users for an IB
router.get('/profiles/:id/referred-users', authenticateAdminToken, async (req, res) => {
  try {
    const { id: rawId } = req.params;
    const id = Number.parseInt(String(rawId), 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'Invalid IB profile id' });
    }

    // Get users from ib_referrals
    const refRes = await query(
      `SELECT r.id as ref_id, r.user_id, r.email, r.created_at as join_date, r.source
       FROM ib_referrals r
       WHERE r.ib_request_id = $1
       ORDER BY r.created_at DESC`,
      [id]
    );

    // Get users from ib_requests where referred_by = id
    const ibRefRes = await query(
      `SELECT ir.id as ib_id, u.id as user_id, ir.email, ir.full_name, ir.submitted_at as join_date, 
              ir.status, ir.ib_type, 'ib_request' as source
       FROM ib_requests ir
       JOIN "User" u ON u.email = ir.email
       WHERE ir.referred_by = $1 AND u.id IS NOT NULL
       ORDER BY ir.submitted_at DESC`,
      [id]
    );

    // Combine and deduplicate by user_id
    const userMap = new Map();
    
    // Add ib_referrals users
    for (const row of refRes.rows) {
      const userId = row.user_id ? String(row.user_id) : null;
      if (userId && !userMap.has(userId)) {
        userMap.set(userId, {
          userId,
          email: row.email,
          name: null,
          joinDate: row.join_date,
          source: row.source || 'crm',
          status: 'active',
          ibType: null
        });
      }
    }

    // Add ib_requests users (may override if duplicate)
    for (const row of ibRefRes.rows) {
      const userId = row.user_id ? String(row.user_id) : null;
      if (userId) {
        userMap.set(userId, {
          userId,
          email: row.email,
          name: row.full_name,
          joinDate: row.submitted_at,
          source: 'ib_request',
          status: row.status,
          ibType: row.ib_type
        });
      }
    }

    // Get stats for each user
    const usersWithStats = await Promise.all(
      Array.from(userMap.values()).map(async (user) => {
        // Count MT5 accounts
        let accountCount = 0;
        try {
          const accRes = await query(
            'SELECT COUNT(*)::int AS cnt FROM "MT5Account" WHERE "userId" = $1',
            [user.userId]
          );
          accountCount = Number(accRes.rows[0]?.cnt || 0);
        } catch {}

        // Get trading stats from ib_trade_history (only closed trades - deals out)
        // Only count trades with profit != 0 (closed trades) to match trade history display
        let totalVolume = 0;
        let totalCommission = 0;
        let tradeCount = 0;
        try {
          // Get trades for this user
          const tradesRes = await query(
            `SELECT group_id, volume_lots
             FROM ib_trade_history
             WHERE ib_request_id = $1 
               AND user_id = $2
               AND close_price IS NOT NULL 
               AND close_price != 0 
               AND profit != 0`,
            [id, user.userId]
          );

          if (tradesRes.rows.length > 0) {
            // Calculate commission using commission structure
            const commissionResult = calculateCommissionFromTrades(tradesRes.rows, commissionGroupsMap);
            totalVolume = commissionResult.totalLots;
            totalCommission = commissionResult.total;
            tradeCount = commissionResult.totalTrades;
          }
        } catch (error) {
          console.error(`Error calculating commission for user ${user.userId}:`, error);
        }

        // Determine if active (has trades or accounts)
        const isActive = accountCount > 0 || tradeCount > 0;

        return {
          ...user,
          accountCount,
          totalVolume,
          totalCommission,
          tradeCount,
          isActive
        };
      })
    );

    res.json({
      success: true,
      data: {
        users: usersWithStats,
        total: usersWithStats.length
      }
    });
  } catch (error) {
    console.error('Error fetching referred users:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch referred users'
    });
  }
});

// Get MT5 accounts for a specific user under an IB
router.get('/profiles/:ibId/user/:userId/accounts', authenticateAdminToken, async (req, res) => {
  try {
    const { ibId: rawIbId, userId } = req.params;
    const ibId = Number.parseInt(String(rawIbId), 10);
    if (!Number.isFinite(ibId) || !userId) {
      return res.status(400).json({ success: false, message: 'Invalid parameters' });
    }

    // Verify user is referred by this IB
    const verifyRes = await query(
      `SELECT 1 FROM ib_referrals WHERE ib_request_id = $1 AND user_id = $2
       UNION
       SELECT 1 FROM ib_requests ir 
       JOIN "User" u ON u.email = ir.email 
       WHERE ir.referred_by = $1 AND u.id::text = $2`,
      [ibId, String(userId)]
    );

    if (verifyRes.rows.length === 0) {
      return res.status(403).json({ success: false, message: 'User is not referred by this IB' });
    }

    // Get all MT5 accounts for this user
    const accountsResult = await query(
      'SELECT "accountId" FROM "MT5Account" WHERE "userId" = $1',
      [userId]
    );

    // Fetch account details from MT5 API
    const fetchAccount = async (accountId) => {
      try {
        // Fetch balance, equity, profit from getClientBalance API
        let balance = 0;
        let equity = 0;
        let profit = 0;
        let margin = 0;
        let marginFree = 0;

        try {
          const balanceController = new AbortController();
          const balanceTimeout = setTimeout(() => balanceController.abort(), 5000);
          const balanceResponse = await fetch(
            `http://18.175.242.21:5003/api/Users/${accountId}/getClientBalance`,
            { headers: { accept: '*/*' }, signal: balanceController.signal }
          );
          clearTimeout(balanceTimeout);

          if (balanceResponse.ok) {
            const balanceData = await balanceResponse.json();
            console.log(`[User Accounts] Balance API response for ${accountId}:`, JSON.stringify(balanceData).substring(0, 400));
            // Response structure: { Success: true, Data: { Balance, Equity, Profit, Margin, MarginFree, ... } }
            const dataObj = balanceData?.Data || balanceData?.data || balanceData;
            if (dataObj) {
              // Try multiple possible field name variations
              balance = Number(dataObj.Balance ?? dataObj.balance ?? 0);
              equity = Number(dataObj.Equity ?? dataObj.equity ?? 0);
              profit = Number(dataObj.Profit ?? dataObj.profit ?? dataObj.Floating ?? dataObj.floating ?? 0);
              margin = Number(dataObj.Margin ?? dataObj.margin ?? 0);
              marginFree = Number(dataObj.MarginFree ?? dataObj.marginFree ?? dataObj.MarginFree ?? 0);
              console.log(`[User Accounts] Parsed values for ${accountId}: balance=${balance}, equity=${equity}, profit=${profit}, margin=${margin}`);
              console.log(`[User Accounts] Raw data keys:`, Object.keys(dataObj));
            } else {
              console.warn(`[User Accounts] No Data object found in response for ${accountId}:`, balanceData);
            }
          } else {
            console.warn(`[User Accounts] Balance API returned status ${balanceResponse.status} for ${accountId}`);
          }
        } catch (error) {
          console.error(`[User Accounts] Error fetching balance for account ${accountId}:`, error.message);
        }

        // Fetch profile for group name and demo check
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        const response = await fetch(
          `http://18.175.242.21:5003/api/Users/${accountId}/getClientProfile`,
          { headers: { accept: '*/*' }, signal: controller.signal }
        );
        clearTimeout(timeout);

        if (!response.ok) return null;
        const data = await response.json();
        const payload = data?.Data || data?.data;
        if (!payload) return null;

        const accountType = payload?.AccountType ?? payload?.accountType ?? payload?.AccountTypeText ?? payload?.accountTypeText ?? null;
        const groupIdFull = payload?.Group || payload?.group || '';
        const isDemo = 
          (accountType && String(accountType).toLowerCase().includes('demo')) ||
          (groupIdFull && String(groupIdFull).toLowerCase().includes('demo'));

        let groupName = payload?.Group ?? payload?.group ?? payload?.GroupName ?? payload?.group_name ?? 'Unknown';
        if (typeof groupName === 'string') {
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

        // Get commission groups for this IB
        const commissionGroupsRes = await query(
          `SELECT group_id, structure_name, usd_per_lot, spread_share_percentage
           FROM ib_group_assignments
           WHERE ib_request_id = $1`,
          [ibId]
        );

        // Build commission groups map
        const commissionGroupsMap = new Map();
        for (const r of commissionGroupsRes.rows) {
          const k = normalizeGroupId(r.group_id);
          if (k) {
            commissionGroupsMap.set(k, {
              spreadPct: Number(r.spread_share_percentage || 0),
              usdPerLot: Number(r.usd_per_lot || 0),
              structureName: r.structure_name
            });
          }
        }

        // Find matching commission structure for this account's group
        const normalizedGroup = normalizeGroupId(groupIdFull);
        const matchingRule = findMatchingRule(normalizedGroup, commissionGroupsMap);
        const commissionInfo = matchingRule || {};

        // Get trades for this account - only closed trades (deals out) with profit != 0
        const tradesRes = await query(
          `SELECT group_id, volume_lots, profit
           FROM ib_trade_history
           WHERE ib_request_id = $1 
             AND account_id = $2
             AND close_price IS NOT NULL 
             AND close_price != 0 
             AND profit != 0`,
          [ibId, String(accountId)]
        );

        // Calculate commission using commission structure
        const commissionResult = calculateCommissionFromTrades(tradesRes.rows, commissionGroupsMap);
        
        // Calculate total profit from trades
        const totalProfit = tradesRes.rows.reduce((sum, row) => sum + Number(row.profit || 0), 0);
        
        // If profit from API is 0, use profit from trade history
        const finalProfit = profit !== 0 ? profit : totalProfit;
        
        // If margin is 0, calculate from equity and balance (margin = balance - equity + profit, or use marginFree)
        const finalMargin = margin !== 0 ? margin : (balance - equity + finalProfit);

        return {
          accountId,
          balance: balance, // From getClientBalance API
          equity: equity, // From getClientBalance API
          margin: finalMargin, // From getClientBalance API or calculated
          profit: finalProfit, // From getClientBalance API or trade history
          marginFree: marginFree, // From getClientBalance API
          group: groupName,
          groupId: groupIdFull,
          accountType: accountType || (isDemo ? 'Demo' : 'Live'),
          isDemo,
          isEligibleForCommission: matchingRule !== null,
          commissionStructure: commissionInfo.structureName || null,
          usdPerLot: Number(commissionInfo.usdPerLot || 0),
          spreadSharePercentage: Number(commissionInfo.spreadPct || 0),
          totalVolume: commissionResult.totalLots,
          totalCommission: commissionResult.total,
          tradeCount: commissionResult.totalTrades
        };
      } catch (error) {
        console.error(`Error fetching account ${accountId}:`, error);
        return null;
      }
    };

    const accounts = await Promise.all(
      accountsResult.rows.map(r => fetchAccount(r.accountId))
    );

    const validAccounts = accounts.filter(acc => acc !== null && !acc.isDemo);

    res.json({
      success: true,
      data: {
        accounts: validAccounts,
        total: validAccounts.length
      }
    });
  } catch (error) {
    console.error('Error fetching user accounts:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch user accounts'
    });
  }
});

// Get all MT5 accounts from referred users (for client accounts table)
router.get('/profiles/:id/all-accounts', authenticateAdminToken, async (req, res) => {
  try {
    const { id: rawId } = req.params;
    const id = Number.parseInt(String(rawId), 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'Invalid IB profile id' });
    }

    // Get referred user_ids
    const referredUserIds = [];
    const userMap = new Map(); // userId -> { email, name, joinDate, partnerCode, country }

    // From ib_referrals
    let refRes;
    try {
      refRes = await query(
        `SELECT r.user_id, r.email, r.created_at as join_date, r.referral_code as partner_code,
                COALESCE(u.country, u.country_code, u.nationality, '-') as country
         FROM ib_referrals r
         LEFT JOIN "User" u ON u.id::text = r.user_id
         WHERE r.ib_request_id = $1 AND r.user_id IS NOT NULL`,
        [id]
      );
    } catch (err) {
      // If COALESCE fails due to missing columns, try without it
      console.warn('Error with COALESCE, trying simpler query:', err.message);
      refRes = await query(
        `SELECT r.user_id, r.email, r.created_at as join_date, r.referral_code as partner_code,
                '-' as country
         FROM ib_referrals r
         WHERE r.ib_request_id = $1 AND r.user_id IS NOT NULL`,
        [id]
      );
    }
    for (const row of refRes.rows) {
      const userId = String(row.user_id);
      if (!userMap.has(userId)) {
        referredUserIds.push(userId);
        userMap.set(userId, {
          email: row.email,
          name: null,
          joinDate: row.join_date,
          partnerCode: row.partner_code || '-',
          country: row.country || '-'
        });
      }
    }

    // From ib_requests where referred_by = id
    let ibRefRes;
    try {
      ibRefRes = await query(
        `SELECT u.id as user_id, ir.email, ir.full_name, ir.submitted_at as join_date, 
                ir.referral_code as partner_code, 
                COALESCE(u.country, u.country_code, u.nationality, '-') as country
         FROM ib_requests ir
         JOIN "User" u ON u.email = ir.email
         WHERE ir.referred_by = $1 AND u.id IS NOT NULL`,
        [id]
      );
    } catch (err) {
      // If COALESCE fails due to missing columns, try without it
      console.warn('Error with COALESCE in ib_requests query, trying simpler query:', err.message);
      ibRefRes = await query(
        `SELECT u.id as user_id, ir.email, ir.full_name, ir.submitted_at as join_date, 
                ir.referral_code as partner_code, 
                '-' as country
         FROM ib_requests ir
         JOIN "User" u ON u.email = ir.email
         WHERE ir.referred_by = $1 AND u.id IS NOT NULL`,
        [id]
      );
    }
    for (const row of ibRefRes.rows) {
      const userId = String(row.user_id);
      if (!userMap.has(userId)) {
        referredUserIds.push(userId);
      }
      userMap.set(userId, {
        email: row.email,
        name: row.full_name,
        joinDate: row.submitted_at,
        partnerCode: row.partner_code || '-',
        country: row.country || '-'
      });
    }

    if (referredUserIds.length === 0) {
      return res.json({
        success: true,
        data: {
          accounts: [],
          total: 0
        }
      });
    }

    // Get all MT5 accounts for referred users
    const accountsRes = await query(
      `SELECT "accountId", "userId" 
       FROM "MT5Account" 
       WHERE "userId" = ANY($1::text[])`,
      [referredUserIds]
    );

    console.log(`[All Accounts] Found ${accountsRes.rows.length} MT5 accounts for ${referredUserIds.length} referred users`);
    console.log(`[All Accounts] Referred user IDs:`, referredUserIds);
    console.log(`[All Accounts] Sample account rows:`, accountsRes.rows.slice(0, 3));

    if (accountsRes.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          accounts: [],
          total: 0
        }
      });
    }

    // Get trading stats for all accounts first (faster, doesn't require API)
    // Only count trades from referred users, excluding IB's own trades
    const statsMap = new Map();
    const accountIds = accountsRes.rows.map(r => String(r.accountId));
    
    // Get IB's own user_id to exclude
    const getIBUserId = async (ibId) => {
      try {
        const ibRes = await query('SELECT email FROM ib_requests WHERE id = $1', [ibId]);
        if (ibRes.rows.length === 0) return null;
        const userRes = await query('SELECT id FROM "User" WHERE email = $1', [ibRes.rows[0].email]);
        return userRes.rows.length > 0 ? String(userRes.rows[0].id) : null;
      } catch {
        return null;
      }
    };

    const ibUserId = await getIBUserId(id);
    
    if (accountIds.length > 0) {
      // Build WHERE clause to exclude IB's own trades and only include referred users' trades
      let userFilter = '';
      const params = [id, accountIds];
      if (ibUserId) {
        params.push(ibUserId);
        userFilter = `AND user_id != $${params.length}`;
      }
      params.push(referredUserIds);
      const userInClause = `AND user_id = ANY($${params.length}::text[])`;

      const statsRes = await query(
        `SELECT 
           account_id,
           COALESCE(SUM(profit), 0) AS total_profit,
           COALESCE(SUM(volume_lots), 0) AS total_volume_lots,
           MAX(synced_at) AS last_trading_date
         FROM ib_trade_history
         WHERE ib_request_id = $1 
           AND account_id = ANY($2::text[])
           AND close_price IS NOT NULL 
           AND close_price != 0 
           AND profit != 0
           ${userFilter}
           ${userInClause}
         GROUP BY account_id`,
        params
      );

      console.log(`[All Accounts] Query returned ${statsRes.rows.length} account stats`);
      console.log(`[All Accounts] Account IDs being queried:`, accountIds.slice(0, 5));
      console.log(`[All Accounts] Referred user IDs:`, referredUserIds);
      console.log(`[All Accounts] IB user ID (to exclude):`, ibUserId);
      
      for (const row of statsRes.rows) {
        const accountIdStr = String(row.account_id);
        const volumeLots = Number(row.total_volume_lots || 0);
        statsMap.set(accountIdStr, {
          totalProfit: Number(row.total_profit || 0),
          totalVolumeLots: volumeLots,
          lastTradingDate: row.last_trading_date || null
        });
        console.log(`[All Accounts] Stats for account ${accountIdStr}: volumeLots=${volumeLots}, profit=${Number(row.total_profit || 0)}`);
      }
      
      // Log accounts that didn't get stats
      const accountsWithoutStats = accountIds.filter(accId => !statsMap.has(accId));
      if (accountsWithoutStats.length > 0) {
        console.log(`[All Accounts] WARNING: ${accountsWithoutStats.length} accounts have no stats:`, accountsWithoutStats.slice(0, 5));
      }
    }

    // Fetch account details from MT5 API (optional, for group name and demo check)
    const allAccounts = await Promise.all(
      accountsRes.rows.map(async (row) => {
        const accountId = row.accountId;
        const userId = String(row.userId);
        const userInfo = userMap.get(userId) || { email: '-', name: null, joinDate: null, partnerCode: '-', country: '-' };

        // Get trading stats (already computed)
        const stats = statsMap.get(String(accountId)) || {
          totalProfit: 0,
          totalVolumeLots: 0,
          lastTradingDate: null
        };

        const totalProfitFromHistory = stats.totalProfit;
        const totalVolumeLots = Number(stats.totalVolumeLots || 0);
        // Convert lots to millions USD: 1 lot = 100,000 USD, so lots * 0.1 = millions USD
        const totalVolumeMlnUSD = totalVolumeLots * 0.1;
        const lastTradingDate = stats.lastTradingDate;
        
        console.log(`[All Accounts] Account ${accountId}: volumeLots=${totalVolumeLots}, volumeMlnUSD=${totalVolumeMlnUSD}`);

        // Fetch balance, equity, and profit from MT5 API
        let balance = 0;
        let equity = 0;
        let profit = 0;
        let groupName = 'Standard';
        let isDemo = false;

        try {
          // Fetch balance data from getClientBalance API
          const balanceController = new AbortController();
          const balanceTimeout = setTimeout(() => balanceController.abort(), 5000);
          const balanceResponse = await fetch(
            `http://18.175.242.21:5003/api/Users/${accountId}/getClientBalance`,
            { headers: { accept: '*/*' }, signal: balanceController.signal }
          );
          clearTimeout(balanceTimeout);

          if (balanceResponse.ok) {
            const balanceData = await balanceResponse.json();
            console.log(`[All Accounts] Balance API response for ${accountId}:`, JSON.stringify(balanceData).substring(0, 400));
            // Response structure: { Success: true, Data: { Balance, Equity, Profit, Margin, ... } }
            const dataObj = balanceData?.Data || balanceData?.data || balanceData;
            if (dataObj) {
              // Try multiple possible field name variations
              balance = Number(dataObj.Balance ?? dataObj.balance ?? 0);
              equity = Number(dataObj.Equity ?? dataObj.equity ?? 0);
              profit = Number(dataObj.Profit ?? dataObj.profit ?? dataObj.Floating ?? dataObj.floating ?? 0);
              console.log(`[All Accounts] Parsed for ${accountId}: balance=${balance}, equity=${equity}, profit=${profit}`);
              console.log(`[All Accounts] Raw data keys:`, Object.keys(dataObj));
            } else {
              console.warn(`[All Accounts] No Data object found in response for ${accountId}:`, balanceData);
            }
          } else {
            console.warn(`[All Accounts] Balance API returned status ${balanceResponse.status} for ${accountId}`);
          }
        } catch (error) {
          console.error(`[All Accounts] Error fetching balance for ${accountId}:`, error.message, error.stack);
        }

        // Try to fetch account profile from MT5 API (optional, for group name and demo check)
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          const response = await fetch(
            `http://18.175.242.21:5003/api/Users/${accountId}/getClientProfile`,
            { headers: { accept: '*/*' }, signal: controller.signal }
          );
          clearTimeout(timeout);

          if (response.ok) {
            const data = await response.json();
            const payload = data?.Data || data?.data;
            if (payload) {
              // Check if demo account
              const accountType = payload?.AccountType ?? payload?.accountType ?? payload?.AccountTypeText ?? payload?.accountTypeText ?? null;
              const groupIdFull = payload?.Group || payload?.group || '';
              isDemo = 
                (accountType && String(accountType).toLowerCase().includes('demo')) ||
                (groupIdFull && String(groupIdFull).toLowerCase().includes('demo'));

              // Extract group name
              if (groupIdFull) {
                groupName = groupIdFull;
                if (typeof groupName === 'string') {
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
              }
            }
          }
        } catch (error) {
          // Continue with default values if API fails
          console.warn(`Could not fetch MT5 profile for account ${accountId}, using defaults`);
        }

        // If profit from API is 0, use profit from trade history
        const finalProfit = profit !== 0 ? profit : Number(totalProfitFromHistory || 0);
        
        // Include ALL accounts, even if API fails or if we can't determine if it's demo
        // The frontend can filter if needed, but we show all accounts from referred users
        return {
          clientAccount: String(accountId), // Ensure it's a string for display
          profit: finalProfit, // Use profit from getClientBalance API or trade history
          balance: balance, // Balance from getClientBalance API
          equity: equity, // Equity from getClientBalance API
          totalProfit: totalProfitFromHistory, // Total profit from trade history (for commission calculation)
          volumeLots: totalVolumeLots,
          volumeMlnUSD: totalVolumeMlnUSD,
          clientId: userId,
          partnerCode: userInfo.partnerCode,
          comment: '-',
          signupDate: userInfo.joinDate,
          lastTradingDate: lastTradingDate,
          country: userInfo.country,
          accountType: groupName || 'Standard',
          userEmail: userInfo.email,
          userName: userInfo.name || userInfo.email,
          isDemo: isDemo
        };
      })
    );

    // Include all accounts (don't filter out nulls or demos - show everything)
    const validAccounts = allAccounts.filter(acc => acc !== null);

    console.log(`[All Accounts] Returning ${validAccounts.length} valid accounts`);
    if (validAccounts.length > 0) {
      console.log(`[All Accounts] Sample account:`, validAccounts[0]);
    }

    res.json({
      success: true,
      data: {
        accounts: validAccounts,
        total: validAccounts.length
      }
    });
  } catch (error) {
    console.error('Error fetching all accounts:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch accounts',
      error: process.env.NODE_ENV !== 'production' ? error.message : undefined
    });
  }
});

// POST /api/admin/ib-requests/profiles/:id/sync-commission - Sync and save commission to database
router.post('/profiles/:id/sync-commission', authenticateAdminToken, async (req, res) => {
  try {
    const { id: rawId } = req.params;
    const id = Number.parseInt(String(rawId), 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'Invalid IB profile id' });
    }

    // Get IB details
    const ibResult = await query('SELECT email FROM ib_requests WHERE id = $1', [id]);
    if (ibResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'IB profile not found' });
    }

    const ibEmail = ibResult.rows[0].email;

    // Helper: Get IB's own user_id to exclude
    const getIBUserId = async (ibId) => {
      try {
        const ibRes = await query('SELECT email FROM ib_requests WHERE id = $1', [ibId]);
        if (ibRes.rows.length === 0) return null;
        const userRes = await query('SELECT id FROM "User" WHERE email = $1', [ibRes.rows[0].email]);
        return userRes.rows.length > 0 ? String(userRes.rows[0].id) : null;
      } catch {
        return null;
      }
    };

    // Helper: Get list of referred user_ids (from ib_referrals and ib_requests)
    const getReferredUserIds = async (ibId) => {
      const userIds = new Set();
      try {
        // Get user_ids from ib_referrals
        const refRes = await query(
          'SELECT user_id FROM ib_referrals WHERE ib_request_id = $1 AND user_id IS NOT NULL',
          [ibId]
        );
        refRes.rows.forEach(row => {
          if (row.user_id) userIds.add(String(row.user_id));
        });

        // Get user_ids from ib_requests where referred_by = ibId
        const ibRefRes = await query(
          `SELECT u.id as user_id 
           FROM ib_requests ir
           JOIN "User" u ON u.email = ir.email
           WHERE ir.referred_by = $1 AND u.id IS NOT NULL`,
          [ibId]
        );
        ibRefRes.rows.forEach(row => {
          if (row.user_id) userIds.add(String(row.user_id));
        });
      } catch (error) {
        console.error('Error getting referred user IDs:', error);
      }
      return Array.from(userIds);
    };

    // Get commission structures (groups)
    const groupsResult = await query(
      `SELECT group_id, group_name, structure_name, usd_per_lot, spread_share_percentage
       FROM ib_group_assignments
       WHERE ib_request_id = $1`,
      [id]
    );

    // Get IB's user_id for ib_commission table
    const ibUserResult = await query('SELECT id FROM "User" WHERE LOWER(email) = LOWER($1)', [ibEmail]);
    const ibUserId = ibUserResult.rows[0]?.id ? String(ibUserResult.rows[0].id) : null;

    // Get IB's own user_id to exclude
    const ibUserIdForExclusion = await getIBUserId(id);
    // Get referred user_ids to include
    const referredUserIds = await getReferredUserIds(id);

    console.log(`[Sync Commission] IB ID: ${id}, IB Email: ${ibEmail}`);
    console.log(`[Sync Commission] IB User ID (to exclude): ${ibUserIdForExclusion}`);
    console.log(`[Sync Commission] Referred User IDs (${referredUserIds.length}):`, referredUserIds);
    console.log(`[Sync Commission] Commission Groups (${groupsResult.rows.length}):`, groupsResult.rows.map(r => ({ group_id: r.group_id, spread: r.spread_share_percentage })));
    
    // Diagnostic: Check if there are ANY trades for this IB (without filters)
    const diagnosticQuery = await query(
      `SELECT COUNT(*)::int AS total, COALESCE(SUM(volume_lots), 0) AS total_lots, COALESCE(SUM(ib_commission), 0) AS total_commission
       FROM ib_trade_history
       WHERE ib_request_id = $1 AND close_price IS NOT NULL AND close_price != 0 AND profit != 0`,
      [id]
    );
    console.log(`[Sync Commission] DIAGNOSTIC - All trades for IB ${id}:`, diagnosticQuery.rows[0]);

    // Build commission groups map
    const commissionGroupsMap = new Map();
    for (const r of groupsResult.rows) {
      const k = normalizeGroupId(r.group_id);
      if (k) {
        commissionGroupsMap.set(k, {
          spreadPct: Number(r.spread_share_percentage || 0),
          usdPerLot: Number(r.usd_per_lot || 0)
        });
      }
    }

    console.log(`[Sync Commission] Commission groups map:`, Array.from(commissionGroupsMap.entries()).map(([k, v]) => ({ key: k, spreadPct: v.spreadPct, usdPerLot: v.usdPerLot })));

    // Calculate commission, trades, and lots from referred users' trades only (excluding IB's own trades)
    let balance = 0;
    let totalTrades = 0;
    let totalLots = 0;

    if (referredUserIds.length > 0 && commissionGroupsMap.size > 0) {
      // Build WHERE clause to exclude IB's own trades and only include referred users' trades
      let userFilter = '';
      const params = [id];
      if (ibUserIdForExclusion) {
        params.push(ibUserIdForExclusion);
        userFilter = `AND user_id != $${params.length}`;
      }
      params.push(referredUserIds);
      const userInClause = `AND user_id = ANY($${params.length}::text[])`;

      // Get all trades from referred users (only closed trades with profit != 0)
      const tradesRes = await query(
        `SELECT group_id, volume_lots
         FROM ib_trade_history
         WHERE ib_request_id = $1
           AND close_price IS NOT NULL AND close_price != 0 AND profit != 0
           ${userFilter}
           ${userInClause}`,
        params
      );

      console.log(`[Sync Commission] Found ${tradesRes.rows.length} trades from referred users`);

      // Calculate commission using helper function
      const commissionResult = calculateCommissionFromTrades(tradesRes.rows, commissionGroupsMap);
      
      balance = commissionResult.total;
      totalTrades = commissionResult.totalTrades;
      totalLots = commissionResult.totalLots;

      console.log(`[Sync Commission] Calculation result: fixed=${commissionResult.fixed}, spread=${commissionResult.spread}, total=${balance}, trades=${totalTrades}, lots=${totalLots}`);
    } else {
      if (referredUserIds.length === 0) {
        console.log(`[Sync Commission] WARNING: No referred users found for IB ${id}`);
      }
      if (commissionGroupsMap.size === 0) {
        console.log(`[Sync Commission] WARNING: No commission groups found for IB ${id}`);
      }
    }

    console.log(`[Sync Commission] Final calculation: total_commission=${balance}, total_trades=${totalTrades}, total_lots=${totalLots}`);

    // Save/update commission in ib_commission table
    if (ibUserId) {
      try {
        console.log(`[Sync Commission] Saving to database: ib_request_id=${id}, user_id=${ibUserId}, total_commission=${balance}, total_trades=${totalTrades}, total_lots=${totalLots}`);
        await IBCommission.upsertCommission(id, ibUserId, {
          totalCommission: balance,
          totalTrades: totalTrades,
          totalLots: totalLots
        });
        console.log(`[Sync Commission] Successfully saved to database`);
      } catch (error) {
        console.error('Error saving commission to ib_commission table:', error);
        console.error('Error stack:', error.stack);
        return res.status(500).json({
          success: false,
          message: 'Error saving commission data',
          error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined,
          details: process.env.NODE_ENV !== 'production' ? error.stack : undefined
        });
      }
    } else {
      console.log(`[Sync Commission] WARNING: IB user not found in User table for email ${ibEmail}`);
      return res.status(404).json({
        success: false,
        message: 'IB user not found in User table'
      });
    }

    res.json({
      success: true,
      message: 'Commission synced and saved successfully',
      data: {
        totalCommission: balance,
        totalTrades: totalTrades,
        totalLots: totalLots
      }
    });
  } catch (error) {
    console.error('Error syncing commission:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Unable to sync commission',
      error: process.env.NODE_ENV !== 'production' ? String(error?.message || error) : undefined,
      details: process.env.NODE_ENV !== 'production' ? error.stack : undefined
    });
  }
});

// Account statistics (live MT5 balances)
router.get('/profiles/:id/account-stats', authenticateAdminToken, async (req, res) => {
  try {
    const { id: rawId } = req.params;
    const id = Number.parseInt(String(rawId), 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'Invalid IB profile id' });
    }
    const ibResult = await query('SELECT email FROM ib_requests WHERE id = $1::int', [id]);
    if (ibResult.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'IB not found' });
    }

    // Get IB's own user_id to exclude
    const ibEmail = ibResult.rows[0].email;
    const ibUserResult = await query('SELECT id FROM "User" WHERE email = $1', [ibEmail]);
    const ibUserId = ibUserResult.rows.length > 0 ? String(ibUserResult.rows[0].id) : null;

    // Get referred user_ids (from ib_referrals and ib_requests)
    const referredUserIds = [];
    try {
      // From ib_referrals
      const refRes = await query(
        'SELECT user_id FROM ib_referrals WHERE ib_request_id = $1 AND user_id IS NOT NULL',
        [id]
      );
      refRes.rows.forEach(row => {
        if (row.user_id) referredUserIds.push(String(row.user_id));
      });

      // From ib_requests where referred_by = id
      const ibRefRes = await query(
        `SELECT u.id as user_id 
         FROM ib_requests ir
         JOIN "User" u ON u.email = ir.email
         WHERE ir.referred_by = $1 AND u.id IS NOT NULL`,
        [id]
      );
      ibRefRes.rows.forEach(row => {
        if (row.user_id) referredUserIds.push(String(row.user_id));
      });
    } catch (error) {
      console.error('Error getting referred user IDs:', error);
    }

    if (referredUserIds.length === 0) {
      return res.json({
        success: true,
        data: {
          totals: { totalAccounts: 0, totalBalance: 0, totalEquity: 0 },
          accounts: [],
          trades: [],
          tradeSummary: { totalTrades: 0, totalVolume: 0, totalProfit: 0, totalIbCommission: 0 }
        }
      });
    }

    // Get accounts from referred users only (exclude IB's own accounts)
    const accountsResult = await query(
      `SELECT "accountId", "userId" FROM "MT5Account" 
       WHERE "userId" = ANY($1::text[])`,
      [referredUserIds]
    );

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
      
      // Get account type from API response
      const accountType = payload?.AccountType ?? payload?.accountType ?? payload?.AccountTypeText ?? payload?.accountTypeText ?? null;
      
      // Check if account is demo by group name or account type
      const groupIdFull = payload?.Group || payload?.group || '';
      const isDemo = 
        (accountType && String(accountType).toLowerCase().includes('demo')) ||
        (groupIdFull && String(groupIdFull).toLowerCase().includes('demo')) ||
        (groupName && String(groupName).toLowerCase().includes('demo'));
      
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
        accountType: accountType || (isDemo ? 'Demo' : 'Live'),
        isDemo,
        raw: payload
      };
    };

    // Create a map of accountId to userId for reference
    const accountToUserMap = new Map();
    accountsResult.rows.forEach(row => {
      accountToUserMap.set(String(row.accountId), String(row.userId));
    });

    // Get user emails for display
    const userIds = [...new Set(accountsResult.rows.map(r => String(r.userId)))];
    const userEmailMap = new Map();
    if (userIds.length > 0) {
      const userEmailsRes = await query(
        `SELECT id, email FROM "User" WHERE id = ANY($1::text[])`,
        [userIds]
      );
      userEmailsRes.rows.forEach(row => {
        userEmailMap.set(String(row.id), row.email);
      });
    }

    const accounts = await Promise.all(accountsResult.rows.map(async r => {
      const accountData = await fetchOne(r.accountId);
      if (accountData) {
        accountData.userId = String(r.userId);
        accountData.userEmail = userEmailMap.get(String(r.userId)) || null;
      }
      return accountData;
    }));
    
    // Filter out demo accounts - only show real/live accounts
    const realAccounts = accounts.filter(acc => !acc.isDemo);
    // Whitelist of allowed accounts for this user; used to filter trade aggregates
    const allowedAccounts = new Set(realAccounts.map(a => String(a.accountId)));
    
    for (const acc of realAccounts) {
      totals.totalBalance += acc.balance;
      totals.totalEquity += acc.equity;
    }
    
    // Update total accounts count to only include real accounts
    totals.totalAccounts = realAccounts.length;

    // Get IB commission structures for this IB
    const commissionStructuresResult = await query(
      `SELECT group_id, group_name, structure_name, usd_per_lot, spread_share_percentage 
       FROM ib_group_assignments 
       WHERE ib_request_id = $1`,
      [id]
    );
    const eligibleGroups = new Map();
    const normalizeKey = (gid) => {
      if (!gid) return '';
      const s = String(gid).toLowerCase();
      const parts = s.split(/[\\/]/);
      return parts[parts.length - 1] || s;
    };
    commissionStructuresResult.rows.forEach(row => {
      if (row.group_id) {
        const groupIdLower = String(row.group_id).toLowerCase();
        const groupNameLower = row.group_name ? String(row.group_name).toLowerCase() : null;
        
        // Store with both group_id and group_name as keys for flexible matching
        eligibleGroups.set(groupIdLower, {
          structureName: row.structure_name,
          usdPerLot: Number(row.usd_per_lot || 0),
          spreadSharePercentage: Number(row.spread_share_percentage || 0)
        });
        
        if (groupNameLower && groupNameLower !== groupIdLower) {
          eligibleGroups.set(groupNameLower, {
            structureName: row.structure_name,
            usdPerLot: Number(row.usd_per_lot || 0),
            spreadSharePercentage: Number(row.spread_share_percentage || 0)
          });
        }

        // Also store a normalized key using only the trailing segment (e.g., dynamic-2000x-10P)
        const shortKey = normalizeKey(groupIdLower);
        if (shortKey && !eligibleGroups.has(shortKey)) {
          eligibleGroups.set(shortKey, {
            structureName: row.structure_name,
            usdPerLot: Number(row.usd_per_lot || 0),
            spreadSharePercentage: Number(row.spread_share_percentage || 0)
          });
        }
      }
    });

    // Fetch trades for this IB (closed positions with non-zero P&L).
    // EXCLUDE IB's own trades - only include trades from referred users
    // Admin view should reflect all historical trades; do not restrict by approval date.
    let tradesQuery = `
      SELECT account_id, group_id, volume_lots, profit, ib_commission, synced_at, updated_at, created_at, user_id
      FROM ib_trade_history
      WHERE ib_request_id = $1 
        AND close_price IS NOT NULL AND close_price != 0 AND profit != 0
        AND user_id = ANY($2::text[])`;
    const tradesParams = [id, referredUserIds];
    
    // Exclude IB's own trades if IB has a user_id
    if (ibUserId) {
      tradesQuery = `
        SELECT account_id, group_id, volume_lots, profit, ib_commission, synced_at, updated_at, created_at, user_id
        FROM ib_trade_history
        WHERE ib_request_id = $1 
          AND close_price IS NOT NULL AND close_price != 0 AND profit != 0
          AND user_id != $3
          AND user_id = ANY($2::text[])`;
      tradesParams.push(ibUserId);
    }
    
    const tradesRes = await query(tradesQuery, tradesParams);

    const normalize = (gid) => {
      if (!gid) return '';
      const s = String(gid).toLowerCase().trim();
      const parts = s.split(/[\\/]/);
      return parts[parts.length - 1] || s;
    };

    const approvedMap = {};
    for (const [k, v] of eligibleGroups.entries()) {
      approvedMap[k] = v; // keys already lowercased elsewhere
    }

    // Build commission groups map from eligibleGroups
    const commissionGroupsMap = new Map();
    for (const [k, v] of eligibleGroups.entries()) {
      commissionGroupsMap.set(k, {
        spreadPct: Number(v.spreadSharePercentage || 0),
        usdPerLot: Number(v.usdPerLot || 0)
      });
    }

    // Group trades by account_id for commission calculation
    const tradesByAccount = new Map();
    for (const row of tradesRes.rows) {
      const rowAccId = String(row.account_id);
      if (!allowedAccounts.has(rowAccId)) continue;
      
      if (!tradesByAccount.has(rowAccId)) {
        tradesByAccount.set(rowAccId, []);
      }
      tradesByAccount.get(rowAccId).push({
        group_id: row.group_id,
        volume_lots: row.volume_lots
      });
    }

    // Calculate commission for each account using commission structure
    const accountCommissionMap = new Map();
    const perAccountStats = new Map();

    for (const [accountId, trades] of tradesByAccount.entries()) {
      // Calculate commission using helper function
      const commissionResult = calculateCommissionFromTrades(trades, commissionGroupsMap);
      
      accountCommissionMap.set(accountId, {
        totalCommission: commissionResult.total,
        tradeCount: commissionResult.totalTrades
      });

      // Calculate other stats
      const accountTrades = tradesRes.rows.filter(r => String(r.account_id) === accountId);
      const st = {
        account_id: accountId,
        trade_count: commissionResult.totalTrades,
        total_volume: commissionResult.totalLots,
        total_profit: accountTrades.reduce((sum, t) => sum + Number(t.profit || 0), 0),
        total_ib_commission: commissionResult.total
      };
      perAccountStats.set(accountId, st);
    }

    // Add commission data and eligibility to each account
    // Helper: produce multiple keys for matching eligibility (handles \\ vs / and short segments)
    const makeKeys = (gidOrName) => {
      if (!gidOrName) return [];
      const raw = String(gidOrName).trim().toLowerCase();
      const variants = new Set([raw, raw.replace(/\\\\/g, '/'), raw.replace(/\//g, '\\')]);
      const parts = raw.split(/[\\\\/]/);
      if (parts.length) variants.add(parts[parts.length - 1]);
      const bbookIdx = parts.findIndex(p => p === 'bbook');
      if (bbookIdx >= 0 && bbookIdx + 1 < parts.length) variants.add(parts[bbookIdx + 1]);
      return Array.from(variants);
    };

    const accountsWithCommission = accounts.map(acc => {
      const accountIdStr = String(acc.accountId);
      const commissionData = accountCommissionMap.get(accountIdStr) || { totalCommission: 0, tradeCount: 0 };
      
      // Check if this account's group is eligible for commission
      // Try matching both groupId (full path) and group name (extracted)
      const groupIdLower = acc.groupId ? String(acc.groupId).toLowerCase() : null;
      const groupNameLower = acc.group ? String(acc.group).toLowerCase() : null;

      // Try a broad set of keys against eligibleGroups map
      let isEligible = false;
      let commissionInfo = null;
      const candidates = [
        ...makeKeys(groupIdLower),
        ...makeKeys(groupNameLower)
      ];
      for (const key of candidates) {
        if (eligibleGroups.has(key)) {
          isEligible = true;
          commissionInfo = eligibleGroups.get(key);
          break;
        }
      }

      return {
        ...acc,
        ibCommission: commissionData.totalCommission,
        tradeCount: commissionData.tradeCount,
        isEligibleForCommission: isEligible,
        commissionStructure: commissionInfo?.structureName || null,
        usdPerLot: commissionInfo?.usdPerLot || 0,
        spreadSharePercentage: commissionInfo?.spreadSharePercentage || 0
      };
    });

    const tradeMetrics = Array.from(perAccountStats.values());
    const summary = tradeMetrics.reduce((acc, row) => {
      acc.totalTrades += Number(row.trade_count || 0);
      acc.totalVolume += Number(row.total_volume || 0);
      acc.totalProfit += Number(row.total_profit || 0);
      acc.totalIbCommission += Number(row.total_ib_commission || 0);
      return acc;
    }, { totalTrades: 0, totalVolume: 0, totalProfit: 0, totalIbCommission: 0 });

    // Filter out demo accounts from the final response
    const realAccountsWithCommission = accountsWithCommission.filter(acc => !acc.isDemo);
    
    res.json({ success: true, data: { totals, accounts: realAccountsWithCommission, trades: tradeMetrics, tradeSummary: summary } });
  } catch (error) {
    console.error('Fetch account stats error:', error);
    res.status(500).json({ success: false, message: 'Unable to fetch account statistics' });
  }
});

// Trade history for IB profile
router.get('/profiles/:id/trades', authenticateAdminToken, async (req, res) => {
  try {
    const { id: rawId } = req.params;
    const id = Number.parseInt(String(rawId), 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, message: 'Invalid IB profile id' });
    }
    const { accountId, page = 1, pageSize = 50, sync } = req.query;

    const ibResult = await query('SELECT email FROM ib_requests WHERE id = $1::int', [id]);
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
    let result = await IBTradeHistory.getTrades({ userId, accountId, groupId, limit, offset });

    // If some rows still have zero fixed commission, compute on the fly using
    // the approved group's USD/lot so the UI always shows correct amounts.
    try {
      const assignments = await query(
        `SELECT a.group_id, a.group_name,
                COALESCE(a.usd_per_lot, s.usd_per_lot) AS usd_per_lot,
                COALESCE(a.spread_share_percentage, s.spread_share_percentage) AS spread_share_percentage
         FROM ib_group_assignments a
         LEFT JOIN group_commission_structures s
           ON (s.id = a.structure_id OR lower(COALESCE(s.structure_name,'')) = lower(COALESCE(a.structure_name,'')))
         WHERE a.ib_request_id = $1`,
        [id]
      );
      const norm = (gid) => {
        if (!gid) return '';
        const s = String(gid).toLowerCase();
        const parts = s.split(/[\\/]/);
        return parts[parts.length - 1] || s;
      };
      const rateMap = new Map();
      for (const r of assignments.rows) {
        const keys = [String(r.group_id||'').toLowerCase(), String(r.group_name||'').toLowerCase(), norm(r.group_id)];
        for (const k of keys) { if (k) rateMap.set(k, Number(r.usd_per_lot || 0)); }
      }
      const fallbackRate = Math.max(0, ...assignments.rows.map(r => Number(r.usd_per_lot || 0)));
      result.trades = result.trades.map(t => {
        if (Number(t.ib_commission || 0) > 0) return t;
        const k = norm(t.group_id) || String(t.group_id||'').toLowerCase();
        const usdPerLot = rateMap.get(k) ?? fallbackRate;
        const lots = Number(t.volume_lots || 0);
        return { ...t, ib_commission: lots * usdPerLot };
      });
    } catch {}

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
      
      // Helper function to normalize group IDs for matching
      const normalizeGroupId = (groupId) => {
        if (!groupId) return '';
        const normalized = String(groupId).toLowerCase().trim();
        // Extract last meaningful segment (after last / or \)
        const parts = normalized.split(/[\/\\]/);
        return parts[parts.length - 1] || normalized;
      };
      
      return groups.map(g => {
        // Try to find matching aggregate by exact match or normalized match
        const groupIdLower = String(g.groupId || '').toLowerCase();
        const groupNameLower = String(g.groupName || '').toLowerCase();
        const normalizedGroupId = normalizeGroupId(g.groupId);
        
        let matchedAggregate = null;
        
        // Try exact match first
        if (aggregates[g.groupId]) {
          matchedAggregate = aggregates[g.groupId];
        } else if (aggregates[groupIdLower]) {
          matchedAggregate = aggregates[groupIdLower];
        } else if (aggregates[groupNameLower]) {
          matchedAggregate = aggregates[groupNameLower];
        } else {
          // Try normalized match
          for (const [key, value] of Object.entries(aggregates)) {
            const normalizedKey = normalizeGroupId(key);
            if (normalizedKey === normalizedGroupId || normalizedKey === groupNameLower) {
              matchedAggregate = value;
              break;
            }
          }
        }
        
        return {
          ...g,
          totalCommission: Number(matchedAggregate?.totalCommission || 0),
          totalLots: Number(matchedAggregate?.totalLots || 0),
          totalVolume: Number(matchedAggregate?.totalVolume || 0),
          totalProfit: Number(matchedAggregate?.totalProfit || 0),
          totalTrades: Number(matchedAggregate?.totalTrades || 0)
        };
      });
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
    
    // Helper function to normalize group IDs for matching
    const normalizeGroupId = (groupId) => {
      if (!groupId) return '';
      const normalized = String(groupId).toLowerCase().trim();
      // Extract last meaningful segment (after last / or \)
      const parts = normalized.split(/[\/\\]/);
      return parts[parts.length - 1] || normalized;
    };
    
    return groups.map(g => {
      // Try to find matching aggregate by exact match or normalized match
      const groupIdLower = String(g.groupId || '').toLowerCase();
      const groupNameLower = String(g.groupName || '').toLowerCase();
      const normalizedGroupId = normalizeGroupId(g.groupId);
      
      let matchedAggregate = null;
      
      // Try exact match first
      if (aggregates[g.groupId]) {
        matchedAggregate = aggregates[g.groupId];
      } else if (aggregates[groupIdLower]) {
        matchedAggregate = aggregates[groupIdLower];
      } else if (aggregates[groupNameLower]) {
        matchedAggregate = aggregates[groupNameLower];
      } else {
        // Try normalized match
        for (const [key, value] of Object.entries(aggregates)) {
          const normalizedKey = normalizeGroupId(key);
          if (normalizedKey === normalizedGroupId || normalizedKey === groupNameLower) {
            matchedAggregate = value;
            break;
          }
        }
      }
      
      return {
        ...g,
        totalCommission: Number(matchedAggregate?.totalCommission || 0),
        totalLots: Number(matchedAggregate?.totalLots || 0),
        totalVolume: Number(matchedAggregate?.totalVolume || 0),
        totalProfit: Number(matchedAggregate?.totalProfit || 0)
      };
    });
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
    // Only include real/live accounts, exclude demo accounts
    const accountToGroup = {};
    const profilePromises = accountsRes.rows.map(async (row) => {
      const accountId = row.accountId;
      try {
        const res = await fetch(`http://18.175.242.21:5003/api/Users/${accountId}/getClientProfile`, { headers: { accept: '*/*' } });
        if (res.ok) {
          const data = await res.json();
          const payload = data?.Data || data?.data || null;
          if (!payload) return;
          
          // Check if account is demo
          const accountType = payload?.AccountType ?? payload?.accountType ?? payload?.AccountTypeText ?? payload?.accountTypeText ?? null;
          const groupId = payload?.Group || payload?.group || null;
          const groupIdLower = groupId ? String(groupId).toLowerCase() : '';
          
          const isDemo = 
            (accountType && String(accountType).toLowerCase().includes('demo')) ||
            (groupIdLower && groupIdLower.includes('demo'));
          
          // Only add real/live accounts
          if (!isDemo && groupId) {
            accountToGroup[String(accountId)] = groupId;
          }
        }
      } catch {}
    });
    await Promise.allSettled(profilePromises);

    if (!Object.keys(accountToGroup).length) return {};

    // Sum lots, commissions, profit, and trade count per account from DB, then fold by groupId (only closed deals with P&L)
    const tradesRes = await query(
      `SELECT account_id, 
              COALESCE(SUM(volume_lots),0) AS total_lots, 
              COALESCE(SUM(ib_commission),0) AS total_commission,
              COALESCE(SUM(profit),0) AS total_profit,
              COUNT(*)::int AS trade_count
       FROM ib_trade_history 
       WHERE ib_request_id = $1 AND close_price IS NOT NULL AND close_price != 0 AND profit != 0
       GROUP BY account_id`,
      [ibId]
    );

    // Also get account profits from MT5 API (current account profit/loss) - only for real accounts
    const accountProfits = {};
    const profitPromises = Object.keys(accountToGroup).map(async (accountId) => {
      try {
        const res = await fetch(`http://18.175.242.21:5003/api/Users/${accountId}/getClientProfile`, { headers: { accept: '*/*' } });
        if (res.ok) {
          const data = await res.json();
          const payload = data?.Data || data?.data || null;
          if (!payload) return;
          
          // Double-check it's not a demo account (should already be filtered, but just in case)
          const accountType = payload?.AccountType ?? payload?.accountType ?? payload?.AccountTypeText ?? payload?.accountTypeText ?? null;
          const groupId = payload?.Group || payload?.group || '';
          const isDemo = 
            (accountType && String(accountType).toLowerCase().includes('demo')) ||
            (groupId && String(groupId).toLowerCase().includes('demo'));
          
          if (!isDemo) {
            const profit = Number(payload?.Profit || payload?.profit || 0);
            accountProfits[accountId] = profit;
          }
        }
      } catch {}
    });
    await Promise.allSettled(profitPromises);

    const totals = tradesRes.rows.reduce((acc, row) => {
      const groupId = accountToGroup[row.account_id];
      if (!groupId) {
        console.log(`[computeGroupAggregates] No group mapping for account ${row.account_id}`);
        return acc; // skip if no mapping
      }
      
      // Store with full path (normalize to lowercase for consistency)
      const normalizedGroupId = String(groupId).toLowerCase();
      if (!acc[normalizedGroupId]) {
        acc[normalizedGroupId] = { totalLots: 0, totalCommission: 0, totalProfit: 0, totalVolume: 0, totalTrades: 0 };
      }
      acc[normalizedGroupId].totalLots += Number(row.total_lots || 0);
      acc[normalizedGroupId].totalCommission += Number(row.total_commission || 0);
      acc[normalizedGroupId].totalProfit += Number(row.total_profit || 0);
      acc[normalizedGroupId].totalVolume += Number(row.total_lots || 0);
      acc[normalizedGroupId].totalTrades += Number(row.trade_count || 0);
      
      return acc;
    }, {});

    // Add current account profits (from MT5 API) to totals
    Object.keys(accountToGroup).forEach(accountId => {
      const groupId = accountToGroup[accountId];
      const accountProfit = accountProfits[accountId] || 0;
      if (groupId) {
        const normalizedGroupId = String(groupId).toLowerCase();
        if (!totals[normalizedGroupId]) {
          totals[normalizedGroupId] = { totalLots: 0, totalCommission: 0, totalProfit: 0, totalVolume: 0, totalTrades: 0 };
        }
        totals[normalizedGroupId].totalProfit += accountProfit;
      }
    });

    console.log(`[computeGroupAggregates] IB ${ibId} - Aggregates:`, JSON.stringify(totals, null, 2));
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

  const makeKeys = (gid) => {
    if (!gid) return [];
    const s = String(gid).trim().toLowerCase();
    const fwd = s.replace(/\\\\/g, '/');
    const bwd = s.replace(/\//g, '\\');
    const parts = s.split(/[\\\\/]/);
    const last = parts[parts.length - 1] || s;
    let afterBbook = null;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === 'bbook' && i + 1 < parts.length) { afterBbook = parts[i + 1]; break; }
    }
    const keys = new Set([s, fwd, bwd, last]);
    if (afterBbook) keys.add(afterBbook);
    return Array.from(keys);
  };

  const map = assignments.rows.reduce((acc, row) => {
    if (!row.group_id) return acc;
    const payload = {
      usdPerLot: Number(row.usd_per_lot || 0),
      spreadPercentage: Number(row.spread_share_percentage || 0)
    };
    for (const k of makeKeys(row.group_id)) acc[k] = payload;
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
    const apiUrl = `http://18.130.5.209:5003/api/client/tradehistory/trades?accountId=${accountId}&page=1&pageSize=1000&fromDate=${from}&toDate=${to}`;

    const response = await fetch(apiUrl, { headers: { accept: '*/*' } });
    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    const trades = data.Items || [];

    // Resolve group id for this account
    let groupId = null;
    try {
      const profRes = await fetch(`http://18.130.5.209:5003/api/Users/${accountId}/getClientProfile`, { headers: { accept: '*/*' } });
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
    try { await IBTradeHistory.calculateIBCommissions(accountId, ibId); } catch {}
    return true;
  } catch (error) {
    console.error(`Trade sync failed for account ${accountId}:`, error.message);
    return false;
  }
}

async function getAccountStats(ibId) {
  try {
    // Get referred user_ids (from ib_referrals and ib_requests)
    const referredUserIds = [];
    try {
      // From ib_referrals
      const refRes = await query(
        'SELECT user_id FROM ib_referrals WHERE ib_request_id = $1 AND user_id IS NOT NULL',
        [ibId]
      );
      refRes.rows.forEach(row => {
        if (row.user_id) referredUserIds.push(String(row.user_id));
      });

      // From ib_requests where referred_by = ibId
      const ibRefRes = await query(
        `SELECT u.id as user_id 
         FROM ib_requests ir
         JOIN "User" u ON u.email = ir.email
         WHERE ir.referred_by = $1 AND u.id IS NOT NULL`,
        [ibId]
      );
      ibRefRes.rows.forEach(row => {
        if (row.user_id) referredUserIds.push(String(row.user_id));
      });
    } catch (error) {
      console.error('Error getting referred user IDs in getAccountStats:', error);
    }

    if (referredUserIds.length === 0) {
      return { totalAccounts: 0, totalBalance: 0, totalEquity: 0 };
    }

    // Step 1: Get all MT5 accounts from referred users only (exclude IB's own accounts)
    const result = await query(
      `SELECT "accountId" FROM "MT5Account" WHERE "userId" = ANY($1::text[])`,
      [referredUserIds]
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
                
                // Check if account is demo
                const accountType = data.AccountType ?? data.accountType ?? data.AccountTypeText ?? data.accountTypeText ?? null;
                const groupIdFull = data.Group || data.group || '';
                const isDemo = 
                  (accountType && String(accountType).toLowerCase().includes('demo')) ||
                  (groupIdFull && String(groupIdFull).toLowerCase().includes('demo'));
                
                // Skip demo accounts
                if (isDemo) {
                  tradingAccounts[index] = null; // Mark for removal
                  return;
                }
                
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
                  status: data.IsEnabled ? 1 : 0,
                  isDemo: false
                };
              }
            }
          } catch {}
        });
        await Promise.allSettled(fetchPromises);
        
        // Filter out demo accounts (null entries)
        const filteredAccounts = tradingAccounts.filter(acc => acc !== null);
        // Replace the array with filtered accounts
        tradingAccounts.length = 0;
        tradingAccounts.push(...filteredAccounts);
      } catch {}
    })();

    // Filter out any null entries (demo accounts) before returning
    const filteredAccounts = tradingAccounts.filter(acc => acc !== null && !acc.isDemo);
    
    console.log(`[Trading Accounts] Returning ${filteredAccounts.length} real accounts (filtered out demo)`);

    return filteredAccounts;
  } catch (error) {
    console.error('Error in getTradingAccounts:', error);
    return [];
  }
}

async function getTradeHistory(ibId) {
  try {
    // Get recent trades from ib_trade_history (only closed deals)
    const tradesResult = await query(`
      SELECT * FROM ib_trade_history
      WHERE ib_request_id = $1 AND close_price IS NOT NULL AND close_price != 0 AND profit != 0
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

// Build IB hierarchy tree using referral relationships
async function getTreeStructure(rootIbId) {
  try {
    // Helper: list real account IDs for an IB (from MT5Account with accountType/package filters)
    const getRealAccountIdsByIbId = async (ibId) => {
      try {
        const ibRes = await query('SELECT email FROM ib_requests WHERE id = $1', [ibId]);
        const email = ibRes.rows?.[0]?.email;
        if (!email) return [];
        const u = await query('SELECT id FROM "User" WHERE LOWER(email) = LOWER($1)', [email]);
        if (!u.rows.length) return [];
        const userId = u.rows[0].id;
        const attempts = [
          `SELECT "accountId" AS id FROM "MT5Account" WHERE "userId" = $1 AND LOWER("accountType") IN ('live','real') AND ("package" IS NULL OR LOWER("package") NOT LIKE '%demo%')`,
          `SELECT "accountId" AS id FROM "MT5Account" WHERE "userId" = $1 AND LOWER(accountType) IN ('live','real') AND (package IS NULL OR LOWER(package) NOT LIKE '%demo%')`,
          `SELECT "accountId" AS id FROM "MT5Account" WHERE "userId" = $1 AND LOWER(account_type) IN ('live','real') AND (package IS NULL OR LOWER(package) NOT LIKE '%demo%')`,
          `SELECT "accountId" AS id FROM "MT5Account" WHERE "userId" = $1 AND LOWER(type) IN ('live','real') AND (package IS NULL OR LOWER(package) NOT LIKE '%demo%')`,
          // accountType-only
          `SELECT "accountId" AS id FROM "MT5Account" WHERE "userId" = $1 AND LOWER("accountType") IN ('live','real')`,
          `SELECT "accountId" AS id FROM "MT5Account" WHERE "userId" = $1 AND LOWER(accountType) IN ('live','real')`,
          `SELECT "accountId" AS id FROM "MT5Account" WHERE "userId" = $1 AND LOWER(account_type) IN ('live','real')`,
          `SELECT "accountId" AS id FROM "MT5Account" WHERE "userId" = $1 AND LOWER(type) IN ('live','real')`,
          // package-only (not demo)
          `SELECT "accountId" AS id FROM "MT5Account" WHERE "userId" = $1 AND ("package" IS NULL OR LOWER("package") NOT LIKE '%demo%')`,
          `SELECT "accountId" AS id FROM "MT5Account" WHERE "userId" = $1 AND (package IS NULL OR LOWER(package) NOT LIKE '%demo%')`
        ];
        for (const q of attempts) {
          try {
            const r = await query(q, [userId]);
            if (r.rows?.length) return r.rows.map(x => String(x.id));
          } catch {/* try next */}
        }
      } catch {}
      return [];
    };
    // Helper: get IB's own user_id to exclude from commission calculations
    const getIBUserId = async (ibId) => {
      try {
        const ibRes = await query('SELECT email FROM ib_requests WHERE id = $1', [ibId]);
        if (ibRes.rows.length === 0) return null;
        const userRes = await query('SELECT id FROM "User" WHERE email = $1', [ibRes.rows[0].email]);
        return userRes.rows.length > 0 ? String(userRes.rows[0].id) : null;
      } catch {
        return null;
      }
    };

    // Helper: get list of referred user_ids (from ib_referrals and ib_requests)
    const getReferredUserIds = async (ibId) => {
      const userIds = new Set();
      try {
        // Get user_ids from ib_referrals
        const refRes = await query(
          'SELECT user_id FROM ib_referrals WHERE ib_request_id = $1 AND user_id IS NOT NULL',
          [ibId]
        );
        refRes.rows.forEach(row => {
          if (row.user_id) userIds.add(String(row.user_id));
        });

        // Get user_ids from ib_requests where referred_by = ibId
        const ibRefRes = await query(
          `SELECT u.id as user_id 
           FROM ib_requests ir
           JOIN "User" u ON u.email = ir.email
           WHERE ir.referred_by = $1 AND u.id IS NOT NULL`,
          [ibId]
        );
        ibRefRes.rows.forEach(row => {
          if (row.user_id) userIds.add(String(row.user_id));
        });
      } catch (error) {
        console.error('Error getting referred user IDs:', error);
      }
      return Array.from(userIds);
    };

    // Helper: compute own lots and commission breakdown for a given IB (EXCLUDING IB's own trades)
    const getOwnStats = async (ibId) => {
      // Get IB's own user_id to exclude
      const ibUserId = await getIBUserId(ibId);
      // Get referred user_ids to include
      const referredUserIds = await getReferredUserIds(ibId);
      
      if (referredUserIds.length === 0) {
        return { ownLots: 0, tradeCount: 0, fixed: 0, spread: 0 };
      }

      // Fetch approved group mappings for this IB
      const assignRes = await query(
        `SELECT group_id, usd_per_lot, spread_share_percentage
         FROM ib_group_assignments WHERE ib_request_id = $1`,
        [ibId]
      );
      const normalize = (gid) => {
        if (!gid) return '';
        const s = String(gid).toLowerCase().trim();
        const parts = s.split(/[\\/]/);
        return parts[parts.length - 1] || s;
      };
      const approved = new Map();
      for (const r of assignRes.rows) {
        const k = normalize(r.group_id);
        if (k) approved.set(k, { usdPerLot: Number(r.usd_per_lot || 0), spreadPct: Number(r.spread_share_percentage || 0) });
      }
      if (!approved.size) return { ownLots: 0, tradeCount: 0, fixed: 0, spread: 0 };

      // Build WHERE clause to exclude IB's own trades and only include referred users' trades
      let userFilter = '';
      const params = [ibId];
      if (ibUserId) {
        params.push(ibUserId);
        userFilter = `AND user_id != $${params.length}`;
      }
      params.push(referredUserIds);
      const userInClause = `AND user_id = ANY($${params.length}::text[])`;

      const res = await query(
        `SELECT group_id, COALESCE(SUM(volume_lots),0) AS lots, COUNT(*)::int AS trade_count, COALESCE(SUM(ib_commission),0) AS fixed
         FROM ib_trade_history
         WHERE ib_request_id = $1
           AND close_price IS NOT NULL AND close_price != 0 AND profit != 0
           ${userFilter}
           ${userInClause}
         GROUP BY group_id`,
        params
      );
      let ownLots = 0, tradeCount = 0, fixed = 0, spread = 0;
      for (const row of res.rows) {
        const k = normalize(row.group_id);
        const rule = approved.get(k);
        if (!rule) continue; // only approved groups
        const l = Number(row.lots || 0);
        ownLots += l;
        tradeCount += Number(row.trade_count || 0);
        const f = Number(row.fixed || 0);
        fixed += f;
        spread += l * (Number(rule.spreadPct || 0) / 100);
      }
      return { ownLots, tradeCount, fixed, spread };
    };

    // Helper: fetch IB request basic info
    const getIb = async (ibId) => {
      const res = await query(
        'SELECT id, full_name, email, status FROM ib_requests WHERE id = $1',
        [ibId]
      );
      return res.rows[0] || null;
    };

    // Helper: get commission structures assigned to IB (for display)
    const getAssignments = async (ibId) => {
      const res = await query(
        `SELECT structure_name, usd_per_lot, spread_share_percentage
         FROM ib_group_assignments
         WHERE ib_request_id = $1 AND (structure_name IS NOT NULL OR structure_id IS NOT NULL)`,
        [ibId]
      );
      return res.rows.map(r => ({
        structureName: r.structure_name || null,
        usdPerLot: Number(r.usd_per_lot || 0),
        spreadSharePercentage: Number(r.spread_share_percentage || 0)
      }));
    };

    // Helper: total IB commission for this IB (fixed+spread)
    const getIbCommissionTotal = async (ibId) => {
      const s = await getOwnStats(ibId);
      return s.fixed + s.spread;
    };

    // Helper: accounts count for IB user
    const getAccountsCount = async (ibEmail) => {
      // Prefer counting real accounts from MT5Account using accountType + package filters
      try {
        const u = await query('SELECT id FROM "User" WHERE LOWER(email) = LOWER($1)', [ibEmail]);
        if (u.rows.length) {
          const userId = u.rows[0].id;

          // Try with both quoted/unquoted column variations
          const attempts = [
            // Both columns present, strict: accountType in ('live','real') AND package not demo
            `SELECT COUNT(*)::int AS cnt FROM "MT5Account" WHERE "userId" = $1 AND LOWER("accountType") IN ('live','real') AND ("package" IS NULL OR LOWER("package") NOT LIKE '%demo%')`,
            `SELECT COUNT(*)::int AS cnt FROM "MT5Account" WHERE "userId" = $1 AND LOWER(accountType) IN ('live','real') AND (package IS NULL OR LOWER(package) NOT LIKE '%demo%')`,
            `SELECT COUNT(*)::int AS cnt FROM "MT5Account" WHERE "userId" = $1 AND LOWER(account_type) IN ('live','real') AND (package IS NULL OR LOWER(package) NOT LIKE '%demo%')`,
            `SELECT COUNT(*)::int AS cnt FROM "MT5Account" WHERE "userId" = $1 AND LOWER(type) IN ('live','real') AND (package IS NULL OR LOWER(package) NOT LIKE '%demo%')`,
            // If package not present, at least ensure accountType is live/real
            `SELECT COUNT(*)::int AS cnt FROM "MT5Account" WHERE "userId" = $1 AND LOWER("accountType") IN ('live','real')`,
            `SELECT COUNT(*)::int AS cnt FROM "MT5Account" WHERE "userId" = $1 AND LOWER(accountType) IN ('live','real')`,
            `SELECT COUNT(*)::int AS cnt FROM "MT5Account" WHERE "userId" = $1 AND LOWER(account_type) IN ('live','real')`,
            `SELECT COUNT(*)::int AS cnt FROM "MT5Account" WHERE "userId" = $1 AND LOWER(type) IN ('live','real')`,
            // If accountType not present, fallback to package not demo
            `SELECT COUNT(*)::int AS cnt FROM "MT5Account" WHERE "userId" = $1 AND ("package" IS NULL OR LOWER("package") NOT LIKE '%demo%')`,
            `SELECT COUNT(*)::int AS cnt FROM "MT5Account" WHERE "userId" = $1 AND (package IS NULL OR LOWER(package) NOT LIKE '%demo%')`
          ];

          for (const q of attempts) {
            try {
              const r = await query(q, [userId]);
              if (r?.rows?.[0]?.cnt !== undefined) return Number(r.rows[0].cnt || 0);
            } catch {/* try next variant */}
          }
        }
      } catch {/* fall back below */}

      // Final fallback: count distinct real-account trades (non-demo groups)
      try {
        const r = await query(
          `SELECT COUNT(DISTINCT account_id)::int AS cnt
           FROM ib_trade_history
           WHERE close_price IS NOT NULL AND close_price != 0 AND profit != 0
             AND (group_id IS NULL OR LOWER(group_id) NOT LIKE '%demo%')
             AND ib_request_id = (SELECT id FROM ib_requests WHERE LOWER(email)=LOWER($1) LIMIT 1)`,
          [ibEmail]
        );
        return Number(r.rows?.[0]?.cnt || 0);
      } catch { return 0; }
    };

    // Helper: fetch direct children (referred IBs)
    const getChildren = async (ibId) => {
      const res = await query(
        `SELECT id, full_name, email, status
         FROM ib_requests
         WHERE referred_by = $1
         ORDER BY approved_at NULLS LAST, submitted_at ASC`,
        [ibId]
      );
      return res.rows;
    };

    // Build node recursively
    const buildNode = async (ibId) => {
      const ib = await getIb(ibId);
      if (!ib) return null;
      const { ownLots, tradeCount, fixed, spread } = await getOwnStats(ibId);
      const assignments = await getAssignments(ibId);
      const ibCommissionTotal = fixed + spread;
      const accountsCount = await getAccountsCount(ib.email);
      const childrenRecords = await getChildren(ibId);
      const children = [];
      let teamLots = 0;
      for (const child of childrenRecords) {
        const childNode = await buildNode(child.id);
        if (childNode) {
          children.push(childNode);
          teamLots += childNode.ownLots + (childNode.teamLots || 0);
        }
      }
      // Append CRM-referred traders as leaf nodes
      try {
        const crmRes = await query('SELECT id AS ref_id, user_id, email, created_at FROM ib_referrals WHERE ib_request_id = $1 ORDER BY created_at DESC', [ibId]);
        for (const t of crmRes.rows) {
          const statsRes = await query(
            `SELECT COALESCE(SUM(volume_lots),0) AS lots, COUNT(*)::int AS trade_count, COALESCE(SUM(ib_commission),0) AS fixed
             FROM ib_trade_history
             WHERE ib_request_id = $1 AND user_id = $2 AND close_price IS NOT NULL AND close_price != 0 AND profit != 0`,
            [ibId, t.user_id]
          );
          const lots = Number(statsRes.rows?.[0]?.lots || 0);
          const tradeC = Number(statsRes.rows?.[0]?.trade_count || 0);
          const fixedTrader = Number(statsRes.rows?.[0]?.fixed || 0);
          let accountsCnt = 0;
          if (t.user_id) {
            try {
              const acc = await query('SELECT COUNT(*)::int AS cnt FROM "MT5Account" WHERE "userId" = $1', [t.user_id]);
              accountsCnt = Number(acc.rows?.[0]?.cnt || 0);
            } catch {}
          }
          children.push({
            id: `trader-${t.user_id || t.ref_id}`,
            name: t.email,
            email: t.email,
            status: 'trader',
            ownLots: lots,
            tradeCount: tradeC,
            accountsCount: accountsCnt,
            ibCommissionTotal: fixedTrader,
            fixedCommission: fixedTrader,
            spreadCommission: 0,
            structures: [],
            teamLots: 0,
            children: []
          });
        }
      } catch {}
      return {
        id: ib.id,
        name: ib.full_name,
        email: ib.email,
        status: ib.status,
        ownLots,
        tradeCount,
        accountsCount,
        ibCommissionTotal,
        fixedCommission: fixed,
        spreadCommission: spread,
        structures: assignments,
        teamLots,
        children
      };
    };

    const root = await buildNode(rootIbId);
    if (!root) {
      return { ownLots: 0, teamLots: 0, totalTrades: 0, root: null };
    }

    // Aggregate overall metrics from the built tree
    const totalTrades = (function countTrades(node) {
      if (!node) return 0;
      let total = Number(node.tradeCount || 0);
      for (const c of node.children || []) total += countTrades(c);
      return total;
    })(root);

    return {
      ownLots: Number(root.ownLots || 0),
      teamLots: Number(root.teamLots || 0),
      totalTrades,
      root
    };
  } catch (e) {
    console.warn('getTreeStructure error:', e.message);
    return { ownLots: 0, teamLots: 0, totalTrades: 0, root: null };
  }
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
    if (error?.code === '23505') {
      return res.status(400).json({ success: false, message: 'Level already exists for this group. Please choose a unique level order.' });
    }
    res.status(500).json({ success: false, message: 'Unable to create commission structure' });
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
    if (error?.code === '23505') {
      return res.status(400).json({ success: false, message: 'Level already exists for this group. Please choose a unique level order.' });
    }
    res.status(500).json({ success: false, message: 'Unable to update commission structure' });
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
