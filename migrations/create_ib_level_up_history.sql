-- Migration: Create IB level up history table
-- This table tracks when IBs automatically upgrade to higher commission structures

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


