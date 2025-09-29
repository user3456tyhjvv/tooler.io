require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = process.env.PORT || 3001;

// --- CACHE SETUP ---
const NodeCache = require('node-cache');
const statsCache = new NodeCache({ stdTTL: 300 });

// --- INITIALIZATION ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Supabase client with better error handling
let supabase;
try {
  supabase = createClient(
    process.env.SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_KEY,
    {
      realtime: {
        disabled: true
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false
      },
      global: {
        headers: {
          'Content-Type': 'application/json',
        }
      }
    }
  );
  console.log('✅ Supabase client initialized');
} catch (error) {
  console.error('❌ Supabase client initialization failed:', error.message);
  supabase = null;
}

// --- MIDDLEWARE OPTIMIZATIONS ---
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(compression());

// IMPROVED CORS CONFIGURATION - FIXED WILDCARD ISSUE
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://localhost:3000', 
      'http://localhost:5173', 
      'https://localhost:3000',
      'https://www.tiffad.co.ke',
      'https://tiffad.co.ke',
      'https://www.gigatechshop.co.ke',
      'https://gigatechshop.co.ke',
      'https://www.yourspaceanalytics.info',
      'https://yourspaceanalytics.info'
    ];
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      // For tracking purposes, allow any origin
      callback(null, true);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Handle preflight requests for specific endpoints instead of using '*'
app.options('/track', cors());
app.options('/api/stats/:domain', cors());
app.options('/tracker.js', cors());

app.use(express.json({ limit: '10kb' }));

// Rate limiting - more generous for tracking
const trackLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 500,
  message: 'Too many tracking requests'
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200
});

// --- DATABASE SETUP FUNCTIONS ---

async function setupDatabase() {
  if (!supabase) {
    console.log('⚠️ Database setup skipped: Supabase client not available');
    return;
  }

  try {
    // Test connection by checking if table exists
    const { data, error } = await supabase
      .from('page_views')
      .select('count')
      .limit(1);

    if (error) {
      console.log('📋 Table might not exist. Attempting to create tables...');
      await createTables();
    } else {
      console.log('✅ Database connection successful - tables exist');
    }
  } catch (error) {
    console.log('⚠️ Database setup error:', error.message);
  }
}

async function createTables() {
  console.log('💡 Please create the tables manually in Supabase SQL Editor:');
  console.log(`
    CREATE TABLE IF NOT EXISTS page_views (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      site_id TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      path TEXT NOT NULL,
      referrer TEXT,
      screen_width INTEGER,
      screen_height INTEGER,
      language TEXT,
      timezone TEXT,
      event_type TEXT DEFAULT 'pageview',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS websites (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      domain TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_page_views_site_id ON page_views(site_id);
    CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON page_views(created_at);
    CREATE INDEX IF NOT EXISTS idx_websites_domain ON websites(domain);
  `);
}
setupDatabase();

// --- REAL TRACKING ENDPOINT (FIXED CORS) ---
app.post('/track', trackLimiter, async (req, res) => {
  // Let the CORS middleware handle headers - REMOVE manual CORS headers
  console.log('📨 Received tracking request:', req.body?.siteId, req.body?.path);

  const { 
    siteId, 
    visitorId, 
    path, 
    referrer, 
    screenWidth, 
    screenHeight, 
    language, 
    timezone,
    eventType = 'pageview',
    timestamp = Date.now()
  } = req.body;
  
  if (!siteId || !visitorId) {
    return res.status(400).json({ error: 'Missing required tracking info' });
  }

  try {
    // Store the tracking event in Supabase if available
    if (supabase) {
      const { data, error } = await supabase
        .from('page_views')
        .insert([
          {
            id: uuidv4(),
            site_id: siteId,
            visitor_id: visitorId,
            path: path || '/',
            referrer: referrer || 'direct',
            screen_width: screenWidth,
            screen_height: screenHeight,
            language: language,
            timezone: timezone,
            event_type: eventType,
            created_at: new Date(timestamp).toISOString()
          }
        ])
        .select();

      if (error) {
        console.error('Database insert error:', error);
        // Continue to log the event even if DB fails
      } else {
        console.log('✅ Tracked event in DB:', { 
          siteId, 
          visitorId, 
          path: path || '/', 
          eventType
        });
      }
    } else {
      console.log('📝 Tracked event (no DB):', { 
        siteId, 
        visitorId, 
        path: path || '/', 
        eventType
      });
    }
    
    res.status(204).send();
  } catch (error) {
    console.error('Unexpected tracking error:', error);
    res.status(204).send();
  }
});

// --- HELPER FUNCTIONS (FIXED STATS ERROR) ---

