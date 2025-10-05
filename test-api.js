import fetch from 'node-fetch';

async function testRecentVisitors() {
  const domain = 'testdomain.com';
  const userId = 'testuserid';
  const url = `http://localhost:3001/api/recent-visitors/${domain}`;

  try {
    const response = await fetch(url, {
      headers: {
        'x-user-id': userId,
      },
    });

    if (!response.ok) {
      console.error('API request failed with status:', response.status);
      const text = await response.text();
      console.error('Response:', text);
      return;
    }

    const data = await response.json();
    console.log('API response data:', data);
  } catch (error) {
    console.error('Error making API request:', error);
  }
}

testRecentVisitors();
