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
import nodemailer from 'nodemailer';
import { createServer } from 'http';
import { Server } from 'socket.io';

const app = express();
const server = createServer(app);
const port = process.env.PORT || 3001;

// --- SOCKET.IO SETUP ---
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000", "https://yourspaceanalytics.info"],
    methods: ["GET", "POST"]
  }
});

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

// Email transporter - lazy initialization
let emailTransporter = null;

// Enhanced email transporter for Brevo
function getEmailTransporter() {
  if (emailTransporter) return emailTransporter;

  try {
    // Check if all required SMTP environment variables are present
    const requiredVars = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
    const missingVars = requiredVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      console.error('❌ Missing SMTP environment variables:', missingVars);
      console.log('💡 Brevo SMTP Configuration Guide:');
      console.log('   1. Log into Brevo → SMTP & API');
      console.log('   2. Get your SMTP credentials:');
      console.log('      - Server: smtp-relay.brevo.com');
      console.log('      - Port: 587');
      console.log('      - Login: Your Brevo email');
      console.log('      - Password: Your SMTP key');
      console.log('   3. Verify sender email in Brevo → Senders & IP');
      console.log('   4. Add to .env file:');
      console.log('      SMTP_HOST=smtp-relay.brevo.com');
      console.log('      SMTP_PORT=587');
      console.log('      SMTP_USER=your-brevo-email@domain.com');
      console.log('      SMTP_PASS=your-smtp-key');
      console.log('      SMTP_FROM=verified-sender@domain.com');
      return null;
    }

    console.log('🔧 Initializing Brevo email transporter with:', {
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      user: process.env.SMTP_USER,
      from: process.env.SMTP_FROM
    });

    emailTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true', // false for Brevo
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      // Brevo-specific settings
      tls: {
        rejectUnauthorized: false
      }
    });

    // Verify transporter configuration
    emailTransporter.verify(function (error, success) {
      if (error) {
        console.error('❌ Brevo email transporter verification failed:', error);
        console.log('💡 Troubleshooting tips:');
        console.log('   - Check your SMTP credentials in Brevo dashboard');
        console.log('   - Ensure sender email is verified in Brevo');
        console.log('   - Try alternative Brevo SMTP server: smtp.brevo.com');
      } else {
        console.log('✅ Brevo email transporter is ready to send messages');
      }
    });

    return emailTransporter;
  } catch (error) {
    console.error('❌ Brevo email transporter initialization failed:', error.message);
    return null;
  }
}

// --- HELPER FUNCTIONS ---
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
    totalSessions: 0,
    exitPages: [],
    trafficSources: [],
    conversionFunnel: []
  };
}

function isValidDomain(domain) {
  const domainRegex = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return domainRegex.test(domain);
}

function generateErrorId() {
  return uuidv4().substring(0, 8);
}

function getStartDate(range) {
  const now = new Date();
  switch(range) {
    case '24h': return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case '7d': return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case '30d': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    default: return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }
}

// --- SOCKET.IO HANDLERS ---
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);
  
  socket.on('subscribe-domain', (domain) => {
    socket.join(domain);
    console.log(`Client ${socket.id} subscribed to domain: ${domain}`);
  });

  socket.on('disconnect', () => {
    console.log('🔌 Client disconnected:', socket.id);
  });
});

// Emit real-time updates
function emitStatsUpdate(domain, stats) {
  io.to(domain).emit('stats-update', stats);
}

// --- MIDDLEWARE OPTIMIZATIONS ---
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5173','https://yourspaceanalytics.info','https://www.yourspaceanalytics.info'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id'],
  credentials: true
}));
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(compression());

// --- TRIAL EXPIRATION MIDDLEWARE ---
async function checkTrialExpiration(req, res, next) {
  try {
    const publicPaths = ['/api/health', '/track', '/tracker.js', '/api/paypal'];
    if (publicPaths.some(path => req.path.startsWith(path))) {
      return next();
    }

    const userId = req.headers['x-user-id'] || req.query.userId;
    if (!userId) return next();

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
    next();
  }
}

app.use(checkTrialExpiration);

// Enhanced CORS configuration
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://localhost:3000', 
      'http://localhost:5173', 
      'https://localhost:3000',
      'https://www.gigatechshop.co.ke',
      'https://gigatechshop.co.ke',
      'https://www.yourspaceanalytics.info',
      'https://yourspaceanalytics.info'
    ];
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-user-id']
}));

// Handle preflight requests
app.options('/track', cors());
app.options('/api/stats/:domain', cors());
app.options('/tracker.js', cors());

app.use(express.json({ limit: '10kb' }));

