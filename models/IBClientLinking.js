import { query } from '../config/database.js';

export class IBClientLinking {
  static async createTable() {
    try {
      // Main linking table - current active linkings
      await query(`
        CREATE TABLE IF NOT EXISTS ib_client_linking (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL,
          user_name VARCHAR(255) NOT NULL,
          user_email VARCHAR(255) NOT NULL,
          user_account_id TEXT,
          current_ib_id INTEGER,
          current_ib_name VARCHAR(255),
          current_ib_code VARCHAR(100),
          assigned_ib_id INTEGER NOT NULL,
          assigned_ib_name VARCHAR(255) NOT NULL,
          assigned_ib_code VARCHAR(100),
          assigned_ib_email VARCHAR(255),
          status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'pending')),
          direct_volume_lots DECIMAL(15, 2) DEFAULT 0.00,
          direct_commission DECIMAL(15, 2) DEFAULT 0.00,
          linked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          created_by INTEGER,
          UNIQUE(user_id, assigned_ib_id, status) 
        )
      `);

      // History table - tracks all linking changes
      await query(`
        CREATE TABLE IF NOT EXISTS ib_client_linking_history (
          id SERIAL PRIMARY KEY,
          linking_id INTEGER REFERENCES ib_client_linking(id) ON DELETE SET NULL,
          user_id INTEGER NOT NULL,
          user_name VARCHAR(255) NOT NULL,
          user_email VARCHAR(255) NOT NULL,
          from_ib_id INTEGER,
          from_ib_name VARCHAR(255),
          from_ib_code VARCHAR(100),
          to_ib_id INTEGER NOT NULL,
          to_ib_name VARCHAR(255) NOT NULL,
          to_ib_code VARCHAR(100),
          action VARCHAR(20) NOT NULL CHECK (action IN ('created', 'updated', 'moved', 'deleted', 'activated', 'deactivated')),
          moved_by INTEGER,
          moved_by_name VARCHAR(255),
          notes TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create indexes for better query performance
      await query(`
        CREATE INDEX IF NOT EXISTS idx_ib_client_linking_user_id ON ib_client_linking(user_id)
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS idx_ib_client_linking_assigned_ib_id ON ib_client_linking(assigned_ib_id)
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS idx_ib_client_linking_status ON ib_client_linking(status)
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS idx_ib_client_linking_history_user_id ON ib_client_linking_history(user_id)
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS idx_ib_client_linking_history_linking_id ON ib_client_linking_history(linking_id)
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS idx_ib_client_linking_history_created_at ON ib_client_linking_history(created_at DESC)
      `);

      console.log('ib_client_linking tables created successfully');
    } catch (error) {
      console.error('Error creating ib_client_linking tables:', error);
      throw error;
    }
  }

  // Get current linking for a user
  static async findByUserId(userId) {
    try {
      const result = await query(`
        SELECT * FROM ib_client_linking 
        WHERE user_id = $1 AND status = 'active'
        ORDER BY linked_at DESC
        LIMIT 1
      `, [userId]);

      return result.rows[0] || null;
    } catch (error) {
      console.error('Error finding linking by user ID:', error);
      throw error;
    }
  }

  // Create or update client linking (move user to another IB)
  static async createOrUpdateLinking(data) {
    try {
      const {
        user_id,
        user_name,
        user_email,
        user_account_id,
        assigned_ib_id,
        assigned_ib_name,
        assigned_ib_code,
        assigned_ib_email,
        created_by,
        moved_by,
        moved_by_name,
        notes
      } = data;

      // Get current linking if exists
      const currentLinking = await this.findByUserId(user_id);
      const from_ib_id = currentLinking?.assigned_ib_id || null;
      const from_ib_name = currentLinking?.assigned_ib_name || null;
      const from_ib_code = currentLinking?.assigned_ib_code || null;

      // Deactivate old linking if exists
      if (currentLinking && currentLinking.id) {
        await query(`
          UPDATE ib_client_linking 
          SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [currentLinking.id]);

        // Record history for deactivation
        await query(`
          INSERT INTO ib_client_linking_history (
            linking_id, user_id, user_name, user_email,
            from_ib_id, from_ib_name, from_ib_code,
            to_ib_id, to_ib_name, to_ib_code,
            action, moved_by, moved_by_name, notes
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        `, [
          currentLinking.id,
          user_id,
          user_name,
          user_email,
          from_ib_id,
          from_ib_name,
          from_ib_code,
          assigned_ib_id,
          assigned_ib_name,
          assigned_ib_code,
          'moved',
          moved_by,
          moved_by_name,
          notes || `Moved from ${from_ib_name || 'None'} to ${assigned_ib_name}`
        ]);
      }

      // Create new linking
      const result = await query(`
        INSERT INTO ib_client_linking (
          user_id, user_name, user_email, user_account_id,
          current_ib_id, current_ib_name, current_ib_code,
          assigned_ib_id, assigned_ib_name, assigned_ib_code, assigned_ib_email,
          status, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (user_id, assigned_ib_id, status) 
        DO UPDATE SET
          status = 'active',
          updated_at = CURRENT_TIMESTAMP
        RETURNING *
      `, [
        user_id,
        user_name,
        user_email,
        user_account_id || null,
        from_ib_id,
        from_ib_name,
        from_ib_code,
        assigned_ib_id,
        assigned_ib_name,
        assigned_ib_code || null,
        assigned_ib_email || null,
        'active',
        created_by || null
      ]);

      const newLinking = result.rows[0];

      // Record history for new linking
      await query(`
        INSERT INTO ib_client_linking_history (
          linking_id, user_id, user_name, user_email,
          from_ib_id, from_ib_name, from_ib_code,
          to_ib_id, to_ib_name, to_ib_code,
          action, moved_by, moved_by_name, notes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      `, [
        newLinking.id,
        user_id,
        user_name,
        user_email,
        from_ib_id,
        from_ib_name,
        from_ib_code,
        assigned_ib_id,
        assigned_ib_name,
        assigned_ib_code,
        currentLinking ? 'moved' : 'created',
        moved_by,
        moved_by_name,
        notes || (currentLinking ? `Moved from ${from_ib_name || 'None'} to ${assigned_ib_name}` : `Linked to ${assigned_ib_name}`)
      ]);

      return newLinking;
    } catch (error) {
      console.error('Error creating/updating linking:', error);
      throw error;
    }
  }

  // Get all linkings with filters
  static async findAll(filters = {}) {
    try {
      let whereClauses = [];
      let params = [];
      let paramIndex = 1;

      if (filters.status && filters.status !== 'all') {
        whereClauses.push(`status = $${paramIndex}`);
        params.push(filters.status);
        paramIndex++;
      }

      if (filters.ib_id && filters.ib_id !== 'all') {
        whereClauses.push(`assigned_ib_id = $${paramIndex}`);
        params.push(filters.ib_id);
        paramIndex++;
      }

      if (filters.search) {
        whereClauses.push(`(
          user_name ILIKE $${paramIndex} OR 
          user_email ILIKE $${paramIndex} OR 
          user_account_id ILIKE $${paramIndex} OR
          assigned_ib_name ILIKE $${paramIndex} OR
          assigned_ib_code ILIKE $${paramIndex}
        )`);
        params.push(`%${filters.search}%`);
        paramIndex++;
      }

      const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      const page = parseInt(filters.page) || 1;
      const limit = parseInt(filters.limit) || 50;
      const offset = (page - 1) * limit;

      // Get total count
      const countResult = await query(`
        SELECT COUNT(*) FROM ib_client_linking ${whereSQL}
      `, params);
      const totalCount = parseInt(countResult.rows[0].count);

      // Get paginated data
      const result = await query(`
        SELECT * FROM ib_client_linking 
        ${whereSQL}
        ORDER BY linked_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `, [...params, limit, offset]);

      return {
        linkings: result.rows,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit)
        }
      };
    } catch (error) {
      console.error('Error fetching linkings:', error);
      throw error;
    }
  }

  // Get linking history
  static async getHistory(filters = {}) {
    try {
      let whereClauses = [];
      let params = [];
      let paramIndex = 1;

      if (filters.user_id) {
        whereClauses.push(`user_id = $${paramIndex}`);
        params.push(filters.user_id);
        paramIndex++;
      }

      if (filters.linking_id) {
        whereClauses.push(`linking_id = $${paramIndex}`);
        params.push(filters.linking_id);
        paramIndex++;
      }

      const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      const page = parseInt(filters.page) || 1;
      const limit = parseInt(filters.limit) || 50;
      const offset = (page - 1) * limit;

      // Get total count
      const countResult = await query(`
        SELECT COUNT(*) FROM ib_client_linking_history ${whereSQL}
      `, params);
      const totalCount = parseInt(countResult.rows[0].count);

      // Get paginated data
      const result = await query(`
        SELECT * FROM ib_client_linking_history 
        ${whereSQL}
        ORDER BY created_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `, [...params, limit, offset]);

      return {
        history: result.rows,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit)
        }
      };
    } catch (error) {
      console.error('Error fetching linking history:', error);
      throw error;
    }
  }

  // Update direct volume and commission
  static async updateVolume(userId, volumeLots, commission) {
    try {
      await query(`
        UPDATE ib_client_linking 
        SET 
          direct_volume_lots = $1,
          direct_commission = $2,
          updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $3 AND status = 'active'
      `, [volumeLots, commission, userId]);

      return true;
    } catch (error) {
      console.error('Error updating volume:', error);
      throw error;
    }
  }

  // Delete/link user from IB
  static async deleteLinking(id, deletedBy, deletedByName) {
    try {
      // Get linking before deletion
      const linkingResult = await query(`
        SELECT * FROM ib_client_linking WHERE id = $1
      `, [id]);

      if (linkingResult.rows.length === 0) {
        throw new Error('Linking not found');
      }

      const linking = linkingResult.rows[0];

      // Record history before deletion
      await query(`
        INSERT INTO ib_client_linking_history (
          linking_id, user_id, user_name, user_email,
          from_ib_id, from_ib_name, from_ib_code,
          to_ib_id, to_ib_name, to_ib_code,
          action, moved_by, moved_by_name
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `, [
        linking.id,
        linking.user_id,
        linking.user_name,
        linking.user_email,
        linking.assigned_ib_id,
        linking.assigned_ib_name,
        linking.assigned_ib_code,
        linking.assigned_ib_id,
        linking.assigned_ib_name,
        linking.assigned_ib_code,
        'deleted',
        deletedBy,
        deletedByName
      ]);

      // Soft delete (set status to inactive)
      await query(`
        UPDATE ib_client_linking 
        SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [id]);

      return true;
    } catch (error) {
      console.error('Error deleting linking:', error);
      throw error;
    }
  }

  // Get stats
  static async getStats() {
    try {
      const result = await query(`
        SELECT
          COUNT(*) as total_linkings,
          COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
          COUNT(CASE WHEN status = 'inactive' THEN 1 END) as inactive,
          COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending
        FROM ib_client_linking
      `);

      return result.rows[0] || {
        total_linkings: 0,
        active: 0,
        inactive: 0,
        pending: 0
      };
    } catch (error) {
      console.error('Error fetching stats:', error);
      throw error;
    }
  }
}

