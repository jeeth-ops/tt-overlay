// ================================================================
// 🔁 RETRY QUEUE STORE — the on-disk record of clips that are cut and
// safe on this PC but have not yet been handed to server.js.
//
// This is THE file that has to survive a crash, a restart, or the
// operator closing the engine mid-outage. If it is wrong, clips that
// exist on disk are never uploaded and nobody finds out until after the
// match.
//
// 🛠 ROOT CAUSE THIS MODULE EXISTS TO FIX.
//
// The queue used to be persisted with a bare
//
//     fs.writeFileSync(FILE, JSON.stringify(retryQueue))
//
// inside a try/catch that swallowed the error. But a queued entry also
// carries `timer`, the live setTimeout handle for its next retry, and a
// Node Timeout is a circular object (_idlePrev -> TimersList ->
// _idleNext -> back). JSON.stringify THROWS on it:
//
//     TypeError: Converting circular structure to JSON
//       --> starting at object with constructor 'Timeout'
//
// So the moment ANY entry in the queue had a retry timer armed — which
// is every entry except the one being written, and every entry at all
// after startup re-arms them — the write threw, the catch ate it, and
// the file silently stopped being updated.
//
// The effect in the exact scenario this engine is built for: the line
// goes down, clip 1 fails to forward and IS persisted (its timer is
// null at that instant), clip 2 fails and is not (clip 1's timer is now
// live), nor is clip 3, or any after it. Restart the engine while still
// offline and only the first clip is recovered; the rest sit on disk as
// orphans with no queue entry to drive them, and never upload.
//
// The fix is to persist a projection of the entry rather than the entry
// itself: only the fields that describe the work, never the runtime
// handles. Serialising is then total — it cannot throw on a live timer
// because a live timer is not part of what gets written — and a failure
// to write is reported instead of swallowed, because losing this file
// silently is the failure that costs a match's clips.
// ================================================================
const fs = require('fs');

// Everything needed to re-attempt a forward after a restart, and
// nothing else. `timer` is deliberately absent — see above.
const PERSISTED_FIELDS = [
    'clipId', 'matchId', 'eventType', 'timestamp', 'ballMeta',
    'filePath', 'mainServerUrl', 'attempts', 'offline', 'lastError', 'enqueuedAt',
];

function projectEntry(entry) {
    const out = {};
    for (const key of PERSISTED_FIELDS) {
        if (entry[key] !== undefined) out[key] = entry[key];
    }
    return out;
}

// Total: never throws, whatever runtime junk is hanging off an entry.
function serializeRetryQueue(queue) {
    return JSON.stringify((queue || []).map(projectEntry));
}

// Atomic: written to a temp file and renamed, so a crash mid-write
// cannot leave a truncated queue file that then fails to parse on the
// next start — which would lose the whole backlog just as thoroughly as
// not writing it at all.
function saveRetryQueue(file, queue, onError) {
    const tmp = `${file}.tmp`;
    try {
        fs.writeFileSync(tmp, serializeRetryQueue(queue));
        fs.renameSync(tmp, file);
        return true;
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean up */ }
        // Loud on purpose: a queue that is not being written is a silent
        // data-loss bug, which is exactly what this module replaced.
        if (typeof onError === 'function') onError(e);
        else console.error(`[stream-engine] ⚠ could not persist the clip retry queue (${file}): ${e.message}`);
        return false;
    }
}

// Tolerant of a missing file (first run) and of a corrupt one (partial
// write from an older build): a bad file yields an empty queue rather
// than throwing at startup, and the caller's own orphan reconciliation
// picks the clips back up from the clip-jobs record.
function loadRetryQueue(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) { return []; }                       // first run
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map(projectEntry);
    } catch (e) {
        console.error(`[stream-engine] ⚠ clip retry queue file was unreadable (${file}: ${e.message}) — starting empty; orphaned clips are recovered from clip-jobs.local.json`);
        return [];
    }
}

module.exports = { PERSISTED_FIELDS, projectEntry, serializeRetryQueue, saveRetryQueue, loadRetryQueue };
