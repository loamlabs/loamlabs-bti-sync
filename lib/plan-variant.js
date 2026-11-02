// lib/plan-variant.js
// Decides what the BTI sync should do with ONE Shopify variant. PURE: no network, no Shopify, no Supabase.
// api/index.js calls this and then performs the planned writes.
//
// Guards added for the Vendor Watcher / BTI one-owner work:
//   (a) "IGNORE" (the Watcher's old marker) and blank are never real BTI part numbers: such a variant is skipped, never treated as discontinued.
//   (b) the part number of a variant that has a watcher rule is never deleted; a part missing from the feed is only reported.
//   (c) price and compare-at are never written on a variant that has a watcher rule (the Watcher owns the price). Cost still is.
//   (d) a watcher-managed variant is only touched at all when custom.bti_sync_authority is true (BTI owns inventory): policy and cost as before.

const isRealPartNumber = (value) => {
    if (value === null || value === undefined) return false;
    const v = String(value).trim();
    return v !== '' && v.toUpperCase() !== 'IGNORE';
};

/**
 * @param {object} p
 * @param {object} p.variant  { btiPartNumber, inventoryQuantity, inventoryPolicy ('CONTINUE'|'DENY'), price, compareAtPrice, unitCostAmount,
 *                              outOfStockAction, priceAdjustmentPct }  (strings as Shopify returns them; null when missing)
 * @param {object|undefined} p.btiData  { available, cost, msrp } from the BTI feed, undefined when the part is not in the feed
 * @param {boolean} p.isManagedByWatcher  the variant has a watcher rule with a vendor_url
 * @param {boolean} p.btiMonitorActive    custom.bti_sync_authority === 'true'
 * @returns {{
 *   skip: string|null,            // reason BTI does nothing with this variant
 *   notice: string|null,          // something to tell Jerry in the report (no write needed)
 *   deleteNumber: boolean,        // delete custom.bti_part_number (only ever for variants WITHOUT a watcher rule)
 *   policy: 'DENY'|'CONTINUE'|null,
 *   availabilityText: string|null,
 *   pricing: null | { price: string|null, compareAt: string|null, cost: string, costOnly: boolean }
 * }}
 */
function planVariant({ variant, btiData, isManagedByWatcher, btiMonitorActive }) {
    const plan = { skip: null, notice: null, deleteNumber: false, policy: null, availabilityText: null, pricing: null };
    const v = variant || {};

    // (a) not a real number: nothing to match against BTI's feed
    if (!isRealPartNumber(v.btiPartNumber)) { plan.skip = 'part number is blank or IGNORE (not a BTI number)'; return plan; }

    // (d) the Watcher owns every watcher-managed variant unless it handed inventory to BTI
    if (isManagedByWatcher && !btiMonitorActive) { plan.skip = 'authority yielded to Vendor Watcher'; return plan; }

    const missing = !btiData;
    const data = missing ? { available: 0, cost: 0, msrp: 0 } : btiData;
    const forceDeny = missing;                       // a part that is not in the feed counts as discontinued

    // (b) only variants without a watcher rule are unlinked; a watcher-managed one keeps its number and is reported
    if (forceDeny && !isManagedByWatcher) plan.deleteNumber = true;
    if (forceDeny && isManagedByWatcher) plan.notice = `BTI part ${v.btiPartNumber} is not in BTI's feed. The number was kept (this variant has a watcher rule).`;

    // availability (unchanged rules)
    const shopifyStock = v.inventoryQuantity;
    const isTrulyOutOfStock = shopifyStock <= 0 && data.available <= 0;
    const isCurrentlyContinue = v.inventoryPolicy === 'CONTINUE';
    if (v.outOfStockAction === 'Make Unavailable (Track Inventory)' || !v.outOfStockAction) {
        if ((isTrulyOutOfStock || forceDeny) && isCurrentlyContinue) {
            plan.policy = 'DENY';
            // the unlink is reported on its own line; only report the policy change when there was no unlink
            plan.availabilityText = plan.deleteNumber ? null : (forceDeny ? 'Made Unavailable (Missing from BTI feed)' : 'Made Unavailable');
        } else if (!isTrulyOutOfStock && !isCurrentlyContinue && !forceDeny) {
            plan.policy = 'CONTINUE';
            plan.availabilityText = 'Made Available';
        }
    }

    // pricing
    if (data.msrp > 0 && data.cost > 0) {
        const newCost = data.cost.toFixed(2);
        const currentCost = v.unitCostAmount != null ? parseFloat(v.unitCostAmount).toFixed(2) : null;
        if (isManagedByWatcher) {
            // (c) cost only; price and compare-at belong to the Watcher
            if (newCost !== currentCost) plan.pricing = { price: null, compareAt: null, cost: newCost, costOnly: true };
        } else {
            let newPrice, newCompareAt;
            const pct = v.priceAdjustmentPct;
            if (pct != null) newPrice = (data.msrp * (1 + parseInt(pct, 10) / 100)).toFixed(2);
            else newPrice = (data.msrp * 0.99).toFixed(2);
            const currentPrice = parseFloat(v.price);
            const currentCompare = v.compareAtPrice ? parseFloat(v.compareAtPrice) : 0;
            if (currentCompare > currentPrice) newCompareAt = (parseFloat(newPrice) + (currentCompare - currentPrice)).toFixed(2);
            else newCompareAt = (pct != null) ? newPrice : data.msrp.toFixed(2);
            if (newPrice !== v.price || newCompareAt !== v.compareAtPrice || newCost !== currentCost) {
                plan.pricing = { price: newPrice, compareAt: newCompareAt, cost: newCost, costOnly: false };
            }
        }
    }
    return plan;
}

module.exports = { planVariant, isRealPartNumber };
