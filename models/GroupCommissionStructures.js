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

    // Ensure new columns exist (level order + qualification criteria)
    await query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'group_commission_structures' AND column_name = 'level_order'
        ) THEN
          ALTER TABLE group_commission_structures ADD COLUMN level_order INTEGER DEFAULT 1;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'group_commission_structures' AND column_name = 'min_trading_volume'
        ) THEN
          ALTER TABLE group_commission_structures ADD COLUMN min_trading_volume DECIMAL(12,2);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'group_commission_structures' AND column_name = 'max_trading_volume'
        ) THEN
          ALTER TABLE group_commission_structures ADD COLUMN max_trading_volume DECIMAL(12,2);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'group_commission_structures' AND column_name = 'min_active_clients'
        ) THEN
          ALTER TABLE group_commission_structures ADD COLUMN min_active_clients INTEGER;
        END IF;
      END $$;
    `);

    // Make level_order NOT NULL with default for uniqueness and ordering
    await query(`ALTER TABLE group_commission_structures ALTER COLUMN level_order SET DEFAULT 1;`).catch(()=>{});
    await query(`ALTER TABLE group_commission_structures ALTER COLUMN level_order SET NOT NULL;`).catch(()=>{});

    // Helpful indexes
    await query(`CREATE INDEX IF NOT EXISTS idx_commission_structures_level_order ON group_commission_structures(level_order);`).catch(()=>{});
    await query(`CREATE INDEX IF NOT EXISTS idx_commission_structures_group ON group_commission_structures(group_id);`).catch(()=>{});
    // Enforce unique level per group
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_commission_group_level ON group_commission_structures(group_id, level_order);`).catch(()=>{});
  }

  static async getByGroupId(groupId, page = 1, limit = 10) {
    const offset = (page - 1) * limit;
    const result = await query(
      `
        SELECT * FROM group_commission_structures
        WHERE group_id = $1
        ORDER BY level_order ASC, structure_name ASC
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
    const { structureName, usdPerLot, spreadSharePercentage, levelOrder = 1, minTradingVolume = 0, maxTradingVolume = null, minActiveClients = 0 } = structureData;

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
        INSERT INTO group_commission_structures (
          group_id, structure_name, usd_per_lot, spread_share_percentage,
          level_order, min_trading_volume, max_trading_volume, min_active_clients
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *;
      `,
      [groupId, structureName, usdPerLot, spreadSharePercentage, levelOrder, minTradingVolume, maxTradingVolume, minActiveClients]
    );

    return result.rows[0];
  }

  static async update(id, updates) {
    const { structureName, usdPerLot, spreadSharePercentage, isActive, levelOrder = null, minTradingVolume = null, maxTradingVolume = null, minActiveClients = null } = updates;

    const result = await query(
      `
        UPDATE group_commission_structures
        SET structure_name = $2,
            usd_per_lot = $3,
            spread_share_percentage = $4,
            is_active = $5,
            level_order = COALESCE($6, level_order),
            min_trading_volume = COALESCE($7, min_trading_volume),
            max_trading_volume = COALESCE($8, max_trading_volume),
            min_active_clients = COALESCE($9, min_active_clients),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *;
      `,
      [id, structureName, usdPerLot, spreadSharePercentage, isActive, levelOrder, minTradingVolume, maxTradingVolume, minActiveClients]
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
