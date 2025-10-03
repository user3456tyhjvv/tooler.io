import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

async function createTables() {
  try {
    console.log('Creating tables...');

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

createTables();
