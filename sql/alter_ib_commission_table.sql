-- SQL Query to ALTER ib_commission table manually
-- Remove fixed_commission and spread_commission columns
-- Add total_trades and total_lots columns

-- Step 1: Add new columns if they don't exist
ALTER TABLE ib_commission 
ADD COLUMN IF NOT EXISTS total_trades INTEGER DEFAULT 0;

ALTER TABLE ib_commission 
ADD COLUMN IF NOT EXISTS total_lots NUMERIC(15, 2) DEFAULT 0;

-- Step 2: Remove old columns if they exist
ALTER TABLE ib_commission 
DROP COLUMN IF EXISTS fixed_commission;

ALTER TABLE ib_commission 
DROP COLUMN IF EXISTS spread_commission;

-- Verify the table structure
-- SELECT column_name, data_type 
-- FROM information_schema.columns 
-- WHERE table_name = 'ib_commission' 
-- ORDER BY ordinal_position;

