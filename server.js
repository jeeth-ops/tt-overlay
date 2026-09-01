const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstallerPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegInstallerPath);
const { google } = require('googleapis');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// ================================================================
// ☁️ CLOUDFLARE R2 — where clips live for their first (public-facing)
// year on the website. R2 is S3-compatible, so we talk to it with the
// same AWS SDK everyone uses for S3 — just pointed at Cloudflare's
// endpoint instead of Amazon's. Safe init (same pattern as Firebase/
// Mongo/Drive above): missing env vars just disable this feature
// instead of crashing the whole server.
// ================================================================
let r2Client = null;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL; // e.g. https://pub-xxxx.r2.dev  (no trailing slash)

if (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) {
    r2Client = new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
        }
    });
    console.log('☁️  Cloudflare R2 client ready');
} else {
    console.log('⚠️  R2 env vars not set — clips will only go to Drive until they are.');
}

// Safe Initialization to prevent crashes on Render if environment variables are missing
try {
    if (process.env.FIREBASE_PRIVATE_KEY) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID || "scorvix-faf0e",
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
            })
        });
    } else {
        admin.initializeApp({
            projectId: "scorvix-faf0e"
        });
    }
} catch (e) {
    console.log("Firebase Admin Init Error:", e);
}

const db = admin.firestore();
const app = express();
const server = http.createServer(app);

// ================================================================
// 🍃 MONGODB — source of truth for raw ball-by-ball data.
// Firestore (above) keeps the current live SCOREBOARD STATE (what the
// overlay renders right now, small doc, overwritten constantly).
// MongoDB keeps every single ball ever bowled as its own document —
// the permanent match log that Excel export / stats / clips reference
// later. These two are deliberately separate concerns.
// Safe init (same pattern as Firebase above): server must not crash if
// MONGODB_URI isn't set yet — it just logs and features that need Mongo
// no-op until it's configured.
// ================================================================
let mongoDb = null;
let ballsCollection = null;
let matchesCollection = null;
let clipsCollection = null;
let leaguesCollection = null;
let templatesCollection = null;
let auditLogsCollection = null;
let settingsCollection = null;

async function connectMongo() {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
        console.log('⚠️  MONGODB_URI not set — ball-by-ball logging & clips are disabled until it is.');
        return;
    }
    try {
        const client = new MongoClient(uri);
        await client.connect();
        mongoDb = client.db(process.env.MONGODB_DB_NAME || 'scorvix');
        ballsCollection = mongoDb.collection('balls');
        matchesCollection = mongoDb.collection('matches');
        clipsCollection = mongoDb.collection('clips');
        leaguesCollection = mongoDb.collection('leagues');
        // 🛡️ Owner Admin Portal — templates (Broadcasting tab), auditLogs
        // (every admin action, append-only) and settings (single doc of
        // safe global config). All three are net-new, real, and start
        // empty — nothing here is seeded with fake data.
        templatesCollection = mongoDb.collection('templates');
        auditLogsCollection = mongoDb.collection('auditLogs');
        settingsCollection = mongoDb.collection('settings');
        // Fast lookups: all balls of a match in bowling order, and one
        // match doc per matchId.
        await ballsCollection.createIndex({ matchId: 1, innings: 1, over: 1, ballInOver: 1 });
        await matchesCollection.createIndex({ matchId: 1 }, { unique: true });
        await clipsCollection.createIndex({ matchId: 1, createdAt: 1 });
        // 🔗 Clip ↔ player linking (see "PLAYER IDENTITY FOR CLIPS & STATS"
        // below): fast "this player's clips" lookups scoped to one match,
        // one owner's whole account (career), or filtered by clip type.
        await clipsCollection.createIndex({ matchId: 1, strikerKey: 1, eventType: 1 });
        await clipsCollection.createIndex({ matchId: 1, bowlerKey: 1, eventType: 1 });
        await clipsCollection.createIndex({ ownerUid: 1, strikerKey: 1, createdAt: -1 });
        await clipsCollection.createIndex({ ownerUid: 1, bowlerKey: 1, createdAt: -1 });
        await clipsCollection.createIndex({ matchId: 1, battingTeam: 1, eventType: 1 });
        // One doc per (owner, league) pair — owner-scoped so two different
        // customers naming a league the same thing (e.g. "Summer Cup") never
        // collide/overwrite each other. ownerUid comes from the logged-in
        // Firebase user (see index.html's `scorvix_uid`), matching how the
        // rest of this app already identifies "whose data is whose".
        await leaguesCollection.createIndex({ ownerUid: 1, leagueKey: 1 }, { unique: true });
        // Public tournament portal links (see /api/league/:name/public-link) —
        // sparse because most league docs never mint one.
        await leaguesCollection.createIndex({ publicToken: 1 }, { unique: true, sparse: true });
        // Public standalone-match lookups resolve by matchId/roomId inside the
        // reserved __single_matches__ doc's matches[] array — see
        // GET /api/public/match/:id.
        await leaguesCollection.createIndex({ leagueKey: 1, 'matches.matchId': 1 });
        await leaguesCollection.createIndex({ leagueKey: 1, 'matches.roomId': 1 });
        console.log('🍃 MongoDB connected —', mongoDb.databaseName);
    } catch (err) {
        console.log('MongoDB connection error:', err);
    }
}
connectMongo();

// ================================================================
// 📁 GOOGLE DRIVE (service account) — uploads finished clips straight
// into a folder the operator owns. One-time setup: create a service
// account in Google Cloud, put its JSON key in GOOGLE_SERVICE_ACCOUNT_JSON,
// and have the operator share their Drive folder with that account's
// email (Editor access). No per-operator login/OAuth needed after that
// — but since the SERVICE ACCOUNT (not the operator) technically owns
// any file it creates, uploads only stay reliable long-term on a paid
// Google Workspace / Shared Drive folder — a personal Gmail account's
// folder can start rejecting uploads once the service account's own
// (near-zero) storage quota fills up. This was a deliberate trade-off
// for simplicity (paste-a-link, no OAuth popups) over that reliability.
// ================================================================
let driveClient = null;
function initDriveClient() {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) {
        console.log('⚠️  GOOGLE_SERVICE_ACCOUNT_JSON not set — Drive upload is disabled until it is.');
        return;
    }
    try {
        const creds = JSON.parse(raw);
        const auth = new google.auth.JWT(
            creds.client_email,
            null,
            creds.private_key,
            ['https://www.googleapis.com/auth/drive']
        );
        driveClient = google.drive({ version: 'v3', auth });
        console.log('📁 Google Drive service account ready:', creds.client_email);
    } catch (err) {
        console.log('Drive credentials parse error:', err);
    }
}
initDriveClient();

// Accepts either a full folder share link (…/folders/<id>?usp=sharing)
// or a bare folder ID pasted directly.
function extractDriveFolderId(link) {
    if (!link) return null;
    const trimmed = link.trim();
    const folderMatch = trimmed.match(/folders\/([a-zA-Z0-9_-]+)/);
    if (folderMatch) return folderMatch[1];
    if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed;
    return null;
}

function buildClipFileName(eventType, ballMeta) {
    const over = (ballMeta && ballMeta.over !== undefined) ? ballMeta.over : '_';
    const ballInOver = (ballMeta && ballMeta.ballInOver !== undefined) ? ballMeta.ballInOver : '_';
    const striker = (ballMeta && ballMeta.striker) ? '_' + ballMeta.striker.replace(/[^a-zA-Z0-9]+/g, '_') : '';
    return `${eventType}_Over-${over}.${ballInOver}${striker}_${Date.now()}.mp4`;
}

// Fire-and-forget — never blocks the clip pipeline. If no folder has
// been set for this match yet, it just logs and skips (clip file still
// stays on the server's disk either way).
//
// Two ways a match can be connected to Drive, tried in this order:
//  1. Per-user OAuth (recordingSessions[matchId].driveOAuth) — operator
//     clicked "Connect Google Drive" and picked their own folder via the
//     Picker. No manual sharing needed, but the access token only lives
//     ~1hr — if it's expired/revoked the upload just fails and logs it;
//     recording itself is completely unaffected either way.
//  2. Legacy service-account folder (driveFolderId) — operator manually
//     shared a folder with the service account's email and pasted the link.
async function uploadClipToDrive(matchId, filePath, eventType, ballMeta) {
    const session = recordingSessions[matchId];
    const oauth = session && session.driveOAuth;

    let uploadClient = null;
    let folderId = null;

    if (oauth && oauth.accessToken) {
        const userAuth = new google.auth.OAuth2();
        userAuth.setCredentials({ access_token: oauth.accessToken });
        uploadClient = google.drive({ version: 'v3', auth: userAuth });
        folderId = oauth.folderId;
    } else if (driveClient) {
        uploadClient = driveClient;
        folderId = session && session.driveFolderId;
        if (!folderId && matchesCollection) {
            try {
                const doc = await matchesCollection.findOne({ matchId });
                folderId = doc && doc.driveFolderId;
            } catch (err) { console.log('Mongo drive-folder lookup error:', err); }
        }
    }

    if (!uploadClient || !folderId) {
        console.log(`No Drive connection for match ${matchId} — clip stays local only: ${filePath}`);
        return;
    }

    const fileName = buildClipFileName(eventType, ballMeta);
    try {
        const uploadRes = await uploadClient.files.create({
            requestBody: { name: fileName, parents: [folderId] },
            media: { mimeType: 'video/mp4', body: fs.createReadStream(filePath) },
            fields: 'id, webViewLink'
        });
        if (clipsCollection) {
            await clipsCollection.updateOne(
                { matchId, filePath },
                { $set: { driveStatus: 'uploaded', driveFileId: uploadRes.data.id, driveUrl: uploadRes.data.webViewLink } }
            );
        }
        console.log(`☁️  Uploaded to Drive: ${fileName}`);
    } catch (err) {
        console.log(`Drive upload error (${fileName}):`, err.message || err);
        if (clipsCollection) {
            await clipsCollection.updateOne({ matchId, filePath }, { $set: { driveStatus: 'failed' } }).catch(() => {});
        }
    }
}

// Uploads a clip to Cloudflare R2 (fire-and-forget, same shape as
// uploadClipToDrive above) and saves the public playback URL on the
// clip's Mongo record — this is the URL the scorecard's video player
// actually points at for anything less than a year old.
async function uploadClipToR2(matchId, filePath, eventType, ballMeta) {
    if (!r2Client || !R2_BUCKET_NAME) {
        console.log(`No R2 connection configured — clip stays Drive-only: ${filePath}`);
        return;
    }

    const fileName = buildClipFileName(eventType, ballMeta);
    const key = `${matchId}/${fileName}`;

    try {
        await r2Client.send(new PutObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
            Body: fs.createReadStream(filePath),
            ContentType: 'video/mp4'
        }));

        const publicUrl = `${R2_PUBLIC_URL}/${key}`;
        if (clipsCollection) {
            await clipsCollection.updateOne(
                { matchId, filePath },
                { $set: { r2Status: 'uploaded', r2Key: key, r2Url: publicUrl } }
            );
        }
        console.log(`☁️  Uploaded to R2: ${key}`);
    } catch (err) {
        console.log(`R2 upload error (${key}):`, err.message || err);
        if (clipsCollection) {
            await clipsCollection.updateOne({ matchId, filePath }, { $set: { r2Status: 'failed' } }).catch(() => {});
        }
    }
}

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(__dirname));
app.use(express.json());

// ================================================================
// 🎬 RECORDING + CLIPS (FFmpeg)
// Flow: operator clicks "Start Recording" in cricket-panel.html →
// browser shares its own tab/screen (getDisplayMedia) → MediaRecorder
// slices it into small webm chunks → each chunk is POSTed here as it's
// produced → we save chunks to disk in bowling order.
// On WICKET/FOUR/SIX the panel asks for a clip; we wait until enough
// "after" footage has actually arrived, then use ffmpeg to stitch the
// relevant chunks + trim to an exact 20s window (10s before, 10s after).
// Nothing here touches OBS/vMix or the live stream — this capture runs
// in the operator's panel tab, a completely separate browser context
// from whatever OBS is reading as its browser source/scene.
// ================================================================
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const CLIPS_DIR = path.join(__dirname, 'clips');
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });

// In-memory manifest per match, keyed by matchId (NOT room-prefixed —
// this is the raw match id the panel/overlay share, e.g. "abc123").
// { startedAt: ms epoch when recording began, chunkDir, chunks: [{index, file, receivedAt}], stopped }
const recordingSessions = {};

