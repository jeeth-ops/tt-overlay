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
        },
        // 🐛 Newer @aws-sdk/client-s3 versions default to adding a
        // streaming trailer checksum (x-amz-checksum-crc32) on PutObject.
        // R2 doesn't handle that the same way S3 does — the request
        // "succeeds" from the SDK's point of view (no thrown error) but
        // the object never actually lands in the bucket (0 B, no file
        // listed, yet the R2 dashboard still counts it as an operation —
        // exactly what was happening here). Forcing this to
        // WHEN_REQUIRED stops the SDK from attaching that checksum
        // unless we explicitly ask for one.
        requestChecksumCalculation: 'WHEN_REQUIRED'
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

// ================================================================
// Hide hosting identity: disable Express's default header, and
// redirect any request that comes in on the Render default domain
// (*.onrender.com) over to the real custom domain instead.
// ================================================================
app.disable('x-powered-by');

// Never redirect Render's own health check / uptime pings, or the
// redirect could make Render think the service is down and restart it.
// Add any other health-check path you've set in Render's dashboard here.
const HEALTH_CHECK_PATHS = ['/', '/health', '/healthz'];
app.use((req, res, next) => {
    const host = req.get('host');
    if (host && host.includes('onrender.com') && !HEALTH_CHECK_PATHS.includes(req.path)) {
        return res.redirect(301, `https://allsportslivestreams.com${req.originalUrl}`);
    }
    next();
});

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
let matchRecordsCollection = null;
let playersCollection = null;

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
        // 🩹 FIX (see comment block above matchRecordsCollection's queries
        // below): one document PER MATCH, instead of every match an owner
        // has ever saved living inside one giant array field on a single
        // league document. That old design hits MongoDB's hard 16MB
        // per-document limit once an owner accumulates enough matches over
        // months/years — after which saving (and sometimes reading) ANY
        // match under that owner/league starts failing, which is exactly
        // the "old matches won't load" symptom this fixes. Matches now
        // scale to unlimited history with no per-owner size ceiling.
        matchRecordsCollection = mongoDb.collection('matchRecords');
        // 🌟 GLOBAL PLAYER PROFILES — one permanent playerId per real person,
        // per owner account, instead of every ball/clip/stats query matching
        // purely on a lowercased name string (playerKey). A playerId doc
        // holds every nameKey (spelling variant) that has ever been merged
        // into it, so "Rohit Sharma" and "Rohit S" typed on two different
        // devices can be reconciled into one identity without losing either
        // match's history — see resolvePlayerId() and the /api/players
        // routes below. nameKeys is intentionally an array (not a single
        // field) so merges are just a $push, never a rewrite of history.
        playersCollection = mongoDb.collection('players');
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
        // 🩹 matchRecords indexes — one doc per match now (see comment above
        // matchRecordsCollection's assignment). ownerUid+leagueKey+matchId is
        // unique (the owner-scoped save/list/delete path); leagueKey+matchId
        // and leagueKey+roomId cover the public lookup paths, which never
        // carry an ownerUid (see GET /api/public/match/:id).
        await matchRecordsCollection.createIndex({ ownerUid: 1, leagueKey: 1, matchId: 1 }, { unique: true });
        await matchRecordsCollection.createIndex({ leagueKey: 1, matchId: 1 });
        await matchRecordsCollection.createIndex({ leagueKey: 1, roomId: 1 });
        // playerId is globally unique; nameKeys is multikey so a lookup by
        // any one of a player's known spelling variants, scoped to their
        // owner, resolves straight to the right playerId doc.
        await playersCollection.createIndex({ playerId: 1 }, { unique: true });
        await playersCollection.createIndex({ ownerUid: 1, nameKeys: 1 }, { unique: true });
        console.log('🍃 MongoDB connected —', mongoDb.databaseName);

        // 🩹 One-time migration: move any matches still embedded in a league
        // doc's `matches[]` array (the old, size-limited design) into their
        // own matchRecords documents, then strip the array off the league
        // doc so it shrinks back down. Guarded by a flag in `settings` so it
        // only ever runs once, and is safe to leave in permanently — every
        // future boot just does one cheap findOne and skips.
        await migrateEmbeddedMatchesToOwnDocs();
    } catch (err) {
        console.log('MongoDB connection error:', err);
    }
}

// 🩹 See the big comment above matchRecordsCollection's assignment: this
// moves every match still sitting inside a league doc's old `matches[]`
// array into its own matchRecords document, then $unsets that array so the
// league doc stops growing without bound. Runs once (settings flag), is
// idempotent, and never touches a league doc that has nothing to migrate.
async function migrateEmbeddedMatchesToOwnDocs() {
    if (!leaguesCollection || !matchRecordsCollection || !settingsCollection) return;
    try {
        const flag = await settingsCollection.findOne({ _id: 'matchRecordsMigration' });
        if (flag && flag.done) return;

        const cursor = leaguesCollection.find(
            { matches: { $exists: true, $not: { $size: 0 } } },
            { projection: { ownerUid: 1, leagueKey: 1, matches: 1 } }
        );
        let leaguesMigrated = 0, matchesMigrated = 0;
        while (await cursor.hasNext()) {
            const doc = await cursor.next();
            const matches = doc.matches || [];
            if (!matches.length) continue;
            const ops = matches
                .filter(m => m && m.matchId)
                .map(m => ({
                    updateOne: {
                        filter: { ownerUid: doc.ownerUid, leagueKey: doc.leagueKey, matchId: m.matchId },
                        update: { $setOnInsert: { ownerUid: doc.ownerUid, leagueKey: doc.leagueKey }, $set: m },
                        upsert: true
                    }
                }));
            if (ops.length) {
                await matchRecordsCollection.bulkWrite(ops, { ordered: false });
                matchesMigrated += ops.length;
            }
            // Shrink the league doc back down now that its matches live in
            // their own documents — this is the whole point of the fix.
            await leaguesCollection.updateOne({ _id: doc._id }, { $unset: { matches: '' } });
            leaguesMigrated++;
        }
        await settingsCollection.updateOne(
            { _id: 'matchRecordsMigration' },
            { $set: { done: true, leaguesMigrated, matchesMigrated, migratedAt: Date.now() } },
            { upsert: true }
        );
        if (leaguesMigrated) {
            console.log(`🩹 Migrated ${matchesMigrated} matches out of ${leaguesMigrated} oversized league docs into matchRecords.`);
        }
    } catch (err) {
        console.log('matchRecords migration error (will retry next boot):', err);
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
        return false;
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
        return true;
    } catch (err) {
        console.log(`Drive upload error (${fileName}):`, err.message || err);
        if (clipsCollection) {
            await clipsCollection.updateOne({ matchId, filePath }, { $set: { driveStatus: 'failed' } }).catch(() => {});
        }
        return false;
    }
}

