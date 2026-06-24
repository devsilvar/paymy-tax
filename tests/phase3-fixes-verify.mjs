// Targeted verification of the two fixes we just landed:
//   Fix #1 — defaultProfitMargin is honored (was always 20%).
//   Fix #3 — analytics validator rejects garbage from/to with 400, not 500.
//
// Run with backend on http://localhost:3000.

const BASE = 'http://localhost:3000/api/v1';
const TS = Date.now();
const EMAIL = `phase3-fix-${TS}@v.com`;
const PASSWORD = 'TestPass@123';
let accessToken = '';
let businessId = '';

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, body: json };
}

let pass = 0, fail = 0;
function check(label, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${label}`); pass++; }
  else { console.log(`  ✗ ${label}  ${detail}`); fail++; }
}

// Setup
const reg = await api('POST', '/auth/register', { email: EMAIL, password: PASSWORD, fullName: 'Fix Probe' });
if (reg.status !== 201) {
  console.error('register failed:', reg.status, JSON.stringify(reg.body));
  process.exit(2);
}
accessToken = reg.body.data.accessToken;

const biz = await api('POST', '/businesses', {
  businessName: 'Fix Probe Co',
  ownerName: 'Probe Owner',
  businessType: 'retail',
  state: 'Lagos',
  defaultProfitMargin: 35,  // not the legacy default of 20
});
businessId = biz.body.data.id;

// ─── Fix #1: defaultProfitMargin honored ───
console.log('\n━━━ Fix #1: defaultProfitMargin honored ━━━');

// Sale 1M, expense 990K → actual margin 1%.
// With expected=35, |1-35|=34 > 15 → margin_deviation fires, message says "(35%)".
// With expected=20 (the bug), it would say "(20%)".
await api('POST', `/businesses/${businessId}/sales`, {
  amount: 1000000, transactionDate: '2027-04-10', source: 'manual', description: 's',
});
await api('POST', `/businesses/${businessId}/expenses`, {
  amount: 990000, expenseDate: '2027-04-10', category: 'rent', description: 'e',
});

const calc = await api('POST', `/businesses/${businessId}/tax/calculate`, {
  month: 4, year: 2027,
});
const w = calc.body?.warnings?.find(x => x.type === 'margin_deviation');
check('margin_deviation warning fires', !!w, `warnings=${JSON.stringify(calc.body?.warnings)}`);
check('message references the configured 35% (not 20%)', w?.message?.includes('(35%)'), `msg="${w?.message}"`);

// ─── Fix #3: analytics validator ───
console.log('\n━━━ Fix #3: analytics validator ━━━');

const garbage = await api('GET', `/businesses/${businessId}/tax/analytics?range=custom&from=garbage&to=garbage`);
check('garbage from/to → 400 (not 500)', garbage.status === 400, `got ${garbage.status}, code=${garbage.body?.error?.code}`);
check('error code = VALIDATION_ERROR', garbage.body?.error?.code === 'VALIDATION_ERROR', `got ${garbage.body?.error?.code}`);

// Off-by-one month digits
const bad13 = await api('GET', `/businesses/${businessId}/tax/analytics?range=custom&from=2027-13&to=2027-14`);
check('from=2027-13 → 400', bad13.status === 400, `got ${bad13.status}`);

// Wrong format (YYYY-M, not YYYY-MM)
const wrongFmt = await api('GET', `/businesses/${businessId}/tax/analytics?range=custom&from=2027-1&to=2027-3`);
check('from=2027-1 (one digit) → 400', wrongFmt.status === 400, `got ${wrongFmt.status}`);

// Valid still works
const good = await api('GET', `/businesses/${businessId}/tax/analytics?range=custom&from=2027-01&to=2027-03`);
check('valid from/to still → 200', good.status === 200, `got ${good.status}`);

// Range alone (no from/to) still works
const r6 = await api('GET', `/businesses/${businessId}/tax/analytics?range=6m`);
check('range=6m alone → 200', r6.status === 200, `got ${r6.status}`);

console.log(`\n━━━ Summary ━━━`);
console.log(`  PASS: ${pass}`);
console.log(`  FAIL: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
