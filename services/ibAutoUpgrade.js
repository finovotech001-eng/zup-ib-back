import { query } from '../config/database.js';
// import { IBLevelUpHistory } from '../models/IBLevelUpHistory.js'; // File removed
import { GroupCommissionStructures } from '../models/GroupCommissionStructures.js';
import { IBGroupAssignment } from '../models/IBGroupAssignment.js';

/**
 * Calculate total trading volume for an IB (in USD)
 * This sums up volume_lots from ib_trade_history
 * For simplicity, we'll use a standard contract size (100,000 USD per standard lot)
 */
export async function calculateIBTradingVolume(ibRequestId) {
  try {
    const result = await query(
      `
        SELECT COALESCE(SUM(volume_lots), 0) as total_lots
        FROM ib_trade_history
        WHERE ib_request_id = $1
      `,
      [ibRequestId]
    );

    const totalLots = Number(result.rows[0]?.total_lots || 0);
    // Standard lot = 100,000 USD notional value
    // Return in USD (not millions)
    const totalVolumeUSD = totalLots * 100000;
    
    return totalVolumeUSD;
  } catch (error) {
    console.error('Error calculating trading volume:', error);
    return 0;
  }
}

/**
 * Calculate number of active clients for an IB
 * Active clients are those who have traded in the last 30 days
 */
export async function calculateIBActiveClients(ibRequestId) {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const result = await query(
      `
        SELECT COUNT(DISTINCT account_id) as active_clients
        FROM ib_trade_history
        WHERE ib_request_id = $1
          AND created_at >= $2
      `,
      [ibRequestId, thirtyDaysAgo.toISOString()]
    );

    return parseInt(result.rows[0]?.active_clients || 0);
  } catch (error) {
    console.error('Error calculating active clients:', error);
    return 0;
  }
}

/**
 * Check and upgrade IB commission structure if they qualify
 */
export async function checkAndUpgradeIB(ibRequestId) {
  try {
    // Get IB details
    const ibResult = await query(
      'SELECT id, email, status FROM ib_requests WHERE id = $1',
      [ibRequestId]
    );

    if (ibResult.rows.length === 0 || ibResult.rows[0].status !== 'approved') {
      return { upgraded: false, message: 'IB not found or not approved' };
    }

    // Get current group assignments
    const currentAssignments = await IBGroupAssignment.getByIbRequestId(ibRequestId);
    
    if (currentAssignments.length === 0) {
      return { upgraded: false, message: 'No group assignments found' };
    }

    // Calculate IB metrics
    const tradingVolume = await calculateIBTradingVolume(ibRequestId);
    const activeClients = await calculateIBActiveClients(ibRequestId);

    const upgrades = [];

    // Check each group assignment
    for (const assignment of currentAssignments) {
      const groupId = assignment.group_id;
      const currentStructureId = assignment.structure_id;

      // Get all structures for this group ordered by level
      const structures = await GroupCommissionStructures.getByGroupIdOrderedByLevel(groupId);
      
      if (structures.length === 0) {
        continue;
      }

      // Find the highest eligible structure
      const eligibleStructure = await GroupCommissionStructures.findEligibleStructure(
        groupId,
        tradingVolume,
        activeClients
      );

      if (!eligibleStructure) {
        continue;
      }

      // Check if eligible structure is higher than current
      const currentStructure = structures.find(s => s.id === currentStructureId);
      const currentLevel = currentStructure?.level_order || 0;
      const eligibleLevel = eligibleStructure.level_order || 0;

      if (eligibleLevel > currentLevel) {
        // Upgrade needed!
        const fromStructureName = currentStructure?.structure_name || 'Default';
        const toStructureName = eligibleStructure.structure_name;

        // Record level up
        // await IBLevelUpHistory.recordLevelUp( // File removed
        //   ibRequestId,
        //   currentStructureId,
        //   eligibleStructure.id,
        //   fromStructureName,
        //   toStructureName,
        //   tradingVolume / 1000000, // Convert to millions
        //   activeClients
        // );

        // Update group assignment
        await IBGroupAssignment.updateStructure(
          assignment.id,
          eligibleStructure.id,
          eligibleStructure.structure_name,
          eligibleStructure.usd_per_lot,
          eligibleStructure.spread_share_percentage
        );

        upgrades.push({
          groupId,
          groupName: assignment.group_name || groupId,
          fromStructure: fromStructureName,
          toStructure: toStructureName,
          fromLevel: currentLevel,
          toLevel: eligibleLevel
        });
      }
    }

    if (upgrades.length > 0) {
      return {
        upgraded: true,
        message: `Upgraded to ${upgrades.map(u => `${u.toStructure} (${u.groupName})`).join(', ')}`,
        upgrades
      };
    }

    return {
      upgraded: false,
      message: 'IB does not qualify for upgrade yet',
      metrics: {
        tradingVolume: tradingVolume / 1000000, // in millions
        activeClients
      }
    };
  } catch (error) {
    console.error('Error checking and upgrading IB:', error);
    return {
      upgraded: false,
      message: 'Error during upgrade check',
      error: error.message
    };
  }
}

/**
 * Check all approved IBs and upgrade if they qualify
 */
export async function checkAllIBsForUpgrade() {
  try {
    const result = await query(
      'SELECT id FROM ib_requests WHERE LOWER(TRIM(status)) = $1',
      ['approved']
    );

    const ibIds = result.rows.map(row => row.id);
    const results = [];

    for (const ibId of ibIds) {
      const upgradeResult = await checkAndUpgradeIB(ibId);
      results.push({
        ibId,
        ...upgradeResult
      });
    }

    return {
      success: true,
      totalChecked: ibIds.length,
      upgraded: results.filter(r => r.upgraded).length,
      results
    };
  } catch (error) {
    console.error('Error checking all IBs for upgrade:', error);
    return {
      success: false,
      message: 'Error checking IBs for upgrade',
      error: error.message
    };
  }
}