// Rate limiting
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
          time_on_page INTEGER,
          session_id TEXT,
          utm_source TEXT,
          utm_medium TEXT,
          utm_campaign TEXT,
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

    // Create profiles table for subscription management
    const { error: profilesError } = await supabase.rpc('exec_sql', {
      sql: `
        CREATE TABLE IF NOT EXISTS profiles (
          id UUID PRIMARY KEY,
          plan TEXT DEFAULT 'free',
          tracking_code TEXT,
          subscription_id TEXT,
          trial_ends_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `
    });

    if (profilesError) {
      console.error('Error creating profiles table:', profilesError);
    } else {
      console.log('✅ profiles table created or already exists');
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
  }
}

setupDatabase();

// --- MATERIALIZED VIEWS FOR PERFORMANCE ---
async function createMaterializedViews() {
  if (!supabase) return;
  
  try {
    await supabase.rpc('exec_sql', {
      sql: `
        CREATE MATERIALIZED VIEW IF NOT EXISTS daily_stats AS
        SELECT 
          site_id,
          DATE(created_at) as date,
          COUNT(DISTINCT visitor_id) as daily_visitors,
          COUNT(*) as page_views
        FROM page_views 
        GROUP BY site_id, DATE(created_at);
      `
    });
    console.log('✅ Materialized views created');
  } catch (error) {
    console.error('Error creating materialized views:', error);
  }
}

// --- ENHANCED STATS CALCULATION WITH TRENDS ---
async function calculateRealStats(pageViews, timeRange = '24h', domain = null) {
  if (!pageViews || !Array.isArray(pageViews)) {
    console.log('⚠️ calculateRealStats: pageViews is undefined or not an array');
    return getEmptyStats();
  }

  if (pageViews.length === 0) {
    return getEmptyStats();
  }

  const startTime = getStartDate(timeRange);
  const filteredPageViews = pageViews.filter(pv => 
    new Date(pv.created_at) >= startTime
  );

  if (filteredPageViews.length === 0) {
    return getEmptyStats();
  }

  // Calculate previous period for trend comparison
  const previousStartTime = getPreviousPeriodStart(timeRange);
  const previousPageViews = pageViews.filter(pv => {
    const createdAt = new Date(pv.created_at);
    return createdAt >= previousStartTime && createdAt < startTime;
  });

  // Calculate current period stats
  const currentStats = await calculatePeriodStats(filteredPageViews, domain, startTime);
  
  // Calculate previous period stats for trends
  const previousStats = previousPageViews.length > 0 
    ? await calculatePeriodStats(previousPageViews, domain, previousStartTime)
    : null;

  // Calculate trends
  const trends = calculateTrends(currentStats, previousStats);

  return {
    ...currentStats,
    trends,
    lastUpdated: new Date().toISOString(),
    realData: true
  };
}

// Helper function to calculate start of previous period
function getPreviousPeriodStart(timeRange) {
  const now = new Date();
  switch(timeRange) {
    case '24h':
      return new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48 hours ago
    case '7d':
      return new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000); // 14 days ago
    case '30d':
      return new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
    default:
      return new Date(now.getTime() - 48 * 60 * 60 * 1000);
  }
}

