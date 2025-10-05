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

    // Create users table for admin user management
    const { error: usersError } = await supabase.rpc('exec_sql', {
      sql: `
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email TEXT UNIQUE NOT NULL,
          full_name TEXT,
          role TEXT DEFAULT 'user',
          trial_start_date TIMESTAMPTZ DEFAULT NOW(),
          trial_end_date TIMESTAMPTZ,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `
    });

    if (usersError) {
      console.error('Error creating users table:', usersError);
    } else {
      console.log('✅ users table created or already exists');
    }

    // Create messages table for chat functionality
    const { error: messagesError } = await supabase.rpc('exec_sql', {
      sql: `
        CREATE TABLE IF NOT EXISTS messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          sender_id UUID REFERENCES users(id),
          recipient_id UUID REFERENCES users(id),
          content TEXT NOT NULL,
          message_type TEXT DEFAULT 'text',
          is_read BOOLEAN DEFAULT false,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `
    });

    if (messagesError) {
      console.error('Error creating messages table:', messagesError);
    } else {
      console.log('✅ messages table created or already exists');
    }

    // Create notifications table for admin notifications
    const { error: notificationsError } = await supabase.rpc('exec_sql', {
      sql: `
        CREATE TABLE IF NOT EXISTS notifications (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID REFERENCES users(id),
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          type TEXT DEFAULT 'info',
          is_read BOOLEAN DEFAULT false,
          sent_by UUID REFERENCES users(id),
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `
    });

    if (notificationsError) {
      console.error('Error creating notifications table:', notificationsError);
    } else {
      console.log('✅ notifications table created or already exists');
    }

    // Create user_trials table for trial management
    const { error: trialsError } = await supabase.rpc('exec_sql', {
      sql: `
        CREATE TABLE IF NOT EXISTS user_trials (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID REFERENCES users(id),
          start_date TIMESTAMPTZ DEFAULT NOW(),
          end_date TIMESTAMPTZ NOT NULL,
          status TEXT DEFAULT 'active',
          notified_3_days BOOLEAN DEFAULT false,
          notified_1_day BOOLEAN DEFAULT false,
          notified_expired BOOLEAN DEFAULT false,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
      `
    });

    if (trialsError) {
      console.error('Error creating user_trials table:', trialsError);
    } else {
      console.log('✅ user_trials table created or already exists');
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
