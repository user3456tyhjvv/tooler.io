import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function checkData() {
  console.log('🔍 Checking database for existing data...');

  try {
    // Check websites
    const { data: websites, error: websitesError } = await supabase
      .from('websites')
      .select('*');

    if (websitesError) {
      console.log('❌ Error fetching websites:', websitesError.message);
    } else {
      console.log('📋 Registered websites:', websites.length);
      websites.forEach(w => console.log('  -', w.domain, 'for user', w.userId));
    }

    // Check page views
    const { data: pageViews, error: pageViewsError } = await supabase
      .from('page_views')
      .select('site_id, visitor_id, path, created_at')
      .order('created_at', { ascending: false })
      .limit(10);

    if (pageViewsError) {
      console.log('❌ Error fetching page views:', pageViewsError.message);
    } else {
      console.log('📊 Recent page views:', pageViews.length);
      pageViews.forEach(pv => {
        console.log('  -', pv.site_id, pv.visitor_id, pv.path, new Date(pv.created_at).toLocaleString());
      });
    }

    if (websites.length === 0 && pageViews.length === 0) {
      console.log('💡 No data found. You need to:');
      console.log('   1. Register a website via the frontend');
      console.log('   2. Add the tracker script to your website');
      console.log('   3. Visit the website to generate tracking data');
    }

  } catch (error) {
    console.log('❌ Database check error:', error.message);
  }
}

checkData();