// Extract the stats calculation into a reusable function
async function calculatePeriodStats(pageViews, domain, periodStartTime) {
  const visitors = new Set();
  const sessions = new Map();
  const visitorEvents = {};
  const visitorFirstSeen = {};

  // Process page views and calculate sessions
  pageViews.forEach(pv => {
    const visitorId = pv.visitor_id;
    const visitTime = new Date(pv.created_at);
    
    visitors.add(visitorId);
    
    if (!visitorFirstSeen[visitorId] || visitTime < visitorFirstSeen[visitorId]) {
      visitorFirstSeen[visitorId] = visitTime;
    }

    if (!visitorEvents[visitorId]) {
      visitorEvents[visitorId] = [];
    }
    visitorEvents[visitorId].push({
      ...pv,
      timestamp: visitTime
    });

    if (!sessions.has(visitorId)) {
      sessions.set(visitorId, []);
    }

    const visitorSessions = sessions.get(visitorId);
    let sessionFound = false;

    for (let session of visitorSessions) {
      const lastEventTime = new Date(session.events[session.events.length - 1].created_at);
      const timeDiff = (visitTime - lastEventTime) / (1000 * 60);

      if (timeDiff <= 30) {
        session.events.push(pv);
        session.endTime = visitTime;
        sessionFound = true;
        break;
      }
    }

    if (!sessionFound) {
      visitorSessions.push({
        startTime: visitTime,
        endTime: visitTime,
        events: [pv],
        sessionId: `${visitorId}-${visitTime.getTime()}`
      });
    }
  });

  // Calculate total sessions
  let totalSessions = 0;
  sessions.forEach(visitorSessions => {
    totalSessions += visitorSessions.length;
  });

  // Calculate bounce rate (sessions with only one pageview)
  let bounceSessions = 0;
  sessions.forEach(visitorSessions => {
    visitorSessions.forEach(session => {
      if (session.events.length === 1) {
        bounceSessions++;
      }
    });
  });

  const bounceRate = totalSessions > 0 ? (bounceSessions / totalSessions) * 100 : 0;

  // Calculate average session duration
  let totalSessionDuration = 0;
  let sessionsWithDuration = 0;

  sessions.forEach(visitorSessions => {
    visitorSessions.forEach(session => {
      if (session.events.length > 1) {
        const duration = (session.endTime - session.startTime) / 1000;
        totalSessionDuration += duration;
        sessionsWithDuration++;
      }
    });
  });

  const avgSessionDuration = sessionsWithDuration > 0 ? 
    Math.round(totalSessionDuration / sessionsWithDuration) : 0;

  // Calculate returning visitors (visited before the period)
  let returningVisitors = 0;
  let historicalVisitors = new Set();

  if (supabase) {
    try {
      const { data: historicalData, error: histError } = await supabase
        .from('page_views')
        .select('visitor_id')
        .eq('site_id', domain)
        .lt('created_at', periodStartTime.toISOString());

      if (!histError && historicalData) {
        historicalData.forEach(pv => {
          if (pv.visitor_id) {
            historicalVisitors.add(pv.visitor_id);
          }
        });
      }
    } catch (error) {
      console.error('Error fetching historical visitors:', error);
    }
  }

  visitors.forEach(visitorId => {
    if (historicalVisitors.has(visitorId)) {
      returningVisitors++;
    }
  });

  const totalVisitors = visitors.size;
  const newVisitors = totalVisitors - returningVisitors;

  // Calculate pages per visit
  const pagesPerVisit = totalSessions > 0 ? 
    parseFloat((pageViews.length / totalSessions).toFixed(1)) : 0;

  return {
    totalVisitors,
    newVisitors,
    returningVisitors,
    bounceRate: parseFloat(bounceRate.toFixed(1)),
    avgSessionDuration,
    pagesPerVisit,
    totalPageViews: pageViews.length,
    totalSessions
  };
}

// Trend calculation function
function calculateTrends(currentStats, previousStats) {
  if (!previousStats) {
    // If no previous data, return neutral trends
    return {
      bounceRate: 0,
      avgSessionDuration: 0,
      pagesPerVisit: 0,
      totalVisitors: 0,
      newVisitors: 0,
      returningVisitors: 0
    };
  }

  // Helper function to calculate percentage change safely
  const calculateChange = (current, previous) => {
    if (previous === 0) {
      return current > 0 ? 100 : 0; // If no previous data but current exists, show 100% growth
    }
    return ((current - previous) / previous) * 100;
  };

  return {
    bounceRate: parseFloat(calculateChange(currentStats.bounceRate, previousStats.bounceRate).toFixed(1)),
    avgSessionDuration: parseFloat(calculateChange(currentStats.avgSessionDuration, previousStats.avgSessionDuration).toFixed(1)),
    pagesPerVisit: parseFloat(calculateChange(currentStats.pagesPerVisit, previousStats.pagesPerVisit).toFixed(1)),
    totalVisitors: parseFloat(calculateChange(currentStats.totalVisitors, previousStats.totalVisitors).toFixed(1)),
    newVisitors: parseFloat(calculateChange(currentStats.newVisitors, previousStats.newVisitors).toFixed(1)),
    returningVisitors: parseFloat(calculateChange(currentStats.returningVisitors, previousStats.returningVisitors).toFixed(1))
  };
}
// --- EXIT PAGES CALCULATION ---
function calculateExitPages(pageViews) {
  if (!pageViews || pageViews.length === 0) return [];

  const pageStats = {};
  const visitorPages = {};

  // Group by visitor to find exit pages
  pageViews.forEach(pv => {
    if (!visitorPages[pv.visitor_id]) {
      visitorPages[pv.visitor_id] = [];
    }
    visitorPages[pv.visitor_id].push(pv);
  });

  // Find exit pages for each visitor
  Object.values(visitorPages).forEach(pages => {
    pages.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const lastPage = pages[pages.length - 1];
    if (!pageStats[lastPage.path]) {
      pageStats[lastPage.path] = { visits: 0, exits: 0, totalTime: 0 };
    }
    pageStats[lastPage.path].exits++;
  });

  // Count total visits per page
  pageViews.forEach(pv => {
    if (!pageStats[pv.path]) {
      pageStats[pv.path] = { visits: 0, exits: 0, totalTime: 0 };
    }
    pageStats[pv.path].visits++;
    pageStats[pv.path].totalTime += pv.time_on_page || 0;
  });

  return Object.entries(pageStats)
    .map(([url, stats]) => ({
      url,
      exitRate: parseFloat(((stats.exits / stats.visits) * 100).toFixed(1)),
      visits: stats.visits,
      avgTimeOnPage: Math.round(stats.totalTime / stats.visits) || 0
    }))
    .sort((a, b) => b.exitRate - a.exitRate)
    .slice(0, 10);
}

