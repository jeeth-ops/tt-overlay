// ================================================================
// 🎥 VIDEO SOURCE ADAPTER — "AllSportsLive local recording"
//
// PART 1 of removing the hard vMix dependency from clipping.
//
// Previously, clip *video* only ever came from one place: an external
// ClipperHelper.exe running on the operator's PC next to vMix, reading
// vMix's own recording file (see server.js's /api/clips/ingest and the
// CLIPPER_HELPER_URL calls in cricket-panel.html). That's a real, hard
// dependency — no vMix (or no ClipperHelper.exe running) meant no clips.
//
// This module is the "video source adapter" the rest of the app should
// go through instead of assuming a specific capture tool. The clipper
// (cutClip() in server.js) only ever needs to ask ONE question:
//
//     "give me the local video covering matchId around this timestamp,
//      with N seconds of pre-roll and M seconds of post-roll"
//
// getClipWindow() below answers exactly that, backed by a local,
// segmented/rolling recording (small chunks written to disk as they
// arrive — see startSession/addChunk), not one giant multi-hour file.
// Nothing here talks to vMix, OBS, or any external process — this is
// the vMix-free path. The legacy ClipperHelper→/api/clips/ingest path
// in server.js is untouched and keeps working side by side; this is
// purely the new alternative source, not a replacement of that route.
//
// On-disk layout — every match gets its own isolated tree, so two
// matches (or two different tournaments) can record independently and
// can never read/overwrite each other's footage:
//
//   media/matches/<matchId>/
//     recordings/   raw chunk files as they arrive (rolling/segmented)
//     clips/        finished, cut .mp4 clips before upload
//     temp/         short-lived stitching scratch files
//     logs/         one append-only session.log per match
//
// (The request that shaped this module described the same idea rooted
// at C:\AllSportsLive\... — that path is where a *native local capture
// agent* on the operator's Windows PC would eventually replace
// ClipperHelper.exe as the actual video producer. That agent is a
// separate executable outside this repo and is NOT built here — see
// the Part 1 report. This module is the server-side half of the same
// abstraction: whatever produces the raw footage, it lands here in
// this per-match tree and callers use the same adapter API to read it
// back.)
// ================================================================
const fs = require('fs');
const path = require('path');

const MEDIA_ROOT = path.join(__dirname, 'media', 'matches');

