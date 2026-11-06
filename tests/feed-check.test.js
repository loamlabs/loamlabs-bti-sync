// Run with: npm test   (no network)
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkFeed, FeedCheckError, readPreviousCount, recordCount, unlinkCap } = require('../lib/feed-check');

test('a normal day passes: same size feed, a handful of unlinks', () => {
    assert.deepEqual(checkFeed({ count: 52000, previous: 52100, plannedUnlinks: 3, linked: 900 }), { ok: true, reasons: [] });
    assert.equal(checkFeed({ count: 52000, previous: null, plannedUnlinks: 0, linked: 900 }).ok, true);      // first run: no baseline, only the other checks
});

test('an empty feed stops the run', () => {
    const r = checkFeed({ count: 0, previous: 52000, plannedUnlinks: 900, linked: 900 });
    assert.equal(r.ok, false); assert.match(r.reasons[0], /no records/);
});

test('a feed under 80% of the previous run stops it; exactly 80% passes', () => {
    assert.equal(checkFeed({ count: 41599, previous: 52000, plannedUnlinks: 0, linked: 900 }).ok, false);
    assert.equal(checkFeed({ count: 41600, previous: 52000, plannedUnlinks: 0, linked: 900 }).ok, true);
    assert.match(checkFeed({ count: 100, previous: 52000, plannedUnlinks: 0, linked: 900 }).reasons[0], /previous run had 52000/);
});

test('too many unlinks stop it: more than max(20, 2% of linked)', () => {
    assert.equal(unlinkCap(900), 20); assert.equal(unlinkCap(5000), 100); assert.equal(unlinkCap(0), 20);
    assert.equal(checkFeed({ count: 52000, previous: 52000, plannedUnlinks: 20, linked: 900 }).ok, true);
    const r = checkFeed({ count: 52000, previous: 52000, plannedUnlinks: 21, linked: 900 });
    assert.equal(r.ok, false); assert.match(r.reasons[0], /unlink 21 parts \(limit 20 for 900/);
});

test('the error carries a clear message and the reasons', () => {
    const e = new FeedCheckError(['the feed has no records']);
    assert.equal(e.feedCheck, true); assert.match(e.message, /^BTI feed looks truncated, nothing changed: the feed has no records$/); assert.ok(e instanceof Error);
});

test('previous count: read from the newest bti_feed row; unreadable or missing means no baseline; recording never throws', async () => {
    const mk = (data, error = null) => ({ from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data, error }) }) }) }) }) });
    assert.equal(await readPreviousCount(mk([{ message: 'records=51234' }])), 51234);
    assert.equal(await readPreviousCount(mk([])), null); assert.equal(await readPreviousCount(mk(null, { message: 'x' })), null); assert.equal(await readPreviousCount(mk([{ message: 'junk' }])), null);
    assert.equal(await readPreviousCount({ from: () => { throw new Error('down'); } }), null);
    let row = null; await recordCount({ from: (t) => ({ insert: async (r) => { row = [t, r[0]]; } }) }, 777); assert.deepEqual(row, ['sync_logs', { status: 'bti_feed', message: 'records=777' }]);
    await recordCount({ from: () => { throw new Error('down'); } }, 1);
});
