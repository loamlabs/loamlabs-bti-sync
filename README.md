# LoamLabs Data Audit & Task Runner

Consolidated task runner executing daily data quality audits and abandoned build analytics reporting.

## Overview

This project serves as a centralized task orchestrator running multiple scheduled jobs from a single Vercel Cron trigger. It performs two critical functions: ensuring data integrity across the component catalog and providing business intelligence on customer engagement with the custom wheel builder.

## Key Features

### 1. Weekly Data Quality Audit
- **Comprehensive Validation**: Scans all products tagged with `component:` tags for correct publishing status and required metafields
- **Selective Auditing**: Respects `audit:exclude` tag for intentionally incomplete products
- **Silent Success**: Only sends email reports when issues are detected
- **Actionable Reporting**: Identifies specific products and missing metafields for rapid remediation

### 2. Daily Abandoned Build Report
- **Behavioral Analytics**: Collects data on "significant" builds (all mandatory components selected) that users complete but don't add to cart
- **User Identification**: Distinguishes between logged-in customers (with Shopify profile links) and anonymous users (tracked via persistent UUID)
- **Minimal Data Collection**: Uses lightweight build state representation to respect privacy and minimize storage
- **Engagement Insights**: Provides visibility into component popularity, common build configurations, and potential friction points

### 3. Task Orchestration
- **Single Cron Job**: Runs all tasks from one daily trigger to stay within Vercel free tier limits
- **Parallel Execution**: Tasks run concurrently for efficiency
- **Independent Failure**: Issues in one task don't affect others

## Technical Architecture

### Core Technologies
- **Runtime**: Node.js (Vercel Serverless Functions)
- **APIs**: Shopify Admin API (GraphQL for product queries)
- **Database**: Upstash Redis (temporary storage for abandoned build data)
- **Email Service**: Resend
- **Scheduling**: Vercel Cron

### Project Structure
```
├── api/
│   ├── log-abandoned-build.js    # Frontend data collector endpoint
│   └── run-daily-tasks.js        # Master task orchestrator (triggered by cron)
```

### Abandoned Build Analytics Workflow

**Frontend Tracking** (`variant-builder.js` in main Shopify theme):
1. User completes a significant build (rim + hub + spokes + nipples selected)
2. On page exit (`beforeunload` event), frontend checks if build was added to cart
3. If not, sends lightweight build data to `/api/log-abandoned-build` using `fetch(keepalive)`
4. Payload includes: component selections, specifications, user identifier, timestamp

**Backend Collection** (`api/log-abandoned-build.js`):
1. Receives build data from frontend
2. Adds `capturedAt` timestamp
3. Pushes complete JSON object to Redis list under key `abandoned_builds`

**Daily Reporting** (`api/run-daily-tasks.js`):
1. Cron job triggers daily
2. Retrieves entire `abandoned_builds` list from Redis
3. Immediately deletes Redis key to prevent re-reporting
4. Formats data into readable HTML email with customer profile links for logged-in users
5. Sends "Daily Abandoned Build Report" via Resend

### Data Audit Workflow

1. **Product Query**: Fetches all products with `component:` tags via GraphQL
2. **Filtering**: Excludes products tagged with `audit:exclude`
3. **Validation**: Checks each product for:
   - Correct publishing status (published to "Online Store" channel)
   - Presence of all required product and variant metafields
4. **Reporting**: If issues found, compiles detailed list and sends "Weekly Data Health Report"
5. **Silent Success**: No email sent if all products pass validation

## Data Privacy

### Abandoned Build Data Collection
- **Minimal Footprint**: Only collects component IDs and specifications, no personal data beyond email for logged-in users
- **Ephemeral Storage**: Data held in Redis for max 24 hours before deletion
- **Transparent Purpose**: Data used solely for internal business intelligence
- **User Control**: Anonymous users represented by device-specific UUID, can be cleared by clearing browser localStorage

## Security

- CORS configuration restricts data collector endpoint to authorized domains
- Redis access controlled via environment variables
- No sensitive customer data (payment info, addresses) collected

## Environment Variables

Required environment variables (configured in Vercel):
- `SHOPIFY_STORE_DOMAIN`
- `SHOPIFY_ADMIN_ACCESS_TOKEN`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `RESEND_API_KEY`

## Cron Schedule

Configured in `vercel.json`:
```json
{
  "crons": [{
    "path": "/api/run-daily-tasks",
    "schedule": "0 9 * * *"
  }]
}
```
Runs daily at 9:00 AM UTC.

## Theme Integration

### Content Security Policy (CSP)
The main Shopify theme requires CSP configuration to allow frontend analytics:

In `layout/theme.liquid`:
```liquid
{%- assign shopify_additional_csp_connect_srcs = "https://loamlabs-data-audit.vercel.app" -%}
```

This whitelists the Vercel endpoint for cross-origin data collection.

## Future Enhancements

- A/B testing support for builder UI changes
- Funnel analysis showing where users drop off in the build process
- Automated email follow-up to users with abandoned builds
- Integration with marketing automation for retargeting

## License

MIT License - See LICENSE file for details

---

**Built to maintain data quality and provide actionable business intelligence for LoamLabs.**