// Uploads a clip to Cloudflare R2 (same shape as uploadClipToDrive above)
// and saves the public playback URL on the clip's Mongo record — this is
// the URL the scorecard's video player actually points at for anything
// less than a year old. Mongo NEVER stores the video bytes — only this
// small metadata doc (matchId, playerKeys, eventType, r2Url/driveUrl). The
// actual .mp4 lives only in R2 (and optionally Drive); see cutClip below,
// which deletes the local Render-disk copy once at least one of these
// uploads confirms success, so Render's disk is never the permanent home
// for video either.
async function uploadClipToR2(matchId, filePath, eventType, ballMeta) {
    if (!r2Client || !R2_BUCKET_NAME) {
        console.log(`No R2 connection configured — clip stays Drive-only: ${filePath}`);
        return false;
    }

    const fileName = buildClipFileName(eventType, ballMeta);
    const key = `${matchId}/${fileName}`;

    try {
        // Reading the whole clip into a Buffer (clips are only a few MB —
        // well within memory limits) instead of streaming it lets the SDK
        // know the exact Content-Length upfront and skips the chunked/
        // trailer-checksum upload path entirely — the combination that was
        // causing R2 to accept the request (hence the operation count going
        // up) but never actually store the bytes (hence 0 B / no object).
        const fileBuffer = fs.readFileSync(filePath);
        await r2Client.send(new PutObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
            Body: fileBuffer,
            ContentLength: fileBuffer.length,
            ContentType: 'video/mp4'
        }));

        const publicUrl = R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${key}` : null;
        if (clipsCollection) {
            await clipsCollection.updateOne(
                { matchId, filePath },
                { $set: { r2Status: 'uploaded', r2Key: key, r2Url: publicUrl } }
            );
        }
        console.log(`☁️  Uploaded to R2: ${key}`);
        return true;
    } catch (err) {
        console.log(`R2 upload error (${key}):`, err.message || err);
        if (clipsCollection) {
            await clipsCollection.updateOne({ matchId, filePath }, { $set: { r2Status: 'failed' } }).catch(() => {});
        }
        return false;
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

        await finalizeClip({ matchId, eventType, eventTimestamp, ballMeta, uid, outFile, offsetStartSec: fromSec, offsetEndSec: toSec });
    } catch (err) {
        console.log(`Clip generation error (${matchId}/${eventType}):`, err.message || err);
    } finally {
        fs.existsSync(stitchedFile) && fs.unlink(stitchedFile, () => {});
    }
}

// ================================================================
// 🔗 finalizeClip — shared by BOTH clip pipelines:
//  1. cutClip() above (browser tab-capture chunks stitched server-side)
//  2. /api/clips/ingest below (an already-cut .mp4 handed to us whole —
//     e.g. by ClipperHelper.exe, which cuts locally from the vMix
//     recording using its own ffmpeg).
// Both need EXACTLY the same thing done to a finished clip file: link
// it to real player identities via the canonical ball, insert the
// Mongo doc the clips/stats APIs read, upload to R2 + Drive, then
// clean up the local copy. Keeping this in one place means the
// scorecard's "clips by player" view works identically no matter which
// pipeline actually produced the clip.
// ================================================================
async function finalizeClip({ matchId, eventType, eventTimestamp, ballMeta, uid, outFile, offsetStartSec, offsetEndSec }) {
    if (clipsCollection) {
        // 🔗 Link this clip to real player identities/dismissal info by
        // cross-referencing the canonical ball (logged via `logBall`,
        // the permanent source of truth) instead of trusting only the
        // ballMeta the panel happened to attach to the clip request.
        // Falls back gracefully to whatever ballMeta was sent if no
        // matching ball is found (e.g. Mongo briefly unavailable).
        const canonicalBall = await findCanonicalBall(matchId, ballMeta);
        const ownerUid = await resolveOwnerUidForMatch(matchId, uid || (canonicalBall && canonicalBall.ownerUid));
        // personName() unwraps any stray {name,...} object (old data, or
        // any future client that sends one) into a clean string — see the
        // comment on personName() near playerKey() for why this matters.
        const striker = personName(canonicalBall && canonicalBall.striker) || personName(ballMeta && ballMeta.striker);
        const bowler = personName(canonicalBall && canonicalBall.bowler) || personName(ballMeta && ballMeta.bowler);
        const nonStriker = personName(canonicalBall && canonicalBall.nonStriker) || personName(ballMeta && ballMeta.nonStriker);
        const dismissal = (canonicalBall && canonicalBall.dismissal) || (ballMeta && ballMeta.dismissal) || null;
        const battingTeam = (canonicalBall && canonicalBall.battingTeam) || (ballMeta && ballMeta.battingTeam) || null;
        // 🌟 Prefer the canonical ball's already-resolved playerIds (same
        // identity the ball itself was logged under) and only fall back
        // to a fresh resolve if this clip has no matching ball yet.
        const strikerPlayerId = (canonicalBall && canonicalBall.strikerPlayerId) || (ownerUid ? await resolvePlayerId(ownerUid, striker) : null);
        const nonStrikerPlayerId = (canonicalBall && canonicalBall.nonStrikerPlayerId) || (ownerUid ? await resolvePlayerId(ownerUid, nonStriker) : null);
        const bowlerPlayerId = (canonicalBall && canonicalBall.bowlerPlayerId) || (ownerUid ? await resolvePlayerId(ownerUid, bowler) : null);
        const fielderPlayerId = (canonicalBall && canonicalBall.dismissalFielderPlayerId) || (ownerUid ? await resolvePlayerId(ownerUid, dismissal && dismissal.fielder) : null);

        await clipsCollection.insertOne({
            matchId, ownerUid: ownerUid || null, eventType, ballMeta: ballMeta || null,
            eventTimestamp, offsetStartSec: offsetStartSec ?? null, offsetEndSec: offsetEndSec ?? null,
            filePath: outFile, driveStatus: 'pending', createdAt: Date.now(),
            // --- player/dismissal linking, for the clips & stats APIs ---
            over: canonicalBall ? canonicalBall.over : (ballMeta && ballMeta.over),
            ballInOver: canonicalBall ? canonicalBall.ballInOver : (ballMeta && ballMeta.ballInOver),
            innings: canonicalBall ? canonicalBall.innings : (ballMeta && ballMeta.innings),
            runs: canonicalBall ? canonicalBall.runs : (ballMeta && ballMeta.runs),
            battingTeam,
            strikerName: striker, strikerKey: playerKey(striker), strikerPlayerId,
            nonStrikerName: nonStriker, nonStrikerKey: playerKey(nonStriker), nonStrikerPlayerId,
            bowlerName: bowler, bowlerKey: playerKey(bowler), bowlerPlayerId,
            dismissalType: dismissal && dismissal.type ? dismissal.type : null,
            fielderName: personName(dismissal && dismissal.fielder),
            fielderKey: playerKey(dismissal && dismissal.fielder), fielderPlayerId
        });
    }
    console.log(`🎬 Clip ready: ${outFile}`);
    // Upload to R2 + Drive in parallel, THEN delete the local Render-disk
    // copy — this is the only place video bytes ever touch Render's disk,
    // and only for the few seconds it takes to push them to cloud storage.
    // MongoDB never sees the video itself, only this clip doc's metadata
    // (matchId, player keys, eventType, r2Url/driveUrl) via the
    // clipsCollection.insertOne above.
    const [r2Ok, driveOk] = await Promise.all([
        uploadClipToR2(matchId, outFile, eventType, ballMeta),
        uploadClipToDrive(matchId, outFile, eventType, ballMeta)
    ]);
    if (r2Ok || driveOk) {
        fs.unlink(outFile, (err) => {
            if (err) console.log(`Local clip cleanup error (${outFile}):`, err.message || err);
            else console.log(`🧹 Removed local clip copy (now only in ${r2Ok ? 'R2' : ''}${r2Ok && driveOk ? '/' : ''}${driveOk ? 'Drive' : ''}): ${outFile}`);
        });
    } else {
        // Both uploads failed — keep the local file as a last-resort
        // fallback instead of losing the clip entirely. It'll be retried
        // never automatically today; worth adding a retry sweep later.
        console.log(`⚠️  Both R2 and Drive uploads failed — keeping local copy for now: ${outFile}`);
    }
    return { r2Ok, driveOk };
}

// ================================================================
// 🖥️ EXTERNAL CLIP INGEST — for ClipperHelper.exe (runs on the
// operator's own PC next to vMix, cuts the clip itself with its own
// local ffmpeg from the vMix recording file, then POSTs the finished
// .mp4 here as raw bytes). We do NOT trust the operator's PC with R2 or
// Drive credentials — this endpoint receives the plain video file and
// does the exact same player-linking + R2/Drive upload that the
// browser tab-capture pipeline (cutClip, above) does, via the shared
// finalizeClip() function. That's what makes ClipperHelper clips show
// up in the scorecard's "clips by player" view exactly like any other
// clip.
//
// POST /api/clips/ingest?matchId=...&eventType=FOUR|SIX|WICKET&timestamp=<ms>
// Body: raw video/mp4 bytes.
// Header 'X-Ball-Meta': optional JSON string with whatever the panel
// already knows about the ball (striker/nonStriker/bowler/dismissal/
// battingTeam/over/ballInOver/innings/runs) — same shape as the
// ballMeta cutClip() already accepts. Even without it, finalizeClip()
// still tries to resolve the real player names via findCanonicalBall()
// using matchId + timestamp-derived over/ballInOver if present.
// ================================================================
app.post('/api/clips/ingest', express.raw({ type: '*/*', limit: '60mb' }), async (req, res) => {
    const matchId = safeMatchId(req.query.matchId);
    const eventType = String(req.query.eventType || 'CLIP').toUpperCase();
    const eventTimestamp = parseInt(req.query.timestamp, 10) || Date.now();
    if (!matchId) return res.status(400).json({ success: false, error: 'matchId required' });
    if (!req.body || !req.body.length) return res.status(400).json({ success: false, error: 'Empty clip body' });

    let ballMeta = null;
    try {
        if (req.headers['x-ball-meta']) ballMeta = JSON.parse(req.headers['x-ball-meta']);
    } catch (err) { /* bad JSON from an old helper version — just skip linking-by-ballMeta */ }

    const clipDir = path.join(CLIPS_DIR, matchId);
    if (!fs.existsSync(clipDir)) fs.mkdirSync(clipDir, { recursive: true });
    const outFile = path.join(clipDir, `${eventType}_ext_${Date.now()}.mp4`);

    res.json({ success: true }); // acknowledge immediately; upload continues in the background

    try {
        await new Promise((resolve, reject) => {
            fs.writeFile(outFile, req.body, (err) => err ? reject(err) : resolve());
        });
        await finalizeClip({ matchId, eventType, eventTimestamp, ballMeta, uid: null, outFile });
    } catch (err) {
        console.log(`External clip ingest error (${matchId}/${eventType}):`, err.message || err);
    }
});

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

// ================================================================
// 🔐 GMAIL-BASED CREATOR ACCESS CONTROL — cricket "Select Sport" /
// tournament create/manage.
//
// Exactly these 3 Gmail accounts may see "Select Sport", pick Cricket, and
// create/edit/delete a tournament. Everyone else — signed out, or signed in
// with any other Gmail — is a read-only visitor of PUBLIC tournaments only.
//
// workallsportslive@gmail.com and vinitkrkr1@gmail.com's cricket
// tournaments are PUBLIC (listed + viewable by anyone). chhayajeeth@gmail.com's
// are PRIVATE — never listed, searched, or reachable by anyone except
// chhayajeeth@gmail.com, even via a direct/guessed public link.
//
// Configurable via env vars so this list can change without a redeploy of
// code; the literals are the agreed defaults / local-dev fallback.
// ================================================================
const AUTHORIZED_CREATOR_EMAILS = (process.env.AUTHORIZED_CREATOR_EMAILS
    ? process.env.AUTHORIZED_CREATOR_EMAILS.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
    : ['workallsportslive@gmail.com', 'vinitkrkr1@gmail.com', 'chhayajeeth@gmail.com']
);
const PRIVATE_CREATOR_EMAILS = new Set(
    (process.env.PRIVATE_CREATOR_EMAILS || 'chhayajeeth@gmail.com')
        .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
);
function isAuthorizedCreatorEmail(email) {
    return !!email && AUTHORIZED_CREATOR_EMAILS.includes(String(email).toLowerCase());
}
function isPrivateCreatorEmail(email) {
    return !!email && PRIVATE_CREATOR_EMAILS.has(String(email).toLowerCase());
}
// The 2 authorized emails whose tournaments are public (allowlist minus the
// private set) — computed once, used by the homepage directory below.
const PUBLIC_CREATOR_EMAILS = AUTHORIZED_CREATOR_EMAILS.filter(e => !isPrivateCreatorEmail(e));

// uid -> real account email, resolved via Firebase Admin SDK (never trusts
// a client-supplied email) and cached briefly since these don't change.
const uidEmailCache = new Map(); // uid -> { email, expiresAt }
const UID_EMAIL_CACHE_TTL_MS = 5 * 60 * 1000;
async function getVerifiedEmailForUid(uid) {
    if (!uid) return null;
    const hit = uidEmailCache.get(uid);
    if (hit && hit.expiresAt > Date.now()) return hit.email;
    try {
        const user = await admin.auth().getUser(uid);
        const email = (user.email || '').toLowerCase();
        uidEmailCache.set(uid, { email, expiresAt: Date.now() + UID_EMAIL_CACHE_TTL_MS });
        return email;
    } catch (err) {
        return null;
    }
}

// email -> uid, the reverse lookup, used by the homepage's public
// tournaments directory (needs each public creator's uid to query leagues).
const uidByEmailCache = new Map(); // email -> { uid, expiresAt }
async function getUidForEmail(email) {
    const key = String(email || '').toLowerCase();
    if (!key) return null;
    const hit = uidByEmailCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.uid;
    try {
        const user = await admin.auth().getUserByEmail(key);
        uidByEmailCache.set(key, { uid: user.uid, expiresAt: Date.now() + UID_EMAIL_CACHE_TTL_MS });
        return user.uid;
    } catch (err) {
        console.log(`getUidForEmail(${key}) — account may not have signed in yet:`, err.message);
        return null;
    }
}

// 🛡️ Real server-side gate for every tournament create/edit/delete route
// below (NOT just the "Select Sport"/"Create Tournament" buttons being
// hidden in the UI — those are convenience only). Resolves the REAL
// account email for the request's ownerUid via the Admin SDK (a client
// cannot lie about which email a uid belongs to) and rejects unless it's
// one of the 3 authorized Gmail accounts.
async function requireAuthorizedCreator(req, res, next) {
    const ownerUid = ownerUidFrom(req);
    if (!ownerUid) return res.status(401).json({ success: false, error: 'Login required (missing uid)' });
    const email = await getVerifiedEmailForUid(ownerUid);
    if (!isAuthorizedCreatorEmail(email)) {
        return res.status(403).json({ success: false, error: 'Access Denied: your account is not authorized to create or manage tournaments' });
    }
    req.creatorEmail = email;
    next();
}

// Resolves whether a league doc belongs to the private creator
// (chhayajeeth@gmail.com) — used to keep it out of every public
// list/token/API response for anyone else.
async function isPrivateLeagueDoc(doc) {
    if (!doc || !doc.ownerUid) return false;
    const email = await getVerifiedEmailForUid(doc.ownerUid);
    return isPrivateCreatorEmail(email);
}

// The verified (Firebase ID token) email of whoever is making this
// request, or null if there isn't a valid one attached. Used only to let
// chhayajeeth@gmail.com view their OWN private tournaments through the
// public portal routes — everyone else gets a 404 for those, same as if
// the tournament didn't exist.
async function verifiedRequesterEmail(req) {
    const idToken = extractIdToken(req);
    const decoded = await verifyIdTokenFull(idToken);
    return decoded ? decoded.email : null;
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

// 🏷️ SPORT DETECTION — /api/league/:name/match is generic and is called by
// every panel (cricket-panel, tt-panel, football-panel all point at the
// same league-save flow), but no caller has ever sent an explicit "which
// sport is this" field. Historically the only signal has been the
// tournament name itself (e.g. operators prefixing table-tennis tournaments
// with "TT::"), which is how a TT tournament ("TT::Amitabh") ended up
// showing on the public, cricket-only Tournaments section.
//
// Going forward, callers SHOULD pass an explicit `sport` in the save-match
// body (cricket-panel.html / tt-panel.html / football-panel.html can send
// `sport: 'cricket' | 'tabletennis' | 'football'`) — that's stored as-is and
// wins over any name guessing. Until every panel is updated to send it, this
// name-based fallback keeps existing/legacy tournaments correctly sorted.
function detectSportFromName(name) {
    const n = String(name || '').trim().toLowerCase();
    if (/^tt[\s:_-]|table[\s-]?tennis/.test(n)) return 'tabletennis';
    if (/^(fb|foot)[\s:_-]|football/.test(n)) return 'football';
    return 'cricket';
}
const SINGLE_MATCHES_LEAGUE_KEY = '__single_matches__'; // must match SINGLE_MATCHES_NAME in cricket-panel.html
function ownerUidFrom(req) {
    const uid = (req.query.uid || (req.body && req.body.uid) || '').toString().trim();
    return uid || null;
}

// 🩹 Every match now lives in its own matchRecords document (see the big
// comment above matchRecordsCollection's assignment in connectMongo) instead
// of inside a league doc's `matches[]` array. This helper is the read path
// every "all matches for a league" caller below shares.
async function getLeagueMatches(ownerUid, leagueKey) {
    return matchRecordsCollection.find({ ownerUid, leagueKey }).sort({ savedAt: 1 }).toArray();
}

// All matches saved under a league/tournament name, for one owner.
// 🔐 Gated: only an authorized creator account can read its own
// tournament-management data through this route (the public, read-only
// view for everyone else is the separate /api/public/tournament/:token
// section further below).
app.get('/api/league/:name', requireAuthorizedCreator, async (req, res) => {
    const leagueKey = leagueKeyFor(req.params.name);
    const ownerUid = ownerUidFrom(req);
    if (!leagueKey) return res.status(400).json({ success: false, error: 'League name required' });
    if (!ownerUid) return res.status(401).json({ success: false, error: 'Login required (missing uid)' });
    if (!matchRecordsCollection) return res.json({ success: true, matches: [] }); // Mongo not configured — panel falls back to its local cache
    try {
        const matches = await getLeagueMatches(ownerUid, leagueKey);
        // Also hand back whether the tournament has been marked completed
        // (see POST /api/league/:name/complete below), so the panel can show
        // the real current state of the "Mark Tournament as Completed"
        // button instead of guessing/always defaulting to "not completed".
        let completed = false;
        if (leaguesCollection) {
            const doc = await leaguesCollection.findOne({ ownerUid, leagueKey }, { projection: { completed: 1 } });
            completed = !!(doc && doc.completed);
        }
        res.json({ success: true, matches, completed });
    } catch (err) {
        console.log('League fetch error:', err);
        res.status(500).json({ success: false, error: 'Could not load league data' });
    }
});

// Upserts one match record into a league by matchId — re-saving after a
// correction (or the panel's automatic save-on-victory) updates the same
// entry instead of duplicating it, same as the old localStorage version.
// 🩹 This is now a single atomic upsert on that ONE match's own document —
// no more read-the-whole-league-then-rewrite-the-whole-array, so saving one
// match can never be slowed down or size-capped by every other match this
// owner has ever saved, and two saves landing at the same time can't clobber
// each other's matches the way the old whole-array $set could.
app.post('/api/league/:name/match', requireAuthorizedCreator, async (req, res) => {
    const leagueKey = leagueKeyFor(req.params.name);
    const ownerUid = ownerUidFrom(req);
    const record = req.body;
    if (!leagueKey) return res.status(400).json({ success: false, error: 'League name required' });
    if (!ownerUid) return res.status(401).json({ success: false, error: 'Login required (missing uid)' });
    if (!record || !record.matchId) return res.status(400).json({ success: false, error: 'Match record with matchId required' });
    if (!matchRecordsCollection || !leaguesCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    try {
        // 🩹 CLIPS FIX: clips are cut and tagged with the live *roomId*
        // (see cutClip()/io.on('connection') above), never with this
        // record's matchId — a tournament match's matchId is a separate
        // UUID minted client-side (ensureTournamentMatchId()), so without
        // this, clips recorded during the live broadcast become
        // unreachable the moment the match is saved under its tournament
        // matchId. The panel already tells us this mapping while the
        // match is live, via /api/league/:name/live-status (roomId +
        // matchId together) — so if the save payload itself doesn't carry
        // a roomId, backfill it from that same league doc here, before
        // it's potentially lost when a later active:false ping prunes the
        // liveMatches entry.
        let roomId = record.roomId || null;
        if (!roomId) {
            const liveDoc = await leaguesCollection.findOne(
                { ownerUid, leagueKey },
                { projection: { liveMatches: 1, liveMatchId: 1, liveRoomId: 1 } }
            );
            if (liveDoc) {
                const liveEntry = (liveDoc.liveMatches || []).find(lm => lm.matchId === record.matchId);
                roomId = (liveEntry && liveEntry.roomId)
                    || (liveDoc.liveMatchId === record.matchId ? liveDoc.liveRoomId : null)
                    || null;
            }
        }
        await matchRecordsCollection.updateOne(
            { ownerUid, leagueKey, matchId: record.matchId },
            { $set: { ...record, roomId: roomId || record.roomId || null, ownerUid, leagueKey, savedAt: record.savedAt || new Date().toISOString() } },
            { upsert: true }
        );
        // League doc itself stays tiny now — just metadata (displayName,
        // publicToken, live pointer). matches[] is intentionally never
        // written here anymore.
        // Prefer an explicit sport sent by the panel; fall back to guessing
        // from the tournament name for panels that don't send it yet.
        const sport = record.sport || req.body.sport || detectSportFromName(req.params.name);
        await leaguesCollection.updateOne(
            { ownerUid, leagueKey },
            {
                $set: { ownerUid, leagueKey, displayName: (req.params.name || '').trim(), sport, updatedAt: Date.now() },
                // 🏷️ createdBy: locked in once, on first save, to whichever
                // authorized creator account actually made it (req.creatorEmail
                // comes from requireAuthorizedCreator's verified ID token, never
                // a client-supplied value). $setOnInsert so it's never
                // overwritten by a later save under the same league — used only
                // by the Owner Admin Panel to show "Created by" (see
                // GET /api/admin/tournaments/search); never exposed publicly.
                $setOnInsert: { createdBy: req.creatorEmail || null }
            },
            { upsert: true }
        );
        const matches = await getLeagueMatches(ownerUid, leagueKey);
        res.json({ success: true, matches });
    } catch (err) {
        console.log('League save error:', err);
        res.status(500).json({ success: false, error: 'Could not save match' });
    }
});

// Removes one match from a league.
app.delete('/api/league/:name/match/:matchId', requireAuthorizedCreator, async (req, res) => {
    const leagueKey = leagueKeyFor(req.params.name);
    const ownerUid = ownerUidFrom(req);
    if (!leagueKey) return res.status(400).json({ success: false, error: 'League name required' });
    if (!ownerUid) return res.status(401).json({ success: false, error: 'Login required (missing uid)' });
    if (!matchRecordsCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    try {
        await matchRecordsCollection.deleteOne({ ownerUid, leagueKey, matchId: req.params.matchId });
        const matches = await getLeagueMatches(ownerUid, leagueKey);
        res.json({ success: true, matches });
    } catch (err) {
        console.log('League delete error:', err);
        res.status(500).json({ success: false, error: 'Could not delete match' });
    }
});

// 🩹 NEW: deletes an ENTIRE tournament/league — the league doc itself
// (name, publicToken, sport, live pointer) plus every match saved under it.
// Nothing previously removed the league doc: deleting all of a tournament's
// matches one-by-one via the route above left an empty "ghost" tournament
// (0 matches, publicToken still set) behind forever, which is why deleted
// tournaments kept reappearing on the public Tournaments section.
app.delete('/api/league/:name', requireAuthorizedCreator, async (req, res) => {
    const leagueKey = leagueKeyFor(req.params.name);
    const ownerUid = ownerUidFrom(req);
    if (!leagueKey) return res.status(400).json({ success: false, error: 'League name required' });
    if (!ownerUid) return res.status(401).json({ success: false, error: 'Login required (missing uid)' });
    if (leagueKey === SINGLE_MATCHES_LEAGUE_KEY) return res.status(400).json({ success: false, error: 'Cannot delete the single-matches bucket' });
    if (!leaguesCollection || !matchRecordsCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    try {
        await matchRecordsCollection.deleteMany({ ownerUid, leagueKey });
        await leaguesCollection.deleteOne({ ownerUid, leagueKey });
        publicTournamentsListCache = null; // don't serve the stale list for up to 8s
        res.json({ success: true });
    } catch (err) {
        console.log('League (tournament) delete error:', err);
        res.status(500).json({ success: false, error: 'Could not delete tournament' });
    }
});

// 🏁 Marks a tournament as finished/not-finished. "Completed" on the public
// Tournaments section previously just meant "has ≥1 saved match" — which
// made a tournament that's still ongoing (only 1 of many matches played so
// far) show as "Completed" the moment its first match was saved. Now
// "Completed" only ever comes from this explicit flag, set by the operator
// when the tournament is actually over (see status logic in
// /api/public/tournaments below).
app.post('/api/league/:name/complete', requireAuthorizedCreator, async (req, res) => {
    const leagueKey = leagueKeyFor(req.params.name);
    const ownerUid = ownerUidFrom(req);
    const completed = !!(req.body && req.body.completed);
    if (!leagueKey) return res.status(400).json({ success: false, error: 'League name required' });
    if (!ownerUid) return res.status(401).json({ success: false, error: 'Login required (missing uid)' });
    if (!leaguesCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    try {
        await leaguesCollection.updateOne(
            { ownerUid, leagueKey },
            { $set: { completed, completedAt: completed ? Date.now() : null } }
        );
        publicTournamentsListCache = null; // reflect the change immediately, not after up to 8s
        res.json({ success: true, completed });
    } catch (err) {
        console.log('League complete-toggle error:', err);
        res.status(500).json({ success: false, error: 'Could not update tournament status' });
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
    return String(personName(name) || '').trim().toLowerCase() || null;
}

// 🛡️ Defense-in-depth: some client somewhere (past or future) might send
// a whole {name, runs, balls,...} object instead of a plain name string
// for striker/bowler/nonStriker/fielder — that's exactly what silently
// turned every strikerKey/bowlerKey into the literal text "[object
// Object]" for every ball ever logged, until the panel-side fix. Every
// place that turns one of these fields into a name/key now goes through
// this first, so a stray object never breaks linking again.
function personName(x) {
    if (!x) return null;
    if (typeof x === 'string') return x.trim() || null;
    if (typeof x === 'object' && typeof x.name === 'string') return x.name.trim() || null;
    return null; // don't stringify unknown shapes into "[object Object]"
}

// ================================================================
// 🌟 GLOBAL PLAYER PROFILES (playerId) — see playersCollection comment in
// connectMongo. Every ball/clip is still keyed by nameKey (playerKey(name))
// for backward compatibility with every existing query in this file; a
// playerId doc is a thin, mergeable layer ON TOP that groups one or more
// nameKeys under one permanent identity, so a scorer's typo/variant on a
// second device doesn't fragment a player's stats.
// ================================================================

// Find-or-create the playerId for (ownerUid, name). Memoized in-process
// since this gets called on every single ball logged — avoids a Mongo
// round-trip for the common case of the same four names repeating over and
// over within one match.
const playerIdCache = new Map(); // `${ownerUid}::${nameKey}` -> playerId
async function resolvePlayerId(ownerUid, name) {
    const nameKey = playerKey(name);
    if (!nameKey || !ownerUid || !playersCollection) return null;
    const cacheKey = `${ownerUid}::${nameKey}`;
    if (playerIdCache.has(cacheKey)) return playerIdCache.get(cacheKey);
    try {
        const existing = await playersCollection.findOne({ ownerUid, nameKeys: nameKey });
        if (existing) {
            playerIdCache.set(cacheKey, existing.playerId);
            return existing.playerId;
        }
        const playerId = crypto.randomBytes(6).toString('hex'); // 12-char id
        await playersCollection.insertOne({
            playerId, ownerUid, nameKeys: [nameKey],
            displayName: personName(name) || String(name).trim(),
            createdAt: Date.now(), updatedAt: Date.now()
        });
        playerIdCache.set(cacheKey, playerId);
        return playerId;
    } catch (err) {
        // Unique-index race: two balls for a brand-new player logged at
        // nearly the same instant can both miss the findOne above and both
        // try to insert — the loser just re-looks-up instead of erroring.
        if (err && err.code === 11000) {
            const existing = await playersCollection.findOne({ ownerUid, nameKeys: nameKey });
            if (existing) { playerIdCache.set(cacheKey, existing.playerId); return existing.playerId; }
        }
        console.log('resolvePlayerId error:', err);
        return null;
    }
}

// 🌟 Same job as resolvePlayerId() above, but for callers that already
// know the player's identity from a client-side roster (see cricket-panel
// TEAM SQUADS) instead of having to guess it from a name string. Upserts
// the SAME playersCollection doc under the client's own ID rather than
// generating a new hex one, so two players who happen to share a name
// (even on different teams) never collide into a single profile — the
// exact failure mode name-only resolution can't avoid. Falls back to the
// normal name-based resolvePlayerId() when no explicit ID is given, so
// every caller/client that doesn't send one behaves exactly as before.
async function resolvePlayerIdExplicit(ownerUid, explicitId, name){
  if(!explicitId) return resolvePlayerId(ownerUid, name);
  if(!ownerUid || !playersCollection) return explicitId;
  const nameKey = playerKey(name);
  try{
    await playersCollection.updateOne(
      { playerId: explicitId, ownerUid },
      {
        $setOnInsert: { playerId: explicitId, ownerUid, createdAt: Date.now(), displayName: personName(name) || String(name || '').trim() },
        $set: { updatedAt: Date.now() },
        ...(nameKey ? { $addToSet: { nameKeys: nameKey } } : {})
      },
      { upsert: true }
    );
  }catch(err){
    console.log('resolvePlayerIdExplicit error:', err);
  }
  return explicitId;
}


// queries can match on "any of this player's known spellings" instead of
// just one. Returns [] if the playerId doesn't exist (caller should treat
// that as "no results" rather than falling back to raw playerId as a key).
async function nameKeysForPlayerId(playerId) {
    if (!playersCollection || !playerId) return [];
    try {
        const doc = await playersCollection.findOne({ playerId }, { projection: { nameKeys: 1 } });
        return (doc && doc.nameKeys) || [];
    } catch (err) {
        console.log('nameKeysForPlayerId error:', err);
        return [];
    }
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
    if (!matchRecordsCollection) return null;
    try {
        const doc = await matchRecordsCollection.findOne(
            { matchId },
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
app.post('/api/league/:name/public-link', requireAuthorizedCreator, async (req, res) => {
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
app.post('/api/league/:name/live-status', requireAuthorizedCreator, async (req, res) => {
    const leagueKey = leagueKeyFor(req.params.name);
    const ownerUid = ownerUidFrom(req);
    if (!leagueKey) return res.status(400).json({ success: false, error: 'League name required' });
    if (!ownerUid) return res.status(401).json({ success: false, error: 'Login required (missing uid)' });
    if (!leaguesCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    const { roomId, matchId, active } = req.body || {};
    try {
        // 🩹 liveMatches is an ARRAY, not a single field — the same
        // tournament can have MULTIPLE matches being scored at once, each
        // on its own device/room (Laptop 1 → Match A, Laptop 2 → Match B,
        // same tournament, same account). The old singular liveRoomId/
        // liveMatchId meant a second match starting silently kicked the
        // first match's viewers off the public portal's "Live Now" card.
        // liveRoomId/liveMatchId are still kept, mirroring whichever match
        // most recently pinged, purely so any older frontend reading only
        // those singular fields keeps working exactly as before.
        if (active === false) {
            if (matchId) {
                await leaguesCollection.updateOne({ ownerUid, leagueKey }, { $pull: { liveMatches: { matchId } } });
            }
            const doc = await leaguesCollection.findOne({ ownerUid, leagueKey }, { projection: { liveMatches: 1 } });
            const remaining = (doc && doc.liveMatches) || [];
            const mostRecent = remaining[remaining.length - 1] || null;
            await leaguesCollection.updateOne(
                { ownerUid, leagueKey },
                { $set: { liveRoomId: mostRecent ? mostRecent.roomId : null, liveMatchId: mostRecent ? mostRecent.matchId : null, updatedAt: Date.now() } },
                { upsert: true }
            );
        } else {
            // Drop any existing entry for this matchId first so a re-ping
            // (every ball, debounced) never creates duplicate array entries.
            await leaguesCollection.updateOne({ ownerUid, leagueKey }, { $pull: { liveMatches: { matchId } } });
            await leaguesCollection.updateOne(
                { ownerUid, leagueKey },
                {
                    $push: { liveMatches: { roomId: roomId || null, matchId: matchId || null, startedAt: Date.now() } },
                    $set: { liveRoomId: roomId || null, liveMatchId: matchId || null, updatedAt: Date.now() }
                },
                { upsert: true }
            );
        }
        res.json({ success: true });
    } catch (err) {
        console.log('Live-status update error:', err);
        res.status(500).json({ success: false });
    }
});

// ---- PUBLIC, READ-ONLY endpoints — no uid/auth, the token itself is the
// access control, and ownerUid is never included in any response. -------

// 🚀 Tiny in-memory TTL cache for the public tournament portal — this is
// the one endpoint every one of a tournament's viewers polls repeatedly
// (potentially thousands at once, see the 5,000-concurrent-viewer target),
// and it does real work every call: pulling every saved match for the
// league AND recomputing the points table + leaderboards from scratch. A
// short TTL means a live tournament still updates within a few seconds of
// a new ball, but a burst of simultaneous requests only recomputes once
// instead of once per viewer. Deliberately process-memory (not Redis) to
// avoid a new infra dependency for a single-process win; safe to swap for
// Redis later if this ever runs across multiple server instances.
const PUBLIC_CACHE_TTL_MS = 4000;
const publicTournamentCache = new Map(); // token -> { expiresAt, payload }
function getCached(cache, key) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.payload;
    return null;
}
function setCached(cache, key, payload, ttlMs) {
    cache.set(key, { payload, expiresAt: Date.now() + ttlMs });
}

// Full tournament portal payload: sanitized match list + live pointer +
// points table + leaderboards, all computed fresh from matchRecords (one
// doc per match — see the big comment above matchRecordsCollection's
// assignment) instead of a legacy matches[] array on the league doc.
app.get('/api/public/tournament/:token', async (req, res) => {
    if (!leaguesCollection || !matchRecordsCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    try {
        const doc = await leaguesCollection.findOne({ publicToken: req.params.token });
        if (!doc) return res.status(404).json({ success: false, error: 'Tournament not found' });

        // 🔒 PRIVACY: chhayajeeth@gmail.com's tournaments are private. Even
        // with a valid/guessed token, nobody but a verified chhayajeeth
        // request gets the data — respond exactly like an unknown token so
        // existence can't be inferred either.
        if (await isPrivateLeagueDoc(doc)) {
            const requesterEmail = await verifiedRequesterEmail(req);
            if (!isPrivateCreatorEmail(requesterEmail)) {
                return res.status(404).json({ success: false, error: 'Tournament not found' });
            }
        }

        const cached = getCached(publicTournamentCache, req.params.token);
        if (cached) return res.json(cached);
        const matches = await getLeagueMatches(doc.ownerUid, doc.leagueKey);
        const payload = {
            success: true,
            displayName: doc.displayName || '',
            matches,
            // roomId/matchId: most-recently-active match, for older
            // frontends. matches: every match currently live under this
            // tournament at once (see the live-status route comment above).
            live: { roomId: doc.liveRoomId || null, matchId: doc.liveMatchId || null, matches: doc.liveMatches || [] },
            pointsTable: computePointsTable(matches),
            leaderboards: computeLeaderboards(matches)
        };
        setCached(publicTournamentCache, req.params.token, payload, PUBLIC_CACHE_TTL_MS);
        res.json(payload);
    } catch (err) {
        console.log('Public tournament fetch error:', err);
        res.status(500).json({ success: false, error: 'Could not load tournament' });
    }
});

// One specific match's full scorecard within a tournament.
app.get('/api/public/tournament/:token/match/:matchId', async (req, res) => {
    if (!leaguesCollection || !matchRecordsCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    try {
        const doc = await leaguesCollection.findOne({ publicToken: req.params.token });
        if (!doc) return res.status(404).json({ success: false, error: 'Tournament not found' });

        // 🔒 Same private-tournament rule as /api/public/tournament/:token above.
        if (await isPrivateLeagueDoc(doc)) {
            const requesterEmail = await verifiedRequesterEmail(req);
            if (!isPrivateCreatorEmail(requesterEmail)) {
                return res.status(404).json({ success: false, error: 'Tournament not found' });
            }
        }

        const match = await matchRecordsCollection.findOne({ ownerUid: doc.ownerUid, leagueKey: doc.leagueKey, matchId: req.params.matchId });
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
// __single_matches__ matchRecords by matchId/roomId rather than needing an
// ownerUid, since a public link never carries one.
app.get('/api/public/match/:id', async (req, res) => {
    if (!matchRecordsCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    const id = req.params.id;
    try {
        const match = await matchRecordsCollection.findOne({
            leagueKey: SINGLE_MATCHES_LEAGUE_KEY,
            $or: [{ matchId: id }, { roomId: id }]
        });
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
// 🏠 HOMEPAGE TOURNAMENTS DIRECTORY — public, read-only, no auth.
// "All tournaments" means every cricket league that a PUBLIC authorized
// creator (workallsportslive@gmail.com, vinitkrkr1@gmail.com) has
// generated a public link for — same trust model as
// /api/public/tournament/:token above, just listed instead of requiring
// the token up front. chhayajeeth@gmail.com's tournaments are private and
// are never included here (getVerifiedEmailForUid/isPrivateLeagueDoc keeps
// them out even defensively, on top of only querying the 2 public uids).
// Cards on the homepage link straight to the existing
// /score/tournament/:token page, which already renders matches,
// scorecards, stats and clips — nothing is duplicated here.
// ================================================================
async function getPublicCreatorUids() {
    const uids = await Promise.all(PUBLIC_CREATOR_EMAILS.map(getUidForEmail));
    return uids.filter(Boolean);
}

const PUBLIC_TOURNAMENTS_CACHE_TTL_MS = 8000;
let publicTournamentsListCache = null; // { expiresAt, payload }

app.get('/api/public/tournaments', async (req, res) => {
    if (!leaguesCollection || !matchRecordsCollection) return res.json({ success: true, tournaments: [] });
    try {
        // 🔐 OWNER VIEW: only when the request carries a verified Firebase ID
        // token for the exact OWNER_EMAIL account (chhayajeeth@gmail.com —
        // never trusted from anything client-supplied) do we include EVERY
        // creator's tournaments here, private ones included, each tagged
        // with who made it and whether it's private. This response is never
        // written into publicTournamentsListCache — that cache is shared by
        // every anonymous visitor, and must never end up holding private
        // data or creator emails.
        const requesterEmail = await verifiedRequesterEmail(req);
        const isOwnerViewer = requesterEmail === OWNER_EMAIL;

        if (isOwnerViewer) {
            const ownerUids = await Promise.all(AUTHORIZED_CREATOR_EMAILS.map(getUidForEmail));
            const uidToEmail = new Map(AUTHORIZED_CREATOR_EMAILS.map((email, i) => [ownerUids[i], email]));
            const validUids = ownerUids.filter(Boolean);
            if (validUids.length === 0) return res.json({ success: true, tournaments: [] });

            const leagues = await leaguesCollection.find({
                ownerUid: { $in: validUids },
                leagueKey: { $ne: SINGLE_MATCHES_LEAGUE_KEY },
                publicToken: { $exists: true, $ne: null }
            }).project({ ownerUid: 1, leagueKey: 1, displayName: 1, publicToken: 1, updatedAt: 1, liveMatches: 1, sport: 1, completed: 1, statusOverride: 1, createdBy: 1 }).toArray();

            const allTournaments = await Promise.all(leagues.map(async doc => {
                const matches = await getLeagueMatches(doc.ownerUid, doc.leagueKey);
                const isLive = !!(doc.liveMatches && doc.liveMatches.length > 0);
                const creatorEmail = doc.createdBy || uidToEmail.get(doc.ownerUid) || null;
                return {
                    token: doc.publicToken,
                    name: doc.displayName || doc.leagueKey,
                    status: doc.statusOverride || (isLive ? 'live' : (doc.completed ? 'completed' : (matches.length > 0 ? 'ongoing' : 'upcoming'))),
                    matchCount: matches.length,
                    updatedAt: doc.updatedAt || 0,
                    sport: doc.sport || detectSportFromName(doc.displayName || doc.leagueKey),
                    // Owner-only fields — never present in the normal (cached,
                    // anonymous) response below.
                    createdBy: creatorEmail || 'Unknown',
                    isPrivate: isPrivateCreatorEmail(creatorEmail)
                };
            }));

            const tournaments = allTournaments.filter(t => t.sport === 'cricket');
            tournaments.sort((a, b) => {
                if ((a.status === 'live') !== (b.status === 'live')) return a.status === 'live' ? -1 : 1;
                return (b.updatedAt || 0) - (a.updatedAt || 0);
            });
            return res.json({ success: true, tournaments, ownerView: true });
        }

        if (publicTournamentsListCache && publicTournamentsListCache.expiresAt > Date.now()) {
            return res.json(publicTournamentsListCache.payload);
        }
        const ownerUids = await getPublicCreatorUids();
        if (ownerUids.length === 0) return res.json({ success: true, tournaments: [] });

        const leagues = await leaguesCollection.find({
            ownerUid: { $in: ownerUids },
            leagueKey: { $ne: SINGLE_MATCHES_LEAGUE_KEY },
            publicToken: { $exists: true, $ne: null }
        }).project({ ownerUid: 1, leagueKey: 1, displayName: 1, publicToken: 1, updatedAt: 1, liveMatches: 1, sport: 1, completed: 1, statusOverride: 1 }).toArray();

        const allTournaments = await Promise.all(leagues.map(async doc => {
            const matches = await getLeagueMatches(doc.ownerUid, doc.leagueKey);
            const isLive = !!(doc.liveMatches && doc.liveMatches.length > 0);
            return {
                token: doc.publicToken,
                name: doc.displayName || doc.leagueKey,
                // Manual override (set only via the owner-only admin route
                // POST /api/admin/tournaments/:leagueKey/status) always wins.
                // Otherwise: 'live' while a match is actually live, 'completed'
                // only once the operator has explicitly marked the WHOLE
                // tournament finished (doc.completed) — NOT just "has a saved
                // match", 'ongoing' once matches exist but it isn't finished
                // yet, else 'upcoming'.
                status: doc.statusOverride || (isLive ? 'live' : (doc.completed ? 'completed' : (matches.length > 0 ? 'ongoing' : 'upcoming'))),
                matchCount: matches.length,
                updatedAt: doc.updatedAt || 0,
                // Legacy docs saved before `sport` existed on the league doc
                // don't have it stored — fall back to the same name-based
                // guess used at save time (see detectSportFromName above).
                sport: doc.sport || detectSportFromName(doc.displayName || doc.leagueKey)
            };
        }));

        // Public Tournaments section on index.html is cricket-only — Football
        // and Table Tennis tournaments (e.g. "TT::Amitabh") must never appear
        // here even though they live in the same leaguesCollection.
        const tournaments = allTournaments.filter(t => t.sport === 'cricket');

        tournaments.sort((a, b) => {
            if ((a.status === 'live') !== (b.status === 'live')) return a.status === 'live' ? -1 : 1;
            return (b.updatedAt || 0) - (a.updatedAt || 0);
        });

        const payload = { success: true, tournaments };
        publicTournamentsListCache = { payload, expiresAt: Date.now() + PUBLIC_TOURNAMENTS_CACHE_TTL_MS };
        res.json(payload);
    } catch (err) {
        console.log('Public tournaments list error:', err);
        res.status(500).json({ success: false, tournaments: [] });
    }
});

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
// Shared core for both /api/clips/player/:playerKey and
// /api/players/:playerId/clips — pk may be a single nameKey or an array of
// nameKeys (merged playerId aliases). Returns a result object rather than
// writing to res, same pattern as runPlayerStatsQuery above.
async function runPlayerClipsQuery(pk, req) {
    if (!clipsCollection) return { httpError: 503, message: 'Database not configured' };
    const pkSet = new Set(Array.isArray(pk) ? pk : [pk]);
    const pkList = [...pkSet];
    const scope = req.query.scope || 'match';

    let matchFilter = null; // null = no matchId restriction (career, or tournament resolved below)
    if (scope === 'match') {
        if (!req.query.matchId) return { httpError: 400, message: 'matchId required for scope=match' };
        matchFilter = { $in: [safeMatchId(req.query.matchId)] };
    } else if (scope === 'tournament') {
        const leagueKey = leagueKeyFor(req.query.leagueName);
        const ownerUid = ownerUidFrom(req);
        if (!leagueKey || !ownerUid || !matchRecordsCollection) return { httpError: 400, message: 'leagueName and uid required for scope=tournament' };
        const ids = await matchRecordsCollection.find({ ownerUid, leagueKey }, { projection: { matchId: 1 } }).toArray();
        matchFilter = { $in: ids.map(m => m.matchId) };
    }
    // scope === 'career' (or 'season', best-effort — no explicit season
    // field exists on matches yet, so career and season currently return
    // the same set; filter by year client-side using each clip's createdAt
    // until a real season field is added) — no matchId restriction, just
    // ownerUid if we have one, so results stay scoped to one account.

    const base = { $or: [{ strikerKey: { $in: pkList } }, { bowlerKey: { $in: pkList } }, { fielderKey: { $in: pkList } }] };
    if (matchFilter) base.matchId = matchFilter;
    const ownerUid = ownerUidFrom(req);
    if (!matchFilter && ownerUid) base.ownerUid = ownerUid;

    const clips = await clipsCollection.find(base).sort({ createdAt: -1 }).limit(300).toArray();
    const out = { fours: [], sixes: [], dismissal: [], wickets: [] };
    clips.forEach(c => {
        const s = serializeClip(c);
        if (pkSet.has(c.strikerKey) && c.eventType === 'FOUR') out.fours.push(s);
        else if (pkSet.has(c.strikerKey) && c.eventType === 'SIX') out.sixes.push(s);
        else if (pkSet.has(c.strikerKey) && c.eventType === 'WICKET') out.dismissal.push(s);
        if (pkSet.has(c.bowlerKey) && c.eventType === 'WICKET') out.wickets.push(s);
    });
    return { scope, batting: { fours: out.fours, sixes: out.sixes, dismissal: out.dismissal }, bowling: { wickets: out.wickets } };
}

app.get('/api/clips/player/:playerKey', async (req, res) => {
    const pk = playerKey(req.params.playerKey);
    if (!pk) return res.status(400).json({ success: false, error: 'playerKey required' });
    try {
        const result = await runPlayerClipsQuery(pk, req);
        if (result.httpError) return res.status(result.httpError).json({ success: false, error: result.message });
        res.json({ success: true, playerKey: pk, ...result });
    } catch (err) {
        console.log('Player-clips fetch error:', err);
        res.status(500).json({ success: false, error: 'Could not load player clips' });
    }
});

// GET /api/players/:playerId/clips?scope=match|tournament|career&...
app.get('/api/players/:playerId/clips', async (req, res) => {
    const pks = await nameKeysForPlayerId(req.params.playerId);
    if (!pks.length) return res.status(404).json({ success: false, error: 'Player not found' });
    try {
        const result = await runPlayerClipsQuery(pks, req);
        if (result.httpError) return res.status(result.httpError).json({ success: false, error: result.message });
        res.json({ success: true, playerId: req.params.playerId, ...result });
    } catch (err) {
        console.log('Player-clips (by playerId) fetch error:', err);
        res.status(500).json({ success: false, error: 'Could not load player clips' });
    }
});

// Quick existence check before trusting a saved r2Url — once clips start
// getting deleted from R2 after ~1 year (retention plan), the Mongo record
// still has r2Url sitting on it forever unless someone remembers to clear
// it. A HEAD request is cheap and confirms the object is actually still
// there before we redirect/stream a viewer to it; on any failure (404,
// network error, whatever) we treat it as "not on R2 anymore" and let the
// caller fall back to Drive instead of handing back a dead link.
async function r2ObjectExists(url) {
    try {
        const headRes = await fetch(url, { method: 'HEAD' });
        return headRes.ok;
    } catch (err) {
        return false;
    }
}

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
// the edge — see uploadClipToR2 above); if R2 doesn't have it anymore (or
// never did) and only Drive has it, we proxy the bytes through our own
// server instead of sending the user to Drive's UI.
app.get('/api/clips/:clipId/watch', async (req, res) => {
    try {
        const clip = await resolvePlayableClip(req.params.clipId);
        if (!clip) return res.status(404).json({ success: false, error: 'Clip not found' });
        if (clip.r2Url && await r2ObjectExists(clip.r2Url)) {
            return res.redirect(302, clip.r2Url);
        }
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
// that header on plain object URLs); if the R2 fetch fails (object gone —
// e.g. past the 1-year retention window) we fall back to Drive the same
// way /watch does, instead of erroring out; Drive clips use the same proxy
// path as /watch, just with the attachment header added.
app.get('/api/clips/:clipId/download', async (req, res) => {
    try {
        const clip = await resolvePlayableClip(req.params.clipId);
        if (!clip) return res.status(404).json({ success: false, error: 'Clip not found' });
        const filename = `${clip.eventType || 'clip'}_over-${clip.over ?? ''}.${clip.ballInOver ?? ''}_${clip.strikerName || clip.bowlerName || ''}.mp4`.replace(/\s+/g, '-');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'video/mp4');
        if (clip.r2Url) {
            try {
                const r2Res = await fetch(clip.r2Url);
                if (r2Res.ok && r2Res.body) {
                    const { Readable } = require('stream');
                    return Readable.fromWeb(r2Res.body).pipe(res);
                }
                console.log(`R2 fetch not OK for clip ${clip._id} (status ${r2Res.status}) — falling back to Drive`);
            } catch (r2Err) {
                console.log(`R2 fetch error for clip ${clip._id}, falling back to Drive:`, r2Err.message || r2Err);
            }
            // R2 missing/failed — fall through to the Drive branch below
            // instead of returning an error, same recovery as /watch.
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
// NOT credited as a bowler wicket. A maiden over is one bowled entirely by
// this bowler (6 legal deliveries, no wides/no-balls) with zero runs
// conceded off it (including byes/leg-byes charged against the over).
// Adjust here if cricket-panel.html's `kind`/`dismissal.type` strings
// differ from the values assumed below.
async function computeMatchPlayerStats(matchId, pk) {
    // pk may be a single nameKey (existing callers) or an array of nameKeys
    // — a merged playerId's aliases (see nameKeysForPlayerId). Normalize to
    // a Set once so every ball only pays for one membership check.
    const pkSet = new Set(Array.isArray(pk) ? pk : [pk]);
    const isPk = (v) => pkSet.has(v);
    const balls = await ballsCollection.find({ matchId, $or: [{ strikerKey: { $in: [...pkSet] } }, { bowlerKey: { $in: [...pkSet] } }] }).toArray();
    const bat = { runs: 0, balls: 0, fours: 0, sixes: 0, out: false, howOut: null };
    const bowl = { balls: 0, runs: 0, wickets: 0, wides: 0, noballs: 0 };
    const oversBowled = {}; // `${innings}-${over}` -> { legalBalls, runs }
    balls.forEach(b => {
        if (isPk(b.strikerKey) && b.kind !== 'Wd') {
            bat.balls++;
            if (b.kind !== 'B' && b.kind !== 'LB') bat.runs += b.runs || 0;
            if (b.kind === '4') bat.fours++;
            if (b.kind === '6') bat.sixes++;
        }
        if (isPk(b.strikerKey) && b.dismissal) {
            bat.out = true;
            bat.howOut = b.dismissal.type || null;
        }
        if (isPk(b.bowlerKey) && b.kind !== 'B' && b.kind !== 'LB') {
            const isLegal = b.kind !== 'Wd' && b.kind !== 'Nb';
            if (isLegal) bowl.balls++;
            if (b.kind === 'Wd') bowl.wides++;
            if (b.kind === 'Nb') bowl.noballs++;
            bowl.runs += b.runs || 0;
            if (b.dismissal && b.dismissal.type && b.dismissal.type.toLowerCase() !== 'run out') bowl.wickets++;

            const overKey = `${b.innings || 1}-${b.over}`;
            if (!oversBowled[overKey]) oversBowled[overKey] = { legalBalls: 0, runs: 0 };
            if (isLegal) oversBowled[overKey].legalBalls++;
            oversBowled[overKey].runs += b.runs || 0;
        }
    });
    const maidens = Object.values(oversBowled).filter(o => o.legalBalls === 6 && o.runs === 0).length;
    return {
        batting: { runs: bat.runs, balls: bat.balls, fours: bat.fours, sixes: bat.sixes, out: bat.out, howOut: bat.howOut, strikeRate: bat.balls ? Number(((bat.runs / bat.balls) * 100).toFixed(2)) : 0 },
        bowling: { overs: `${Math.floor(bowl.balls / 6)}.${bowl.balls % 6}`, maidens, runs: bowl.runs, wickets: bowl.wickets, wides: bowl.wides, noballs: bowl.noballs, economy: bowl.balls ? Number((bowl.runs / (bowl.balls / 6)).toFixed(2)) : 0 }
    };
}

// Filters computeLeaderboards' per-match rollup down to a single player,
// across whatever set of saved matches[] is passed in (one tournament, or
// every league belonging to an owner for career).
function computeSinglePlayerRollup(matches, pk) {
    // pk may be a single nameKey or an array of nameKeys (merged playerId
    // aliases) — see computeMatchPlayerStats for the same normalization.
    const pkSet = new Set(Array.isArray(pk) ? pk : [pk]);
    const { topRuns, topWickets } = computeLeaderboards(matches);
    return {
        batting: topRuns.find(r => pkSet.has(playerKey(r.name))) || null,
        bowling: topWickets.find(r => pkSet.has(playerKey(r.name))) || null
    };
}

// Shared core for both /api/stats/player/:playerKey and the newer
// /api/players/:playerId/stats — pk here may be a single nameKey or an
// array of nameKeys (a merged playerId's aliases). Returns a plain result
// object (or an { httpError, message } shape) rather than writing to res
// directly, so both routes can attach their own identifier field
// (playerKey vs playerId) to the JSON response.
async function runPlayerStatsQuery(pk, req) {
    const scope = req.query.scope || 'match';
    if (scope === 'match') {
        if (!ballsCollection) return { httpError: 503, message: 'Database not configured' };
        if (!req.query.matchId) return { httpError: 400, message: 'matchId required for scope=match' };
        const stats = await computeMatchPlayerStats(safeMatchId(req.query.matchId), pk);
        return { scope, ...stats };
    }
    if (!matchRecordsCollection) return { httpError: 503, message: 'Database not configured' };
    if (scope === 'tournament') {
        const leagueKey = leagueKeyFor(req.query.leagueName);
        const ownerUid = ownerUidFrom(req);
        if (!leagueKey || !ownerUid) return { httpError: 400, message: 'leagueName and uid required for scope=tournament' };
        const matches = await getLeagueMatches(ownerUid, leagueKey);
        const stats = computeSinglePlayerRollup(matches, pk);
        return { scope, ...stats };
    }
    // career (and season, best-effort — see note on the clips endpoint
    // above): every match across every league this owner has saved.
    const ownerUid = ownerUidFrom(req);
    if (!ownerUid) return { httpError: 400, message: 'uid required for scope=career' };
    const allMatches = await matchRecordsCollection.find({ ownerUid }).toArray();
    const stats = computeSinglePlayerRollup(allMatches, pk);
    return { scope, ...stats };
}

// Shared core for both /api/stats/player/:playerKey/tournaments and
// /api/players/:playerId/tournaments — same pk-as-string-or-array contract
// as runPlayerStatsQuery above.
async function runPlayerTournamentHistory(pk, req) {
    if (!leaguesCollection || !matchRecordsCollection) return { httpError: 503, message: 'Database not configured' };
    const ownerUid = ownerUidFrom(req);
    if (!ownerUid) return { httpError: 400, message: 'uid required' };
    const pkSet = new Set(Array.isArray(pk) ? pk : [pk]);
    const leagues = await leaguesCollection.find({ ownerUid, leagueKey: { $ne: SINGLE_MATCHES_LEAGUE_KEY } })
        .project({ leagueKey: 1, displayName: 1, updatedAt: 1 }).toArray();
    const tournaments = (await Promise.all(leagues.map(async doc => {
        const matches = await getLeagueMatches(ownerUid, doc.leagueKey);
        const stats = computeSinglePlayerRollup(matches, pk);
        if (!stats.batting && !stats.bowling) return null; // player never appeared in this tournament
        return {
            leagueName: doc.displayName || doc.leagueKey,
            matchesPlayed: matches.filter(m => {
                return ['A', 'B'].some(k =>
                    ((m.battingCard && m.battingCard[k]) || []).some(b => pkSet.has(playerKey(b.name))) ||
                    ((m.bowlingCard && m.bowlingCard[k]) || []).some(b => pkSet.has(playerKey(b.name)))
                );
            }).length,
            updatedAt: doc.updatedAt || 0,
            batting: stats.batting,
            bowling: stats.bowling
        };
    })))
        .filter(Boolean)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    return { tournaments };
}

// GET /api/stats/player/:playerKey?scope=match|tournament|career&matchId=&leagueName=&uid=
app.get('/api/stats/player/:playerKey', async (req, res) => {
    const pk = playerKey(req.params.playerKey);
    if (!pk) return res.status(400).json({ success: false, error: 'playerKey required' });
    try {
        const result = await runPlayerStatsQuery(pk, req);
        if (result.httpError) return res.status(result.httpError).json({ success: false, error: result.message });
        res.json({ success: true, playerKey: pk, ...result });
    } catch (err) {
        console.log('Player-stats fetch error:', err);
        res.status(500).json({ success: false, error: 'Could not load player stats' });
    }
});

// GET /api/stats/player/:playerKey/tournaments?uid=
// TOURNAMENT HISTORY — one row per tournament this player has ever
// appeared in for this owner, each with that tournament's own totals
// (same rollup as scope=tournament above, just run once per league doc
// instead of once). This is what powers the "2024 — Tournament A — 421
// Runs" style breakdown on the player profile, on top of the single
// flattened scope=career number. Sorted most-recent-first by the
// tournament's last updatedAt so a player's newest form shows up top.
app.get('/api/stats/player/:playerKey/tournaments', async (req, res) => {
    const pk = playerKey(req.params.playerKey);
    if (!pk) return res.status(400).json({ success: false, error: 'playerKey required' });
    try {
        const result = await runPlayerTournamentHistory(pk, req);
        if (result.httpError) return res.status(result.httpError).json({ success: false, error: result.message });
        res.json({ success: true, playerKey: pk, ...result });
    } catch (err) {
        console.log('Player-tournament-history fetch error:', err);
        res.status(500).json({ success: false, error: 'Could not load tournament history' });
    }
});

// ================================================================
// 🌟 GLOBAL PLAYER PROFILE ROUTES — playerId-addressed versions of the
// stats/tournaments endpoints above, plus search (typeahead for the
// scoring panel) and merge (dedup two profiles created for the same real
// person under slightly different spellings). See playersCollection
// comment in connectMongo and resolvePlayerId above for the data model.
// ================================================================

// GET /api/players/search?uid=&q= — typeahead for the panel's player name
// inputs. Matching on a name that's ALREADY a known player (rather than
// letting the scorer free-type a fresh variant every time) is what keeps
// nameKeys from fragmenting in the first place.
app.get('/api/players/search', async (req, res) => {
    if (!playersCollection) return res.json({ success: true, players: [] });
    const ownerUid = ownerUidFrom(req);
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!ownerUid || q.length < 2) return res.json({ success: true, players: [] });
    try {
        const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const players = await playersCollection.find({ ownerUid, displayName: { $regex: escaped, $options: 'i' } })
            .project({ playerId: 1, displayName: 1 }).limit(10).toArray();
        res.json({ success: true, players });
    } catch (err) {
        console.log('Player search error:', err);
        res.status(500).json({ success: false, players: [] });
    }
});

// POST /api/players/resolve  { uid, name } — find-or-create a playerId for
// a name. The panel can call this as soon as a scorer commits a player
// name (instead of only implicitly via logBall), so the playerId is known
// before the first ball is even bowled.
app.post('/api/players/resolve', async (req, res) => {
    const ownerUid = ownerUidFrom(req) || req.body.uid;
    const name = req.body.name;
    if (!ownerUid || !String(name || '').trim()) return res.status(400).json({ success: false, error: 'uid and name required' });
    try {
        const playerId = await resolvePlayerId(ownerUid, name);
        if (!playerId) return res.status(503).json({ success: false, error: 'Database not configured' });
        res.json({ success: true, playerId });
    } catch (err) {
        console.log('Player resolve error:', err);
        res.status(500).json({ success: false, error: 'Could not resolve player' });
    }
});

// POST /api/players/:playerId/merge  { uid, intoNameKeys: [...] } — folds
// another set of nameKeys (typically every alias of a duplicate playerId
// created by mistake) into this playerId, then leaves the duplicate doc's
// nameKeys empty so it stops matching anything new. Historical balls/clips
// already stamped with the OLD playerId keep that value (we never rewrite
// history), but since stats are computed live from nameKeys — not from the
// stamped playerId — merging here immediately unifies their stats. The
// stamped playerId fields are for provenance/debugging, not the query key.
app.post('/api/players/:playerId/merge', async (req, res) => {
    if (!playersCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    const ownerUid = ownerUidFrom(req) || req.body.uid;
    const { fromPlayerId } = req.body || {};
    if (!ownerUid || !fromPlayerId) return res.status(400).json({ success: false, error: 'uid and fromPlayerId required' });
    if (fromPlayerId === req.params.playerId) return res.status(400).json({ success: false, error: 'Cannot merge a player into itself' });
    try {
        const [into, from] = await Promise.all([
            playersCollection.findOne({ playerId: req.params.playerId, ownerUid }),
            playersCollection.findOne({ playerId: fromPlayerId, ownerUid })
        ]);
        if (!into || !from) return res.status(404).json({ success: false, error: 'Player not found' });
        const mergedKeys = [...new Set([...(into.nameKeys || []), ...(from.nameKeys || [])])];
        await playersCollection.updateOne({ _id: from._id }, { $set: { nameKeys: [], mergedInto: into.playerId, updatedAt: Date.now() } });
        await playersCollection.updateOne({ _id: into._id }, { $set: { nameKeys: mergedKeys, updatedAt: Date.now() } });
        res.json({ success: true, playerId: into.playerId, nameKeys: mergedKeys });
    } catch (err) {
        console.log('Player merge error:', err);
        res.status(500).json({ success: false, error: 'Could not merge players' });
    }
});

// GET /api/players/:playerId?uid= — profile (display name + known aliases)
app.get('/api/players/:playerId', async (req, res) => {
    if (!playersCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    try {
        const profile = await playersCollection.findOne({ playerId: req.params.playerId });
        if (!profile) return res.status(404).json({ success: false, error: 'Player not found' });
        res.json({ success: true, playerId: profile.playerId, displayName: profile.displayName, aliases: profile.nameKeys || [] });
    } catch (err) {
        console.log('Player profile fetch error:', err);
        res.status(500).json({ success: false, error: 'Could not load player' });
    }
});

// GET /api/players/:playerId/stats?scope=match|tournament|career&... — same
// contract as /api/stats/player/:playerKey, addressed by the permanent
// playerId instead of a raw name string, and automatically covering every
// nameKey ever merged into this playerId.
app.get('/api/players/:playerId/stats', async (req, res) => {
    const pks = await nameKeysForPlayerId(req.params.playerId);
    if (!pks.length) return res.status(404).json({ success: false, error: 'Player not found' });
    try {
        const result = await runPlayerStatsQuery(pks, req);
        if (result.httpError) return res.status(result.httpError).json({ success: false, error: result.message });
        res.json({ success: true, playerId: req.params.playerId, ...result });
    } catch (err) {
        console.log('Player-stats (by playerId) fetch error:', err);
        res.status(500).json({ success: false, error: 'Could not load player stats' });
    }
});

// GET /api/players/:playerId/tournaments?uid=
app.get('/api/players/:playerId/tournaments', async (req, res) => {
    const pks = await nameKeysForPlayerId(req.params.playerId);
    if (!pks.length) return res.status(404).json({ success: false, error: 'Player not found' });
    try {
        const result = await runPlayerTournamentHistory(pks, req);
        if (result.httpError) return res.status(result.httpError).json({ success: false, error: result.message });
        res.json({ success: true, playerId: req.params.playerId, ...result });
    } catch (err) {
        console.log('Player-tournament-history (by playerId) fetch error:', err);
        res.status(500).json({ success: false, error: 'Could not load tournament history' });
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

// ---- Tournaments: manual status override (owner-only) ----
// Lets ONLY the verified owner (requireOwner — real Firebase-token email
// check, not a client-supplied uid) force what a tournament's card shows on
// the public Tournaments section — e.g. flip a "Live" card to "Completed"
// or back — regardless of what the actual match data would compute.
// status: 'live' | 'completed' | 'ongoing' | 'upcoming' to force it, or
// null/omitted to clear the override and go back to automatic status.
adminRouter.post('/tournaments/:leagueKey/status', async (req, res) => {
    if (!leaguesCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    const leagueKey = leagueKeyFor(req.params.leagueKey);
    const allowed = ['live', 'completed', 'ongoing', 'upcoming', null];
    const status = req.body && req.body.status ? String(req.body.status) : null;
    if (!leagueKey) return res.status(400).json({ success: false, error: 'League key required' });
    if (!allowed.includes(status)) return res.status(400).json({ success: false, error: 'status must be live, completed, ongoing, upcoming, or null' });
    try {
        // req.ownerUid comes straight from requireOwner's verified ID token
        // (this whole router is chhayajeeth-only) — no extra lookup needed.
        const ownerUid = req.ownerUid;
        const before = await leaguesCollection.findOne({ ownerUid, leagueKey }, { projection: { statusOverride: 1, displayName: 1 } });
        if (!before) return res.status(404).json({ success: false, error: 'Tournament not found' });
        await leaguesCollection.updateOne(
            { ownerUid, leagueKey },
            status ? { $set: { statusOverride: status } } : { $unset: { statusOverride: '' } }
        );
        publicTournamentsListCache = null; // reflect the change immediately, not after up to 8s
        await logAuditAction(req.ownerEmail, 'Tournament status override', before.displayName || leagueKey, before.statusOverride || null, status);
        res.json({ success: true, status });
    } catch (err) {
        console.log('Tournament status override error:', err);
        res.status(500).json({ success: false, error: 'Could not update tournament status' });
    }
});

// ================================================================
// 🛡️ OWNER GLOBAL CORRECTION & MANAGEMENT — chhayajeeth@gmail.com only.
// Everything below sits on adminRouter (requireOwner already verified the
// caller's real Firebase ID token IS chhayajeeth@gmail.com — see the
// `adminRouter.use(requireOwner)` line above; nothing here re-checks email
// because the whole router already did). Lets the owner open ANY creator's
// ANY tournament/match/clip — workallsportslive@gmail.com's,
// vinitkrkr1@gmail.com's, or their own — and correct it.
//
// Deliberately reuses the exact same matchRecordsCollection /
// leaguesCollection / clipsCollection documents the live scoring panels and
// public scorecard already read from — no parallel/duplicate data store.
// Tournament leaderboards, points table and player stats are NEVER stored;
// computePointsTable()/computeLeaderboards()/runPlayerStatsQuery() already
// recompute them fresh from matchRecords on every read (see those functions
// above), so correcting a match's saved record is the entire fix — nothing
// downstream needs a manual recalculation step. We only need to clear the
// two short-lived response caches below so the very next read reflects it
// immediately instead of after their normal TTL.
// ================================================================

// Finds a league doc across ALL owners by name (partial, case-insensitive)
// so the owner can locate a tournament without already knowing its ownerUid
// — the Cricket Data tab's list is capped at 50 most-recently-updated, which
// isn't enough to find an older tournament to correct.
adminRouter.get('/tournaments/search', async (req, res) => {
    if (!leaguesCollection || !matchRecordsCollection) return res.json({ success: true, tournaments: [] });
    const q = (req.query.q || '').trim();
    try {
        const filter = { leagueKey: { $ne: SINGLE_MATCHES_LEAGUE_KEY } };
        if (q) filter.displayName = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
        const leagues = await leaguesCollection.find(filter)
            .project({ ownerUid: 1, leagueKey: 1, displayName: 1, updatedAt: 1, sport: 1, publicToken: 1, createdBy: 1, completed: 1, statusOverride: 1, liveMatches: 1 })
            .sort({ updatedAt: -1 }).limit(200).toArray();
        const tournaments = await Promise.all(leagues.map(async l => {
            const matchCount = await matchRecordsCollection.countDocuments({ ownerUid: l.ownerUid, leagueKey: l.leagueKey });
            const creatorEmail = l.createdBy || await getVerifiedEmailForUid(l.ownerUid);
            // 🩹 FIX: statusOverride/publicStatus were being queried (see the
            // .project() above) but never put on the response object, so the
            // admin panel's Explorer grid and dashboard "Live Right Now" /
            // "Completed" counters — which read t.statusOverride/t.publicStatus
            // (see tournamentEffectiveStatus() and loadDashboardExtras() in
            // admin.html) — always fell back to 'upcoming' / 0. Same
            // computation as GET /api/admin/cricket, so both routes now agree.
            const isLive = !!(l.liveMatches && l.liveMatches.length > 0);
            const publicStatus = l.statusOverride || (isLive ? 'live' : (l.completed ? 'completed' : (matchCount > 0 ? 'ongoing' : 'upcoming')));
            return {
                ownerUid: l.ownerUid, leagueKey: l.leagueKey, displayName: l.displayName || l.leagueKey,
                sport: l.sport || 'cricket', matchCount, updatedAt: l.updatedAt || null,
                publicToken: l.publicToken || null,
                publicStatus, statusOverride: l.statusOverride || null,
                // "Created by" — this is the one place in the whole app this
                // is ever surfaced (Owner Admin Panel only, never the public
                // API/homepage).
                createdBy: creatorEmail || 'Unknown',
                isPrivate: isPrivateCreatorEmail(creatorEmail)
            };
        }));
        res.json({ success: true, tournaments });
    } catch (err) {
        console.log('Admin tournament search error:', err);
        res.status(500).json({ success: false, error: 'Could not search tournaments' });
    }
});

// Full match list for one tournament (any owner) — the correction screen's
// data source. Same matchRecordsCollection the public scorecard reads.
adminRouter.get('/tournament/:ownerUid/:leagueKey', async (req, res) => {
    if (!leaguesCollection || !matchRecordsCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    const { ownerUid } = req.params;
    const leagueKey = leagueKeyFor(req.params.leagueKey);
    try {
        const league = await leaguesCollection.findOne({ ownerUid, leagueKey });
        if (!league) return res.status(404).json({ success: false, error: 'Tournament not found' });
        const matches = await getLeagueMatches(ownerUid, leagueKey);
        const creatorEmail = league.createdBy || await getVerifiedEmailForUid(ownerUid);
        res.json({
            success: true,
            league: {
                ownerUid, leagueKey, displayName: league.displayName || leagueKey,
                sport: league.sport || 'cricket', publicToken: league.publicToken || null,
                createdBy: creatorEmail || 'Unknown', isPrivate: isPrivateCreatorEmail(creatorEmail)
            },
            matches
        });
    } catch (err) {
        console.log('Admin tournament fetch error:', err);
        res.status(500).json({ success: false, error: 'Could not load tournament' });
    }
});

// Correct one match's saved record. Body: { record: {...full corrected
// match object...} }. Any field can be corrected this way — runs, balls,
// overs, wickets, battingCard/bowlingCard entries, winningTeam, etc. — the
// same shape the scoring panel itself saves via POST /api/league/:name/match.
// Identity fields (ownerUid/leagueKey/matchId/roomId/savedAt) are preserved
// from the existing doc regardless of what the body sends, so a correction
// can never accidentally move a match to a different tournament or drop its
// clip linkage (roomId).
adminRouter.put('/tournament/:ownerUid/:leagueKey/match/:matchId', async (req, res) => {
    if (!leaguesCollection || !matchRecordsCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    const { ownerUid, matchId } = req.params;
    const leagueKey = leagueKeyFor(req.params.leagueKey);
    const correction = req.body && req.body.record;
    if (!correction || typeof correction !== 'object') return res.status(400).json({ success: false, error: 'record object required' });
    try {
        const existing = await matchRecordsCollection.findOne({ ownerUid, leagueKey, matchId });
        if (!existing) return res.status(404).json({ success: false, error: 'Match not found' });
        const league = await leaguesCollection.findOne({ ownerUid, leagueKey }, { projection: { publicToken: 1, displayName: 1 } });

        // The admin panel round-trips the existing record through the JSON
        // textarea, which turns Mongo's ObjectId into a plain string _id.
        // replaceOne() treats _id as immutable, so sending that string back
        // causes "the (immutable) field '_id' was found to have been
        // altered" and the whole save fails with a 500 ("Could not save
        // correction"). Strip whatever _id came in the body and let Mongo
        // keep the existing document's real _id untouched.
        const { _id, ...correctionWithoutId } = correction;

        const corrected = {
            ...correctionWithoutId,
            ownerUid, leagueKey, matchId,
            roomId: existing.roomId || null,
            savedAt: existing.savedAt
        };
        await matchRecordsCollection.replaceOne({ ownerUid, leagueKey, matchId }, corrected);

        // Nothing to recompute by hand — points table, leaderboards and
        // player stats are derived fresh from matchRecords on every read.
        // Just clear the short-lived response caches so the correction is
        // visible immediately instead of waiting out their TTL.
        if (league && league.publicToken) publicTournamentCache.delete(league.publicToken);
        publicTournamentsListCache = null;

        await logAuditAction(req.ownerEmail, 'Owner match correction', `${league && league.displayName || leagueKey} — match ${matchId}`, null, null);
        res.json({ success: true, match: corrected });
    } catch (err) {
        console.log('Owner match correction error:', err);
        res.status(500).json({ success: false, error: 'Could not save correction' });
    }
});

// Deletes an ENTIRE tournament: the league doc, every match saved under it,
// and every clip belonging to those matches. Frontend shows a confirmation
// modal before ever calling this (see admin.html) — there is no undo.
adminRouter.delete('/tournament/:ownerUid/:leagueKey', async (req, res) => {
    if (!leaguesCollection || !matchRecordsCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    const { ownerUid } = req.params;
    const leagueKey = leagueKeyFor(req.params.leagueKey);
    try {
        const league = await leaguesCollection.findOne({ ownerUid, leagueKey });
        if (!league) return res.status(404).json({ success: false, error: 'Tournament not found' });

        const matches = await matchRecordsCollection.find({ ownerUid, leagueKey }, { projection: { matchId: 1 } }).toArray();
        const matchIds = matches.map(m => m.matchId).filter(Boolean);

        if (clipsCollection && matchIds.length) {
            await clipsCollection.deleteMany({ matchId: { $in: matchIds } });
        }
        await matchRecordsCollection.deleteMany({ ownerUid, leagueKey });
        await leaguesCollection.deleteOne({ ownerUid, leagueKey });

        if (league.publicToken) publicTournamentCache.delete(league.publicToken);
        publicTournamentsListCache = null;

        await logAuditAction(req.ownerEmail, 'Delete tournament', league.displayName || leagueKey, { matchesDeleted: matchIds.length }, null);
        res.json({ success: true, deletedMatches: matchIds.length });
    } catch (err) {
        console.log('Owner tournament delete error:', err);
        res.status(500).json({ success: false, error: 'Could not delete tournament' });
    }
});

// ---- Clip correction ----
// Full (untrimmed) clip docs for one match — includes strikerKey/bowlerKey/
// fielderKey, which the public /api/clips/match/:matchId route deliberately
// hides (see serializeClip above) but the owner needs to see/edit here.
adminRouter.get('/clips/match/:matchId', async (req, res) => {
    if (!clipsCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    try {
        const clips = await clipsCollection.find({ matchId: safeMatchId(req.params.matchId) }).sort({ over: 1, ballInOver: 1 }).toArray();
        res.json({ success: true, clips: clips.map(c => ({ ...c, clipId: c._id.toString(), _id: undefined })) });
    } catch (err) {
        console.log('Admin clips fetch error:', err);
        res.status(500).json({ success: false, error: 'Could not load clips' });
    }
});

// Corrects a clip that got attached to the wrong player/event. Any of these
// fields may be sent; only the ones present are changed. Renaming
// striker/bowler/fielder also recomputes their *Key (playerKey() —lower-
// cased, trimmed name) so the clip keeps showing up correctly in that
// player's stats/clip listings — the *Key, not the *Name, is what
// scorecard/clip queries actually match on.
adminRouter.put('/clips/:clipId', async (req, res) => {
    if (!clipsCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    const { ObjectId } = require('mongodb');
    let _id;
    try { _id = new ObjectId(req.params.clipId); } catch { return res.status(400).json({ success: false, error: 'Invalid clip id' }); }
    const body = req.body || {};
    const set = {};
    if (body.matchId !== undefined) set.matchId = safeMatchId(body.matchId);
    if (body.eventType !== undefined) set.eventType = String(body.eventType).toUpperCase();
    if (body.dismissalType !== undefined) set.dismissalType = body.dismissalType || null;
    if (body.battingTeam !== undefined) set.battingTeam = String(body.battingTeam).toUpperCase();
    if (body.over !== undefined) set.over = Number(body.over) || 0;
    if (body.ballInOver !== undefined) set.ballInOver = Number(body.ballInOver) || 0;
    if (body.innings !== undefined) set.innings = Number(body.innings) || 1;
    if (body.runs !== undefined) set.runs = Number(body.runs) || 0;
    if (body.strikerName !== undefined) { set.strikerName = body.strikerName || null; set.strikerKey = playerKey(body.strikerName); }
    if (body.bowlerName !== undefined) { set.bowlerName = body.bowlerName || null; set.bowlerKey = playerKey(body.bowlerName); }
    if (body.nonStrikerName !== undefined) { set.nonStrikerName = body.nonStrikerName || null; }
    if (body.fielderName !== undefined) { set.fielderName = body.fielderName || null; set.fielderKey = playerKey(body.fielderName); }
    if (Object.keys(set).length === 0) return res.status(400).json({ success: false, error: 'No correctable fields provided' });
    try {
        const result = await clipsCollection.findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after' });
        if (!result || !result.value) return res.status(404).json({ success: false, error: 'Clip not found' });
        await logAuditAction(req.ownerEmail, 'Owner clip correction', req.params.clipId, null, set);
        res.json({ success: true, clip: serializeClip(result.value) });
    } catch (err) {
        console.log('Owner clip correction error:', err);
        res.status(500).json({ success: false, error: 'Could not save clip correction' });
    }
});

// Removes a clip wrongly attached to a player/event entirely (rather than
// reassigning it) — e.g. it was never a real four/six/wicket.
adminRouter.delete('/clips/:clipId', async (req, res) => {
    if (!clipsCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    const { ObjectId } = require('mongodb');
    let _id;
    try { _id = new ObjectId(req.params.clipId); } catch { return res.status(400).json({ success: false, error: 'Invalid clip id' }); }
    try {
        const result = await clipsCollection.deleteOne({ _id });
        if (!result.deletedCount) return res.status(404).json({ success: false, error: 'Clip not found' });
        await logAuditAction(req.ownerEmail, 'Delete clip', req.params.clipId, null, null);
        res.json({ success: true });
    } catch (err) {
        console.log('Owner clip delete error:', err);
        res.status(500).json({ success: false, error: 'Could not delete clip' });
    }
});

// ================================================================
// 🎯 BALL-BY-BALL CORRECTION ENGINE (Owner-only)
//
// Everything above (Correct Match, Correct Clip) edits a CACHED total
// directly — exactly the anti-pattern a real scoring system must avoid.
// This section instead treats one delivery (a document in ballsCollection)
// as the source of truth: the owner edits the delivery, the engine
// re-derives kind/runs for it, simulates the WHOLE match's derived state
// with that one ball swapped in (buildLiveCardsFromBallsArray — same rules
// buildLiveCardsFromBalls() already uses live), runs consistency checks,
// and only writes + resyncs matchRecordsCollection if everything holds
// together. Tournament leaderboards/points table need no extra step here —
// they already recompute fresh from matchRecordsCollection on every read
// (see computeLeaderboards/computePointsTable above).
//
// ⚠️ KNOWN SCHEMA LIMIT: `kind` on a ball is still a single bucket
// ('0'-'6' | 'W' | 'Wd' | 'Nb' | 'B' | 'LB'), matching how logBall has
// always written it. That means a wicket that happens ON a Wide or No
// Ball (a stumping/run-out off a wide, a run-out off a no-ball) cannot be
// fully represented yet — buildBallFromCorrection() below deliberately
// REJECTS that combination rather than silently dropping the extra or the
// wicket. Fully modelling it needs additive schema fields (separate
// runsOffBat/extraRuns/extraType on every ball) and a backfill plan for
// existing matches — a bigger, separate change than this correction UI.
// ================================================================

const VALID_EXTRA_TYPES = new Set(['none', 'wide', 'noball', 'bye', 'legbye']);

// Derives law-consistent per-delivery facts (Laws 21/22/23/26 of the MCC
// Laws of Cricket — No ball, Wide, Bye, Leg bye) from the existing single
// `kind` + team-run-delta `runs` a ball document already stores. Purely
// read-only/derived — never changes how kind/runs are written elsewhere.
function deriveBallFacts(kind, runs) {
    const total = Number(runs) || 0;
    switch (kind) {
        case 'Wd': return { legalBall: false, extraType: 'wide', runsOffBat: 0, extraRuns: total };
        case 'Nb': { const bat = Math.max(0, total - 1); return { legalBall: false, extraType: 'noball', runsOffBat: bat, extraRuns: total - bat }; }
        case 'B': return { legalBall: true, extraType: 'bye', runsOffBat: 0, extraRuns: total };
        case 'LB': return { legalBall: true, extraType: 'legbye', runsOffBat: 0, extraRuns: total };
        default: return { legalBall: true, extraType: 'none', runsOffBat: total, extraRuns: 0 }; // '0'-'6' and 'W'
    }
}

// Re-derives the single kind/runs pair from the Edit Delivery screen's
// composite input (runs off bat, extras, extra type, wicket) — the ONE
// place in the file that has to understand the richer editable shape.
// Throws a plain, owner-facing Error on any contradictory combination
// (see "IMPORTANT — Do not allow contradictory combinations" in the spec)
// instead of guessing/silently coercing it into something scoreable.
function buildBallFromCorrection(input) {
    const runsOffBat = Math.max(0, Number(input.runsOffBat) || 0);
    const extraRuns = Math.max(0, Number(input.extras) || 0);
    const extraType = VALID_EXTRA_TYPES.has(input.extraType) ? input.extraType : 'none';
    const isWicket = !!input.wicket;

    if (extraType === 'wide' && runsOffBat > 0) throw new Error('A Wide cannot carry runs off the bat — the striker never faced it.');
    if ((extraType === 'bye' || extraType === 'legbye') && runsOffBat > 0) throw new Error('Byes/Leg Byes are never credited as runs off the bat.');
    if (extraType !== 'none' && extraRuns <= 0 && extraType !== 'noball') throw new Error(`Extra type is "${extraType}" but Extras is 0 — enter the runs run/extra runs.`);
    if (isWicket && (extraType === 'wide' || extraType === 'noball')) {
        throw new Error(`A wicket together with a ${extraType === 'wide' ? 'Wide' : 'No Ball'} isn't representable in the current delivery model yet (see the schema-limit note above the correction engine) — record the wicket on a legal delivery, or leave this one as a extra-only ball for now.`);
    }
    if (isWicket && extraType === 'none' && ['Bowled', 'LBW', 'Stumped', 'Hit Wicket', 'Caught'].includes(input.dismissalType) && runsOffBat > 0) {
        throw new Error(`${input.dismissalType} ends the delivery dead — it can't also carry runs off the bat. Use Run Out if runs were completed.`);
    }

    let kind, totalRuns;
    if (isWicket && extraType === 'none') { kind = 'W'; totalRuns = runsOffBat; }         // e.g. Run Out completed runs; 0 for a clean dismissal
    else if (extraType === 'wide') { kind = 'Wd'; totalRuns = extraRuns; }
    else if (extraType === 'noball') { kind = 'Nb'; totalRuns = 1 + runsOffBat; }          // 1 penalty always + bat runs
    else if (extraType === 'bye') { kind = 'B'; totalRuns = extraRuns; }
    else if (extraType === 'legbye') { kind = 'LB'; totalRuns = extraRuns; }
    else { kind = String(Math.min(6, runsOffBat)); totalRuns = runsOffBat; }               // '0'..'6' off-the-bat delivery
    return { kind, runs: totalRuns, isWicket };
}

