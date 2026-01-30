const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Format phone number to E.164 format
function formatPhoneNumber(phoneNumber) {
  if (!phoneNumber) return null;

  const digits = phoneNumber.replace(/\D/g, '');

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }

  if (digits.length > 10) {
    return `+${digits}`;
  }

  return null;
}

// Process message template with dynamic values
function processMessageTemplate(template, columnValues) {
  let processedMessage = template;
  const replacements = [];

  columnValues.forEach(column => {
    const placeholder = `{${column.id}}`;
    if (processedMessage.includes(placeholder)) {
      const replacement = column.text || column.value || '';
      processedMessage = processedMessage.replace(
        new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'),
        replacement
      );
      replacements.push({
        placeholder: placeholder,
        value: replacement || '(empty)',
        columnId: column.id
      });
    }
  });

  // Log replacements for debugging
  if (replacements.length > 0) {
    console.log(`   📝 Template replacements made: ${replacements.map(r => `${r.placeholder} → "${r.value}"`).join(', ')}`);
  }

  // Check if there are unreplaced tags
  const unreplacedTags = processedMessage.match(/\{[^}]+\}/g);
  if (unreplacedTags) {
    console.log(`   ⚠️  Unreplaced tags found: ${unreplacedTags.join(', ')}`);
    console.log(`   Available column IDs: ${columnValues.map(c => c.id).join(', ')}`);
  }

  return processedMessage;
}

// Apply multiple filters to items
function applyMultipleFilters(items, filters) {
  if (!filters || filters.length === 0) {
    return items;
  }

  return items.filter(item => {
    return filters.every(filter => {
      const columnValue = item.column_values.find(col => col.id === filter.column_id);
      const itemValue = columnValue && columnValue.text ? columnValue.text.trim() : '';

      switch (filter.operator) {
        case 'equals':
          return itemValue === filter.value;
        case 'contains':
          return itemValue.toLowerCase().includes(filter.value.toLowerCase());
        case 'not_equals':
          return itemValue !== filter.value;
        case 'not_contains':
          return !itemValue.toLowerCase().includes(filter.value.toLowerCase());
        default:
          return true;
      }
    });
  });
}

// Get items from Monday.com with pagination
async function getMondayItems(config) {
  let allItems = [];
  let hasNextPage = true;
  let cursor = null;
  let pageCount = 0;
  const maxPages = 50;

  console.log(`Starting to fetch items from Monday.com for board ${config.board_id}, group ${config.group_id}`);

  while (hasNextPage && pageCount < maxPages) {
    pageCount++;

    const query = `
      query {
        boards(ids: ${config.board_id}) {
          groups(ids: "${config.group_id}") {
            items_page(limit: 100${cursor ? `, cursor: "${cursor}"` : ''}) {
              cursor
              items {
                id
                name
                column_values {
                  id
                  text
                  value
                }
              }
            }
          }
        }
      }
    `;

    try {
      console.log(`Fetching page ${pageCount} from Monday.com...`);

      const response = await axios({
        method: 'post',
        url: 'https://api.monday.com/v2',
        headers: {
          'Authorization': config.monday_api_key,
          'Content-Type': 'application/json'
        },
        data: { query },
        timeout: 30000
      });

      if (!response.data || !response.data.data) {
        throw new Error('Invalid response from Monday.com API');
      }

      if (response.data.errors && response.data.errors.length > 0) {
        throw new Error(`Monday.com API errors: ${response.data.errors.map(e => e.message).join(', ')}`);
      }

      const boards = response.data.data.boards;
      if (!boards || boards.length === 0) {
        throw new Error(`Board with ID ${config.board_id} not found or no access`);
      }

      const groups = boards[0].groups;
      if (!groups || groups.length === 0) {
        throw new Error(`Group with ID ${config.group_id} not found in board ${config.board_id}`);
      }

      const itemsPage = groups[0].items_page;
      if (!itemsPage) {
        console.log('No items_page found, ending pagination');
        break;
      }

      const items = itemsPage.items || [];
      allItems = allItems.concat(items);

      console.log(`Page ${pageCount}: Fetched ${items.length} items, total so far: ${allItems.length}`);

      if (itemsPage.cursor && items.length === 100) {
        cursor = itemsPage.cursor;
        console.log(`Has more pages, cursor: ${cursor}`);
      } else {
        hasNextPage = false;
        console.log('No more pages to fetch');
      }

    } catch (error) {
      console.error(`Error fetching page ${pageCount}:`, error.message);

      if (pageCount === 1) {
        throw error;
      }

      console.log(`Stopping pagination due to error, returning ${allItems.length} items collected so far`);
      break;
    }
  }

  if (pageCount >= maxPages) {
    console.warn(`Reached maximum page limit (${maxPages}), stopping pagination`);
  }

  console.log(`Finished fetching items. Total: ${allItems.length} items from ${pageCount} pages`);
  return allItems;
}