function safeMatchId(id) {
    // Matches are used to build folder/file names on disk — never trust
    // user input directly in a path.
    return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

// ================================================================
// 🧹 DISK CLEANUP — this is the piece that stops the server's disk
// from filling up over hundreds of matches.
//
// IMPORTANT: we never delete chunks mid-match. cutClip() always needs
// chunk 0 onward to rebuild a valid webm, so removing any chunk before
// a match ends could silently break the NEXT clip request. Instead we
// wait until recording has stopped AND every clip that could still be
// in flight has had time to finish, then delete the whole match's
// chunk folder in one go. This keeps clip-cutting 100% unaffected
// while still guaranteeing nothing lives on disk forever.
// ================================================================

// Longest a clip request can still be pending after "stop" is pressed:
// requestClip() waits up to (eventTimestamp + 10s) before cutting, so a
// wicket/four/six recorded in the last few seconds before stop could
// still need its chunks up to ~11s later. 90s is a generous safety
// margin on top of that.
const RECORDING_CLEANUP_DELAY_MS = 90 * 1000;

function deleteRecordingFolder(matchId, chunkDir) {
    fs.rm(chunkDir, { recursive: true, force: true }, (err) => {
        if (err) {
            console.log(`🧹 Cleanup error for match ${matchId}:`, err.message);
        } else {
            console.log(`🧹 Cleaned up recording chunks for match ${matchId}`);
        }
    });
    delete recordingSessions[matchId];
}

function scheduleRecordingCleanup(matchId) {
    const session = recordingSessions[matchId];
    if (!session) return;
    // Avoid double-scheduling if stop is somehow called twice.
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    session.cleanupTimer = setTimeout(() => {
        deleteRecordingFolder(matchId, session.chunkDir);
    }, RECORDING_CLEANUP_DELAY_MS);
}

// 🛟 Safety net for crashes / missed "stop" calls: even if a match's
// stop event never fires (server restart mid-match, operator's tab
// closing without hitting stop, network drop, etc.), this sweep makes
// sure a stray folder can never sit on disk forever. Anything older
// than 12 hours with no in-memory session is almost certainly a dead
// leftover, since real matches don't run that long.
const ORPHAN_RECORDING_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function sweepOrphanedRecordings() {
    fs.readdir(RECORDINGS_DIR, (err, entries) => {
        if (err) return;
        entries.forEach((matchId) => {
            if (recordingSessions[matchId]) return; // still active / pending cleanup
            const dir = path.join(RECORDINGS_DIR, matchId);
            fs.stat(dir, (statErr, stats) => {
                if (statErr || !stats.isDirectory()) return;
                if (Date.now() - stats.mtimeMs > ORPHAN_RECORDING_MAX_AGE_MS) {
                    fs.rm(dir, { recursive: true, force: true }, (rmErr) => {
                        if (!rmErr) console.log(`🧹 Swept orphaned recording folder: ${matchId}`);
                    });
                }
            });
        });
    });
}
// Run once shortly after boot (catches anything left from before a
// deploy/restart) and then every hour going forward.
setTimeout(sweepOrphanedRecordings, 60 * 1000);
setInterval(sweepOrphanedRecordings, 60 * 60 * 1000);

app.post('/api/recording/start', async (req, res) => {
    const matchId = safeMatchId(req.body.matchId);
    if (!matchId) return res.status(400).json({ success: false, error: 'matchId required' });

    const chunkDir = path.join(RECORDINGS_DIR, matchId);
    if (!fs.existsSync(chunkDir)) fs.mkdirSync(chunkDir, { recursive: true });

    const startedAt = Date.now();
    recordingSessions[matchId] = { startedAt, chunkDir, chunks: [], stopped: false };

    if (matchesCollection) {
        try {
            await matchesCollection.updateOne(
                { matchId },
                { $set: { matchId, recordingStartedAt: startedAt, recordingStatus: 'recording' } },
                { upsert: true }
            );
        } catch (err) { console.log('Mongo recording/start error:', err); }
    }
    console.log(`🔴 Recording started for match ${matchId}`);
    res.json({ success: true, startedAt });
});

// Chunks arrive as raw binary (webm blob straight from MediaRecorder).
// ?matchId=xxx&index=0,1,2...  — index keeps them in the right order
// even if two chunks happen to arrive out of sequence over the network.
app.post('/api/recording/chunk', express.raw({ type: '*/*', limit: '25mb' }), (req, res) => {
    const matchId = safeMatchId(req.query.matchId);
    const index = parseInt(req.query.index, 10);
    const session = recordingSessions[matchId];
    if (!session) return res.status(400).json({ success: false, error: 'No active recording session for this matchId — call /api/recording/start first' });
    if (Number.isNaN(index)) return res.status(400).json({ success: false, error: 'index required' });

    const file = path.join(session.chunkDir, `chunk_${String(index).padStart(6, '0')}.webm`);
    fs.writeFile(file, req.body, (err) => {
        if (err) {
            console.log('Chunk write error:', err);
            return res.status(500).json({ success: false });
        }
        session.chunks.push({ index, file, receivedAt: Date.now() });
        session.chunks.sort((a, b) => a.index - b.index);
        res.json({ success: true });
    });
});

app.post('/api/recording/stop', async (req, res) => {
    const matchId = safeMatchId(req.body.matchId);
    const session = recordingSessions[matchId];
    if (!session) return res.status(400).json({ success: false, error: 'No active recording session' });
    session.stopped = true;

    if (matchesCollection) {
        try {
            await matchesCollection.updateOne({ matchId }, { $set: { recordingStatus: 'stopped', recordingStoppedAt: Date.now() } });
        } catch (err) { console.log('Mongo recording/stop error:', err); }
    }
    console.log(`⏹ Recording stopped for match ${matchId} (${session.chunks.length} chunks)`);
    // Clips can still be in flight for a few more seconds — schedule
    // the actual disk cleanup instead of deleting immediately.
    scheduleRecordingCleanup(matchId);
    res.json({ success: true, chunkCount: session.chunks.length });
});

// Operator pastes their Drive folder's share link once (per match) —
// we resolve it to a folder ID and remember it both in-memory (fast
// path for uploads right after a clip is cut) and in Mongo (survives
// a server restart mid-match).
app.post('/api/set-drive-folder', async (req, res) => {
    const matchId = safeMatchId(req.body.matchId);
    const folderId = extractDriveFolderId(req.body.folderLink);
    if (!matchId || !folderId) {
        return res.status(400).json({ success: false, error: 'Valid matchId and Drive folder link are required' });
    }

    if (recordingSessions[matchId]) recordingSessions[matchId].driveFolderId = folderId;
    if (matchesCollection) {
        try {
            await matchesCollection.updateOne({ matchId }, { $set: { matchId, driveFolderId: folderId } }, { upsert: true });
        } catch (err) { console.log('Mongo set-drive-folder error:', err); }
    }
    res.json({ success: true, folderId });
});

// 🔗 Per-user Google Drive connect (Picker flow) — operator signs into
// their OWN Google account in the browser, picks/creates a folder from
// their own Drive via the Picker widget, and the resulting short-lived
// access token + folder id land here. No manual "share this folder with
// our service account" step required. We verify the token can actually
// see the folder before accepting it, so a stale/bad token fails loudly
// here instead of silently on the first clip upload. The token is kept
// in memory only (not persisted to Mongo) since it expires in ~1hr —
// if it goes stale mid-match the operator just clicks "Connect" again.
app.post('/api/set-drive-folder-oauth', async (req, res) => {
    const matchId = safeMatchId(req.body.matchId);
    const { accessToken, folderId } = req.body;
    if (!matchId || !accessToken || !folderId) {
        return res.status(400).json({ success: false, error: 'matchId, accessToken and folderId are required' });
    }

    try {
        const userAuth = new google.auth.OAuth2();
        userAuth.setCredentials({ access_token: accessToken });
        const drive = google.drive({ version: 'v3', auth: userAuth });
        try {
            await drive.files.get({ fileId: folderId, fields: 'id, name' });
        } catch (firstErr) {
            // Picker-granted access can take a moment to propagate — one retry after a short wait.
            await new Promise(r => setTimeout(r, 1500));
            await drive.files.get({ fileId: folderId, fields: 'id, name' });
        }
    } catch (err) {
        console.log('Drive OAuth verify error:', err.message || err);
        return res.status(400).json({ success: false, error: 'Could not verify Drive access — please reconnect' });
    }

    if (!recordingSessions[matchId]) {
        recordingSessions[matchId] = { startedAt: Date.now(), chunkDir: path.join(RECORDINGS_DIR, matchId), chunks: [], stopped: false };
    }
    recordingSessions[matchId].driveOAuth = { accessToken, folderId, connectedAt: Date.now() };

    if (matchesCollection) {
        try {
            // Only the folder id is persisted — never the access token.
            await matchesCollection.updateOne({ matchId }, { $set: { matchId, driveFolderId: folderId, driveMode: 'oauth' } }, { upsert: true });
        } catch (err) { console.log('Mongo set-drive-folder-oauth error:', err); }
    }

    res.json({ success: true, folderId });
});

// Finds which chunk files together cover [fromSec, toSec] of the
// recording, based on each chunk's arrival time relative to startedAt.
// This is an approximation (chunk arrival ≈ chunk content time, since
// MediaRecorder emits chunks on a steady timeslice) — good enough for a
// ±10s highlight clip, not frame-accurate editing.
function chunksCoveringRange(session, fromSec, toSec) {
    const fromMs = session.startedAt + Math.max(0, fromSec) * 1000;
    const toMs = session.startedAt + toSec * 1000;
    // Include one chunk before the window starts too, so ffmpeg has
    // enough lead-in to seek precisely with -ss.
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

// Stitches the covering chunks + trims to an exact clip using ffmpeg,
// and records the clip in MongoDB so the (future) Google Drive step
// knows what's waiting to be uploaded.
async function cutClip({ matchId, eventType, eventTimestamp, ballMeta, uid }) {
    const session = recordingSessions[matchId];
    if (!session) { console.log(`No recording session for ${matchId} — skipping clip for ${eventType}`); return; }

    const offsetSec = (eventTimestamp - session.startedAt) / 1000;
    const fromSec = Math.max(0, offsetSec - 10);
    const toSec = offsetSec + 10;
    const clipDir = path.join(CLIPS_DIR, matchId);
    if (!fs.existsSync(clipDir)) fs.mkdirSync(clipDir, { recursive: true });

    const covering = chunksCoveringRange(session, fromSec, toSec);
    if (!covering.length) { console.log(`No chunks found covering clip window for ${matchId}/${eventType}`); return; }

    // MediaRecorder's timeslice chunks are NOT independently-valid WebM
    // files except the very first one (it carries the EBML/Segment
    // header; every later chunk is a bare Matroska Cluster meant to be
    // appended directly after it). ffmpeg's concat *demuxer* expects each
    // listed input to be independently valid on its own, so handing it
    // non-first chunks used to fail with "Invalid argument". The fix:
    // raw byte-concatenate every chunk from index 0 through the last
    // chunk covering our window, in strict order — that reconstructs an
    // actually-playable file, which we then trim/transcode as before.
    const lastIndex = covering[covering.length - 1].index;
    const toStitch = [...session.chunks].sort((a, b) => a.index - b.index).filter(c => c.index <= lastIndex);

    const stitchedFile = path.join(clipDir, `_stitched_${Date.now()}.webm`);
    const outFile = path.join(clipDir, `${eventType}_${Date.now()}.mp4`);

    // The stitched file always starts at t=0 of the whole recording now
    // (since we always include chunk 0), so no extra offset math needed.
    const trimStartSec = fromSec;

    try {
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(stitchedFile);
            out.on('error', reject);
            (async () => {
                for (const c of toStitch) {
                    await new Promise((res2, rej2) => {
                        const rs = fs.createReadStream(c.file);
                        rs.on('error', rej2);
                        rs.on('end', res2);
                        rs.pipe(out, { end: false });
                    });
                }
                out.end();
                resolve();
            })().catch(reject);
        });

        await new Promise((resolve, reject) => {
            ffmpeg(stitchedFile)
                .setStartTime(trimStartSec)
                .duration(20)
                .outputOptions(['-c:v libx264', '-c:a aac', '-preset veryfast'])
                .save(outFile)
                .on('end', resolve)
                .on('error', reject);
        });

        if (clipsCollection) {
            // 🔗 Link this clip to real player identities/dismissal info by
            // cross-referencing the canonical ball (logged via `logBall`,
            // the permanent source of truth) instead of trusting only the
            // ballMeta the panel happened to attach to the clip request.
            // Falls back gracefully to whatever ballMeta was sent if no
            // matching ball is found (e.g. Mongo briefly unavailable).
            const canonicalBall = await findCanonicalBall(matchId, ballMeta);
            const ownerUid = await resolveOwnerUidForMatch(matchId, uid || (canonicalBall && canonicalBall.ownerUid));
            const striker = (canonicalBall && canonicalBall.striker) || (ballMeta && ballMeta.striker) || null;
            const bowler = (canonicalBall && canonicalBall.bowler) || (ballMeta && ballMeta.bowler) || null;
            const nonStriker = (canonicalBall && canonicalBall.nonStriker) || (ballMeta && ballMeta.nonStriker) || null;
            const dismissal = (canonicalBall && canonicalBall.dismissal) || (ballMeta && ballMeta.dismissal) || null;
            const battingTeam = (canonicalBall && canonicalBall.battingTeam) || (ballMeta && ballMeta.battingTeam) || null;

            await clipsCollection.insertOne({
                matchId, ownerUid: ownerUid || null, eventType, ballMeta: ballMeta || null,
                eventTimestamp, offsetStartSec: fromSec, offsetEndSec: toSec,
                filePath: outFile, driveStatus: 'pending', createdAt: Date.now(),
                // --- player/dismissal linking, for the clips & stats APIs ---
                over: canonicalBall ? canonicalBall.over : (ballMeta && ballMeta.over),
                ballInOver: canonicalBall ? canonicalBall.ballInOver : (ballMeta && ballMeta.ballInOver),
                innings: canonicalBall ? canonicalBall.innings : (ballMeta && ballMeta.innings),
                runs: canonicalBall ? canonicalBall.runs : (ballMeta && ballMeta.runs),
                battingTeam,
                strikerName: striker, strikerKey: playerKey(striker),
                nonStrikerName: nonStriker, nonStrikerKey: playerKey(nonStriker),
                bowlerName: bowler, bowlerKey: playerKey(bowler),
                dismissalType: dismissal && dismissal.type ? dismissal.type : null,
                fielderName: dismissal && dismissal.fielder ? dismissal.fielder : null,
                fielderKey: playerKey(dismissal && dismissal.fielder)
            });
        }
        console.log(`🎬 Clip ready: ${outFile}`);
        // Both uploads are fire-and-forget — neither blocks/delays clip
        // cutting, and one failing (e.g. Drive token expired) never stops
        // the other from succeeding.
        uploadClipToR2(matchId, outFile, eventType, ballMeta);
        uploadClipToDrive(matchId, outFile, eventType, ballMeta);
    } catch (err) {
        console.log(`Clip generation error (${matchId}/${eventType}):`, err.message || err);
    } finally {
        fs.existsSync(stitchedFile) && fs.unlink(stitchedFile, () => {});
    }
}

// 🔐 Verifies a Firebase ID token and returns the real, cryptographically-
// confirmed uid — or null if it's missing/invalid/expired. This is the only
// trustworthy way to know who someone actually is; a uid supplied in a URL
// or socket payload can be typed/guessed/copied by anyone, but an ID token
// is signed by Firebase and can't be forged.
async function verifyFirebaseIdToken(idToken) {
    if (!idToken) return null;
    try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        return decoded.uid;
    } catch (err) {
        return null;
    }
}

// ================================================================
// 🛡️ OWNER ADMIN PORTAL — server-side authorization.
// This is the ONLY place that decides who is the owner. The rule is
// exactly: authenticatedUser.email === OWNER_EMAIL, verified against a
// cryptographically-signed Firebase ID token — never trusted from a
// client-supplied email/uid the way ownerUid is elsewhere in this file.
// Set OWNER_EMAIL as an env var in production; the literal below is
// only a local-dev fallback so this still works before env vars are wired up.
// ================================================================
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'chhayajeeth@gmail.com';

// Verifies the token AND returns the decoded token (has .email, .uid) —
// unlike verifyFirebaseIdToken above (which only hands back a uid), the
// owner check needs the token's verified email.
async function verifyIdTokenFull(idToken) {
    if (!idToken) return null;
    try {
        return await admin.auth().verifyIdToken(idToken);
    } catch (err) {
        return null;
    }
}

function extractIdToken(req) {
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) return authHeader.slice(7);
    return (req.body && req.body.idToken) || req.query.idToken || null;
}

// Every /api/admin/* route uses this. On success it attaches
// req.ownerEmail / req.ownerUid; on failure it responds and stops the
// chain — the route handler never even runs for a non-owner.
async function requireOwner(req, res, next) {
    const idToken = extractIdToken(req);
    const decoded = await verifyIdTokenFull(idToken);
    if (!decoded || decoded.email !== OWNER_EMAIL) {
        return res.status(403).json({ success: false, error: 'Access Denied' });
    }
    req.ownerEmail = decoded.email;
    req.ownerUid = decoded.uid;
    next();
}

// Append-only trail of what the owner did, when, to what, and the
// before/after value — shown in the Audit Logs tab.
async function logAuditAction(ownerEmail, action, target, previousValue, newValue) {
    if (!auditLogsCollection) return;
    try {
        await auditLogsCollection.insertOne({
            action, target,
            previousValue: previousValue === undefined ? null : previousValue,
            newValue: newValue === undefined ? null : newValue,
            performedBy: ownerEmail,
            timestamp: Date.now()
        });
    } catch (err) {
        console.log('Audit log write error:', err);
    }
}

