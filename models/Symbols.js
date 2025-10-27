import { query } from '../config/database.js';

export class Symbols {
  static async createTable() {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS symbols (
          id SERIAL PRIMARY KEY,
          symbol_name VARCHAR(50) NOT NULL,
          description TEXT,
          symbol_type VARCHAR(20),
          group_name VARCHAR(100),
          digits INTEGER DEFAULT 5,
          spread FLOAT DEFAULT 0,
          contract_size INTEGER DEFAULT 100000,
          profit_mode VARCHAR(20) DEFAULT 'forex',
          enable BOOLEAN DEFAULT true,
          swap_mode VARCHAR(20) DEFAULT 'disabled',
          swap_long FLOAT DEFAULT 0,
          swap_short FLOAT DEFAULT 0,
          swap3_day VARCHAR(10) DEFAULT 'wednesday',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(symbol_name)
        )
      `);
    } catch (error) {
      console.error('Error creating symbols table:', error);
      throw error;
    }
  }

  static async syncFromAPI() {
    try {
      const response = await fetch('http://18.130.5.209:5003/api/Symbols', {
        method: 'GET',
        headers: {
          'accept': 'text/plain',
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`API request failed with status ${response.status}`);
      }

      const data = await response.text();
      let symbolsData;

      try {
        symbolsData = JSON.parse(data);
      } catch (parseError) {
        throw new Error('Invalid JSON response from API');
      }

      // Handle both array and object responses
      const symbolsArray = Array.isArray(symbolsData) ? symbolsData : symbolsData.data || [];

      if (symbolsArray.length === 0) {
        return { message: 'No symbols data received from API', synced: 0 };
      }

      // Clear existing data
      await query('DELETE FROM symbols');

      // Insert new data
      let synced = 0;
      for (const symbol of symbolsArray) {
        try {
          await query(`
            INSERT INTO symbols (
              symbol_name, description, symbol_type, group_name, digits,
              spread, contract_size, profit_mode, enable, swap_mode,
              swap_long, swap_short, swap3_day
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (symbol_name) DO UPDATE SET
              description = EXCLUDED.description,
              symbol_type = EXCLUDED.symbol_type,
              group_name = EXCLUDED.group_name,
              digits = EXCLUDED.digits,
              spread = EXCLUDED.spread,
              contract_size = EXCLUDED.contract_size,
              profit_mode = EXCLUDED.profit_mode,
              enable = EXCLUDED.enable,
              swap_mode = EXCLUDED.swap_mode,
              swap_long = EXCLUDED.swap_long,
              swap_short = EXCLUDED.swap_short,
              swap3_day = EXCLUDED.swap3_day,
              updated_at = CURRENT_TIMESTAMP
          `, [
            symbol.Symbol || symbol.symbol_name,
            symbol.Description || symbol.description || '',
            symbol.Type || symbol.symbol_type || 'forex',
            symbol.Group || symbol.group_name || '',
            symbol.Digits || symbol.digits || 5,
            symbol.Spread || symbol.spread || 0,
            symbol.ContractSize || symbol.contract_size || 100000,
            symbol.ProfitMode || symbol.profit_mode || 'forex',
            symbol.Enable !== undefined ? symbol.Enable : true,
            symbol.SwapMode || symbol.swap_mode || 'disabled',
            symbol.SwapLong || symbol.swap_long || 0,
            symbol.SwapShort || symbol.swap_short || 0,
            symbol.Swap3Day || symbol.swap3_day || 'wednesday'
          ]);
          synced++;
        } catch (insertError) {
          console.error(`Error inserting symbol ${symbol.Symbol || symbol.symbol_name}:`, insertError);
        }
      }

      return {
        message: `Successfully synced ${synced} symbols from API`,
        synced: synced
      };
    } catch (error) {
      console.error('Error syncing symbols from API:', error);
      throw error;
    }
  }

  static async findAll(page = 1, limit = 100) {
    try {
      const offset = (page - 1) * limit;

      // Get total count
      const countResult = await query('SELECT COUNT(*) FROM symbols');
      const totalCount = parseInt(countResult.rows[0].count);

      // Get paginated data
      const result = await query('SELECT * FROM symbols ORDER BY symbol_name LIMIT $1 OFFSET $2', [limit, offset]);

      return {
        symbols: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit)
        }
      };
    } catch (error) {
      console.error('Error fetching symbols:', error);
      throw error;
    }
  }

  static async findById(id) {
    try {
      const result = await query('SELECT * FROM symbols WHERE id = $1', [id]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('Error fetching symbol by ID:', error);
      throw error;
    }
  }

  static async search(searchTerm, page = 1, limit = 100) {
    try {
      const offset = (page - 1) * limit;

      // Get total count for search
      const countResult = await query('SELECT COUNT(*) FROM symbols WHERE (symbol_name ILIKE $1 OR description ILIKE $1)', [`%${searchTerm}%`]);
      const totalCount = parseInt(countResult.rows[0].count);

      // Get paginated search results
      const result = await query('SELECT * FROM symbols WHERE (symbol_name ILIKE $1 OR description ILIKE $1) ORDER BY symbol_name LIMIT $2 OFFSET $3', [`%${searchTerm}%`, limit, offset]);

      return {
        symbols: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit)
        }
      };
    } catch (error) {
      console.error('Error searching symbols:', error);
      throw error;
    }
  }

  static async getStats() {
    try {
      const result = await query(`
        SELECT
          COUNT(*) as total_symbols,
          COUNT(CASE WHEN COALESCE(enable, true) = true THEN 1 END) as active_symbols,
          COUNT(DISTINCT group_name) as total_groups,
          COUNT(DISTINCT symbol_type) as total_types
        FROM symbols
      `);

      return result.rows[0];
    } catch (error) {
      console.error('Error fetching symbols stats:', error);
      throw error;
    }
  }
}
