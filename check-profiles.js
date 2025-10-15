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

async function checkProfilesTable() {
  try {
    console.log('Checking profiles table...');

    // Try to select from profiles table
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .limit(1);

    if (error) {
      console.log('❌ Profiles table error:', error.message);
      console.log('Error code:', error.code);
      return;
    }

    console.log('✅ Profiles table exists');

    // Try to get a sample record to see structure
    if (data && data.length > 0) {
      console.log('Sample record keys:', Object.keys(data[0]));
      console.log('Sample record:', JSON.stringify(data[0], null, 2));
    } else {
      console.log('No records in profiles table');
    }

  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

checkProfilesTable();