// --- TRAFFIC SOURCES CALCULATION ---
function calculateTrafficSources(pageViews) {
  if (!pageViews || pageViews.length === 0) return [];

  const sourceStats = {};

  pageViews.forEach(pv => {
    const source = pv.utm_source || pv.referrer || 'direct';
    if (!sourceStats[source]) {
      sourceStats[source] = { visitors: new Set(), bounces: new Set(), conversions: 0 };
    }
    
    sourceStats[source].visitors.add(pv.visitor_id);
    
    // Simplified bounce detection (single page visit)
    const visitorPages = pageViews.filter(page => page.visitor_id === pv.visitor_id);
    if (visitorPages.length === 1) {
      sourceStats[source].bounces.add(pv.visitor_id);
    }
  });

  return Object.entries(sourceStats).map(([source, stats]) => {
    const totalVisitors = stats.visitors.size;
    const bounceRate = totalVisitors > 0 ? (stats.bounces.size / totalVisitors) * 100 : 0;
    
    return {
      source: source === 'direct' ? 'Direct' : formatSource(source),
      visitors: totalVisitors,
      bounceRate: parseFloat(bounceRate.toFixed(1)),
      conversionRate: 2.5, // Simplified for now
      cost: getEstimatedCost(source),
      revenue: getEstimatedRevenue(source, totalVisitors)
    };
  }).sort((a, b) => b.visitors - a.visitors);
}

function formatSource(source) {
  if (source.includes('google')) return 'Google';
  if (source.includes('facebook')) return 'Facebook';
  if (source.includes('instagram')) return 'Instagram';
  if (source.includes('twitter')) return 'Twitter';
  if (source.includes('linkedin')) return 'LinkedIn';
  if (source === 'direct') return 'Direct';
  
  try {
    if (source.startsWith('http')) {
      const url = new URL(source);
      return url.hostname.replace('www.', '');
    }
  } catch (e) {
    // If it's not a valid URL, return as is
  }
  
  return source;
}

function getEstimatedCost(source) {
  const costs = {
    'Google': 500,
    'Facebook': 300,
    'Instagram': 200,
    'Twitter': 150,
    'LinkedIn': 400,
    'Direct': 0
  };
  return costs[source] || 100;
}

function getEstimatedRevenue(source, visitors) {
  const conversionRates = {
    'Google': 0.04,
    'Facebook': 0.03,
    'Instagram': 0.025,
    'Twitter': 0.02,
    'LinkedIn': 0.05,
    'Direct': 0.06
  };
  
  const avgOrderValue = 89;
  const conversionRate = conversionRates[source] || 0.02;
  return Math.round(visitors * conversionRate * avgOrderValue);
}

// --- CONVERSION FUNNEL CALCULATION ---
function calculateConversionFunnel(pageViews) {
  if (!pageViews || pageViews.length === 0) return [];

  const stages = [
    { stage: 'view-product', pattern: /product|item|shop|store/ },
    { stage: 'add-to-cart', pattern: /cart|basket|add/ },
    { stage: 'checkout', pattern: /checkout|payment|billing/ },
    { stage: 'purchase', pattern: /success|thank-you|confirmation/ }
  ];

  const stageVisitors = {};
  stages.forEach(stage => stageVisitors[stage.stage] = new Set());

  // Assign visitors to stages based on visited pages
  pageViews.forEach(pv => {
    stages.forEach(({ stage, pattern }) => {
      if (pattern.test(pv.path.toLowerCase())) {
        stageVisitors[stage].add(pv.visitor_id);
      }
    });
  });

  const funnel = [];
  let previousVisitors = 0;

  stages.forEach((stage, index) => {
    const visitors = stageVisitors[stage.stage].size;
    const dropOffCount = index === 0 ? 0 : previousVisitors - visitors;
    const dropOffRate = index === 0 ? 0 : parseFloat(((dropOffCount / previousVisitors) * 100).toFixed(1));

    funnel.push({
      stage: stage.stage,
      visitors,
      dropOffCount,
      dropOffRate
    });

    previousVisitors = visitors;
  });

  return funnel;
}