// Post-correction sanity checks (VALIDATION section of the spec) — run
// against the SIMULATED full match, before anything is written. Kept
// conservative: only flags structural impossibilities (more than 10
// wickets, more than 6 legal balls in one over), never a legitimate but
// unusual passage of play, so it never blocks a real correction with a
// false positive.
function validateCorrectedBalls(balls) {
    const errors = [];
    const wicketsByInnings = {}, legalByOver = {};
    balls.forEach(b => {
        const ik = b.innings || 1;
        wicketsByInnings[ik] = (wicketsByInnings[ik] || 0) + (b.dismissal ? 1 : 0);
        if (deriveBallFacts(b.kind, b.runs).legalBall) {
            const ok = `${ik}-${b.over}`;
            legalByOver[ok] = (legalByOver[ok] || 0) + 1;
        }
    });
    Object.entries(wicketsByInnings).forEach(([ik, w]) => { if (w > 10) errors.push(`This correction creates a scoring inconsistency: innings ${ik} would have ${w} wickets — only 10 are possible.`); });
    Object.entries(legalByOver).forEach(([ok, n]) => { if (n > 6) { const [ik, ov] = ok.split('-'); errors.push(`This correction creates a scoring inconsistency: over ${ov} of innings ${ik} would have ${n} legal deliveries — an over can only have 6. Please review the delivery.`); } });
    return errors;
}

