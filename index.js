import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { v4 as uuidv4 } from 'uuid';
import fetch from "node-fetch";
import { core } from '@paypal/checkout-server-sdk';


const app = express();
const port = process.env.PORT || 3001;

// --- CACHE SETUP ---
import NodeCache from 'node-cache';
const statsCache = new NodeCache({ stdTTL: 300 });

// --- INITIALIZATION ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Supabase client with better error handling
let supabase;
try {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('❌ Missing Supabase environment variables');
    supabase = null;
  } else {
    supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    );
    console.log('✅ Supabase client initialized');
  }
} catch (error) {
  console.error('❌ Supabase client initialization failed:', error.message);
  supabase = null;
}

// PayPal client - lazy initialization
let paypalClient = null;

function getPayPalClient() {
  if (paypalClient) return paypalClient;

  try {
    if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
      console.error('❌ Missing PayPal environment variables: PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET');
      return null;
    }

    const environment = process.env.PAYPAL_ENVIRONMENT === 'live'
      ? new core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
      : new core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET);

    paypalClient = new core.PayPalHttpClient(environment);
    console.log('✅ PayPal client initialized (lazy)');
    return paypalClient;
  } catch (error) {
    console.error('❌ PayPal client initialization failed:', error.message);
    return null;
  }
}

// --- MIDDLEWARE OPTIMIZATIONS ---
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(compression());

// --- TRIAL EXPIRATION MIDDLEWARE ---
async function checkTrialExpiration(req, res, next) {
  try {
    // Skip for auth-related endpoints and public endpoints
    const publicPaths = ['/api/health', '/track', '/tracker.js', '/api/paypal'];
    if (publicPaths.some(path => req.path.startsWith(path))) {
      return next();
    }

    // Check if user is authenticated via header or query param
    const userId = req.headers['x-user-id'] || req.query.userId;

    if (!userId) {
      return next(); // Allow anonymous access for now
    }

    if (supabase) {
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('plan, trial_ends_at')
        .eq('id', userId)
        .single();

      if (!error && profile) {
        const plan = profile.plan || 'free';
        const trialEndsAt = profile.trial_ends_at;
        const now = new Date();
        const trialEndDate = trialEndsAt ? new Date(trialEndsAt) : null;
        const trialExpired = trialEndDate ? now > trialEndDate : false;

        if (plan === 'free' && trialExpired) {
          return res.status(403).json({
            error: 'Trial expired',
            message: 'Your 14-day trial has ended. Please subscribe to continue using the service.',
            action: 'subscribe'
          });
        }
      }
    }

    next();
  } catch (error) {
    console.error('Trial check middleware error:', error);
    next(); // Continue on error to avoid blocking legitimate requests
  }
}

app.use(checkTrialExpiration);

