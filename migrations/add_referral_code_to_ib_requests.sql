-- Migration: Add referral_code column to ib_requests table
-- This migration adds a referral_code column that will store unique referral codes for approved IBs

DO $$
BEGIN
  -- Add referral_code column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ib_requests' AND column_name = 'referral_code'
  ) THEN
    ALTER TABLE ib_requests 
    ADD COLUMN referral_code VARCHAR(50) UNIQUE;
    
    -- Create index on referral_code for faster lookups
    CREATE INDEX IF NOT EXISTS idx_ib_requests_referral_code ON ib_requests(referral_code);
    
    RAISE NOTICE 'referral_code column added successfully';
  ELSE
    RAISE NOTICE 'referral_code column already exists';
  END IF;
END $$;


