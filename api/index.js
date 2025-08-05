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
  apiSecretKey: 'not-used-for-admin-token',
  adminApiAccessToken: SHOPIFY_ADMIN_API_TOKEN,
  isCustomStoreApp: true,
  hostName: SHOPIFY_STORE_DOMAIN.replace('https://', ''),
  apiVersion: shopifyApi.LATEST_API_VERSION,
});
const resend = new Resend(RESEND_API_KEY);

const BTI_INVENTORY_URL = 'https://www.bti-usa.com/inventory';

// --- The main sync function ---
module.exports = async (req, res) => {
    console.log("BTI inventory sync function triggered...");
    const log = ["BTI Sync Started..."];
    let status = 200;
    let message = "Sync completed successfully.";

    try {
        // --- 1. FETCH AND PARSE BTI INVENTORY ---
        log.push("Fetching inventory from BTI...");
        const btiCredentials = Buffer.from(`${BTI_USERNAME}:${BTI_PASSWORD}`).toString('base64');
        const btiResponse = await fetch(BTI_INVENTORY_URL, {
            headers: { 'Authorization': `Basic ${btiCredentials}` }
        });

        if (!btiResponse.ok) {
            throw new Error(`BTI connection failed. Status: ${btiResponse.status} ${btiResponse.statusText}`);
        }

        const csvText = await btiResponse.text();
        const records = parse(csvText, { columns: true, skip_empty_lines: true });

        const btiStockMap = new Map(records.map(r => [r.id, parseInt(r.available, 10) || 0]));
        log.push(`Successfully parsed ${btiStockMap.size} items from BTI feed.`);

        // --- 2. FETCH ALL RELEVANT SHOPIFY VARIANTS ---
        log.push("Fetching all Shopify variants with a BTI part number...");
        const shopifyVariants = await getAllShopifyVariants();
        log.push(`Found ${shopifyVariants.length} Shopify variants to process.`);

        const productsToUpdate = new Map();

        // --- 3. PROCESS EACH VARIANT AND DETERMINE REQUIRED ACTION ---
        for (const variant of shopifyVariants) {
            const btiPartNumber = variant.btiPartNumber.value;
            const btiStock = btiStockMap.get(btiPartNumber) || 0;
            const shopifyStock = variant.inventoryQuantity;

            const isOutOfStock = shopifyStock <= 0 && btiStock <= 0;
            const action = variant.product.outOfStockAction?.value || 'Set to Draft'; // Default to safest action
            
            // Determine the needed state for the parent product
            if (!productsToUpdate.has(variant.product.id)) {
                productsToUpdate.set(variant.product.id, {
                    isCurrentlyActive: variant.product.status === 'ACTIVE',
                    isCurrentlySpecialOrder: variant.product.templateSuffix === 'special-order',
                    variants: [],
                    action: action,
                });
            }
            productsToUpdate.get(variant.product.id).variants.push({ isOutOfStock });
        }
        
        // --- 4. EXECUTE SHOPIFY UPDATES ---
        for (const [productId, data] of productsToUpdate.entries()) {
            // If ALL variants of this product are out of stock, take action.
            const shouldBeUnavailable = data.variants.every(v => v.isOutOfStock);

            if (shouldBeUnavailable) {
                if (data.action === 'Switch to Special Order Template') {
                    if (!data.isCurrentlySpecialOrder) {
                        await updateProductTemplate(productId, 'special-order');
                        log.push(` -> ACTION: Switched product ${productId} to Special Order template.`);
                    }
                } else { // Default to 'Set to Draft'
                    if (data.isCurrentlyActive) {
                        await updateProductStatus(productId, 'DRAFT');
                        log.push(` -> ACTION: Set product ${productId} to Draft status.`);
                    }
                }
            } else { // At least one variant is in stock
                if (!data.isCurrentlyActive) {
                    await updateProductStatus(productId, 'ACTIVE');
                    log.push(` -> ACTION: Set product ${productId} to Active status.`);
                }
                if (data.isCurrentlySpecialOrder) {
                    await updateProductTemplate(productId, null); // Revert to default template
                    log.push(` -> ACTION: Reverted product ${productId} to default template.`);
                }
            }
        }
        
        log.push("Sync logic complete.");
        message = `Sync complete. Processed ${shopifyVariants.length} variants across ${productsToUpdate.size} products.`;

    } catch (error) {
        console.error("An error occurred during the BTI sync:", error);
        log.push(`\n--- ERROR --- \n${error.message}`);
        status = 500;
        message = `Sync failed: ${error.message}`;

        // Send error email
        await resend.emails.send({
            from: 'LoamLabs BTI Sync <alerts@loamlabsusa.com>',
            to: REPORT_EMAIL_TO,
            subject: `BTI Sync Failure: ${error.message}`,
            html: `<h1>BTI Inventory Sync Failed</h1>
                   <p>The automated sync process encountered a critical error. Please review the logs in your Vercel project for details.</p>
                   <p><strong>Error Message:</strong> ${error.message}</p>
                   <hr><h3>Full Log:</h3><pre>${log.join('\n')}</pre>`
        });
    }
    
    console.log(log.join('\n'));
    res.status(status).send(message);
};

// --- SHOPIFY API HELPER FUNCTIONS ---

async function getAllShopifyVariants() {
    const query = `
    query($cursor: String) {
      productVariants(first: 250, after: $cursor, query: "metafield:custom.bti_part_number:''") {
        edges {
          node {
            id
            inventoryQuantity
            btiPartNumber: metafield(namespace: "custom", key: "bti_part_number") {
              value
            }
            product {
              id
              status
              templateSuffix
              outOfStockAction: metafield(namespace: "custom", key: "out_of_stock_action") {
                value
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }`;

    const client = new shopify.clients.Graphql({ session: getSession() });
    let allVariants = [];
    let hasNextPage = true;
    let cursor = null;

    do {
        const response = await client.query({ data: { query, variables: { cursor } } });
        const pageData = response.body.data.productVariants;
        allVariants.push(...pageData.edges.map(edge => edge.node));
        hasNextPage = pageData.pageInfo.hasNextPage;
        cursor = pageData.pageInfo.endCursor;
    } while (hasNextPage);

    return allVariants;
}

async function updateProductStatus(productId, status) {
    const client = new shopify.clients.Graphql({ session: getSession() });
    await client.query({
        data: {
            query: `mutation productUpdate($input: ProductInput!) { productUpdate(input: $input) { product { id status } userErrors { field message } } }`,
            variables: { input: { id: productId, status: status } }
        }
    });
}

async function updateProductTemplate(productId, templateSuffix) {
    const client = new shopify.clients.Graphql({ session: getSession() });
    await client.query({
        data: {
            query: `mutation productUpdate($input: ProductInput!) { productUpdate(input: $input) { product { id templateSuffix } userErrors { field message } } }`,
            variables: { input: { id: productId, templateSuffix: templateSuffix } }
        }
    });
}

function getSession() {
    return {
        id: 'bti-sync-session',
        shop: SHOPIFY_STORE_DOMAIN,
        accessToken: SHOPIFY_ADMIN_API_TOKEN,
        state: 'not-used',
        isOnline: false,
    };
}
