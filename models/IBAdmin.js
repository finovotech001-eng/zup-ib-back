import { query } from '../config/database.js';
import bcrypt from 'bcryptjs';

const DEFAULT_ADMIN_EMAIL = 'admin_ib@zuperior.com';
const DEFAULT_ADMIN_PASSWORD = 'Admin@000';

export class IBAdmin {
  static async createTable() {
    const queryText = `
      CREATE TABLE IF NOT EXISTS ib_admin (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'admin',
        is_active BOOLEAN DEFAULT true,
        last_login TIMESTAMP WITH TIME ZONE,
        login_attempts INTEGER DEFAULT 0,
        locked_until TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await query(queryText);

    // Add new columns if they don't exist (for existing installations)
    await IBAdmin.addMissingColumns();
  }

  static async addMissingColumns() {
    try {
      // Check if role column exists
      const roleCheck = await query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ib_admin' AND column_name = 'role'
      `);

      if (roleCheck.rows.length === 0) {
        await query(`ALTER TABLE ib_admin ADD COLUMN role VARCHAR(50) DEFAULT 'admin'`);
        console.log('Added role column to ib_admin table');
      }

      // Check if is_active column exists
      const activeCheck = await query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ib_admin' AND column_name = 'is_active'
      `);

      if (activeCheck.rows.length === 0) {
        await query(`ALTER TABLE ib_admin ADD COLUMN is_active BOOLEAN DEFAULT true`);
        console.log('Added is_active column to ib_admin table');
      }

      // Check if last_login column exists
      const loginCheck = await query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ib_admin' AND column_name = 'last_login'
      `);

      if (loginCheck.rows.length === 0) {
        await query(`ALTER TABLE ib_admin ADD COLUMN last_login TIMESTAMP WITH TIME ZONE`);
        console.log('Added last_login column to ib_admin table');
      }

      // Check if login_attempts column exists
      const attemptsCheck = await query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ib_admin' AND column_name = 'login_attempts'
      `);

      if (attemptsCheck.rows.length === 0) {
        await query(`ALTER TABLE ib_admin ADD COLUMN login_attempts INTEGER DEFAULT 0`);
        console.log('Added login_attempts column to ib_admin table');
      }

      // Check if locked_until column exists
      const lockedCheck = await query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ib_admin' AND column_name = 'locked_until'
      `);

      if (lockedCheck.rows.length === 0) {
        await query(`ALTER TABLE ib_admin ADD COLUMN locked_until TIMESTAMP WITH TIME ZONE`);
        console.log('Added locked_until column to ib_admin table');
      }

    } catch (error) {
      console.error('Error adding missing columns:', error);
    }
  }

  static async seedDefaultAdmin() {
    const existing = await IBAdmin.findByEmail(DEFAULT_ADMIN_EMAIL);
    if (existing) {
      return existing;
    }

    const passwordHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 12);
    const insertQuery = `
      INSERT INTO ib_admin (email, password_hash)
      VALUES ($1, $2)
      RETURNING *;
    `;

    const result = await query(insertQuery, [DEFAULT_ADMIN_EMAIL, passwordHash]);
    return result.rows[0];
  }

  static async findByEmail(email) {
    const result = await query('SELECT * FROM ib_admin WHERE email = $1;', [email]);
    return result.rows[0];
  }

  static async findById(id) {
    const result = await query('SELECT * FROM ib_admin WHERE id = $1;', [id]);
    return result.rows[0];
  }

  static async updateLastLogin(id) {
    const result = await query(
      'UPDATE ib_admin SET last_login = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1;',
      [id]
    );
    return result.rows[0];
  }

  static async incrementLoginAttempts(email) {
    const result = await query(
      'UPDATE ib_admin SET login_attempts = login_attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE email = $1;',
      [email]
    );
    return result.rows[0];
  }

  static async lockAccount(email, lockUntil) {
    const result = await query(
      'UPDATE ib_admin SET locked_until = $2, updated_at = CURRENT_TIMESTAMP WHERE email = $1;',
      [email, lockUntil]
    );
    return result.rows[0];
  }

  static async resetLoginAttempts(email) {
    const result = await query(
      'UPDATE ib_admin SET login_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE email = $1;',
      [email]
    );
    return result.rows[0];
  }

  static async updateAdmin(id, updates) {
    const fields = Object.keys(updates);
    const values = Object.values(updates);
    const setClause = fields.map((field, index) => `${field} = $${index + 2}`).join(', ');

    const result = await query(
      `UPDATE ib_admin SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = $1;`,
      [id, ...values]
    );
    return result.rows[0];
  }

  static verifyPassword(password, passwordHash) {
    return bcrypt.compare(password, passwordHash);
  }
}