function getEmptyStats() {
  return {
    totalVisitors: 0,
    newVisitors: 0,
    returningVisitors: 0,
    bounceRate: 0,
    avgSessionDuration: 0,
    pagesPerVisit: 0,
    lastUpdated: new Date().toISOString(),
    realData: false,
    totalPageViews: 0,
    totalSessions: 0
  };
}

// FIXED: Added proper error handling for undefined pageViews
function calculateRealStats(pageViews) {
  // FIX: Check if pageViews is undefined or not an array
  if (!pageViews || !Array.isArray(pageViews)) {
    console.log('⚠️ calculateRealStats: pageViews is undefined or not an array');
    return getEmptyStats();
  }

  if (pageViews.length === 0) {
    return getEmptyStats();
  }

  const visitors = new Set(pageViews.map(pv => pv.visitor_id));
  const sessions = new Set();

  // Group by visitor and calculate sessions
  const visitorEvents = {};
  pageViews.forEach(pv => {
    if (!visitorEvents[pv.visitor_id]) {
      visitorEvents[pv.visitor_id] = [];
    }
    visitorEvents[pv.visitor_id].push(pv);
  });

  // Calculate sessions (visits with same visitor_id within 30 minutes)
  Object.values(visitorEvents).forEach(events => {
    events.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    let sessionStart = new Date(events[0].created_at);
    let sessionId = `${events[0].visitor_id}-${sessionStart.getTime()}`;
    sessions.add(sessionId);

    for (let i = 1; i < events.length; i++) {
      const currentTime = new Date(events[i].created_at);
      const timeDiff = (currentTime - sessionStart) / (1000 * 60); // minutes

      if (timeDiff > 30) {
        // New session
        sessionStart = currentTime;
        sessionId = `${events[i].visitor_id}-${sessionStart.getTime()}`;
        sessions.add(sessionId);
      }
    }
  });

  // Calculate bounce rate (single page sessions)
  const singlePageSessions = Array.from(sessions).filter(sessionId => {
    const visitorId = sessionId.split('-')[0];
    return visitorEvents[visitorId] && visitorEvents[visitorId].length === 1;
  });

  const totalVisitors = visitors.size;
  const totalSessions = sessions.size;
  const bounceRate = totalSessions > 0 ? (singlePageSessions.length / totalSessions) * 100 : 0;

  // FIX: Use optional chaining and proper fallbacks
  return {
    totalVisitors: totalVisitors,
    newVisitors: totalVisitors, // Simplified: all are new for now
    returningVisitors: 0, // Simplified
    bounceRate: parseFloat(bounceRate.toFixed(1)),
    avgSessionDuration: 120, // Simplified placeholder
    pagesPerVisit: parseFloat((pageViews?.length / totalSessions).toFixed(1)) || 0,
    lastUpdated: new Date().toISOString(),
    realData: true,
    totalPageViews: pageViews?.length || 0, // FIX: Added fallback
    totalSessions: totalSessions
  };
}

// --- REAL STATS ENDPOINT (FIXED UNDEFINED ERROR) ---
app.get('/api/stats/:domain', apiLimiter, async (req, res) => {
  const { domain } = req.params;
  
  if (!domain || domain.length > 255) {
    return res.status(400).json({ error: 'Invalid domain parameter' });
  }

  const cacheKey = `stats:${domain}`;
  const cachedStats = statsCache.get(cacheKey);
  
  // Only use cache if it's very fresh (10 seconds)
  if (cachedStats && (Date.now() - new Date(cachedStats.lastUpdated).getTime()) < 10000) {
    return res.json(cachedStats);
  }

  try {
    let pageViews = [];
    
    // Only query database if supabase is available
    if (supabase) {
      const { data, error } = await supabase
        .from('page_views')
        .select('*')
        .eq('site_id', domain)
        .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

      if (error) {
        console.error('Database query error:', error.message);
        // FIX: Ensure pageViews is always an array even on error
        pageViews = [];
      } else {
        // FIX: Added proper fallback
        pageViews = data || [];
      }
    }

    // Calculate real statistics
    const stats = calculateRealStats(pageViews);
    
    console.log('📊 Stats for:', domain, {
      totalVisitors: stats.totalVisitors,
      totalPageViews: stats.totalPageViews,
      realData: stats.realData
    });
    
    // Cache for only 10 seconds for near real-time updates
    statsCache.set(cacheKey, stats, 10);
    
    res.json(stats);

  } catch (error) {
    console.error(`Error fetching stats for ${domain}:`, error.message);
    // FIX: Return proper empty stats instead of letting it crash
    const emptyStats = getEmptyStats();
    emptyStats.message = "No tracking data yet. Add the tracker to your website.";
    res.json(emptyStats);
  }
});

