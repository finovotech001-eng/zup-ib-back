import { query } from '../config/database.js';
import bcrypt from 'bcryptjs';

export class User {
  static async findByEmail(email) {
    const result = await query('SELECT * FROM "User" WHERE email = $1;', [email]);
    return result.rows[0];
  }

  static async verifyPassword(plainPassword, hashedPassword) {
    return bcrypt.compare(plainPassword, hashedPassword);
  }

  static sanitize(user) {
    if (!user) {
      return null;
    }
    const { password, ...rest } = user;
    return rest;
  }
}
