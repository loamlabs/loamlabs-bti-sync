// Run with: npm test   (node --test, no extra dependencies)
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchWatcherManagedSet, PAGE_SIZE } = require('../lib/watcher-managed');
const { planVariant } = require('../lib/plan-variant');

// Fake supabase client that behaves like the real one: a request returns at most 1,000 rows, whatever range is asked for.
function fakeSupabase(rules, { failOnPage = null } = {}) {
    const calls = [];
    const client = {
        calls,
        from(table) {
            assert.equal(table, 'watcher_rules');
            const q = { filters: [], order: null, range: null };
            const b = {
                select() { return b; },
                not(col, op, val) { q.filters.push([col, op, val]); return b; },
                order(col) { q.order = col; return b; },
                range(a, z) { q.range = [a, z]; return b; },
                then(resolve) {
                    calls.push(q.range);
                    if (failOnPage !== null && calls.length === failOnPage) return resolve({ data: null, error: { message: 'boom' } });
                    let rows = rules.filter((r) => r.vendor_url !== null);
                    if (q.order) rows = [...rows].sort((x, y) => (x[q.order] < y[q.order] ? -1 : 1));
                    const [a, z] = q.range || [0, 999];
                    resolve({ data: rows.slice(a, Math.min(z, a + 999) + 1), error: null });
                },
            };
            return b;
        },
    };
    return client;
}
const rule = (i, over) => ({ id: 'r' + String(i).padStart(6, '0'), shopify_variant_id: 9000000 + i, vendor_url: 'https://v.example/p', ...over });

test('reads all rules when there are more than 1,000 (5,745 like production)', async () => {
    const rules = Array.from({ length: 5745 }, (_, i) => rule(i));
    const set = await fetchWatcherManagedSet(fakeSupabase(rules));
    assert.equal(set.size, 5745);
    assert.ok(set.has('9005744') && set.has('9000000'));
});
test('exact multiple of the page size ends cleanly (one extra empty page)', async () => {
    const sb = fakeSupabase(Array.from({ length: 2000 }, (_, i) => rule(i)));
    const set = await fetchWatcherManagedSet(sb);
    assert.equal(set.size, 2000);
    assert.equal(sb.calls.length, 3);
});
test('rules without a vendor_url are not in the set', async () => {
    const rules = [rule(1), rule(2, { vendor_url: null }), rule(3)];
    const set = await fetchWatcherManagedSet(fakeSupabase(rules));
    assert.deepEqual([...set].sort(), ['9000001', '9000003']);
});
test('a failed page throws instead of returning a partial list', async () => {
    const rules = Array.from({ length: 2500 }, (_, i) => rule(i));
    await assert.rejects(() => fetchWatcherManagedSet(fakeSupabase(rules, { failOnPage: 2 })), /Could not read the Watcher rules/);
});
test('page size is not above the server cap', () => assert.ok(PAGE_SIZE <= 1000));

test('Watcher-owned OneUp variant beyond row 1,000 is skipped for price AND inventory', async () => {
    const rules = Array.from({ length: 1500 }, (_, i) => rule(i));
    const beyond = rules[1400]; // row 1,401: the old plain select never saw it
    const oldSet = new Set(rules.slice(0, 1000).map((r) => String(r.shopify_variant_id)));
    const set = await fetchWatcherManagedSet(fakeSupabase(rules));
    const input = (managed) => ({
        variant: { btiPartNumber: 'OU3040', inventoryQuantity: 0, inventoryPolicy: 'CONTINUE', price: '219.99', compareAtPrice: '323.65', unitCostAmount: '150.00', outOfStockAction: null, priceAdjustmentPct: null },
        btiData: { available: 0, cost: 155.99, msrp: 219.99 }, isManagedByWatcher: managed, btiMonitorActive: false,
    });
    const id = String(beyond.shopify_variant_id);
    // before the fix: not in the list, BTI rewrites price (217.79) and could flip the policy
    const before = planVariant(input(oldSet.has(id)));
    assert.equal(oldSet.has(id), false);
    assert.equal(before.pricing && before.pricing.price, '217.79');
    // after the fix: in the list, BTI does nothing at all (flag is not true)
    const after = planVariant(input(set.has(id)));
    assert.equal(set.has(id), true);
    assert.ok(after.skip);
    assert.equal(after.pricing, null);
    assert.equal(after.policy, null);
    assert.equal(after.deleteNumber, false);
});
test('BTI-owned (flag true) managed variant still gets cost only, never price', () => {
    const p = planVariant({
        variant: { btiPartNumber: 'OU3000', inventoryQuantity: 0, inventoryPolicy: 'CONTINUE', price: '99.99', compareAtPrice: '148.65', unitCostAmount: '60.00', outOfStockAction: null, priceAdjustmentPct: null },
        btiData: { available: 0, cost: 70.99, msrp: 99.99 }, isManagedByWatcher: true, btiMonitorActive: true,
    });
    assert.equal(p.skip, null);
    assert.equal(p.pricing.costOnly, true);
    assert.equal(p.pricing.price, null);
});
