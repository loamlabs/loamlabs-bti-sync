// Phase 2 only: the handler must reject BEFORE any outside call. Everything outside is a trap that fails the test if touched.
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
    SHOPIFY_STORE_DOMAIN: 'https://example.myshopify.com', SHOPIFY_ADMIN_API_TOKEN: 'x', BTI_USERNAME: 'u', BTI_PASSWORD: 'p',
    RESEND_API_KEY: 're_x', REPORT_EMAIL_TO: 'a@example.com', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k',
});
let outsideCalls = 0;
global.fetch = async () => { outsideCalls++; throw new Error('network must not be touched when rejected'); };
const handler = require('../api/index');

const run = async (headers) => {
    const out = { code: null, body: null };
    const res = { status(c) { out.code = c; return res; }, json(b) { out.body = b; return res; }, send(b) { out.body = b; return res; } };
    await handler({ headers }, res);
    return out;
};
const logs = [];
const origLog = console.log; console.log = (...a) => { logs.push(a.join(' ')); };
test.after(() => { console.log = origLog; });

test('secret configured, none sent -> 401, no outside call, nothing secret in the log', async () => {
    process.env.CRON_SECRET = 'a-very-secret-value-for-test';
    const r = await run({});
    assert.equal(r.code, 401);
    assert.deepEqual(r.body, { error: 'Unauthorized' });
    assert.equal(outsideCalls, 0);
    assert.ok(logs.some((l) => l.includes('[AUTH] rejected: no-secret-sent')));
    assert.ok(!logs.join('\n').includes('a-very-secret-value-for-test'));
});
test('wrong secret -> 401, no outside call, the wrong value is not logged', async () => {
    process.env.CRON_SECRET = 'a-very-secret-value-for-test';
    const r = await run({ authorization: 'Bearer totally-wrong-guess' });
    assert.equal(r.code, 401);
    assert.equal(outsideCalls, 0);
    assert.ok(!logs.join('\n').includes('totally-wrong-guess'));
});
test('no CRON_SECRET on the server -> 503 NOT_CONFIGURED, no outside call', async () => {
    delete process.env.CRON_SECRET;
    const r = await run({ authorization: 'Bearer anything' });
    assert.equal(r.code, 503);
    assert.deepEqual(r.body, { error: 'NOT_CONFIGURED' });
    assert.equal(outsideCalls, 0);
});
test('correct secret gets past the lock (the trap then stops it at the first outside call)', async () => {
    process.env.CRON_SECRET = 'a-very-secret-value-for-test';
    await run({ authorization: 'Bearer a-very-secret-value-for-test' }).catch(() => {});
    assert.ok(outsideCalls >= 1, 'the sync started its first outside call');
});
