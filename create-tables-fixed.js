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
    console.log('Creating tables using Supabase client...');

    // Note: This script assumes tables are created manually in Supabase dashboard
    // or through migrations. The exec_sql function is not available by default.

    // Test if tables exist by trying to query them
    console.log('Testing table existence...');

    // Test users table
    const { data: usersData, error: usersError } = await supabase
      .from('users')
      .select('id')
      .limit(1);

    if (usersError && usersError.code === 'PGRST205') {
      console.log('❌ users table does not exist');
      console.log('📋 Please create the following tables manually in your Supabase dashboard:');
      console.log(`
CREATE TABLE users (
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

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID REFERENCES users(id),
  recipient_id UUID REFERENCES users(id),
  content TEXT NOT NULL,
  message_type TEXT DEFAULT 'text',
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT DEFAULT 'info',
  is_read BOOLEAN DEFAULT false,
  sent_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE user_trials (
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

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
CREATE INDEX IF NOT EXISTS idx_user_trials_user_id ON user_trials(user_id);
CREATE INDEX IF NOT EXISTS idx_user_trials_status ON user_trials(status);
      `);
    } else if (!usersError) {
      console.log('✅ users table exists');
    }

    // Test messages table
    const { data: messagesData, error: messagesError } = await supabase
      .from('messages')
      .select('id')
      .limit(1);

    if (messagesError && messagesError.code === 'PGRST205') {
      console.log('❌ messages table does not exist');
    } else if (!messagesError) {
      console.log('✅ messages table exists');
    }

    // Test notifications table
    const { data: notificationsData, error: notificationsError } = await supabase
      .from('notifications')
      .select('id')
      .limit(1);

    if (notificationsError && notificationsError.code === 'PGRST205') {
      console.log('❌ notifications table does not exist');
    } else if (!notificationsError) {
      console.log('✅ notifications table exists');
    }

    // Test user_trials table
    const { data: trialsData, error: trialsError } = await supabase
      .from('user_trials')
      .select('id')
      .limit(1);

    if (trialsError && trialsError.code === 'PGRST205') {
      console.log('❌ user_trials table does not exist');
    } else if (!trialsError) {
      console.log('✅ user_trials table exists');
    }

    console.log('🎉 Table check completed');

  } catch (error) {
    console.error('❌ Error in createTables:', error);
  }
}

createTables();
