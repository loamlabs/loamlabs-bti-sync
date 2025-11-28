# LoamLabs BTI Distributor Sync

Automated inventory and pricing synchronization with BTI Sports distributor.

## Overview

This serverless function maintains real-time synchronization between BTI Sports (primary component distributor) inventory/pricing data and the LoamLabs Shopify store. Running daily via Vercel Cron, it ensures product availability and pricing accuracy without manual intervention.

## Key Features

- **Automatic Inventory Sync**: Updates product availability based on distributor stock levels
- **Dynamic Pricing**: Adjusts product pricing based on distributor MSRP and configurable markup rules
- **Smart Local Stock Detection**: Preserves manual inventory adjustments when local stock is available
- **Rate Limit Compliance**: Sequential processing with programmatic delays to respect Shopify API limits
- **Selective Updates**: Only performs API calls when changes are detected
- **Comprehensive Error Handling**: Detailed failure reports with full error context for rapid debugging
- **Silent Success**: Only sends email notifications when changes are made or errors occur

## Technical Architecture

### Core Technologies
- **Runtime**: Node.js (Vercel Serverless Functions)
- **APIs**: 
  - BTI Sports Data Feed (JSON API)
  - Shopify Admin API (GraphQL for reads, REST for writes)
- **Scheduling**: Vercel Cron
- **Email Service**: Resend

### Synchronization Logic

**Product Matching**: 
- Each Shopify variant includes a `custom.bti_part_number` metafield
- Script fetches BTI inventory data and matches by part number

**Inventory Policy Rules**:
Products define behavior via `custom.out_of_stock_action` metafield:
- `continue_selling`: Sets inventory policy to "continue" (allows backorders)
- `stop_selling`: Sets inventory policy to "deny" (prevents sales when out of stock)

**Pricing Rules**:
Products define markup via `custom.price_adjustment_percentage` metafield:
- Example: `10` = 10% markup over BTI MSRP
- Script calculates final price and updates both price and cost fields

**Local Stock Override**:
- If Shopify variant has `inventory_quantity > 0`, script skips inventory policy updates
- Allows manual stock management without distributor interference
- Pricing still updates regardless of local stock

### Rate Limiting Strategy

To prevent `HttpThrottlingError` (Shopify limit: 2 calls/second):
1. Script processes variants **sequentially** (not in parallel)
2. After each update API call, script pauses for **550ms**
3. Ensures request rate stays safely below 2/second threshold
4. Makes sync process reliable and error-free

### API Strategy (Hybrid Approach)

**GraphQL for Reads**:
- Efficiently fetches all product/variant data in bulk
- Retrieves metafields and current inventory status

**REST for Writes**:
- Updates price, cost, and inventory policy
- Chosen for stability after GraphQL mutations proved unreliable

**Version Pinning**:
- `@shopify/shopify-api` version locked in `package.json` (e.g., `9.3.2`)
- API client initialized to specific version (e.g., `2024-04`) in code
- Prevents unexpected breaking changes from library updates

## Workflow

1. **Fetch BTI Data**: Retrieves current inventory and pricing from distributor API
2. **Fetch Shopify Products**: Queries all variants with `custom.bti_part_number` metafields
3. **Compare & Detect Changes**: For each matched variant:
   - Checks if inventory policy should change based on BTI stock and local stock override
   - Checks if price should change based on BTI MSRP and markup rules
4. **Sequential Updates**: For variants requiring changes:
   - Makes REST API call to update price/cost and/or inventory policy
   - Pauses 550ms before next update
5. **Report Results**: Sends summary email only if changes were made
6. **Error Handling**: On critical failure, sends detailed error report with full technical context

## Email Notifications

**Success Summary** (only when changes made):
- List of variants updated
- Changes made (price adjustments, inventory policy changes)
- Total number of products processed

**Failure Report** (on critical error):
- Full error message and stack trace
- Technical details (`util.inspect` output)
- Timestamp and execution context

## Environment Variables

Required environment variables (configured in Vercel):
- `SHOPIFY_STORE_DOMAIN`
- `SHOPIFY_ADMIN_ACCESS_TOKEN`
- `BTI_API_ENDPOINT` (or hardcoded in script)
- `RESEND_API_KEY`
- `ADMIN_EMAIL`

## Cron Schedule

Configured in `vercel.json`:
```json
{
  "crons": [{
    "path": "/api/index",
    "schedule": "0 8 * * *"
  }]
}
```
Runs daily at 8:00 AM UTC.

## Key Implementation Learnings

### Why REST API for Updates
Initial implementation used GraphQL `productVariantUpdate` mutation, which failed due to:
- Breaking changes between Shopify API versions
- Unreliable field definitions in GraphQL schema
- `400 Bad Request` and `Field doesn't exist on type 'Mutation'` errors

Switching to REST API resolved all reliability issues.

### Why Version Pinning
Without version pinning, automatic minor version updates to `@shopify/shopify-api` caused unexpected failures. Pinning both the package version and API version ensures long-term stability.

### Why Sequential Processing
Parallel processing caused frequent `HttpThrottlingError` from Shopify. Sequential processing with delays ensures 100% reliability at the cost of slightly longer execution time.

## Future Enhancements

- Support for multiple distributors beyond BTI
- Predictive stock alerts based on BTI inventory trends
- Automated price optimization based on competitor analysis
- Integration with demand forecasting for proactive restocking

## License

MIT License - See LICENSE file for details

---

**Built to automate critical supply chain operations for LoamLabs.**
