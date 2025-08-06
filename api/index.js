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
        const shopifyVariants = await getAllShopifyVariants();
        log.push(`Found ${shopifyVariants.length} Shopify variants to process.`);

        for (const variant of shopifyVariants) {
            const btiPartNumber = variant.btiPartNumber.value;
            const btiData = btiDataMap.get(btiPartNumber);
            if (!btiData) continue;

            const variantIdentifier = `${variant.product.title} - ${variant.title}`;
            const shopifyStock = variant.inventoryQuantity;
            const isTrulyOutOfStock = shopifyStock <= 0 && btiData.available <= 0;
            const isCurrentlySetToContinueSelling = variant.inventoryPolicy === 'CONTINUE';
            
            if (variant.product.outOfStockAction?.value === 'Make Unavailable (Track Inventory)' || !variant.product.outOfStockAction?.value) {
                if (isTrulyOutOfStock && isCurrentlySetToContinueSelling) {
                    await updateVariantInventoryPolicy(variant.id, 'deny');
                    changesMade.availability.push({ name: variantIdentifier, action: 'Made Unavailable' });
                } else if (!isTrulyOutOfStock && !isCurrentlySetToContinueSelling) {
                    await updateVariantInventoryPolicy(variant.id, 'continue');
                    changesMade.availability.push({ name: variantIdentifier, action: 'Made Available' });
                }
            }

            const isPriceSyncExcluded = variant.product.excludeFromPriceSync?.value === true;
            if (isPriceSyncExcluded) {
                continue; // Skip the rest of the loop for this variant
            }

            if (btiData.msrp > 0 && btiData.cost > 0) {
                const newPrice = (btiData.msrp * 0.99).toFixed(2);
                const currentPrice = variant.price;
                const currentCompareAtPrice = variant.compareAtPrice;
                const currentCost = variant.inventoryItem.unitCost?.amount;

                if (newPrice !== currentPrice || btiData.msrp.toFixed(2) !== currentCompareAtPrice || btiData.cost.toFixed(2) !== currentCost) {
                    await updateVariantPricing(variant.id, variant.inventoryItem.id, newPrice, btiData.msrp.toFixed(2), btiData.cost.toFixed(2));
                    changesMade.pricing.push({ name: variantIdentifier, oldPrice: currentPrice, newPrice: newPrice, oldCost: currentCost, newCost: btiData.cost.toFixed(2) });
                }
            }
        }
        
        const totalChanges = changesMade.availability.length + changesMade.pricing.length;
        if (totalChanges > 0) {
            let reportHtml = `<h1>BTI Inventory & Price Sync Report</h1><p>...</p>`;
            // ... (HTML building logic) ...
            await resend.emails.send({
                from: 'LoamLabs BTI Sync <info@loamlabsusa.com>', to: REPORT_EMAIL_TO,
                subject: `BTI Sync Report: ${totalChanges} Updates Made`,
                html: reportHtml,
            });
            log.push("Sync report email sent successfully.");
        } else {
            log.push("Sync complete. No changes were needed.");
        }
        message = `Sync complete. Processed ${shopifyVariants.length} variants. ${totalChanges} changes made.`;

    } catch (error) {
        console.error("An error occurred during the BTI sync:", error);
        log.push(`\n--- ERROR --- \n${error.message}`);
        status = 500;
        message = `Sync failed: ${error.message}`;
        await resend.emails.send({ from: 'LoamLabs BTI Sync <info@loamlabsusa.com>', to: REPORT_EMAIL_TO, subject: `BTI Sync Failure: ${error.message}`, html: `<h1>BTI Sync Failed</h1><p>...</p><pre>${log.join('\n')}</pre>` });
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
            id, title, price, compareAtPrice, inventoryQuantity, inventoryPolicy
            inventoryItem { id, unitCost { amount } }
            btiPartNumber: metafield(namespace: "custom", key: "bti_part_number") { value }
            product {
              id, title
              outOfStockAction: metafield(namespace: "custom", key: "out_of_stock_action") { value }
              excludeFromPriceSync: metafield(namespace: "custom", key: "exclude_from_price_sync") { value }
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

async function updateVariantInventoryPolicy(variantGid, policy) {
    const variantId = variantGid.split('/').pop();
    const client = new shopify.clients.Rest({ session: getSession() });
    await client.put({
        path: `variants/${variantId}`,
        data: { variant: { id: variantId, inventory_policy: policy } },
    });
}

async function updateVariantPricing(variantGid, inventoryItemId, price, compareAtPrice, cost) {
    const client = new shopify.clients.Graphql({ session: getSession() });
    await client.query({
        data: {
            query: `mutation productVariantUpdate($input: ProductVariantInput!) {
                productVariantUpdate(input: $input) {
                    productVariant { id } userErrors { field message }
                }
            }`,
            variables: {
                input: {
                    id: variantGid,
                    price: price,
                    compareAtPrice: compareAtPrice,
                    inventoryItem: {
                        cost: cost
                    }
                }
            }
        }
    });
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