// Send SMS using OpenPhone API
async function sendSMS(phoneNumber, message, config) {
  try {
    console.log(`Attempting to send SMS to ${phoneNumber} using OpenPhone API`);

    const response = await axios({
      method: 'post',
      url: 'https://api.openphone.com/v1/messages',
      headers: {
        'Authorization': config.openphone_api_key,
        'Content-Type': 'application/json'
      },
      data: {
        content: message,
        from: config.sender_phone,
        to: [phoneNumber]
      },
      timeout: 30000
    });

    console.log(`SMS sent successfully to ${phoneNumber}. Response:`, response.data);
    return { success: true, data: response.data };

  } catch (error) {
    console.error(`SMS sending failed to ${phoneNumber}:`);

    let errorMessage = 'Unknown error';
    let errorDetails = {};

    if (error.response) {
      errorDetails = {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      };

      switch (error.response.status) {
        case 400:
          errorMessage = `Bad Request: ${error.response.data?.message || 'Invalid request data'}`;
          break;
        case 401:
          errorMessage = 'Unauthorized: Invalid OpenPhone API key';
          break;
        case 403:
          errorMessage = 'Forbidden: No permission to send from this number';
          break;
        case 404:
          errorMessage = 'Not Found: Invalid endpoint or phone number';
          break;
        case 422:
          errorMessage = `Validation Error: ${error.response.data?.message || 'Invalid data provided'}`;
          break;
        case 429:
          errorMessage = 'Rate Limited: Too many requests';
          break;
        case 500:
          errorMessage = 'OpenPhone Server Error: Please try again later';
          break;
        default:
          errorMessage = `HTTP ${error.response.status}: ${error.response.data?.message || error.response.statusText}`;
      }
    } else if (error.request) {
      errorMessage = 'Network Error: No response from OpenPhone API';
      errorDetails = { request: 'No response received' };
    } else {
      errorMessage = `Request Setup Error: ${error.message}`;
      errorDetails = { message: error.message };
    }

    return {
      success: false,
      error: errorMessage,
      details: errorDetails
    };
  }
}

// Save message to message_logs table
async function saveMessageLog(campaignId, executionId, recipientPhone, recipientName, messageContent, status, errorMessage = null, providerId = null) {
  try {
    const logData = {
      campaign_id: campaignId,
      execution_id: executionId,
      recipient_phone: recipientPhone,
      recipient_name: recipientName,
      message_content: messageContent,
      status: status,
      sms_provider: 'openphone',
      sent_at: status === 'sent' ? new Date().toISOString() : null
    };

    if (errorMessage) {
      logData.error_message = errorMessage;
    }

    if (providerId) {
      logData.provider_message_id = providerId;
    }

    const { error } = await supabase
      .from('message_logs')
      .insert([logData]);

    if (error) {
      console.error('Error saving message log:', error);
    }
  } catch (error) {
    console.error('Error saving message log:', error);
  }
}

