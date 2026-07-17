// Test script to verify knowledge state API
// Run with: node server/scripts/testKnowledgeStateAPI.js

require('dotenv').config({ path: './server/.env' });
const axios = require('axios');

async function testAPI() {
    const baseURL = 'http://localhost:8080/api';

    console.log('🧪 Testing Knowledge State API\n');

    // You'll need to replace this with a real token from your browser
    const token = 'YOUR_AUTH_TOKEN_HERE';

    try {
        console.log('1. Testing GET /api/knowledge-state...');
        const response = await axios.get(`${baseURL}/knowledge-state`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        console.log('✅ Success!');
        console.log('Status:', response.status);
        console.log('Data:', JSON.stringify(response.data, null, 2));

    } catch (error) {
        console.log('❌ Failed!');
        console.log('Status:', error.response?.status);
        console.log('Error:', error.response?.data || error.message);

        if (error.response?.status === 401) {
            console.log('\n⚠️  Authentication failed. Please:');
            console.log('1. Log in to your app');
            console.log('2. Open browser DevTools (F12)');
            console.log('3. Go to Application > Local Storage');
            console.log('4. Copy the value of "authToken"');
            console.log('5. Replace YOUR_AUTH_TOKEN_HERE in this script');
        }
    }
}

testAPI();