// Runs one full delivery correction: validate → simulate → (if clean and
// not a dry run) write + resync. Returns { before, after, errors } either
// way, so the SAME function powers both the Preview screen and the real
// Save & Recalculate — the preview is never a guess at what the save will
// do, it's the actual save logic run with the write skipped.
async function correctDelivery(ballId, actorEmail, input, dryRun) {
    if (!ballsCollection || !matchRecordsCollection) return { errors: ['Database not configured'] };
    const { ObjectId } = require('mongodb');
    let _id;
    try { _id = new ObjectId(ballId); } catch { return { errors: ['Invalid delivery id'] }; }
    const original = await ballsCollection.findOne({ _id });
    if (!original) return { errors: ['Delivery not found'] };

    let kind, runs, isWicket;
    try { ({ kind, runs, isWicket } = buildBallFromCorrection(input)); }
    catch (err) { return { errors: [err.message] }; }

    const strikerName = input.striker !== undefined ? personName(input.striker) : original.striker;
    const nonStrikerName = input.nonStriker !== undefined ? personName(input.nonStriker) : original.nonStriker;
    const bowlerName = input.bowler !== undefined ? personName(input.bowler) : original.bowler;
    const fielderName = isWicket ? (personName(input.fielder) || null) : null;

    const correctedBall = {
        ...original,
        kind, runs,
        striker: strikerName, strikerKey: playerKey(strikerName),
        nonStriker: nonStrikerName, nonStrikerKey: playerKey(nonStrikerName),
        bowler: bowlerName, bowlerKey: playerKey(bowlerName),
        dismissal: isWicket ? { type: input.dismissalType || 'Bowled', fielder: fielderName } : null,
        dismissalFielderKey: playerKey(fielderName),
        correctionOf: original.correctionOf || original._id, // keeps the ORIGINAL id traceable across repeat corrections
        correctedAt: Date.now(), correctedBy: actorEmail || null
    };

    // Re-resolve global playerIds for anyone actually renamed, exactly the
    // way logBall() does for a brand-new ball — keeps career/roster stats
    // linked to the right profile after a Batter/Bowler Correction.
    if (original.ownerUid && strikerName !== original.striker) correctedBall.strikerPlayerId = await resolvePlayerId(original.ownerUid, strikerName);
    if (original.ownerUid && bowlerName !== original.bowler) correctedBall.bowlerPlayerId = await resolvePlayerId(original.ownerUid, bowlerName);

    const allBalls = await ballsCollection.find({ matchId: original.matchId }).sort({ innings: 1, over: 1, ballInOver: 1 }).toArray();
    const simulated = allBalls.map(b => (String(b._id) === String(_id) ? correctedBall : b));

    const errors = validateCorrectedBalls(simulated);
    const before = buildLiveCardsFromBallsArray(allBalls);
    const after = buildLiveCardsFromBallsArray(simulated);
    const result = { before: { ball: original, cards: before }, after: { ball: correctedBall, cards: after }, errors };
    if (errors.length || dryRun) return result;

    await ballsCollection.replaceOne({ _id }, correctedBall);

    // Delivery saved — now derive EVERYTHING downstream from it, per the
    // "AFTER SAVING A CORRECTION" recalculation list: this rebuilds
    // battingCard/bowlingCard/scoreA/scoreB (batting stats, bowling
    // stats, extras-affected totals, overs, wickets, team total) onto the
    // same matchRecordsCollection doc the public scorecard and tournament
    // pages already read, and busts the short-lived public caches so it's
    // visible immediately. Current/required run rate, target and match
    // result are derived FROM scoreA/scoreB by the scorecard/overlay at
    // render time already, so they follow automatically too — EXCEPT a
    // final win/loss/tie verdict on an already-completed match, which
    // this deliberately does not auto-flip (see resultMayNeedReview
    // below) rather than risk guessing a DLS/target situation wrong.
    if (original.ownerUid) await syncMatchRecordFromBalls(original.ownerUid, original.matchId);

    // Keep a clip cut around this exact delivery (same innings/over/ball —
    // identity unchanged) pointing at the corrected player names, per
    // "CLIP CORRECTION": the clip stays connected to the same event unless
    // the owner explicitly reassigns the event itself. Best-effort/non-
    // blocking — a clip metadata miss should never fail the score
    // correction that already succeeded.
    if (clipsCollection) {
        clipsCollection.updateMany(
            { matchId: original.matchId, innings: original.innings, over: original.over, ballInOver: original.ballInOver },
            { $set: { strikerName, strikerKey: correctedBall.strikerKey, bowlerName, bowlerKey: correctedBall.bowlerKey, runs: correctedBall.runs } }
        ).catch(err => console.log('Clip resync after ball correction error:', err));
    }

    const existingMatch = await matchRecordsCollection.findOne({ matchId: original.matchId }, { projection: { winningTeam: 1 } });
    result.resultMayNeedReview = !!(existingMatch && existingMatch.winningTeam &&
        (before.scoreA.runs !== after.scoreA.runs || before.scoreB.runs !== after.scoreB.runs ||
         before.scoreA.wickets !== after.scoreA.wickets || before.scoreB.wickets !== after.scoreB.wickets));

    return result;
}

