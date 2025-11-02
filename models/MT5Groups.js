import { query } from '../config/database.js';
import axios from 'axios';

export class MT5Groups {
  static generateGroupName(groupId, index = null) {
    if (!groupId) return 'Unknown Group';

    const upperGroupId = groupId.toUpperCase();

    // Generate sequential letters (A, B, C, D, etc.)
    const getSequentialLetter = (idx) => {
      if (idx === null || idx === undefined) return 'A';
      return String.fromCharCode(65 + (idx % 26)); // 65 is ASCII for 'A'
    };

    // Extract leverage information
    const leverageMatch = upperGroupId.match(/(\d+)X/);
    const leverage = leverageMatch ? leverageMatch[1] + 'x' : '100x';

    // Pattern matching for different account types
    if (upperGroupId.includes('DEMO')) {
      return `Demo${leverage}`;
    }

    if (upperGroupId.includes('REAL') || upperGroupId.includes('LIVE')) {
      return `Live${leverage}`;
    }

    // Check for specific account types
    if (upperGroupId.includes('PRO') || upperGroupId.includes('PROFESSIONAL')) {
      const letter = getSequentialLetter(index);
      return `${letter} Pro Dynamic`;
    }

    if (upperGroupId.includes('STANDARD') || upperGroupId.includes('STD')) {
      const letter = getSequentialLetter(index);
      return `${letter} Standard Dynamic`;
    }

    if (upperGroupId.includes('CENT')) {
      return `Cent${leverage}`;
    }

    if (upperGroupId.includes('VIP') || upperGroupId.includes('PREMIUM')) {
      const letter = getSequentialLetter(index);
      return `${letter} VIP Dynamic`;
    }

    if (upperGroupId.includes('ECN')) {
      const letter = getSequentialLetter(index);
      return `${letter} ECN Dynamic`;
    }

    if (upperGroupId.includes('MICRO')) {
      return `Micro${leverage}`;
    }

    if (upperGroupId.includes('MINI')) {
      return `Mini${leverage}`;
    }

    // For unknown patterns, create a sequential name
    const letter = getSequentialLetter(index);
    return `${letter} Standard Dynamic`;
  }

  static async createTable() {
    const queryText = `
      CREATE TABLE IF NOT EXISTS mt5_groups (
        id SERIAL PRIMARY KEY,
        group_id VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        synced_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await query(queryText);
  }

  static async syncFromAPI(apiUrl = 'http://18.175.242.21:5003/api/Groups') {
    try {
      const response = await axios.get(apiUrl, {
        headers: {
          'accept': 'text/plain'
        }
      });

      const data = response.data; // Axios provides data directly

      // Clear existing data and insert new
      await query('DELETE FROM mt5_groups');

      if (Array.isArray(data)) {
        for (let i = 0; i < data.length; i++) {
          const group = data[i];
          const groupId = group.Group;
          const generatedName = MT5Groups.generateGroupName(groupId, i);
          const description = `Auto-generated group: ${groupId}`;
          await query(
            `INSERT INTO mt5_groups (group_id, name, description) VALUES ($1, $2, $3)`,
            [groupId, generatedName, description]
          );
        }
      }

      await query('UPDATE mt5_groups SET synced_at = CURRENT_TIMESTAMP');

      return { success: true, message: 'Groups synced successfully' };
    } catch (error) {
      console.error('Error syncing groups from API:', error);
      throw error;
    }
  }

  static async getAll(page = 1, limit = 10) {
    const offset = (page - 1) * limit;
    const result = await query(
      `SELECT * FROM mt5_groups ORDER BY name ASC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countResult = await query('SELECT COUNT(*) FROM mt5_groups');
    const totalCount = parseInt(countResult.rows[0].count);

    return {
      groups: result.rows,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit)
      }
    };
  }

  static async getAllWithoutPagination() {
    const result = await query(`SELECT * FROM mt5_groups ORDER BY name ASC`);
    return result.rows;
  }

  static async findById(groupId) {
    const result = await query('SELECT * FROM mt5_groups WHERE group_id = $1', [groupId]);
    return result.rows[0];
  }

  static async regenerateAllNames() {
    try {
      const groups = await MT5Groups.getAllWithoutPagination();

      // Update each group with sequential naming
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const newName = MT5Groups.generateGroupName(group.group_id, i);
        await query(
          'UPDATE mt5_groups SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE group_id = $2',
          [newName, group.group_id]
        );
      }

      return { success: true, message: `Regenerated names for ${groups.length} groups` };
    } catch (error) {
      console.error('Error regenerating group names:', error);
      throw error;
    }
  }

  static async updateGroupName(groupId, customName) {
    try {
      console.log('MT5Groups.updateGroupName called:', { groupId, customName });

      if (!customName || !customName.trim()) {
        throw new Error('Group name cannot be empty');
      }

      if (!groupId) {
        throw new Error('Group ID is required');
      }

      const trimmedName = customName.trim();
      console.log('Updating group in database:', { groupId, trimmedName });

      // First check if the group exists
      const existingGroup = await MT5Groups.findById(groupId);
      if (!existingGroup) {
        throw new Error('Group not found in database');
      }

      const result = await query(
        'UPDATE mt5_groups SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE group_id = $2',
        [trimmedName, groupId]
      );

      console.log('Database update result:', result);

      if (result.rowCount === 0) {
        throw new Error('Failed to update group name');
      }

      return { success: true, message: 'Group name updated successfully' };
    } catch (error) {
      console.error('Error updating group name:', error);
      throw error;
    }
  }
}