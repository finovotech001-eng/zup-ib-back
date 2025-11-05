-- Complete Migration: Add qualification criteria and level up history system
-- Run this migration to set up automatic commission structure upgrades

-- ============================================
-- 1. Add qualification criteria to commission structures
-- ============================================
DO $$
BEGIN
  -- Add level_order column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'group_commission_structures' AND column_name = 'level_order'
  ) THEN
    ALTER TABLE group_commission_structures 
    ADD COLUMN level_order INTEGER DEFAULT 1;
    
    CREATE INDEX IF NOT EXISTS idx_commission_structures_level_order 
    ON group_commission_structures(level_order);
    
    RAISE NOTICE 'level_order column added successfully';
  END IF;

  -- Add min_trading_volume (in millions USD)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'group_commission_structures' AND column_name = 'min_trading_volume'
  ) THEN
    ALTER TABLE group_commission_structures 
    ADD COLUMN min_trading_volume DECIMAL(15,2) DEFAULT 0;
    
    RAISE NOTICE 'min_trading_volume column added successfully';
  END IF;

  -- Add max_trading_volume (in millions USD) - NULL means no upper limit
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'group_commission_structures' AND column_name = 'max_trading_volume'
  ) THEN
    ALTER TABLE group_commission_structures 
    ADD COLUMN max_trading_volume DECIMAL(15,2);
    
    RAISE NOTICE 'max_trading_volume column added successfully';
  END IF;

  -- Add min_active_clients (minimum number of active clients required)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'group_commission_structures' AND column_name = 'min_active_clients'
  ) THEN
    ALTER TABLE group_commission_structures 
    ADD COLUMN min_active_clients INTEGER DEFAULT 0;
    
    RAISE NOTICE 'min_active_clients column added successfully';
  END IF;
END $$;

-- ============================================
-- 2. Create IB Level Up History table
-- ============================================
CREATE TABLE IF NOT EXISTS ib_level_up_history (
  id SERIAL PRIMARY KEY,
  ib_request_id INTEGER NOT NULL REFERENCES ib_requests(id) ON DELETE CASCADE,
  from_structure_id INTEGER REFERENCES group_commission_structures(id) ON DELETE SET NULL,
  to_structure_id INTEGER NOT NULL REFERENCES group_commission_structures(id) ON DELETE RESTRICT,
  from_structure_name VARCHAR(255),
  to_structure_name VARCHAR(255),
  trading_volume_at_upgrade DECIMAL(15,2),
  active_clients_at_upgrade INTEGER,
  upgraded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_ib_level_up_history_ib_request_id 
ON ib_level_up_history(ib_request_id);

CREATE INDEX IF NOT EXISTS idx_ib_level_up_history_upgraded_at 
ON ib_level_up_history(upgraded_at DESC);

-- Add comment to table
COMMENT ON TABLE ib_level_up_history IS 'Tracks automatic commission structure upgrades for IB partners';

-- ============================================
-- 3. Update existing commission structures to have default level_order
-- ============================================
UPDATE group_commission_structures 
SET level_order = 1 
WHERE level_order IS NULL;

-- ============================================
-- Migration Complete
-- ============================================
SELECT 'Commission upgrade system migration completed successfully!' as status;



