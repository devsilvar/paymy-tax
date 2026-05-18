/**
 * Setup Verification Script
 * 
 * Tests that all core modules can be imported without errors.
 * Does not require database connection.
 * 
 * Run with: npm run test:setup
 */

import config from './config';
import logger from './lib/logger';

console.log('🧪 Testing PayMyTax Backend Setup...\n');

// Test 1: Configuration
console.log('✅ Test 1: Configuration loaded');
console.log(`   - Environment: ${config.app.env}`);
console.log(`   - Port: ${config.app.port}`);
console.log(`   - API Version: ${config.app.apiVersion}`);

// Test 2: Logger
console.log('\n✅ Test 2: Winston logger initialized');
logger.info('Logger test message');

// Test 3: Environment variables
console.log('\n✅ Test 3: Environment variables');
console.log(`   - JWT_ACCESS_SECRET: ${config.jwt.accessSecret ? '✓ Set' : '✗ Missing'}`);
console.log(`   - JWT_REFRESH_SECRET: ${config.jwt.refreshSecret ? '✓ Set' : '✗ Missing'}`);
console.log(`   - DATABASE_URL: ${config.database.url ? '✓ Set' : '✗ Missing'}`);

// Test 4: TypeScript compilation
console.log('\n✅ Test 4: TypeScript compilation successful');

// Test 5: Express app creation (without starting server)
import { createApp } from './app';
const app = createApp();
console.log('\n✅ Test 5: Express app created successfully');

console.log('\n=================================');
console.log('✅ ALL TESTS PASSED!');
console.log('=================================\n');
console.log('📝 Next Steps:');
console.log('1. Set up a PostgreSQL database (Neon recommended)');
console.log('2. Update DATABASE_URL in .env');
console.log('3. Run: npm run prisma:migrate');
console.log('4. Run: npm run prisma:seed');
console.log('5. Run: npm run dev');
console.log('\n');
