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

async function registerWebsite() {
  const userId = '00000000-0000-0000-0000-000000000000'; // Use a valid UUID for userId
  const domain = 'example.com';

  try {
    // First check if it already exists
    const { data: existing, error: checkError } = await supabase
      .from('websites')
      .select('*')
      .eq('userId', userId)
      .eq('domain', domain)
      .single();

    if (existing) {
      console.log('✅ Website already registered:', existing);
      return;
    }

    const { data, error } = await supabase
      .from('websites')
      .insert({ userId: userId, domain })
      .select();

    if (error) {
      console.error('Error registering website:', error);
      return;
    }

    console.log('✅ Website registered:', data);
  } catch (error) {
    console.error('Unexpected error:', error);
  }
}

registerWebsite();