// IMPROVED CORS CONFIGURATION - FIXED WILDCARD ISSUE
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://localhost:3000', 
      'http://localhost:5173', 
      'https://localhost:3000',
      // 'https://www.tiffad.co.ke',
      // 'https://tiffad.co.ke',
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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-user-id']
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
  if (!supabase) {
    console.log('⚠️ Cannot create tables: Supabase not configured');
    return;
  }

  try {
    console.log('🔧 Attempting to create tables automatically...');

    // Create page_views table
    const { error: pageViewsError } = await supabase.rpc('exec_sql', {
      sql: `
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
      `
    });

    if (pageViewsError) {
      console.error('Error creating page_views table:', pageViewsError);
    } else {
      console.log('✅ page_views table created or already exists');
    }

    // Create websites table
    const { error: websitesError } = await supabase.rpc('exec_sql', {
      sql: `
        CREATE TABLE IF NOT EXISTS websites (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          userId TEXT NOT NULL,
          domain TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(userId, domain)
        );
      `
    });

    if (websitesError) {
      console.error('Error creating websites table:', websitesError);
    } else {
      console.log('✅ websites table created or already exists');
    }

    // Create indexes
    const { error: indexError1 } = await supabase.rpc('exec_sql', {
      sql: 'CREATE INDEX IF NOT EXISTS idx_page_views_site_id ON page_views(site_id);'
    });

    const { error: indexError2 } = await supabase.rpc('exec_sql', {
      sql: 'CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON page_views(created_at);'
    });

    const { error: indexError3 } = await supabase.rpc('exec_sql', {
      sql: 'CREATE INDEX IF NOT EXISTS idx_websites_domain ON websites(domain);'
    });

    if (indexError1 || indexError2 || indexError3) {
      console.error('Error creating indexes:', indexError1, indexError2, indexError3);
    } else {
      console.log('✅ Indexes created or already exist');
    }

    console.log('🎉 Database setup completed');

  } catch (error) {
    console.error('❌ Error in createTables:', error);
    console.log('💡 Fallback: Please create the tables manually in Supabase SQL Editor:');
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
        userId TEXT NOT NULL,
        domain TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(userId, domain)
      );

      CREATE INDEX IF NOT EXISTS idx_page_views_site_id ON page_views(site_id);
      CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON page_views(created_at);
      CREATE INDEX IF NOT EXISTS idx_websites_domain ON websites(domain);
    `);
  }
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
      // Insert or update the website in the websites table for the user
      const userId = req.headers['x-user-id'] || req.query.userId || null;
      if (userId) {
        try {
          await supabase
            .from('websites')
            .upsert({ userId: userId, domain: siteId }, { onConflict: ['userId', 'domain'] });
        } catch (err) {
          console.error('Error upserting website:', err);
        }
      }

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
        console.error('Database insert error:', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code
        });
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
  const userId = req.headers['x-user-id'] || req.query.userId;

  if (!domain || domain.length > 255) {
    return res.status(400).json({ error: 'Invalid domain parameter' });
  }

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  // Check if user owns this domain
  if (supabase) {
    try {
      const { data: website, error: ownershipError } = await supabase
        .from('websites')
        .select('id')
        .eq('userId', userId)
        .eq('domain', domain)
        .single();

      if (ownershipError || !website) {
        return res.status(403).json({ error: 'Access denied: You do not own this website' });
      }
    } catch (error) {
      console.error('Ownership check error:', error);
      return res.status(500).json({ error: 'Could not verify website ownership' });
    }
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

    console.log('📊 Stats for:', domain, 'user:', userId, {
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

// --- HELPER FUNCTION TO FETCH WEBSITE CONTENT ---
async function fetchWebsiteContent(domain) {
  try {
    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    // Try HTTPS first
    let response = await fetch(`https://${domain}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WebTrafficInsightAI/1.0)'
      }
    });

    clearTimeout(timeoutId);

    // If HTTPS fails, try HTTP
    if (!response.ok && response.status !== 200) {
      const controller2 = new AbortController();
      const timeoutId2 = setTimeout(() => controller2.abort(), 10000);

      response = await fetch(`http://${domain}`, {
        signal: controller2.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; WebTrafficInsightAI/1.0)'
        }
      });

      clearTimeout(timeoutId2);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('text/html')) {
      throw new Error(`Expected HTML but got ${contentType}`);
    }

    const html = await response.text();
    return html.substring(0, 50000); // Limit to first 50k chars to avoid token limits

  } catch (error) {
    if (error.name === 'AbortError') {
      console.error(`Timeout fetching website content for ${domain}`);
    } else {
      console.error(`Error fetching website content for ${domain}:`, error.message);
    }
    return null;
  }
}