// All deliveries for one match, for the Edit Delivery list — plus the
// distinct striker/non-striker/bowler names already seen in this match,
// so the correction screen's dropdowns are populated from real roster
// names instead of free text.
adminRouter.get('/cricket/match/:matchId/balls', async (req, res) => {
    if (!ballsCollection) return res.status(503).json({ success: false, error: 'Database not configured' });
    try {
        const matchId = safeMatchId(req.params.matchId);
        const balls = await ballsCollection.find({ matchId }).sort({ innings: 1, over: 1, ballInOver: 1 }).toArray();
        const roster = new Set();
        balls.forEach(b => { [b.striker, b.nonStriker, b.bowler].forEach(n => { if (n) roster.add(n); }); });
        res.json({
            success: true,
            roster: [...roster].sort(),
            balls: balls.map(b => ({ ...b, ballId: b._id.toString(), _id: undefined }))
        });
    } catch (err) {
        console.log('Admin balls fetch error:', err);
        res.status(500).json({ success: false, error: 'Could not load deliveries' });
    }
});

// Dry-run: shows the owner exactly what Save & Recalculate would change,
// without writing anything — powers the "BEFORE / AFTER … This correction
// will update" preview screen from the spec.
adminRouter.post('/cricket/ball/:ballId/preview', async (req, res) => {
    try {
        const result = await correctDelivery(req.params.ballId, req.ownerEmail, req.body || {}, true);
        if (result.errors && result.errors.length && !result.before) return res.status(400).json({ success: false, error: result.errors[0] });
        res.json({ success: true, ...result });
    } catch (err) {
        console.log('Ball correction preview error:', err);
        res.status(500).json({ success: false, error: 'Could not preview correction' });
    }
});