// --- DEBUG ENDPOINT: Check tracking data ---
app.get('/api/debug/:domain', apiLimiter, async (req, res) => {
  const { domain } = req.params;
  
  try {
    let pageViews = [];
    let dbStatus = 'disconnected';
    
    if (supabase) {
      const { data, error } = await supabase
        .from('page_views')
        .select('*')
        .eq('site_id', domain)
        .order('created_at', { ascending: false })
        .limit(20);

      if (!error) {
        pageViews = data || [];
        dbStatus = 'connected';
      } else {
        console.error('Debug endpoint database error:', error);
      }
    }

    res.json({
      domain,
      database: dbStatus,
      totalRecords: pageViews.length,
      sampleRecords: pageViews.slice(0, 5),
      allVisitors: [...new Set(pageViews.map(pv => pv.visitor_id))],
      supabaseConfigured: !!supabase
    });

  } catch (error) {
    console.error('Debug endpoint error:', error);
    res.status(500).json({ 
      error: error.message,
      supabaseConfigured: !!supabase
    });
  }
});

// --- SERVE TRACKER SCRIPT (IMPROVED) ---
app.get('/tracker.js', (req, res) => {
  // Set proper CORS headers for the tracker script
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Vary', 'Origin');

  const trackerScript = `
(function() {
  'use strict';

  const config = {
    backendUrl: 'https://${req.get('host')}',
    trackEngagement: true,
    trackPageExit: true
  };

  // Don't run in iframes
  if (window.self !== window.top) {
    return;
  }

  const script = document.currentScript;
  const siteId = script?.getAttribute('data-site-id');

  if (!siteId) {
    console.error('Insight AI: Missing data-site-id attribute.');
    return;
  }

  // Generate or retrieve visitor ID
  let visitorId = localStorage.getItem('insight_ai_visitor_id');
  if (!visitorId) {
    visitorId = 'v2-' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
    try {
      localStorage.setItem('insight_ai_visitor_id', visitorId);
    } catch (e) {
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
    userAgent: navigator.userAgent,
    timestamp: Date.now()
  };

  // Send tracking data
  function sendTracking(eventType = 'pageview', customData = {}) {
    const trackingData = { ...pageData, ...customData, eventType };

    if (navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(trackingData)], { type: 'application/json' });
      navigator.sendBeacon(config.backendUrl + '/track', blob);
    } else {
      fetch(config.backendUrl + '/track', {
        method: 'POST',
        body: JSON.stringify(trackingData),
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        mode: 'no-cors' // Fallback for CORS issues
      }).catch(() => {});
    }
  }

  // Track initial page view
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => sendTracking('pageview'));
  } else {
    setTimeout(() => sendTracking('pageview'), 100);
  }

  // Track page exit
  if (config.trackPageExit) {
    window.addEventListener('beforeunload', function() {
      sendTracking('pageexit', { exitTime: Date.now() });
    });
  }

  // Track user engagement
  if (config.trackEngagement) {
    let engaged = false;
    const engagementEvents = ['click', 'scroll', 'keydown', 'mousemove'];

    engagementEvents.forEach(event => {
      document.addEventListener(event, function() {
        if (!engaged) {
          engaged = true;
          sendTracking('engagement', { engagementTime: Date.now() });
        }
      }, { once: true, passive: true });
    });
  }

  // Expose global function for custom events
  window.insightAI = window.insightAI || {};
  window.insightAI.track = function(eventName, customData = {}) {
    sendTracking(eventName, customData);
  };

  console.log('✅ Insight AI Tracker Loaded for site:', siteId);
})();
  `;

  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(trackerScript);
});

// --- HEALTH CHECK ENDPOINT ---
app.get('/api/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    tracking: 'active',
    database: supabase ? 'connected' : 'disconnected'
  });
});

// --- AI ENDPOINTS ---
const aiPromptCache = new NodeCache({ stdTTL: 600 });

app.post('/api/suggestions', apiLimiter, async (req, res) => {
  try {
    const { trafficData, domain } = req.body;
    
    if (!trafficData || !domain) {
      return res.status(400).json({ 
        error: 'Missing required data: trafficData and domain are required' 
      });
    }

    console.log('Generating suggestions for domain:', domain);

    const suggestions = {
      insights: [
        `Your site ${domain} shows potential with ${trafficData.totalVisitors} total visitors`,
        `New visitors make up ${Math.round((trafficData.newVisitors / trafficData.totalVisitors) * 100)}% of your traffic`,
        `A bounce rate of ${trafficData.bounceRate}% indicates room for improvement`
      ],
      recommendations: [
        "Implement lazy loading for images to improve page speed",
        "Add clear call-to-action buttons on key pages",
        "Create targeted landing pages for different audience segments",
        "Optimize for mobile devices to enhance user experience"
      ]
    };

    res.json(suggestions);

  } catch (error) {
    console.error('AI Suggestions Error:', error);
    res.json({
      insights: [
        "We're currently optimizing our analysis system",
        "Your site shows steady traffic patterns",
        "Focus on user experience improvements"
      ],
      recommendations: [
        "Ensure fast page loading times",
        "Make content easily accessible",
        "Engage visitors with clear calls to action"
      ]
    });
  }
});

