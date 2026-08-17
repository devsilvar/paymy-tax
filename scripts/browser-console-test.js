/**
 * Browser Console Testing Helper
 * 
 * Copy-paste this entire script into your browser console on the live site
 * to test DVA and transaction APIs directly.
 * 
 * SETUP:
 * 1. Login to your app at https://paymy-tax.onrender.com
 * 2. Open browser DevTools (F12)
 * 3. Go to Console tab
 * 4. Paste this entire script and press Enter
 * 5. Run: await testDVA()
 */

// Configuration
const API_BASE = 'https://paymy-tax.onrender.com/api/v1';
const BUSINESS_ID = '0ca4c440-5358-4ac6-923c-71317014baf7'; // Replace with your business ID

// Get auth token from localStorage (adjust based on your app's storage)
function getAuthToken() {
  // Try common token storage locations
  const token = localStorage.getItem('token') || 
                localStorage.getItem('authToken') ||
                localStorage.getItem('accessToken') ||
                sessionStorage.getItem('token');
  
  if (!token) {
    console.error('❌ No auth token found! Please login first.');
    console.log('💡 Looking for token in: localStorage.token, localStorage.authToken, etc.');
    return null;
  }
  
  console.log('✅ Auth token found');
  return token;
}

// API Helper
async function apiCall(endpoint, options = {}) {
  const token = getAuthToken();
  if (!token) return null;
  
  const url = `${API_BASE}${endpoint}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...options.headers
  };
  
  console.log(`🔄 ${options.method || 'GET'} ${url}`);
  
  try {
    const response = await fetch(url, {
      ...options,
      headers
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      console.error(`❌ ${response.status} ${response.statusText}`, data);
      return { error: data, status: response.status };
    }
    
    console.log(`✅ ${response.status}`, data);
    return data;
  } catch (error) {
    console.error('❌ Request failed:', error);
    return { error: error.message };
  }
}

// Test Functions
async function testDVA() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔍 DVA & TRANSACTION TESTING SUITE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  // Test 1: Get Virtual Account
  console.log('📋 Test 1: Get Virtual Account Details');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const dva = await apiCall(`/businesses/${BUSINESS_ID}/dva/virtual-account`);
  
  if (dva?.data?.accountNumber) {
    console.log(`\n✅ DVA Active!`);
    console.log(`   Account: ${dva.data.accountNumber}`);
    console.log(`   Bank: ${dva.data.bankName}`);
    console.log(`\n💡 Send a test transfer to this account to test webhooks\n`);
  } else if (dva?.data?.status === 'none') {
    console.log('\n⚠️  No DVA set up yet');
    console.log('💡 Set up DVA first via the frontend or:');
    console.log(`   POST /businesses/${BUSINESS_ID}/dva/setup-virtual-account\n`);
    return;
  }
  
  // Test 2: Check Unverified Transactions
  console.log('\n📋 Test 2: Check Unverified Transactions');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const unverified = await apiCall(`/businesses/${BUSINESS_ID}/sales/unverified`);
  
  if (unverified?.data?.length > 0) {
    console.log(`\n⚠️  Found ${unverified.data.length} unverified transaction(s):\n`);
    
    unverified.data.forEach((sale, idx) => {
      console.log(`${idx + 1}. ₦${sale.amount} - ${sale.customerName || 'Unknown'}`);
      console.log(`   ID: ${sale.id}`);
      console.log(`   Status: ${sale.status}`);
      console.log(`   Date: ${new Date(sale.transactionDate).toLocaleString()}`);
      console.log(`   Reference: ${sale.referenceId || 'N/A'}`);
      
      if (sale.metadata?.channel === 'dva') {
        console.log(`   ✅ Auto-captured from DVA`);
      }
      console.log('');
    });
    
    console.log(`💡 To verify a transaction, run:`);
    console.log(`   await verifyTransaction('${unverified.data[0].id}')\n`);
    
    // Store first sale ID globally for easy verification
    window.FIRST_SALE_ID = unverified.data[0].id;
  } else {
    console.log('\n✅ No unverified transactions (all clean!)\n');
  }
  
  // Test 3: Check All Sales
  console.log('\n📋 Test 3: All Sales Transactions');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const allSales = await apiCall(`/businesses/${BUSINESS_ID}/sales?limit=10`);
  
  if (allSales?.data?.length > 0) {
    console.log(`\n✅ Found ${allSales.data.length} transaction(s):\n`);
    
    const pending = allSales.data.filter(s => s.status === 'pending').length;
    const confirmed = allSales.data.filter(s => s.status === 'confirmed').length;
    
    console.log(`   ⏳ Pending: ${pending}`);
    console.log(`   ✅ Confirmed: ${confirmed}\n`);
  } else {
    console.log('\n❌ No sales transactions found!');
    console.log('💡 Possible reasons:');
    console.log('   1. No payments received yet');
    console.log('   2. Webhooks not configured');
    console.log('   3. Webhook processing failed\n');
  }
  
  // Test 4: Monthly Summary
  console.log('\n📋 Test 4: Monthly Summary (Confirmed Only)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  
  const summary = await apiCall(`/businesses/${BUSINESS_ID}/sales/summary?month=${month}&year=${year}`);
  
  if (summary?.data) {
    console.log(`\n📊 ${year}-${month.toString().padStart(2, '0')} Summary:`);
    console.log(`   Total Sales: ₦${summary.data.totalSales?.toFixed(2) || '0.00'}`);
    console.log(`   Transactions: ${summary.data.transactionCount || 0}`);
    
    if (summary.data.sourceBreakdown?.length > 0) {
      console.log('\n   Breakdown by source:');
      summary.data.sourceBreakdown.forEach(source => {
        console.log(`     ${source.source}: ₦${source.total.toFixed(2)} (${source.count} txns)`);
      });
    }
    console.log('');
  }
  
  // Summary
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ TESTING COMPLETE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  console.log('📋 Available Commands:');
  console.log('   await testDVA()                    - Run all tests');
  console.log('   await getUnverified()              - List unverified transactions');
  console.log('   await verifyTransaction(saleId)    - Verify a transaction');
  console.log('   await getSummary(month, year)      - Get monthly summary');
  console.log('   await createTestSale(amount)       - Create a test manual sale\n');
  
  if (window.FIRST_SALE_ID) {
    console.log('💡 Quick verify first unverified transaction:');
    console.log(`   await verifyTransaction('${window.FIRST_SALE_ID}')\n`);
  }
}

// Helper: Verify a transaction
async function verifyTransaction(saleId, classification = 'sale') {
  console.log(`\n🔄 Verifying transaction ${saleId}...`);
  
  const result = await apiCall(
    `/businesses/${BUSINESS_ID}/sales/${saleId}/verify`,
    {
      method: 'POST',
      body: JSON.stringify({ classification })
    }
  );
  
  if (result?.success) {
    console.log('✅ Transaction verified successfully!');
    console.log('💡 It will now appear in monthly summaries');
    return result;
  } else {
    console.error('❌ Verification failed');
    return result;
  }
}

// Helper: Get unverified transactions
async function getUnverified() {
  console.log('\n🔄 Fetching unverified transactions...');
  return await apiCall(`/businesses/${BUSINESS_ID}/sales/unverified`);
}

// Helper: Get monthly summary
async function getSummary(month, year) {
  if (!month || !year) {
    const now = new Date();
    month = month || now.getMonth() + 1;
    year = year || now.getFullYear();
  }
  
  console.log(`\n🔄 Fetching summary for ${year}-${month}...`);
  return await apiCall(`/businesses/${BUSINESS_ID}/sales/summary?month=${month}&year=${year}`);
}

// Helper: Create test manual sale
async function createTestSale(amount = 1000) {
  console.log(`\n🔄 Creating test sale of ₦${amount}...`);
  
  const result = await apiCall(
    `/businesses/${BUSINESS_ID}/sales`,
    {
      method: 'POST',
      body: JSON.stringify({
        amount: amount,
        source: 'manual',
        status: 'confirmed',
        customerName: 'Test Customer',
        transactionDate: new Date().toISOString(),
        description: 'Console test transaction'
      })
    }
  );
  
  if (result?.success) {
    console.log('✅ Test sale created!');
    console.log(`   ID: ${result.data.id}`);
    return result;
  } else {
    console.error('❌ Failed to create test sale');
    return result;
  }
}

// Helper: Check webhook events (if you have an admin endpoint)
async function checkWebhooks() {
  console.log('\n🔄 Checking recent webhook events...');
  
  // Try to access webhook logs if available
  const result = await apiCall('/admin/webhooks?limit=10');
  
  if (result?.error?.status === 403) {
    console.log('⚠️  Admin endpoint - requires admin access');
  }
  
  return result;
}

// Helper: Requery DVA (force check for missed transactions)
async function requeryDVA() {
  console.log('\n🔄 Requerying DVA for missed transactions...');
  console.log('⚠️  Note: Rate limited to once per 10 minutes');
  
  const result = await apiCall(
    `/businesses/${BUSINESS_ID}/dva/requery`,
    { method: 'POST' }
  );
  
  if (result?.success) {
    console.log('✅ Requery initiated');
    console.log('💡 Any missed transfers should appear in a few moments');
    return result;
  } else if (result?.error?.status === 429) {
    console.log('⚠️  Rate limited - please wait before requerying again');
    return result;
  } else {
    console.error('❌ Requery failed');
    return result;
  }
}

// Make functions globally available
window.testDVA = testDVA;
window.verifyTransaction = verifyTransaction;
window.getUnverified = getUnverified;
window.getSummary = getSummary;
window.createTestSale = createTestSale;
window.checkWebhooks = checkWebhooks;
window.requeryDVA = requeryDVA;

console.log('✅ DVA Testing Suite Loaded!');
console.log('💡 Run: await testDVA()');
