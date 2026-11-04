// lib/auth.js
// Decides whether a request may start the BTI sync. PURE: no network, nothing logged here, the secret is never returned.
//
// Accepted proofs (both are the value of the CRON_SECRET env var):
//   Authorization: Bearer <secret>   (Vercel cron sends this by itself when the project has CRON_SECRET)
//   x-loam-secret: <secret>          (a deliberate manual run)
//
// ENFORCE is the phase switch. Phase 1 (false): every call is allowed, the result only says what WOULD have happened.
// Phase 2 (true): wrong or missing secret -> 401, no secret configured on the server -> 503. Both are decided before any work.
const crypto = require('crypto');

const ENFORCE = true;

const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
// Constant time and safe for strings of different lengths (compares fixed-size digests).
const sameSecret = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

function presentedSecret(headers) {
    const h = headers || {};
    const bearer = typeof h.authorization === 'string' && /^Bearer\s+/i.test(h.authorization) ? h.authorization.replace(/^Bearer\s+/i, '').trim() : '';
    const custom = typeof h['x-loam-secret'] === 'string' ? h['x-loam-secret'].trim() : '';
    return bearer || custom;
}

/**
 * @param {{ headers: object, secret: string|undefined, enforce?: boolean }} p
 * @returns {{ allowed: boolean, status: 200|401|503, ok: boolean, reason: string }}
 *   ok = the secret was correct. reason is a short code safe to log.
 */
function checkAuth({ headers, secret, enforce = ENFORCE }) {
    const configured = typeof secret === 'string' && secret.trim() !== '';
    let ok = false, reason;
    if (!configured) reason = 'no-secret-configured';
    else {
        const sent = presentedSecret(headers);
        if (!sent) reason = 'no-secret-sent';
        else if (sameSecret(sent, secret.trim())) { ok = true; reason = 'secret-ok'; }
        else reason = 'wrong-secret';
    }
    if (!enforce) return { allowed: true, status: 200, ok, reason };
    if (!configured) return { allowed: false, status: 503, ok, reason };
    return ok ? { allowed: true, status: 200, ok, reason } : { allowed: false, status: 401, ok, reason };
}

module.exports = { checkAuth, ENFORCE };
