import { query } from './config/database.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigration() {
  try {
    console.log('Running migration for mt5_groups table...');
    
    const migrationPath = join(__dirname, 'migrations', 'alter_mt5_groups.sql');
    const migrationSQL = await readFile(migrationPath, 'utf8');
    
    await query(migrationSQL);
    
    console.log('Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

runMigration();