// --- IMPROVEMENTS ENDPOINT ---
app.post('/api/improvements', apiLimiter, async (req, res) => {
  try {
    const { trafficData, domain } = req.body;

    if (!trafficData || !domain) {
      return res.status(400).json({
        error: 'Missing required data: trafficData and domain are required'
      });
    }

    console.log('Generating AI-powered improvements for domain:', domain);

    const cacheKey = `improvements:${domain}`;
    const cachedResult = aiPromptCache.get(cacheKey);

    if (cachedResult) {
      console.log('Returning cached improvements for:', domain);
      return res.json(cachedResult);
    }

    // Fetch website content
    const websiteContent = await fetchWebsiteContent(domain);

    if (!websiteContent) {
      console.log('Could not fetch website content, using fallback for:', domain);
      const fallback = {
        improvements: [
          "Optimize images for faster loading",
          "Simplify navigation menus",
          "Enhance mobile responsiveness",
          "Improve page loading speed",
          "Add engaging content sections"
        ]
      };
      aiPromptCache.set(cacheKey, fallback, 300); // Cache fallback for 5 minutes
      return res.json(fallback);
    }

    // Generate AI suggestions using Gemini
    const prompt = `
Analyze this website's HTML content and traffic data to provide specific, actionable improvement suggestions.

Website Domain: ${domain}
Traffic Data:
- Total Visitors: ${trafficData.totalVisitors}
- Bounce Rate: ${trafficData.bounceRate}%
- Average Session Duration: ${trafficData.avgSessionDuration} seconds
- Pages per Visit: ${trafficData.pagesPerVisit}

Website HTML Content (first 50,000 characters):
${websiteContent}

Based on the HTML structure, content, and traffic metrics, provide 5-7 specific, actionable suggestions to improve the website's performance, user experience, and conversion rates. Focus on:
- Technical improvements (speed, mobile responsiveness)
- Content and design enhancements
- User engagement strategies
- SEO and accessibility improvements

Return only the suggestions as a JSON array of strings, no additional text or formatting.
`;

    const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim();

    let suggestions;
    try {
      // Try to parse as JSON array
      suggestions = JSON.parse(text);
      if (!Array.isArray(suggestions)) {
        throw new Error('Not an array');
      }
    } catch (parseError) {
      console.error('AI response parsing error:', parseError);
      // Fallback: split by newlines and clean up
      suggestions = text.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 10 && !line.startsWith('[') && !line.startsWith(']'))
        .slice(0, 7);
    }

    // Ensure we have at least some suggestions
    if (suggestions.length === 0) {
      suggestions = [
        "Optimize images for faster loading",
        "Improve mobile responsiveness",
        "Simplify navigation structure",
        "Add clear call-to-action buttons",
        "Implement schema markup for SEO"
      ];
    }

    const resultData = { improvements: suggestions };

    // Cache the result for 10 minutes
    aiPromptCache.set(cacheKey, resultData, 600);

    console.log('Generated AI improvements for:', domain, suggestions.length, 'suggestions');

    res.json(resultData);

  } catch (error) {
    console.error('Improvements generation error:', error);
    const fallback = {
      improvements: [
        "Optimize images for faster loading",
        "Simplify navigation menus",
        "Enhance mobile responsiveness",
        "Improve page loading speed",
        "Add engaging content sections"
      ]
    };
    res.json(fallback);
  }
});

