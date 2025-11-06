import { query } from './config/database.js';

async function testReferrals() {
  try {
    // Get IB ID 2
    const ib2 = await query(`SELECT id, full_name, email FROM ib_requests WHERE id = 2`);
    console.log('IB ID 2:', ib2.rows[0]);
    
    // Get all referrals by IB ID 2
    const referrals = await query(`SELECT id, full_name, email, status FROM ib_requests WHERE referred_by = 2`);
    console.log('\nReferrals by IB ID 2:');
    referrals.rows.forEach(r => console.log(`- ${r.full_name} (${r.email}) - Status: ${r.status}`));
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

testReferrals();
