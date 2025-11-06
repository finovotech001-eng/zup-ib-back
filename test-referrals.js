import { query } from './config/database.js';

async function testReferrals() {
  try {
    console.log('Testing referral system for finovotech001@gmail.com...\n');
    
    // Get the IB request ID for finovotech001@gmail.com
    const ibResult = await query(
      `SELECT id, full_name, email, status FROM ib_requests WHERE email = $1`,
      ['finovotech001@gmail.com']
    );
    
    if (ibResult.rows.length === 0) {
      console.log('❌ IB not found for finovotech001@gmail.com');
      process.exit(1);
    }
    
    const ib = ibResult.rows[0];
    console.log('✅ Found IB:', ib);
    console.log('IB Request ID:', ib.id);
    console.log('');
    
    // Check who referred this IB
    const referredResult = await query(
      `SELECT id, full_name, email, referred_by FROM ib_requests WHERE id = $1`,
      [ib.id]
    );
    console.log('Referred by:', referredResult.rows[0].referred_by);
    console.log('');
    
    // Check who this IB has referred
    const referralsResult = await query(
      `SELECT id, full_name, email, status, created_at 
       FROM ib_requests 
       WHERE referred_by = $1 
       ORDER BY created_at DESC`,
      [ib.id]
    );
    
    console.log(`📊 People referred by ${ib.full_name}:`);
    console.log('Total referrals:', referralsResult.rows.length);
    console.log('');
    
    if (referralsResult.rows.length > 0) {
      referralsResult.rows.forEach((ref, idx) => {
        console.log(`${idx + 1}. ${ref.full_name} (${ref.email})`);
        console.log(`   Status: ${ref.status}`);
        console.log(`   Created: ${ref.created_at}`);
        console.log('');
      });
    } else {
      console.log('❌ No referrals found');
    }
    
    // Check User table
    const userResult = await query(
      `SELECT id, email FROM "User" WHERE email = $1`,
      ['finovotech001@gmail.com']
    );
    
    if (userResult.rows.length > 0) {
      console.log('✅ User found in User table:', userResult.rows[0]);
    } else {
      console.log('❌ User NOT found in User table');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

testReferrals();