// Save & Recalculate — the real write. Refuses to save (400, with the
// specific inconsistency) rather than ever writing a delivery that fails
// validateCorrectedBalls(), matching the spec's "don't silently save
// corrupted data" requirement.
adminRouter.put('/cricket/ball/:ballId', async (req, res) => {
    try {
        const result = await correctDelivery(req.params.ballId, req.ownerEmail, req.body || {}, false);
        if (!result.before) return res.status(400).json({ success: false, error: (result.errors && result.errors[0]) || 'Could not correct delivery' });
        if (result.errors && result.errors.length) return res.status(409).json({ success: false, error: result.errors[0] });
        await logAuditAction(
            req.ownerEmail, 'Owner delivery correction',
            `Match ${result.before.ball.matchId} — Innings ${result.before.ball.innings} Over ${result.before.ball.over}.${result.before.ball.ballInOver}`,
            { kind: result.before.ball.kind, runs: result.before.ball.runs, striker: result.before.ball.striker, bowler: result.before.ball.bowler },
            { kind: result.after.ball.kind, runs: result.after.ball.runs, striker: result.after.ball.striker, bowler: result.after.ball.bowler }
        );
        res.json({ success: true, ...result });
    } catch (err) {
        console.log('Ball correction save error:', err);
        res.status(500).json({ success: false, error: 'Could not save correction' });
    }
});

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
        // 🩹 matchCount now comes from matchRecordsCollection (one doc per
        // match) via a cheap grouped count, instead of projecting the whole
        // `matches` array out of every league doc just to read its .length —
        // that used to mean this single admin page load pulled every match
        // any of the last 50 active owners had ever saved.
        const [leagues, matchCounts, recentMatches, ballCount] = await Promise.all([
            leaguesCollection ? leaguesCollection.find({}).project({ ownerUid: 1, leagueKey: 1, displayName: 1, updatedAt: 1, liveMatches: 1, sport: 1, completed: 1, statusOverride: 1 }).sort({ updatedAt: -1 }).limit(50).toArray() : [],
            matchRecordsCollection ? matchRecordsCollection.aggregate([
                { $group: { _id: { ownerUid: '$ownerUid', leagueKey: '$leagueKey' }, count: { $sum: 1 } } }
            ]).toArray() : [],
            matchesCollection ? matchesCollection.find({}).sort({ recordingStartedAt: -1 }).limit(50).toArray() : [],
            ballsCollection ? ballsCollection.countDocuments() : 0
        ]);
        const countKey = (ownerUid, leagueKey) => `${ownerUid}::${leagueKey}`;
        const countMap = new Map(matchCounts.map(c => [countKey(c._id.ownerUid, c._id.leagueKey), c.count]));
        const tournaments = leagues.map(l => {
            const matchCount = countMap.get(countKey(l.ownerUid, l.leagueKey)) || 0;
            const isLive = !!(l.liveMatches && l.liveMatches.length > 0);
            // Same status computation as the public /api/public/tournaments
            // route, so what the admin panel shows/edits matches what
            // visitors actually see on index.html.
            const publicStatus = l.statusOverride || (isLive ? 'live' : (l.completed ? 'completed' : (matchCount > 0 ? 'ongoing' : 'upcoming')));
            return {
                leagueKey: l.leagueKey, displayName: l.displayName || l.leagueKey,
                ownerUid: l.ownerUid, matchCount, updatedAt: l.updatedAt || null,
                sport: l.sport || 'cricket', publicStatus, statusOverride: l.statusOverride || null
            };
        });
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
// A specific completed match inside a tournament now reuses the full
// cricket-scorecard.html viewer (same batting/bowling clip icons, Match
// Highlights, comparison charts as a live match) instead of the plainer
// score-tournament.html per-match view — see loadMatchSnapshot()/
// history=1 mode in cricket-scorecard.html.
app.get('/score/tournament/:token/match/:matchId', (req, res) => {
    const qs = new URLSearchParams({ token: req.params.token, match: req.params.matchId, history: '1' });
    res.redirect(302, `/cricket-scorecard?${qs.toString()}`);
});
// A specific standalone (non-tournament) match now also reuses
// cricket-scorecard.html — if it's finished, history=1 pulls a one-shot
// snapshot via /api/public/match/:id; if it's still being played (that
// endpoint comes back with match:null + a roomId), the page transparently
// falls back to a live socket join instead of showing an error.
app.get('/score/match/:id', (req, res) => {
    const qs = new URLSearchParams({ match: req.params.id, history: '1' });
    res.redirect(302, `/cricket-scorecard?${qs.toString()}`);
});
app.get('/football-matchintro', (req, res) => res.sendFile(__dirname + '/football-matchintro.html'));
app.get('/football-matchintro-panel', (req, res) => res.sendFile(__dirname + '/football-matchintro-panel.html'));

