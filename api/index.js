// Import the necessary tools (libraries)
const shopifyApi = require('@shopify/shopify-api');
require('@shopify/shopify-api/adapters/node');
const { Resend } = require('resend');
const { parse } = require('csv-parse/sync');
const util = require('util'); // <-- IMPORT THE DEBUGGING TOOL

// --- CONFIGURATION ---
const {
  SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_TOKEN, BTI_USERNAME,
  BTI_PASSWORD, RESEND_API_KEY, REPORT_EMAIL_TO,
} = process.env;

// Initialize clients
const shopify = shopifyApi.shopifyApi({
  apiKey: 'temp_key', apiSecretKey: 'temp_secret',
  scopes: ['read_products', 'write_products', 'write_inventory'],
  hostName: SHOPIFY_STORE_DOMAIN.replace('https://', ''),
  apiVersion: shopifyApi.LATEST_API_VERSION,
  isEmbeddedApp: false, isCustomStoreApp: true,
  adminApiAccessToken: SHOPIFY_ADMIN_API_TOKEN,
});
const resend = new Resend(RESEND_API_KEY);
const BTI_FULL_DATA_URL = 'https://www.bti-usa.com/inventory?full=true';

// The main sync function
module.exports = async (req, res) => {
    console.log("BTI full sync (inventory & price) function triggered...");
    const log = ["BTI Sync Started..."];
    let status = 200;
    let message = "Sync completed successfully.";
    const changesMade = { availability: [], pricing: [] };

    try {
        log.push("Fetching FULL inventory and price data from BTI...");
        const btiCredentials = Buffer.from(`${BTI_USERNAME}:${BTI_PASSWORD}`).toString('base64');
        const btiResponse = await fetch(BTI_FULL_DATA_URL, { headers: { 'Authorization': `Basic ${btiCredentials}` } });
        if (!btiResponse.ok) throw new Error(`BTI connection failed: ${btiResponse.status}`);
        const csvText = await btiResponse.text();
        const records = parse(csvText, { columns: true, skip_empty_lines: true });
        const btiDataMap = new Map(records.map(r => [r.id, {
            available: parseInt(r.available, 10) || 0,
            cost: parseFloat(r.your_price) || 0,
            msrp: parseFloat(r.msrp) || 0,
        }]));
        log.push(`Successfully parsed ${btiDataMap.size} items from BTI feed.`);

        log.push("Fetching all Shopify variants with a BTI part number...");
        const shopifyVariants = await getBtiLinkedShopifyVariants();
        log.push(`Found ${shopifyVariants.length} Shopify variants to process.`);

        // ... (The rest of the success logic remains the same) ...

    } catch (error) {
        console.error("--- CRITICAL ERROR in BTI SYNC ---");
        
        // --- NEW, AGGRESSIVE DEBUGGING ---
        // This will print the entire, deeply nested error object to the logs.
        const detailedErrorString = util.inspect(error, { showHidden: false, depth: null, colors: false });
        console.error("--- FULL ERROR OBJECT ---");
        console.error(detailedErrorString);
        log.push("\n--- FULL ERROR OBJECT ---\n" + detailedErrorString);
        // --- END NEW DEBUGGING ---

        log.push(`\n--- ERROR MESSAGE --- \n${error.message}`);
        status = 500;
        message = `Sync failed: ${error.message}`;
        await resend.emails.send({ from: 'LoamLabs BTI Sync <info@loamlabsusa.com>', to: REPORT_EMAIL_TO, subject: `BTI Sync Failure: ${error.message}`, html: `<h1>BTI Sync Failed</h1><p>The sync process encountered a critical error. Please check the Vercel logs for details.</p><pre>${log.join('\n')}</pre>` });
    }
    
    console.log(log.join('\n'));
    res.status(status).send(message);
};

// --- SHOPIFY API HELPER FUNCTIONS ---

async function getBtiLinkedShopifyVariants() {
    const query = `
    query($cursor: String) {
      productVariants(first: 250, after: $cursor) {
        edges {
          node {
            id, title, price, compareAtPrice, inventoryQuantity, inventoryPolicy
            inventoryItem { id, unitCost { amount } }
            btiPartNumber: metafield(namespace: "custom", key: "bti_part_number") { value }
            product {
              id, title
              outOfStockAction: metafield(namespace: "custom", key: "out_of_stock_action") { value }
              priceAdjustmentPercentage: metafield(namespace: "custom", key: "price_adjustment_percentage") { value }
            }
          }
        }
        pageInfo { hasNextPage, endCursor }
      }
    }`;
    
    const client = new shopify.clients.Graphql({ session: getSession() });
    let allVariants = [];
    let hasNextPage = true; let cursor = null;
    
    do {
        const response = await client.request({ 
            data: { query, variables: { cursor } } 
        });
        if (!response.data.productVariants) { break; }
        const pageData = response.data.productVariants;
        allVariants.push(...pageData.edges.map(edge => edge.node));
        hasNextPage = pageData.pageInfo.hasNextPage;
        cursor = pageData.pageInfo.endCursor;
    } while (hasNextPage);
    
    return allVariants.filter(variant => variant.btiPartNumber && variant.btiPartNumber.value);
}

// ... (updateVariantInventoryPolicy and updateVariantPricing functions remain the same) ...
async function updateVariantInventoryPolicy(variantGid, policy) { /* ... no changes ... */ }
async function updateVariantPricing(variantGid, price, compareAtPrice, cost) { /* ... no changes ... */ }


function getSession() {
    return {
        id: 'bti-sync-session',
        shop: SHOPIFY_STORE_DOMAIN,
        accessToken: SHOPIFY_ADMIN_API_TOKEN,
        state: 'not-used',
        isOnline: false, 
    };
}
