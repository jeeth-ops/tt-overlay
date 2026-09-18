// ================================================================
// 🎥 AllSportsLive LOCAL RECORDING/BUFFER (Part 3)
//
// This is the "AllSportsLive Local Recording/Buffer" the existing
// clipper (cricket-panel.html's recordBall()/triggerWicketClip(), plus
// finalizeClip() on server.js) now reads from — running HERE, on the
// operator's own PC, fed by the exact same browser capture Live Studio
// (Part 2) already produces. It replaces vMix's recording file as the
// clip source with zero runtime dependency on vMix or ClipperHelper.exe.
//
// Same per-match isolation idea as server.js's videoSource.js (Part 1),
// adapted for this being a LOCAL, single-operator process instead of a
// shared Render server: chunks are pruned on a rolling window instead
// of kept for the whole match, since this now runs continuously across
// a multi-hour match on the operator's own disk rather than being
// cleaned up once at the end.
//
// Bounding rationale: a clip only ever needs [eventTime-preRoll,
// eventTime+postRoll] (10s/10s today — unchanged from Part 1). Keeping
// far more than that around is pure waste on a laptop's disk over a
// multi-hour match, so anything older than RETENTION_SEC is pruned as
// new chunks arrive — except chunk 0, which carries the WebM/Matroska
// EBML+Segment header every later chunk (a bare Cluster) needs to
// decode at all. Retained clusters keep their ORIGINAL timestamps
// (MediaRecorder never resets these between chunks), so ffmpeg's
// absolute-offset seek (-ss) still lands correctly as long as the
// requested window falls inside the retained range — which it always
// does here, since clip requests are always for an event that just
// happened, not a historical timestamp from earlier in the match.
// ================================================================
const fs = require('fs');
const path = require('path');

const BUFFER_ROOT = path.join(__dirname, 'buffer', 'matches');
const RETENTION_SEC = 90; // keep the last 90s of footage — comfortably more than the 10s/10s clip window

function safeMatchId(id) {
    return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function matchDirs(matchId) {
    const root = path.join(BUFFER_ROOT, matchId);
    return {
        root,
        recordingsDir: path.join(root, 'recordings'),
        clipsDir: path.join(root, 'clips'),
        tempDir: path.join(root, 'temp'),
    };
}

function ensureMatchDirs(matchId) {
    const dirs = matchDirs(matchId);
    [dirs.root, dirs.recordingsDir, dirs.clipsDir, dirs.tempDir].forEach((d) => {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    });
    return dirs;
}

// { matchId: { startedAt, tournamentId, mainServerUrl, dirs, chunks:[{index,file,receivedAt}], stopped } }
const sessions = {};

function startSession(rawMatchId, { tournamentId, mainServerUrl } = {}) {
    const matchId = safeMatchId(rawMatchId);
    if (!matchId) return null;
    const dirs = ensureMatchDirs(matchId);
    sessions[matchId] = {
        matchId,
        tournamentId: tournamentId || null,
        mainServerUrl: mainServerUrl || null,
        startedAt: Date.now(),
        dirs,
        chunks: [],
        stopped: false,
    };
    return sessions[matchId];
}

function getSession(rawMatchId) {
    return sessions[safeMatchId(rawMatchId)] || null;
}

// Deletes on-disk chunk files that have fallen out of the retention
// window — but NEVER chunk 0 (the header every later chunk depends on).
function pruneOldChunks(session) {
    const cutoffMs = Date.now() - RETENTION_SEC * 1000;
    const keep = [];
    for (const c of session.chunks) {
        if (c.index === 0 || c.receivedAt >= cutoffMs) { keep.push(c); continue; }
        fs.unlink(c.file, () => {});
    }
    session.chunks = keep;
}

function addChunk(rawMatchId, index, buffer) {
    const matchId = safeMatchId(rawMatchId);
    const session = sessions[matchId];
    if (!session) return { ok: false, error: 'No active local-buffer session for this matchId' };
    if (!Number.isFinite(index)) return { ok: false, error: 'index required' };

    const file = path.join(session.dirs.recordingsDir, `chunk_${String(index).padStart(6, '0')}.webm`);
    try {
        fs.writeFileSync(file, buffer);
    } catch (err) {
        return { ok: false, error: err.message };
    }
    session.chunks.push({ index, file, receivedAt: Date.now() });
    session.chunks.sort((a, b) => a.index - b.index);
    pruneOldChunks(session);
    return { ok: true };
}

function stopSession(rawMatchId) {
    const matchId = safeMatchId(rawMatchId);
    const session = sessions[matchId];
    if (!session) return null;
    session.stopped = true;
    return session;
}

function deleteMatchMedia(rawMatchId) {
    const matchId = safeMatchId(rawMatchId);
    const { root } = matchDirs(matchId);
    fs.rm(root, { recursive: true, force: true }, () => {});
    delete sessions[matchId];
}

// Same idea as videoSource.js's orphan sweep — anything left on disk
// with no in-memory session (crash, missed stop) older than maxAgeMs
// gets removed so the laptop's disk never fills up match after match.
function sweepOrphaned(maxAgeMs) {
    fs.readdir(BUFFER_ROOT, (err, entries) => {
        if (err) return;
        entries.forEach((matchId) => {
            if (sessions[matchId]) return;
            const dir = path.join(BUFFER_ROOT, matchId);
            fs.stat(dir, (statErr, stats) => {
                if (statErr || !stats.isDirectory()) return;
                if (Date.now() - stats.mtimeMs > maxAgeMs) {
                    fs.rm(dir, { recursive: true, force: true }, () => {});
                }
            });
        });
    });
}

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

// The adapter's one contract — identical shape to videoSource.js's
// getClipWindow (Part 1), unchanged pre-roll/post-roll semantics.
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
    // Guard: if pruning ever left a gap between chunk 0 and the window
    // (shouldn't happen given RETENTION_SEC >> preRollSec, but this is
    // exactly the failure mode described in the header comment above —
    // fail loudly instead of silently handing ffmpeg a broken stitch).
    if (toStitch.length && toStitch[0].index !== 0) return null;

    return {
        session,
        fromSec,
        toSec,
        toStitch,
        trimStartSec: fromSec,
        dirs: session.dirs,
    };
}

function activeSessionCount() {
    return Object.keys(sessions).length;
}

module.exports = {
    BUFFER_ROOT,
    RETENTION_SEC,
    safeMatchId,
    matchDirs,
    ensureMatchDirs,
    startSession,
    getSession,
    addChunk,
    stopSession,
    deleteMatchMedia,
    sweepOrphaned,
    getClipWindow,
    activeSessionCount,
};
