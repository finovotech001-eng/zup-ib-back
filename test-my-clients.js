import { query } from './config/database.js';

async function testMyClients() {
  try {
    // Test for finovo (ID 2)
    const ibRequestId = 2;
    
    console.log('Testing My Clients for IB ID:', ibRequestId);
    console.log('');
    
    const clientsResult = await query(`
      SELECT 
        ib.id as ib_id,
        ib.full_name as user_name,
        ib.email as user_email,
        ib.submitted_at as linked_at,
        ib.ib_type,
        ib.status,
        COALESCE(SUM(th.volume_lots), 0) as direct_volume_lots,
        COALESCE(SUM(th.ib_commission), 0) as direct_commission,
        COUNT(DISTINCT ma."accountId") as account_count
      FROM ib_requests ib
      LEFT JOIN "User" u ON u.email = ib.email
      LEFT JOIN "MT5Account" ma ON ma."userId" = u.id
      LEFT JOIN ib_trade_history th ON th.ib_request_id = ib.id
      WHERE ib.referred_by = $1
      GROUP BY ib.id, ib.full_name, ib.email, ib.submitted_at, ib.ib_type, ib.status
      ORDER BY ib.submitted_at DESC
    `, [ibRequestId]);
    
    console.log('Found clients:', clientsResult.rows.length);
    console.log('');
    
    clientsResult.rows.forEach((client, idx) => {
      console.log(`${idx + 1}. ${client.user_name} (${client.user_email})`);
      console.log(`   Status: ${client.status}`);
      console.log(`   IB Type: ${client.ib_type}`);
      console.log(`   Accounts: ${client.account_count}`);
      console.log(`   Total Lots: ${client.direct_volume_lots}`);
      console.log(`   Commission: $${client.direct_commission}`);
      console.log('');
    });
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

testMyClients();
