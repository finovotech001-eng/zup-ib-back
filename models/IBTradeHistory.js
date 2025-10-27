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
      
      if (tableExists) {
        console.log('ib_trade_history table already exists');
        return;
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
      
      // Create indexes separately
      await query('CREATE INDEX IF NOT EXISTS idx_ib_trade_account ON ib_trade_history (account_id);');
      await query('CREATE INDEX IF NOT EXISTS idx_ib_trade_user ON ib_trade_history (user_id);');
      await query('CREATE INDEX IF NOT EXISTS idx_ib_trade_ib ON ib_trade_history (ib_request_id);');
      await query('CREATE INDEX IF NOT EXISTS idx_ib_trade_symbol ON ib_trade_history (symbol);');
      
      console.log('✅ ib_trade_history table created successfully');
    } catch (error) {
      console.error('Error in createTable:', error.message);
    }
  }

  // Upsert trades with optional IB commission calculation
  static async upsertTrades(trades, { accountId, userId, ibRequestId, commissionMap = {} }) {
    const saved = [];
    const usdPerLot = Number(commissionMap['*']?.usdPerLot || 0);

    for (const trade of trades) {
      try {
        // Basic validation
        const orderId = String(trade?.OrderId ?? '');
        if (!orderId) continue;
        if (!trade?.Symbol) continue;

        const id = `${accountId}-${orderId}`;
        const volumeLots = Number(trade?.Volume || 0);
        const ibCommission = volumeLots * usdPerLot;

        const queryText = `
          INSERT INTO ib_trade_history (
            id, order_id, account_id, user_id, ib_request_id, symbol, order_type,
            volume_lots, open_price, close_price, profit, take_profit, stop_loss,
            ib_commission, synced_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,CURRENT_TIMESTAMP
          )
          ON CONFLICT (order_id)
          DO UPDATE SET
            volume_lots = EXCLUDED.volume_lots,
            close_price = EXCLUDED.close_price,
            profit = EXCLUDED.profit,
            ib_commission = EXCLUDED.ib_commission,
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
          trade.Symbol || '',
          trade.OrderType || 'buy',
          volumeLots,
          Number(trade.OpenPrice || 0),
          Number(trade.ClosePrice || 0),
          Number(trade.Profit || 0),
          Number(trade.TakeProfit || 0),
          Number(trade.StopLoss || 0),
          Number(ibCommission || 0)
        ]);

        saved.push(result.rows[0]);
      } catch (error) {
        console.error('upsertTrades error:', error.message);
      }
    }

    return saved;
  }

  // Paginated trades for a user/account used by admin route
  static async getTrades({ userId, accountId = null, limit = 50, offset = 0 }) {
    const params = [userId];
    let where = 'user_id = $1';
    if (accountId) {
      params.push(String(accountId));
      where += ` AND account_id = $${params.length}`;
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
      WHERE user_id = $1
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
        // Skip if no symbol (invalid trade)
        if (!trade.Symbol || trade.Symbol === '') {
          continue;
        }
        
        const id = `${accountId}-${trade.OrderId}`;
        const orderId = String(trade.OrderId);
        
        // Skip if no valid order ID
        if (!orderId || orderId === 'undefined' || orderId === 'null') {
          continue;
        }
        
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
          trade.Symbol || '',
          trade.OrderType || 'buy',
          Number(trade.Volume || 0),
          Number(trade.OpenPrice || 0),
          Number(trade.ClosePrice || 0),
          Number(trade.Profit || 0),
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
      // Get IB commission rates
      const ibResult = await query(
        'SELECT usd_per_lot, spread_percentage_per_lot FROM ib_requests WHERE id = $1',
        [ibRequestId]
      );
      
      if (ibResult.rows.length === 0) {
        return 0;
      }
      
      const { usd_per_lot } = ibResult.rows[0];
      const usdPerLot = Number(usd_per_lot || 0);
      
      // Calculate IB commission: (Volume in lots × USD per lot)
      const updateQuery = `
        UPDATE ib_trade_history
        SET ib_commission = (volume_lots * $1::numeric),
        updated_at = CURRENT_TIMESTAMP
        WHERE account_id = $2
        RETURNING *;
      `;
      
      const result = await query(updateQuery, [usdPerLot, String(accountId)]);
      return result.rows.length;
    } catch (error) {
      console.error('Error calculating IB commissions:', error);
      return 0;
    }
  }

  static async getTradesByIB(ibRequestId, accountId = null) {
    let queryText = `
      SELECT * FROM ib_trade_history
      WHERE ib_request_id = $1
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
      WHERE ib_request_id = $1
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
