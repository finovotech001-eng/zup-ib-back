import { query } from '../config/database.js';

export class IBCommission {
  static async createTable() {
    try {
      // Check if table exists first
      const checkTableQuery = `
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'ib_commission'
        );
      `;
      const checkResult = await query(checkTableQuery);
      const tableExists = checkResult.rows[0]?.exists;

      if (!tableExists) {
        const createTableQuery = `
          CREATE TABLE ib_commission (
            id SERIAL PRIMARY KEY,
            ib_request_id INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            total_commission NUMERIC(15, 2) DEFAULT 0,
            fixed_commission NUMERIC(15, 2) DEFAULT 0,
            spread_commission NUMERIC(15, 2) DEFAULT 0,
            total_trades INTEGER DEFAULT 0,
            total_lots NUMERIC(15, 2) DEFAULT 0,
            last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(ib_request_id, user_id)
          );
        `;
        
        await query(createTableQuery);
        
        // Create indexes for faster lookups
        await query('CREATE INDEX IF NOT EXISTS idx_ib_commission_ib_request ON ib_commission(ib_request_id);');
        await query('CREATE INDEX IF NOT EXISTS idx_ib_commission_user ON ib_commission(user_id);');
        await query('CREATE INDEX IF NOT EXISTS idx_ib_commission_updated ON ib_commission(last_updated);');
        
        // Try to add foreign keys if they don't exist (may fail if tables don't exist, that's ok)
        try {
          await query('ALTER TABLE ib_commission ADD CONSTRAINT fk_ib_request FOREIGN KEY (ib_request_id) REFERENCES ib_requests(id) ON DELETE CASCADE;');
        } catch (e) {
          console.warn('Could not add foreign key fk_ib_request (may already exist):', e.message);
        }
        
        try {
          await query('ALTER TABLE ib_commission ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES "User"(id) ON DELETE CASCADE;');
        } catch (e) {
          console.warn('Could not add foreign key fk_user (may already exist):', e.message);
        }
        
        console.log('ib_commission table created successfully');
      } else {
        console.log('ib_commission table already exists');
      }
    } catch (error) {
      console.error('Error creating ib_commission table:', error);
      console.error('Error stack:', error.stack);
      // Don't throw - allow the operation to continue even if table creation fails
      // The actual query will fail with a better error message
    }
  }

  /**
   * Upsert commission data for an IB
   * @param {number} ibRequestId - IB request ID
   * @param {string} userId - User ID (from User table)
   * @param {object} commissionData - { totalCommission, totalTrades, totalLots }
   */
  static async upsertCommission(ibRequestId, userId, commissionData) {
    try {
      // Ensure table exists first
      await this.createTable();
      
      // Ensure all columns exist (add if missing)
      try {
        await query('ALTER TABLE ib_commission ADD COLUMN IF NOT EXISTS fixed_commission NUMERIC(15, 2) DEFAULT 0;');
        await query('ALTER TABLE ib_commission ADD COLUMN IF NOT EXISTS spread_commission NUMERIC(15, 2) DEFAULT 0;');
        await query('ALTER TABLE ib_commission ADD COLUMN IF NOT EXISTS total_trades INTEGER DEFAULT 0;');
        await query('ALTER TABLE ib_commission ADD COLUMN IF NOT EXISTS total_lots NUMERIC(15, 2) DEFAULT 0;');
      } catch (alterError) {
        console.warn('[IBCommission] Could not alter table structure:', alterError.message);
        // Continue anyway, will try the insert
      }
      
      const { totalCommission, fixedCommission, spreadCommission, totalTrades, totalLots } = commissionData;
      
      const upsertQuery = `
        INSERT INTO ib_commission (ib_request_id, user_id, total_commission, fixed_commission, spread_commission, total_trades, total_lots, last_updated, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (ib_request_id, user_id)
        DO UPDATE SET
          total_commission = EXCLUDED.total_commission,
          fixed_commission = EXCLUDED.fixed_commission,
          spread_commission = EXCLUDED.spread_commission,
          total_trades = EXCLUDED.total_trades,
          total_lots = EXCLUDED.total_lots,
          last_updated = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *;
      `;
      
      console.log(`[IBCommission] Upserting: ib_request_id=${ibRequestId}, user_id=${userId}, total_commission=${totalCommission}, fixed_commission=${fixedCommission || 0}, spread_commission=${spreadCommission || 0}, total_trades=${totalTrades || 0}, total_lots=${totalLots || 0}`);
      
      const result = await query(upsertQuery, [
        ibRequestId,
        userId,
        Number(totalCommission || 0),
        Number(fixedCommission || 0),
        Number(spreadCommission || 0),
        Number(totalTrades || 0),
        Number(totalLots || 0)
      ]);
      
      console.log(`[IBCommission] Upsert successful, returned row:`, result.rows[0]);
      return result.rows[0];
    } catch (error) {
      console.error('[IBCommission] Error upserting commission:', error);
      console.error('[IBCommission] Error message:', error.message);
      console.error('[IBCommission] Error stack:', error.stack);
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

