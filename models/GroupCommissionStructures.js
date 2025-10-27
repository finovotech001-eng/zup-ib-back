import { query } from '../config/database.js';

export class GroupCommissionStructures {
  static async createTable() {
    const queryText = `
      CREATE TABLE IF NOT EXISTS group_commission_structures (
        id SERIAL PRIMARY KEY,
        group_id VARCHAR(255) NOT NULL,
        structure_name VARCHAR(100) NOT NULL,
        usd_per_lot DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        spread_share_percentage DECIMAL(5,2) NOT NULL DEFAULT 0.00,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(group_id, structure_name)
      );
    `;
    await query(queryText);
  }

  static async getByGroupId(groupId, page = 1, limit = 10) {
    const offset = (page - 1) * limit;
    const result = await query(
      `
        SELECT * FROM group_commission_structures
        WHERE group_id = $1
        ORDER BY structure_name ASC
        LIMIT $2 OFFSET $3
      `,
      [groupId, limit, offset]
    );

    const countResult = await query(
      'SELECT COUNT(*) FROM group_commission_structures WHERE group_id = $1',
      [groupId]
    );
    const totalCount = parseInt(countResult.rows[0].count);

    return {
      structures: result.rows,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit)
      }
    };
  }

  static async create(groupId, structureData) {
    const { structureName, usdPerLot, spreadSharePercentage } = structureData;

    // Ensure the group exists in mt5_groups table
    const existingGroup = await query('SELECT id FROM mt5_groups WHERE group_id = $1', [groupId]);
    if (existingGroup.rows.length === 0) {
      // If group doesn't exist, insert it (this handles cases where sync didn't capture all groups)
      await query(
        'INSERT INTO mt5_groups (group_id, name, description) VALUES ($1, $2, $3) ON CONFLICT (group_id) DO NOTHING',
        [groupId, groupId, null]
      );
    }

    const result = await query(
      `
        INSERT INTO group_commission_structures (group_id, structure_name, usd_per_lot, spread_share_percentage)
        VALUES ($1, $2, $3, $4)
        RETURNING *;
      `,
      [groupId, structureName, usdPerLot, spreadSharePercentage]
    );

    return result.rows[0];
  }

  static async update(id, updates) {
    const { structureName, usdPerLot, spreadSharePercentage, isActive } = updates;

    const result = await query(
      `
        UPDATE group_commission_structures
        SET structure_name = $2,
            usd_per_lot = $3,
            spread_share_percentage = $4,
            is_active = $5,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *;
      `,
      [id, structureName, usdPerLot, spreadSharePercentage, isActive]
    );

    return result.rows[0];
  }

  static async delete(id) {
    const result = await query(
      'DELETE FROM group_commission_structures WHERE id = $1 RETURNING *;',
      [id]
    );
    return result.rows[0];
  }

  static async findById(id) {
    const result = await query('SELECT * FROM group_commission_structures WHERE id = $1', [id]);
    return result.rows[0];
  }

  static async getAllStructures(page = 1, limit = 10) {
    const offset = (page - 1) * limit;
    const result = await query(
      `
        SELECT gcs.*, mg.name as group_name
        FROM group_commission_structures gcs
        LEFT JOIN mt5_groups mg ON gcs.group_id = mg.group_id
        ORDER BY gcs.group_id, gcs.structure_name
        LIMIT $1 OFFSET $2
      `,
      [limit, offset]
    );

    const countResult = await query('SELECT COUNT(*) FROM group_commission_structures');
    const totalCount = parseInt(countResult.rows[0].count);

    return {
      structures: result.rows,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit)
      }
    };
  }
}