// --- TIME SERIES DATA FOR CHARTS ---
async function getTimeSeriesData(domain, range) {
  if (!supabase) return [];

  try {
    const { data } = await supabase
      .from('page_views')
      .select('created_at, visitor_id')
      .eq('site_id', domain)
      .gte('created_at', getStartDate(range))
      .order('created_at', { ascending: true });
    
    return groupDataByTime(data || [], range);
  } catch (error) {
    console.error('Error fetching time series data:', error);
    return [];
  }
}

function groupDataByTime(data, range) {
  const groupedData = {};
  
  data.forEach(item => {
    const date = new Date(item.created_at);
    let timeKey;
    
    switch(range) {
      case '24h':
        timeKey = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        break;
      case '7d':
        timeKey = date.toLocaleDateString('en-US', { weekday: 'short' });
        break;
      case '30d':
        timeKey = `Week ${Math.ceil(date.getDate() / 7)}`;
        break;
      default:
        timeKey = date.toLocaleDateString();
    }
    
    if (!groupedData[timeKey]) {
      groupedData[timeKey] = { visitors: new Set(), count: 0 };
    }
    
    groupedData[timeKey].visitors.add(item.visitor_id);
    groupedData[timeKey].count++;
  });

  return Object.entries(groupedData).map(([time, stats]) => ({
    time,
    visitors: stats.visitors.size,
    pageViews: stats.count,
    timestamp: new Date().getTime() // Simplified, should be actual timestamp
  }));
}

// --- VALIDATION MIDDLEWARE ---
const validateStatsRequest = (req, res, next) => {
  const { domain } = req.params;
  
  if (!domain || domain.length > 255) {
    return res.status(400).json({ error: 'Invalid domain parameter' });
  }
  
  if (!isValidDomain(domain)) {
    return res.status(400).json({ error: 'Invalid domain format' });
  }
  
  next();
};

// --- AI ANALYSIS FUNCTIONS ---
async function analyzePageWithAI(page, domain) {
  try {
    const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    const prompt = `
Analyze this webpage's performance data and provide specific recommendations:

Page URL: ${page.url}
Domain: ${domain}
Performance Metrics:
- Exit Rate: ${page.exitRate}%
- Visits: ${page.visits}
- Average Time on Page: ${page.avgTimeOnPage} seconds

Based on these metrics and typical web performance standards, provide:
1. Severity assessment (high/medium/low)
2. 3-5 specific suggestions to improve retention
3. Performance issues to address
4. Security concerns if any
5. SEO recommendations

Return as JSON with this exact structure:
{
  "severity": "high|medium|low",
  "suggestions": ["suggestion1", "suggestion2", ...],
  "performanceIssues": ["issue1", "issue2", ...],
  "securityConcerns": ["concern1", "concern2", ...],
  "seoRecommendations": ["rec1", "rec2", ...]
}
`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    
    throw new Error('Invalid AI response format');
  } catch (error) {
    console.error('AI page analysis failed:', error);
    // Return fallback analysis
    return {
      severity: page.exitRate > 70 ? 'high' : page.exitRate > 40 ? 'medium' : 'low',
      suggestions: ['Improve page content relevance', 'Add clear call-to-action buttons'],
      performanceIssues: [],
      securityConcerns: [],
      seoRecommendations: ['Optimize meta tags', 'Improve page loading speed']
    };
  }
}

// --- WEBSITE CONTENT FETCHING ---
async function fetchWebsiteContent(domain) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    let response = await fetch(`https://${domain}`, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WebTrafficInsightAI/1.0)'
      }
    });

    clearTimeout(timeoutId);

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
    return html.substring(0, 50000);
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error(`Timeout fetching website content for ${domain}`);
    } else {
      console.error(`Error fetching website content for ${domain}:`, error.message);
    }
    return null;
  }
}

// --- AI PROMPT CACHE ---
const aiPromptCache = new NodeCache({ stdTTL: 600 });

// --- ENDPOINTS ---

// --- REAL TRACKING ENDPOINT ---
app.post('/track', trackLimiter, async (req, res) => {
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
    timeOnPage,
    sessionId,
    utmSource,
    utmMedium,
    utmCampaign,
    timestamp = Date.now()
  } = req.body;
  
  if (!siteId || !visitorId) {
    return res.status(400).json({ error: 'Missing required tracking info' });
  }

  try {
    if (supabase) {
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
            time_on_page: timeOnPage,
            session_id: sessionId,
            utm_source: utmSource,
            utm_medium: utmMedium,
            utm_campaign: utmCampaign,
            created_at: new Date(timestamp).toISOString()
          }
        ])
        .select();

      if (error) {
        console.error('Database insert error:', error);
      } else {
        console.log('✅ Tracked event in DB:', { siteId, visitorId, path: path || '/', eventType });
        // Emit real-time update
        emitStatsUpdate(siteId, { event: 'new_pageview', path: path || '/' });
      }
    } else {
      console.log('📝 Tracked event (no DB):', { siteId, visitorId, path: path || '/', eventType });
    }
    
    res.status(204).send();
  } catch (error) {
    console.error('Unexpected tracking error:', error);
    res.status(204).send();
  }
});