let roomStates = {};
const firestoreWriteTimers = {}; // debounce map: targetId -> timeout handle

// ================================================================
// 🩹 FIX: MATCH SCORECARD ↔ TOURNAMENT SYNC
//
// ROOT CAUSE: matchRecordsCollection (the ONLY thing tournament pages read
// — see /api/public/tournament/:token and getLeagueMatches above) was
// previously updated ONLY when the panel client explicitly called
// POST /api/league/:name/match (match start / "save on victory"). Every
// ball in between was written to ballsCollection (via the logBall socket
// handler below) and broadcast live over the socket (via
// updateCricketScore), so the live Match Scorecard page — which reads
// straight from the socket — was instantly correct, while any Tournament
// page — which only reads matchRecordsCollection — kept showing whatever
// was last explicitly saved (typically the match's initial 0-0 shell).
// Same underlying event, two disconnected read paths.
//
// FIX: after every ball is committed to ballsCollection (the permanent
// source of truth), also rebuild that match's battingCard/bowlingCard/
// scoreA/scoreB from ballsCollection — using the EXACT same per-ball rules
// as computeMatchPlayerStats() above (byes/leg-byes aren't batter runs,
// wides aren't a faced ball, run-outs aren't a bowler wicket) — and $set
// them onto the SAME matchRecordsCollection doc the tournament already
// reads. No client changes needed, no new data store, no second scoring
// system: ballsCollection stays the one source of truth: this just keeps
// the tournament's read path from going stale. Debounced per matchId
// (900ms) so a burst of balls doesn't hammer Mongo, mirroring the same
// debounce pattern already used for Firestore writes above.
// ================================================================
const matchRecordSyncTimers = {}; // matchId -> timeout handle

