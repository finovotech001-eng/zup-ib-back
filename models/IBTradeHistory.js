import { query } from '../config/database.js';

export class IBTradeHistory {
  static async createTable() {
    try {
      // Check if table exists
      const checkTableQuery = `
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'ib_trade_history'
        );
      `;
      
      const checkResult = await query(checkTableQuery);
      const tableExists = checkResult.rows[0].exists;
      // Do not return early; we still need to run migrations/indexes when table exists
      if (tableExists) {
        console.log('ib_trade_history table already exists; ensuring schema');
      }
      
      // Create table
      const createTableQuery = `
        CREATE TABLE IF NOT EXISTS ib_trade_history (
          id TEXT PRIMARY KEY,
          order_id TEXT NOT NULL UNIQUE,
          account_id TEXT NOT NULL,
          user_id TEXT,
          ib_request_id INTEGER,
          symbol TEXT NOT NULL,
          order_type TEXT NOT NULL,
          volume_lots NUMERIC NOT NULL,
          open_price NUMERIC,
          close_price NUMERIC,
          profit NUMERIC,
          ib_commission NUMERIC DEFAULT 0,
          take_profit NUMERIC,
          stop_loss NUMERIC,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `;
      
      await query(createTableQuery);
      
      // Ensure new columns exist
      await query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ib_trade_history' AND column_name = 'group_id'
          ) THEN
            ALTER TABLE ib_trade_history ADD COLUMN group_id TEXT;
          END IF;
        END $$;
      `);
      
      // Create indexes separately
      await query('CREATE INDEX IF NOT EXISTS idx_ib_trade_account ON ib_trade_history (account_id);');
      await query('CREATE INDEX IF NOT EXISTS idx_ib_trade_user ON ib_trade_history (user_id);');
      await query('CREATE INDEX IF NOT EXISTS idx_ib_trade_ib ON ib_trade_history (ib_request_id);');
      await query('CREATE INDEX IF NOT EXISTS idx_ib_trade_symbol ON ib_trade_history (symbol);');
      await query('CREATE INDEX IF NOT EXISTS idx_ib_trade_group ON ib_trade_history (group_id);');
      
      console.log('✅ ib_trade_history table created successfully');
    } catch (error) {
      console.error('Error in createTable:', error.message);
    }
  }

  // Upsert trades with optional IB commission calculation
  static async upsertTrades(trades, { accountId, userId, ibRequestId, commissionMap = {}, groupId = null }) {
    const saved = [];
    
    // Get commission rate from map based on group or fallback to default
    let usdPerLot = 0;
    if (groupId && commissionMap[groupId.toLowerCase()]) {
      usdPerLot = Number(commissionMap[groupId.toLowerCase()]?.usdPerLot || 0);
    } else if (commissionMap['*']) {
      usdPerLot = Number(commissionMap['*']?.usdPerLot || 0);
    }

    for (const trade of trades) {
      try {
        // Basic validation
        const orderId = String(trade?.OrderId ?? '');
        if (!orderId) continue;
        
        // Must have a valid trading symbol
        const symbol = String(trade?.Symbol || '').trim();
        if (!symbol) continue;
        
        // Only include actual trading positions (buy/sell) - exclude balance, deposit, withdrawal, etc.
        const orderType = String(trade?.OrderType || '').toLowerCase().trim();
        if (orderType !== 'buy' && orderType !== 'sell') continue;
        
        // Only include closed positions (must have ClosePrice and it must not be 0)
        const closePrice = Number(trade?.ClosePrice || 0);
        if (!closePrice || closePrice === 0) continue;
        
        // Must have OpenPrice
        const openPrice = Number(trade?.OpenPrice || 0);
        if (!openPrice || openPrice === 0) continue;
        
        // Must have valid volume
        const volume = Number(trade?.Volume || 0);
        if (!volume || volume === 0) continue;
        
        // Allow zero-profit trades so history shows all closed deals
        const profit = Number(trade?.Profit || 0);

        const id = `${accountId}-${orderId}`;
        // MT5 returns volume in different formats - convert to standard lots
        // If volume < 0.1, it's likely in mini/micro lots, multiply by 1000
        const volumeLots = volume < 0.1 ? volume * 1000 : volume;
        const ibCommission = volumeLots * usdPerLot;

        const queryText = `
          INSERT INTO ib_trade_history (
            id, order_id, account_id, user_id, ib_request_id, symbol, order_type,
            volume_lots, open_price, close_price, profit, take_profit, stop_loss,
            ib_commission, group_id, synced_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,CURRENT_TIMESTAMP
          )
          ON CONFLICT (order_id)
          DO UPDATE SET
            volume_lots = EXCLUDED.volume_lots,
            close_price = EXCLUDED.close_price,
            profit = EXCLUDED.profit,
            ib_commission = EXCLUDED.ib_commission,
            group_id = COALESCE(EXCLUDED.group_id, ib_trade_history.group_id),
            updated_at = CURRENT_TIMESTAMP,
            synced_at = CURRENT_TIMESTAMP
          RETURNING *;
        `;

        const result = await query(queryText, [
          id,
          orderId,
          String(accountId),
          userId,
          ibRequestId,
          symbol,
          orderType,
          volumeLots,
          openPrice,
          closePrice,
          profit,
          Number(trade.TakeProfit || 0),
          Number(trade.StopLoss || 0),
          Number(ibCommission || 0),
          groupId
        ]);

        saved.push(result.rows[0]);
      } catch (error) {
        console.error('upsertTrades error:', error.message);
      }
    }

    return saved;
  }

  // Paginated trades for a user/account used by admin route
  static async getTrades({ userId, accountId = null, groupId = null, limit = 50, offset = 0 }) {
    const params = [userId];
    let where = 'user_id = $1 AND close_price IS NOT NULL AND close_price != 0';
    if (accountId) {
      params.push(String(accountId));
      where += ` AND account_id = $${params.length}`;
    }
    if (groupId) {
      params.push(String(groupId));
      where += ` AND group_id = $${params.length}`;
    }

    const countQuery = `SELECT COUNT(*)::int AS count FROM ib_trade_history WHERE ${where}`;
    const listQuery = `
      SELECT *
      FROM ib_trade_history
      WHERE ${where}
      ORDER BY synced_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;

    const countRes = await query(countQuery, params);
    const total = Number(countRes.rows?.[0]?.count || 0);

    const listRes = await query(listQuery, [...params, Number(limit), Number(offset)]);
    const trades = listRes.rows.map((row) => ({
      account_id: row.account_id,
      mt5_deal_id: row.order_id,
      symbol: row.symbol,
      volume_lots: Number(row.volume_lots || 0),
      profit: Number(row.profit || 0),
      commission: 0,
      ib_commission: Number(row.ib_commission || 0),
      group_id: row.group_id || null,
      close_time: row.updated_at || row.synced_at || null
    }));

    return {
      trades,
      total,
      page: Math.floor(Number(offset) / (Number(limit) || 1)) + 1,
      pageSize: Number(limit)
    };
  }

