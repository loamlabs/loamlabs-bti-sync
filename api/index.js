// Import the necessary tools (libraries)
const shopifyApi = require('@shopify/shopify-api');
require('@shopify/shopify-api/adapters/node');
const { Resend } = require('resend');
const { parse } = require('csv-parse/sync');

// --- CONFIGURATION ---
const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_ADMIN_API_TOKEN,
  BTI_USERNAME,
  BTI_PASSWORD,
  RESEND_API_KEY,
  REPORT_EMAIL_TO,
} = process.env;

// Initialize clients
const shopify = shopifyApi.shopifyApi({
  apiKey: 'temp_key', apiSecretKey: 'temp_secret',
  scopes: ['read_products', 'write_products'],
  hostName: SHOPIFY_STORE_DOMAIN.replace('https://', ''),
  apiVersion: shopifyApi.LATEST_API_VERSION,
  isEmbeddedApp: false, isCustomStoreApp: true,
  adminApiAccessToken: SHOPIFY_ADMIN_API_TOKEN,
});
const resend = new Resend(RESEND_API_KEY);
const BTI_INVENTORY_URL = 'https://www.bti-usa.com/inventory';

// The main sync function
module.exports = async (req, res) => {
    console.log("BTI inventory sync function triggered...");
    const log = ["BTI Sync Started..."];
    let status = 200;
    let message = "Sync completed successfully.";

    try {
        // 1. Fetch and Parse BTI Inventory
        log.push("Fetching inventory from BTI...");
        const btiCredentials = Buffer.from(`${BTI_USERNAME}:${BTI_PASSWORD}`).toString('base64');
        const btiResponse = await fetch(BTI_INVENTORY_URL, { headers: { 'Authorization': `Basic ${btiCredentials}` } });
        if (!btiResponse.ok) throw new Error(`BTI connection failed: ${btiResponse.status}`);
        const csvText = await btiResponse.text();
        const records = parse(csvText, { columns: true, skip_empty_lines: true });
        const btiStockMap = new Map(records.map(r => [r.id, parseInt(r.available, 10) || 0]));
        log.push(`Successfully parsed ${btiStockMap.size} items from BTI feed.`);

        // 2. Fetch all Shopify variants that are linked to BTI
        log.push("Fetching all Shopify variants with a BTI part number...");
        const shopifyVariants = await getAllShopifyVariants();
        log.push(`Found ${shopifyVariants.length} Shopify variants to process.`);

        // 3. Process each variant and execute updates
        for (const variant of shopifyVariants) {
            const btiPartNumber = variant.btiPartNumber.value;
            const btiStock = btiStockMap.get(btiPartNumber) || 0;
            const shopifyStock = variant.inventoryQuantity;
            const outOfStockAction = variant.product.outOfStockAction?.value || 'Make Unavailable (Track Inventory)';
            const isTrulyOutOfStock = shopifyStock <= 0 && btiStock <= 0;
            const isCurrentlySetToContinueSelling = variant.inventoryPolicy === 'CONTINUE';

            if (outOfStockAction === 'Make Unavailable (Track Inventory)') {
                if (isTrulyOutOfStock && isCurrentlySetToContinueSelling) {
                    await updateVariantInventoryPolicy(variant.id, 'DENY');
                    log.push(` -> ACTION: Made variant "${variant.product.title} - ${variant.title}" unavailable (OOS).`);
                } else if (!isTrulyOutOfStock && !isCurrentlySetToContinueSelling) {
                    await updateVariantInventoryPolicy(variant.id, 'CONTINUE');
                    log.push(` -> ACTION: Made variant "${variant.product.title} - ${variant.title}" available again (Back in Stock).`);
                }
            } else if (outOfStockAction === 'Switch to Special Order Template') {
                if (!isCurrentlySetToContinueSelling) {
                    await updateVariantInventoryPolicy(variant.id, 'CONTINUE');
                    log.push(` -> INFO: Ensuring variant "${variant.product.title} - ${variant.title}" for Special Order product is sellable.`);
                }
            }
        }
        
        log.push("Sync logic complete.");
        message = `Sync complete. Processed ${shopifyVariants.length} variants.`;

    } catch (error) {
        console.error("An error occurred during the BTI sync:", error);
        log.push(`\n--- ERROR --- \n${error.message}`);
        status = 500;
        message = `Sync failed: ${error.message}`;
        await resend.emails.send({
            from: 'LoamLabs BTI Sync <info@loamlabsusa.com>', to: REPORT_EMAIL_TO,
            subject: `BTI Sync Failure: ${error.message}`,
            html: `<h1>BTI Inventory Sync Failed</h1><p>...</p><pre>${log.join('\n')}</pre>`
        });
    }
    
    console.log(log.join('\n'));
    res.status(status).send(message);
};

// --- SHOPIFY API HELPER FUNCTIONS ---
async function getAllShopifyVariants() {
    const query = `
    query($cursor: String) {
      productVariants(first: 250, after: $cursor, query: "-metafield:custom.bti_part_number:''") {
        edges {
          node {
            id
            inventoryQuantity
            inventoryPolicy
            btiPartNumber: metafield(namespace: "custom", key: "bti_part_number") { value }
            product {
              id
              title
              outOfStockAction: metafield(namespace: "custom", key: "out_of_stock_action") { value }
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
        const response = await client.query({ data: { query, variables: { cursor } } });
        if (!response.body.data.productVariants) {
            console.warn("Shopify API returned no productVariants object.");
            break;
        }
        const pageData = response.body.data.productVariants;
        allVariants.push(...pageData.edges.map(edge => edge.node));
        hasNextPage = pageData.pageInfo.hasNextPage;
        cursor = pageData.pageInfo.endCursor;
    } while (hasNextPage);
    return allVariants;
}

async function updateVariantInventoryPolicy(variantId, policy) {
    const client = new shopify.clients.Graphql({ session: getSession() });
    const response = await client.query({
        data: {
            query: `mutation productVariantUpdate($input: ProductVariantInput!) {
                productVariantUpdate(input: $input) {
                    productVariant { id inventoryPolicy }
                    userErrors { field message }
                }
            }`,
            variables: {
                input: {
                    id: variantId,
                    inventoryPolicy: policy, // DENY or CONTINUE
                }
            }
        }
    });
    if(response.body.data.productVariantUpdate.userErrors.length > 0){
        console.error("Error updating variant policy:", response.body.data.productVariantUpdate.userErrors);
    }
}

function getSession() {
    return {
        id: 'bti-sync-session',
        shop: SHOPIFY_STORE_DOMAIN,
        accessToken: SHOPIFY_ADMIN_API_TOKEN,
        state: 'not-used',
        isOnline: true,
    };
}
