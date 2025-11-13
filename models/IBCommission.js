import { query } from '../config/database.js';

export class IBCommission {
  static async createTable() {
    try {
      const createTableQuery = `
        CREATE TABLE IF NOT EXISTS ib_commission (
          id SERIAL PRIMARY KEY,
          ib_request_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          total_commission NUMERIC(15, 2) DEFAULT 0,
          fixed_commission NUMERIC(15, 2) DEFAULT 0,
          spread_commission NUMERIC(15, 2) DEFAULT 0,
          last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(ib_request_id, user_id),
          CONSTRAINT fk_ib_request FOREIGN KEY (ib_request_id) REFERENCES ib_requests(id) ON DELETE CASCADE,
          CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES "User"(id) ON DELETE CASCADE
        );
      `;
      
      await query(createTableQuery);
      
      // Create indexes for faster lookups
      await query('CREATE INDEX IF NOT EXISTS idx_ib_commission_ib_request ON ib_commission(ib_request_id);');
      await query('CREATE INDEX IF NOT EXISTS idx_ib_commission_user ON ib_commission(user_id);');
      await query('CREATE INDEX IF NOT EXISTS idx_ib_commission_updated ON ib_commission(last_updated);');
      
      console.log('ib_commission table created successfully');
    } catch (error) {
      console.error('Error creating ib_commission table:', error);
      throw error;
    }
  }

  /**
   * Upsert commission data for an IB
   * @param {number} ibRequestId - IB request ID
   * @param {string} userId - User ID (from User table)
   * @param {object} commissionData - { totalCommission, fixedCommission, spreadCommission }
   */
  static async upsertCommission(ibRequestId, userId, commissionData) {
    try {
      const { totalCommission, fixedCommission, spreadCommission } = commissionData;
      
      const upsertQuery = `
        INSERT INTO ib_commission (ib_request_id, user_id, total_commission, fixed_commission, spread_commission, last_updated, updated_at)
        VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (ib_request_id, user_id)
        DO UPDATE SET
          total_commission = EXCLUDED.total_commission,
          fixed_commission = EXCLUDED.fixed_commission,
          spread_commission = EXCLUDED.spread_commission,
          last_updated = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *;
      `;
      
      const result = await query(upsertQuery, [
        ibRequestId,
        userId,
        Number(totalCommission || 0),
        Number(fixedCommission || 0),
        Number(spreadCommission || 0)
      ]);
      
      return result.rows[0];
    } catch (error) {
      console.error('Error upserting commission:', error);
      throw error;
    }
  }

  /**
   * Get commission data for an IB by ib_request_id
   * @param {number} ibRequestId - IB request ID
   */
  static async getByIBRequestId(ibRequestId) {
    try {
      const result = await query(
        'SELECT * FROM ib_commission WHERE ib_request_id = $1 ORDER BY updated_at DESC LIMIT 1',
        [ibRequestId]
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error('Error getting commission by IB request ID:', error);
      throw error;
    }
  }

  /**
   * Get commission data for a user by user_id
   * @param {string} userId - User ID (from User table)
   */
  static async getByUserId(userId) {
    try {
      const result = await query(
        'SELECT * FROM ib_commission WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1',
        [userId]
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error('Error getting commission by user ID:', error);
      throw error;
    }
  }

  /**
   * Get commission data by both ib_request_id and user_id
   * @param {number} ibRequestId - IB request ID
   * @param {string} userId - User ID (from User table)
   */
  static async getByIBAndUser(ibRequestId, userId) {
    try {
      const result = await query(
        'SELECT * FROM ib_commission WHERE ib_request_id = $1 AND user_id = $2',
        [ibRequestId, userId]
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error('Error getting commission by IB and user:', error);
      throw error;
    }
  }
}

