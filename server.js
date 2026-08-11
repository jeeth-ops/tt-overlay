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
        // Fast lookups: all balls of a match in bowling order, and one
        // match doc per matchId.
        await ballsCollection.createIndex({ matchId: 1, innings: 1, over: 1, ballInOver: 1 });
        await matchesCollection.createIndex({ matchId: 1 }, { unique: true });
        await clipsCollection.createIndex({ matchId: 1, createdAt: 1 });
        // One doc per (owner, league) pair — owner-scoped so two different
        // customers naming a league the same thing (e.g. "Summer Cup") never
        // collide/overwrite each other. ownerUid comes from the logged-in
        // Firebase user (see index.html's `scorvix_uid`), matching how the
        // rest of this app already identifies "whose data is whose".
        await leaguesCollection.createIndex({ ownerUid: 1, leagueKey: 1 }, { unique: true });
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
async function cutClip({ matchId, eventType, eventTimestamp, ballMeta }) {
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
            await clipsCollection.insertOne({
                matchId, eventType, ballMeta: ballMeta || null,
                eventTimestamp, offsetStartSec: fromSec, offsetEndSec: toSec,
                filePath: outFile, driveStatus: 'pending', createdAt: Date.now()
            });
        }
        console.log(`🎬 Clip ready: ${outFile}`);
        uploadClipToDrive(matchId, outFile, eventType, ballMeta); // fire-and-forget — never blocks/delays clip cutting
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

// Routes
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
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
            socket.leave(socket.activeRoom);
            socket.join(room);
            socket.activeRoom = room;
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

    // 🍃 Every ball, straight to MongoDB — the permanent source of truth.
    // Fired once per recordBall() call in cricket-panel.html, independent
    // of the cricketState broadcast above (that one's just "what the
    // overlay shows right now"; this is "what actually happened, forever").
    socket.on('logBall', async (data) => {
        if (!ballsCollection) return; // Mongo not configured yet — no-op
        const matchId = safeMatchId(data.matchId || (data.room ? data.room.replace('room-', '') : null) || matchIdForClient);
        if (!matchId || matchId === 'default') return;
        try {
            await ballsCollection.insertOne({
                matchId,
                innings: data.innings,
                over: data.over,
                ballInOver: data.ballInOver,
                kind: data.kind,          // '0'-'6', 'W', 'Wd', 'Nb', 'B', 'LB'
                runs: data.runs,
                battingTeam: data.battingTeam,
                striker: data.striker,
                nonStriker: data.nonStriker,
                bowler: data.bowler,
                dismissal: data.dismissal || null,
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
            cutClip({ matchId, eventType: data.eventType, eventTimestamp, ballMeta: data.ballMeta || null });
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
