// Import the necessary tools (libraries)
const shopifyApi = require('@shopify/shopify-api');
require('@shopify/shopify-api/adapters/node');
const { Resend } = require('resend');
const { parse } = require('csv-parse/sync');
const util = require('util');

// A simple helper function to pause execution
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- CONFIGURATION ---
const {
  SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_TOKEN, BTI_USERNAME,
  BTI_PASSWORD, RESEND_API_KEY, REPORT_EMAIL_TO,
} = process.env;

// Initialize clients (Keep as is)
const shopify = shopifyApi.shopifyApi({
  apiKey: 'temp_key', apiSecretKey: 'temp_secret',
  scopes: ['read_products', 'write_products', 'write_inventory'],
  hostName: SHOPIFY_STORE_DOMAIN ? SHOPIFY_STORE_DOMAIN.replace('https://', '') : '', // Added safety check
  apiVersion: '2024-04',
  isEmbeddedApp: false, isCustomStoreApp: true,
  adminApiAccessToken: SHOPIFY_ADMIN_API_TOKEN,
});
const resend = new Resend(RESEND_API_KEY);
const BTI_FULL_DATA_URL = 'https://www.bti-usa.com/inventory?full=true';

// --- NEW HELPER: RETRY FETCH LOGIC ---
async function fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            if (response.ok) return response;
            
            // If 503, wait and retry
            if (response.status === 503 || response.status === 502 || response.status === 504) {
                console.log(`Attempt ${i + 1} failed with ${response.status}. Retrying in 2 seconds...`);
                await sleep(2000 * (i + 1)); // Wait 2s, then 4s, etc.
                continue;
            }
            
            // If it's a 401 (Auth) or 404, throw immediately, don't retry
            throw new Error(`Request failed: ${response.status}`);
        } catch (err) {
            if (i === retries - 1) throw err; // Throw on last attempt
            console.log(`Connection error on attempt ${i + 1}: ${err.message}. Retrying...`);
            await sleep(2000);
        }
    }
}

