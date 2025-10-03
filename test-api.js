import fetch from 'node-fetch';

async function testAPI() {
  console.log('🧪 Testing API endpoints...');

  try {
    // Test stats endpoint
    console.log('📊 Testing stats endpoint for tiffad.co.ke...');
    const response = await fetch('http://localhost:3001/api/stats/tiffad.co.ke', {
      method: 'GET',
      headers: {
        'x-user-id': 'a5576d05-be86-46fb-8910-0e9f3fff9d16',
        'Content-Type': 'application/json'
      }
    });

    if (response.ok) {
      const data = await response.json();
      console.log('✅ Stats response:', {
        totalVisitors: data.totalVisitors,
        totalPageViews: data.totalPageViews,
        realData: data.realData,
        lastUpdated: data.lastUpdated
      });
    } else {
      console.log('❌ Stats endpoint failed:', response.status, response.statusText);
    }

    // Test debug endpoint
    console.log('🐛 Testing debug endpoint for tiffad.co.ke...');
    const debugResponse = await fetch('http://localhost:3001/api/debug/tiffad.co.ke', {
      method: 'GET'
    });

    if (debugResponse.ok) {
      const debugData = await debugResponse.json();
      console.log('✅ Debug response:', {
        totalRecords: debugData.totalRecords,
        database: debugData.database,
        supabaseConfigured: debugData.supabaseConfigured
      });
    } else {
      console.log('❌ Debug endpoint failed:', debugResponse.status, debugResponse.statusText);
    }

  } catch (error) {
    console.log('❌ API test error:', error.message);
  }
}

testAPI();
