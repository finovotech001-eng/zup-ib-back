-- Migration: Add referred_by column to ib_requests table
-- This migration adds a referred_by column to track which IB referred a new application

DO $$
BEGIN
  -- Add referred_by column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ib_requests' AND column_name = 'referred_by'
  ) THEN
    ALTER TABLE ib_requests 
    ADD COLUMN referred_by INTEGER REFERENCES ib_requests(id) ON DELETE SET NULL;
    
    -- Create index on referred_by for faster lookups
    CREATE INDEX IF NOT EXISTS idx_ib_requests_referred_by ON ib_requests(referred_by);
    
    RAISE NOTICE 'referred_by column added successfully';
  ELSE
    RAISE NOTICE 'referred_by column already exists';
  END IF;
END $$;