// 🔐 Lets the panel owner generate a "control token" so a second device
// (e.g. phone, via the Control-from-Mobile QR) can operate their SAME match
// — without exposing their real uid, and without letting anyone who merely
// obtains the link hijack someone else's room. Only someone holding a valid
// Firebase ID token for the room's real owner can mint a token for that room.
app.post('/api/create-control-token', async (req, res) => {
    const ownerUid = await verifyFirebaseIdToken(req.body.idToken);
    if (!ownerUid) return res.status(401).json({ success: false, error: 'Invalid or expired login' });

    const token = crypto.randomBytes(24).toString('hex');
    try {
        await db.collection('controlTokens').doc(token).set({
            room: `room-${ownerUid}`,
            ownerUid,
            createdAt: Date.now()
        });
        res.json({ success: true, token });
    } catch (err) {
        console.log('Control token creation error:', err);
        res.status(500).json({ success: false });
    }
});

// ================================================================
// 🏆 LEAGUE / TOURNAMENT DATABASE — MongoDB-backed so the same league's
// match history (and the automatic Team/Player/Bowler "Tournament" cards
// built from it) shows up identically no matter which laptop/browser the
// cricket-panel is opened from. Keyed by (ownerUid, leagueKey) — leagueKey
// is the league name, case/whitespace-insensitive, same matching rule the
// panel already used for its old localStorage-only version of this.
//
// ownerUid comes straight from the client (see cricket-panel.html — it
// reads the same `scorvix_uid` that index.html sets in localStorage after
// Google sign-in). It is NOT cryptographically verified here, same trust
// level the rest of this server already uses to route TT/Football rooms.
// It's still enough to stop two unrelated customers' leagues from ever
// colliding, which is the actual risk being guarded against — someone
// deliberately spoofing their own localStorage to read another account's
// league data would need the stronger Firebase-ID-token verification the
// /api/create-control-token route uses, which can be layered on later.
// ================================================================
function leagueKeyFor(name) {
    return String(name || '').trim().toLowerCase();
}
const SINGLE_MATCHES_LEAGUE_KEY = '__single_matches__'; // must match SINGLE_MATCHES_NAME in cricket-panel.html
function ownerUidFrom(req) {
    const uid = (req.query.uid || (req.body && req.body.uid) || '').toString().trim();
    return uid || null;
}

// All matches saved under a league/tournament name, for one owner.
app.get('/api/league/:name', async (req, res) => {
    const leagueKey = leagueKeyFor(req.params.name);
    const ownerUid = ownerUidFrom(req);
    if (!leagueKey) return res.status(400).json({ success: false, error: 'League name required' });
    if (!ownerUid) return res.status(401).json({ success: false, error: 'Login required (missing uid)' });
    if (!leaguesCollection) return res.json({ success: true, matches: [] }); // Mongo not configured — panel falls back to its local cache
    try {
        const doc = await leaguesCollection.findOne({ ownerUid, leagueKey });
        res.json({ success: true, matches: (doc && doc.matches) || [] });
    } catch (err) {
        console.log('League fetch error:', err);
        res.status(500).json({ success: false, error: 'Could not load league data' });
    }
});

