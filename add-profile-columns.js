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

async function addProfileColumns() {
  try {
    console.log('Adding missing columns to profiles table...');

    // Add trial_end_date column
    const { error: trialEndError } = await supabase.rpc('exec_sql', {
      sql: `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS trial_end_date TIMESTAMPTZ;`
    });

    if (trialEndError) {
      console.log('❌ Could not add trial_end_date column:', trialEndError.message);
    } else {
      console.log('✅ Added trial_end_date column to profiles table');
    }

    // Add other potentially missing columns
    const columnsToAdd = [
      'trial_start_date TIMESTAMPTZ DEFAULT NOW()',
      'is_active BOOLEAN DEFAULT true',
      'created_at TIMESTAMPTZ DEFAULT NOW()',
      'updated_at TIMESTAMPTZ DEFAULT NOW()'
    ];

    for (const col of columnsToAdd) {
      const { error: colError } = await supabase.rpc('exec_sql', {
        sql: `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ${col};`
      });

      if (colError) {
        console.log(`❌ Could not add ${col.split(' ')[0]} column:`, colError.message);
      } else {
        console.log(`✅ Added ${col.split(' ')[0]} column to profiles table`);
      }
    }

    console.log('Column addition completed!');

  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

addProfileColumns();
