-- Migration: Add qualification criteria and level ordering to commission structures
-- This migration adds fields to support automatic commission structure upgrades

DO $$
BEGIN
  -- Add level_order column for ordering commission structures (level 1, 2, 3, etc.)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'group_commission_structures' AND column_name = 'level_order'
  ) THEN
    ALTER TABLE group_commission_structures 
    ADD COLUMN level_order INTEGER DEFAULT 1;
    
    CREATE INDEX IF NOT EXISTS idx_commission_structures_level_order 
    ON group_commission_structures(level_order);
    
    RAISE NOTICE 'level_order column added successfully';
  ELSE
    RAISE NOTICE 'level_order column already exists';
  END IF;

  -- Add min_trading_volume (in millions USD)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'group_commission_structures' AND column_name = 'min_trading_volume'
  ) THEN
    ALTER TABLE group_commission_structures 
    ADD COLUMN min_trading_volume DECIMAL(15,2) DEFAULT 0;
    
    RAISE NOTICE 'min_trading_volume column added successfully';
  ELSE
    RAISE NOTICE 'min_trading_volume column already exists';
  END IF;

  -- Add max_trading_volume (in millions USD) - NULL means no upper limit
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'group_commission_structures' AND column_name = 'max_trading_volume'
  ) THEN
    ALTER TABLE group_commission_structures 
    ADD COLUMN max_trading_volume DECIMAL(15,2);
    
    RAISE NOTICE 'max_trading_volume column added successfully';
  ELSE
    RAISE NOTICE 'max_trading_volume column already exists';
  END IF;

  -- Add min_active_clients (minimum number of active clients required)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'group_commission_structures' AND column_name = 'min_active_clients'
  ) THEN
    ALTER TABLE group_commission_structures 
    ADD COLUMN min_active_clients INTEGER DEFAULT 0;
    
    RAISE NOTICE 'min_active_clients column added successfully';
  ELSE
    RAISE NOTICE 'min_active_clients column already exists';
  END IF;
END $$;