// Upserts one match record into a league by matchId — re-saving after a
// correction (or the panel's automatic save-on-victory) updates the same
// entry instead of duplicating it, same as the old localStorage version.
app.post('/api/league/:name/match', async (req, res) => {
    const leagueKey = leagueKeyFor(req.params.name);
    const ownerUid = ownerUidFrom(req);
    const record = req.body;
    if (!leagueKey) return res.status(400).json({ success: false, error: 'League name required' });
    if (!ownerUid) return res.status(401).json({ success: false, error: 'Login required (missing uid)' });
    if (!record || !record.matchId) return res.status(400).json({ success: false, error: 'Match record with matchId required' });
    if (!leaguesCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    try {
        const doc = await leaguesCollection.findOne({ ownerUid, leagueKey });
        const matches = (doc && doc.matches) || [];
        const idx = matches.findIndex(m => m.matchId === record.matchId);
        if (idx >= 0) matches[idx] = record; else matches.push(record);
        await leaguesCollection.updateOne(
            { ownerUid, leagueKey },
            { $set: { ownerUid, leagueKey, displayName: (req.params.name || '').trim(), matches, updatedAt: Date.now() } },
            { upsert: true }
        );
        res.json({ success: true, matches });
    } catch (err) {
        console.log('League save error:', err);
        res.status(500).json({ success: false, error: 'Could not save match' });
    }
});

// Removes one match from a league.
app.delete('/api/league/:name/match/:matchId', async (req, res) => {
    const leagueKey = leagueKeyFor(req.params.name);
    const ownerUid = ownerUidFrom(req);
    if (!leagueKey) return res.status(400).json({ success: false, error: 'League name required' });
    if (!ownerUid) return res.status(401).json({ success: false, error: 'Login required (missing uid)' });
    if (!leaguesCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    try {
        const doc = await leaguesCollection.findOne({ ownerUid, leagueKey });
        const matches = ((doc && doc.matches) || []).filter(m => m.matchId !== req.params.matchId);
        await leaguesCollection.updateOne({ ownerUid, leagueKey }, { $set: { matches, updatedAt: Date.now() } });
        res.json({ success: true, matches });
    } catch (err) {
        console.log('League delete error:', err);
        res.status(500).json({ success: false, error: 'Could not delete match' });
    }
});

// ================================================================
// 🌐 PUBLIC SCORECARD SYSTEM
// Read-only, token-based public access to tournament & standalone match
// data. Builds entirely on the existing `leagues` collection (tournaments
// and single matches are both already permanently stored there, upserted
// by permanent matchId — see /api/league/:name/match above) — no
// duplicate data store, no risk of drifting from the admin panel's source
// of truth.
//
// Security model: public viewers never see ownerUid or any other
// internal id. Tournaments are addressed by a random, permanent
// `publicToken` minted once (via /api/league/:name/public-link) and
// stored on the league doc. Standalone matches are addressed by the
// match's own permanent matchId (already a crypto-random UUID minted
// client-side in cricket-panel.html's ensureTournamentMatchId()) — no
// extra token needed there. Every /api/public/* route strips ownerUid
// before responding.
// ================================================================
function generatePublicToken() {
    return crypto.randomBytes(9).toString('base64url'); // ~12 chars, URL-safe
}

// Real overs string ("12.4" = 12 overs + 4 balls) -> float overs, for NRR.
function oversToFloat(overs) {
    const parts = String(overs || '0.0').split('.');
    const o = parseInt(parts[0], 10) || 0;
    const b = parseInt(parts[1], 10) || 0;
    return o + (b / 6);
}
function fmtOversLike(o, b) { return `${o || 0}.${b || 0}`; }

// Standard cricket points table: 2 pts win, 1 pt tie, 0 loss/no-result.
// NRR = (runs scored / overs faced) - (runs conceded / overs bowled),
// summed across every match saved under this tournament so far.
function computePointsTable(matches) {
    const table = {}; // key: lowercased team name -> row
    const ensure = (name) => {
        const key = (name || '').trim().toLowerCase();
        if (!key) return null;
        if (!table[key]) {
            table[key] = {
                team: (name || '').trim(), played: 0, won: 0, lost: 0, tied: 0, noResult: 0,
                points: 0, runsFor: 0, oversFor: 0, runsAgainst: 0, oversAgainst: 0
            };
        }
        return table[key];
    };
    matches.forEach(m => {
        const rowA = ensure(m.teamA && m.teamA.name);
        const rowB = ensure(m.teamB && m.teamB.name);
        if (!rowA || !rowB) return;
        const scoreA = m.scoreA || { runs: 0, overs: '0.0' };
        const scoreB = m.scoreB || { runs: 0, overs: '0.0' };

        rowA.played++; rowB.played++;
        rowA.runsFor += scoreA.runs || 0; rowA.oversFor += oversToFloat(scoreA.overs);
        rowA.runsAgainst += scoreB.runs || 0; rowA.oversAgainst += oversToFloat(scoreB.overs);
        rowB.runsFor += scoreB.runs || 0; rowB.oversFor += oversToFloat(scoreB.overs);
        rowB.runsAgainst += scoreA.runs || 0; rowB.oversAgainst += oversToFloat(scoreA.overs);

        if (m.winningTeam === 'A') { rowA.won++; rowA.points += 2; rowB.lost++; }
        else if (m.winningTeam === 'B') { rowB.won++; rowB.points += 2; rowA.lost++; }
        else if (m.winningTeam === 'TIE') { rowA.tied++; rowB.tied++; rowA.points += 1; rowB.points += 1; }
        else { rowA.noResult++; rowB.noResult++; } // still in progress / no result recorded
    });
    return Object.values(table).map(r => ({
        ...r,
        nrr: Number((((r.oversFor > 0 ? r.runsFor / r.oversFor : 0) - (r.oversAgainst > 0 ? r.runsAgainst / r.oversAgainst : 0))).toFixed(3))
    })).sort((a, b) => (b.points - a.points) || (b.nrr - a.nrr));
}

// Batting/bowling leaderboards aggregated from every saved match's
// battingCard/bowlingCard — the same full scorecards already persisted
// per match, just rolled up across the whole tournament.
function computeLeaderboards(matches) {
    const batters = {};
    const bowlers = {};
    matches.forEach(m => {
        ['A', 'B'].forEach(k => {
            (m.battingCard && m.battingCard[k] || []).forEach(b => {
                if (!b || !b.name) return;
                const key = b.name.trim().toLowerCase();
                if (!batters[key]) batters[key] = { name: b.name.trim(), innings: 0, runs: 0, balls: 0, fours: 0, sixes: 0, fifties: 0, hundreds: 0, highScore: 0 };
                const row = batters[key];
                row.innings++; row.runs += b.runs || 0; row.balls += b.balls || 0;
                row.fours += b.fours || 0; row.sixes += b.sixes || 0;
                if ((b.runs || 0) > row.highScore) row.highScore = b.runs || 0;
                if ((b.runs || 0) >= 100) row.hundreds++;
                else if ((b.runs || 0) >= 50) row.fifties++;
            });
            (m.bowlingCard && m.bowlingCard[k] || []).forEach(b => {
                if (!b || !b.name) return;
                const key = b.name.trim().toLowerCase();
                if (!bowlers[key]) bowlers[key] = { name: b.name.trim(), innings: 0, overs: 0, runs: 0, wickets: 0, bestFigures: '0/0' };
                const row = bowlers[key];
                row.innings++; row.overs += oversToFloat(fmtOversLike(b.overs, b.balls)); row.runs += b.runs || 0; row.wickets += b.wickets || 0;
                const [bw, br] = row.bestFigures.split('/').map(Number);
                if ((b.wickets || 0) > bw || ((b.wickets || 0) === bw && (b.runs || 0) < br)) row.bestFigures = `${b.wickets || 0}/${b.runs || 0}`;
            });
        });
    });
    const topRuns = Object.values(batters).map(r => ({ ...r, average: r.innings ? (r.runs / r.innings).toFixed(2) : '0.00', strikeRate: r.balls ? ((r.runs / r.balls) * 100).toFixed(2) : '0.00' }))
        .sort((a, b) => b.runs - a.runs).slice(0, 15);
    const topWickets = Object.values(bowlers).map(r => ({ ...r, overs: Number(r.overs.toFixed(1)), economy: r.overs ? (r.runs / r.overs).toFixed(2) : '0.00' }))
        .sort((a, b) => (b.wickets - a.wickets) || (a.runs - b.runs)).slice(0, 15);
    return { topRuns, topWickets };
}

// ================================================================
// 🔗 PLAYER IDENTITY FOR CLIPS & STATS
// The codebase already has a de-facto global player key: computeLeaderboards
// above keys every batter/bowler by `name.trim().toLowerCase()` so the same
// player rolls up correctly across every match saved under a tournament.
// We reuse that exact convention (rather than inventing a separate players
// collection/ID) so a player is automatically the same identity in clips,
// match stats, tournament stats and career stats — and requires no schema
// migration of anything already saved.
// ================================================================
function playerKey(name) {
    return String(name || '').trim().toLowerCase() || null;
}

// Resolves which owner a matchId belongs to, without requiring the caller
// to already know it. Fast path: the client can pass `uid` directly (same
// trust level as ownerUidFrom() above — see the comment on that function).
// Fallback: search leaguesCollection for whichever league (tournament OR
// the reserved __single_matches__ league) has this matchId saved — this
// works with ZERO client changes since every match is already saved there
// by matchId. Used to stamp clips/balls with an ownerUid so a player's
// clips/stats can be queried across their whole account ("career"), not
// just within one match.
const ownerUidByMatchCache = new Map(); // small in-memory memo; matchId -> ownerUid
async function resolveOwnerUidForMatch(matchId, hintUid) {
    if (hintUid) { ownerUidByMatchCache.set(matchId, hintUid); return hintUid; }
    if (ownerUidByMatchCache.has(matchId)) return ownerUidByMatchCache.get(matchId);
    if (!leaguesCollection) return null;
    try {
        const doc = await leaguesCollection.findOne(
            { 'matches.matchId': matchId },
            { projection: { ownerUid: 1 } }
        );
        const uid = (doc && doc.ownerUid) || null;
        if (uid) ownerUidByMatchCache.set(matchId, uid);
        return uid;
    } catch (err) {
        console.log('resolveOwnerUidForMatch error:', err);
        return null;
    }
}

// Looks up the canonical ball (written by the `logBall` socket handler,
// the permanent source of truth) that a requested clip's window is centred
// on, so the clip can be linked to real player identities/dismissal data
// instead of trusting only whatever the panel happened to send as ballMeta.
async function findCanonicalBall(matchId, ballMeta) {
    if (!ballsCollection || !ballMeta) return null;
    const query = { matchId };
    if (ballMeta.innings !== undefined) query.innings = ballMeta.innings;
    if (ballMeta.over !== undefined) query.over = ballMeta.over;
    if (ballMeta.ballInOver !== undefined) query.ballInOver = ballMeta.ballInOver;
    if (Object.keys(query).length <= 1) return null; // nothing specific enough to match on
    try {
        // Most-recent match on (over, ballInOver): guards against the rare
        // case a correction re-logged the same ball, or innings wasn't sent.
        return await ballsCollection.find(query).sort({ timestamp: -1 }).limit(1).next();
    } catch (err) {
        console.log('findCanonicalBall error:', err);
        return null;
    }
}

// Mint (or fetch, if already minted) a tournament's permanent public
// token. Idempotent — calling it again for the same tournament always
// returns the same token, so a link the operator already shared never
// breaks.
app.post('/api/league/:name/public-link', async (req, res) => {
    const leagueKey = leagueKeyFor(req.params.name);
    const ownerUid = ownerUidFrom(req);
    if (!leagueKey) return res.status(400).json({ success: false, error: 'League name required' });
    if (!ownerUid) return res.status(401).json({ success: false, error: 'Login required (missing uid)' });
    if (leagueKey === SINGLE_MATCHES_LEAGUE_KEY) return res.status(400).json({ success: false, error: 'Single matches get their own link per match, not a collection link' });
    if (!leaguesCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    try {
        const existing = await leaguesCollection.findOne({ ownerUid, leagueKey });
        if (existing && existing.publicToken) {
            return res.json({ success: true, token: existing.publicToken, url: `/score/tournament/${existing.publicToken}` });
        }
        const token = generatePublicToken();
        await leaguesCollection.updateOne(
            { ownerUid, leagueKey },
            { $set: { ownerUid, leagueKey, displayName: (req.params.name || '').trim(), publicToken: token, updatedAt: Date.now() }, $setOnInsert: { matches: [] } },
            { upsert: true }
        );
        res.json({ success: true, token, url: `/score/tournament/${token}` });
    } catch (err) {
        console.log('Public link creation error:', err);
        res.status(500).json({ success: false, error: 'Could not create public link' });
    }
});

// "Which match is currently live" pointer for a tournament's public
// portal — the panel calls this when a tournament match starts/stops
// being scored. Deliberately separate from the /match save route: this
// never touches the permanent matches[] array, so it can never corrupt
// or overwrite saved match data even if it fails or races.
app.post('/api/league/:name/live-status', async (req, res) => {
    const leagueKey = leagueKeyFor(req.params.name);
    const ownerUid = ownerUidFrom(req);
    if (!leagueKey) return res.status(400).json({ success: false, error: 'League name required' });
    if (!ownerUid) return res.status(401).json({ success: false, error: 'Login required (missing uid)' });
    if (!leaguesCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    const { roomId, matchId, active } = req.body || {};
    try {
        await leaguesCollection.updateOne(
            { ownerUid, leagueKey },
            { $set: active === false
                ? { liveRoomId: null, liveMatchId: null, updatedAt: Date.now() }
                : { liveRoomId: roomId || null, liveMatchId: matchId || null, updatedAt: Date.now() } },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (err) {
        console.log('Live-status update error:', err);
        res.status(500).json({ success: false });
    }
});

// ---- PUBLIC, READ-ONLY endpoints — no uid/auth, the token itself is the
// access control, and ownerUid is never included in any response. -------

// Full tournament portal payload: sanitized match list + live pointer +
// points table + leaderboards, all computed fresh from the same
// permanent matches[] the admin panel writes to.
app.get('/api/public/tournament/:token', async (req, res) => {
    if (!leaguesCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    try {
        const doc = await leaguesCollection.findOne({ publicToken: req.params.token });
        if (!doc) return res.status(404).json({ success: false, error: 'Tournament not found' });
        const matches = (doc.matches || []).slice().sort((a, b) => new Date(a.savedAt || 0) - new Date(b.savedAt || 0));
        res.json({
            success: true,
            displayName: doc.displayName || '',
            matches,
            live: { roomId: doc.liveRoomId || null, matchId: doc.liveMatchId || null },
            pointsTable: computePointsTable(matches),
            leaderboards: computeLeaderboards(matches)
        });
    } catch (err) {
        console.log('Public tournament fetch error:', err);
        res.status(500).json({ success: false, error: 'Could not load tournament' });
    }
});

// One specific match's full scorecard within a tournament.
app.get('/api/public/tournament/:token/match/:matchId', async (req, res) => {
    if (!leaguesCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    try {
        const doc = await leaguesCollection.findOne({ publicToken: req.params.token });
        if (!doc) return res.status(404).json({ success: false, error: 'Tournament not found' });
        const match = (doc.matches || []).find(m => m.matchId === req.params.matchId);
        if (!match) return res.status(404).json({ success: false, error: 'Match not found' });
        res.json({ success: true, displayName: doc.displayName || '', match });
    } catch (err) {
        console.log('Public tournament match fetch error:', err);
        res.status(500).json({ success: false, error: 'Could not load match' });
    }
});

// A standalone match's public page, addressed by its own permanent
// matchId (or the live "connection id"/roomId it was broadcast under
// before it was ever saved). Deliberately searches across ALL owners'
// __single_matches__ docs by matchId/roomId rather than needing an
// ownerUid, since a public link never carries one.
app.get('/api/public/match/:id', async (req, res) => {
    if (!leaguesCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    const id = req.params.id;
    try {
        const doc = await leaguesCollection.findOne({
            leagueKey: SINGLE_MATCHES_LEAGUE_KEY,
            $or: [{ 'matches.matchId': id }, { 'matches.roomId': id }]
        });
        const match = doc && (doc.matches || []).find(m => m.matchId === id || m.roomId === id);
        if (match) return res.json({ success: true, match });
        // Not saved yet — either still being played (public page falls back
        // to a live socket join using this id) or the id is simply wrong.
        res.json({ success: true, match: null, roomId: id });
    } catch (err) {
        console.log('Public match fetch error:', err);
        res.status(500).json({ success: false, error: 'Could not load match' });
    }
});

// ================================================================
// 🎬 CLIPS API — read-only, metadata-first (per REQUIREMENT: scorecard
// loads text/stats + clip metadata only; the actual video is fetched only
// when the user taps WATCH/DOWNLOAD). Every route here returns clipId +
// small fields + a playable URL — never raw file paths, R2 keys, or Drive
// credentials. matchId/strikerKey/bowlerKey/battingTeam are all indexed
// (see connectMongo above) so these stay fast even with thousands of
// clips across a tournament.
// ================================================================

// Trims a raw clip Mongo doc down to exactly what the frontend needs.
function serializeClip(c) {
    return {
        clipId: c._id.toString(),
        matchId: c.matchId,
        eventType: c.eventType,                 // 'FOUR' | 'SIX' | 'WICKET'
        dismissalType: c.dismissalType || null,  // 'Bowled' | 'Caught' | 'LBW' | 'Run Out' | 'Stumped' | 'Hit Wicket' | ...
        over: c.over, ballInOver: c.ballInOver, innings: c.innings,
        runs: c.runs, battingTeam: c.battingTeam,
        striker: c.strikerName || null, bowler: c.bowlerName || null,
        nonStriker: c.nonStrikerName || null, fielder: c.fielderName || null,
        ready: !!(c.r2Url || c.driveUrl),
        watchUrl: `/api/clips/${c._id}/watch`,
        downloadUrl: `/api/clips/${c._id}/download`,
        createdAt: c.createdAt
    };
}

// GET /api/clips/match/:matchId?type=FOUR|SIX|WICKET&playerKey=...&team=A|B&limit=&skip=
app.get('/api/clips/match/:matchId', async (req, res) => {
    if (!clipsCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    const matchId = safeMatchId(req.params.matchId);
    const query = { matchId };
    if (req.query.type) query.eventType = String(req.query.type).toUpperCase();
    if (req.query.team) query.battingTeam = String(req.query.team).toUpperCase();
    if (req.query.playerKey) {
        const pk = playerKey(req.query.playerKey);
        query.$or = [{ strikerKey: pk }, { bowlerKey: pk }, { fielderKey: pk }];
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    try {
        const clips = await clipsCollection.find(query).sort({ over: 1, ballInOver: 1 }).skip(skip).limit(limit).toArray();
        res.json({ success: true, clips: clips.map(serializeClip) });
    } catch (err) {
        console.log('Clips-by-match fetch error:', err);
        res.status(500).json({ success: false, error: 'Could not load clips' });
    }
});

// GET /api/clips/team/:matchId/:teamKey — every team wicket clip (run outs,
// catches, LBW, bowled, stumped, hit wicket, ...) for that side in this match.
app.get('/api/clips/team/:matchId/:teamKey', async (req, res) => {
    if (!clipsCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    const matchId = safeMatchId(req.params.matchId);
    const teamKey = String(req.params.teamKey || '').toUpperCase();
    try {
        const clips = await clipsCollection.find({ matchId, battingTeam: teamKey, eventType: 'WICKET' })
            .sort({ over: 1, ballInOver: 1 }).toArray();
        res.json({ success: true, clips: clips.map(serializeClip) });
    } catch (err) {
        console.log('Team-clips fetch error:', err);
        res.status(500).json({ success: false, error: 'Could not load team clips' });
    }
});

// GET /api/clips/player/:playerKey?scope=match|tournament|career&matchId=&leagueName=&uid=
// Returns clips grouped the way the scorecard displays them (spec section 4):
// batting: { fours, sixes, dismissal }, bowling: { wickets }.
app.get('/api/clips/player/:playerKey', async (req, res) => {
    if (!clipsCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    const pk = playerKey(req.params.playerKey);
    if (!pk) return res.status(400).json({ success: false, error: 'playerKey required' });
    const scope = req.query.scope || 'match';

    let matchFilter = null; // null = no matchId restriction (career, or tournament resolved below)
    try {
        if (scope === 'match') {
            if (!req.query.matchId) return res.status(400).json({ success: false, error: 'matchId required for scope=match' });
            matchFilter = { $in: [safeMatchId(req.query.matchId)] };
        } else if (scope === 'tournament') {
            const leagueKey = leagueKeyFor(req.query.leagueName);
            const ownerUid = ownerUidFrom(req);
            if (!leagueKey || !ownerUid || !leaguesCollection) return res.status(400).json({ success: false, error: 'leagueName and uid required for scope=tournament' });
            const doc = await leaguesCollection.findOne({ ownerUid, leagueKey }, { projection: { 'matches.matchId': 1 } });
            matchFilter = { $in: ((doc && doc.matches) || []).map(m => m.matchId) };
        }
        // scope === 'career' (or 'season', best-effort — no explicit season
        // field exists on matches yet, so career and season currently return
        // the same set; filter by year client-side using each clip's createdAt
        // until a real season field is added) — no matchId restriction, just
        // ownerUid if we have one, so results stay scoped to one account.

        const base = { $or: [{ strikerKey: pk }, { bowlerKey: pk }, { fielderKey: pk }] };
        if (matchFilter) base.matchId = matchFilter;
        const ownerUid = ownerUidFrom(req);
        if (!matchFilter && ownerUid) base.ownerUid = ownerUid;

        const clips = await clipsCollection.find(base).sort({ createdAt: -1 }).limit(300).toArray();
        const out = {
            fours: [], sixes: [], dismissal: [], wickets: []
        };
        clips.forEach(c => {
            const s = serializeClip(c);
            if (c.strikerKey === pk && c.eventType === 'FOUR') out.fours.push(s);
            else if (c.strikerKey === pk && c.eventType === 'SIX') out.sixes.push(s);
            else if (c.strikerKey === pk && c.eventType === 'WICKET') out.dismissal.push(s);
            if (c.bowlerKey === pk && c.eventType === 'WICKET') out.wickets.push(s);
        });
        res.json({ success: true, playerKey: pk, scope, batting: { fours: out.fours, sixes: out.sixes, dismissal: out.dismissal }, bowling: { wickets: out.wickets } });
    } catch (err) {
        console.log('Player-clips fetch error:', err);
        res.status(500).json({ success: false, error: 'Could not load player clips' });
    }
});

// Resolves a clip's actual playable URL server-side — the frontend never
// talks to R2/Drive directly and no credentials/keys ever reach the client.
async function resolvePlayableClip(clipId) {
    if (!clipsCollection) return null;
    const { ObjectId } = require('mongodb');
    let _id;
    try { _id = new ObjectId(clipId); } catch { return null; }
    return clipsCollection.findOne({ _id });
}

// GET /api/clips/:clipId/watch — plays inline in the scorecard's own video
// modal. R2 is preferred (public CDN URL, cheap to redirect to, cached at
// the edge — see uploadClipToR2 above); if only Drive has it, we proxy the
// bytes through our own server instead of sending the user to Drive's UI.
app.get('/api/clips/:clipId/watch', async (req, res) => {
    try {
        const clip = await resolvePlayableClip(req.params.clipId);
        if (!clip) return res.status(404).json({ success: false, error: 'Clip not found' });
        if (clip.r2Url) return res.redirect(302, clip.r2Url);
        if (clip.driveFileId && driveClient) {
            const driveRes = await driveClient.files.get({ fileId: clip.driveFileId, alt: 'media' }, { responseType: 'stream' });
            res.setHeader('Content-Type', 'video/mp4');
            driveRes.data.on('error', () => res.end());
            return driveRes.data.pipe(res);
        }
        res.status(202).json({ success: false, error: 'Clip is still processing — try again shortly' });
    } catch (err) {
        console.log('Clip watch error:', err);
        res.status(500).json({ success: false, error: 'Could not load clip' });
    }
});

// GET /api/clips/:clipId/download — forces a same-origin download instead
// of opening the file's Drive/R2 page. R2 clips are fetched server-side and
// re-streamed with Content-Disposition: attachment (R2 itself doesn't set
// that header on plain object URLs); Drive clips use the same proxy path
// as /watch, just with the attachment header added.
app.get('/api/clips/:clipId/download', async (req, res) => {
    try {
        const clip = await resolvePlayableClip(req.params.clipId);
        if (!clip) return res.status(404).json({ success: false, error: 'Clip not found' });
        const filename = `${clip.eventType || 'clip'}_over-${clip.over ?? ''}.${clip.ballInOver ?? ''}_${clip.strikerName || clip.bowlerName || ''}.mp4`.replace(/\s+/g, '-');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'video/mp4');
        if (clip.r2Url) {
            const r2Res = await fetch(clip.r2Url);
            if (!r2Res.ok || !r2Res.body) return res.status(502).json({ success: false, error: 'Could not fetch clip' });
            const { Readable } = require('stream');
            return Readable.fromWeb(r2Res.body).pipe(res);
        }
        if (clip.driveFileId && driveClient) {
            const driveRes = await driveClient.files.get({ fileId: clip.driveFileId, alt: 'media' }, { responseType: 'stream' });
            driveRes.data.on('error', () => res.end());
            return driveRes.data.pipe(res);
        }
        res.status(202).json({ success: false, error: 'Clip is still processing — try again shortly' });
    } catch (err) {
        console.log('Clip download error:', err);
        res.status(500).json({ success: false, error: 'Could not download clip' });
    }
});

// ================================================================
// 📊 PLAYER STATS API — MATCH scope aggregates straight from ballsCollection
// (the permanent, correction-safe ball-by-ball log), so it's always
// recomputed fresh rather than cached/stale (REQUIREMENT #13). TOURNAMENT/
// CAREER scope reuses the same battingCard/bowlingCard rollup logic as
// computeLeaderboards above, filtered to one player, across every match
// saved for that league (tournament) or every league this owner has
// (career) — same global playerKey identity throughout.
// ================================================================

// Best-effort batting/bowling line for one player from one match's raw
// balls. Cricket-rule note: byes/leg-byes add to the team total but are
// NOT credited as batsman runs; wides are NOT a faced ball. Run-outs are
// NOT credited as a bowler wicket. Adjust here if cricket-panel.html's
// `kind`/`dismissal.type` strings differ from the values assumed below.
async function computeMatchPlayerStats(matchId, pk) {
    const balls = await ballsCollection.find({ matchId, $or: [{ strikerKey: pk }, { bowlerKey: pk }] }).toArray();
    const bat = { runs: 0, balls: 0, fours: 0, sixes: 0, out: false };
    const bowl = { balls: 0, runs: 0, wickets: 0, maidens: 0 };
    balls.forEach(b => {
        if (b.strikerKey === pk && b.kind !== 'Wd') {
            bat.balls++;
            if (b.kind !== 'B' && b.kind !== 'LB') bat.runs += b.runs || 0;
            if (b.kind === '4') bat.fours++;
            if (b.kind === '6') bat.sixes++;
        }
        if (b.strikerKey === pk && b.dismissal) bat.out = true;
        if (b.bowlerKey === pk && b.kind !== 'B' && b.kind !== 'LB') {
            if (b.kind !== 'Wd') bowl.balls++;
            bowl.runs += b.runs || 0;
            if (b.dismissal && b.dismissal.type && b.dismissal.type.toLowerCase() !== 'run out') bowl.wickets++;
        }
    });
    return {
        batting: { runs: bat.runs, balls: bat.balls, fours: bat.fours, sixes: bat.sixes, out: bat.out, strikeRate: bat.balls ? Number(((bat.runs / bat.balls) * 100).toFixed(2)) : 0 },
        bowling: { overs: `${Math.floor(bowl.balls / 6)}.${bowl.balls % 6}`, runs: bowl.runs, wickets: bowl.wickets, economy: bowl.balls ? Number((bowl.runs / (bowl.balls / 6)).toFixed(2)) : 0 }
    };
}

// Filters computeLeaderboards' per-match rollup down to a single player,
// across whatever set of saved matches[] is passed in (one tournament, or
// every league belonging to an owner for career).
function computeSinglePlayerRollup(matches, pk) {
    const { topRuns, topWickets } = computeLeaderboards(matches);
    return {
        batting: topRuns.find(r => playerKey(r.name) === pk) || null,
        bowling: topWickets.find(r => playerKey(r.name) === pk) || null
    };
}

// GET /api/stats/player/:playerKey?scope=match|tournament|career&matchId=&leagueName=&uid=
app.get('/api/stats/player/:playerKey', async (req, res) => {
    const pk = playerKey(req.params.playerKey);
    if (!pk) return res.status(400).json({ success: false, error: 'playerKey required' });
    const scope = req.query.scope || 'match';
    try {
        if (scope === 'match') {
            if (!ballsCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
            if (!req.query.matchId) return res.status(400).json({ success: false, error: 'matchId required for scope=match' });
            const stats = await computeMatchPlayerStats(safeMatchId(req.query.matchId), pk);
            return res.json({ success: true, scope, playerKey: pk, ...stats });
        }
        if (!leaguesCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
        if (scope === 'tournament') {
            const leagueKey = leagueKeyFor(req.query.leagueName);
            const ownerUid = ownerUidFrom(req);
            if (!leagueKey || !ownerUid) return res.status(400).json({ success: false, error: 'leagueName and uid required for scope=tournament' });
            const doc = await leaguesCollection.findOne({ ownerUid, leagueKey });
            const stats = computeSinglePlayerRollup((doc && doc.matches) || [], pk);
            return res.json({ success: true, scope, playerKey: pk, ...stats });
        }
        // career (and season, best-effort — see note on the clips endpoint
        // above): every match across every league this owner has saved.
        const ownerUid = ownerUidFrom(req);
        if (!ownerUid) return res.status(400).json({ success: false, error: 'uid required for scope=career' });
        const leagues = await leaguesCollection.find({ ownerUid }).project({ matches: 1 }).toArray();
        const allMatches = leagues.flatMap(l => l.matches || []);
        const stats = computeSinglePlayerRollup(allMatches, pk);
        res.json({ success: true, scope, playerKey: pk, ...stats });
    } catch (err) {
        console.log('Player-stats fetch error:', err);
        res.status(500).json({ success: false, error: 'Could not load player stats' });
    }
});

// ================================================================
// 💬 SUPPORT CHATBOT — answers visitor questions on the marketing site
// (index.html) using Claude. Grounded with a short product brief so it
// sticks to real Scorvix features/FAQ instead of guessing at pricing or
// capabilities that don't exist. Requires ANTHROPIC_API_KEY to be set;
// safe no-op (friendly error) if it isn't, same pattern as the other
// optional integrations above.
// ================================================================
const SUPPORT_SYSTEM_PROMPT = `You are the support assistant embedded on Scorvix's website (a browser-based broadcast graphics tool for live sports scoreboards/overlays).

Ground truth about Scorvix — only state things from this brief; if asked something not covered here (pricing, roadmap dates, something you're unsure of), say you're not certain and suggest the visitor reach out to the team directly rather than guessing:
- What it is: a browser-based control panel + browser-source overlay for live sports scoreboards, controllable from a phone or laptop, no software install.
- Sports supported today: Table Tennis, Football, Cricket (more sports planned).
- Setup: sign in with Google, open the control panel, paste the unique overlay link into streaming software as a browser source.
- Works with: OBS Studio, vMix, Streamlabs, or any software supporting browser-source inputs.
- Live updates: every change in the control panel (score, timer, team colors, logos) reflects on the overlay instantly.
- Security: each user signs in with Google and gets a private, unique overlay room only they control.
- Cricket-specific: ball-by-ball scoring, batting/bowling cards, Excel export, and a League/Tournament mode that tracks stats across multiple matches saved under the same league name.

Style: concise, friendly, plain language, no more than a few sentences unless the visitor asks for detail. Never invent features, pricing, or timelines not listed above.`;

app.post('/api/support-chat', async (req, res) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        return res.status(503).json({ success: false, error: 'Support chat is not configured yet.' });
    }
    const incoming = Array.isArray(req.body.messages) ? req.body.messages : [];
    if (!incoming.length) return res.status(400).json({ success: false, error: 'messages required' });

    // Keep only the last 12 turns and hard-cap message length — visitor
    // input, never trust it blindly for size going into an LLM call.
    const messages = incoming.slice(-12).map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content || '').slice(0, 2000)
    }));

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-6',
                max_tokens: 400,
                system: SUPPORT_SYSTEM_PROMPT,
                messages
            })
        });
        const data = await response.json();
        if (!response.ok) {
            console.log('Support chat API error:', data);
            return res.status(502).json({ success: false, error: 'Support chat is temporarily unavailable.' });
        }
        const reply = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        res.json({ success: true, reply: reply || "Sorry, I didn't catch that — could you rephrase?" });
    } catch (err) {
        console.log('Support chat error:', err);
        res.status(500).json({ success: false, error: 'Support chat is temporarily unavailable.' });
    }
});

// ================================================================
// 🎯 SPORT TEMPLATES — public read, owner-only write.
// index.html's loadDynamicSports() has been calling /api/get-sports
// since before this route existed (it was 404ing silently). This is
// the real implementation, backed by the new `templates` Mongo
// collection — no mock data, just genuinely empty until the owner
// adds one from the Admin Portal.
// ================================================================
app.get('/api/get-sports', async (req, res) => {
    if (!templatesCollection) return res.json([]);
    try {
        const sports = await templatesCollection.find({}, { projection: { panelCode: 0, overlayCode: 0, overlays: 0 } }).sort({ createdAt: 1 }).toArray();
        res.json(sports.map(s => ({ name: s.name, icon: s.icon, slug: s.slug })));
    } catch (err) {
        console.log('get-sports error:', err);
        res.json([]);
    }
});

// ================================================================
// 🛡️ OWNER ADMIN PORTAL API — every route below requires requireOwner.
// A normal user hitting any of these (even with a valid login, even by
// guessing the URL) gets a 403 Access Denied — this is the real
// server-side enforcement the frontend button/page cannot substitute for.
// ================================================================
const adminRouter = express.Router();
adminRouter.use(requireOwner);

// ---- Dashboard ----
adminRouter.get('/dashboard', async (req, res) => {
    try {
        const [userList, leagueCount, matchCount, ballCount, templateCount, logEventCount] = await Promise.all([
            admin.auth().listUsers(1000).catch(() => ({ users: [] })),
            leaguesCollection ? leaguesCollection.countDocuments() : 0,
            matchesCollection ? matchesCollection.countDocuments() : 0,
            ballsCollection ? ballsCollection.countDocuments() : 0,
            templatesCollection ? templatesCollection.countDocuments() : 0,
            db.collection('analytics_logs').get().then(s => s.size).catch(() => 0)
        ]);
        const users = userList.users || [];
        const now = Date.now();
        const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
        const newUsers30d = users.filter(u => new Date(u.metadata.creationTime).getTime() > now - THIRTY_DAYS).length;
        const activeUsers30d = users.filter(u => u.metadata.lastSignInTime && new Date(u.metadata.lastSignInTime).getTime() > now - THIRTY_DAYS).length;
        res.json({
            success: true,
            totalUsers: users.length,
            newUsers30d,
            activeUsers30d,
            disabledUsers: users.filter(u => u.disabled).length,
            leagues: leagueCount,
            matches: matchCount,
            ballsLogged: ballCount,
            templates: templateCount,
            activityEvents: logEventCount,
            liveConnections: io.engine.clientsCount
        });
    } catch (err) {
        console.log('Admin dashboard error:', err);
        res.status(500).json({ success: false, error: 'Could not load dashboard' });
    }
});

// ---- Users ----
adminRouter.get('/users', async (req, res) => {
    try {
        const pageToken = req.query.pageToken || undefined;
        const result = await admin.auth().listUsers(50, pageToken);
        res.json({
            success: true,
            nextPageToken: result.pageToken || null,
            users: result.users.map(u => ({
                uid: u.uid, email: u.email, displayName: u.displayName || null,
                photoURL: u.photoURL || null, disabled: u.disabled,
                createdAt: u.metadata.creationTime, lastSignInAt: u.metadata.lastSignInTime || null
            }))
        });
    } catch (err) {
        console.log('Admin users list error:', err);
        res.status(500).json({ success: false, error: 'Could not load users' });
    }
});

adminRouter.get('/users/search', async (req, res) => {
    const email = (req.query.email || '').trim();
    if (!email) return res.status(400).json({ success: false, error: 'email required' });
    try {
        const u = await admin.auth().getUserByEmail(email);
        res.json({ success: true, user: { uid: u.uid, email: u.email, displayName: u.displayName || null, photoURL: u.photoURL || null, disabled: u.disabled, createdAt: u.metadata.creationTime, lastSignInAt: u.metadata.lastSignInTime || null } });
    } catch (err) {
        res.status(404).json({ success: false, error: 'No user with that email' });
    }
});

adminRouter.post('/users/:uid/disable', async (req, res) => {
    if (req.params.uid === req.ownerUid) return res.status(400).json({ success: false, error: "You can't disable your own owner account" });
    try {
        await admin.auth().updateUser(req.params.uid, { disabled: true });
        await logAuditAction(req.ownerEmail, 'Suspend user', req.params.uid, { disabled: false }, { disabled: true });
        res.json({ success: true });
    } catch (err) {
        console.log('Disable user error:', err);
        res.status(500).json({ success: false, error: 'Could not disable user' });
    }
});

adminRouter.post('/users/:uid/enable', async (req, res) => {
    try {
        await admin.auth().updateUser(req.params.uid, { disabled: false });
        await logAuditAction(req.ownerEmail, 'Reactivate user', req.params.uid, { disabled: true }, { disabled: false });
        res.json({ success: true });
    } catch (err) {
        console.log('Enable user error:', err);
        res.status(500).json({ success: false, error: 'Could not enable user' });
    }
});

adminRouter.delete('/users/:uid', async (req, res) => {
    if (req.params.uid === req.ownerUid) return res.status(400).json({ success: false, error: "You can't delete your own owner account" });
    try {
        await admin.auth().deleteUser(req.params.uid);
        await logAuditAction(req.ownerEmail, 'Delete user', req.params.uid, null, null);
        res.json({ success: true });
    } catch (err) {
        console.log('Delete user error:', err);
        res.status(500).json({ success: false, error: 'Could not delete user' });
    }
});

// ---- Broadcasting / Templates ----
adminRouter.get('/templates', async (req, res) => {
    if (!templatesCollection) return res.json({ success: true, templates: [] });
    try {
        const templates = (await templatesCollection.find({}).sort({ createdAt: -1 }).toArray()).map(normalizeTemplate);
        res.json({ success: true, templates });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Could not load templates' });
    }
});

// A template ("sport") can have MULTIPLE overlays but keeps a single panel.
// Older docs only have a flat `overlayCode` string (no `overlays` array) —
// normalizeTemplate() upgrades those in-memory so every other route can
// assume `overlays` is always an array.
function normalizeTemplate(doc) {
    if (!doc) return doc;
    if (!Array.isArray(doc.overlays)) {
        doc.overlays = doc.overlayCode
            ? [{ id: 'default', name: 'Default', code: doc.overlayCode, published: true, createdAt: doc.createdAt || Date.now() }]
            : [];
    }
    return doc;
}

adminRouter.post('/templates', async (req, res) => {
    const { sportName, sportIcon, panelCode, overlayCode } = req.body || {};
    if (!sportName) return res.status(400).json({ success: false, error: 'sportName required' });
    if (!templatesCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    const slug = String(sportName).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    try {
        const existing = await templatesCollection.findOne({ slug });
        const now = Date.now();
        const overlays = existing ? normalizeTemplate(existing).overlays : [];
        // First save (or re-save with overlay code present) seeds/updates the
        // "Default" overlay so the simple 2-textarea flow keeps working as-is.
        if (overlayCode) {
            const defaultIdx = overlays.findIndex(o => o.id === 'default');
            const defaultOverlay = { id: 'default', name: 'Default', code: overlayCode, published: true, createdAt: now };
            if (defaultIdx >= 0) overlays[defaultIdx] = { ...overlays[defaultIdx], code: overlayCode }; else overlays.unshift(defaultOverlay);
        }
        const doc = {
            name: sportName.trim(), icon: sportIcon || '🎯', slug,
            panelCode: panelCode !== undefined ? panelCode : (existing ? existing.panelCode : ''),
            overlays,
            published: existing ? existing.published : true,
            createdAt: existing ? existing.createdAt : now,
            updatedAt: now
        };
        await templatesCollection.updateOne({ slug }, { $set: doc, $unset: { overlayCode: '' } }, { upsert: true });
        await logAuditAction(req.ownerEmail, existing ? 'Update template' : 'Create template', slug, null, { name: doc.name });
        res.json({ success: true, template: doc });
    } catch (err) {
        console.log('Create template error:', err);
        res.status(500).json({ success: false, error: 'Could not save template' });
    }
});

// ---- Overlays (multiple per sport) ----
adminRouter.post('/templates/:slug/overlays', async (req, res) => {
    if (!templatesCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    const { name, code } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ success: false, error: 'Overlay name required' });
    try {
        const doc = normalizeTemplate(await templatesCollection.findOne({ slug: req.params.slug }));
        if (!doc) return res.status(404).json({ success: false, error: 'Template not found' });
        const overlay = { id: crypto.randomUUID(), name: name.trim(), code: code || '', published: true, createdAt: Date.now() };
        doc.overlays.push(overlay);
        await templatesCollection.updateOne({ slug: req.params.slug }, { $set: { overlays: doc.overlays, updatedAt: Date.now() } });
        await logAuditAction(req.ownerEmail, 'Add overlay', req.params.slug, null, { overlay: overlay.name });
        res.json({ success: true, overlay });
    } catch (err) {
        console.log('Add overlay error:', err);
        res.status(500).json({ success: false, error: 'Could not add overlay' });
    }
});

adminRouter.put('/templates/:slug/overlays/:overlayId', async (req, res) => {
    if (!templatesCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    const { name, code, published } = req.body || {};
    try {
        const doc = normalizeTemplate(await templatesCollection.findOne({ slug: req.params.slug }));
        if (!doc) return res.status(404).json({ success: false, error: 'Template not found' });
        const idx = doc.overlays.findIndex(o => o.id === req.params.overlayId);
        if (idx < 0) return res.status(404).json({ success: false, error: 'Overlay not found' });
        if (name !== undefined) doc.overlays[idx].name = name.trim();
        if (code !== undefined) doc.overlays[idx].code = code;
        if (published !== undefined) doc.overlays[idx].published = !!published;
        await templatesCollection.updateOne({ slug: req.params.slug }, { $set: { overlays: doc.overlays, updatedAt: Date.now() } });
        await logAuditAction(req.ownerEmail, 'Update overlay', req.params.slug, null, { overlay: doc.overlays[idx].name });
        res.json({ success: true, overlay: doc.overlays[idx] });
    } catch (err) {
        console.log('Update overlay error:', err);
        res.status(500).json({ success: false, error: 'Could not update overlay' });
    }
});

adminRouter.delete('/templates/:slug/overlays/:overlayId', async (req, res) => {
    if (!templatesCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    try {
        const doc = normalizeTemplate(await templatesCollection.findOne({ slug: req.params.slug }));
        if (!doc) return res.status(404).json({ success: false, error: 'Template not found' });
        const overlays = doc.overlays.filter(o => o.id !== req.params.overlayId);
        await templatesCollection.updateOne({ slug: req.params.slug }, { $set: { overlays, updatedAt: Date.now() } });
        await logAuditAction(req.ownerEmail, 'Delete overlay', req.params.slug, null, null);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Could not delete overlay' });
    }
});

// ---- Duplicate (clone a whole sport + its overlays under a new name) ----
adminRouter.post('/templates/:slug/duplicate', async (req, res) => {
    if (!templatesCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    const { newName, newIcon } = req.body || {};
    if (!newName || !newName.trim()) return res.status(400).json({ success: false, error: 'New name required' });
    try {
        const src = normalizeTemplate(await templatesCollection.findOne({ slug: req.params.slug }));
        if (!src) return res.status(404).json({ success: false, error: 'Template not found' });
        const slug = String(newName).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const existing = await templatesCollection.findOne({ slug });
        if (existing) return res.status(409).json({ success: false, error: 'A template with that name already exists' });
        const now = Date.now();
        const doc = {
            name: newName.trim(), icon: newIcon || src.icon, slug,
            panelCode: src.panelCode || '',
            overlays: (src.overlays || []).map(o => ({ ...o, id: crypto.randomUUID() })),
            published: false, createdAt: now, updatedAt: now,
            duplicatedFrom: src.slug
        };
        await templatesCollection.insertOne(doc);
        await logAuditAction(req.ownerEmail, 'Duplicate template', slug, null, { from: src.slug, name: doc.name });
        res.json({ success: true, template: doc });
    } catch (err) {
        console.log('Duplicate template error:', err);
        res.status(500).json({ success: false, error: 'Could not duplicate template' });
    }
});

adminRouter.post('/templates/:slug/publish', async (req, res) => {
    if (!templatesCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    const published = !!(req.body && req.body.published);
    try {
        await templatesCollection.updateOne({ slug: req.params.slug }, { $set: { published } });
        await logAuditAction(req.ownerEmail, published ? 'Publish template' : 'Unpublish template', req.params.slug, { published: !published }, { published });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Could not update template' });
    }
});

adminRouter.delete('/templates/:slug', async (req, res) => {
    if (!templatesCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    try {
        await templatesCollection.deleteOne({ slug: req.params.slug });
        await logAuditAction(req.ownerEmail, 'Delete template', req.params.slug, null, null);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Could not delete template' });
    }
});
// Kept for backward-compat with any existing client code calling the
// old (previously missing) route name.
adminRouter.post('/delete-template', async (req, res) => {
    if (!templatesCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    try {
        await templatesCollection.deleteOne({ slug: req.body.slug });
        await logAuditAction(req.ownerEmail, 'Delete template', req.body.slug, null, null);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Could not delete template' });
    }
});

// ---- Cricket Data ----
adminRouter.get('/cricket', async (req, res) => {
    try {
        const [leagues, recentMatches, ballCount] = await Promise.all([
            leaguesCollection ? leaguesCollection.find({}).project({ ownerUid: 1, leagueKey: 1, displayName: 1, matches: 1, updatedAt: 1 }).sort({ updatedAt: -1 }).limit(50).toArray() : [],
            matchesCollection ? matchesCollection.find({}).sort({ recordingStartedAt: -1 }).limit(50).toArray() : [],
            ballsCollection ? ballsCollection.countDocuments() : 0
        ]);
        const tournaments = leagues.map(l => ({
            leagueKey: l.leagueKey, displayName: l.displayName || l.leagueKey,
            ownerUid: l.ownerUid, matchCount: (l.matches || []).length, updatedAt: l.updatedAt || null
        }));
        res.json({ success: true, tournaments, recentMatches, totalBallsLogged: ballCount });
    } catch (err) {
        console.log('Admin cricket data error:', err);
        res.status(500).json({ success: false, error: 'Could not load cricket data' });
    }
});

// ---- Analytics ----
adminRouter.get('/analytics', async (req, res) => {
    try {
        const snap = await db.collection('analytics_logs').get();
        const byDay = {};
        const byAction = {};
        const byOverlay = {};
        snap.forEach(doc => {
            const d = doc.data();
            const day = (d.time || '').split(',')[0] || 'Unknown';
            byDay[day] = (byDay[day] || 0) + 1;
            byAction[d.action || 'Unknown'] = (byAction[d.action || 'Unknown'] || 0) + 1;
            if (d.action === 'Overlay Opened') byOverlay[d.overlay || 'Unknown'] = (byOverlay[d.overlay || 'Unknown'] || 0) + 1;
        });
        res.json({
            success: true,
            totalEvents: snap.size,
            byDay: Object.entries(byDay).map(([date, count]) => ({ date, count })).slice(-30),
            byAction: Object.entries(byAction).map(([action, count]) => ({ action, count })),
            byOverlay: Object.entries(byOverlay).map(([overlay, count]) => ({ overlay, count })).sort((a, b) => b.count - a.count)
        });
    } catch (err) {
        console.log('Admin analytics error:', err);
        res.status(500).json({ success: false, error: 'Could not load analytics' });
    }
});

// ---- System Health ----
const SERVER_STARTED_AT = Date.now();
adminRouter.get('/system-health', async (req, res) => {
    let mongoOk = false;
    try { if (mongoDb) { await mongoDb.command({ ping: 1 }); mongoOk = true; } } catch (e) { mongoOk = false; }
    let firestoreOk = false;
    try { await db.collection('analytics_logs').limit(1).get(); firestoreOk = true; } catch (e) { firestoreOk = false; }
    res.json({
        success: true,
        uptimeSeconds: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
        mongoConnected: mongoOk,
        firestoreConnected: firestoreOk,
        websocketConnections: io.engine.clientsCount,
        activeRecordingSessions: Object.keys(recordingSessions).length,
        driveUploadConfigured: !!driveClient,
        memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024)
    });
});

// ---- Audit Logs ----
adminRouter.get('/audit-logs', async (req, res) => {
    if (!auditLogsCollection) return res.json({ success: true, logs: [] });
    try {
        const logs = await auditLogsCollection.find({}).sort({ timestamp: -1 }).limit(200).toArray();
        res.json({ success: true, logs });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Could not load audit logs' });
    }
});

// ---- Settings (safe global config only — one doc) ----
adminRouter.get('/settings', async (req, res) => {
    if (!settingsCollection) return res.json({ success: true, settings: {} });
    try {
        const doc = await settingsCollection.findOne({ _id: 'global' });
        res.json({ success: true, settings: (doc && doc.values) || {} });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Could not load settings' });
    }
});

adminRouter.post('/settings', async (req, res) => {
    if (!settingsCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    const values = (req.body && req.body.values) || {};
    try {
        const before = await settingsCollection.findOne({ _id: 'global' });
        await settingsCollection.updateOne({ _id: 'global' }, { $set: { values, updatedAt: Date.now() } }, { upsert: true });
        await logAuditAction(req.ownerEmail, 'Update settings', 'global', (before && before.values) || {}, values);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Could not save settings' });
    }
});

app.use('/api/admin', adminRouter);

// Routes
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
// 🛡️ Owner Admin Portal shell. This always serves the static page — it
// contains no data. Every real fact it shows comes from an authenticated
// call to /api/admin/*, which requireOwner enforces server-side above.
// A non-owner opening this URL sees the page's own "Access Denied" state,
// not any admin data.
app.get('/admin', (req, res) => res.sendFile(__dirname + '/admin.html'));
app.get('/overlay', (req, res) => res.sendFile(__dirname + '/overlay.html'));
app.get('/tt-templates', (req, res) => res.sendFile(__dirname + '/tt-templates.html'));
app.get('/tt-panel', (req, res) => res.sendFile(__dirname + '/tt-panel.html'));
app.get('/tt-matchintro', (req, res) => res.sendFile(__dirname + '/tt-matchintro.html'));
app.get('/tt-matchintro-panel', (req, res) => res.sendFile(__dirname + '/tt-matchintro-panel.html'));
app.get('/tt-lowerthird', (req, res) => res.sendFile(__dirname + '/tt-lowerthird.html'));
app.get('/tt-lowerthird-panel', (req, res) => res.sendFile(__dirname + '/tt-lowerthird-panel.html'));
app.get('/cricket-templates', (req, res) => res.sendFile(__dirname + '/cricket-templates.html'));
app.get('/cricket-overlay', (req, res) => res.sendFile(__dirname + '/cricket-overlay.html'));
app.get('/cricket-panel', (req, res) => res.sendFile(__dirname + '/cricket-panel.html'));
app.get('/cricket-overlay2', (req, res) => res.sendFile(__dirname + '/cricket-overlay2.html'));
app.get('/cricket-panel2', (req, res) => res.sendFile(__dirname + '/cricket-panel2.html'));
app.get('/cricket-scorecard', (req, res) => res.sendFile(__dirname + '/cricket-scorecard.html'));
app.get('/cricket-overlay3', (req, res) => res.sendFile(__dirname + '/cricket-overlay3.html'));
app.get('/cricket-panel3', (req, res) => res.sendFile(__dirname + '/cricket-panel3.html'));

// 🧩 Generic serving routes for sports added via Admin → Broadcasting →
// Add Template (the panelCode/overlayCode the owner pastes in). Cricket /
// Football / Table Tennis keep their own dedicated hardcoded routes above;
// everything else (including brand-new custom sports) is served here
// straight out of the `templates` collection — no code changes needed to
// add a sport. Used for both the real OBS browser-source URLs and the
// Admin "Preview" button.
app.get('/t/:slug/panel', async (req, res) => {
    if (!templatesCollection) return res.status(503).send('Database not configured');
    const doc = await templatesCollection.findOne({ slug: req.params.slug });
    if (!doc) return res.status(404).send('Template not found');
    res.set('Content-Type', 'text/html').send(doc.panelCode || '<!-- No panel code saved for this template yet -->');
});
app.get('/t/:slug/overlay/:overlayId', async (req, res) => {
    if (!templatesCollection) return res.status(503).send('Database not configured');
    const doc = normalizeTemplate(await templatesCollection.findOne({ slug: req.params.slug }));
    if (!doc) return res.status(404).send('Template not found');
    const overlay = doc.overlays.find(o => o.id === req.params.overlayId);
    if (!overlay) return res.status(404).send('Overlay not found');
    res.set('Content-Type', 'text/html').send(overlay.code || '<!-- No overlay code saved yet -->');
});

// 🌐 Public scorecard system — see the "PUBLIC SCORECARD SYSTEM" section
// above for the /api/public/* + /api/league/:name/public-link routes
// these pages call. Both are static shells; all data loads client-side.
app.get('/score/tournament/:token', (req, res) => res.sendFile(__dirname + '/score-tournament.html'));
app.get('/score/tournament/:token/match/:matchId', (req, res) => res.sendFile(__dirname + '/score-tournament.html'));
app.get('/score/match/:id', (req, res) => res.sendFile(__dirname + '/score-match.html'));
app.get('/football-matchintro', (req, res) => res.sendFile(__dirname + '/football-matchintro.html'));
app.get('/football-matchintro-panel', (req, res) => res.sendFile(__dirname + '/football-matchintro-panel.html'));

let roomStates = {};
const firestoreWriteTimers = {}; // debounce map: targetId -> timeout handle
const hydratedRooms = {}; // room -> true once we've pulled its saved state from Firestore.
// Without this, getRoomState() below was hitting Firestore on EVERY single
// call — every button press, every color drag, every socket connect — instead
// of just once per room. On Render's free plan that network round-trip is
// what was causing the multi-second lag on every single update.

async function getRoomState(room) {
    if (!roomStates[room]) {
        roomStates[room] = {
            ttState: {
                tourneyTitle: "TABLE TENNIS SUPER LEAGUE",
                p1Name: "Team A", p2Name: "Team B", 
                p1Score: 0, p2Score: 0, p1Sets: 0, p2Sets: 0, server: 1, img1: "", img2: "", state: "score-in", colors: {
                    bg: "#0e101c",
                    accent: "#ec4a9b",
                    text: "#ffffff"
                },
                ltTitle: "MATCH HIGHLIGHT", ltText: "Announcement text goes here", ltVisible: false
            },
            footballState: {
                showScoreboard: true,
                nameA: "REAL MADRID",
                nameB: "BARCELONA",
                logoA: "",
                logoB: "",
                showLogoA: true,
                showLogoB: true,
                scoreA: 0,
                scoreB: 0,
                colorA: "#0284c7",
                colorB: "#dc2626",
                colorClock: "#090d16",
                colorModal: "#38bdf8",
                penA: "",
                penB: "",
                timer: "00:00",
                matchDuration: 90,
                activeModal: "",
                showActionReplay: false
            },
            matchIntroState: {
                league: "TABLE TENNIS",
                round: "Quarter Final",
                venue: "Table Tennis Arena",
                teamA: { name: "Team A", logo: "" },
                teamB: { name: "Team B", logo: "" },
                colors: {
                    pink: "#ec4a9b", pinkSoft: "#f472b6", purple: "#8b6cf0", cyan: "#3fd6ea",
                    headerBg: "#0a0a0f", cardBg: "rgba(14,16,28,.55)",
                    navyDeep: "#060a16", navyMid: "#131c36", navyEnd: "#1b2a4d",
                    bgOpacity: 0.3
                },
                // Team names auto-sync with the TT scorecard until both
                // sides have real names filled in — see reconcileTeamNames().
            },
            cricketState: {
                format: "T20",
                customOvers: 20,
                venue: "",
                broadcaster: "BCCI.TV",
                teamA: { name: "India", short: "IND", color: "#1c3a8a", flagUrl: "" },
                teamB: { name: "Australia", short: "AUS", color: "#f2c200", flagUrl: "" },
                battingTeam: "A",
                score: { runs: 0, wickets: 0, overs: 0, balls: 0 },
                target: null,
                striker: { name: "Batsman 1", runs: 0, balls: 0, fours: 0, sixes: 0 },
                nonStriker: { name: "Batsman 2", runs: 0, balls: 0, fours: 0, sixes: 0 },
                bowler: { name: "Bowler", overs: 0, balls: 0, maidens: 0, runs: 0, wickets: 0 },
                thisOver: [],
                partnershipRuns: 0,
                partnershipBalls: 0,
                milestonesHit: {},
                visible: true
            },
            footballMatchIntroState: {
                league: "LAKERS CUP PLAYOFFS",
                venue: "American Airlines Center - Dallas, TX",
                kickoff: "Tomorrow, 8PM EST",
                teamA: { name: "Player A", logo: "", color: "#1c8a4a", colorAuto: true },
                teamB: { name: "Player B", logo: "", color: "#c41c2e", colorAuto: true },
                colors: {
                    navyDeep: "#060a16", navyMid: "#0d1424", navyEnd: "#151f38",
                    headerBg: "#05060a", cardBorder: "rgba(255,255,255,.14)",
                    accent: "#3fd6ea"
                },
                visible: true
            }
        };
    }

    const isUserRoom = room.startsWith('room-') || (room.length === 6 && room !== 'scorvix-master-room');

    // Only fetch from Firestore the first time this room is seen after a server
    // start/restart. We mark it hydrated BEFORE the await so two near-simultaneous
    // calls (e.g. panel connecting + panel immediately emitting an update) don't
    // both fire a redundant fetch.
    if (isUserRoom && !hydratedRooms[room]) {
        hydratedRooms[room] = true;
        const uid = room.replace('room-', '');
        try {
            const doc = await db.collection("scorvix").doc(uid).get();
            if (doc.exists) {
                const data = doc.data();
                if (data.ttState) roomStates[room].ttState = { ...roomStates[room].ttState, ...data.ttState };
                if (data.footballState) roomStates[room].footballState = { ...roomStates[room].footballState, ...data.footballState };
                if (data.matchIntroState) roomStates[room].matchIntroState = { ...roomStates[room].matchIntroState, ...data.matchIntroState };
                if (data.cricketState) roomStates[room].cricketState = { ...roomStates[room].cricketState, ...data.cricketState };
                if (data.footballMatchIntroState) roomStates[room].footballMatchIntroState = { ...roomStates[room].footballMatchIntroState, ...data.footballMatchIntroState };
            }
        } catch (err) {
            console.log("Firestore fetch error:", err);
            hydratedRooms[room] = false; // allow retry on next call since this fetch failed
        }
    }
    return roomStates[room];
}

// 🌟 Keeps team names/logos in sync between the TT scorecard (ttState) and
// the Match Intro template (matchIntroState) for the SAME match — in
// whichever order the user fills them in. Whichever side still has the
// untouched default ("Team A"/"Team B") adopts the other side's real names.
// Once BOTH sides have real (non-default) names, nothing here touches them
// again — so a later manual fix on either side stays exactly as typed.
// Returns 'matchIntro' | 'tt' | false depending on which side (if any) was
// just filled in, so the caller knows what to broadcast/persist.
function reconcileTeamNames(state) {
    if (!state.ttState || !state.matchIntroState) return false;
    const tt = state.ttState;
    const mi = state.matchIntroState;
    const ttHasReal = tt.p1Name && tt.p1Name !== "Team A" && tt.p2Name && tt.p2Name !== "Team B";
    const miHasReal = mi.teamA && mi.teamA.name && mi.teamA.name !== "Team A" && mi.teamB && mi.teamB.name && mi.teamB.name !== "Team B";

    if (ttHasReal && !miHasReal) {
        mi.teamA = { ...mi.teamA, name: tt.p1Name, logo: tt.img1 || "" };
        mi.teamB = { ...mi.teamB, name: tt.p2Name, logo: tt.img2 || "" };
        return 'matchIntro';
    }
    if (miHasReal && !ttHasReal) {
        tt.p1Name = mi.teamA.name;
        tt.img1 = mi.teamA.logo || "";
        tt.p2Name = mi.teamB.name;
        tt.img2 = mi.teamB.logo || "";
        return 'tt';
    }
    return false;
}

// Lower Third REST APIs
app.get('/api/tt-data', async (req, res) => {
    let room = req.query.id || req.query.uid || 'scorvix-master-room';
    if (!room.startsWith('room-') && room !== 'scorvix-master-room') room = `room-${room}`;
    const state = await getRoomState(room);
    res.json({
        ltTitle: state.ttState.ltTitle || "MATCH HIGHLIGHT",
        ltText: state.ttState.ltText || "Announcement text goes here",
        ltVisible: state.ttState.ltVisible || false
    });
});

app.post('/api/update-tt-data', async (req, res) => {
    let room = req.body.id || req.query.id || req.body.uid || req.query.uid || 'scorvix-master-room';
    if (!room.startsWith('room-') && room !== 'scorvix-master-room') room = `room-${room}`;
    const state = await getRoomState(room);
    
    if (req.body.ltTitle !== undefined) state.ttState.ltTitle = req.body.ltTitle;
    if (req.body.ltText !== undefined) state.ttState.ltText = req.body.ltText;
    if (req.body.ltVisible !== undefined) state.ttState.ltVisible = req.body.ltVisible;

    io.to(room).emit('liveLowerThird', {
        ltTitle: state.ttState.ltTitle,
        ltText: state.ttState.ltText,
        ltVisible: state.ttState.ltVisible
    });

    if (room.startsWith('room-')) {
        const uid = room.replace('room-', '');
        db.collection("scorvix").doc(uid).set({ ttState: state.ttState }, { merge: true }).catch(err => console.log("DB update error:", err));
    }
    res.json({ success: true });
});

// 🔗 OBS/vMix Link Activity Logging
// Panels call this whenever a user copies or previews their overlay link,
// so it shows up in the Maalik Panel's Analytics tab alongside login/logout
// and overlay-open events. Kept as its own lightweight route (rather than
// requiring the panel to load the Firestore client SDK just for this) so any
// current or future panel can log link activity with one small fetch call.
app.post('/api/log-link-action', async (req, res) => {
    try {
        const { email, action, overlay } = req.body;
        if (!email || !action) {
            return res.status(400).json({ success: false, error: 'email and action are required' });
        }
        await db.collection('analytics_logs').add({
            email,
            action,
            overlay: overlay || 'Unknown',
            time: new Date().toLocaleString()
        });
        res.json({ success: true });
    } catch (err) {
        console.log('Log link action error:', err);
        res.status(500).json({ success: false });
    }
});

// Match Intro REST API
app.get('/api/matchintro-data', async (req, res) => {
    let room = req.query.id || req.query.uid || 'scorvix-master-room';
    if (!room.startsWith('room-') && room !== 'scorvix-master-room') room = `room-${room}`;
    const state = await getRoomState(room);
    const changed = reconcileTeamNames(state);
    if (changed && room.startsWith('room-')) {
        const uid = room.replace('room-', '');
        const patch = changed === 'matchIntro' ? { matchIntroState: state.matchIntroState } : { ttState: state.ttState };
        db.collection("scorvix").doc(uid).set(patch, { merge: true }).catch(err => console.log("DB update error:", err));
    }
    res.json(state.matchIntroState);
});

io.on('connection', async (socket) => {
    let currentRoom = 'scorvix-master-room';
    socket.activeRoom = currentRoom;
    socket.join(currentRoom);

    const query = socket.handshake.query;
    const clientId = query.id || query.uid;
    const cleanQueryUid = query.uid ? query.uid.replace('overlay-', '') : null;
    // Overlay pages connect with a "room" query param (e.g. ?room=room-xxxxx).
    // This was not being read before, so overlays never joined the correct
    // room and stayed stuck in 'scorvix-master-room'.
    const cleanQueryRoom = query.room ? query.room.replace('room-', '') : null;

    if (clientId || cleanQueryUid || cleanQueryRoom) {
        const idVal = cleanQueryRoom || cleanQueryUid || clientId;
        currentRoom = `room-${idVal}`;
        socket.leave(socket.activeRoom);
        socket.join(currentRoom);
        socket.activeRoom = currentRoom;
    }

    const roomState = await getRoomState(currentRoom);
    const matchIdForClient = cleanQueryRoom || cleanQueryUid || clientId || 'default';

    const connectSyncResult = reconcileTeamNames(roomState);
    if (roomState.matchIntroState) {
        socket.emit('liveMatchIntro', {
            matchId: matchIdForClient,
            config: roomState.matchIntroState,
            triggerReplay: false
        });
    }
    if (roomState.ttState) socket.emit('liveScore', roomState.ttState);
    if (roomState.footballState) socket.emit('liveFootballScore', roomState.footballState);
    if (roomState.cricketState) socket.emit('liveCricketScore', roomState.cricketState);
    if (roomState.footballMatchIntroState) socket.emit('liveFootballMatchIntro', { config: roomState.footballMatchIntroState, triggerReplay: false });
    if (connectSyncResult && currentRoom.startsWith('room-')) {
        const uid = currentRoom.replace('room-', '');
        const patch = connectSyncResult === 'matchIntro' ? { matchIntroState: roomState.matchIntroState } : { ttState: roomState.ttState };
        db.collection("scorvix").doc(uid).set(patch, { merge: true }).catch(err => console.log("DB update error:", err));
    }

    // SCOREBOARD PANEL UPDATE HANDLING (Table Tennis)
    socket.on('updateScore', async (data) => {
        let room = socket.activeRoom;
        const targetId = data.id || data.uid || matchIdForClient;
        if (targetId && targetId !== 'default') {
            room = `room-${targetId}`;
            // Only leave/join if the socket isn't already in this room —
            // avoids unnecessary work on every single point/keystroke event.
            // (Same fix already applied to football/cricket below — without
            // it, every TT update paid a socket.leave+join cost, which is
            // what was causing the felt lag on live updates.)
            if (socket.activeRoom !== room) {
                socket.leave(socket.activeRoom);
                socket.join(room);
                socket.activeRoom = room;
            }
        }

        const state = await getRoomState(room);
        state.ttState = { ...state.ttState, ...data };
        // 🩹 Self-heal: an old bug could nest these top-level keys inside
        // ttState itself, growing deeper on every save until Firestore
        // rejected the write ("deeper than 20 levels or contains a cycle").
        // Stripping them here fixes already-corrupted rooms automatically.
        delete state.ttState.ttState;
        delete state.ttState.footballState;
        delete state.ttState.matchIntroState;

        io.to(room).emit('liveScore', state.ttState);

        // 🌟 Keep the Match Intro template's teams in sync in real time too
        // (not just on next page load) — works both ways, see reconcileTeamNames().
        const scoreSyncResult = reconcileTeamNames(state);
        if (scoreSyncResult === 'matchIntro') {
            io.to(room).emit('liveMatchIntro', {
                matchId: targetId || matchIdForClient,
                config: state.matchIntroState,
                triggerReplay: false
            });
            if (targetId && targetId !== 'default') {
                db.collection("scorvix").doc(targetId).set({ matchIntroState: state.matchIntroState }, { merge: true }).catch(err => console.log("DB update error:", err));
            }
        }

        // Debounced (max once per 700ms per room) — same fix already applied
        // to football. Without this, every point/voice-command/text-edit fired
        // its own immediate Firestore write, and those queued up on Node's
        // single event loop, delaying processing of the NEXT update (for TT,
        // football, or anyone else's room) behind it.
        if (targetId && targetId !== 'default') {
            clearTimeout(firestoreWriteTimers[targetId + ':tt']);
            firestoreWriteTimers[targetId + ':tt'] = setTimeout(() => {
                db.collection("scorvix").doc(targetId).set({ ttState: state.ttState }, { merge: true }).catch(err => console.log("DB update error:", err));
            }, 700);
        }
    });

    // ⚽ FOOTBALL SCOREBOARD PANEL & OVERLAY SOCKET HANDLING
    const handleFootballUpdate = async (data) => {
        let room = socket.activeRoom;
        const targetId = data.room ? data.room.replace('room-', '') : (data.id || data.uid || matchIdForClient);
        if (targetId && targetId !== 'default') {
            room = `room-${targetId}`;
            // Only leave/join if the socket isn't already in this room —
            // avoids unnecessary work on every single keystroke/slider event.
            if (socket.activeRoom !== room) {
                socket.leave(socket.activeRoom);
                socket.join(room);
                socket.activeRoom = room;
            }
        }

        const state = await getRoomState(room);
        state.footballState = { ...state.footballState, ...data };

        // Broadcast updated football data to overlay and panels IMMEDIATELY —
        // this is what makes the overlay feel instant.
        io.to(room).emit('liveFootballScore', state.footballState);

        // Save to Firestore, but debounced (max once per 700ms per room).
        // Without this, rapid updates (e.g. dragging a color picker) queue up
        // many DB writes back-to-back, which can make later live updates feel
        // delayed since Node has to work through the backlog.
        if (targetId && targetId !== 'default') {
            clearTimeout(firestoreWriteTimers[targetId]);
            firestoreWriteTimers[targetId] = setTimeout(() => {
                db.collection("scorvix").doc(targetId).set({ footballState: state.footballState }, { merge: true }).catch(err => console.log("DB update error:", err));
            }, 700);
        }
    };

    socket.on('updateFootballScore', handleFootballUpdate);
    socket.on('liveFootballScore', handleFootballUpdate);

    // 🏏 CRICKET SCOREBOARD PANEL & OVERLAY SOCKET HANDLING
    // Mirrors handleFootballUpdate: merge partial updates into persisted room
    // state, broadcast immediately, save to Firestore debounced (700ms) so
    // rapid ball-by-ball updates don't queue up a DB write per click.
    const handleCricketUpdate = async (data) => {
        let room = socket.activeRoom;
        const targetId = data.room ? data.room.replace('room-', '') : (data.id || data.uid || matchIdForClient);
        if (targetId && targetId !== 'default') {
            room = `room-${targetId}`;
            if (socket.activeRoom !== room) {
                socket.leave(socket.activeRoom);
                socket.join(room);
                socket.activeRoom = room;
            }
        }

        const state = await getRoomState(room);
        state.cricketState = { ...state.cricketState, ...data };

        io.to(room).emit('liveCricketScore', state.cricketState);

        if (targetId && targetId !== 'default') {
            clearTimeout(firestoreWriteTimers[`cricket-${targetId}`]);
            firestoreWriteTimers[`cricket-${targetId}`] = setTimeout(() => {
                db.collection("scorvix").doc(targetId).set({ cricketState: state.cricketState }, { merge: true }).catch(err => console.log("DB update error:", err));
            }, 700);
        }
    };

    socket.on('updateCricketScore', handleCricketUpdate);
    socket.on('liveCricketScore', handleCricketUpdate);

    // One-off milestone animations (FOUR/SIX/WICKET/50/100/victory/etc.) are
    // pure broadcast events — they are NOT merged into cricketState and are
    // NOT written to Firestore, since they're a transient overlay animation
    // trigger, not part of the persisted scoreboard.
    socket.on('cricketEvent', (data) => {
        let room = socket.activeRoom;
        const targetId = data.room ? data.room.replace('room-', '') : (data.id || data.uid || matchIdForClient);
        if (targetId && targetId !== 'default') room = `room-${targetId}`;
        io.to(room).emit('cricketEvent', data.event || data);
    });

    // 🏏 Innings-complete / match-result summary graphics (cricket-panel2.html
    // "Pill Scorebug" variant). Same treatment as cricketEvent: pure
    // broadcast, NOT merged into cricketState and NOT written to Firestore —
    // these are one-off overlay graphics, not persisted scoreboard fields.
    socket.on('cricketInningsSummary', (data) => {
        let room = socket.activeRoom;
        const targetId = data.room ? data.room.replace('room-', '') : (data.id || data.uid || matchIdForClient);
        if (targetId && targetId !== 'default') room = `room-${targetId}`;
        io.to(room).emit('cricketInningsSummary', data.data || data);
    });

    socket.on('cricketMatchSummary', (data) => {
        let room = socket.activeRoom;
        const targetId = data.room ? data.room.replace('room-', '') : (data.id || data.uid || matchIdForClient);
        if (targetId && targetId !== 'default') room = `room-${targetId}`;
        io.to(room).emit('cricketMatchSummary', data.data || data);
    });

    // 🏏🙈 Manually hide the innings/match summary card on the overlay
    // (cricket-panel2's "Hide" buttons). Same pure-broadcast treatment as
    // cricketEvent — these were previously emitted by the panel but never
    // relayed by the server, so the overlay never received them and the
    // summary card stayed stuck on screen until it timed out on its own.
    socket.on('cricketHideInningsSummary', (data) => {
        let room = socket.activeRoom;
        const targetId = data && data.room ? data.room.replace('room-', '') : (data && (data.id || data.uid)) || matchIdForClient;
        if (targetId && targetId !== 'default') room = `room-${targetId}`;
        io.to(room).emit('cricketHideInningsSummary');
    });

    socket.on('cricketHideMatchSummary', (data) => {
        let room = socket.activeRoom;
        const targetId = data && data.room ? data.room.replace('room-', '') : (data && (data.id || data.uid)) || matchIdForClient;
        if (targetId && targetId !== 'default') room = `room-${targetId}`;
        io.to(room).emit('cricketHideMatchSummary');
    });

    // 🏏🪙 Toss announcement card — same pure-broadcast treatment as the
    // summary cards above (not persisted, one-off overlay graphic). This
    // pair was missing entirely, which is why the panel's "Show Toss on
    // Overlay" button emitted cricketToss/cricketHideToss but the overlay
    // never received them (nothing was listening server-side to relay it
    // to the room).
    socket.on('cricketToss', (data) => {
        let room = socket.activeRoom;
        const targetId = data.room ? data.room.replace('room-', '') : (data.id || data.uid || matchIdForClient);
        if (targetId && targetId !== 'default') room = `room-${targetId}`;
        io.to(room).emit('cricketToss', data.data || data);
    });

    socket.on('cricketHideToss', (data) => {
        let room = socket.activeRoom;
        const targetId = data && data.room ? data.room.replace('room-', '') : (data && (data.id || data.uid)) || matchIdForClient;
        if (targetId && targetId !== 'default') room = `room-${targetId}`;
        io.to(room).emit('cricketHideToss');
    });

    // 🏏🎚️ Left-slide player/bowler stat cards (batting-team / bowling-team
    // branded, Match or Tournament scope). Same pure-broadcast treatment as
    // cricketEvent/cricketInningsSummary above — an on/off toggle on the
    // panel, not persisted scoreboard state, so nothing here touches
    // cricketState or Firestore.
    socket.on('cricketPlayerStat', (data) => {
        let room = socket.activeRoom;
        const targetId = data.room ? data.room.replace('room-', '') : (data.id || data.uid || matchIdForClient);
        if (targetId && targetId !== 'default') room = `room-${targetId}`;
        io.to(room).emit('cricketPlayerStat', data.data || data);
    });

    socket.on('cricketBowlerStat', (data) => {
        let room = socket.activeRoom;
        const targetId = data.room ? data.room.replace('room-', '') : (data.id || data.uid || matchIdForClient);
        if (targetId && targetId !== 'default') room = `room-${targetId}`;
        io.to(room).emit('cricketBowlerStat', data.data || data);
    });

    socket.on('cricketHidePlayerStat', (data) => {
        let room = socket.activeRoom;
        const targetId = data && data.room ? data.room.replace('room-', '') : (data && (data.id || data.uid)) || matchIdForClient;
        if (targetId && targetId !== 'default') room = `room-${targetId}`;
        io.to(room).emit('cricketHidePlayerStat');
    });

    socket.on('cricketHideBowlerStat', (data) => {
        let room = socket.activeRoom;
        const targetId = data && data.room ? data.room.replace('room-', '') : (data && (data.id || data.uid)) || matchIdForClient;
        if (targetId && targetId !== 'default') room = `room-${targetId}`;
        io.to(room).emit('cricketHideBowlerStat');
    });

    // 🏏🏆 Team tournament-record card — same pure-broadcast treatment as
    // the player/bowler stat cards just above. This pair was missing
    // entirely, which is why the panel's Team Stat toggle emitted
    // cricketTeamStat/cricketHideTeamStat but the overlay never received
    // them (nothing was listening server-side to relay it to the room).
    socket.on('cricketTeamStat', (data) => {
        let room = socket.activeRoom;
        const targetId = data.room ? data.room.replace('room-', '') : (data.id || data.uid || matchIdForClient);
        if (targetId && targetId !== 'default') room = `room-${targetId}`;
        io.to(room).emit('cricketTeamStat', data.data || data);
    });

    socket.on('cricketHideTeamStat', (data) => {
        let room = socket.activeRoom;
        const targetId = data && data.room ? data.room.replace('room-', '') : (data && (data.id || data.uid)) || matchIdForClient;
        if (targetId && targetId !== 'default') room = `room-${targetId}`;
        io.to(room).emit('cricketHideTeamStat');
    });

    // 🏏📜 Player/Team tournament-history overlay cards — same pure-broadcast
    // treatment as cricketTeamStat/cricketPlayerStat above.
    socket.on('cricketPlayerHistory', (data) => {
        let room = socket.activeRoom;
        const targetId = data.room ? data.room.replace('room-', '') : (data.id || data.uid || matchIdForClient);
        if (targetId && targetId !== 'default') room = `room-${targetId}`;
        io.to(room).emit('cricketPlayerHistory', data.data || data);
    });

    socket.on('cricketHidePlayerHistory', (data) => {
        let room = socket.activeRoom;
        const targetId = data && data.room ? data.room.replace('room-', '') : (data && (data.id || data.uid)) || matchIdForClient;
        if (targetId && targetId !== 'default') room = `room-${targetId}`;
        io.to(room).emit('cricketHidePlayerHistory');
    });

    socket.on('cricketTeamHistory', (data) => {
        let room = socket.activeRoom;
        const targetId = data.room ? data.room.replace('room-', '') : (data.id || data.uid || matchIdForClient);
        if (targetId && targetId !== 'default') room = `room-${targetId}`;
        io.to(room).emit('cricketTeamHistory', data.data || data);
    });

    socket.on('cricketHideTeamHistory', (data) => {
        let room = socket.activeRoom;
        const targetId = data && data.room ? data.room.replace('room-', '') : (data && (data.id || data.uid)) || matchIdForClient;
        if (targetId && targetId !== 'default') room = `room-${targetId}`;
        io.to(room).emit('cricketHideTeamHistory');
    });

    // 🏆 Points Table overlay card — same pure-broadcast relay as
    // cricketTeamHistory above (panel builds the standings payload from
    // the league data it already has locally; server just forwards it to
    // whoever is watching this room's overlay).
    socket.on('cricketPointsTable', (data) => {
        let room = socket.activeRoom;
        const targetId = data.room ? data.room.replace('room-', '') : (data.id || data.uid || matchIdForClient);
        if (targetId && targetId !== 'default') room = `room-${targetId}`;
        io.to(room).emit('cricketPointsTable', data.data || data);
    });

    socket.on('cricketHidePointsTable', (data) => {
        let room = socket.activeRoom;
        const targetId = data && data.room ? data.room.replace('room-', '') : (data && (data.id || data.uid)) || matchIdForClient;
        if (targetId && targetId !== 'default') room = `room-${targetId}`;
        io.to(room).emit('cricketHidePointsTable');
    });

    // 🍃 Every ball, straight to MongoDB — the permanent source of truth.
    // Fired once per recordBall() call in cricket-panel.html, independent
    // of the cricketState broadcast above (that one's just "what the
    // overlay shows right now"; this is "what actually happened, forever").
    socket.on('logBall', async (data) => {
        if (!ballsCollection) return; // Mongo not configured yet — no-op
        const matchId = safeMatchId(data.matchId || (data.room ? data.room.replace('room-', '') : null) || matchIdForClient);
        if (!matchId || matchId === 'default') return;
        try {
            // Best-effort owner resolution (see resolveOwnerUidForMatch above)
            // so this ball — and any clip cut around it — can be found again
            // in career-wide player queries, not just within this one match.
            const ownerUid = await resolveOwnerUidForMatch(matchId, data.uid);
            await ballsCollection.insertOne({
                matchId,
                ownerUid: ownerUid || null,
                innings: data.innings,
                over: data.over,
                ballInOver: data.ballInOver,
                kind: data.kind,          // '0'-'6', 'W', 'Wd', 'Nb', 'B', 'LB'
                runs: data.runs,
                battingTeam: data.battingTeam,
                striker: data.striker,
                strikerKey: playerKey(data.striker),
                nonStriker: data.nonStriker,
                nonStrikerKey: playerKey(data.nonStriker),
                bowler: data.bowler,
                bowlerKey: playerKey(data.bowler),
                dismissal: data.dismissal || null, // { type: 'Bowled'|'Caught'|'LBW'|'Run Out'|'Stumped'|'Hit Wicket'|..., fielder? }
                dismissalFielderKey: playerKey(data.dismissal && data.dismissal.fielder),
                score: data.score,        // { runs, wickets, overs, balls } snapshot after this ball
                timestamp: data.timestamp || Date.now()
            });
        } catch (err) {
            console.log('logBall Mongo insert error:', err);
        }
    });

    // 🎬 WICKET/FOUR/SIX → cut a 20s clip (10s before, 10s after) from the
    // match recording. We deliberately wait until the "after" half of the
    // window has actually been recorded before touching ffmpeg, otherwise
    // we'd be trying to cut footage that doesn't exist on disk yet.
    socket.on('requestClip', (data) => {
        const matchId = safeMatchId(data.matchId || (data.room ? data.room.replace('room-', '') : null) || matchIdForClient);
        if (!matchId || matchId === 'default') return;
        const eventTimestamp = data.timestamp || Date.now();
        const waitMs = Math.max(0, (eventTimestamp + 10000) - Date.now()) + 1000; // +1s safety buffer
        setTimeout(() => {
            cutClip({ matchId, eventType: data.eventType, eventTimestamp, ballMeta: data.ballMeta || null, uid: data.uid || null });
        }, waitMs);
    });

    // 🏈 FOOTBALL MATCH INTRO PANEL & OVERLAY SOCKET HANDLING
    // Broadcast is ALWAYS immediate (no delay ever added to what viewers see)
    // — only the Firestore save is debounced, purely to avoid flooding the DB
    // on rapid edits. That debounce never delays the live update itself.
    const handleFootballMatchIntroUpdate = async (data) => {
        let room = socket.activeRoom;
        const targetId = data.room ? data.room.replace('room-', '') : (data.id || data.uid || matchIdForClient);
        if (targetId && targetId !== 'default') {
            room = `room-${targetId}`;
            if (socket.activeRoom !== room) {
                socket.leave(socket.activeRoom);
                socket.join(room);
                socket.activeRoom = room;
            }
        }

        const state = await getRoomState(room);
        if (data.config) {
            // Merge (not replace) so fields the panel never sends (e.g. 'visible')
            // are preserved instead of being wiped out on every panel edit.
            state.footballMatchIntroState = { ...state.footballMatchIntroState, ...data.config };
        } else {
            state.footballMatchIntroState = { ...state.footballMatchIntroState, ...data };
        }

        io.to(room).emit('liveFootballMatchIntro', {
            config: state.footballMatchIntroState,
            triggerReplay: data.triggerReplay || false
        });

        if (targetId && targetId !== 'default') {
            clearTimeout(firestoreWriteTimers[`fmi-${targetId}`]);
            firestoreWriteTimers[`fmi-${targetId}`] = setTimeout(() => {
                db.collection("scorvix").doc(targetId).set({ footballMatchIntroState: state.footballMatchIntroState }, { merge: true }).catch(err => console.log("DB update error:", err));
            }, 700);
        }
    };
    socket.on('updateFootballMatchIntro', handleFootballMatchIntroUpdate);
    socket.on('liveFootballMatchIntro', handleFootballMatchIntroUpdate);

    // Match Intro Socket Update Handling
    socket.on('updateMatchIntro', async (data) => {
        let room = socket.activeRoom;
        const targetId = data.id || data.uid || matchIdForClient;
        if (targetId && targetId !== 'default') {
            room = `room-${targetId}`;
            socket.leave(socket.activeRoom);
            socket.join(room);
            socket.activeRoom = room;
        }
        
        const state = await getRoomState(room);
        if (data.config) {
            state.matchIntroState = data.config;
        } else {
            state.matchIntroState = data; 
        }

        io.to(room).emit('liveMatchIntro', {
            matchId: targetId,
            config: state.matchIntroState,
            triggerReplay: data.triggerReplay || false
        });

        if (targetId && targetId !== 'default') {
            db.collection("scorvix").doc(targetId).set({ matchIntroState: state.matchIntroState }, { merge: true }).catch(err => console.log("DB update error:", err));
        }

        // 🌟 If TT's team names are still default and Match Intro just got
        // real ones, push those into the TT scorecard too — so opening the
        // scorecard next (even on a different device) already has them.
        const introSyncResult = reconcileTeamNames(state);
        if (introSyncResult === 'tt') {
            io.to(room).emit('liveScore', state.ttState);
            if (targetId && targetId !== 'default') {
                db.collection("scorvix").doc(targetId).set({ ttState: state.ttState }, { merge: true }).catch(err => console.log("DB update error:", err));
            }
        }
    });

    socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
