import { query } from '../config/database.js';

export class IBRewardClaim {
  static async createTable() {
    try {
      // Check if table exists first
      const checkTableQuery = `
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'ib_reward_claims'
        );
      `;
      const checkResult = await query(checkTableQuery);
      const tableExists = checkResult.rows[0]?.exists;

      if (!tableExists) {
        const createTableQuery = `
          CREATE TABLE ib_reward_claims (
            id SERIAL PRIMARY KEY,
            ib_request_id INTEGER NOT NULL,
            user_id VARCHAR(255) NOT NULL,
            reward_id INTEGER NOT NULL,
            reward_value VARCHAR(50) NOT NULL,
            reward_description VARCHAR(255) NOT NULL,
            reward_type VARCHAR(50) NOT NULL,
            claimant_name VARCHAR(255) NOT NULL,
            claimant_phone VARCHAR(50) NOT NULL,
            claimant_email VARCHAR(255) NOT NULL,
            claimant_address_street TEXT,
            claimant_address_city VARCHAR(100),
            claimant_address_state VARCHAR(100),
            claimant_address_country VARCHAR(100),
            claimant_address_postal_code VARCHAR(50),
            status VARCHAR(50) NOT NULL DEFAULT 'pending',
            total_volume_mln NUMERIC(15, 2) NOT NULL,
            admin_notes TEXT,
            claimed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(ib_request_id, reward_id)
          );
        `;
        
        await query(createTableQuery);
        
        // Create indexes for faster lookups
        await query('CREATE INDEX IF NOT EXISTS idx_ib_reward_claims_ib_request ON ib_reward_claims(ib_request_id);');
        await query('CREATE INDEX IF NOT EXISTS idx_ib_reward_claims_user ON ib_reward_claims(user_id);');
        await query('CREATE INDEX IF NOT EXISTS idx_ib_reward_claims_status ON ib_reward_claims(status);');
        await query('CREATE INDEX IF NOT EXISTS idx_ib_reward_claims_claimed_at ON ib_reward_claims(claimed_at);');
        await query('CREATE INDEX IF NOT EXISTS idx_ib_reward_claims_reward_id ON ib_reward_claims(reward_id);');
        
        // Try to add foreign keys if they don't exist
        try {
          await query('ALTER TABLE ib_reward_claims ADD CONSTRAINT fk_ib_reward_claims_ib_request FOREIGN KEY (ib_request_id) REFERENCES ib_requests(id) ON DELETE CASCADE;');
        } catch (e) {
          console.warn('Could not add foreign key fk_ib_reward_claims_ib_request (may already exist):', e.message);
        }
        
        try {
          await query('ALTER TABLE ib_reward_claims ADD CONSTRAINT fk_ib_reward_claims_user FOREIGN KEY (user_id) REFERENCES "User"(id) ON DELETE CASCADE;');
        } catch (e) {
          console.warn('Could not add foreign key fk_ib_reward_claims_user (may already exist):', e.message);
        }
        
        console.log('ib_reward_claims table created successfully');
      } else {
        console.log('ib_reward_claims table already exists');
      }
    } catch (error) {
      console.error('Error creating ib_reward_claims table:', error);
      console.error('Error stack:', error.stack);
    }
  }

  /**
   * Create a new reward claim
   * @param {number} ibRequestId - IB request ID
   * @param {string} userId - User ID (from User table)
   * @param {object} rewardData - { id, value, description, type }
   * @param {object} claimantData - { name, phone, email, address: { street, city, state, country, postalCode } }
   * @param {number} totalVolumeMln - Total volume in millions USD at time of claim
   */
  static async createClaim(ibRequestId, userId, rewardData, claimantData, totalVolumeMln) {
    try {
      await this.createTable();
      
      const {
        id: rewardId,
        value: rewardValue,
        description: rewardDescription,
        type: rewardType
      } = rewardData;
      
      const {
        name: claimantName,
        phone: claimantPhone,
        email: claimantEmail,
        address = {}
      } = claimantData;
      
      const {
        street: addressStreet,
        city: addressCity,
        state: addressState,
        country: addressCountry,
        postalCode: addressPostalCode
      } = address;
      
      const insertQuery = `
        INSERT INTO ib_reward_claims (
          ib_request_id, user_id, reward_id, reward_value, reward_description, reward_type,
          claimant_name, claimant_phone, claimant_email,
          claimant_address_street, claimant_address_city, claimant_address_state,
          claimant_address_country, claimant_address_postal_code,
          status, total_volume_mln, claimed_at, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'pending', $15, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (ib_request_id, reward_id)
        DO UPDATE SET
          claimant_name = EXCLUDED.claimant_name,
          claimant_phone = EXCLUDED.claimant_phone,
          claimant_email = EXCLUDED.claimant_email,
          claimant_address_street = EXCLUDED.claimant_address_street,
          claimant_address_city = EXCLUDED.claimant_address_city,
          claimant_address_state = EXCLUDED.claimant_address_state,
          claimant_address_country = EXCLUDED.claimant_address_country,
          claimant_address_postal_code = EXCLUDED.claimant_address_postal_code,
          total_volume_mln = EXCLUDED.total_volume_mln,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *;
      `;
      
      const result = await query(insertQuery, [
        ibRequestId,
        userId,
        rewardId,
        rewardValue,
        rewardDescription,
        rewardType,
        claimantName,
        claimantPhone,
        claimantEmail,
        addressStreet || null,
        addressCity || null,
        addressState || null,
        addressCountry || null,
        addressPostalCode || null,
        Number(totalVolumeMln || 0)
      ]);
      
      return result.rows[0];
    } catch (error) {
      console.error('[IBRewardClaim] Error creating claim:', error);
      console.error('[IBRewardClaim] Error message:', error.message);
      console.error('[IBRewardClaim] Error stack:', error.stack);
      throw error;
    }
  }

