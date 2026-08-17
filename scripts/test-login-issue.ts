import prisma from '../src/lib/prisma';
import bcrypt from 'bcrypt';

async function testLoginIssue() {
  try {
    console.log('🔍 Checking registered users...\n');
    
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        isActive: true,
        passwordHash: true,
        createdAt: true,
        lastLoginAt: true,
      },
      take: 5,
    });

    console.log(`Found ${users.length} users in database:\n`);
    
    for (const user of users) {
      console.log(`Email: ${user.email}`);
      console.log(`Active: ${user.isActive}`);
      console.log(`Created: ${user.createdAt}`);
      console.log(`Last Login: ${user.lastLoginAt || 'Never'}`);
      console.log(`Password Hash Length: ${user.passwordHash.length} chars`);
      console.log(`Password Hash Prefix: ${user.passwordHash.substring(0, 7)}`);
      
      // Test if password hash is valid bcrypt format
      const isBcrypt = user.passwordHash.startsWith('$2a$') || 
                       user.passwordHash.startsWith('$2b$') || 
                       user.passwordHash.startsWith('$2y$');
      console.log(`Valid bcrypt format: ${isBcrypt ? '✅' : '❌'}`);
      
      console.log('---');
    }

    // If we have users, let's test a known password
    if (users.length > 0) {
      const firstUser = users[0];
      console.log('\n🧪 Testing password verification...');
      console.log('Common test passwords to try:');
      const testPasswords = ['password123', 'Password123', 'test123', 'Test123!', '12345678'];
      
      for (const pwd of testPasswords) {
        try {
          const isMatch = await bcrypt.compare(pwd, firstUser.passwordHash);
          if (isMatch) {
            console.log(`✅ Match found! Password: "${pwd}"`);
            break;
          }
        } catch (error) {
          console.log(`❌ Error testing "${pwd}":`, error);
        }
      }
    }

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

testLoginIssue();
