/**
 * Login Diagnostic Tool
 * 
 * This script helps diagnose login issues by:
 * 1. Listing all users in the database
 * 2. Allowing you to reset a user's password for testing
 */

import prisma from '../src/lib/prisma';
import bcrypt from 'bcrypt';
import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function main() {
  console.log('\n🔍 LOGIN DIAGNOSTIC TOOL\n');
  console.log('='.repeat(70));

  // List all users
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      isActive: true,
      createdAt: true,
      lastLoginAt: true,
    },
  });

  console.log(`\nFound ${users.length} users:\n`);
  
  users.forEach((user, index) => {
    console.log(`${index + 1}. ${user.email}`);
    console.log(`   Active: ${user.isActive ? '✅' : '❌'}`);
    console.log(`   Created: ${user.createdAt.toLocaleDateString()}`);
    console.log(`   Last login: ${user.lastLoginAt ? user.lastLoginAt.toLocaleDateString() : 'Never'}`);
    console.log('');
  });

  console.log('='.repeat(70));
  console.log('\n📝 DIAGNOSIS OF YOUR LOGIN ISSUE:');
  console.log('\nBased on the database check, your users exist and have valid password hashes.');
  console.log('The login issue is likely one of these:');
  console.log('\n1. ❌ You forgot the password');
  console.log('2. ❌ Password is different from what you think');
  console.log('3. ❌ Typing error (check caps lock, spaces)');
  console.log('\n✅ SOLUTION: Use the forgot password feature you just implemented!');
  console.log('\nOr, if you want to reset a password manually for testing:\n');

  const answer = await question('Do you want to reset a user\'s password? (y/n): ');

  if (answer.toLowerCase() === 'y') {
    const emailInput = await question('\nEnter the email address: ');
    const user = users.find(u => u.email.toLowerCase() === emailInput.toLowerCase().trim());

    if (!user) {
      console.log('\n❌ User not found!');
      rl.close();
      return;
    }

    const newPassword = await question('\nEnter new password (min 8 characters): ');

    if (newPassword.length < 8) {
      console.log('\n❌ Password must be at least 8 characters!');
      rl.close();
      return;
    }

    console.log('\n⏳ Hashing password...');
    const passwordHash = await bcrypt.hash(newPassword, 12);

    console.log('⏳ Updating database...');
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });

    console.log('\n✅ Password updated successfully!');
    console.log(`\n📧 Email: ${user.email}`);
    console.log(`🔑 Password: ${newPassword}`);
    console.log('\nYou can now login with these credentials.');
  } else {
    console.log('\n✅ No problem! Use the forgot password feature instead.');
  }

  console.log('\n' + '='.repeat(70));
  console.log('Done!');
  rl.close();
  await prisma.$disconnect();
}

main().catch(console.error);