async function buildLiveCardsFromBalls(matchId) {
    const balls = await ballsCollection.find({ matchId }).sort({ innings: 1, over: 1, ballInOver: 1 }).toArray();
    return buildLiveCardsFromBallsArray(balls);
}

// 🎯 Same exact derivation as buildLiveCardsFromBalls() above, factored out
// to take an in-memory balls array instead of querying Mongo. This is what
// lets the ball-correction engine (see adminRouter '/cricket/ball/:ballId'
// below) SIMULATE "what would this match look like with delivery X
// corrected" — by swapping one ball in the array — and see the resulting
// scorecard/stats BEFORE writing anything, exactly like the real
// buildLiveCardsFromBalls(matchId) does after a write. Keep these two
// functions' scoring rules identical; buildLiveCardsFromBalls is now a
// thin DB-fetching wrapper around this one so they can never drift apart.
function buildLiveCardsFromBallsArray(balls) {
    const batting = { A: {}, B: {} };     // battingTeam -> strikerKey -> row
    const bowling = { A: {}, B: {} };     // bowlingTeam (bowler's own team) -> bowlerKey -> row
    const oversBowled = { A: {}, B: {} }; // bowlingTeam -> `${bowlerKey}::${innings}-${over}` -> { legalBalls, runs }
    // 🩹 CORRECTION-SAFETY FIX: this used to just forward whichever ball's
    // client-sent `score` snapshot happened to be logged LAST for a team
    // ("latestScore") — a live-only convenience that quietly breaks the
    // moment any earlier ball is corrected, since a stale snapshot from
    // before the correction would still win. A real correction engine
    // needs the team total to be a genuine SUM over the (possibly just-
    // corrected) balls, every time — never a cached/forwarded value. Same
    // for wickets and legal-ball (over) count. See deriveBallFacts() for
    // the legal-ball rule this reuses.
    const teamTotals = { A: { runs: 0, wickets: 0, legalBalls: 0 }, B: { runs: 0, wickets: 0, legalBalls: 0 } };

    balls.forEach(b => {
        const bt = b.battingTeam === 'B' ? 'B' : 'A';
        const bowlTeam = bt === 'A' ? 'B' : 'A';
        const facts = deriveBallFacts(b.kind, b.runs);
        teamTotals[bt].runs += b.runs || 0;
        if (b.dismissal) teamTotals[bt].wickets++;
        if (facts.legalBall) teamTotals[bt].legalBalls++;

        if (b.strikerKey && b.kind !== 'Wd') {
            const key = b.strikerKey;
            if (!batting[bt][key]) batting[bt][key] = { name: b.striker || key, runs: 0, balls: 0, fours: 0, sixes: 0 };
            const row = batting[bt][key];
            row.balls++;
            if (b.kind !== 'B' && b.kind !== 'LB') row.runs += b.runs || 0;
            if (b.kind === '4') row.fours++;
            if (b.kind === '6') row.sixes++;
        }

        if (b.bowlerKey && b.kind !== 'B' && b.kind !== 'LB') {
            const key = b.bowlerKey;
            if (!bowling[bowlTeam][key]) bowling[bowlTeam][key] = { name: b.bowler || key, balls: 0, runs: 0, wickets: 0 };
            const row = bowling[bowlTeam][key];
            const isLegal = b.kind !== 'Wd' && b.kind !== 'Nb';
            if (isLegal) row.balls++;
            row.runs += b.runs || 0;
            if (b.dismissal && b.dismissal.type && b.dismissal.type.toLowerCase() !== 'run out') row.wickets++;

            const overKey = `${key}::${b.innings || 1}-${b.over}`;
            if (!oversBowled[bowlTeam][overKey]) oversBowled[bowlTeam][overKey] = { bowlerKey: key, legalBalls: 0, runs: 0 };
            if (isLegal) oversBowled[bowlTeam][overKey].legalBalls++;
            oversBowled[bowlTeam][overKey].runs += b.runs || 0;
        }
    });

    const toBattingCard = (team) => Object.values(batting[team]);
    const toBowlingCard = (team) => Object.entries(bowling[team]).map(([key, row]) => ({
        name: row.name,
        overs: Math.floor(row.balls / 6),
        balls: row.balls % 6, // same (overs, balls) pair shape fmtOversLike()/computeLeaderboards already expect
        runs: row.runs,
        wickets: row.wickets,
        maidens: Object.values(oversBowled[team]).filter(o => o.bowlerKey === key && o.legalBalls === 6 && o.runs === 0).length
    }));
    const toScore = (team) => {
        const t = teamTotals[team];
        return { runs: t.runs, wickets: t.wickets, overs: `${Math.floor(t.legalBalls / 6)}.${t.legalBalls % 6}` };
    };

    return {
        battingCard: { A: toBattingCard('A'), B: toBattingCard('B') },
        bowlingCard: { A: toBowlingCard('A'), B: toBowlingCard('B') },
        scoreA: toScore('A'),
        scoreB: toScore('B')
    };
}

async function syncMatchRecordFromBalls(ownerUid, matchId) {
    if (!ballsCollection || !matchRecordsCollection || !ownerUid || !matchId) return;
    try {
        // Only UPDATE an existing shell doc (created by the normal
        // POST /api/league/:name/match save at match start) — never upsert
        // here, since we don't know leagueKey/teamA/teamB and must not
        // create/own a competing record for this matchId.
        const existing = await matchRecordsCollection.findOne({ ownerUid, matchId }, { projection: { leagueKey: 1 } });
        if (!existing) return;
        const cards = await buildLiveCardsFromBalls(matchId);
        await matchRecordsCollection.updateOne(
            { ownerUid, leagueKey: existing.leagueKey, matchId },
            { $set: { ...cards, liveSyncedAt: Date.now() } }
        );
        // Public tournament portal caches its payload for up to 4s (see
        // PUBLIC_CACHE_TTL_MS below) — invalidate it now so viewers see
        // this ball within ~1s instead of waiting out the full TTL.
        if (leaguesCollection) {
            const league = await leaguesCollection.findOne({ ownerUid, leagueKey: existing.leagueKey }, { projection: { publicToken: 1 } });
            if (league && league.publicToken) publicTournamentCache.delete(league.publicToken);
        }
    } catch (err) {
        console.log('syncMatchRecordFromBalls error:', err);
    }
}

function scheduleMatchRecordSync(ownerUid, matchId) {
    if (!ownerUid || !matchId) return;
    clearTimeout(matchRecordSyncTimers[matchId]);
    matchRecordSyncTimers[matchId] = setTimeout(() => {
        syncMatchRecordFromBalls(ownerUid, matchId);
    }, 900);
}

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
            // 🌟 Stamp global playerIds alongside the existing name-string
            // keys (see resolvePlayerId) — additive only, every existing
            // *Key field and query in this file still works unchanged.
            // Prefers the client's own roster-assigned ID (strikerId/
            // nonStrikerId/bowlerId — see cricket-panel TEAM SQUADS) when
            // present, so two players sharing a name never collide into
            // one profile; falls back to name-based resolution otherwise.
            const [strikerPlayerId, nonStrikerPlayerId, bowlerPlayerId, dismissalFielderPlayerId] = ownerUid ? await Promise.all([
                resolvePlayerIdExplicit(ownerUid, data.strikerId, data.striker),
                resolvePlayerIdExplicit(ownerUid, data.nonStrikerId, data.nonStriker),
                resolvePlayerIdExplicit(ownerUid, data.bowlerId, data.bowler),
                resolvePlayerId(ownerUid, data.dismissal && data.dismissal.fielder)
            ]) : [null, null, null, null];
            // 🛡️ Normalize through personName() in case a client sends
            // {name,...} objects instead of plain strings (see comment on
            // personName above) — stores the clean name either way.
            const strikerName = personName(data.striker);
            const nonStrikerName = personName(data.nonStriker);
            const bowlerName = personName(data.bowler);
            const fielderName = personName(data.dismissal && data.dismissal.fielder);
            await ballsCollection.insertOne({
                matchId,
                ownerUid: ownerUid || null,
                innings: data.innings,
                over: data.over,
                ballInOver: data.ballInOver,
                kind: data.kind,          // '0'-'6', 'W', 'Wd', 'Nb', 'B', 'LB'
                runs: data.runs,
                battingTeam: data.battingTeam,
                striker: strikerName,
                strikerKey: playerKey(strikerName),
                strikerPlayerId,
                nonStriker: nonStrikerName,
                nonStrikerKey: playerKey(nonStrikerName),
                nonStrikerPlayerId,
                bowler: bowlerName,
                bowlerKey: playerKey(bowlerName),
                bowlerPlayerId,
                dismissal: data.dismissal ? { type: data.dismissal.type || 'Out', fielder: fielderName } : null,
                dismissalFielderKey: playerKey(fielderName),
                dismissalFielderPlayerId,
                score: data.score,        // { runs, wickets, overs, balls } snapshot after this ball
                timestamp: data.timestamp || Date.now()
            });

            // 🩹 Keep the tournament's read path (matchRecordsCollection) from
            // going stale — see the big comment above buildLiveCardsFromBalls.
            if (ownerUid) scheduleMatchRecordSync(ownerUid, matchId);
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