// --- ENHANCED STATS ENDPOINT ---
app.get('/api/stats/:domain', validateStatsRequest, apiLimiter, async (req, res) => {
  const { domain } = req.params;
  const userId = req.headers['x-user-id'] || req.query.userId;
  const timeRange = req.query.range || '24h';

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

  const cacheKey = `stats:${domain}:${timeRange}`;
  const cachedStats = statsCache.get(cacheKey);

  if (cachedStats && (Date.now() - new Date(cachedStats.lastUpdated).getTime()) < 30000) {
    return res.json(cachedStats);
  }

  try {
    let pageViews = [];

    if (supabase) {
      const startDate = getStartDate(timeRange);
      const { data, error } = await supabase
        .from('page_views')
        .select('*')
        .eq('site_id', domain)
        .gte('created_at', startDate.toISOString())
        .order('created_at', { ascending: true });

      if (error) {
        console.error('Database query error:', error.message);
        pageViews = [];
      } else {
        pageViews = data || [];
      }
    }

    // Calculate all statistics
    const stats = await calculateRealStats(pageViews, timeRange, domain);
    const exitPages = calculateExitPages(pageViews);
    const trafficSources = calculateTrafficSources(pageViews);
    const conversionFunnel = calculateConversionFunnel(pageViews);

    const fullStats = {
      ...stats,
      exitPages,
      trafficSources,
      conversionFunnel
    };

    console.log('📊 Stats for:', domain, 'range:', timeRange, 'user:', userId, {
      totalVisitors: stats.totalVisitors,
      totalPageViews: stats.totalPageViews,
      bounceRate: stats.bounceRate,
      realData: stats.realData
    });

    statsCache.set(cacheKey, fullStats, 30);
    res.json(fullStats);

  } catch (error) {
    console.error(`Error fetching stats for ${domain}:`, error.message);
    const emptyStats = getEmptyStats();
    emptyStats.message = "No tracking data yet. Add the tracker to your website.";
    res.json(emptyStats);
  }
});

// --- CHART DATA ENDPOINT ---
app.get('/api/chart-data/:domain', apiLimiter, async (req, res) => {
  const { domain } = req.params;
  const { range = '7d' } = req.query;
  
  try {
    const chartData = await getTimeSeriesData(domain, range);
    res.json(chartData);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch chart data' });
  }
});

// --- RECENT VISITORS ENDPOINT ---
// Replace your existing recent-visitors endpoint with this:
app.get('/api/recent-visitors/:domain', apiLimiter, async (req, res) => {
  const { domain } = req.params;
  const { limit = 50 } = req.query;
  const userId = req.headers['x-user-id'] || req.query.userId;

  console.log('📊 Recent visitors request:', { domain, limit, userId });

  // Validate user ownership
  if (supabase && userId) {
    try {
      const { data: website, error: ownershipError } = await supabase
        .from('websites')
        .select('id')
        .eq('userId', userId)
        .eq('domain', domain)
        .single();

      if (ownershipError || !website) {
        return res.status(403).json({ 
          error: 'Access denied: You do not own this website',
          data: []
        });
      }
    } catch (error) {
      console.error('Ownership check error:', error);
      return res.status(500).json({ 
        error: 'Could not verify website ownership',
        data: []
      });
    }
  }

  if (!supabase) {
    return res.json([]); // Return empty array if no database
  }

  try {
    const { data, error } = await supabase
      .from('page_views')
      .select('*')
      .eq('site_id', domain)
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (error) {
      console.error('Database query error:', error);
      return res.status(500).json({ 
        error: 'Database error: ' + error.message,
        data: []
      });
    }

    console.log('✅ Returning visitors:', data?.length || 0);
    res.json(data || []);

  } catch (error) {
    console.error('Recent visitors endpoint error:', error);
    res.status(500).json({ 
      error: 'Internal server error: ' + error.message,
      data: []
    });
  }
});