  // Aggregated stats per account for a user
  static async getAccountStats(userId) {
    const queryText = `
      SELECT 
        account_id,
        COUNT(*)::int AS trade_count,
        COALESCE(SUM(volume_lots), 0) AS total_volume,
        COALESCE(SUM(profit), 0) AS total_profit,
        COALESCE(SUM(ib_commission), 0) AS total_ib_commission
      FROM ib_trade_history
      WHERE user_id = $1 AND close_price IS NOT NULL AND close_price != 0 AND profit != 0
      GROUP BY account_id
      ORDER BY account_id
    `;

    const result = await query(queryText, [userId]);
    return result.rows;
  }

  static async saveTrades(trades, accountId, userId, ibRequestId) {
    const savedTrades = [];
    
    for (const trade of trades) {
      try {
        // Skip if no valid order ID
        const orderId = String(trade?.OrderId ?? '');
        if (!orderId || orderId === 'undefined' || orderId === 'null') {
          continue;
        }
        
        // Must have a valid trading symbol
        const symbol = String(trade?.Symbol || '').trim();
        if (!symbol) continue;
        
        // Only include actual trading positions (buy/sell) - exclude balance, deposit, withdrawal, etc.
        const orderType = String(trade?.OrderType || '').toLowerCase().trim();
        if (orderType !== 'buy' && orderType !== 'sell') continue;
        
        // Only include closed positions (must have ClosePrice and it must not be 0)
        const closePrice = Number(trade?.ClosePrice || 0);
        if (!closePrice || closePrice === 0) continue;
        
        // Must have OpenPrice
        const openPrice = Number(trade?.OpenPrice || 0);
        if (!openPrice || openPrice === 0) continue;
        
        // Must have valid volume
        const volume = Number(trade?.Volume || 0);
        if (!volume || volume === 0) continue;
        
        // CRITICAL: Only include trades with non-zero profit (actual closed positions with P&L)
        // Trades with $0.00 profit are opening legs or adjustments, not closed positions
        const profit = Number(trade?.Profit || 0);
        if (profit === 0) continue;
        
        const id = `${accountId}-${orderId}`;
        // MT5 returns volume in different formats - convert to standard lots
        const volumeLots = volume < 0.1 ? volume * 1000 : volume;
        
        const insertQuery = `
          INSERT INTO ib_trade_history (
            id, order_id, account_id, user_id, ib_request_id, symbol, order_type,
            volume_lots, open_price, close_price, profit, take_profit, stop_loss, synced_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)
          ON CONFLICT (order_id) 
          DO UPDATE SET
            volume_lots = EXCLUDED.volume_lots,
            close_price = EXCLUDED.close_price,
            profit = EXCLUDED.profit,
            synced_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
          RETURNING *;
        `;
        
        const result = await query(insertQuery, [
          id,
          orderId,
          String(accountId),
          userId,
          ibRequestId,
          symbol,
          orderType,
          volumeLots,
          openPrice,
          closePrice,
          profit,
          Number(trade.TakeProfit || 0),
          Number(trade.StopLoss || 0)
        ]);
        
        savedTrades.push(result.rows[0]);
      } catch (error) {
        console.error(`Error saving trade OrderId ${trade.OrderId}:`, error.message);
      }
    }
    
    return savedTrades;
  }