// Execute campaign
async function executeCampaign(campaign, executionId, scheduleId = null, scheduleType = null) {
  try {
    console.log(`Executing campaign: ${campaign.campaign_name} (${scheduleType || 'manual'})`);

    // Update execution status to running
    await supabase
      .from('campaign_executions')
      .update({
        status: 'running',
        started_at: new Date().toISOString()
      })
      .eq('id', executionId);

    const config = campaign.user_configs;

    // Verify OpenPhone configuration
    if (!config.openphone_api_key || !config.sender_phone) {
      throw new Error('OpenPhone API key or sender phone not configured');
    }

    // Fetch Monday.com items
    const items = await getMondayItems(config);
    let messagesSent = 0;
    let messagesFailed = 0;
    let failureReasons = [];

    // Filter items based on selected_items if available
    let itemsToProcess = campaign.selected_items && campaign.selected_items.length > 0
      ? items.filter(item => campaign.selected_items.includes(item.id))
      : items;

    // Apply multiple filters if they exist
    if (campaign.multiple_filters && campaign.multiple_filters.length > 0) {
      itemsToProcess = applyMultipleFilters(itemsToProcess, campaign.multiple_filters);
    }

    console.log(`📊 Campaign Filter Summary:`);
    console.log(`   Total Monday items: ${items.length}`);
    console.log(`   After filters: ${itemsToProcess.length}`);
    console.log(`   Status filter: ${campaign.status_column} = "${campaign.status_value}"`);
    console.log(`   Phone column: ${campaign.phone_column}`);
    if (campaign.multiple_filters && campaign.multiple_filters.length > 0) {
      console.log(`   Advanced filters: ${campaign.multiple_filters.length}`);
    }

    // Update total recipients
    await supabase
      .from('campaign_executions')
      .update({ total_recipients: itemsToProcess.length })
      .eq('id', executionId);

    if (itemsToProcess.length === 0) {
      console.log('⚠️  No items match your filters. Campaign will not send any messages.');
    }

    // Process each item
    let processedCount = 0;
    for (const item of itemsToProcess) {
      processedCount++;
      const statusColumn = item.column_values.find(col => col.id === campaign.status_column);
      const phoneColumn = item.column_values.find(col => col.id === campaign.phone_column);

      console.log(`[${processedCount}/${itemsToProcess.length}] Processing: ${item.name}`);

      // Check status column
      if (!statusColumn) {
        console.log(`   ⚠️  Status column "${campaign.status_column}" not found`);
        failureReasons.push(`${item.name}: Status column not found`);
        messagesFailed++;
        continue;
      }

      if (statusColumn.text !== campaign.status_value) {
        console.log(`   ⚠️  Status mismatch: "${statusColumn.text}" != "${campaign.status_value}"`);
        continue;
      }

      // Check phone column
      if (!phoneColumn) {
        console.log(`   ⚠️  Phone column "${campaign.phone_column}" not found`);
        failureReasons.push(`${item.name}: Phone column not found`);
        messagesFailed++;
        continue;
      }

      if (!phoneColumn.text) {
        console.log(`   ⚠️  Phone number is empty`);
        failureReasons.push(`${item.name}: Phone number is empty`);
        messagesFailed++;
        continue;
      }

      const phoneNumber = formatPhoneNumber(phoneColumn.text);

      if (!phoneNumber) {
        console.log(`   ❌ Invalid phone format: "${phoneColumn.text}"`);
        failureReasons.push(`${item.name}: Invalid phone number format "${phoneColumn.text}"`);
        messagesFailed++;
        continue;
      }

      console.log(`   📝 Original template: "${campaign.message_template}"`);
      const processedMessage = processMessageTemplate(campaign.message_template, item.column_values);
      console.log(`   📝 Processed message: "${processedMessage}"`);
      const recipientName = item.name || 'Unknown';

      console.log(`   📱 Sending to: ${phoneNumber}`);

      const result = await sendSMS(phoneNumber, processedMessage, config);

      // Save message log
      await saveMessageLog(
        campaign.id,
        executionId,
        phoneNumber,
        recipientName,
        processedMessage,
        result.success ? 'sent' : 'failed',
        result.success ? null : result.error,
        result.success && result.data ? result.data.id : null
      );

      if (result.success) {
        messagesSent++;
        console.log(`   ✅ SUCCESS`);
      } else {
        messagesFailed++;
        failureReasons.push(`${phoneNumber}: ${result.error}`);
        console.log(`   ❌ FAILED: ${result.error}`);
      }

      // Rate limiting - 2 second delay between messages
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Prepare execution notes
    let executionNotes = null;
    if (campaign.multiple_filters && campaign.multiple_filters.length > 0) {
      const filtersText = campaign.multiple_filters.map(f => `${f.column_id} ${f.operator} "${f.value}"`).join(' AND ');
      executionNotes = `Applied ${campaign.multiple_filters.length} filters: ${filtersText}`;
    }

    if (failureReasons.length > 0) {
      const failureLog = failureReasons.slice(0, 10).join('; '); // Limit to first 10 failures
      executionNotes = executionNotes ?
        `${executionNotes}. Failures: ${failureLog}` :
        `Failures: ${failureLog}`;
    }

    // Update execution as completed
    await supabase
      .from('campaign_executions')
      .update({
        status: messagesFailed > 0 && messagesSent === 0 ? 'failed' : 'completed',
        completed_at: new Date().toISOString(),
        successful_sends: messagesSent,
        failed_sends: messagesFailed,
        error_message: executionNotes
      })
      .eq('id', executionId);

    console.log(`\n═══════════════════════════════════════════════════════`);
    console.log(`📊 CAMPAIGN EXECUTION SUMMARY`);
    console.log(`═══════════════════════════════════════════════════════`);
    console.log(`Campaign: ${campaign.campaign_name}`);
    console.log(`Execution Type: ${scheduleType || 'manual'}`);
    console.log(`Total Recipients: ${itemsToProcess.length}`);
    console.log(`✅ Successful: ${messagesSent}`);
    console.log(`❌ Failed: ${messagesFailed}`);
    console.log(`Success Rate: ${itemsToProcess.length > 0 ? Math.round((messagesSent / itemsToProcess.length) * 100) : 0}%`);
    console.log(`═══════════════════════════════════════════════════════\n`);

    // Handle "once" schedule type - deactivate after execution
    if (scheduleType === 'once' && scheduleId) {
      console.log(`Deactivating "once" schedule ${scheduleId} for campaign ${campaign.id}`);

      await supabase
        .from('campaign_schedules')
        .update({ is_active: false })
        .eq('id', scheduleId);

      // Check if all schedules are inactive
      const { data: allSchedules } = await supabase
        .from('campaign_schedules')
        .select('is_active')
        .eq('campaign_id', campaign.id);

      if (allSchedules) {
        const anyActive = allSchedules.some(s => s.is_active);
        if (!anyActive) {
          await supabase
            .from('campaigns')
            .update({ is_active: false })
            .eq('id', campaign.id);

          console.log(`Campaign ${campaign.id} fully deactivated - all "once" schedules completed`);
        }
      }
    }

  } catch (error) {
    console.error('Error executing campaign:', error);

    await supabase
      .from('campaign_executions')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error_message: `Execution failed: ${error.message}`
      })
      .eq('id', executionId);
  }
}

