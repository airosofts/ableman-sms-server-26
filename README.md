# SMS Monday Server

Standalone Node.js server for sending SMS messages via OpenPhone and handling scheduled campaigns.

## Features

- 📱 Send SMS messages via OpenPhone API
- ⏰ Scheduled campaign execution with node-cron
- 🔄 Automatic campaign execution based on schedules
- 📊 Campaign execution logging
- 🎯 Recipient filtering based on Monday.com data
- 📈 Message delivery tracking

## Tech Stack

- **Express.js** - Web framework
- **node-cron** - Scheduled task execution
- **Supabase** - Database for campaigns and logs
- **OpenPhone** - SMS delivery
- **Axios** - Monday.com API integration & OpenPhone API calls

## Installation

### Local Development

1. Navigate to the sms-server directory:
```bash
cd sms-server
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env` file:
```bash
cp .env.example .env
```

4. Configure environment variables in `.env`:
```env
PORT=3001
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_supabase_service_key
```

5. Start the development server:
```bash
npm run dev
```

The server will run on `http://localhost:3001`

## Deployment to Railway

### Step 1: Prepare Your Project

1. Make sure your code is in a Git repository
2. Push your code to GitHub/GitLab

### Step 2: Deploy to Railway

1. Go to [Railway.app](https://railway.app)
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your repository
4. Railway will detect the Node.js project

### Step 3: Configure Environment Variables

In Railway dashboard, add these environment variables:

```
PORT=3001
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_supabase_service_key
```

### Step 4: Set Root Directory (Important!)

Since the server is in a subdirectory:

1. Go to Settings → Build
2. Set **Root Directory** to: `sms-server`
3. Set **Start Command** to: `npm start`

### Step 5: Deploy

Railway will automatically deploy your server. You'll get a URL like:
```
https://your-app.railway.app
```

## API Endpoints

### Execute Campaign Manually

```http
POST /api/campaigns/:id/execute
```

**Response:**
```json
{
  "success": true,
  "executionId": "uuid",
  "message": "Campaign execution started"
}
```

### Get Campaign Executions

```http
GET /api/campaigns/:id/executions
```

**Response:**
```json
[
  {
    "id": "uuid",
    "campaign_id": "uuid",
    "execution_type": "manual",
    "status": "completed",
    "started_at": "2024-01-01T10:00:00Z",
    "completed_at": "2024-01-01T10:05:00Z",
    "total_recipients": 100,
    "successful_sends": 98,
    "failed_sends": 2
  }
]
```

### Health Check

```http
GET /health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T10:00:00Z",
  "version": "2.0.0",
  "provider": "OpenPhone"
}
```

## How It Works

### 1. Manual Campaign Execution

When you activate a campaign or manually trigger it:
1. Server receives POST request to `/api/campaigns/:id/execute`
2. Creates a campaign execution record
3. Fetches Monday.com board data with pagination
4. Filters items based on campaign criteria
5. Sends SMS to each filtered recipient via OpenPhone
6. Logs each message send attempt
7. Updates execution record with results

### 2. Scheduled Execution

The cron job runs every minute:
1. Checks current time (HH:MM format)
2. Fetches all active campaigns with schedules
3. Matches schedules against current time and day
4. Executes matching campaigns automatically
5. Supports three schedule types:
   - **Once**: Specific date and time
   - **Weekly**: Every specific day of week at specific time
   - **Monthly**: Specific day of month at specific time

### 3. Message Filtering

Items are filtered based on:
- **Status column**: Must match specified value
- **Phone column**: Must have a valid phone number
- **Advanced filters**: Custom column conditions (equals, contains, not_equals, not_contains)

### 4. Template Processing

Message templates support dynamic tags:
- `{column_id}` - Replaced with actual Monday.com column value
- Example: `Hi {text}, your order {status} is ready!`

## OpenPhone Setup

### Get Your OpenPhone API Key

1. Go to [OpenPhone Dashboard](https://app.openphone.com)
2. Navigate to Settings → API Keys
3. Create a new API key
4. Copy the API key (starts with `op_...`)
5. Note your sender phone number in E.164 format (e.g., `+14155551234`)

### Add to Configuration

In your SMS Monday platform:
1. Go to Configurations page
2. Add OpenPhone API Key field
3. Add Sender Phone Number field
4. Save configuration

## Database Schema Required

Make sure you've applied the OpenPhone fields migration to your Supabase database:

```bash
# Run the SQL from: database/add_openphone_fields.sql
```

Tables needed:
- `campaign_executions` - Tracks each campaign run
- `message_logs` - Tracks individual SMS sends

## Integrating with Next.js App

Update your Next.js app to call the SMS server API:

```javascript
// Example: Manually execute campaign
const executeCampaign = async (campaignId) => {
  const response = await fetch(`${process.env.NEXT_PUBLIC_SMS_SERVER_URL}/api/campaigns/${campaignId}/execute`, {
    method: 'POST',
  });

  const data = await response.json();
  console.log('Execution started:', data.executionId);
};
```

Add to your `.env.local`:
```env
NEXT_PUBLIC_SMS_SERVER_URL=https://your-sms-server.railway.app
```

## Monitoring & Logs

### View Railway Logs

1. Go to Railway dashboard
2. Click on your project
3. Go to "Deployments" tab
4. Click "View Logs"

### Check Cron Execution

Logs will show:
```
[CRON] Checking campaigns at 2024-01-01T10:00:00Z
[CRON] Executing campaign: Welcome Campaign
Campaign Welcome Campaign completed: 98/100 sent
```

## Troubleshooting

### Campaigns not executing automatically

1. Check Railway logs for cron job output
2. Verify campaign `is_active` is `true` in database
3. Verify schedule time format is `HH:MM` (e.g., "09:00")
4. Check timezone - Railway uses UTC by default

### SMS not sending

1. Verify OpenPhone API key in user_configs table
2. Check phone number format (E.164 format: +1234567890)
3. Review message_logs table for error messages
4. Check OpenPhone dashboard for account status and credits

### Database connection issues

1. Verify SUPABASE_URL is correct
2. Make sure you're using the SERVICE_KEY (not anon key)
3. Check Supabase project is not paused

## Cost Considerations

- **Railway**: Free tier available, then pay-as-you-go (~$5-10/month)
- **OpenPhone**: Pricing varies by plan (check OpenPhone pricing)
- **Supabase**: Free tier available

## Security Notes

- Never commit `.env` file to Git
- Use Supabase service key (not anon key) for server
- OpenPhone API keys are stored in database per-user
- Server validates campaign ownership before execution

## Support

For issues or questions, check the main project README or create an issue on GitHub.
