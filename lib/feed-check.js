// lib/feed-check.js
// Is BTI's feed believable? Decided BEFORE any unlink or DENY is written. A part missing from the feed counts as discontinued (its number is deleted and it is set to DENY),
// so a feed that arrives truncated or empty but still readable would unlink and close everything. Pure apart from the two small database helpers.
//   stop when the feed is empty,
//   or has fewer than 80% of the records of the previous accepted run,
//   or the run would unlink more than max(20, 2% of the linked variants) parts (real days unlink a handful of discontinued parts).
const MIN_RATIO = 0.8;
const UNLINK_MIN_CAP = 20;
const UNLINK_RATIO = 0.02;
const STATUS = 'bti_feed';   // row in the existing sync_logs table: message "records=1234"

const unlinkCap = (linked) => Math.max(UNLINK_MIN_CAP, Math.ceil((linked || 0) * UNLINK_RATIO));

/** @returns {{ok:boolean, reasons:string[]}} */
function checkFeed({ count, previous, plannedUnlinks, linked }) {
    const reasons = [];
    if (!count) reasons.push('the feed has no records');
    if (previous > 0 && count > 0 && count < previous * MIN_RATIO) reasons.push(`the feed has ${count} records, the previous run had ${previous} (less than ${Math.round(MIN_RATIO * 100)}%)`);
    const cap = unlinkCap(linked);
    if (plannedUnlinks > cap) reasons.push(`this run would unlink ${plannedUnlinks} parts (limit ${cap} for ${linked} linked variants)`);
    return { ok: reasons.length === 0, reasons };
}

class FeedCheckError extends Error {
    constructor(reasons) {
        super(`BTI feed looks truncated, nothing changed: ${reasons.join('; ')}`);
        this.name = 'FeedCheckError'; this.feedCheck = true; this.reasons = reasons;
    }
}

/** The record count of the last run that passed the check; null when there is none or the table cannot be read (then only the other two checks apply). */
async function readPreviousCount(supabase) {
    try {
        const { data, error } = await supabase.from('sync_logs').select('message').eq('status', STATUS).order('created_at', { ascending: false }).limit(1);
        if (error || !data || !data.length) return null;
        const m = /records=(\d+)/.exec(String(data[0].message || ''));
        return m ? Number(m[1]) : null;
    } catch (e) { return null; }
}

async function recordCount(supabase, count) {
    try { await supabase.from('sync_logs').insert([{ status: STATUS, message: `records=${count}` }]); } catch (e) { /* a missing log row only means the next run has no baseline */ }
}

module.exports = { checkFeed, FeedCheckError, readPreviousCount, recordCount, unlinkCap, MIN_RATIO, UNLINK_MIN_CAP, UNLINK_RATIO, STATUS };
