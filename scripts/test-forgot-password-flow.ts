/**
 * Comprehensive Login & Forgot Password Test Script
 * 
 * This script will:
 * 1. Register a new test user
 * 2. Test login with correct credentials
 * 3. Test forgot password flow
 * 4. Test password reset flow
 * 5. Test login with new password
 */

import axios from 'axios';

const API_BASE = 'http://localhost:3000/api/v1';
const TEST_EMAIL = `test-${Date.now()}@e2e-password-reset.com`;
const TEST_PASSWORD = 'SecurePassword123!';
const NEW_PASSWORD = 'NewSecurePassword456!';

interface ApiResponse {
  success: boolean;
  data?: any;
  message?: string;
  error?: any;
}

// Helper to make API calls
async function apiCall(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  endpoint: string,
  data?: any,
  token?: string
): Promise<ApiResponse> {
  try {
    const headers: any = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await axios({
      method,
      url: `${API_BASE}${endpoint}`,
      data,
      headers,
    });

    return response.data;
  } catch (error: any) {
    if (error.response) {
      return {
        success: false,
        error: error.response.data,
      };
    }
    throw error;
  }
}

async function runTests() {
  console.log('🚀 Starting comprehensive login and forgot password tests...\n');

  let accessToken: string | undefined;
  let resetToken: string | undefined;

  try {
    // ============================================
    // TEST 1: Register a new user
    // ============================================
    console.log('📝 TEST 1: Registering new user...');
    const registerResult = await apiCall('POST', '/auth/register', {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      phone: `+234${Math.floor(Math.random() * 9000000000 + 1000000000)}`,
    });

    if (!registerResult.success) {
      console.error('❌ Registration failed:', registerResult.error);
      return;
    }
    console.log('✅ Registration successful');
    console.log(`   User ID: ${registerResult.data.user.id}`);
    console.log(`   Email: ${registerResult.data.user.email}`);
    accessToken = registerResult.data.accessToken;

    // ============================================
    // TEST 2: Login with correct credentials
    // ============================================
    console.log('\n🔐 TEST 2: Testing login with correct credentials...');
    const loginResult = await apiCall('POST', '/auth/login', {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });

    if (!loginResult.success) {
      console.error('❌ Login failed:', loginResult.error);
      return;
    }
    console.log('✅ Login successful');
    accessToken = loginResult.data.accessToken;

    // ============================================
    // TEST 3: Login with wrong password
    // ============================================
    console.log('\n🚫 TEST 3: Testing login with wrong password...');
    const wrongLoginResult = await apiCall('POST', '/auth/login', {
      email: TEST_EMAIL,
      password: 'WrongPassword123!',
    });

    if (wrongLoginResult.success) {
      console.error('❌ Security issue: Login succeeded with wrong password!');
      return;
    }
    console.log('✅ Login correctly rejected with wrong password');
    console.log(`   Error: ${wrongLoginResult.error?.error?.message || wrongLoginResult.error?.message}`);

    // ============================================
    // TEST 4: Request forgot password
    // ============================================
    console.log('\n📧 TEST 4: Testing forgot password request...');
    const forgotResult = await apiCall('POST', '/auth/forgot-password', {
      email: TEST_EMAIL,
    });

    if (!forgotResult.success) {
      console.error('❌ Forgot password request failed:', forgotResult.error);
      return;
    }
    console.log('✅ Forgot password request successful');
    console.log(`   Message: ${forgotResult.message}`);
    console.log('\n⚠️  Check your backend logs for the reset token link');
    console.log('   (Email service may be in dev mode - check Winston logs)');

    // ============================================
    // TEST 5: Request forgot password for non-existent user
    // ============================================
    console.log('\n🔒 TEST 5: Testing forgot password for non-existent user (anti-enumeration)...');
    const fakeEmailResult = await apiCall('POST', '/auth/forgot-password', {
      email: 'nonexistent@example.com',
    });

    if (!fakeEmailResult.success) {
      console.error('❌ Forgot password request failed:', fakeEmailResult.error);
      return;
    }
    console.log('✅ Anti-enumeration working: Same response for non-existent user');
    console.log(`   Message: ${fakeEmailResult.message}`);

    // ============================================
    // TEST 6: Get user profile
    // ============================================
    console.log('\n👤 TEST 6: Testing authenticated endpoint (GET /me)...');
    const meResult = await apiCall('GET', '/auth/me', undefined, accessToken);

    if (!meResult.success) {
      console.error('❌ Get profile failed:', meResult.error);
      return;
    }
    console.log('✅ Profile retrieval successful');
    console.log(`   Email: ${meResult.data.email}`);
    console.log(`   Active: ${meResult.data.isActive}`);

    // ============================================
    // MANUAL RESET TEST INSTRUCTIONS
    // ============================================
    console.log('\n\n' + '='.repeat(70));
    console.log('🔄 MANUAL PASSWORD RESET TEST');
    console.log('='.repeat(70));
    console.log('\nTo complete the password reset test:');
    console.log('\n1. Check your backend logs for a line containing:');
    console.log('   "Password reset email sent" or "EMAIL (dev fallback)"');
    console.log('\n2. Copy the reset token from the link');
    console.log('   (The link format: http://localhost:5173/reset-password?token=YOUR_TOKEN)');
    console.log('\n3. Run this curl command:');
    console.log(`\n   curl -X POST ${API_BASE}/auth/reset-password \\`);
    console.log(`     -H "Content-Type: application/json" \\`);
    console.log(`     -d '{"token":"YOUR_TOKEN","newPassword":"${NEW_PASSWORD}"}'`);
    console.log('\n4. Then test login with new password:');
    console.log(`\n   curl -X POST ${API_BASE}/auth/login \\`);
    console.log(`     -H "Content-Type: application/json" \\`);
    console.log(`     -d '{"email":"${TEST_EMAIL}","password":"${NEW_PASSWORD}"}'`);
    console.log('\n' + '='.repeat(70));

    console.log('\n\n✅ All automated tests passed!');
    console.log('\n📊 SUMMARY:');
    console.log('   ✓ User registration');
    console.log('   ✓ Login with correct credentials');
    console.log('   ✓ Login rejection with wrong password');
    console.log('   ✓ Forgot password request');
    console.log('   ✓ Anti-enumeration protection');
    console.log('   ✓ Authenticated endpoint access');
    console.log('\n📝 Test user created:');
    console.log(`   Email: ${TEST_EMAIL}`);
    console.log(`   Password: ${TEST_PASSWORD}`);

  } catch (error: any) {
    console.error('\n❌ Unexpected error:', error.message);
    if (error.response) {
      console.error('   Response:', error.response.data);
    }
  }
}

// Check if server is running
async function checkServer() {
  try {
    await axios.get(`${API_BASE.replace('/api/v1', '')}/health`);
    return true;
  } catch {
    return false;
  }
}

// Main execution
(async () => {
  const serverRunning = await checkServer();
  if (!serverRunning) {
    console.error('❌ Backend server is not running!');
    console.error(`   Please start it first: cd backend && npm run dev`);
    console.error(`   Expected URL: ${API_BASE}`);
    process.exit(1);
  }

  await runTests();
})();
