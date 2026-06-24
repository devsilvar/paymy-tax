import axios from 'axios';

async function testAPI() {
  try {
    // First login to get token
    const loginRes = await axios.post('http://localhost:3000/api/v1/auth/login', {
      email: 'admin@paymytax.com',
      password: 'Admin@123456'
    });
    
    const token = loginRes.data.data.accessToken;
    console.log('✅ Logged in as admin\n');
    
    // Fetch classifications
    const res = await axios.get('http://localhost:3000/api/v1/transaction-classifications', {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    console.log('API Response:');
    console.log('Status:', res.status);
    console.log('Success:', res.data.success);
    console.log('Total classifications:', res.data.data.length);
    console.log('\nClassifications:');
    res.data.data.forEach((c: any, i: number) => {
      console.log(`${i + 1}. ${c.name} (${c.category}) - ${c.taxTreatment}`);
    });
    
  } catch (err: any) {
    console.error('❌ Error:', err.response?.data || err.message);
  }
}

testAPI();
