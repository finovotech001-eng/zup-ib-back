import pool, { query, closePool } from './config/database.js';

async function dropAllTables() {
  console.log('Dropping all created tables...');

  try {
    // Drop tables in reverse order of dependencies
    // First drop tables with foreign keys, then the referenced tables

    console.log('Dropping transactions table...');
    await query('DROP TABLE IF EXISTS transactions CASCADE');

    console.log('Dropping clients table...');
    await query('DROP TABLE IF EXISTS clients CASCADE');

    console.log('Dropping ibs table...');
    await query('DROP TABLE IF EXISTS ibs CASCADE');

    console.log('Dropping users table...');
    await query('DROP TABLE IF EXISTS users CASCADE');

    console.log('✅ All tables dropped successfully!');

    // Verify tables are dropped
    const result = await query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name IN ('users', 'ibs', 'clients', 'transactions')
    `);

    if (result.rows.length === 0) {
      console.log('✅ Verified: No test tables remain in database');
    } else {
      console.log('⚠️  Warning: Some tables may still exist:', result.rows);
    }

  } catch (error) {
    console.error('❌ Error dropping tables:', error.message);
    console.error('Full error:', error);
  } finally {
    await closePool();
    console.log('🔌 Database connection closed');
  }
}

// Run the script if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  dropAllTables();
}

export default dropAllTables;