import { query } from '../config/database.js';
import bcrypt from 'bcryptjs';
import { MT5Groups } from './MT5Groups.js';
import { GroupCommissionStructures } from './GroupCommissionStructures.js';

const STATUS_VALUES = ['pending', 'approved', 'rejected', 'banned'];
const IB_TYPE_VALUES = ['common', 'advanced', 'bronze', 'silver', 'gold', 'platinum', 'brilliant'];

export const IB_REQUEST_STATUS_VALUES = Object.freeze([...STATUS_VALUES]);
export const IB_REQUEST_TYPE_VALUES = Object.freeze([...IB_TYPE_VALUES]);

export class IBRequest {
  static async createTable() {
    const queryText = `
      CREATE TABLE IF NOT EXISTS ib_requests (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','banned')),
        ib_type VARCHAR(255),
        submitted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        approved_at TIMESTAMP WITH TIME ZONE,
        usd_per_lot DECIMAL(10,2),
        spread_percentage_per_lot DECIMAL(5,2),
        admin_comments TEXT,
        group_id VARCHAR(255),
        structure_id INTEGER,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await query(queryText);

    // Add new columns if they don't exist
    await query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'ib_requests' AND column_name = 'group_id'
        ) THEN
          ALTER TABLE ib_requests ADD COLUMN group_id VARCHAR(255);
        END IF;
      END $$;
    `);

