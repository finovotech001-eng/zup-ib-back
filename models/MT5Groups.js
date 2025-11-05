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

  static async runMigration() {
    try {
      // Read and execute the migration SQL
      const fs = require('fs').promises;
      const path = require('path');
      const migrationPath = path.join(__dirname, '../migrations/alter_mt5_groups.sql');
      const migrationSQL = await fs.readFile(migrationPath, 'utf8');
      
      // Execute the migration
      await query(migrationSQL);
      return { success: true, message: 'Migration completed successfully' };
    } catch (error) {
      console.error('Error running migration:', error);
      throw error;
    }
  }

  static async syncFromAPI(apiUrl = 'http://18.175.242.21:3000/api/Groups') {
    try {
      // Handle relative URLs - if it starts with /, prepend the base URL
      let fullApiUrl = apiUrl;
      if (apiUrl.startsWith('/')) {
        fullApiUrl = `http://18.175.242.21:3000${apiUrl}`;
      }

      console.log('[SYNC] Fetching groups from:', fullApiUrl);

      let response;
      try {
        response = await axios.get(fullApiUrl, {
          headers: {
            'accept': 'application/json',
            'Content-Type': 'application/json'
          },
          timeout: 30000,
          validateStatus: function (status) {
            return status < 500; // Don't throw for 4xx errors, but do for 5xx
          }
        });
      } catch (axiosError) {
        console.error('[SYNC] Axios error details:', {
          message: axiosError.message,
          code: axiosError.code,
          response: axiosError.response?.data,
          status: axiosError.response?.status
        });
        
        if (axiosError.code === 'ECONNREFUSED') {
          throw new Error(`Cannot connect to API at ${fullApiUrl}. Server may be down.`);
        }
        if (axiosError.code === 'ETIMEDOUT') {
          throw new Error(`API request timed out after 30 seconds`);
        }
        if (axiosError.response) {
          throw new Error(`API returned status ${axiosError.response.status}: ${axiosError.response.statusText}`);
        }
        throw new Error(`Failed to fetch from API: ${axiosError.message}`);
      }

      if (response.status >= 400) {
        throw new Error(`API returned status ${response.status}: ${response.statusText}`);
      }

      const data = response.data;

      if (!data) {
        throw new Error('No data received from API');
      }

      if (!Array.isArray(data)) {
        console.error('[SYNC] Unexpected data format:', typeof data, data);
        // Log first item structure to understand the format
        if (typeof data === 'object' && data !== null) {
          console.error('[SYNC] Data structure:', JSON.stringify(data, null, 2).substring(0, 500));
        }
        throw new Error(`Expected array but got ${typeof data}`);
      }

      console.log(`[SYNC] Received ${data.length} groups from API`);
      
      // Log first group structure to understand the API response format
      if (data.length > 0) {
        console.log('[SYNC] Sample group structure:', JSON.stringify(data[0], null, 2));
      }

      // Use UPSERT to update existing or insert new groups
      if (Array.isArray(data) && data.length > 0) {
        let successCount = 0;
        let errorCount = 0;
        
        for (let i = 0; i < data.length; i++) {
          const group = data[i];
          
          // Validate group data
          if (!group) {
            console.warn(`[SYNC] Skipping null/undefined group at index ${i}`);
            errorCount++;
            continue;
          }
          
          // Try multiple possible field names from API
          const groupId = group.Group || group.group_id || group.name || group.Name || group.group || null;
          
          if (!groupId) {
            console.warn(`[SYNC] Skipping group at index ${i} - no group ID found. Group data:`, JSON.stringify(group, null, 2));
            errorCount++;
            continue;
          }
          
          const generatedName = group.Name || group.name || MT5Groups.generateGroupName(groupId, i);
          const description = group.Description || group.description || `Auto-generated group: ${groupId}`;
          
          console.log(`[SYNC] Processing group ${i + 1}/${data.length}: ${groupId}`);

          // Parse all the fields from API response
          const server = group.Server ?? group.server ?? 1;
          const company = group.Company || group.company || 'OXO Markets Limited';
          const currency = group.Currency ?? group.currency ?? 0;
          const currencyDigits = group.CurrencyDigits ?? group.currency_digits ?? 2;
          const marginCall = group.MarginCall ?? group.margin_call ?? 100.00;
          const stopOut = group.StopOut ?? group.stop_out ?? 50.00;
          const tradeFlags = group.TradeFlags ?? group.trade_flags ?? 16;
          const authMode = group.AuthMode ?? group.auth_mode ?? 0;
          const minPasswordChars = group.MinPassword ?? group.min_password_chars ?? 8;
          const website = group.Website || group.website || null;
          const email = group.Email || group.email || null;
          const supportPage = group.SupportPage || group.support_page || null;
          const supportEmail = group.SupportEmail || group.support_email || null;
          const reportsMode = group.ReportsMode ?? group.reports_mode ?? 1;
          const marginMode = group.MarginMode ?? group.margin_mode ?? 2;
          const demoLeverage = group.DemoLeverage ?? group.demo_leverage ?? 0;
          const newsMode = group.NewsMode ?? group.news_mode ?? 2;
          const marginFreeMode = group.MarginFreeMode ?? group.margin_free_mode ?? 1;
          const demoDeposit = parseFloat(group.DemoDeposit ?? group.demo_deposit ?? 0);
          const mailMode = group.MailMode ?? group.mail_mode ?? 1;
          const marginSOMode = group.MarginSOMode ?? group.margin_so_mode ?? 0;
          const tradeTransferMode = group.TradeTransferMode ?? group.trade_transfer_mode ?? 0;

          // Parse dates - handle different formats
          let createdAt = group.Created || group.created || group.CreatedAt || group.created_at;
          if (createdAt) {
            createdAt = new Date(createdAt).toISOString();
          }

          // Group path is the same as group_id (full path like OXO_A\Classic)
          const groupPath = groupId;

          // Try to insert with all columns first, fallback to minimal if columns don't exist
          try {
            // First, try with all columns - but wrap in transaction-like safety
            const insertQuery = `
              INSERT INTO mt5_groups (
                group_id, name, description, server, company, currency, currency_digits,
                margin_call, stop_out, trade_flags, auth_mode, min_password_chars,
                website, email, support_page, support_email, reports_mode, margin_mode,
                demo_leverage, news_mode, margin_free_mode, demo_deposit, mail_mode,
                margin_so_mode, trade_transfer_mode, group_path, created_at, synced_at, updated_at
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, COALESCE($27::timestamp, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
              )
              ON CONFLICT (group_id) 
              DO UPDATE SET
                name = EXCLUDED.name,
                description = EXCLUDED.description,
                synced_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            `;
            
            const insertParams = [
              groupId, generatedName, description, server, company, currency, currencyDigits,
              marginCall, stopOut, tradeFlags, authMode, minPasswordChars,
              website, email, supportPage, supportEmail, reportsMode, marginMode,
              demoLeverage, newsMode, marginFreeMode, demoDeposit, mailMode,
              marginSOMode, tradeTransferMode, groupPath, createdAt
            ];
            
            await query(insertQuery, insertParams);
            successCount++;
          } catch (dbError) {
            // If the query fails due to missing columns, use a minimal INSERT
            console.warn(`[SYNC] Failed to insert with all columns for group ${groupId}, using minimal insert.`);
            console.warn(`[SYNC] Database error:`, dbError.message);
            console.warn(`[SYNC] Error code:`, dbError.code);
            
            try {
              // Use minimal INSERT with only required columns that definitely exist
              await query(
                `INSERT INTO mt5_groups (group_id, name, description, synced_at, updated_at)
                 VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                 ON CONFLICT (group_id) 
                 DO UPDATE SET
                   name = EXCLUDED.name,
                   description = EXCLUDED.description,
                   synced_at = CURRENT_TIMESTAMP,
                   updated_at = CURRENT_TIMESTAMP
                `,
                [groupId, generatedName, description]
              );
              successCount++;
              console.log(`[SYNC] Successfully inserted ${groupId} with minimal columns`);
            } catch (minimalError) {
              console.error(`[SYNC] Failed to insert group ${groupId} even with minimal columns:`);
              console.error(`[SYNC] Minimal error message:`, minimalError.message);
              console.error(`[SYNC] Minimal error code:`, minimalError.code);
              console.error(`[SYNC] Minimal error detail:`, minimalError.detail);
              errorCount++;
            }
          }
        }
        
        console.log(`[SYNC] Completed: ${successCount} successful, ${errorCount} failed`);
      }

      const syncedCount = data.length || 0;
      return { 
        success: true, 
        message: syncedCount > 0 
          ? `Synced ${syncedCount} groups successfully` 
          : 'No groups to sync' 
      };
    } catch (error) {
      console.error('[SYNC] Error syncing groups from API:', {
        message: error.message,
        stack: error.stack,
        response: error.response?.data,
        status: error.response?.status
      });
      throw error;
    }
  }

  static async getAll(page = 1, limit = 10) {
    try {
      const offset = (page - 1) * limit;
      // Use COALESCE to handle missing name column gracefully
      const result = await query(
        `SELECT * FROM mt5_groups ORDER BY COALESCE(name, group_id) ASC LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      const countResult = await query('SELECT COUNT(*) FROM mt5_groups');
      const totalCount = parseInt(countResult.rows[0].count) || 0;

      return {
        groups: result.rows || [],
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit)
        }
      };
    } catch (error) {
      console.error('[getAll] Error:', error);
      throw error;
    }
  }

  static async getAllWithoutPagination() {
    try {
      const result = await query(`SELECT * FROM mt5_groups ORDER BY COALESCE(name, group_id) ASC`);
      return result.rows || [];
    } catch (error) {
      console.error('[getAllWithoutPagination] Error:', error);
      return [];
    }
  }

  static async findById(groupId) {
    try {
      const result = await query('SELECT * FROM mt5_groups WHERE group_id = $1', [groupId]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('[findById] Error:', error);
      throw error;
    }
  }

  static async findByIdDbId(dbId) {
    try {
      const result = await query('SELECT * FROM mt5_groups WHERE id = $1', [dbId]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('[findByIdDbId] Error:', error);
      throw error;
    }
  }

  static async getStats() {
    try {
      const totalResult = await query('SELECT COUNT(*) as count FROM mt5_groups');
      const total = parseInt(totalResult.rows[0].count) || 0;

      // Count groups by server - use safe queries that won't fail
      let serverA = 0;
      let serverB = 0;
      let active = 0;

      try {
        const serverAResult = await query(`SELECT COUNT(*) as count FROM mt5_groups WHERE group_id LIKE 'OXO_A%' OR name LIKE 'OXO_A%'`);
        serverA = parseInt(serverAResult.rows[0].count) || 0;
      } catch (error) {
        console.warn('[getStats] Error counting OXO_A groups:', error.message);
      }

      try {
        const serverBResult = await query(`SELECT COUNT(*) as count FROM mt5_groups WHERE group_id LIKE 'OXO_B%' OR name LIKE 'OXO_B%'`);
        serverB = parseInt(serverBResult.rows[0].count) || 0;
      } catch (error) {
        console.warn('[getStats] Error counting OXO_B groups:', error.message);
      }

      // Get active groups - check if synced_at column exists first
      try {
        const checkColumn = await query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'mt5_groups' AND column_name = 'synced_at'
        `);
        const hasSyncedAt = checkColumn.rows.length > 0;
        
        if (hasSyncedAt) {
          const activeResult = await query(`SELECT COUNT(*) as count FROM mt5_groups WHERE synced_at > NOW() - INTERVAL '7 days'`);
          active = parseInt(activeResult.rows[0].count) || 0;
        } else {
          // If synced_at doesn't exist, use updated_at or created_at
          const activeResult = await query(`SELECT COUNT(*) as count FROM mt5_groups WHERE updated_at > NOW() - INTERVAL '7 days' OR created_at > NOW() - INTERVAL '7 days'`);
          active = parseInt(activeResult.rows[0].count) || 0;
        }
      } catch (error) {
        console.warn('[getStats] Error counting active groups:', error.message);
        active = total; // Fallback to total if we can't determine active
      }

      return {
        total_groups: total,
        oxo_a_groups: serverA,
        oxo_b_groups: serverB,
        active_groups: active
      };
    } catch (error) {
      console.error('[getStats] Error:', error);
      // Return safe defaults
      return {
        total_groups: 0,
        oxo_a_groups: 0,
        oxo_b_groups: 0,
        active_groups: 0
      };
    }
  }

  static async searchGroups(searchTerm, page = 1, limit = 50) {
    try {
      const offset = (page - 1) * limit;
      let queryText = `SELECT * FROM mt5_groups WHERE 1=1`;
      const params = [];
      let paramIndex = 1;

      if (searchTerm) {
        // Check if group_path column exists, if not, don't include it in search
        const checkColumn = await query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'mt5_groups' AND column_name = 'group_path'
        `);
        const hasGroupPath = checkColumn.rows.length > 0;
        
        if (hasGroupPath) {
          queryText += ` AND (name ILIKE $${paramIndex} OR group_id ILIKE $${paramIndex} OR group_path ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`;
        } else {
          queryText += ` AND (name ILIKE $${paramIndex} OR group_id ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`;
        }
        params.push(`%${searchTerm}%`);
        paramIndex++;
      }

      // Use COALESCE for created_at to handle if it doesn't exist, fallback to id
      queryText += ` ORDER BY COALESCE(created_at, updated_at, synced_at) DESC NULLS LAST LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);

      const result = await query(queryText, params);
      
      // Build count query safely
      let countQuery = `SELECT COUNT(*) FROM mt5_groups`;
      let countParams = [];
      
      if (searchTerm) {
        const checkColumn = await query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'mt5_groups' AND column_name = 'group_path'
        `);
        const hasGroupPath = checkColumn.rows.length > 0;
        
        if (hasGroupPath) {
          countQuery = `SELECT COUNT(*) FROM mt5_groups WHERE (name ILIKE $1 OR group_id ILIKE $1 OR group_path ILIKE $1 OR description ILIKE $1)`;
        } else {
          countQuery = `SELECT COUNT(*) FROM mt5_groups WHERE (name ILIKE $1 OR group_id ILIKE $1 OR description ILIKE $1)`;
        }
        countParams = [`%${searchTerm}%`];
      }
      
      const countResult = await query(countQuery, countParams);
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
    } catch (error) {
      console.error('[searchGroups] Error:', error);
      throw error;
    }
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