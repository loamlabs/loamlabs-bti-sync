// lib/watcher-managed.js
// Reads EVERY variant id that has a Vendor Watcher rule with a vendor_url.
// Supabase returns at most 1,000 rows per request, so a plain select silently drops the rest (5,745 rules at the time of writing).
// This pages with a stable order until a short page comes back, and throws on any error instead of returning a partial list:
// a partial guard list would let BTI overwrite Watcher-owned prices.

const PAGE_SIZE = 1000;

/**
 * @param {object} supabase  a supabase-js client (or a fake with the same from/select/not/order/range chain)
 * @param {number} pageSize  rows per request (must not exceed the server cap)
 * @returns {Promise<Set<string>>} variant ids as strings
 */
async function fetchWatcherManagedSet(supabase, pageSize = PAGE_SIZE) {
    const ids = new Set();
    for (let from = 0; ; from += pageSize) {
        const { data, error } = await supabase
            .from('watcher_rules')
            .select('id, shopify_variant_id')
            .not('vendor_url', 'is', null)
            .order('id', { ascending: true })
            .range(from, from + pageSize - 1);
        if (error) throw new Error(`Could not read the Watcher rules (${error.message}). Stopping so no Watcher-owned variant is touched.`);
        const rows = data || [];
        for (const r of rows) if (r.shopify_variant_id !== null && r.shopify_variant_id !== undefined) ids.add(String(r.shopify_variant_id));
        if (rows.length < pageSize) break;
    }
    return ids;
}

module.exports = { fetchWatcherManagedSet, PAGE_SIZE };
