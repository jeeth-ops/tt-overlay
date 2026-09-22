'use strict';
/**
 * clip-media.js — media-delivery helpers for recorded clips.
 *
 * Why this exists: a clip that is slow on its FIRST open and fine afterwards is
 * the signature of (1) an MP4 whose `moov` index is at the END of the file (the
 * browser has to fetch the tail before it can start, and every extra round trip
 * hits a cold origin), and (2) objects served with no cache headers from a
 * non-CDN origin. Both are fixed at ingest time, once per clip, so playback is
 * fast on the very first view for every viewer, on every device.
 *
 * Node core only (fs, child_process) — no new dependencies. ffmpeg is invoked
 * through the binary path server.js already has (@ffmpeg-installer/ffmpeg).
 */
const fs = require('fs');
const { spawn } = require('child_process');

// Recorded clips never change after upload (deterministic key per clipId), so
// browsers and the Cloudflare edge may keep them for a year without revalidating.
const CLIP_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/* ---------------------------------------------------------------- MP4 layout */
// Reads the top-level ISO-BMFF boxes (a few bytes each — never the whole file).
async function readTopLevelBoxes(filePath, maxBoxes = 64) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    const boxes = [];
    const hdr = Buffer.alloc(16);
    let pos = 0;
    while (pos + 8 <= fileSize && boxes.length < maxBoxes) {
      const { bytesRead } = await fh.read(hdr, 0, 16, pos);
      if (bytesRead < 8) break;
      let size = hdr.readUInt32BE(0);
      const type = hdr.toString('latin1', 4, 8);
      if (size === 1) {                       // 64-bit "largesize"
        if (bytesRead < 16) break;
        size = Number(hdr.readBigUInt64BE(8));
      } else if (size === 0) {                // box runs to end of file
        size = fileSize - pos;
      }
      if (size < 8 || !/^[\x20-\x7e]{4}$/.test(type)) break;   // not a valid box -> not an MP4 we understand
      boxes.push({ type, offset: pos, size });
      pos += size;
    }
    return { boxes, fileSize };
  } finally {
    await fh.close();
  }
}

// { valid, faststart, moovOffset, mdatOffset, fileSize }
// faststart === the index (moov) comes before the media data (mdat/moof), so
// playback can begin from the first bytes of the file.
async function mp4Layout(filePath) {
  const { boxes, fileSize } = await readTopLevelBoxes(filePath);
  const ftyp = boxes.find(b => b.type === 'ftyp');
  const moov = boxes.find(b => b.type === 'moov');
  const media = boxes.find(b => b.type === 'mdat' || b.type === 'moof');
  if (!ftyp || !moov) return { valid: false, faststart: false, fileSize };
  return {
    valid: true,
    faststart: !media || moov.offset < media.offset,
    moovOffset: moov.offset,
    mdatOffset: media ? media.offset : null,
    fileSize
  };
}

/* ------------------------------------------------------------------- ffmpeg */
function runFfmpeg(ffmpegPath, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, timeoutMs);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.trim()}`)); });
  });
}

// Moves the moov index to the front WITHOUT re-encoding (stream copy: no quality
// loss, ~100-300 ms for a 20 s clip). No-op if the file is already faststart.
async function ensureFastStart(filePath, ffmpegPath) {
  const before = await mp4Layout(filePath);
  if (!before.valid) return { changed: false, reason: 'not-an-mp4' };
  if (before.faststart) return { changed: false, reason: 'already-faststart' };
  const tmp = `${filePath}.faststart.tmp.mp4`;
  try {
    await runFfmpeg(ffmpegPath, ['-i', filePath, '-c', 'copy', '-movflags', '+faststart', tmp]);
    const after = await mp4Layout(tmp);
    const st = await fs.promises.stat(tmp);
    if (!after.valid || !after.faststart || st.size < 1024) throw new Error('remux verification failed');
    await fs.promises.rename(tmp, filePath);   // atomic replace
    return { changed: true, before, after };
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

// One JPEG frame (~0.5 s in, max 640 px wide) — the <video poster> so the player
// shows a picture immediately instead of a black box while it initialises.
async function makePoster(filePath, posterPath, ffmpegPath, { atSec = 0.5, maxWidth = 640 } = {}) {
  await runFfmpeg(ffmpegPath, ['-ss', String(atSec), '-i', filePath, '-frames:v', '1',
    '-vf', `scale='min(${maxWidth},iw)':-2`, '-q:v', '4', posterPath]);
  const st = await fs.promises.stat(posterPath);
  if (st.size < 200) throw new Error('poster too small');
  return posterPath;
}

// Best-effort: never throws (a clip must still be uploaded if optimising fails).
async function optimizeClipFile(filePath, { ffmpegPath, posterPath, log = console.log } = {}) {
  const out = { faststartFixed: false, posterPath: null };
  if (!ffmpegPath) return out;
  try {
    const r = await ensureFastStart(filePath, ffmpegPath);
    out.faststartFixed = !!r.changed;
    if (r.changed) log(`[CLIP-MEDIA] moved moov to front (faststart): ${filePath}`);
  } catch (err) { log(`[CLIP-MEDIA] faststart failed (uploading original): ${err.message || err}`); }
  if (posterPath) {
    try { out.posterPath = await makePoster(filePath, posterPath, ffmpegPath); }
    catch (err) { log(`[CLIP-MEDIA] poster failed (non-fatal): ${err.message || err}`); }
  }
  return out;
}

/* ------------------------------------------------- Drive fallback: Range proxy */
// The old /watch Drive fallback piped the whole file with no Content-Length /
// Accept-Ranges / Range support, so a browser could neither seek nor resume.
// This forwards the viewer's Range header to Drive and relays 206 + Content-Range.
async function pipeDriveClip(driveClient, fileId, req, res) {
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const driveRes = await driveClient.files.get({ fileId, alt: 'media' }, { responseType: 'stream', headers });
  const h = driveRes.headers || {};
  res.status(driveRes.status === 206 ? 206 : 200);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  if (h['content-length']) res.setHeader('Content-Length', h['content-length']);
  if (driveRes.status === 206 && h['content-range']) res.setHeader('Content-Range', h['content-range']);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  const stream = driveRes.data;
  // A viewer seeking/closing aborts the request — release the Drive stream
  // instead of leaking one open connection per abandoned range.
  res.on('close', () => { if (!stream.destroyed) stream.destroy(); });
  stream.on('error', () => res.end());
  stream.pipe(res);
}

/* ---------------------------------- small TTL cache for "does the R2 object exist" */
function createExistenceCache(checkFn, { positiveTtlMs = 10 * 60 * 1000, negativeTtlMs = 30 * 1000, max = 5000 } = {}) {
  const map = new Map();          // url -> { ok, exp }
  const inflight = new Map();     // url -> Promise (coalesce concurrent checks)
  return async function exists(url) {
    const now = Date.now();
    const hit = map.get(url);
    if (hit && hit.exp > now) return hit.ok;
    if (inflight.has(url)) return inflight.get(url);
    const p = (async () => {
      const ok = !!(await checkFn(url));
      if (map.size >= max) map.delete(map.keys().next().value);
      map.set(url, { ok, exp: Date.now() + (ok ? positiveTtlMs : negativeTtlMs) });
      return ok;
    })().finally(() => inflight.delete(url));
    inflight.set(url, p);
    return p;
  };
}

module.exports = {
  CLIP_CACHE_CONTROL, readTopLevelBoxes, mp4Layout, ensureFastStart, makePoster,
  optimizeClipFile, pipeDriveClip, createExistenceCache, runFfmpeg
};