app.post('/api/ai/traffic-source-analysis', apiLimiter, async (req, res) => {
  try {
    const { source, domain, timeRange } = req.body;
    if (!source || !domain) {
      return res.status(400).json({ error: 'Source and domain are required' });
    }

    // Implement traffic source analysis with Gemini
    const model = ai.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    const prompt = `
Analyze this traffic source performance:

Source: ${source.source}
Domain: ${domain}
Time Range: ${timeRange}
Metrics:
- Visitors: ${source.visitors}
- Bounce Rate: ${source.bounceRate}%
- Conversion Rate: ${source.conversionRate}%
- Cost: $${source.cost || 'N/A'}
- Revenue: $${source.revenue || 'N/A'}

Provide performance analysis including:
1. Performance rating (excellent/good/fair/poor)
2. Budget allocation recommendation
3. Industry comparison
4. Optimization tips
5. Risk factors
6. Opportunity areas

Return as structured JSON.
`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return res.json(JSON.parse(jsonMatch[0]));
    }
    
    throw new Error('Invalid AI response format');
  } catch (error) {
    console.error('AI traffic source analysis error:', error);
    res.status(500).json({ error: 'AI analysis failed' });
  }
});

// --- EXISTING AI ENDPOINTS ---
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
      aiPromptCache.set(cacheKey, fallback, 300);
      return res.json(fallback);
    }

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
      suggestions = JSON.parse(text);
      if (!Array.isArray(suggestions)) {
        throw new Error('Not an array');
      }
    } catch (parseError) {
      console.error('AI response parsing error:', parseError);
      suggestions = text.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 10 && !line.startsWith('[') && !line.startsWith(']'))
        .slice(0, 7);
    }

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
        if (error.code === '23505') {
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

// --- DEBUG ENDPOINT ---
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

// --- TRACKER SCRIPT ---
app.get('/tracker.js', (req, res) => {
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

  if (window.self !== window.top) {
    return;
  }

  const script = document.currentScript;
  const siteId = script?.getAttribute('data-site-id');

  if (!siteId) {
    console.error('Insight AI: Missing data-site-id attribute.');
    return;
  }

  let visitorId = localStorage.getItem('insight_ai_visitor_id');
  if (!visitorId) {
    visitorId = 'v2-' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
    try {
      localStorage.setItem('insight_ai_visitor_id', visitorId);
    } catch (e) {
      sessionStorage.setItem('insight_ai_visitor_id', visitorId);
    }
  }

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
        mode: 'no-cors'
      }).catch(() => {});
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => sendTracking('pageview'));
  } else {
    setTimeout(() => sendTracking('pageview'), 100);
  }

  if (config.trackPageExit) {
    window.addEventListener('beforeunload', function() {
      sendTracking('pageexit', { exitTime: Date.now() });
    });
  }

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

