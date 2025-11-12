import { query } from '../config/database.js';

export class IBTradeHistory {
  static async createTable() {
    try {
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
        console.log('ib_trade_history table already exists; ensuring schema');
      }
      
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

  static async upsertTrades(trades, { accountId, userId, ibRequestId, commissionMap = {}, groupId = null }) {
    const saved = [];
    let skipped = { noOrderId: 0, noSymbol: 0, notBuySell: 0, notClosed: 0, noVolume: 0, errors: 0 };
    
    const resolveUsdPerLot = (gid) => {
      if (!gid) return Number(commissionMap['*']?.usdPerLot || 0);
      const low = String(gid).toLowerCase();
      const candidates = new Set([
        low,
        low.replace(/\\\\/g, '/'),
        low.replace(/\//g, '\\')
      ]);
      const parts = low.split(/[\\\/]/);
      if (parts.length) {
        candidates.add(parts[parts.length - 1]);
        const idx = parts.findIndex(p => p === 'bbook');
        if (idx >= 0 && idx + 1 < parts.length) {
          candidates.add(parts[idx + 1]);
        }
      }
      for (const k of candidates) {
        const v = commissionMap[k];
        if (v && typeof v.usdPerLot !== 'undefined') return Number(v.usdPerLot || 0);
      }
      return Number(commissionMap['*']?.usdPerLot || 0);
    };

    let usdPerLot = resolveUsdPerLot(groupId);
    console.log(`[UPSERT] Processing ${trades.length} trades for account ${accountId}, usdPerLot=${usdPerLot}, groupId=${groupId}`);

    for (const trade of trades) {
      try {
        const orderId = String(trade?.OrderId ?? '');
        if (!orderId) { skipped.noOrderId++; continue; }
        
        const symbol = String(trade?.Symbol || '').trim();
        if (!symbol) { skipped.noSymbol++; continue; }
        
        const orderType = String(trade?.OrderType || '').toLowerCase().trim();
        if (orderType !== 'buy' && orderType !== 'sell') { skipped.notBuySell++; continue; }
        
        const entry = String(trade?.Entry || trade?.EntryType || trade?.DealEntry || '').toLowerCase();
        const hasCloseTime = Boolean(
          trade?.CloseTime || trade?.ClosedTime || trade?.CloseDate || trade?.Closed ||
          trade?.TimeClose || trade?.DoneTime || trade?.DealTime || trade?.CloseTimeMsc || 
          trade?.CloseTimeMS || trade?.CloseTimeMs || trade?.ClosedAt || trade?.Time
        );
        const closePrice = Number(trade?.ClosePrice || 0);
        const openPrice = Number(trade?.OpenPrice || 0);
        
        const isClosedByEntry = entry.includes('out') || entry.includes('close');
        const isClosedByFields = (closePrice > 0 || hasCloseTime) && openPrice > 0;
        const isClosed = isClosedByEntry || isClosedByFields;
        
        if (!isClosed) { skipped.notClosed++; continue; }
        
        const volume = Number(trade?.Volume || 0);
        if (!volume || volume === 0) { skipped.noVolume++; continue; }
        
        const profit = Number(trade?.Profit || 0);
        const id = `${accountId}-${orderId}`;
        const volumeLots = volume < 0.1 ? volume * 1000 : volume;
        const ibCommission = volumeLots * usdPerLot;
        const finalClosePrice = closePrice > 0 ? closePrice : openPrice;

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
          finalClosePrice,
          profit,
          Number(trade.TakeProfit || 0),
          Number(trade.StopLoss || 0),
          Number(ibCommission || 0),
          groupId
        ]);

        saved.push(result.rows[0]);
      } catch (error) {
        console.error(`[UPSERT] Error on trade ${trade?.OrderId}:`, error.message);
        skipped.errors++;
      }
    }

    console.log(`[UPSERT] Saved ${saved.length}/${trades.length}. Skipped: notClosed=${skipped.notClosed}, notBuySell=${skipped.notBuySell}, noVolume=${skipped.noVolume}, errors=${skipped.errors}`);
    return saved;
  }