  static async calculateIBCommissions(accountId, ibRequestId) {
    try {
      // Calculate commission per trade using the assigned group's USD/lot when available
      const updateQuery = `
        UPDATE ib_trade_history AS t
        SET ib_commission = (t.volume_lots * COALESCE(a.usd_per_lot, 0)),
            updated_at = CURRENT_TIMESTAMP
        FROM ib_group_assignments AS a
        WHERE t.account_id = $1
          AND t.ib_request_id = $2
          AND t.close_price IS NOT NULL AND t.close_price != 0
          AND (
            lower(COALESCE(t.group_id, '')) = lower(COALESCE(a.group_id, '')) OR
            lower(COALESCE(t.group_id, '')) = lower(COALESCE(a.group_name, '')) OR
            regexp_replace(lower(COALESCE(t.group_id,'')), '.*[\\\\/]', '') = regexp_replace(lower(COALESCE(a.group_id,'')), '.*[\\\\/]', '')
          )
          AND a.ib_request_id = $2
        RETURNING t.*;
      `;
      const result = await query(updateQuery, [String(accountId), ibRequestId]);
      return result.rows.length;
    } catch (error) {
      console.error('Error calculating IB commissions:', error);
      return 0;
    }
  }

  static async getTradesByIB(ibRequestId, accountId = null) {
    let queryText = `
      SELECT * FROM ib_trade_history
      WHERE ib_request_id = $1 AND close_price IS NOT NULL AND close_price != 0 AND profit != 0
    `;
    const params = [ibRequestId];
    
    if (accountId) {
      queryText += ` AND account_id = $2`;
      params.push(String(accountId));
    }
    
    queryText += ` ORDER BY synced_at DESC LIMIT 100`;
    
    const result = await query(queryText, params);
    return result.rows;
  }

  static async getTradeStats(ibRequestId, accountId = null) {
    let queryText = `
      SELECT 
        COUNT(*) as total_trades,
        SUM(volume_lots) as total_lots,
        SUM(profit) as total_profit,
        SUM(ib_commission) as total_ib_commission
      FROM ib_trade_history
      WHERE ib_request_id = $1 AND close_price IS NOT NULL AND close_price != 0 AND profit != 0
    `;
    const params = [ibRequestId];
    
    if (accountId) {
      queryText += ` AND account_id = $2`;
      params.push(String(accountId));
    }
    
    const result = await query(queryText, params);
    return result.rows[0] || {
      total_trades: 0,
      total_lots: 0,
      total_profit: 0,
      total_ib_commission: 0
    };
  }

  static async getLastSyncTime(accountId) {
    const result = await query(
      'SELECT MAX(synced_at) as last_sync FROM ib_trade_history WHERE account_id = $1',
      [String(accountId)]
    );
    return result.rows[0]?.last_sync || null;
  }
}
