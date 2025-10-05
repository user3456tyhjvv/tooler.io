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

async function sendTrialExpiryNotifications() {
  try {
    console.log('🔍 Checking for trial expiry notifications...');

    // Calculate dates for notifications
    const now = new Date();
    const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    const oneDayFromNow = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);

    // Find users whose trials expire in 3 days and haven't been notified yet
    const { data: usersExpiringIn3Days, error: error3Days } = await supabase
      .from('user_trials')
      .select(`
        *,
        user:users(id, email, full_name)
      `)
      .eq('status', 'active')
      .lte('end_date', threeDaysFromNow.toISOString())
      .gt('end_date', oneDayFromNow.toISOString())
      .eq('notified_3_days', false);

    if (error3Days) {
      console.error('Error fetching users expiring in 3 days:', error3Days);
    } else if (usersExpiringIn3Days && usersExpiringIn3Days.length > 0) {
      console.log(`📧 Found ${usersExpiringIn3Days.length} users expiring in 3 days`);

      for (const trial of usersExpiringIn3Days) {
        try {
          // Send notification
          await supabase
            .from('notifications')
            .insert({
              user_id: trial.user_id,
              title: 'Trial Expiring Soon',
              message: `Your free trial will expire on ${new Date(trial.end_date).toLocaleDateString()}. Upgrade now to continue using our analytics service.`,
              type: 'warning',
              sent_by: null // System notification
            });

          // Mark as notified
          await supabase
            .from('user_trials')
            .update({ notified_3_days: true })
            .eq('id', trial.id);

          console.log(`✅ Sent 3-day expiry notification to ${trial.user.email}`);
        } catch (notifyError) {
          console.error(`❌ Failed to notify user ${trial.user.email}:`, notifyError);
        }
      }
    }

    // Find users whose trials expire in 1 day and haven't been notified yet
    const { data: usersExpiringIn1Day, error: error1Day } = await supabase
      .from('user_trials')
      .select(`
        *,
        user:users(id, email, full_name)
      `)
      .eq('status', 'active')
      .lte('end_date', oneDayFromNow.toISOString())
      .gt('end_date', now.toISOString())
      .eq('notified_1_day', false);

    if (error1Day) {
      console.error('Error fetching users expiring in 1 day:', error1Day);
    } else if (usersExpiringIn1Day && usersExpiringIn1Day.length > 0) {
      console.log(`📧 Found ${usersExpiringIn1Day.length} users expiring in 1 day`);

      for (const trial of usersExpiringIn1Day) {
        try {
          // Send notification
          await supabase
            .from('notifications')
            .insert({
              user_id: trial.user_id,
              title: 'Trial Expires Tomorrow',
              message: `Your free trial expires tomorrow (${new Date(trial.end_date).toLocaleDateString()}). Don't lose access to your analytics data - upgrade today!`,
              type: 'error',
              sent_by: null // System notification
            });

          // Mark as notified
          await supabase
            .from('user_trials')
            .update({ notified_1_day: true })
            .eq('id', trial.id);

          console.log(`✅ Sent 1-day expiry notification to ${trial.user.email}`);
        } catch (notifyError) {
          console.error(`❌ Failed to notify user ${trial.user.email}:`, notifyError);
        }
      }
    }

    // Find users whose trials have expired and haven't been notified yet
    const { data: expiredTrials, error: expiredError } = await supabase
      .from('user_trials')
      .select(`
        *,
        user:users(id, email, full_name)
      `)
      .eq('status', 'active')
      .lt('end_date', now.toISOString())
      .eq('notified_expired', false);

    if (expiredError) {
      console.error('Error fetching expired trials:', expiredError);
    } else if (expiredTrials && expiredTrials.length > 0) {
      console.log(`📧 Found ${expiredTrials.length} expired trials`);

      for (const trial of expiredTrials) {
        try {
          // Send notification
          await supabase
            .from('notifications')
            .insert({
              user_id: trial.user_id,
              title: 'Trial Expired',
              message: `Your free trial has expired. Upgrade to a paid plan to continue using our analytics service and retain access to your data.`,
              type: 'error',
              sent_by: null // System notification
            });

          // Mark as notified and update status
          await supabase
            .from('user_trials')
            .update({
              notified_expired: true,
              status: 'expired'
            })
            .eq('id', trial.id);

          // Also update user status
          await supabase
            .from('users')
            .update({ is_active: false })
            .eq('id', trial.user_id);

          console.log(`✅ Sent expiry notification to ${trial.user.email} and deactivated account`);
        } catch (notifyError) {
          console.error(`❌ Failed to notify user ${trial.user.email}:`, notifyError);
        }
      }
    }

    console.log('✅ Trial expiry notification check completed');

  } catch (error) {
    console.error('❌ Error in sendTrialExpiryNotifications:', error);
  }
}

// Run the notification check
sendTrialExpiryNotifications();