  static async getTrades({ userId, accountId = null, groupId = null, limit = 50, offset = 0 }) {
    const params = [userId];
    let where = 'user_id = $1 AND close_price IS NOT NULL AND close_price > 0';
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

  static async getAccountStats(userId) {
    const queryText = `
      SELECT 
        account_id,
        COUNT(*)::int AS trade_count,
        COALESCE(SUM(volume_lots), 0) AS total_volume,
        COALESCE(SUM(profit), 0) AS total_profit,
        COALESCE(SUM(ib_commission), 0) AS total_ib_commission
      FROM ib_trade_history
      WHERE user_id = $1 AND close_price IS NOT NULL AND close_price > 0
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
        const orderId = String(trade?.OrderId ?? '');
        if (!orderId || orderId === 'undefined' || orderId === 'null') continue;
        
        const symbol = String(trade?.Symbol || '').trim();
        if (!symbol) continue;
        
        const orderType = String(trade?.OrderType || '').toLowerCase().trim();
        if (orderType !== 'buy' && orderType !== 'sell') continue;
        
        const entry = String(trade?.Entry || trade?.EntryType || trade?.DealEntry || '').toLowerCase();
        const hasCloseTime = Boolean(
          trade?.CloseTime || trade?.ClosedTime || trade?.CloseDate || trade?.Closed ||
          trade?.TimeClose || trade?.DoneTime || trade?.DealTime || trade?.CloseTimeMsc || 
          trade?.CloseTimeMS || trade?.CloseTimeMs || trade?.ClosedAt || trade?.Time
        );
        const closePrice = Number(trade?.ClosePrice || 0);
        const openPrice = Number(trade?.OpenPrice || 0);
        
        const isClosedByEntry = entry.includes('out') || entry.includes('close');
        const isClosedByFields = (closePrice > 0 || hasCloseTime) && openPrice > 0;
        const isClosed = isClosedByEntry || isClosedByFields;
        
        if (!isClosed) continue;
        
        const volume = Number(trade?.Volume || 0);
        if (!volume || volume === 0) continue;
        
        const profit = Number(trade?.Profit || 0);
        const id = `${accountId}-${orderId}`;
        const volumeLots = volume < 0.1 ? volume * 1000 : volume;
        const finalClosePrice = closePrice > 0 ? closePrice : openPrice;
        
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
          finalClosePrice,
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
      const updateQuery = `
        UPDATE ib_trade_history AS t
        SET ib_commission = (t.volume_lots * COALESCE(a.usd_per_lot, s.usd_per_lot, 0)),
            updated_at = CURRENT_TIMESTAMP
        FROM ib_group_assignments AS a
        LEFT JOIN group_commission_structures AS s ON (
              s.id = a.structure_id
           OR lower(COALESCE(s.structure_name, '')) = lower(COALESCE(a.structure_name, ''))
        )
        WHERE t.account_id = $1
          AND t.ib_request_id = $2
          AND t.close_price IS NOT NULL AND t.close_price > 0
          AND a.ib_request_id = $2
          AND (
            lower(COALESCE(t.group_id, '')) = lower(COALESCE(a.group_id, '')) OR
            lower(COALESCE(t.group_id, '')) = lower(COALESCE(a.group_name, '')) OR
            regexp_replace(lower(COALESCE(t.group_id,'')), '.*[\\\/]', '') = regexp_replace(lower(COALESCE(a.group_id,'')), '.*[\\\/]', '')
          )
        RETURNING t.*;
      `;
      const result = await query(updateQuery, [String(accountId), ibRequestId]);

      const fallbackRateRes = await query(
        `SELECT COALESCE(MAX(COALESCE(a.usd_per_lot, s.usd_per_lot)), 0) AS usd_per_lot
         FROM ib_group_assignments a
         LEFT JOIN group_commission_structures s ON (s.id = a.structure_id OR lower(COALESCE(s.structure_name,'')) = lower(COALESCE(a.structure_name,'')))
         WHERE a.ib_request_id = $1`,
        [ibRequestId]
      );
      const fallbackUsdPerLot = Number(fallbackRateRes.rows?.[0]?.usd_per_lot || 0);
      if (fallbackUsdPerLot > 0) {
        await query(
          `UPDATE ib_trade_history
           SET ib_commission = (volume_lots * $1::numeric), updated_at = CURRENT_TIMESTAMP
           WHERE ib_request_id = $2 AND account_id = $3
             AND close_price IS NOT NULL AND close_price > 0
             AND COALESCE(ib_commission,0) = 0`,
          [fallbackUsdPerLot, ibRequestId, String(accountId)]
        );
      }

      return result.rows.length;
    } catch (error) {
      console.error('Error calculating IB commissions:', error);
      return 0;
    }
  }

  static async getTradesByIB(ibRequestId, accountId = null) {
    let queryText = `
      SELECT * FROM ib_trade_history
      WHERE ib_request_id = $1 AND close_price IS NOT NULL AND close_price > 0
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
      WHERE ib_request_id = $1 AND close_price IS NOT NULL AND close_price > 0
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
