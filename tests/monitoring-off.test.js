// custom.inventory_monitoring_enabled = false (product or variant) switches the BTI scan off for that variant.
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { planVariant, isMonitoringOff } = require('../lib/plan-variant');

const variant = (over) => ({
    btiPartNumber: 'SP8115', inventoryQuantity: 0, inventoryPolicy: 'CONTINUE', price: '113.84', compareAtPrice: '114.99',
    unitCostAmount: '60.00', outOfStockAction: null, priceAdjustmentPct: null, ...over
});
const feed = { available: 7, cost: 70, msrp: 116.99 };
// the same mapping api/index.js uses
const planWith = ({ productFlag, variantFlag, btiData = feed, managed = false, authority = false, v = variant() }) =>
    planVariant({ variant: v, btiData, isManagedByWatcher: managed, btiMonitorActive: authority, monitoringOff: isMonitoringOff(productFlag, variantFlag) });

const NOTHING = { skip: null, deleteNumber: false, policy: null, pricing: null };
const assertUntouched = (p) => {
    assert.ok(p.skip, 'skipped');
    assert.equal(p.deleteNumber, false);
    assert.equal(p.policy, null);
    assert.equal(p.pricing, null);
    assert.equal(p.availabilityText, null);
};

test('isMonitoringOff: only the word false (any case, spaces) turns it off, on either level', () => {
    for (const v of ['false', 'FALSE', ' False ']) { assert.equal(isMonitoringOff(v, undefined), true, v); assert.equal(isMonitoringOff(undefined, v), true, v); }
    for (const v of [undefined, null, '', 'true', 'TRUE', '0', 'no', 'off']) assert.equal(isMonitoringOff(v, v), false, String(v));
    assert.equal(isMonitoringOff('true', 'false'), true);
    assert.equal(isMonitoringOff('false', 'true'), true);
});

test('flag false at PRODUCT level: no price, no policy, no unlink, number kept', () => {
    assertUntouched(planWith({ productFlag: 'false' }));
});
test('flag false at VARIANT level: no price, no policy, no unlink, number kept', () => {
    assertUntouched(planWith({ variantFlag: 'false' }));
});
test('flag false and the part is MISSING from the feed: number kept, no DENY, no unlink', () => {
    for (const where of [{ productFlag: 'false' }, { variantFlag: 'false' }]) assertUntouched(planWith({ ...where, btiData: null }));
});
test('flag false, feed has the part with stock and a new price: still nothing written', () => {
    assertUntouched(planWith({ productFlag: 'false', v: variant({ inventoryPolicy: 'DENY', price: '99.00', compareAtPrice: '99.00' }) }));
});

test('flag ABSENT: behaviour unchanged (price written, policy follows stock)', () => {
    const p = planWith({});
    assert.equal(p.skip, null);
    assert.equal(p.pricing.price, '115.82');   // msrp x 0.99
    assert.equal(p.pricing.costOnly, false);
});
test('flag TRUE: behaviour unchanged', () => {
    const p = planWith({ productFlag: 'true', variantFlag: 'true' });
    assert.equal(p.skip, null);
    assert.equal(p.pricing.price, '115.82');
});
test('flag absent and part missing from the feed on an unmanaged variant: still unlinked and denied (old behaviour)', () => {
    const p = planWith({ btiData: null });
    assert.equal(p.deleteNumber, true);
    assert.equal(p.policy, 'DENY');
});

test('existing Watcher-managed rules unchanged when the flag is absent or true', () => {
    // managed, authority yielded: skipped (as before)
    assert.equal(planWith({ managed: true, authority: false }).skip, 'authority yielded to Vendor Watcher');
    // managed, BTI owns inventory, part missing: number kept, notice, DENY (as before)
    const miss = planWith({ managed: true, authority: true, btiData: null });
    assert.equal(miss.skip, null);
    assert.equal(miss.deleteNumber, false);
    assert.match(miss.notice, /not in BTI's feed/);
    assert.equal(miss.policy, 'DENY');
    // managed, BTI owns inventory, cost differs: cost only (as before)
    const cost = planWith({ managed: true, authority: true, productFlag: 'true' });
    assert.deepEqual(cost.pricing, { price: null, compareAt: null, cost: '70.00', costOnly: true });
});
test('a managed variant with the flag false is also left alone', () => {
    assertUntouched(planWith({ managed: true, authority: true, productFlag: 'false', btiData: null }));
});

test('a blank or IGNORE number is still skipped for its own reason (rule (a) comes first)', () => {
    const p = planWith({ productFlag: 'false', v: variant({ btiPartNumber: 'IGNORE' }) });
    assert.match(p.skip, /blank or IGNORE/);
});

test('the sync entry point reads the flag from product and variant and passes it to the planner', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'index.js'), 'utf8');
    assert.match(src, /monitoringVar: metafield\(namespace: "custom", key: "inventory_monitoring_enabled"\)/);
    assert.match(src, /monitoringProd: metafield\(namespace: "custom", key: "inventory_monitoring_enabled"\)/);
    assert.match(src, /monitoringOff: isMonitoringOff\(variant\.product\.monitoringProd\?\.value, variant\.monitoringVar\?\.value\)/);
});
test('a flagged variant adds no planned unlink for the feed check (it is skipped before the unlink rule)', () => {
    const missing = planWith({ productFlag: 'false', btiData: null });
    assert.equal(missing.deleteNumber, false);
});