  /**
   * Get all claims for an IB
   * @param {number} ibRequestId - IB request ID
   */
  static async getByIB(ibRequestId) {
    try {
      // Ensure table exists first
      await this.createTable();
      
      const result = await query(
        'SELECT * FROM ib_reward_claims WHERE ib_request_id = $1 ORDER BY claimed_at DESC',
        [ibRequestId]
      );
      return result.rows;
    } catch (error) {
      console.error('Error getting claims by IB:', error);
      // Return empty array if table doesn't exist or query fails
      return [];
    }
  }

  /**
   * Get all claims for a user
   * @param {string} userId - User ID (from User table)
   */
  static async getByUser(userId) {
    try {
      // Ensure table exists first
      await this.createTable();
      
      const result = await query(
        'SELECT * FROM ib_reward_claims WHERE user_id = $1 ORDER BY claimed_at DESC',
        [userId]
      );
      return result.rows;
    } catch (error) {
      console.error('Error getting claims by user:', error);
      // Return empty array if table doesn't exist or query fails
      return [];
    }
  }

  /**
   * Get all claims with optional filters
   * @param {object} filters - { status, ibRequestId, dateFrom, dateTo, page, pageSize }
   */
  static async getAll(filters = {}) {
    try {
      const {
        status,
        ibRequestId,
        dateFrom,
        dateTo,
        page = 1,
        pageSize = 50
      } = filters;
      
      let whereConditions = [];
      let params = [];
      let paramIndex = 1;
      
      if (status) {
        whereConditions.push(`status = $${paramIndex}`);
        params.push(status);
        paramIndex++;
      }
      
      if (ibRequestId) {
        whereConditions.push(`ib_request_id = $${paramIndex}`);
        params.push(ibRequestId);
        paramIndex++;
      }
      
      if (dateFrom) {
        whereConditions.push(`claimed_at >= $${paramIndex}`);
        params.push(dateFrom);
        paramIndex++;
      }
      
      if (dateTo) {
        whereConditions.push(`claimed_at <= $${paramIndex}`);
        params.push(dateTo);
        paramIndex++;
      }
      
      const whereClause = whereConditions.length > 0 
        ? `WHERE ${whereConditions.join(' AND ')}`
        : '';
      
      // Get total count
      const countQuery = `SELECT COUNT(*) as total FROM ib_reward_claims ${whereClause}`;
      const countResult = await query(countQuery, params);
      const total = Number(countResult.rows[0]?.total || 0);
      
      // Get paginated results
      const offset = (page - 1) * pageSize;
      params.push(pageSize, offset);
      const dataQuery = `
        SELECT * FROM ib_reward_claims 
        ${whereClause}
        ORDER BY claimed_at DESC 
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;
      const dataResult = await query(dataQuery, params);
      
      return {
        claims: dataResult.rows,
        total,
        page: Number(page),
        pageSize: Number(pageSize),
        totalPages: Math.ceil(total / pageSize)
      };
    } catch (error) {
      console.error('Error getting all claims:', error);
      throw error;
    }
  }

  /**
   * Update claim status
   * @param {number} id - Claim ID
   * @param {string} status - New status ('pending', 'approved', 'fulfilled', 'rejected')
   * @param {string} adminNotes - Optional admin notes
   */
  static async updateStatus(id, status, adminNotes = null) {
    try {
      const updateQuery = `
        UPDATE ib_reward_claims
        SET status = $1,
            admin_notes = COALESCE($2, admin_notes),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
        RETURNING *;
      `;
      
      const result = await query(updateQuery, [status, adminNotes, id]);
      return result.rows[0];
    } catch (error) {
      console.error('Error updating claim status:', error);
      throw error;
    }
  }

  /**
   * Get single claim by ID
   * @param {number} id - Claim ID
   */
  static async getById(id) {
    try {
      const result = await query(
        'SELECT * FROM ib_reward_claims WHERE id = $1',
        [id]
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error('Error getting claim by ID:', error);
      throw error;
    }
  }

  /**
   * Check if a reward has already been claimed by an IB
   * @param {number} ibRequestId - IB request ID
   * @param {number} rewardId - Reward ID
   */
  static async isClaimed(ibRequestId, rewardId) {
    try {
      const result = await query(
        'SELECT id FROM ib_reward_claims WHERE ib_request_id = $1 AND reward_id = $2 LIMIT 1',
        [ibRequestId, rewardId]
      );
      return result.rows.length > 0;
    } catch (error) {
      console.error('Error checking if reward is claimed:', error);
      return false;
    }
  }
}