// Scheduled job to check and execute campaigns (runs every minute)
// Using EST (America/New_York) timezone
cron.schedule('* * * * *', async () => {
  try {
    // Get current time in EST
    const now = new Date();
    const estOptions = { timeZone: 'America/New_York' };
    const currentDay = now.toLocaleDateString('en-US', { weekday: 'long', ...estOptions });
    const currentDate = new Date(now.toLocaleString('en-US', estOptions)).getDate();
    const currentTime = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', ...estOptions });

    console.log(`[CRON] Checking campaigns at ${now.toISOString()} (EST: ${currentDay}, ${currentTime})`);

    // Fetch active campaigns with schedules
    const { data: campaigns, error } = await supabase
      .from('campaigns')
      .select(`
        *,
        user_configs(*),
        campaign_schedules(*)
      `)
      .eq('is_active', true);

    if (error) {
      console.error('Error fetching campaigns:', error);
      return;
    }

    if (!campaigns || campaigns.length === 0) {
      return;
    }

    for (const campaign of campaigns) {
      if (!campaign.campaign_schedules || campaign.campaign_schedules.length === 0) {
        continue;
      }

      for (const schedule of campaign.campaign_schedules) {
        if (!schedule.is_active) {
          continue;
        }

        // For "once" schedules, check if the scheduled time has already passed
        if (schedule.schedule_type === 'once') {
          const scheduleDateTime = new Date(schedule.schedule_day + 'T' + schedule.schedule_time + ':00');
          const estNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));

          // If the scheduled time has passed, deactivate it
          if (scheduleDateTime < estNow) {
            // Only deactivate if it's more than 2 minutes past (to avoid edge cases)
            const minutesPassed = (estNow - scheduleDateTime) / 1000 / 60;
            if (minutesPassed > 2) {
              console.log(`[CRON] Deactivating expired "once" schedule for campaign: ${campaign.campaign_name} (scheduled for ${schedule.schedule_day} ${schedule.schedule_time})`);

              await supabase
                .from('campaign_schedules')
                .update({ is_active: false })
                .eq('id', schedule.id);

              // Check if all schedules are inactive
              const { data: allSchedules } = await supabase
                .from('campaign_schedules')
                .select('is_active')
                .eq('campaign_id', campaign.id);

              if (allSchedules) {
                const anyActive = allSchedules.some(s => s.is_active);
                if (!anyActive) {
                  await supabase
                    .from('campaigns')
                    .update({ is_active: false })
                    .eq('id', campaign.id);

                  console.log(`[CRON] Campaign ${campaign.campaign_name} deactivated - all schedules expired`);
                }
              }

              continue;
            }
          }
        }

        // Check if "once" schedule was already executed (ever)
        if (schedule.schedule_type === 'once' && schedule.last_executed_at) {
          console.log(`[CRON] Skipping already executed "once" schedule for campaign: ${campaign.campaign_name} (last executed: ${schedule.last_executed_at})`);
          continue;
        }

        let shouldExecute = false;

        if (schedule.schedule_time !== currentTime) {
          continue;
        }

        switch (schedule.schedule_type) {
          case 'once':
            // Parse the schedule_day as date string (YYYY-MM-DD)
            const scheduleDate = new Date(schedule.schedule_day + 'T00:00:00');
            const estDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
            const isToday = scheduleDate.toDateString() === estDate.toDateString();
            shouldExecute = isToday;
            break;

          case 'weekly':
            shouldExecute = schedule.schedule_day === currentDay;
            break;

          case 'monthly':
            shouldExecute = parseInt(schedule.schedule_day) === currentDate;
            break;
        }

        if (shouldExecute) {
          console.log(`[CRON] Executing campaign: ${campaign.campaign_name} (Schedule ID: ${schedule.id}, Type: ${schedule.schedule_type})`);

          // Update schedule execution tracking BEFORE execution
          await supabase
            .from('campaign_schedules')
            .update({
              last_executed_at: new Date().toISOString(),
              execution_count: (schedule.execution_count || 0) + 1
            })
            .eq('id', schedule.id);

          // Create execution record
          const { data: execution } = await supabase
            .from('campaign_executions')
            .insert({
              campaign_id: campaign.id,
              execution_type: 'scheduled',
              status: 'pending',
            })
            .select()
            .single();

          if (execution) {
            // Execute campaign asynchronously
            executeCampaign(campaign, execution.id, schedule.id, schedule.schedule_type).catch(error => {
              console.error('Scheduled campaign execution error:', error);
            });
          }
        }
      }
    }
  } catch (error) {
    console.error('Cron job error:', error);
  }
}, {
  timezone: 'America/New_York' // EST timezone
});