    await query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'ib_requests' AND column_name = 'structure_id'
        ) THEN
          ALTER TABLE ib_requests ADD COLUMN structure_id INTEGER;
        END IF;
      END $$;
    `);

    // Add referral_code column if it doesn't exist
    await query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'ib_requests' AND column_name = 'referral_code'
        ) THEN
          ALTER TABLE ib_requests ADD COLUMN referral_code VARCHAR(8) UNIQUE;
          CREATE INDEX IF NOT EXISTS idx_ib_requests_referral_code ON ib_requests(referral_code);
        END IF;
      END $$;
    `);

    // Add referred_by column if it doesn't exist
    await query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'ib_requests' AND column_name = 'referred_by'
        ) THEN
          ALTER TABLE ib_requests ADD COLUMN referred_by INTEGER REFERENCES ib_requests(id) ON DELETE SET NULL;
          CREATE INDEX IF NOT EXISTS idx_ib_requests_referred_by ON ib_requests(referred_by);
        END IF;
      END $$;
    `);

    // Normalize existing data to align with enforced constraints
    const allowedStatusesList = STATUS_VALUES.map((status) => `'${status}'`).join(', ');
    const allowedIbTypesList = IB_TYPE_VALUES.map((type) => `'${type}'`).join(', ');

    await query(`
      UPDATE ib_requests
      SET status = LOWER(TRIM(status))
      WHERE status IS NOT NULL AND status <> LOWER(TRIM(status));
    `);

    await query(`
      UPDATE ib_requests
      SET status = 'pending'
      WHERE status IS NULL OR LOWER(TRIM(status)) NOT IN (${allowedStatusesList});
    `);

    await query(`
      UPDATE ib_requests
      SET ib_type = LOWER(TRIM(ib_type))
      WHERE ib_type IS NOT NULL AND ib_type <> LOWER(TRIM(ib_type));
    `);

    await query(`
      UPDATE ib_requests
      SET ib_type = 'common'
      WHERE ib_type IS NULL OR LOWER(TRIM(ib_type)) NOT IN (${allowedIbTypesList});
    `);

    await query(`ALTER TABLE ib_requests ALTER COLUMN status SET DEFAULT 'pending';`);
    await query(`ALTER TABLE ib_requests ALTER COLUMN status SET NOT NULL;`);
    await query(`ALTER TABLE ib_requests ALTER COLUMN ib_type SET DEFAULT 'common';`);
    await query(`ALTER TABLE ib_requests ALTER COLUMN ib_type SET NOT NULL;`);

    await query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_type = 'CHECK'
            AND constraint_name = 'ib_requests_status_check'
            AND table_name = 'ib_requests'
        ) THEN
          ALTER TABLE ib_requests
            ADD CONSTRAINT ib_requests_status_check
            CHECK (status IN (${allowedStatusesList}));
        END IF;
      END
      $$;
    `);

    await query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_type = 'CHECK'
            AND constraint_name = 'ib_requests_type_check'
            AND table_name = 'ib_requests'
        ) THEN
          NULL;
        END IF;
      END$$;
    `);


    // Create mt5_groups table
    await MT5Groups.createTable();

    // Create group_commission_structures table
    await GroupCommissionStructures.createTable();
  }


  static async create(requestData) {
    const { fullName, email, password, ibType, referredBy } = requestData;
    const passwordHash = await bcrypt.hash(password, 12);

    const queryText = `
      INSERT INTO ib_requests (full_name, email, password_hash, ib_type, referred_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;

    const normalizedType = typeof ibType === 'string' ? ibType.toLowerCase() : null;
    const finalType = IB_TYPE_VALUES.includes(normalizedType) ? normalizedType : 'common';

    const result = await query(queryText, [
      fullName,
      email,
      passwordHash,
      finalType,
      referredBy || null
    ]);

    return IBRequest.stripSensitiveFields(result.rows[0]);
  }

  /**
   * Find IB by referral code
   * @param {string} referralCode - The referral code to search for
   * @returns {Promise<Object|null>} IB request or null if not found
   */
  static async findByReferralCode(referralCode) {
    if (!referralCode || typeof referralCode !== 'string') {
      return null;
    }

    const result = await query(
      'SELECT id, full_name, email, status, referral_code FROM ib_requests WHERE referral_code = $1 AND LOWER(TRIM(status)) = $2',
      [referralCode.trim().toUpperCase(), 'approved']
    );

    return result.rows.length > 0 ? IBRequest.stripSensitiveFields(result.rows[0]) : null;
  }

  static async updateApplication(id, updateData) {
    const { fullName, password, ibType, referredBy } = updateData;
    const passwordHash = await bcrypt.hash(password, 12);

    const normalizedType = typeof ibType === 'string' ? ibType.toLowerCase() : null;
    const finalType = IB_TYPE_VALUES.includes(normalizedType) ? normalizedType : 'common';

    // Build query dynamically based on whether referredBy is provided
    let queryText;
    let params;
    
    if (referredBy !== undefined) {
      queryText = `
        UPDATE ib_requests
        SET full_name = $1,
            password_hash = $2,
            ib_type = $3,
            referred_by = COALESCE($5, referred_by),
            status = 'pending',
            admin_comments = NULL,
            approved_at = NULL,
            usd_per_lot = NULL,
            spread_percentage_per_lot = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $4
        RETURNING *;
      `;
      params = [fullName, passwordHash, finalType, id, referredBy || null];
    } else {
      queryText = `
        UPDATE ib_requests
        SET full_name = $1,
            password_hash = $2,
            ib_type = $3,
            status = 'pending',
            admin_comments = NULL,
            approved_at = NULL,
            usd_per_lot = NULL,
            spread_percentage_per_lot = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $4
        RETURNING *;
      `;
      params = [fullName, passwordHash, finalType, id];
    }

    const result = await query(queryText, params);

    return IBRequest.stripSensitiveFields(result.rows[0]);
  }

  static async findById(id) {
    const result = await query('SELECT * FROM ib_requests WHERE id = $1;', [id]);
    return result.rows[0];
  }

  static async findByEmail(email) {
    const result = await query(
      `
        SELECT *
        FROM ib_requests
        WHERE email = $1
        ORDER BY submitted_at DESC
        LIMIT 1;
      `,
      [email]
    );
    return result.rows[0];
  }

  static async findAll(limit = 50, offset = 0) {
    const result = await query(
      `
        SELECT *
        FROM ib_requests
        ORDER BY submitted_at DESC
        LIMIT $1 OFFSET $2;
      `,
      [limit, offset]
    );
    return result.rows.map((record) => IBRequest.stripSensitiveFields(record));
  }

  static async updateStatus(id, status, adminComments, usdPerLot, spreadPercentagePerLot, ibType, groupId, structureId) {
    // Generate referral code if status is being changed to 'approved' and code doesn't exist
    let referralCode = null;
    if (status === 'approved') {
      // Check if referral code already exists
      const existing = await query('SELECT referral_code FROM ib_requests WHERE id = $1', [id]);
      if (!existing.rows[0]?.referral_code) {
        referralCode = await IBRequest.generateReferralCode(id);
      }
    }

    const result = await query(
      `
        UPDATE ib_requests
        SET status = $1,
            admin_comments = $2,
            usd_per_lot = $3,
            spread_percentage_per_lot = $4,
            ib_type = CASE WHEN $1::varchar = 'approved' THEN $6 ELSE ib_type END,
            group_id = CASE WHEN $1::varchar = 'approved' THEN $7 ELSE group_id END,
            structure_id = CASE WHEN $1::varchar = 'approved' THEN $8 ELSE structure_id END,
            approved_at = CASE WHEN $1::varchar = 'approved' THEN CURRENT_TIMESTAMP ELSE approved_at END,
            referral_code = CASE 
              WHEN $1::varchar = 'approved' AND referral_code IS NULL THEN $9 
              ELSE referral_code 
            END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $5
        RETURNING *;
      `,
      [status, adminComments ?? null, usdPerLot ?? null, spreadPercentagePerLot ?? null, id, ibType ?? null, groupId ?? null, structureId ?? null, referralCode]
    );

    return IBRequest.stripSensitiveFields(result.rows[0]);
  }

  static async getStats() {
    const result = await query(`
      SELECT
        COUNT(*) AS total_requests,
        COUNT(CASE WHEN LOWER(TRIM(status)) = 'pending' THEN 1 END) AS pending_requests,
        COUNT(CASE WHEN LOWER(TRIM(status)) = 'approved' THEN 1 END) AS approved_requests,
        COUNT(CASE WHEN LOWER(TRIM(status)) = 'rejected' THEN 1 END) AS rejected_requests,
        COUNT(CASE WHEN LOWER(TRIM(status)) = 'banned' THEN 1 END) AS banned_requests
      FROM ib_requests;
    `);

    return result.rows[0];
  }


  static async verifyPassword(password, passwordHash) {
    return bcrypt.compare(password, passwordHash);
  }

  /**
   * Generate a unique referral code for an IB
   * Format: Up to 8 characters (e.g., IB123ABC or IB123A)
   * @returns {Promise<string>} Unique referral code (max 8 characters)
   */
  static async generateReferralCode(ibId) {
    const maxAttempts = 10;
    let attempts = 0;
    const ibIdStr = String(ibId);
    
    while (attempts < maxAttempts) {
      // Calculate available space for random chars (8 max - IB prefix - ID length)
      // Format: IB{ID}{RANDOM} - ensure total length <= 8
      const prefixLength = 2 + ibIdStr.length; // "IB" + ID length
      const availableChars = Math.max(2, 8 - prefixLength); // At least 2 random chars
      
      // Generate random string based on available space
      const randomChars = Math.random().toString(36).substring(2, 2 + availableChars).toUpperCase();
      const referralCode = `IB${ibIdStr}${randomChars}`;
      
      // Ensure it doesn't exceed 8 characters
      if (referralCode.length > 8) {
        // Fallback: use shorter format
        const shortCode = `IB${ibIdStr}${randomChars.substring(0, 6 - ibIdStr.length)}`;
        
        // Check if code already exists
        const existing = await query(
          'SELECT id FROM ib_requests WHERE referral_code = $1',
          [shortCode]
        );
        
        if (existing.rows.length === 0) {
          return shortCode.substring(0, 8); // Ensure max 8 chars
        }
      } else {
        // Check if code already exists
        const existing = await query(
          'SELECT id FROM ib_requests WHERE referral_code = $1',
          [referralCode]
        );
        
        if (existing.rows.length === 0) {
          return referralCode;
        }
      }
      
      attempts++;
    }
    
    // Fallback: use timestamp-based code (max 8 chars)
    const timestamp = Date.now().toString(36).toUpperCase().substring(-4);
    const fallbackCode = `IB${ibIdStr}${timestamp}`;
    return fallbackCode.substring(0, 8); // Ensure max 8 chars
  }

  /**
   * Update referral code for an IB
   * @param {number} id - IB request ID
   * @param {string} referralCode - New referral code (max 8 characters)
   * @returns {Promise<Object|null>} Updated IB request or null if not found
   */
  static async updateReferralCode(id, referralCode) {
    if (!referralCode || typeof referralCode !== 'string') {
      throw new Error('Referral code is required');
    }

    const trimmedCode = referralCode.trim().toUpperCase();
    
    // Validate length (max 8 characters)
    if (trimmedCode.length > 8) {
      throw new Error('Referral code must be 8 characters or less');
    }

    if (trimmedCode.length === 0) {
      throw new Error('Referral code cannot be empty');
    }

    // Validate format (alphanumeric only)
    if (!/^[A-Z0-9]+$/.test(trimmedCode)) {
      throw new Error('Referral code must contain only uppercase letters and numbers');
    }

    // Check if code already exists (excluding current IB)
    const existing = await query(
      'SELECT id FROM ib_requests WHERE referral_code = $1 AND id != $2',
      [trimmedCode, id]
    );

    if (existing.rows.length > 0) {
      throw new Error('Referral code already exists. Please choose a different code.');
    }

    // Update the referral code
    const result = await query(
      'UPDATE ib_requests SET referral_code = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
      [trimmedCode, id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return IBRequest.stripSensitiveFields(result.rows[0]);
  }

  static stripSensitiveFields(record) {
    if (!record) {
      return null;
    }
    const { password_hash, ...rest } = record;
    return rest;
  }
}
