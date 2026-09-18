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

// { matchId: { startedAt, tournamentId, mainServerUrl, dirs, chunks:[{index,file,receivedAt}], firstChunkIndex, recordingActive, stopped } }
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
        // Set on the FIRST addChunk this session actually receives — NOT
        // assumed to be 0. The panel's MediaRecorder chunk counter is
        // shared across features (Live Studio streaming + this clip
        // recording both reuse ONE capture, per the "never duplicate the
        // capture" requirement): if streaming was already running when
        // Recording starts, the very first chunk THIS session sees will
        // already be well past index 0 (the counter never resets), so
        // treating literal index 0 as "the header chunk" would mean this
        // session can never retain it and every clip would permanently
        // fail with a buffer-gap error, no matter how long you wait.
        firstChunkIndex: null,
        // false for a session auto-created just to buffer footage while
        // ONLY streaming is active (see ensureSession) — becomes true
        // once /recording-start (attachRecording) actually asks for
        // clips on this match. Drives activeSessionCount()/the panel's
        // "Recording: Active" indicator, so buffering quietly in the
        // background never gets reported as "recording" to the operator.
        recordingActive: false,
        stopped: false,
    };
    return sessions[matchId];
}

function getSession(rawMatchId) {
    return sessions[safeMatchId(rawMatchId)] || null;
}

// Lazily creates a (non-recording) buffer session on the very first
// chunk of a capture — called from /ingest for EVERY chunk, whether or
// not the operator has clicked "Start Recording" yet. This is what
// guarantees the session's firstChunkIndex/header lands correctly even
// when Live Studio streaming starts the shared capture before Recording
// does: the header is captured from minute one, not from whenever
// /recording-start happens to be clicked.
function ensureSession(rawMatchId) {
    const matchId = safeMatchId(rawMatchId);
    if (!matchId) return null;
    return sessions[matchId] || startSession(matchId, {});
}

// Called by /recording-start. Reuses whatever buffer already exists for
// this match (preserving its real header + any footage already
// captured while streaming-only was running) instead of always
// replacing it with an empty one — that replacement is exactly what
// used to strand every later clip request with a permanent "chunk 0
// missing" gap whenever Recording was started after Go Live.
function attachRecording(rawMatchId, { tournamentId, mainServerUrl } = {}) {
    const matchId = safeMatchId(rawMatchId);
    if (!matchId) return null;
    const session = ensureSession(matchId);
    session.tournamentId = tournamentId || session.tournamentId || null;
    session.mainServerUrl = mainServerUrl || session.mainServerUrl || null;
    session.recordingActive = true;
    session.stopped = false;
    return session;
}

// Deletes on-disk chunk files that have fallen out of the retention
// window — but NEVER this session's first-ever chunk (it carries the
// WebM header every later chunk depends on to decode at all).
function pruneOldChunks(session) {
    const cutoffMs = Date.now() - RETENTION_SEC * 1000;
    const keep = [];
    for (const c of session.chunks) {
        if (c.index === session.firstChunkIndex || c.receivedAt >= cutoffMs) { keep.push(c); continue; }
        fs.unlink(c.file, () => {});
    }
    session.chunks = keep;
}