// The main sync function
module.exports = async (req, res) => {
    console.log("BTI full sync (inventory & price) function triggered...");
    const log = ["BTI Sync Started..."];
    let status = 200;
    let message = "Sync completed successfully.";
    const changesMade = { availability: [], pricing: [] };

    try {
        log.push("Fetching FULL inventory and price data from BTI...");
        
        // --- FIX IMPLEMENTED HERE ---
        const btiCredentials = Buffer.from(`${BTI_USERNAME}:${BTI_PASSWORD}`).toString('base64');
        
        // We use the custom fetchWithRetry function
        // We add User-Agent to pretend we are a browser, not a bot
        const btiResponse = await fetchWithRetry(BTI_FULL_DATA_URL, { 
            headers: { 
                'Authorization': `Basic ${btiCredentials}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/csv,text/plain;q=0.9,*/*;q=0.8',
                'Connection': 'keep-alive'
            } 
        });

        const csvText = await btiResponse.text();
        // ---------------------------

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

        let updatesPerformedCount = 0;
        log.push("Processing variants sequentially to respect API rate limits...");

        for (const variant of shopifyVariants) {
            const btiPartNumber = variant.btiPartNumber.value;
            const btiData = btiDataMap.get(btiPartNumber);
            if (!btiData) continue;
            
            const variantIdentifier = `${variant.product.title} - ${variant.title}`;
            let hasUpdateOccurred = false;

            // --- AVAILABILITY LOGIC ---
            const shopifyStock = variant.inventoryQuantity;
            const isTrulyOutOfStock = shopifyStock <= 0 && btiData.available <= 0;
            const isCurrentlySetToContinueSelling = variant.inventoryPolicy === 'CONTINUE';
            
            // Fixed logic check for outOfStockAction
            const outOfStockAction = variant.product.outOfStockAction?.value;
            
            if (outOfStockAction === 'Make Unavailable (Track Inventory)' || !outOfStockAction) {
                if (isTrulyOutOfStock && isCurrentlySetToContinueSelling) {
                    await updateVariantInventoryPolicy(variant.id, 'DENY');
                    changesMade.availability.push({ name: variantIdentifier, action: 'Made Unavailable' });
                    hasUpdateOccurred = true;
                } else if (!isTrulyOutOfStock && !isCurrentlySetToContinueSelling) {
                    await updateVariantInventoryPolicy(variant.id, 'CONTINUE');
                    changesMade.availability.push({ name: variantIdentifier, action: 'Made Available' });
                    hasUpdateOccurred = true;
                }
            }

            // --- PRICING LOGIC ---
            if (btiData.msrp > 0 && btiData.cost > 0) {
                let newPrice; let newCompareAtPrice;
                const priceAdjustmentPct = variant.product.priceAdjustmentPercentage?.value;
                if (priceAdjustmentPct != null) {
                    const adjustment = 1 + (parseInt(priceAdjustmentPct, 10) / 100);
                    newPrice = (btiData.msrp * adjustment).toFixed(2);
                    newCompareAtPrice = newPrice;
                } else {
                    newPrice = (btiData.msrp * 0.99).toFixed(2);
                    newCompareAtPrice = btiData.msrp.toFixed(2);
                }
                const newCost = btiData.cost.toFixed(2);
                const currentCost = variant.inventoryItem.unitCost ? parseFloat(variant.inventoryItem.unitCost.amount).toFixed(2) : null;
                
                if (newPrice !== variant.price || newCompareAtPrice !== variant.compareAtPrice || newCost !== currentCost) {
                    await updateVariantPricing(variant.id, newPrice, newCompareAtPrice, newCost, variant.inventoryItem.id);
                    changesMade.pricing.push({ 
                        name: variantIdentifier, 
                        oldPrice: variant.price, newPrice: newPrice, 
                        oldCompareAt: variant.compareAtPrice, newCompareAt: newCompareAtPrice,
                        oldCost: currentCost, newCost: newCost 
                    });
                    hasUpdateOccurred = true;
                }
            }

            // If an API call was made for this variant, PAUSE to respect the rate limit.
            if (hasUpdateOccurred) {
                updatesPerformedCount++;
                await sleep(550); // Pause for 550 milliseconds
            }
        }
        
        log.push(`All variants processed. ${updatesPerformedCount} updates were performed sequentially.`);

        const totalChanges = changesMade.availability.length + changesMade.pricing.length;
        if (totalChanges > 0) {
            let reportHtml = `<h1>BTI Inventory & Price Sync Report</h1>`;
            if (changesMade.availability.length > 0) { reportHtml += `<h2>Availability Updates (${changesMade.availability.length})</h2><ul>${changesMade.availability.map(c => `<li><b>${c.name}</b>: ${c.action}</li>`).join('')}</ul>`; }
            if (changesMade.pricing.length > 0) {
                reportHtml += `<h2>Pricing Updates (${changesMade.pricing.length})</h2>
                               <table style="width:100%; border-collapse: collapse;">
                                 <thead><tr style="text-align:left; background-color:#f4f4f4;">
                                     <th style="padding:8px; border:1px solid #ddd;">Product</th>
                                     <th style="padding:8px; border:1px solid #ddd;">Price</th>
                                     <th style="padding:8px; border:1px solid #ddd;">Compare At</th>
                                     <th style="padding:8px; border:1px solid #ddd;">Cost</th>
                                 </tr></thead><tbody>`;
                changesMade.pricing.forEach(c => {
                    const priceChanged = c.oldPrice !== c.newPrice ? 'style="background-color:#fff8e1;"' : '';
                    const compareAtChanged = c.oldCompareAt !== c.newCompareAt ? 'style="background-color:#fff8e1;"' : '';
                    const costChanged = c.oldCost !== c.newCost ? 'style="background-color:#fff8e1;"' : '';
                    reportHtml += `<tr>
                                     <td style="padding:8px; border:1px solid #ddd;"><b>${c.name}</b></td>
                                     <td ${priceChanged}>$${c.oldPrice} → $${c.newPrice}</td>
                                     <td ${compareAtChanged}>$${c.oldCompareAt || 'N/A'} → $${c.newCompareAt}</td>
                                     <td ${costChanged}>$${c.oldCost || 'N/A'} → $${c.newCost}</td>
                                   </tr>`;
                });
                reportHtml += `</tbody></table>`;
            }
            await resend.emails.send({ from: 'LoamLabs BTI Sync <info@loamlabsusa.com>', to: REPORT_EMAIL_TO, subject: `BTI Sync Report: ${totalChanges} Updates Made`, html: reportHtml, });
            log.push("Sync report email sent successfully.");
        } else {
            log.push("Sync complete. No changes were needed.");
        }
        message = `Sync complete. Processed ${shopifyVariants.length} variants. ${totalChanges} changes made.`;

    } catch (error) {
        console.error("--- CRITICAL ERROR in BTI SYNC ---");
        const detailedErrorString = util.inspect(error, { showHidden: false, depth: null, colors: false });
        console.error("--- FULL ERROR OBJECT ---");
        console.error(detailedErrorString);
        log.push("\n--- FULL ERROR OBJECT ---\n" + detailedErrorString);
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
        const response = await client.request(query, { variables: { cursor } });
        if (response.data && !response.data.productVariants) { break; }
        const pageData = response.data.productVariants;
        allVariants.push(...pageData.edges.map(edge => edge.node));
        hasNextPage = pageData.pageInfo.hasNextPage;
        cursor = pageData.pageInfo.endCursor;
    } while (hasNextPage);
    return allVariants.filter(variant => variant.btiPartNumber && variant.btiPartNumber.value);
}

async function updateVariantInventoryPolicy(variantGid, policy) {
    const client = new shopify.clients.Rest({ session: getSession() });
    const numericVariantId = variantGid.split('/').pop();
    await client.put({
        path: `variants/${numericVariantId}.json`,
        data: { variant: { id: numericVariantId, inventory_policy: policy.toLowerCase() } }
    });
}

// --- THIS IS THE FINAL, CORRECTED FUNCTION ---
async function updateVariantPricing(variantGid, price, compareAtPrice, cost, inventoryItemId) {
    const client = new shopify.clients.Rest({ session: getSession() });
    const numericVariantId = variantGid.split('/').pop();
    const numericInventoryItemId = inventoryItemId ? inventoryItemId.split('/').pop() : null;

    // API Call 1: Update price and compare_at_price on the variant
    await client.put({
        path: `variants/${numericVariantId}.json`,
        data: {
            variant: {
                id: numericVariantId,
                price: price,
                compare_at_price: compareAtPrice
            }
        }
    });

    // API Call 2: Update cost on the separate inventory_item endpoint
    if (cost && numericInventoryItemId) {
        await client.put({
            path: `inventory_items/${numericInventoryItemId}.json`,
            data: {
                inventory_item: {
                    id: numericInventoryItemId,
                    cost: cost
                }
            }
        });
    }
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
