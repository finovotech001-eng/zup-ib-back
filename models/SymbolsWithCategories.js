import { query } from '../config/database.js';

export class SymbolsWithCategories {
  static async createTable() {
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS symbols_with_categories (
          id SERIAL PRIMARY KEY,
          symbol VARCHAR(100) NOT NULL UNIQUE,
          pair VARCHAR(50),
          group_name VARCHAR(100),
          category VARCHAR(100),
          pip_per_lot DECIMAL(10, 2) DEFAULT 1.00,
          pip_value DECIMAL(15, 2),
          commission DECIMAL(15, 2),
          currency VARCHAR(10) DEFAULT 'USD',
          status VARCHAR(20) DEFAULT 'active',
          contract_size INTEGER DEFAULT 100000,
          digits INTEGER DEFAULT 5,
          spread DECIMAL(10, 6),
          profit_mode VARCHAR(20) DEFAULT 'forex',
          is_override BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create indexes
      await query(`CREATE INDEX IF NOT EXISTS idx_symbols_category ON symbols_with_categories(category)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_symbols_group ON symbols_with_categories(group_name)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_symbols_status ON symbols_with_categories(status)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_symbols_symbol ON symbols_with_categories(symbol)`);
    } catch (error) {
      console.error('Error creating symbols_with_categories table:', error);
      throw error;
    }
  }

  // Calculate pip value based on symbol type and pair
  static calculatePipValue(symbol, pair, category, contractSize = 100000) {
    if (!pair || pair === '-') {
      // For stocks and other instruments without pairs
      return 10.00; // Default USD10.00
    }

    // Extract base and quote currencies
    const currencies = pair.split('/').map(c => c.trim());
    if (currencies.length !== 2) {
      return 10.00;
    }

    const [baseCurrency, quoteCurrency] = currencies;

    // For crypto pairs, typically USD1.00 per pip
    if (category?.toLowerCase().includes('crypto')) {
      return 1.00;
    }

    // For forex pairs
    if (quoteCurrency === 'USD') {
      // If quote is USD, pip value is typically $10 per lot
      return 10.00;
    } else if (baseCurrency === 'USD') {
      // If base is USD, pip value depends on quote
      return 10.00;
    } else {
      // Cross pairs - default to $10
      return 10.00;
    }
  }

  // Extract pair from symbol or category
  static extractPair(symbol, category) {
    // Try to extract pair from symbol (e.g., ADAUSD -> ADA/USD)
    if (symbol.includes('USD')) {
      const base = symbol.replace(/USD.*$/, '').replace(/\.(.*)$/, '');
      if (base) {
        return `${base} / USD`;
      }
    }

    // If no pair can be extracted
    return '-';
  }

