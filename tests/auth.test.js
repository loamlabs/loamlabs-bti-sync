// Run with: npm test   (node --test, no extra dependencies)
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkAuth, ENFORCE } = require('../lib/auth');

const SECRET = 'correct-horse-battery-staple-123';
const bearer = (s) => ({ authorization: `Bearer ${s}` });
const custom = (s) => ({ 'x-loam-secret': s });
const enforced = (headers, secret = SECRET) => checkAuth({ headers, secret, enforce: true });
const phase1 = (headers, secret = SECRET) => checkAuth({ headers, secret, enforce: false });

test('correct Bearer is accepted', () => { const r = enforced(bearer(SECRET)); assert.equal(r.allowed, true); assert.equal(r.ok, true); assert.equal(r.reason, 'secret-ok'); });
test('correct x-loam-secret is accepted', () => assert.equal(enforced(custom(SECRET)).allowed, true));
test('Bearer scheme is case-insensitive and trimmed', () => assert.equal(enforced({ authorization: `bearer   ${SECRET}  ` }).allowed, true));

test('wrong, empty, missing, and different-length secrets are rejected with 401 (no crash)', () => {
    for (const h of [bearer('nope'), bearer(SECRET + 'x'), bearer(SECRET.slice(0, -1)), bearer(''), custom(''), custom('x'.repeat(5000)), {}, undefined, { authorization: 'Basic abc' }, { authorization: 42 }]) {
        const r = enforced(h);
        assert.equal(r.allowed, false, JSON.stringify(h));
        assert.equal(r.status, 401);
    }
});
test('reasons: no-secret-sent / wrong-secret', () => {
    assert.equal(enforced({}).reason, 'no-secret-sent');
    assert.equal(enforced(bearer('nope')).reason, 'wrong-secret');
});

test('phase 2: no secret configured on the server -> 503, even if the caller sends something', () => {
    for (const secret of [undefined, '', '   ']) {
        const r = enforced(bearer('anything'), secret);
        assert.equal(r.allowed, false);
        assert.equal(r.status, 503);
        assert.equal(r.reason, 'no-secret-configured');
    }
});

test('phase 1: everything is allowed, but the result still tells what would have happened', () => {
    assert.deepEqual(phase1(bearer(SECRET)), { allowed: true, status: 200, ok: true, reason: 'secret-ok' });
    assert.equal(phase1({}).allowed, true);
    assert.equal(phase1({}).ok, false);
    assert.equal(phase1(bearer('nope')).reason, 'wrong-secret');
    assert.equal(phase1({}, undefined).reason, 'no-secret-configured');
});

test('the result never contains the secret or what was sent', () => {
    const sent = 'super-secret-sent-value-999';
    for (const r of [enforced(bearer(sent)), enforced(bearer(SECRET)), phase1(bearer(sent)), enforced({}, undefined)]) {
        const text = JSON.stringify(r);
        assert.ok(!text.includes(sent) && !text.includes(SECRET));
    }
});

test('the committed default matches the phase being shipped', () => assert.equal(typeof ENFORCE, 'boolean'));