// Test configuration endpoint
app.post('/api/test-configuration', async (req, res) => {
  try {
    const { openphone_api_key, sender_phone, test_phone } = req.body;

    if (!openphone_api_key || !sender_phone || !test_phone) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: openphone_api_key, sender_phone, test_phone'
      });
    }

    // Format test phone number
    const formattedPhone = formatPhoneNumber(test_phone);
    if (!formattedPhone) {
      return res.status(400).json({
        success: false,
        error: 'Invalid phone number format. Use E.164 format: +14155551234'
      });
    }

    console.log(`[TEST] Testing configuration with sender: ${sender_phone}, recipient: ${formattedPhone}`);

    // Try to send test SMS
    const testConfig = {
      openphone_api_key,
      sender_phone
    };

    const testMessage = `SMS Monday Test: Your configuration is working correctly! Sent at ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} EST`;

    const result = await sendSMS(formattedPhone, testMessage, testConfig);

    if (result.success) {
      console.log(`[TEST] Configuration test successful`);
      res.json({
        success: true,
        message: 'Test SMS sent successfully! Check your phone.',
        details: {
          to: formattedPhone,
          from: sender_phone,
          provider: 'OpenPhone',
          timestamp: new Date().toISOString()
        }
      });
    } else {
      console.log(`[TEST] Configuration test failed: ${result.error}`);
      res.status(400).json({
        success: false,
        error: result.error,
        details: result.details
      });
    }
  } catch (error) {
    console.error('[TEST] Configuration test error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  const now = new Date();
  const estTime = now.toLocaleString('en-US', { timeZone: 'America/New_York' });

  res.json({
    status: 'ok',
    timestamp: now.toISOString(),
    est_time: estTime,
    timezone: 'America/New_York (EST)',
    version: '2.0.0',
    provider: 'OpenPhone'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`SMS Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`SMS Provider: OpenPhone`);
  console.log(`Timezone: America/New_York (EST)`);
});