  // Sync from external API by category
  static async syncFromAPI(categoryFilter = null) {
    try {
      // Fetch categories
      const categoriesResponse = await fetch('http://18.175.242.21:5003/api/Symbols/categories', {
        method: 'GET',
        headers: {
          'accept': 'text/plain',
          'Content-Type': 'application/json'
        }
      });

      if (!categoriesResponse.ok) {
        throw new Error(`Categories API request failed with status ${categoriesResponse.status}`);
      }

      const categoriesData = await categoriesResponse.text();
      let categoriesObject;
      try {
        categoriesObject = JSON.parse(categoriesData);
      } catch (e) {
        throw new Error('Invalid JSON response from categories API');
      }

      // Extract category keys from the object (these are the 5 categories)
      const apiCategories = Object.keys(categoriesObject || {});
      
      if (!Array.isArray(apiCategories) || apiCategories.length === 0) {
        console.warn('No categories received from API, using defaults');
        apiCategories = ['Stocks', 'Cryptocurrencies', 'Forex', 'Indices', 'Commodities'];
      }

      console.log('API Categories found:', apiCategories);

      // If categoryFilter is provided, use symbols from that category only
      let symbolsArray = [];
      
      if (categoryFilter) {
        // Find the matching category (case-insensitive)
        const matchedCategory = apiCategories.find(cat => 
          cat.toLowerCase() === categoryFilter.toLowerCase()
        );
        
        if (!matchedCategory) {
          throw new Error(`Category "${categoryFilter}" not found. Available categories: ${apiCategories.join(', ')}`);
        }

        // Get symbols for this specific category from the categories object
        symbolsArray = categoriesObject[matchedCategory] || [];
        console.log(`Syncing ${symbolsArray.length} symbols for category: ${matchedCategory}`);
      } else {
        // If no category filter, sync all symbols from all categories
        for (const category of apiCategories) {
          const categorySymbols = categoriesObject[category] || [];
          symbolsArray = symbolsArray.concat(categorySymbols);
        }
        console.log(`Syncing all ${symbolsArray.length} symbols from all categories`);
      }

      if (symbolsArray.length === 0) {
        return {
          message: categoryFilter 
            ? `No symbols found for category: ${categoryFilter}`
            : 'No symbols found in API',
          synced: 0,
          updated: 0,
          total: 0
        };
      }

      let synced = 0;
      let updated = 0;

      // Process each symbol
      for (const symbol of symbolsArray) {
        try {
          const symbolName = symbol.Symbol || symbol.symbol || symbol.SymbolName;
          if (!symbolName) continue;

          // Get original category from symbol
          const originalCategory = symbol.Category || symbol.category || '';
          
          // If we have a category filter, use it; otherwise map from symbol's category
          let category;
          if (categoryFilter) {
            // Use the filter category (already validated)
            const matchedCategory = apiCategories.find(cat => 
              cat.toLowerCase() === categoryFilter.toLowerCase()
            );
            category = matchedCategory || originalCategory;
          } else {
            // Map to one of the 5 API categories
            category = this.mapCategoryToApiCategory(originalCategory, apiCategories);
          }
          
          // Use category as group name for simplicity
          const groupName = category;

          // Extract pair
          const pair = this.extractPair(symbolName, category);

          // Calculate pip value
          const contractSize = symbol.ContractSize || symbol.contract_size || 100000;
          const pipValue = this.calculatePipValue(symbolName, pair, category, contractSize);
          
          // Set commission (same as pip value by default)
          const commission = pipValue;

          // Check if symbol already exists
          const existing = await query(
            'SELECT id FROM symbols_with_categories WHERE symbol = $1',
            [symbolName]
          );

          if (existing.rows.length > 0) {
            // Update existing
            await query(`
              UPDATE symbols_with_categories SET
                pair = $2,
                group_name = $3,
                category = $4,
                pip_per_lot = $5,
                pip_value = $6,
                commission = $7,
                currency = $8,
                contract_size = $9,
                digits = $10,
                spread = $11,
                profit_mode = $12,
                updated_at = CURRENT_TIMESTAMP
              WHERE symbol = $1
            `, [
              symbolName,
              pair,
              groupName,
              category,
              1.00, // pip_per_lot
              pipValue,
              commission,
              symbol.Currency || 'USD',
              contractSize,
              symbol.Digits || symbol.digits || 5,
              symbol.Spread || symbol.spread || 0,
              symbol.ProfitMode || symbol.profit_mode || 'forex'
            ]);
            updated++;
          } else {
            // Insert new
            await query(`
              INSERT INTO symbols_with_categories (
                symbol, pair, group_name, category, pip_per_lot, pip_value,
                commission, currency, contract_size, digits, spread, profit_mode, status
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            `, [
              symbolName,
              pair,
              groupName,
              category,
              1.00,
              pipValue,
              commission,
              symbol.Currency || 'USD',
              contractSize,
              symbol.Digits || symbol.digits || 5,
              symbol.Spread || symbol.spread || 0,
              symbol.ProfitMode || symbol.profit_mode || 'forex',
              symbol.Enable !== false ? 'active' : 'inactive'
            ]);
            synced++;
          }
        } catch (error) {
          console.error(`Error processing symbol ${symbol.Symbol || symbol.symbol}:`, error);
        }
      }

      return {
        message: categoryFilter
          ? `Successfully synced ${synced} new symbols and updated ${updated} existing symbols for category: ${categoryFilter}`
          : `Successfully synced ${synced} new symbols and updated ${updated} existing symbols`,
        synced,
        updated,
        total: synced + updated,
        category: categoryFilter || 'all'
      };
    } catch (error) {
      console.error('Error syncing symbols from API:', error);
      throw error;
    }
  }

