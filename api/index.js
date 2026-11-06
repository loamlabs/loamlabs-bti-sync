// Import the necessary tools (libraries)
const shopifyApi = require('@shopify/shopify-api');
require('@shopify/shopify-api/adapters/node');
const { Resend } = require('resend');
const { parse } = require('csv-parse/sync');
const util = require('util');
const { planVariant, isRealPartNumber } = require('../lib/plan-variant');
const { fetchWatcherManagedSet } = require('../lib/watcher-managed');
const { checkAuth } = require('../lib/auth');
const { checkFeed, FeedCheckError, readPreviousCount, recordCount } = require('../lib/feed-check');
const { createClient } = require('@supabase/supabase-js');

// --- DATABASE CONFIGURATION ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// A simple helper function to pause execution
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
  apiVersion: '2025-10', // <-- UPDATED to current supported version
  isEmbeddedApp: false, isCustomStoreApp: true,
  adminApiAccessToken: SHOPIFY_ADMIN_API_TOKEN,
});
const resend = new Resend(RESEND_API_KEY);
const BTI_FULL_DATA_URL = 'https://www.bti-usa.com/inventory?full=true';

// The main sync function
module.exports = async (req, res) => {
    // Lock: decided before any work. Only a reason code is logged, never the secret or what was sent.
    const auth = checkAuth({ headers: req.headers, secret: process.env.CRON_SECRET });
    console.log(`[AUTH] ${auth.allowed ? (auth.ok ? 'allowed' : 'allowed (phase 1, not enforced)') : 'rejected'}: ${auth.reason}`);
    if (!auth.allowed) return res.status(auth.status).json({ error: auth.status === 503 ? 'NOT_CONFIGURED' : 'Unauthorized' });

    console.log("BTI full sync (inventory & price) function triggered...");
    const log = ["BTI Sync Started..."];
    let status = 200;
    let message = "Sync completed successfully.";
    const changesMade = { availability: [], pricing: [], costOnly: [], notices: [] };

    try {
        log.push("Fetching FULL inventory and price data from BTI...");
        const btiCredentials = Buffer.from(`${BTI_USERNAME}:${BTI_PASSWORD}`).toString('base64');
        
        let btiResponse;
        let attempt = 0;
        const maxRetries = 3;

        // --- RETRY LOOP ---
        while (attempt < maxRetries) {
            if (attempt > 0) log.push(`Retrying BTI connection (Attempt ${attempt + 1}/${maxRetries})...`);
            
            btiResponse = await fetch(BTI_FULL_DATA_URL, { 
                headers: { 
                    'Authorization': `Basic ${btiCredentials}`,
                    'User-Agent': 'LoamLabs-BTI-Sync/1.0 (Vercel Serverless)',
                    'Accept': 'text/csv,text/plain,*/*'
                } 
            });

            if (btiResponse.ok) {
                break; // Success! Exit the retry loop.
            }

            attempt++;
            log.push(`Warning: BTI returned HTTP status ${btiResponse.status}.`);
            
            if (attempt < maxRetries) {
                const waitTime = attempt * 3000; 
                log.push(`Waiting ${waitTime / 1000} seconds before retrying...`);
                await sleep(waitTime); 
            }
        }

        if (!btiResponse.ok) {
            const errorHtml = await btiResponse.text();
            console.error("[BTI 503 RESPONSE BODY]:", errorHtml.substring(0, 1000));
            throw new Error(`BTI connection failed after ${maxRetries} attempts. Final status: ${btiResponse.status}. See logs for response body.`);
        }

        const csvText = await btiResponse.text();
        const records = parse(csvText, { columns: true, skip_empty_lines: true });
        const btiDataMap = new Map(records.map(r => [r.id, {
            available: parseInt(r.available, 10) || 0,
            cost: parseFloat(r.your_price) || 0,
            msrp: parseFloat(r.msrp) || 0,
        }]));
        log.push(`Successfully parsed ${btiDataMap.size} items from BTI feed.`);

        log.push("Fetching Watcher Managed Registry to check for pricing conflicts...");
        const watcherManagedSet = await fetchWatcherManagedSet(supabase); // pages past Supabase's 1,000-row cap; throws rather than return a partial list
        log.push(`Found ${watcherManagedSet.size} variants with a Vendor Watcher rule. BTI skips them unless custom.bti_sync_authority is true, never changes their price or compare-at, and never deletes their part number.`);

        log.push("Fetching all Shopify variants with a BTI part number...");
        const shopifyVariants = await getBtiLinkedShopifyVariants();
        log.push(`Found ${shopifyVariants.length} Shopify variants to process.`);

        // The same planning the loop below uses (pure, writes nothing), also used by the feed check.
        const planFor = (variant) => planVariant({
            variant: {
                btiPartNumber: variant.btiPartNumber.value,
                inventoryQuantity: variant.inventoryQuantity,
                inventoryPolicy: variant.inventoryPolicy,
                price: variant.price,
                compareAtPrice: variant.compareAtPrice,
                unitCostAmount: variant.inventoryItem.unitCost ? variant.inventoryItem.unitCost.amount : null,
                outOfStockAction: variant.product.outOfStockAction?.value || null,
                priceAdjustmentPct: variant.product.priceAdjustmentPercentage?.value ?? null,
            },
            btiData: btiDataMap.get(variant.btiPartNumber.value),
            isManagedByWatcher: watcherManagedSet.has(variant.id.split('/').pop()),
            btiMonitorActive: variant.btiMonitor?.value === 'true',
        });

        // FEED CHECK, before any write: a truncated or empty feed would unlink and close every part that is "missing" from it.
        const plannedUnlinks = shopifyVariants.reduce((n, v) => n + (planFor(v).deleteNumber ? 1 : 0), 0);
        const previousCount = await readPreviousCount(supabase);
        const verdict = checkFeed({ count: btiDataMap.size, previous: previousCount, plannedUnlinks, linked: shopifyVariants.length });
        if (!verdict.ok) throw new FeedCheckError(verdict.reasons);
        log.push(`Feed check passed: ${btiDataMap.size} records (previous run: ${previousCount == null ? 'none recorded' : previousCount}), ${plannedUnlinks} planned unlinks.`);
        await recordCount(supabase, btiDataMap.size);

        let updatesPerformedCount = 0;
        log.push("Processing variants sequentially to respect API rate limits...");

        let skippedIgnoreCount = 0;
        for (const variant of shopifyVariants) {
            const btiPartNumber = variant.btiPartNumber.value;
            const variantIdentifier = `${variant.product.title} - ${variant.title}`;
            const numericVariantId = variant.id.split('/').pop();
            const isManagedByWatcher = watcherManagedSet.has(numericVariantId);
            const btiMonitorActive = variant.btiMonitor?.value === 'true';
            let hasUpdateOccurred = false;

            // All decisions live in lib/plan-variant.js (pure, unit tested). This loop only performs the planned writes.
            const plan = planFor(variant);

            if (plan.skip) {
                if (!isRealPartNumber(btiPartNumber)) skippedIgnoreCount++;
                console.log(`[SKIP] ${variantIdentifier}: ${plan.skip}`);
                continue;
            }
            if (plan.notice) {
                console.log(`[NOTICE] ${variantIdentifier}: ${plan.notice}`);
                changesMade.notices.push({ name: variantIdentifier, text: plan.notice });
            }
            if (plan.deleteNumber) {
                await deleteMetafield(variant.id);
                console.log(`[UNLINK] Deleted BTI part number ${btiPartNumber} from Shopify for ${variantIdentifier}.`);
                changesMade.availability.push({ name: variantIdentifier, action: `Unlinked Discontinued BTI Part (${btiPartNumber})` });
                hasUpdateOccurred = true;
            }
            if (plan.policy) {
                await updateVariantInventoryPolicy(variant.id, plan.policy);
                if (plan.availabilityText) changesMade.availability.push({ name: variantIdentifier, action: plan.availabilityText });
                hasUpdateOccurred = true;
            }
            if (plan.pricing) {
                const currentCost = variant.inventoryItem.unitCost ? parseFloat(variant.inventoryItem.unitCost.amount).toFixed(2) : null;
                if (plan.pricing.costOnly) {
                    await updateInventoryCost(variant.inventoryItem.id, plan.pricing.cost);
                    changesMade.costOnly.push({ name: variantIdentifier, oldCost: currentCost, newCost: plan.pricing.cost });
                } else {
                    await updateVariantPricing(variant.id, plan.pricing.price, plan.pricing.compareAt, plan.pricing.cost, variant.inventoryItem.id);
                    changesMade.pricing.push({
                        name: variantIdentifier,
                        oldPrice: variant.price, newPrice: plan.pricing.price,
                        oldCompareAt: variant.compareAtPrice, newCompareAt: plan.pricing.compareAt,
                        oldCost: currentCost, newCost: plan.pricing.cost
                    });
                }
                hasUpdateOccurred = true;
            }

            if (hasUpdateOccurred) {
                updatesPerformedCount++;
                await sleep(550);
            }
        }
        if (skippedIgnoreCount > 0) log.push(`Skipped ${skippedIgnoreCount} variants whose part number is blank or IGNORE (not treated as discontinued).`);

        log.push(`All variants processed. ${updatesPerformedCount} updates were performed sequentially.`);

        const totalChanges = changesMade.availability.length + changesMade.pricing.length + changesMade.costOnly.length;
        const noticeCount = changesMade.notices.length;
        if (totalChanges > 0 || noticeCount > 0) {
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
            if (changesMade.costOnly.length > 0) { reportHtml += `<h2>Cost Updates on Watcher-Managed Items (${changesMade.costOnly.length})</h2><ul>${changesMade.costOnly.map(c => `<li><b>${c.name}</b>: cost $${c.oldCost || 'N/A'} → $${c.newCost} (price is owned by the Vendor Watcher)</li>`).join('')}</ul>`; }
            if (noticeCount > 0) { reportHtml += `<h2>Needs a Look (${noticeCount})</h2><ul>${changesMade.notices.map(n => `<li><b>${n.name}</b>: ${n.text}</li>`).join('')}</ul>`; }
            await resend.emails.send({ from: 'LoamLabs BTI Sync <info@loamlabsusa.com>', to: REPORT_EMAIL_TO, subject: `BTI Sync Report: ${totalChanges} Updates Made${noticeCount > 0 ? `, ${noticeCount} To Check` : ''}`, html: reportHtml, });
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
        if (error.feedCheck) {
            await resend.emails.send({ from: 'LoamLabs BTI Sync <info@loamlabsusa.com>', to: REPORT_EMAIL_TO, subject: 'BTI Sync STOPPED: feed looks truncated, nothing was changed', html: `<h1>BTI feed looks truncated. Nothing was changed.</h1><p>No part number was unlinked and no availability, price or cost was written, because:</p><ul>${error.reasons.map((r) => `<li>${String(r).replace(/</g, '&lt;')}</li>`).join('')}</ul><p>If the feed really is this size today, tell Backend 2 and the limits will be adjusted; otherwise the next run will try again.</p>` });
        } else
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
            btiPartNumber: metafield(namespace: "custom", key: "bti_part_number") { id, value }
            btiMonitor: metafield(namespace: "custom", key: "bti_sync_authority") { value }
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
        if (hasNextPage) {
            await sleep(1000); 
        }
    } while (hasNextPage);
    return allVariants.filter(variant => variant.btiPartNumber && variant.btiPartNumber.value);
}

// MODERNIZED FUNCTION: Uses GraphQL metafieldsDelete to unlink the part number
async function deleteMetafield(variantGid) {
    const client = new shopify.clients.Graphql({ session: getSession() });
    const mutation = `
        mutation metafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
            metafieldsDelete(metafields: $metafields) {
                deletedMetafields {
                    key
                    namespace
                    ownerId
                }
                userErrors {
                    field
                    message
                }
            }
        }
    `;
    const variables = {
        metafields: [
            {
                ownerId: variantGid,
                namespace: "custom",
                key: "bti_part_number"
            }
        ]
    };
    await client.request(mutation, { variables });
}

async function updateVariantInventoryPolicy(variantGid, policy) {
    const client = new shopify.clients.Rest({ session: getSession() });
    const numericVariantId = variantGid.split('/').pop();
    await client.put({
        path: `variants/${numericVariantId}.json`,
        data: { variant: { id: numericVariantId, inventory_policy: policy.toLowerCase() } }
    });
}

async function updateInventoryCost(inventoryItemGid, cost) {
    const client = new shopify.clients.Rest({ session: getSession() });
    const numericInventoryItemId = inventoryItemGid.split('/').pop();
    await client.put({
        path: `inventory_items/${numericInventoryItemId}.json`,
        data: { inventory_item: { id: numericInventoryItemId, cost: cost } }
    });
}

async function updateVariantPricing(variantGid, price, compareAtPrice, cost, inventoryItemId) {
    const client = new shopify.clients.Rest({ session: getSession() });
    const numericVariantId = variantGid.split('/').pop();
    const numericInventoryItemId = inventoryItemId ? inventoryItemId.split('/').pop() : null;

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
