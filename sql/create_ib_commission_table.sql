-- SQL Query to create ib_commission table manually
-- This table stores IB commission data mapped to User table

CREATE TABLE IF NOT EXISTS ib_commission (
  id SERIAL PRIMARY KEY,
  ib_request_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  total_commission NUMERIC(15, 2) DEFAULT 0,
  fixed_commission NUMERIC(15, 2) DEFAULT 0,
  spread_commission NUMERIC(15, 2) DEFAULT 0,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(ib_request_id, user_id),
  CONSTRAINT fk_ib_request FOREIGN KEY (ib_request_id) REFERENCES ib_requests(id) ON DELETE CASCADE,
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES "User"(id) ON DELETE CASCADE
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_ib_commission_ib_request ON ib_commission(ib_request_id);
CREATE INDEX IF NOT EXISTS idx_ib_commission_user ON ib_commission(user_id);
CREATE INDEX IF NOT EXISTS idx_ib_commission_updated ON ib_commission(last_updated);

-- Add comment to table
COMMENT ON TABLE ib_commission IS 'Stores IB commission data mapped to User table for reliable dashboard display';