function addChunk(rawMatchId, index, buffer) {
    const matchId = safeMatchId(rawMatchId);
    const session = sessions[matchId];
    if (!session) return { ok: false, error: 'No active local-buffer session for this matchId' };
    if (!Number.isFinite(index)) return { ok: false, error: 'index required' };

    // Whatever index this session's FIRST chunk happens to arrive with
    // (0 for a fresh capture, or higher if joining a capture already
    // running for streaming) becomes this session's header anchor.
    if (session.firstChunkIndex === null) session.firstChunkIndex = index;

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
    session.recordingActive = false;
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
// Returns { error } on any failure — with a SPECIFIC reason (no session
// vs. session-but-zero-chunks vs. session-but-window-not-covered vs. a
// pruning gap) instead of one generic "no buffer source" message, so a
// failed clip is actually diagnosable from the panel's own error text.
function getClipWindow({ matchId, eventTimestamp, preRollSec = 10, postRollSec = 10 }) {
    const session = getSession(matchId);
    if (!session) {
        return { error: `No recording session for match "${matchId}" — press "Start Recording" first (or the session was stopped/never started on this Stream Engine instance).` };
    }

    const offsetSec = (eventTimestamp - session.startedAt) / 1000;
    const fromSec = Math.max(0, offsetSec - preRollSec);
    const toSec = offsetSec + postRollSec;

    if (session.chunks.length === 0) {
        return { error: `Recording session for "${matchId}" has received 0 video chunks so far (started ${Math.round((Date.now() - session.startedAt) / 1000)}s ago) — no footage is reaching the local buffer yet. Check that the Live Output preview window is open and actually showing camera/overlay video, and that the browser tab wasn't reloaded after Start Recording.` };
    }

    const covering = chunksCoveringRange(session, fromSec, toSec);
    if (!covering.length) {
        const oldest = session.chunks[0].receivedAt;
        const newest = session.chunks[session.chunks.length - 1].receivedAt;
        return { error: `Recording session for "${matchId}" has ${session.chunks.length} chunk(s) spanning ${Math.round((newest - oldest) / 1000)}s (most recent chunk received ${Math.round((Date.now() - newest) / 1000)}s ago), but none overlap the clip window this event needs (event was ${Math.round(offsetSec)}s into the recording; needs footage from ${Math.round(fromSec)}s to ${Math.round(toSec)}s). If chunks stopped arriving a while ago, footage delivery has silently stalled — check the Live Output window/capture is still active.` };
    }

    const lastIndex = covering[covering.length - 1].index;
    const toStitch = [...session.chunks].sort((a, b) => a.index - b.index).filter((c) => c.index <= lastIndex);
    // Guard: if pruning ever left a gap between chunk 0 and the window
    // (shouldn't happen given RETENTION_SEC >> preRollSec, but this is
    // exactly the failure mode described in the header comment above —
    // fail loudly instead of silently handing ffmpeg a broken stitch).
    if (toStitch.length && toStitch[0].index !== 0) {
        return { error: `Buffer gap for match "${matchId}": chunk 0 (the WebM header every later chunk needs) is missing or was pruned — cannot stitch a clip. This should not normally happen; a Stream Engine restart mid-recording is the most likely cause.` };
    }

    return {
        session,
        fromSec,
        toSec,
        toStitch,
        trimStartSec: fromSec,
        dirs: session.dirs,
    };
}

// Only counts sessions the operator actually asked to record (see
// recordingActive) — a shadow buffer quietly capturing footage while
// only streaming is active must never show as "Recording: Active" in
// the panel.
function activeSessionCount() {
    return Object.values(sessions).filter((s) => s.recordingActive).length;
}

// Diagnostic summary for /status — lets the panel (or a curl during
// troubleshooting) see AT A GLANCE whether footage is actually reaching
// a given match's buffer, without needing to trigger a real clip first.
function sessionsSummary() {
    return Object.values(sessions).map((s) => ({
        matchId: s.matchId,
        ageSec: Math.round((Date.now() - s.startedAt) / 1000),
        chunkCount: s.chunks.length,
        lastChunkAgeSec: s.chunks.length ? Math.round((Date.now() - s.chunks[s.chunks.length - 1].receivedAt) / 1000) : null,
        recordingActive: s.recordingActive,
        stopped: s.stopped,
    }));
}

module.exports = {
    BUFFER_ROOT,
    RETENTION_SEC,
    safeMatchId,
    matchDirs,
    ensureMatchDirs,
    startSession,
    ensureSession,
    attachRecording,
    getSession,
    addChunk,
    sessionsSummary,
    stopSession,
    deleteMatchMedia,
    sweepOrphaned,
    getClipWindow,
    activeSessionCount,
};