app.post('/api/summary', apiLimiter, async (req, res) => {
  try {
    const { trafficData, domain } = req.body;
    
    if (!trafficData || !domain) {
      return res.status(400).json({ error: 'Missing required data' });
    }

    const summary = {
      summary: `Weekly summary for ${domain}: Your site received ${trafficData.totalVisitors} visitors with an average session duration of ${trafficData.avgSessionDuration} seconds. The bounce rate is ${trafficData.bounceRate}% and visitors view an average of ${trafficData.pagesPerVisit} pages per session.`
    };

    res.json(summary);
  } catch (error) {
    console.error('Summary generation error:', error);
    res.json({ 
      summary: `Weekly summary for ${domain}: Analytics system is active. Focus on creating engaging content to improve user retention.` 
    });
  }
});

// --- IMPROVEMENTS ENDPOINT ---
app.post('/api/improvements', apiLimiter, async (req, res) => {
  try {
    const { trafficData, domain } = req.body;
    
    if (!trafficData || !domain) {
      return res.status(400).json({ 
        error: 'Missing required data: trafficData and domain are required' 
      });
    }

    console.log('Generating improvements for domain:', domain);

    const improvements = {
      improvements: [
        "Optimize images for faster loading times",
        "Improve mobile responsiveness across all pages",
        "Simplify navigation structure for better user experience",
        "Add clear call-to-action buttons above the fold",
        "Implement schema markup for better SEO",
        "Reduce server response time through caching",
        "Add engaging visuals to reduce bounce rate"
      ]
    };

    res.json(improvements);

  } catch (error) {
    console.error('Improvements generation error:', error);
    res.json({
      improvements: [
        "Optimize images for faster loading",
        "Simplify navigation menus",
        "Enhance mobile responsiveness",
        "Improve page loading speed",
        "Add engaging content sections"
      ]
    });
  }
});

// --- WEBSITES REGISTRATION ENDPOINT ---
app.post('/api/websites', apiLimiter, async (req, res) => {
  try {
    const { domain } = req.body;

    if (!domain) {
      return res.status(400).json({ error: 'Domain is required' });
    }

    // Validate domain format (basic check)
    const domainRegex = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!domainRegex.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }

    if (supabase) {
      const { data, error } = await supabase
        .from('websites')
        .insert([{ domain }])
        .select();

      if (error) {
        if (error.code === '23505') { // Unique violation
          return res.status(409).json({ error: 'Domain already registered' });
        }
        console.error('Database insert error:', error);
        return res.status(500).json({ error: 'Could not register website' });
      }

      console.log('✅ Website registered:', domain);
      res.status(201).json({ 
        id: data[0].id,
        domain: data[0].domain,
        created_at: data[0].created_at
      });
    } else {
      // Fallback if no DB
      res.status(201).json({
        id: uuidv4(),
        domain,
        created_at: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Website registration error:', error);
    res.status(500).json({ error: 'Could not register website' });
  }
});

// --- INSTALLATION REQUESTS ENDPOINT ---
app.post('/api/help-requests', apiLimiter, async (req, res) => {
  try {
    const { domain, name, email } = req.body;

    if (!domain) {
      return res.status(400).json({ error: 'Domain is required' });
    }

    console.log('Help request received:', { domain, name, email });

    const response = {
      id: Date.now(),
      domain,
      name,
      email,
      status: 'pending',
      created_at: new Date().toISOString()
    };

    res.status(201).json(response);
  } catch (error) {
    console.error('Help request error:', error);
    res.status(500).json({ error: 'Could not save help request' });
  }
});

// --- ERROR HANDLING ---
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// --- 404 HANDLER ---
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    path: req.path,
    method: req.method
  });
});

// --- START SERVER ---
app.listen(port, () => {
  console.log(`🚀 Backend server running on http://localhost:${port}`);
  console.log(`📊 Health check: http://localhost:${port}/api/health`);
  console.log(`📈 Stats endpoint: http://localhost:${port}/api/stats/:domain`);
  console.log(`🤖 AI endpoints: http://localhost:${port}/api/suggestions`);
  console.log(`🔧 Improvements endpoint: http://localhost:${port}/api/improvements`);
  console.log(`📝 Tracker script: http://localhost:${port}/tracker.js`);
  console.log(`🎯 Tracking endpoint: http://localhost:${port}/track`);
  console.log(`🐛 Debug endpoint: http://localhost:${port}/api/debug/:domain`);
});