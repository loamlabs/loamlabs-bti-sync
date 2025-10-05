// A simple helper function to pause execution
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
            if (variant.product.outOfStockAction?.value === 'Make Unavailable (Track Inventory)' || !variant.product.outOfStockAction?.value) {
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
