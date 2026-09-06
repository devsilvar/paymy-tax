/**
 * Standalone Paystack Transfer Trigger Script
 *
 * Allows developers and admins to trigger an instant bank transfer directly
 * via Paystack's Transfers API.
 *
 * Usage:
 *   npx tsx scripts/trigger-transfer.ts [amount] [accountNumber] [bankCode] [secretKeyOverride]
 *
 * Examples:
 *   npx tsx scripts/trigger-transfer.ts 740 8148434507 999992
 *   LIVE_KEY=sk_live_... npx tsx scripts/trigger-transfer.ts 740 8148434507 999992
 */
import 'dotenv/config';

const amount = Number(process.argv[2] ?? 740);
const accountNumber = process.argv[3] ?? '8148434507';
const bankCode = process.argv[4] ?? '999992'; // OPay
const secretKey =
  process.env.LIVE_KEY ??
  process.argv[5] ??
  process.env.PAYSTACK_SECRET_KEY;

if (!secretKey) {
  console.error('❌ No Paystack secret key found in .env or arguments.');
  process.exit(1);
}

const isLiveKey = secretKey.startsWith('sk_live_');
console.log(`\n========================================`);
console.log(`PAYSTACK TRANSFER TRIGGER`);
console.log(`========================================`);
console.log(`Mode:           ${isLiveKey ? '🟢 LIVE (REAL MONEY)' : '🟡 TEST (SANDBOX)'}`);
console.log(`Key Prefix:     ${secretKey.slice(0, 10)}...`);
console.log(`Amount:         ₦${amount.toLocaleString('en-NG')}`);
console.log(`Destination:    ${accountNumber} (Bank Code: ${bankCode})`);
console.log(`========================================\n`);

async function paystackRequest(endpoint: string, method: string = 'GET', body?: any) {
  const url = `https://api.paystack.co${endpoint}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/json',
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok || !data.status) {
    const msg = data.message || `Paystack API Error HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data.data;
}

async function main() {
  // 1. Check current balance on Paystack
  console.log('1. Checking Paystack balance...');
  try {
    const balances = await paystackRequest('/balance');
    console.log('   Available balances on Paystack:');
    for (const b of balances) {
      console.log(`   - ${b.currency}: ₦${(b.balance / 100).toLocaleString('en-NG')}`);
    }
  } catch (err: any) {
    console.warn(`   ⚠️ Could not fetch balance: ${err.message}`);
  }

  // 2. Resolve destination bank account
  console.log('\n2. Resolving account name with NIBSS...');
  let recipientName = 'Beneficiary';
  try {
    const accountInfo = await paystackRequest(
      `/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`
    );
    recipientName = accountInfo.account_name;
    console.log(`   ✅ Account Resolved: ${recipientName}`);
  } catch (err: any) {
    console.warn(`   ⚠️ Account resolution note: ${err.message}`);
  }

  // 3. Create Transfer Recipient
  console.log('\n3. Creating Paystack transfer recipient...');
  const recipient = await paystackRequest('/transferrecipient', 'POST', {
    type: 'nuban',
    name: recipientName,
    account_number: accountNumber,
    bank_code: bankCode,
    currency: 'NGN',
    description: `PayMyTax Settlement to ${recipientName}`,
  });
  console.log(`   ✅ Recipient Code: ${recipient.recipient_code}`);

  // 4. Initiate Transfer
  const reference = `PMT-TRF-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
  console.log(`\n4. Initiating transfer of ₦${amount} (Ref: ${reference})...`);
  const transfer = await paystackRequest('/transfer', 'POST', {
    source: 'balance',
    amount: Math.round(amount * 100), // convert to Kobo
    recipient: recipient.recipient_code,
    reason: `PayMyTax Balance Settlement`,
    reference,
  });

  console.log('\n========================================');
  console.log('🎉 TRANSFER INITIATED SUCCESSFULLY');
  console.log('========================================');
  console.log(`Transfer Code: ${transfer.transfer_code}`);
  console.log(`Status:        ${transfer.status}`);
  console.log(`Reference:     ${reference}`);
  console.log(`Amount:        ₦${amount}`);
  console.log(`Recipient:     ${recipientName} (${accountNumber})`);
  console.log('========================================\n');
}

main().catch((err: any) => {
  console.error('\n❌ Transfer Failed:', err.message);
  if (err.message.includes('third party transfers') || err.message.includes('test secret key')) {
    console.log('\n💡 Note: Paystack test keys cannot dispatch NIBSS transfers to real bank accounts.');
    console.log('To execute a live real-money transfer, pass your live secret key:');
    console.log('  LIVE_KEY=sk_live_your_actual_key npx tsx scripts/trigger-transfer.ts 740 8148434507 999992\n');
  }
  process.exit(1);
});