// --- WEBSITES REGISTRATION ENDPOINT ---
app.post('/api/websites', apiLimiter, async (req, res) => {
  try {
    const { domain } = req.body;
    const userId = req.headers['x-user-id'] || req.query.userId;

    if (!domain) {
      return res.status(400).json({ error: 'Domain is required' });
    }

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Validate domain format (basic check)
    const domainRegex = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!domainRegex.test(domain)) {
      return res.status(400).json({ error: 'Invalid domain format' });
    }

    if (supabase) {
      const { data, error } = await supabase
        .from('websites')
        .insert([{ userId: userId, domain }])
        .select();

      if (error) {
        if (error.code === '23505') { // Unique violation
          return res.status(409).json({ error: 'Domain already registered for this user' });
        }
        console.error('Database insert error:', error);
        return res.status(500).json({ error: 'Could not register website' });
      }

      console.log('✅ Website registered:', domain, 'for user:', userId);
      res.status(201).json({
        id: data[0].id,
        userId: data[0].userId,
        domain: data[0].domain,
        created_at: data[0].created_at
      });
    } else {
      // Fallback if no DB
      res.status(201).json({
        id: uuidv4(),
        userId: userId,
        domain,
        created_at: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Website registration error:', error);
    res.status(500).json({ error: 'Could not register website' });
  }
});

// --- GET WEBSITES FOR USER ENDPOINT ---
app.get('/api/websites/:userId', apiLimiter, async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    if (supabase) {
      const { data, error } = await supabase
        .from('websites')
        .select('*')
        .eq('userId', userId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Database query error:', error);
        return res.status(500).json({ error: 'Could not fetch websites' });
      }

      console.log('✅ Websites fetched for user:', userId, 'count:', data.length);
      res.json(data);
    } else {
      // Fallback if no DB
      res.json([]);
    }
  } catch (error) {
    console.error('Get websites error:', error);
    res.status(500).json({ error: 'Could not fetch websites' });
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

// --- PAYPAL ENDPOINTS ---

// Create subscription
// Create subscription - FIXED VERSION

// Debug PayPal LIVE configuration
app.get('/api/paypal/debug-live', (req, res) => {
  const hasClientId = !!process.env.PAYPAL_CLIENT_ID;
  const hasClientSecret = !!process.env.PAYPAL_CLIENT_SECRET;
  const environment = process.env.PAYPAL_ENVIRONMENT || 'not set';
  
  // Check if credentials look like live credentials
  const clientId = process.env.PAYPAL_CLIENT_ID || '';
  const isLikelyLive = clientId.startsWith('A') && clientId.length > 50;
  
  res.json({
    paypalConfigured: hasClientId && hasClientSecret,
    environment: environment,
    isLikelyLiveCredentials: isLikelyLive,
    clientIdPresent: hasClientId,
    clientSecretPresent: hasClientSecret,
    frontendUrl: process.env.FRONTEND_URL || 'not set',
    planIds: {
      starter: process.env.PAYPAL_PLAN_ID_STARTER ? 'set' : 'not set',
      pro: process.env.PAYPAL_PLAN_ID_PRO ? 'set' : 'not set',
      business: process.env.PAYPAL_PLAN_ID_BUSINESS ? 'set' : 'not set'
    },
    endpoints: {
      token: 'https://api-m.paypal.com/v1/oauth2/token',
      subscriptions: 'https://api-m.paypal.com/v1/billing/subscriptions'
    }
  });
});


// Create subscription - LIVE VERSION
app.post("/api/paypal/create-subscription", apiLimiter, async (req, res) => {
  try {
    const { plan } = req.body;
    console.log('Create subscription request (LIVE):', { plan });

    if (!plan) {
      return res.status(400).json({ error: 'Plan is required' });
    }

    // Use your LIVE plan IDs (replace these with your actual LIVE plan IDs)
    const planIds = {
      starter: process.env.PAYPAL_PLAN_ID_STARTER || "P-24X86838G1075281RNDOTOTQ",
      pro: process.env.PAYPAL_PLAN_ID_PRO || "P-2RL41504YR730211YNDOTOTY",
      business: process.env.PAYPAL_PLAN_ID_BUSINESS || "P-3C9652367W2242413NDOTOUA"
    };

    const planId = planIds[plan];
    if (!planId) {
      return res.status(400).json({ error: `Invalid plan: ${plan}` });
    }

    console.log('Using LIVE plan ID:', planId);

    // Get OAuth2 token - USING LIVE ENDPOINT
    const auth = Buffer.from(
      `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
    ).toString("base64");

    const tokenRes = await fetch("https://api-m.paypal.com/v1/oauth2/token", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("❌ Failed to fetch LIVE access token:", errText);
      return res.status(500).json({ 
        error: "PayPal LIVE authentication failed",
        details: "Check your LIVE CLIENT_ID and CLIENT_SECRET in .env file"
      });
    }

    const { access_token } = await tokenRes.json();
    console.log('✅ Successfully obtained PayPal LIVE access token');

    // Create Subscription - USING LIVE ENDPOINT
    const subRes = await fetch("https://api-m.paypal.com/v1/billing/subscriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${access_token}`,
        "Prefer": "return=representation"
      },
      body: JSON.stringify({
        plan_id: planId,
        application_context: {
          brand_name: "YourSpace Analytics",
          locale: "en-US",
          shipping_preference: "NO_SHIPPING",
          user_action: "SUBSCRIBE_NOW",
          payment_method: {
            payer_selected: "PAYPAL",
            payee_preferred: "IMMEDIATE_PAYMENT_REQUIRED"
          },
          return_url: `${process.env.FRONTEND_URL || 'https://yourspaceanalytics.info'}/dashboard?payment=success`,
          cancel_url: `${process.env.FRONTEND_URL || 'https://yourspaceanalytics.info'}/dashboard?payment=cancel`
        }
      })
    });

    if (!subRes.ok) {
      const errText = await subRes.text();
      console.error("❌ PayPal LIVE subscription creation failed:", errText);
      return res.status(500).json({ 
        error: "PayPal LIVE subscription failed", 
        details: errText 
      });
    }

    const subscription = await subRes.json();
    console.log("✅ Created PayPal LIVE subscription:", subscription.id);

    // Find approval URL
    const approvalLink = subscription.links.find(link => link.rel === 'approve');
    
    if (!approvalLink) {
      console.error('❌ No approval link found in PayPal LIVE response');
      return res.status(500).json({ error: 'No approval URL received from PayPal LIVE' });
    }

    res.json({
      subscriptionId: subscription.id,
      approvalUrl: approvalLink.href,
      status: subscription.status
    });

  } catch (error) {
    console.error("❌ Backend create-subscription LIVE error:", error);
    res.status(500).json({ 
      error: "Internal server error",
      details: error.message 
    });
  }
});
// Activate subscription (webhook handler)
// Activate subscription (webhook handler) - LIVE VERSION
app.post('/api/paypal/activate-subscription', apiLimiter, async (req, res) => {
  try {
    const { subscriptionId, userId } = req.body;

    if (!subscriptionId || !userId) {
      return res.status(400).json({ error: 'Subscription ID and User ID are required' });
    }

    // Get OAuth2 token to verify subscription - USING LIVE ENDPOINT
    const auth = Buffer.from(
      `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
    ).toString("base64");

    const tokenRes = await fetch("https://api-m.paypal.com/v1/oauth2/token", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("❌ Failed to fetch LIVE access token for activation:", errText);
      return res.status(500).json({ error: 'PayPal LIVE authentication failed' });
    }

    const { access_token } = await tokenRes.json();

    // Get subscription details - USING LIVE ENDPOINT
    const subRes = await fetch(`https://api-m.paypal.com/v1/billing/subscriptions/${subscriptionId}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${access_token}`
      }
    });

    if (!subRes.ok) {
      const errText = await subRes.text();
      console.error("❌ Failed to get LIVE subscription details:", errText);
      return res.status(500).json({ error: 'Failed to verify LIVE subscription' });
    }

    const subscription = await subRes.json();

    if (subscription.status !== 'ACTIVE' && subscription.status !== 'APPROVED') {
      return res.status(400).json({ 
        error: 'Subscription is not active', 
        currentStatus: subscription.status 
      });
    }

    // Generate tracking code
    const trackingCode = uuidv4().replace(/-/g, '').substring(0, 16);

    // Determine plan based on plan_id - USE YOUR LIVE PLAN IDs
    const planIds = {
      [process.env.PAYPAL_PLAN_ID_STARTER || "P-24X86838G1075281RNDOTOTQ"]: "starter",
      [process.env.PAYPAL_PLAN_ID_PRO || "P-2RL41504YR730211YNDOTOTY"]: "pro", 
      [process.env.PAYPAL_PLAN_ID_BUSINESS || "P-3C9652367W2242413NDOTOUA"]: "business"
    };

    const plan = planIds[subscription.plan_id] || 'starter';

    // Update user profile in Supabase
    if (supabase) {
      const { error } = await supabase
        .from('profiles')
        .update({
          plan: plan,
          tracking_code: trackingCode,
          subscription_id: subscriptionId,
          updated_at: new Date().toISOString()
        })
        .eq('id', userId);

      if (error) {
        console.error('Database update error:', error);
        return res.status(500).json({ error: 'Failed to update user profile' });
      }
    }

    console.log('LIVE Subscription activated for user:', userId, 'plan:', plan, 'tracking code:', trackingCode);

    res.json({
      success: true,
      trackingCode: trackingCode,
      plan: plan,
      subscriptionStatus: subscription.status
    });

  } catch (error) {
    console.error('PayPal LIVE activate subscription error:', error);
    res.status(500).json({ error: 'Failed to activate LIVE subscription' });
  }
});
// Get user subscription status
app.get('/api/paypal/subscription-status/:userId', apiLimiter, async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    if (!supabase) {
      return res.status(500).json({ error: 'Database not configured' });
    }

    const { data, error } = await supabase
      .from('profiles')
      .select('plan, tracking_code, subscription_id')
      .eq('id', userId)
      .single();

    if (error) {
      console.error('Database query error:', error);
      return res.status(500).json({ error: 'Failed to get subscription status' });
    }

    res.json({
      plan: data.plan || 'free',
      trackingCode: data.tracking_code,
      subscriptionId: data.subscription_id
    });

  } catch (error) {
    console.error('Get subscription status error:', error);
    res.status(500).json({ error: 'Failed to get subscription status' });
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
  console.log(`💳 PayPal create subscription: http://localhost:${port}/api/paypal/create-subscription`);
  console.log(`✅ PayPal activate subscription: http://localhost:${port}/api/paypal/activate-subscription`);
  console.log(`📋 PayPal subscription status: http://localhost:${port}/api/paypal/subscription-status/:userId`);
});
