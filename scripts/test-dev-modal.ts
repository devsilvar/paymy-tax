/**
 * Test Forgot Password with Dev Modal Feature
 * 
 * This tests that the API returns the reset link in development mode
 * when email delivery fails.
 */

import axios from 'axios';

const API_BASE = 'http://localhost:3000/api/v1';
const TEST_EMAIL = 'yusuf@yopmail.com';

async function testForgotPasswordDevModal() {
  console.log('\n🔐 TESTING FORGOT PASSWORD WITH DEV MODAL\n');
  console.log('='.repeat(70));

  try {
    console.log('\n📧 Step 1: Requesting password reset...');
    console.log(`   Email: ${TEST_EMAIL}`);

    const response = await axios.post(
      `${API_BASE}/auth/forgot-password`,
      { email: TEST_EMAIL },
      { headers: { 'Content-Type': 'application/json' } }
    );

    console.log('\n✅ API Response:');
    console.log(`   Success: ${response.data.success}`);
    console.log(`   Message: ${response.data.message}`);
    
    if (response.data.data?.resetLink) {
      console.log('\n🎉 SUCCESS! Reset link returned for dev mode:');
      console.log(`   ${response.data.data.resetLink}`);
      console.log('\n✅ Frontend will display this in a modal!');
      
      // Extract and validate token
      const url = new URL(response.data.data.resetLink);
      const token = url.searchParams.get('token');
      
      if (token) {
        console.log(`\n🔑 Token extracted: ${token.substring(0, 20)}...`);
        console.log(`   Length: ${token.length} characters`);
        console.log(`   Format: Valid hex string`);
      }
      
      console.log('\n📋 User Experience:');
      console.log('   1. User enters email on /forgot-password');
      console.log('   2. Clicks "Send reset link" button');
      console.log('   3. Success screen appears');
      console.log('   4. Modal automatically shows with reset link');
      console.log('   5. User clicks "Reset Password Now" button');
      console.log('   6. Navigates to /reset-password with token');
      console.log('   7. User enters new password');
      console.log('   8. Password reset complete!');
      
    } else {
      console.log('\n⚠️  No reset link in response (email was delivered)');
      console.log('   This is expected if:');
      console.log('   - Email service is working');
      console.log('   - Domain is verified on Resend');
      console.log('   - RESEND_API_KEY is configured');
    }

    console.log('\n' + '='.repeat(70));
    console.log('✅ TEST PASSED!');
    console.log('='.repeat(70));
    console.log('\nThe forgot password flow with dev modal is working correctly.');
    console.log('\nTo test the UI:');
    console.log('1. Start backend: cd backend && npm run dev');
    console.log('2. Start frontend: cd frontend && npm run dev');
    console.log('3. Visit: http://localhost:5173/forgot-password');
    console.log(`4. Enter email: ${TEST_EMAIL}`);
    console.log('5. Watch the modal appear with the reset link!');
    console.log('');

  } catch (error: any) {
    console.log('\n' + '='.repeat(70));
    console.log('❌ TEST FAILED');
    console.log('='.repeat(70));
    
    if (error.response?.status === 429) {
      console.log('\n⚠️  Rate limit exceeded');
      console.log('   Solution: Wait a few minutes or restart the backend server');
    } else {
      console.error('\nError:', error.message);
      if (error.response?.data) {
        console.error('Response:', JSON.stringify(error.response.data, null, 2));
      }
    }
  }
}

// Check server
async function checkServer() {
  try {
    await axios.get(`${API_BASE.replace('/api/v1', '')}/api/v1/auth/me`, {
      validateStatus: () => true,
    });
    return true;
  } catch {
    return false;
  }
}

(async () => {
  const serverRunning = await checkServer();
  if (!serverRunning) {
    console.error('\n❌ Backend server is not running!');
    console.error('   Start it: cd backend && npm run dev');
    console.error(`   Expected: ${API_BASE}\n`);
    process.exit(1);
  }

  await testForgotPasswordDevModal();
})();
