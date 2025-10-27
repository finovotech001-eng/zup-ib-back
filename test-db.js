import { query, closePool } from './config/database.js';

async function testDatabaseConnection() {
  console.log('Testing database connection...');

  try {
    const result = await query('SELECT NOW() AS current_time');
    console.log('✅ Database connection successful!');
    console.log('📅 Current database time:', result.rows[0].current_time);
  } catch (error) {
    console.error('❌ Database test failed:', error.message);
    console.error('Full error:', error);
  } finally {
    await closePool();
    console.log('\n🔌 Database connection closed');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testDatabaseConnection();
}

export default testDatabaseConnection;