  // Helper method to map category
  static mapCategoryToApiCategory(symbolCategory, apiCategories) {
    if (!symbolCategory) {
      return apiCategories[apiCategories.length - 1] || 'Other';
    }

    const categoryLower = symbolCategory.toLowerCase().trim();
    
    // Direct match first
    const directMatch = apiCategories.find(cat => cat.toLowerCase() === categoryLower);
    if (directMatch) {
      return directMatch;
    }

    // Partial match
    const partialMatch = apiCategories.find(cat => {
      const catLower = cat.toLowerCase();
      return categoryLower.includes(catLower) || catLower.includes(categoryLower);
    });
    if (partialMatch) {
      return partialMatch;
    }

    // Keyword matching
    const keywordMap = {
      'stock': apiCategories.find(c => c.toLowerCase().includes('stock')),
      'crypto': apiCategories.find(c => c.toLowerCase().includes('crypto')),
      'forex': apiCategories.find(c => c.toLowerCase().includes('forex')),
      'fx': apiCategories.find(c => c.toLowerCase().includes('forex')),
      'index': apiCategories.find(c => c.toLowerCase().includes('index')),
      'indices': apiCategories.find(c => c.toLowerCase().includes('index')),
      'commodity': apiCategories.find(c => c.toLowerCase().includes('commodity')),
      'commodities': apiCategories.find(c => c.toLowerCase().includes('commodity'))
    };

    for (const [keyword, category] of Object.entries(keywordMap)) {
      if (categoryLower.includes(keyword) && category) {
        return category;
      }
    }

    // Default to last category or first available
    return apiCategories[apiCategories.length - 1] || apiCategories[0] || 'Other';
  }

  static async findAll(filters = {}) {
    try {
      let whereClauses = [];
      let params = [];
      let paramIndex = 1;

      if (filters.category && filters.category !== 'all') {
        whereClauses.push(`category = $${paramIndex}`);
        params.push(filters.category);
        paramIndex++;
      }

      if (filters.group && filters.group !== 'all') {
        whereClauses.push(`group_name = $${paramIndex}`);
        params.push(filters.group);
        paramIndex++;
      }

      if (filters.status && filters.status !== 'all') {
        whereClauses.push(`status = $${paramIndex}`);
        params.push(filters.status);
        paramIndex++;
      }

      if (filters.search) {
        whereClauses.push(`(symbol ILIKE $${paramIndex} OR category ILIKE $${paramIndex} OR group_name ILIKE $${paramIndex})`);
        params.push(`%${filters.search}%`);
        paramIndex++;
      }

      const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      const countSQL = `SELECT COUNT(*) FROM symbols_with_categories ${whereSQL}`;
      
      const countResult = await query(countSQL, params);
      const totalCount = parseInt(countResult.rows[0].count);

      // Pagination
      const page = parseInt(filters.page) || 1;
      const limit = parseInt(filters.limit) || 100;
      const offset = (page - 1) * limit;

      const orderBy = filters.sortBy || 'symbol';
      const orderDir = filters.sortDir || 'ASC';

      const dataSQL = `
        SELECT * FROM symbols_with_categories 
        ${whereSQL}
        ORDER BY ${orderBy} ${orderDir}
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;
      params.push(limit, offset);

      const result = await query(dataSQL, params);

      console.log(`Query returned ${result.rows.length} rows out of ${totalCount} total`);

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

  static async getStats() {
    try {
      const result = await query(`
        SELECT
          COUNT(*) as total_symbols,
          COUNT(CASE WHEN is_override = true THEN 1 END) as overrides,
          COUNT(DISTINCT category) as total_categories,
          SUM(CASE WHEN pip_value IS NOT NULL THEN 1 ELSE 0 END) as configured_pip_lot
        FROM symbols_with_categories
      `);

      // Get categories list
      const categoriesResult = await query(`
        SELECT DISTINCT category FROM symbols_with_categories WHERE category IS NOT NULL ORDER BY category
      `);

      const categories = categoriesResult.rows.map(r => r.category);

      return {
        ...result.rows[0],
        categories
      };
    } catch (error) {
      console.error('Error fetching symbols stats:', error);
      throw error;
    }
  }

  static async getTotalCount() {
    try {
      const result = await query('SELECT COUNT(*) as total FROM symbols_with_categories');
      return parseInt(result.rows[0].total);
    } catch (error) {
      console.error('Error getting total count:', error);
      throw error;
    }
  }

  static async updateSymbol(id, data) {
    try {
      const fields = [];
      const values = [];
      let paramIndex = 1;

      Object.keys(data).forEach(key => {
        if (key !== 'id') {
          fields.push(`${key} = $${paramIndex}`);
          values.push(data[key]);
          paramIndex++;
        }
      });

      values.push(id);

      const result = await query(`
        UPDATE symbols_with_categories 
        SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = $${paramIndex}
        RETURNING *
      `, values);

      return result.rows[0];
    } catch (error) {
      console.error('Error updating symbol:', error);
      throw error;
    }
  }

  static async deleteSymbol(id) {
    try {
      await query('DELETE FROM symbols_with_categories WHERE id = $1', [id]);
      return true;
    } catch (error) {
      console.error('Error deleting symbol:', error);
      throw error;
    }
  }
}

