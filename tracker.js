(function() {
  'use strict';

  // Don't run on localhost or if in an iframe
  if (window.location.hostname === 'localhost' || 
      window.location.hostname === '127.0.0.1' ||
      window.self !== window.top) {
    return;
  }

  const script = document.currentScript;
  const siteId = script?.getAttribute('data-site-id');
  const backendUrl = script?.src.replace('/tracker.js', '');

  if (!siteId || !backendUrl) {
    console.error('Insight AI: Missing required attributes.');
    return;
  }

  // Generate or retrieve visitor ID
  let visitorId = localStorage.getItem('insight_ai_visitor_id');
  if (!visitorId) {
    visitorId = 'v2-' + Math.random().toString(36).substr(2, 9) + 
                Date.now().toString(36);
    try {
      localStorage.setItem('insight_ai_visitor_id', visitorId);
    } catch (e) {
      // Fallback to session storage if localStorage fails
      sessionStorage.setItem('insight_ai_visitor_id', visitorId);
    }
  }

  // Collect page data
  const pageData = {
    siteId: siteId,
    visitorId: visitorId,
    path: window.location.pathname,
    referrer: document.referrer,
    screenWidth: screen.width,
    screenHeight: screen.height,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timestamp: Date.now()
  };

  // Send tracking data
  function sendTracking() {
    // Use sendBeacon for better performance during page unload
    if (navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(pageData)], { type: 'application/json' });
      navigator.sendBeacon(backendUrl + '/track', blob);
    } else {
      // Fallback to fetch API
      fetch(backendUrl + '/track', {
        method: 'POST',
        body: JSON.stringify(pageData),
        headers: { 'Content-Type': 'application/json' },
        keepalive: true // Similar to sendBeacon behavior
      }).catch(() => { /* Silently fail */ });
    }
  }

  // Track page view with different strategies based on page load state
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sendTracking);
  } else {
    // If DOM is already loaded, use requestIdleCallback or setTimeout
    if ('requestIdleCallback' in window) {
      requestIdleCallback(sendTracking);
    } else {
      setTimeout(sendTracking, 0);
    }
  }

  // Track page exit
  window.addEventListener('beforeunload', function() {
    const exitData = { ...pageData, eventType: 'pageexit' };
    const blob = new Blob([JSON.stringify(exitData)], { type: 'application/json' });
    navigator.sendBeacon(backendUrl + '/track', blob);
  });

  // Track user engagement (optional)
  let engaged = false;
  const engagementEvents = ['click', 'scroll', 'keydown', 'mousemove'];
  
  engagementEvents.forEach(event => {
    document.addEventListener(event, function() {
      if (!engaged) {
        engaged = true;
        const engagementData = { ...pageData, eventType: 'engagement' };
        fetch(backendUrl + '/track', {
          method: 'POST',
          body: JSON.stringify(engagementData),
          headers: { 'Content-Type': 'application/json' }
        }).catch(() => { /* Silently fail */ });
      }
    }, { once: true, passive: true });
  });

})();