// --- PAYPAL ENDPOINTS (KEEP EXISTING) ---
app.get('/api/paypal/debug-live', (req, res) => {
  const hasClientId = !!process.env.PAYPAL_CLIENT_ID;
  const hasClientSecret = !!process.env.PAYPAL_CLIENT_SECRET;
  const environment = process.env.PAYPAL_ENVIRONMENT || 'not set';
  
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

app.post("/api/paypal/create-subscription", apiLimiter, async (req, res) => {
  try {
    const { plan } = req.body;
    console.log('Create subscription request (LIVE):', { plan });

    if (!plan) {
      return res.status(400).json({ error: 'Plan is required' });
    }

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

app.post('/api/paypal/activate-subscription', apiLimiter, async (req, res) => {
  try {
    const { subscriptionId, userId } = req.body;

    if (!subscriptionId || !userId) {
      return res.status(400).json({ error: 'Subscription ID and User ID are required' });
    }

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

    const trackingCode = uuidv4().replace(/-/g, '').substring(0, 16);

    const planIds = {
      [process.env.PAYPAL_PLAN_ID_STARTER || "P-24X86838G1075281RNDOTOTQ"]: "starter",
      [process.env.PAYPAL_PLAN_ID_PRO || "P-2RL41504YR730211YNDOTOTY"]: "pro", 
      [process.env.PAYPAL_PLAN_ID_BUSINESS || "P-3C9652367W2242413NDOTOUA"]: "business"
    };

    const plan = planIds[subscription.plan_id] || 'starter';

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

// --- EMAIL FALLBACK ENDPOINT ---
// Replace your existing getEmailTransporter function with this:

// Replace your existing email endpoint with this:
app.post('/api/send-analytics-report', apiLimiter, async (req, res) => {
  try {
    const { to, subject, html, text } = req.body;

    console.log('📧 Received email request:', { 
      to, 
      subject: subject?.substring(0, 50) + (subject?.length > 50 ? '...' : ''),
      htmlLength: html?.length || 0 
    });

    // Validate required fields
    if (!to || !subject || !html) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        details: {
          to: !to ? 'missing' : 'provided',
          subject: !subject ? 'missing' : 'provided', 
          html: !html ? 'missing' : 'provided'
        }
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(to)) {
      return res.status(400).json({ 
        error: 'Invalid email address format',
        provided: to
      });
    }

    const transporter = getEmailTransporter();
    if (!transporter) {
      return res.status(500).json({ 
        error: 'Email service not configured',
        details: 'Please check your SMTP configuration in environment variables',
        requiredVars: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'],
        currentConfig: {
          SMTP_HOST: process.env.SMTP_HOST ? 'set' : 'missing',
          SMTP_USER: process.env.SMTP_USER ? 'set' : 'missing',
          SMTP_PASS: process.env.SMTP_PASS ? 'set' : 'missing',
          SMTP_FROM: process.env.SMTP_FROM ? 'set' : 'missing'
        }
      });
    }

    console.log('📧 Sending email to:', to);

    const mailOptions = {
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: to,
      subject: subject,
      html: html,
      text: text || html.replace(/<[^>]*>/g, '').substring(0, 500), // Create text version from HTML
      // Optional: Add reply-to
      replyTo: process.env.SMTP_REPLY_TO || process.env.SMTP_FROM || process.env.SMTP_USER
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Email sent successfully:', {
      messageId: info.messageId,
      to: to,
      subject: subject
    });

    res.json({
      success: true,
      messageId: info.messageId,
      method: 'nodemailer',
      message: 'Analytics report sent successfully'
    });

  } catch (error) {
    console.error('❌ Email sending failed:', error);
    
    let errorMessage = 'Failed to send email';
    let errorDetails = error.message;
    
    // Provide more specific error messages for common issues
    if (error.code === 'EAUTH') {
      errorMessage = 'Email authentication failed';
      errorDetails = 'Please check your SMTP username and password (app password for Gmail)';
    } else if (error.code === 'ECONNECTION') {
      errorMessage = 'Cannot connect to email server';
      errorDetails = 'Please check your SMTP host and port configuration';
    } else if (error.code === 'ENOTFOUND') {
      errorMessage = 'Email server not found';
      errorDetails = 'Please check your SMTP host address';
    }

    res.status(500).json({
      error: errorMessage,
      details: errorDetails,
      code: error.code
    });
  }
});
// Add to your backend (index.js)
app.get('/api/debug-recent-visitors/:domain', apiLimiter, async (req, res) => {
  const { domain } = req.params;
  const { limit = 50 } = req.query;
  const userId = req.headers['x-user-id'] || req.query.userId;

  console.log('🔍 Debug recent visitors request:', { domain, limit, userId });

  if (!supabase) {
    return res.json({ error: 'Database not configured', data: [] });
  }

  try {
    const { data, error } = await supabase
      .from('page_views')
      .select('*')
      .eq('site_id', domain)
      .order('created_at', { ascending: false })
      .limit(parseInt(limit));

    if (error) {
      console.error('Database error:', error);
      return res.json({ error: error.message, data: [] });
    }

    console.log('✅ Found visitors:', data?.length || 0);
    res.json({
      success: true,
      count: data?.length || 0,
      data: data || [],
      sample: data?.[0] || null
    });

  } catch (error) {
    console.error('Debug endpoint error:', error);
    res.status(500).json({ error: error.message, data: [] });
  }
});

// --- ERROR HANDLING ---
app.use((error, req, res, next) => {
  console.error('Error:', {
    message: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    timestamp: new Date().toISOString()
  });
  
  res.status(500).json({ 
    error: 'Internal server error',
    referenceId: generateErrorId()
  });
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
server.listen(port, () => {
  console.log(`🚀 Backend server running on http://localhost:${port}`);
  console.log(`🔌 Socket.IO server running`);
  console.log(`📊 Health check: http://localhost:${port}/api/health`);
  console.log(`📈 Stats endpoint: http://localhost:${port}/api/stats/:domain`);
  console.log(`📊 Chart data: http://localhost:${port}/api/chart-data/:domain`);
  console.log(`👥 Recent visitors: http://localhost:${port}/api/recent-visitors/:domain`);
  console.log(`🤖 AI endpoints: http://localhost:${port}/api/suggestions`);
  console.log(`🔧 Improvements endpoint: http://localhost:${port}/api/improvements`);
  console.log(`📝 Tracker script: http://localhost:${port}/tracker.js`);
  console.log(`🎯 Tracking endpoint: http://localhost:${port}/track`);
  console.log(`🐛 Debug endpoint: http://localhost:${port}/api/debug/:domain`);
  console.log(`💳 PayPal create subscription: http://localhost:${port}/api/paypal/create-subscription`);
});