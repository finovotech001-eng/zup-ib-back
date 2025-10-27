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
        ib_type VARCHAR(50) NOT NULL DEFAULT 'common' CHECK (ib_type IN ('common','advanced','bronze','silver','gold','platinum','brilliant')),
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
          ALTER TABLE ib_requests
            ADD CONSTRAINT ib_requests_type_check
            CHECK (ib_type IN (${allowedIbTypesList}));
        END IF;
      END
      $$;
    `);


    // Create mt5_groups table
    await MT5Groups.createTable();

    // Create group_commission_structures table
    await GroupCommissionStructures.createTable();
  }


  static async create(requestData) {
    const { fullName, email, password, ibType } = requestData;
    const passwordHash = await bcrypt.hash(password, 12);

    const queryText = `
      INSERT INTO ib_requests (full_name, email, password_hash, ib_type)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `;

    const normalizedType = typeof ibType === 'string' ? ibType.toLowerCase() : null;
    const finalType = IB_TYPE_VALUES.includes(normalizedType) ? normalizedType : 'common';

    const result = await query(queryText, [
      fullName,
      email,
      passwordHash,
      finalType
    ]);

    return IBRequest.stripSensitiveFields(result.rows[0]);
  }

  static async updateApplication(id, updateData) {
    const { fullName, password, ibType } = updateData;
    const passwordHash = await bcrypt.hash(password, 12);

    const normalizedType = typeof ibType === 'string' ? ibType.toLowerCase() : null;
    const finalType = IB_TYPE_VALUES.includes(normalizedType) ? normalizedType : 'common';

    const queryText = `
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

    const result = await query(queryText, [
      fullName,
      passwordHash,
      finalType,
      id
    ]);

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
    const result = await query(
      `
        UPDATE ib_requests
        SET status = $1,
            admin_comments = $2,
            usd_per_lot = $3,
            spread_percentage_per_lot = $4,
            ib_type = COALESCE($6, ib_type),
            group_id = CASE WHEN $1::varchar = 'approved' THEN $7 ELSE group_id END,
            structure_id = CASE WHEN $1::varchar = 'approved' THEN $8 ELSE structure_id END,
            approved_at = CASE WHEN $1::varchar = 'approved' THEN CURRENT_TIMESTAMP ELSE approved_at END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $5
        RETURNING *;
      `,
      [status, adminComments ?? null, usdPerLot ?? null, spreadPercentagePerLot ?? null, id, ibType ?? null, groupId ?? null, structureId ?? null]
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




  static stripSensitiveFields(record) {
    if (!record) {
      return null;
    }
    const { password_hash, ...rest } = record;
    return rest;
  }
}
