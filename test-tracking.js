import fetch from 'node-fetch';

const backendUrl = 'http://localhost:3001';

async function sendTrackingEvent(siteId, visitorId, path) {
  const response = await fetch(`${backendUrl}/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': 'test-user' },
    body: JSON.stringify({
      siteId,
      visitorId,
      path,
      referrer: '',
      screenWidth: 1920,
      screenHeight: 1080,
      language: 'en-US',
      timezone: 'UTC',
      eventType: 'pageview',
      timeOnPage: 30,
      sessionId: 'session1',
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      timestamp: Date.now()
    })
  });

  if (response.ok) {
    console.log(`Tracked event for visitor ${visitorId} on path ${path}`);
  } else {
    console.error(`Failed to track event for visitor ${visitorId} on path ${path}`);
  }
}

async function runTest() {
  const siteId = 'example.com';

  // Simulate multiple visitors and page views
  await sendTrackingEvent(siteId, 'visitor1', '/home');
  await sendTrackingEvent(siteId, 'visitor1', '/about');
  await sendTrackingEvent(siteId, 'visitor2', '/home');
  await sendTrackingEvent(siteId, 'visitor3', '/contact');
  await sendTrackingEvent(siteId, 'visitor2', '/products');
  await sendTrackingEvent(siteId, 'visitor1', '/checkout');
}

runTest().catch(console.error);
