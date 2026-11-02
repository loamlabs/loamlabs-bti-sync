// Run with: npm test   (node --test, no extra dependencies)
const test = require('node:test');
const assert = require('node:assert/strict');
const { planVariant, isRealPartNumber } = require('../lib/plan-variant');

const variant = (over) => ({
    btiPartNumber: 'OU3000', inventoryQuantity: 0, inventoryPolicy: 'DENY', price: '115.82', compareAtPrice: '115.82',
    unitCostAmount: '70.00', outOfStockAction: null, priceAdjustmentPct: null, ...over
});
const feed = { available: 7, cost: 70, msrp: 116.99 };
const plan = (over) => planVariant({ variant: variant(), btiData: feed, isManagedByWatcher: false, btiMonitorActive: false, ...over });

test('isRealPartNumber', () => {
    assert.equal(isRealPartNumber('OU3000'), true);
    for (const v of [null, undefined, '', '  ', 'IGNORE', 'ignore', ' Ignore ']) assert.equal(isRealPartNumber(v), false, String(v));
});

// ---- (a) IGNORE / blank
test('(a) IGNORE is skipped, never discontinued: no delete, no policy, no price (the Oct 31 email case)', () => {
    for (const managed of [true, false]) for (const flag of [true, false]) {
        const p = plan({ variant: variant({ btiPartNumber: 'IGNORE', inventoryPolicy: 'CONTINUE' }), btiData: undefined, isManagedByWatcher: managed, btiMonitorActive: flag });
        assert.ok(p.skip, `managed=${managed} flag=${flag}`);
        assert.equal(p.deleteNumber, false);
        assert.equal(p.policy, null);
        assert.equal(p.pricing, null);
    }
});
test('(a) blank number is skipped', () => {
    assert.ok(plan({ variant: variant({ btiPartNumber: '' }), btiData: undefined }).skip);
});

// ---- watcher authority
test('watcher-managed variant with flag false is skipped completely', () => {
    const p = plan({ isManagedByWatcher: true, btiMonitorActive: false });
    assert.ok(p.skip);
    assert.equal(p.policy, null);
    assert.equal(p.pricing, null);
});

// ---- (b) never delete the number of a watcher-managed variant
test('(b) watcher-managed + flag true + part missing from feed: number kept, notice, policy DENY when it was CONTINUE', () => {
    const p = plan({ variant: variant({ inventoryPolicy: 'CONTINUE' }), btiData: undefined, isManagedByWatcher: true, btiMonitorActive: true });
    assert.equal(p.skip, null);
    assert.equal(p.deleteNumber, false);
    assert.match(p.notice, /not in BTI's feed/);
    assert.equal(p.policy, 'DENY');
    assert.equal(p.availabilityText, 'Made Unavailable (Missing from BTI feed)');
    assert.equal(p.pricing, null);
});
test('(b) a part missing from the feed on a NON-managed variant is still unlinked (old behaviour)', () => {
    const p = plan({ variant: variant({ inventoryPolicy: 'CONTINUE' }), btiData: undefined });
    assert.equal(p.deleteNumber, true);
    assert.equal(p.policy, 'DENY');
    assert.equal(p.availabilityText, null);   // reported as the unlink line only
    assert.equal(p.notice, null);
    assert.equal(p.pricing, null);
});

// ---- (c) price and compare-at
test('(c) watcher-managed + flag true: never a price or compare-at, cost only when it changed', () => {
    const changed = plan({ isManagedByWatcher: true, btiMonitorActive: true, variant: variant({ unitCostAmount: '60.00' }) });
    assert.deepEqual(changed.pricing, { price: null, compareAt: null, cost: '70.00', costOnly: true });
    const same = plan({ isManagedByWatcher: true, btiMonitorActive: true });
    assert.equal(same.pricing, null);
});

// ---- (d) policy handling for flag true
test('(d) flag true: BTI in stock and policy DENY -> CONTINUE', () => {
    const p = plan({ isManagedByWatcher: true, btiMonitorActive: true });
    assert.equal(p.policy, 'CONTINUE');
    assert.equal(p.availabilityText, 'Made Available');
});
test('(d) flag true: BTI and Shopify both 0 and policy CONTINUE -> DENY', () => {
    const p = plan({ isManagedByWatcher: true, btiMonitorActive: true, btiData: { available: 0, cost: 70, msrp: 116.99 }, variant: variant({ inventoryPolicy: 'CONTINUE' }) });
    assert.equal(p.policy, 'DENY');
    assert.equal(p.availabilityText, 'Made Unavailable');
});
test('local Shopify stock keeps the item available even when BTI has none', () => {
    const p = plan({ btiData: { available: 0, cost: 70, msrp: 116.99 }, variant: variant({ inventoryQuantity: 3, inventoryPolicy: 'CONTINUE' }) });
    assert.equal(p.policy, null);
});
test('out_of_stock_action other than Make Unavailable: policy untouched', () => {
    const p = plan({ variant: variant({ outOfStockAction: 'Continue Selling' }) });
    assert.equal(p.policy, null);
});

// ---- unchanged behaviour for BTI-only (non-managed) variants
test('non-managed: price is BTI MSRP x 0.99 (OneUp 116.99 -> 115.82)', () => {
    const p = plan({ variant: variant({ price: '100.00', compareAtPrice: '100.00' }) });
    assert.equal(p.pricing.price, '115.82');
    assert.equal(p.pricing.compareAt, '116.99');
    assert.equal(p.pricing.costOnly, false);
});
test('non-managed: price_adjustment_percentage is honoured, sale gap is kept', () => {
    const pct = plan({ variant: variant({ price: '1.00', compareAtPrice: '1.00', priceAdjustmentPct: '10' }) });
    assert.equal(pct.pricing.price, '128.69');
    assert.equal(pct.pricing.compareAt, '128.69');
    const gap = plan({ variant: variant({ price: '100.00', compareAtPrice: '110.00' }) });
    assert.equal(gap.pricing.price, '115.82');
    assert.equal(gap.pricing.compareAt, '125.82');
});
test('non-managed: nothing to do when everything already matches', () => {
    const p = plan({ variant: variant({ price: '115.82', compareAtPrice: '116.99', inventoryPolicy: 'CONTINUE' }) });
    assert.equal(p.policy, null);
    assert.equal(p.pricing, null);
});
test('no price update when BTI has no msrp or cost', () => {
    assert.equal(plan({ btiData: { available: 7, cost: 0, msrp: 0 } }).pricing, null);
});
