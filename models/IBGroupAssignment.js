import { query } from '../config/database.js';

export class IBGroupAssignment {
  static async createTable() {
    await query(`
      CREATE TABLE IF NOT EXISTS ib_group_assignments (
        id SERIAL PRIMARY KEY,
        ib_request_id INTEGER REFERENCES ib_requests(id) ON DELETE CASCADE,
        group_id VARCHAR(255) NOT NULL,
        group_name VARCHAR(255),
        structure_id INTEGER,
        structure_name VARCHAR(255),
        usd_per_lot DECIMAL(10,2) NOT NULL DEFAULT 0,
        spread_share_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  static async replaceAssignments(ibRequestId, assignments = []) {
    await query('DELETE FROM ib_group_assignments WHERE ib_request_id = $1', [ibRequestId]);

    if (!assignments.length) {
      return;
    }

    const insertPromises = assignments.map((assignment) => {
      const {
        groupId,
        groupName,
        structureId,
        structureName,
        usdPerLot,
        spreadSharePercentage
      } = assignment;

      return query(
        `INSERT INTO ib_group_assignments (
          ib_request_id,
          group_id,
          group_name,
          structure_id,
          structure_name,
          usd_per_lot,
          spread_share_percentage
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          ibRequestId,
          groupId,
          groupName || null,
          structureId || null,
          structureName || null,
          Number(usdPerLot || 0),
          Number(spreadSharePercentage || 0)
        ]
      );
    });

    await Promise.all(insertPromises);
  }

  static async clearAssignments(ibRequestId) {
    await query('DELETE FROM ib_group_assignments WHERE ib_request_id = $1', [ibRequestId]);
  }

  static async getByIbRequestId(ibRequestId) {
    const result = await query(
      `SELECT id, ib_request_id, group_id, group_name, structure_id, structure_name,
              usd_per_lot, spread_share_percentage, created_at, updated_at
         FROM ib_group_assignments
        WHERE ib_request_id = $1
        ORDER BY created_at ASC`,
      [ibRequestId]
    );
    return result.rows;
  }
}

export default IBGroupAssignment;
