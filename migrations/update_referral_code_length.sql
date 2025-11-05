-- Migration: Update referral_code column to maximum 8 characters
-- This migration updates the referral_code column to enforce a maximum length of 8 characters

DO $$
BEGIN
  -- Check if column exists and update its length
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ib_requests' AND column_name = 'referral_code'
  ) THEN
    -- Alter column to VARCHAR(8)
    ALTER TABLE ib_requests 
    ALTER COLUMN referral_code TYPE VARCHAR(8);
    
    RAISE NOTICE 'referral_code column updated to VARCHAR(8)';
  ELSE
    RAISE NOTICE 'referral_code column does not exist';
  END IF;
END $$;


