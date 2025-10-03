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

async function testConnection() {
  console.log('Testing Supabase connection...');

  try {
    // Test basic connection
    const { data, error } = await supabase
      .from('page_views')
      .select('count')
      .limit(1);

    if (error) {
      console.error('Connection test failed:', error);
      return;
    }

    console.log('✅ Supabase connection successful');

    // Check if tables exist
    const { data: tables, error: tableError } = await supabase
      .from('page_views')
      .select('*')
      .limit(1);

    if (tableError) {
      console.error('Table check failed:', tableError);
      return;
    }

    console.log('✅ Tables exist');

    // Try to insert a test record with basic fields only
    const testData = {
      site_id: 'test.com',
      visitor_id: 'test-visitor',
      path: '/test',
      referrer: 'direct',
      screen_width: 1920,
      screen_height: 1080,
      language: 'en-US',
      timezone: 'UTC',
      event_type: 'pageview',
      created_at: new Date().toISOString()
    };

    const { data: insertData, error: insertError } = await supabase
      .from('page_views')
      .insert([testData])
      .select();

    if (insertError) {
      console.error('Insert test failed:', insertError);
      return;
    }

    console.log('✅ Insert successful:', insertData);

    // Check if we can query it back
    const { data: queryData, error: queryError } = await supabase
      .from('page_views')
      .select('*')
      .eq('site_id', 'test.com')
      .limit(5);

    if (queryError) {
      console.error('Query test failed:', queryError);
    } else {
      console.log('✅ Query successful, records:', queryData.length);
    }

    // Clean up test record
    if (insertData && insertData.length > 0) {
      const { error: deleteError } = await supabase
        .from('page_views')
        .delete()
        .eq('id', insertData[0].id);

      if (deleteError) {
        console.error('Delete test failed:', deleteError);
      } else {
        console.log('✅ Delete successful');
      }
    }

  } catch (error) {
    console.error('Unexpected error:', error);
  }
}

testConnection();
