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

// --- DEFINITIVE, CORRECTED INITIALIZATION ---
const shopify = shopifyApi.shopifyApi({
  apiKey: 'placeholder',
  apiSecretKey: 'placeholder',
  scopes: ['read_products', 'write_products'],
  hostName: SHOPIFY_STORE_DOMAIN.replace('https://', ''),
  apiVersion: shopifyApi.LATEST_API_VERSION, // Use the latest version
  isEmbeddedApp: false,
  isCustomStoreApp: true,
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
    const changesMade = [];

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
            const variantIdentifier = `${variant.product.title} - ${variant.title}`;

            if (outOfStockAction === 'Make Unavailable (Track Inventory)') {
                if (isTrulyOutOfStock && isCurrentlySetToContinueSelling) {
                    await updateVariantInventoryPolicy(variant.id, 'DENY');
                    log.push(` -> ACTION: Made variant "${variantIdentifier}" unavailable (OOS).`);
                    changesMade.push({ name: variantIdentifier, action: 'Made Unavailable' });
                } else if (!isTrulyOutOfStock && !isCurrentlySetToContinueSelling) {
                    await updateVariantInventoryPolicy(variant.id, 'CONTINUE');
                    log.push(` -> ACTION: Made variant "${variantIdentifier}" available again (Back in Stock).`);
                    changesMade.push({ name: variantIdentifier, action: 'Made Available' });
                }
            } else if (outOfStockAction === 'Switch to Special Order Template') {
                if (!isCurrentlySetToContinueSelling) {
                    await updateVariantInventoryPolicy(variant.id, 'CONTINUE');
                    log.push(` -> INFO: Ensuring variant "${variantIdentifier}" for Special Order product is sellable.`);
                    changesMade.push({ name: variantIdentifier, action: 'Made Available' });
                }
            }
        }
        
        // 4. Generate and Send Sync Report
        if (changesMade.length > 0) {
            log.push(`Found ${changesMade.length} changes to report. Generating email.`);
            let reportHtml = `<h1>BTI Inventory Sync Report</h1><p>The sync completed successfully and the following ${changesMade.length} variants had their availability updated based on BTI stock levels.</p>`;
            const unavailableItems = changesMade.filter(c => c.action === 'Made Unavailable');
            if (unavailableItems.length > 0) {
                reportHtml += `<hr><h3>Made Unavailable (Out of Stock)</h3><ul>${unavailableItems.map(item => `<li>${item.name}</li>`).join('')}</ul>`;
            }
            const availableItems = changesMade.filter(c => c.action === 'Made Available');
            if (availableItems.length > 0) {
                reportHtml += `<hr><h3>Made Available (Back in Stock)</h3><ul>${availableItems.map(item => `<li>${item.name}</li>`).join('')}</ul>`;
            }
            await resend.emails.send({
                from: 'LoamLabs BTI Sync <info@loamlabsusa.com>',
                to: REPORT_EMAIL_TO,
                subject: `BTI Sync Report: ${changesMade.length} Variants Updated`,
                html: reportHtml,
            });
            log.push("Sync report email sent successfully.");
        } else {
            log.push("Sync complete. No changes to variant availability were needed.");
        }
        message = `Sync complete. Processed ${shopifyVariants.length} variants. ${changesMade.length} changes made.`;

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
      productVariants(first: 250, after: $cursor) {
        edges {
          node {
            id
            title
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
        if (!response.body.data.productVariants) { break; }
        const pageData = response.body.data.productVariants;
        allVariants.push(...pageData.edges.map(edge => edge.node));
        hasNextPage = pageData.pageInfo.hasNextPage;
        cursor = pageData.pageInfo.endCursor;
    } while (hasNextPage);
    return allVariants.filter(variant => variant.btiPartNumber && variant.btiPartNumber.value);
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
                    inventoryPolicy: policy,
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