// Matches are used to build folder/file names on disk — never trust
// user input directly in a path. Same rule the rest of server.js uses.
function safeMatchId(id) {
    return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function matchDirs(matchId) {
    const root = path.join(MEDIA_ROOT, matchId);
    return {
        root,
        recordingsDir: path.join(root, 'recordings'),
        clipsDir: path.join(root, 'clips'),
        tempDir: path.join(root, 'temp'),
        logsDir: path.join(root, 'logs'),
    };
}

function ensureMatchDirs(matchId) {
    const dirs = matchDirs(matchId);
    [dirs.root, dirs.recordingsDir, dirs.clipsDir, dirs.tempDir, dirs.logsDir].forEach((d) => {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    });
    return dirs;
}

function appendLog(matchId, line) {
    try {
        const { logsDir } = matchDirs(matchId);
        if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
        fs.appendFile(path.join(logsDir, 'session.log'), `[${new Date().toISOString()}] ${line}\n`, () => {});
    } catch (e) { /* logging must never break the recording/clip flow */ }
}

// In-memory manifest per match, keyed by matchId (the same raw match id
// the panel/overlay already share — not room-prefixed).
// { startedAt, tournamentId, dirs, chunks:[{index, file, receivedAt}], stopped, cleanupTimer }
const sessions = {};

function startSession(rawMatchId, tournamentId) {
    const matchId = safeMatchId(rawMatchId);
    if (!matchId) return null;
    const dirs = ensureMatchDirs(matchId);
    const startedAt = Date.now();
    // A fresh Start Recording always begins a fresh session — any chunks
    // from a previous session for the same matchId are irrelevant once a
    // new one starts (mirrors the previous recordingSessions[matchId] = {...}
    // overwrite behaviour).
    sessions[matchId] = {
        matchId,
        tournamentId: tournamentId || null,
        startedAt,
        dirs,
        chunks: [],
        stopped: false,
        cleanupTimer: null,
    };
    appendLog(matchId, `Recording session started (tournamentId=${tournamentId || 'none'})`);
    return sessions[matchId];
}

function getSession(rawMatchId) {
    return sessions[safeMatchId(rawMatchId)] || null;
}

function addChunk(rawMatchId, index, buffer) {
    const matchId = safeMatchId(rawMatchId);
    const session = sessions[matchId];
    if (!session) return { ok: false, error: 'No active recording session for this matchId — call startSession first' };
    if (!Number.isFinite(index)) return { ok: false, error: 'index required' };

    const file = path.join(session.dirs.recordingsDir, `chunk_${String(index).padStart(6, '0')}.webm`);
    try {
        fs.writeFileSync(file, buffer);
    } catch (err) {
        return { ok: false, error: err.message };
    }
    session.chunks.push({ index, file, receivedAt: Date.now() });
    session.chunks.sort((a, b) => a.index - b.index);
    return { ok: true, session };
}

function stopSession(rawMatchId) {
    const matchId = safeMatchId(rawMatchId);
    const session = sessions[matchId];
    if (!session) return null;
    session.stopped = true;
    appendLog(matchId, `Recording session stopped (${session.chunks.length} chunks)`);
    return session;
}

// Deletes a match's ENTIRE media tree (recordings/clips/temp/logs). Only
// ever called well after a match's clips can no longer be in flight —
// see scheduleCleanup below, mirrors the original RECORDING_CLEANUP_DELAY_MS
// safety margin from server.js.
function deleteMatchMedia(rawMatchId) {
    const matchId = safeMatchId(rawMatchId);
    const { root } = matchDirs(matchId);
    fs.rm(root, { recursive: true, force: true }, (err) => {
        if (err) console.log(`🧹 [videoSource] Cleanup error for match ${matchId}:`, err.message);
        else console.log(`🧹 [videoSource] Cleaned up media tree for match ${matchId}`);
    });
    delete sessions[matchId];
}

function scheduleCleanup(rawMatchId, delayMs) {
    const matchId = safeMatchId(rawMatchId);
    const session = sessions[matchId];
    if (!session) return;
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    session.cleanupTimer = setTimeout(() => deleteMatchMedia(matchId), delayMs);
}

// Safety net for crashes / missed "stop" calls — anything on disk with no
// in-memory session and older than maxAgeMs is almost certainly a dead
// leftover (real matches don't run that long). Mirrors the original
// sweepOrphanedRecordings() in server.js, just scoped to media/matches/.
function sweepOrphaned(maxAgeMs) {
    fs.readdir(MEDIA_ROOT, (err, entries) => {
        if (err) return; // MEDIA_ROOT not created yet — nothing to sweep
        entries.forEach((matchId) => {
            if (sessions[matchId]) return; // still active / pending cleanup
            const dir = path.join(MEDIA_ROOT, matchId);
            fs.stat(dir, (statErr, stats) => {
                if (statErr || !stats.isDirectory()) return;
                if (Date.now() - stats.mtimeMs > maxAgeMs) {
                    fs.rm(dir, { recursive: true, force: true }, (rmErr) => {
                        if (!rmErr) console.log(`🧹 [videoSource] Swept orphaned match media: ${matchId}`);
                    });
                }
            });
        });
    });
}

// Finds which chunk files together cover [fromSec, toSec] of the
// recording, based on each chunk's arrival time relative to startedAt.
// Approximation (chunk arrival ≈ chunk content time, since MediaRecorder
// emits chunks on a steady timeslice) — good enough for a highlight clip,
// not frame-accurate editing. Unchanged from the original server.js logic.
function chunksCoveringRange(session, fromSec, toSec) {
    const fromMs = session.startedAt + Math.max(0, fromSec) * 1000;
    const toMs = session.startedAt + toSec * 1000;
    const sorted = [...session.chunks].sort((a, b) => a.index - b.index);
    const covering = [];
    for (let i = 0; i < sorted.length; i++) {
        const c = sorted[i];
        const next = sorted[i + 1];
        const chunkEndMs = next ? next.receivedAt : Date.now();
        if (chunkEndMs >= fromMs && c.receivedAt <= toMs) covering.push(c);
    }
    return covering;
}

// ================================================================
// 🔌 THE ADAPTER'S ONE PUBLIC CONTRACT
//
//     Clipper → getClipWindow({matchId, eventTimestamp, preRollSec, postRollSec}) → Video Source Adapter → Local Recording/Buffer
//
// Callers (cutClip in server.js) never touch `sessions`, chunk files, or
// disk paths directly — they ask for a window and get back everything
// needed to build the clip: which chunks to stitch (chunk 0 through the
// last one covering the window — MediaRecorder chunks after the first
// aren't independently valid WebM, so stitching always needs to start
// from chunk 0, same as the original implementation), where the
// window starts inside that stitched stream, and this match's own
// clips/temp directories to write into.
//
// Returns null when there's simply no local recording for this match
// (e.g. the operator is using the legacy ClipperHelper/vMix path
// instead) — callers treat that as "no local source available", not an
// error, and can fall back to whatever other pipeline they support.
// ================================================================
function getClipWindow({ matchId, eventTimestamp, preRollSec = 10, postRollSec = 10 }) {
    const session = getSession(matchId);
    if (!session) return null;

    const offsetSec = (eventTimestamp - session.startedAt) / 1000;
    const fromSec = Math.max(0, offsetSec - preRollSec);
    const toSec = offsetSec + postRollSec;

    const covering = chunksCoveringRange(session, fromSec, toSec);
    if (!covering.length) return null;

    const lastIndex = covering[covering.length - 1].index;
    const toStitch = [...session.chunks].sort((a, b) => a.index - b.index).filter((c) => c.index <= lastIndex);

    return {
        session,
        fromSec,
        toSec,
        durationSec: preRollSec + postRollSec,
        toStitch,       // ordered chunk files to byte-concatenate, starting at chunk 0
        trimStartSec: fromSec, // stitched file always starts at t=0 of the whole recording
        dirs: session.dirs,
    };
}

function activeSessionCount() {
    return Object.keys(sessions).length;
}

module.exports = {
    MEDIA_ROOT,
    safeMatchId,
    matchDirs,
    ensureMatchDirs,
    appendLog,
    startSession,
    getSession,
    addChunk,
    stopSession,
    deleteMatchMedia,
    scheduleCleanup,
    sweepOrphaned,
    getClipWindow,
    activeSessionCount,
};
