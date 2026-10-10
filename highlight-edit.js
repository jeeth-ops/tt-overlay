'use strict';
/**
 * highlight-edit.js — the "pro edit" of a downloaded highlights video.
 *
 * A plain compile glues the clips end to end: hard cuts, no titles. This turns
 * the same clips into a package ready to post:
 *
 *   title card ─▶ clip ─▶ band wipe ─▶ clip ─▶ band wipe ─▶ … ─▶ end card
 *
 * - The title card: the clip's own picture, blurred, slowly zooming, under the
 *   tournament, the player (or the teams) and what the video holds.
 * - Every clip carries a stacked event tag at the top left — the event (SIX /
 *   FOUR / WICKET / …), the player, then the over and the bowler. Top left on
 *   purpose: the broadcast score bar (bottom) and the channel logo (top right)
 *   are already in the picture.
 * - Between clips a branded band, the logo in the middle, sweeps across with a
 *   whoosh. It covers the whole frame at the cut, so a cut is never seen; its
 *   leading edge is the brand colour, its trailing edge the colour of the event
 *   it reveals.
 * - The end card: logo and website, then a fade to black.
 * - One H.264 / AAC MP4 (faststart): 1080p or 720p, 25 or 30 fps.
 *
 * Fast, and kind to the live server:
 * - Each clip is rendered on its own into a segment that already holds its
 *   half of the wipe on either side. The band's path is ONE function of time,
 *   split at the cut, so two segments rendered apart meet without a seam —
 *   and a segment can be cached and reused by any later video with that clip.
 * - Every segment is encoded with the same "stitchable" x264 settings, so the
 *   finished picture is a stream copy of the segments (no second encode); the
 *   sound rides in each segment losslessly and is encoded once, as one track.
 * - One ffmpeg at a time, at low priority (nice), so live scoring on the same
 *   machine never waits behind an edit.
 * - Built for the server's ffmpeg 4.1 static build (no xfade): the wipe is a
 *   pre-drawn band moved by an expression, the text is drawtext.
 *
 * Node core only.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const STYLE = 'v1';             // bump when the look changes: old cached segments are left alone
const STING = 0.6;              // the whole wipe, seconds
const HALF = STING / 2;         // each segment's half of it
const EASE_K = 0.75;            // the band rushes in, lingers while it covers, rushes out
const INTRO_SEC = 2.8;
const OUTRO_SEC = 2.6;
const TAG_IN = 0.45;            // the event tag arrives just after the band has gone
const TAG_HOLD = 3.3;

const ACCENT = { SIX: 'a855f7', FOUR: '3b82f6', WICKET: 'ef4444', HIGHLIGHT: '22c55e', BRAND: 'f59e0b' };
const FONT_DIR = path.join(__dirname, 'assets', 'highlights', 'fonts');
const FONTS = {
  display: path.join(FONT_DIR, 'BigShoulders-Bold.ttf'),       // names, titles
  event: path.join(FONT_DIR, 'InterDisplay-BlackItalic.otf'),  // SIX / FOUR / WICKET
  body: path.join(FONT_DIR, 'Inter-SemiBold.otf')              // over, bowler, website
};
const LOGO = path.join(__dirname, 'logo.png');

/* ------------------------------------------------------------- small helpers */
const r2 = (n) => Math.round(n * 100) / 100;
// Segment lengths are whole multiples of a span that is BOTH whole video frames
// and whole AAC frames (1024 samples at 48 kHz): 16 frames at 30 fps (0.533 s,
// 25 AAC frames), 8 at 25 fps (0.32 s, 15). Picture and sound of every segment
// then end on the same instant, and the joined video has no gap at a cut.
const gridFrames = (fps) => (fps === 25 ? 8 : 16);
function gridLength(sec, fps, mode) {
  const g = gridFrames(fps), n = sec * fps / g;
  return Math.max(1, mode === 'floor' ? Math.floor(n + 1e-6) : Math.round(n)) * g;
}
// A clip keeps all it can of itself, cut down to the grid (at most ~half a second).
const clipFrames = (info, p) => Math.max(gridLength(1.5, p.fps), gridLength(info.duration - 0.05, p.fps, 'floor'));
// A path inside a filtergraph option (Windows drive colons, quotes).
const fpath = (p) => String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
const clampExpr = (e) => `min(max(${e},0),1)`;
// Text shown on the video: one line, plain printable characters, upper case.
function cleanText(s, max = 64) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, max);
}
function sha1(o) { return crypto.createHash('sha1').update(typeof o === 'string' ? o : JSON.stringify(o)).digest('hex'); }
// CPUs this process may really use: a container's cgroup quota when it has one
// (a hosted server reports the host's cores, not the slice it was given).
function cpuBudget() {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) { return ''; } };
  let quota = 0;
  const v2 = read('/sys/fs/cgroup/cpu.max').split(/\s+/);
  if (v2[0] && v2[0] !== 'max' && Number(v2[1]) > 0) quota = Number(v2[0]) / Number(v2[1]);
  if (!quota) {
    const q = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us')), per = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
    if (q > 0 && per > 0) quota = q / per;
  }
  const os = require('os');
  const cores = (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1;
  return Math.max(1, Math.min(cores, quota ? Math.floor(quota) || 1 : cores));
}
// Memory this process may really use (MB): the container's limit when it has one.
function memBudgetMB() {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) { return ''; } };
  const v2 = read('/sys/fs/cgroup/memory.max'), v1 = read('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const lim = Number(v2 && v2 !== 'max' ? v2 : v1);
  const total = require('os').totalmem();
  return Math.round((lim > 0 && lim < total ? lim : total) / 1048576);
}

/* ------------------------------------------------------- the clip's tag text */
// What the event tag on a clip says. clip: a clips-collection doc (or the same
// fields): eventType, outcomeLabel, strikerName, bowlerName, fielderName,
// dismissedPlayerName, dismissalType, over (0-based), ballInOver.
function cardForClip(clip) {
  const c = clip || {};
  const ev = String(c.eventType || '').toUpperCase();
  const at = (c.over != null && c.ballInOver != null) ? `${Number(c.over)}.${Number(c.ballInOver)} OV` : '';
  const bowler = cleanText(c.bowlerName || c.bowler, 40);
  const striker = cleanText(c.strikerName || c.striker, 40);
  const join = (...parts) => parts.filter(Boolean).join('  ·  ');
  if (ev === 'SIX' || ev === 'FOUR') {
    return { kind: ev, label: ev, title: striker || 'BATTER', sub: join(at, bowler && `OFF ${bowler}`) };
  }
  if (ev === 'WICKET') {
    const out = cleanText(c.dismissedPlayerName || c.dismissedPlayer || c.strikerName || c.striker, 40) || 'BATTER';
    const type = String(c.dismissalType || '').toLowerCase();
    const fielder = cleanText(c.fielderName || c.fielder, 40);
    let how = '';
    if (/caught/.test(type)) how = fielder && fielder !== bowler ? `CAUGHT ${fielder}${bowler ? ` · BOWLED ${bowler}` : ''}` : (bowler ? `CAUGHT & BOWLED ${bowler}` : 'CAUGHT');
    else if (/^bowled/.test(type)) how = bowler ? `BOWLED ${bowler}` : 'BOWLED';
    else if (/lbw/.test(type)) how = bowler ? `LBW · ${bowler}` : 'LBW';
    else if (/stump/.test(type)) how = fielder ? `STUMPED ${fielder}${bowler ? ` · ${bowler}` : ''}` : 'STUMPED';
    else if (/run ?out/.test(type)) how = fielder ? `RUN OUT · ${fielder}` : 'RUN OUT';
    else if (/hit wicket/.test(type)) how = bowler ? `HIT WICKET · ${bowler}` : 'HIT WICKET';
    else how = cleanText(c.dismissalType, 30) || (bowler ? `WICKET · ${bowler}` : '');
    return { kind: 'WICKET', label: 'WICKET', title: out, sub: join(how, at) };
  }
  const label = cleanText(c.outcomeLabel, 18) || 'HIGHLIGHT';
  return { kind: 'HIGHLIGHT', label, title: striker || 'HIGHLIGHT', sub: join(at, bowler && `BOWLER ${bowler}`) };
}

/* ------------------------------------------------------------------ ffmpeg */
function createHighlightEditor(opts = {}) {
  const ffmpegPath = opts.ffmpegPath;
  const log = opts.log || (() => {});
  const cacheDir = opts.cacheDir || path.join(require('os').tmpdir(), 'scorvix-highlight-cache');
  const cacheMaxBytes = opts.cacheMaxBytes || 1536 * 1048576;
  const preset = opts.preset || 'superfast';
  // Decoder / encoder threads: the cores really available, at most 3 (beyond
  // that each thread only adds frames held in memory on a small server).
  const threads = Math.max(1, Math.min(opts.threads || cpuBudget(), 3));
  fs.mkdirSync(cacheDir, { recursive: true });

  // Low priority where the OS has it: the live server on the same machine
  // always comes first.
  let niceOk = false;
  if (process.platform !== 'win32' && opts.nice !== false) {
    try { niceOk = spawnSync('nice', ['-n', '1', 'true']).status === 0; } catch (e) { niceOk = false; }
  }
  const niceLevel = String(opts.niceLevel == null ? 12 : opts.niceLevel);

  // One ffmpeg at a time across every job: jobs interleave segment by
  // segment instead of fighting over the CPU.
  let chain = Promise.resolve();
  let queued = 0;
  function run(args, { timeoutMs = 15 * 60 * 1000, totalSec = 0, onProgress } = {}) {
    queued++;
    const p = chain.then(() => { queued--; return exec(args, timeoutMs, totalSec, onProgress); }, () => { queued--; return exec(args, timeoutMs, totalSec, onProgress); });
    chain = p.catch(() => {});
    return p;
  }
  function exec(args, timeoutMs, totalSec, onProgress) {
    return new Promise((resolve, reject) => {
      const full = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...(onProgress ? ['-progress', 'pipe:1', '-nostats'] : []), ...args];
      const p = niceOk ? spawn('nice', ['-n', niceLevel, ffmpegPath, ...full], { stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(ffmpegPath, full, { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; if (err.length > 6000) err = err.slice(-6000); });
      let buf = '';
      p.stdout.on('data', (d) => {
        if (!onProgress) return;
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          const m = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
          if (m && totalSec > 0) onProgress(Math.min(1, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / totalSec));
        }
      });
      const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, timeoutMs);
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.trim().slice(-1500)}`)); });
    });
  }
  // ffmpeg -i with no output: the stream lines on stderr are the probe.
  function probe(file) {
    return new Promise((resolve) => {
      const p = spawn(ffmpegPath, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', () => resolve(null));
      p.on('close', () => {
        const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
        const v = /Stream #\d+:\d+[^\n]*Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(err);
        const f = /Stream #\d+:\d+[^\n]*Video:[^\n]*?([\d.]+) fps/.exec(err) || /Stream #\d+:\d+[^\n]*Video:[^\n]*?([\d.]+) tbr/.exec(err);
        if (!d || !v) return resolve(null);
        resolve({
          duration: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]),
          width: Number(v[1]), height: Number(v[2]), fps: f ? Number(f[1]) : 30,
          hasAudio: /Stream #\d+:\d+[^\n]*Audio:/.test(err)
        });
      });
    });
  }

  /* ---------------------------------------------------------- the format */
  // 1080p when any clip is ~1080p, else 720p. 50/60 fps → 25/30: half the
  // frames to encode, and what the social apps play anyway.
  // A small server (one CPU, or under ~1 GB of memory) renders 720p: a 1080p
  // encode takes ~220 MB next to the live server, and ~1.6x the time.
  const maxHeight = opts.maxHeight || (memBudgetMB() < 1000 || cpuBudget() < 2 ? 720 : 1080);
  function pickProfile(probes) {
    const ok = probes.filter(Boolean);
    const maxH = Math.max(0, ...ok.map(p => p.height));
    const h = maxH >= 1000 && maxHeight >= 1080 ? 1080 : 720;
    const w = h === 1080 ? 1920 : 1280;
    const fpss = ok.map(p => p.fps).filter(f => f > 0);
    const pal = fpss.length > 0 && fpss.every(f => Math.abs(f - 25) < 1.5 || Math.abs(f - 50) < 1.5);
    const fps = pal ? 25 : 30;
    return { w, h, fps, k: h / 1080, key: `${w}x${h}p${fps}` };
  }
  function encodeArgs(p) {
    const big = p.h >= 1080;
    return ['-c:v', 'libx264', '-preset', preset, '-crf', '23', '-maxrate', big ? '6M' : '4M', '-bufsize', big ? '12M' : '8M',
      '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p', '-r', String(p.fps),
      '-x264-params', `stitchable=1:keyint=${p.fps * 2}:min-keyint=${p.fps}`,
      // Lossless sound inside a segment (MKV + FLAC): AAC would put an encoder
      // delay at the start of every segment, and the joins would stutter. The
      // finished video gets ONE AAC encode of the whole soundtrack.
      '-c:a', 'flac', '-ar', '48000', '-ac', '2', '-threads', String(threads), '-f', 'matroska'];
  }

  /* ------------------------------------------------------------ the art */
  // The band: a slanted navy slab (logo in the middle), an accent stripe and a
  // thin detached line on both edges. Drawn once per format and accent.
  function bandGeom(p) {
    const k = p.k, s = Math.round(350 * k), m = Math.round(320 * k), L = Math.round(30 * k);
    const Bw = p.w + s + m, IW = L + s + Bw + L;
    return { s, m, L, Bw, IW, xs: -IW, xe: p.w };
  }
  const assetsMemo = new Map();
  function ensureAssets(p) {
    const key = `${STYLE}-${p.key}`;
    if (!assetsMemo.has(key)) assetsMemo.set(key, buildAssets(p, path.join(cacheDir, 'assets', key)).catch((e) => { assetsMemo.delete(key); throw e; }));
    return assetsMemo.get(key);
  }
  // An asset is written under a temporary name and moved into place, so a
  // crash half-way never leaves a broken file that a later render would trust.
  async function makeOnce(file, args) {
    if (fs.existsSync(file)) return;
    const ext = path.extname(file), tmp = `${file.slice(0, -ext.length)}.${process.pid}.tmp${ext}`;
    try { await run([...args, tmp]); fs.renameSync(tmp, file); } catch (e) { fs.unlink(tmp, () => {}); throw e; }
  }
  async function buildAssets(p, dir) {
    fs.mkdirSync(dir, { recursive: true });
    const g = bandGeom(p), k = p.k, H = p.h;
    const out = { dir, band: {}, shade: path.join(dir, 'shade.png'), whoosh: path.join(dir, 'whoosh.wav'), logo: path.join(dir, 'logo.png') };
    const logoH = Math.round(H * 0.22 / 2) * 2;
    await makeOnce(out.logo, ['-i', LOGO, '-vf', `scale=-2:${logoH}:flags=lanczos,format=rgba`, '-frames:v', '1']);
    const strip = Math.round(34 * k), lineW = Math.round(12 * k), gap = Math.round(18 * k);
    for (const [name, hex] of Object.entries(ACCENT)) {
      const file = path.join(dir, `band-${name}.png`);
      out.band[name] = file;
      const R = parseInt(hex.slice(0, 2), 16), G = parseInt(hex.slice(2, 4), 16), B = parseInt(hex.slice(4, 6), 16);
      // u: distance along the slab from its slanted left edge.
      const u = `(X-${g.L}-${g.s}*(${H}-Y)/${H})`;
      const inBody = `between(${u},0,${g.Bw - 1})`;
      const inStrip = `(between(${u},0,${strip - 1})+between(${u},${g.Bw - strip},${g.Bw - 1}))`;
      const inLine = `(between(${u},${-gap - lineW},${-gap - 1})+between(${u},${g.Bw + gap},${g.Bw + gap + lineW - 1}))`;
      const ch = (acc, navyTop, navyBot) => `if(${inStrip}+${inLine},${acc},${navyTop}+(${navyBot - navyTop})*Y/${H})`;
      await makeOnce(file, ['-f', 'lavfi', '-i', `color=c=black@0:s=${g.IW}x${H},format=rgba`, '-i', out.logo,
        '-filter_complex',
        `[0:v]geq=r='${ch(R, 11, 22)}':g='${ch(G, 18, 34)}':b='${ch(B, 32, 58)}':a='if(${inBody},255,if(${inLine},200,0))'[b];` +
        `[b][1:v]overlay=x=${g.L + Math.round(g.s / 2 + g.Bw / 2)}-w/2:y=(H-h)/2:format=rgb[o]`,
        '-map', '[o]', '-frames:v', '1']);
    }
    // Darkens the left of a title card for the text, and the bottom a little.
    await makeOnce(out.shade, ['-f', 'lavfi', '-i', `color=c=black:s=${p.w}x${H},format=rgba`, '-vf',
      `geq=r=6:g=10:b=20:a='min(255,215*pow(1-X/W,1.15)+90*pow(Y/H,2.5)+40)'`, '-frames:v', '1']);
    // A whoosh: filtered pink noise, swelling to the cut and away again.
    await makeOnce(out.whoosh, ['-f', 'lavfi', '-i', `anoisesrc=d=${STING}:c=pink:r=48000:a=0.6:s=11`, '-af',
      `highpass=f=320,lowpass=f=7000,afade=t=in:d=${HALF}:curve=exp,afade=t=out:st=${HALF}:d=${HALF}:curve=exp,volume=1.4,aformat=channel_layouts=stereo`]);
    return out;
  }

  // x of the band at stinger time tau (0 … STING) — the same function on both
  // sides of a cut, which is what makes two separately rendered halves meet.
  function bandX(g, tauExpr) {
    const U = `(${tauExpr})/${STING}`;
    return `${g.xs}+${g.xe - g.xs}*((${U})+${EASE_K}*sin(2*PI*(${U}))/(2*PI))`;
  }

  /* -------------------------------------------------------- the text bits */
  function textFile(dir, name, text) {
    const f = path.join(dir, `${name}.txt`);
    fs.writeFileSync(f, text, 'utf8');
    return f;
  }
  // A line that slides in from the left (ease-out) after `inAt`, holds, and
  // slides back out (ease-in) at `outAt`.
  function slideX(x0, dist, inAt, outAt) {
    const uin = clampExpr(`(t-${r2(inAt)})/0.38`), uout = clampExpr(`(t-${r2(outAt)})/0.30`);
    return `${x0}-${dist}*(1-(1-pow(1-${uin},3)))-${dist}*pow(${uout},3)`;
  }
  function fadeAlpha(inAt, outAt) {
    return `min(${clampExpr(`(t-${r2(inAt)})/0.22`)},1-${clampExpr(`(t-${r2(outAt + 0.08)})/0.22`)})`;
  }
  function drawtext({ font, file, size, color, box, boxBorder, x, y, alpha, from, to }) {
    return `drawtext=fontfile='${fpath(font)}':textfile='${fpath(file)}':expansion=none:fontsize=${size}:fontcolor=${color}` +
      (box ? `:box=1:boxcolor=${box}:boxborderw=${boxBorder}` : '') + `:x='${x}':y='${y}'` + (alpha ? `:alpha='${alpha}'` : '') +
      (from != null ? `:enable='between(t,${r2(from)},${r2(to == null ? 1e6 : to)})'` : '');
  }
  // Big names shrink to fit: a 26-letter name still sits on one line.
  const fitSize = (text, base, width) => Math.max(Math.round(base * 0.55), Math.min(base, Math.floor(width / Math.max(1, text.length))));

  // The stacked event tag at the top left: event pill / name / over · bowler.
  function tagFilters(p, card, dir, T) {
    const k = p.k, x0 = Math.round(64 * k), y0 = Math.round(54 * k);
    const accent = `0x${ACCENT[card.kind] || ACCENT.HIGHLIGHT}`;
    const outAt = Math.max(TAG_IN + 1.2, Math.min(TAG_IN + TAG_HOLD, T - HALF - 0.5));
    const dist = Math.round(820 * k);
    const label = cleanText(card.label, 18), title = cleanText(card.title, 40), sub = cleanText(card.sub, 72);
    const pillSize = Math.round(42 * k), nameSize = fitSize(title, Math.round(88 * k), Math.round(1100 * k) / 0.42), subSize = Math.round(30 * k);
    const nameY = y0 + Math.round(pillSize * 1.2 + 2 * 13 * k + 6 * k);
    const subY = nameY + Math.round(nameSize * 0.98 + 2 * 15 * k + 6 * k);
    const f = [];
    f.push(drawtext({ font: FONTS.event, file: textFile(dir, 'tag-label', label), size: pillSize, color: 'white', box: `${accent}@1.0`, boxBorder: Math.round(13 * k),
      x: slideX(x0 + Math.round(13 * k), dist, TAG_IN, outAt + 0.10), y: y0 + Math.round(13 * k), alpha: fadeAlpha(TAG_IN, outAt + 0.10), from: TAG_IN, to: outAt + 0.45 }));
    f.push(drawtext({ font: FONTS.display, file: textFile(dir, 'tag-title', title), size: nameSize, color: 'white', box: '0x0b1220@0.92', boxBorder: Math.round(15 * k),
      x: slideX(x0 + Math.round(15 * k), dist, TAG_IN + 0.07, outAt + 0.05), y: nameY, alpha: fadeAlpha(TAG_IN + 0.07, outAt + 0.05), from: TAG_IN + 0.07, to: outAt + 0.4 }));
    if (sub) {
      f.push(drawtext({ font: FONTS.body, file: textFile(dir, 'tag-sub', sub), size: subSize, color: '0xdbe4f0', box: '0x131c30@0.92', boxBorder: Math.round(12 * k),
        x: slideX(x0 + Math.round(12 * k), dist, TAG_IN + 0.14, outAt), y: subY, alpha: fadeAlpha(TAG_IN + 0.14, outAt), from: TAG_IN + 0.14, to: outAt + 0.35 }));
    }
    return f.join(',');
  }

  /* ----------------------------------------------------------- segments */
  // [base][head band][tail band] → the picture with both halves of the wipe.
  function wipeFilters(g, T, headIn, tailIn, baseIn, outLabel, { head = true, tail = true } = {}) {
    const parts = [];
    let cur = baseIn;
    if (head) {
      parts.push(`[${cur}][${headIn}]overlay=x='${bandX(g, `t+${HALF}`)}':y=0:eval=frame:enable='lt(t,${HALF})'[wh]`);
      cur = 'wh';
    }
    if (tail) {
      parts.push(`[${cur}][${tailIn}]overlay=x='${bandX(g, `t-${r2(T - HALF)}`)}':y=0:eval=frame:enable='gte(t,${r2(T - HALF)})'[wt]`);
      cur = 'wt';
    }
    parts.push(`[${cur}]null[${outLabel}]`);
    return parts.join(';');
  }
  // A still image repeated for the length of a segment: decoded and converted
  // to the blend format once (not once per frame — the band is 3000 px wide).
  const loopImg = (inp, fps, label) => `[${inp}]format=yuva420p,loop=loop=-1:size=1:start=0,setpts=N/${fps}/TB[${label}]`;

  // One clip → one segment: scaled to the format, its tag, both wipe halves,
  // the whoosh halves, its own audio faded in and out.
  async function renderClip({ src, info, card, profile: p, assets, out, workDir, onProgress }) {
    const dir = fs.mkdtempSync(path.join(workDir, 'seg-'));
    try {
      const g = bandGeom(p);
      const frames = clipFrames(info, p);
      const T = frames / p.fps;
      const headBand = assets.band[card.kind] || assets.band.HIGHLIGHT;
      const args = ['-threads', String(threads), '-i', src, '-i', headBand, '-i', assets.band.BRAND, '-i', assets.whoosh];
      if (!info.hasAudio) args.push('-f', 'lavfi', '-t', String(r2(T + 0.5)), '-i', 'anullsrc=r=48000:cl=stereo');
      const aIn = info.hasAudio ? '0:a' : '4:a';
      const fit = (info.width === p.w && info.height === p.h) ? 'setsar=1'
        : `scale=${p.w}:${p.h}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${p.w}:${p.h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
      const fc = [
        `[0:v]fps=${p.fps},${fit},format=yuv420p,trim=end_frame=${frames},setpts=PTS-STARTPTS[v0]`,
        loopImg('1:v', p.fps, 'bh'), loopImg('2:v', p.fps, 'bt'),
        `[v0]${tagFilters(p, card, dir, T)}[vt]`,
        wipeFilters(g, T, 'bh', 'bt', 'vt', 'vout'),
        `[${aIn}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:${r2(T)},asetpts=PTS-STARTPTS,afade=t=in:d=0.25,afade=t=out:st=${r2(T - 0.32)}:d=0.32,apad[ca]`,
        `[3:a]asplit=2[w1][w2]`,
        `[w1]atrim=${HALF}:${STING},asetpts=PTS-STARTPTS,apad[wh]`,
        `[w2]atrim=0:${HALF},asetpts=PTS-STARTPTS,adelay=${Math.round((T - HALF) * 1000)}|${Math.round((T - HALF) * 1000)},apad[wt]`,
        `[ca][wh][wt]amix=inputs=3:duration=first:dropout_transition=0,volume=3,atrim=end_sample=${Math.round(T * 48000)}[aout]`
      ].join(';');
      args.push('-filter_complex', fc, '-map', '[vout]', '-map', '[aout]', ...encodeArgs(p), '-frames:v', String(frames), out);
      await run(args, { totalSec: T, onProgress });
      return { duration: T };
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }

  // The blurred picture behind a title / end card.
  async function stillFrom(src, info, p, out, atSec) {
    const at = Math.max(0, Math.min((info && info.duration ? info.duration - 0.2 : 1), atSec));
    await run(['-ss', String(r2(at)), '-i', src, '-frames:v', '1', '-vf',
      `scale=${Math.round(p.w / 4)}:${Math.round(p.h / 4)}:force_original_aspect_ratio=increase,crop=${Math.round(p.w / 4)}:${Math.round(p.h / 4)},boxblur=6:2,scale=${p.w}:${p.h}:flags=bicubic,setsar=1,eq=saturation=0.85`,
      out]);
    return out;
  }

  // Title card: kicker / title / accent bar / pill / meta over the first clip.
  async function renderIntro({ title, bgSrc, bgInfo, profile: p, assets, out, workDir }) {
    const dir = fs.mkdtempSync(path.join(workDir, 'intro-'));
    try {
      const g = bandGeom(p), k = p.k, frames = gridLength(INTRO_SEC, p.fps), T = frames / p.fps;
      const bg = bgSrc ? await stillFrom(bgSrc, bgInfo, p, path.join(dir, 'bg.png'), 1.2) : null;
      const accent = `0x${ACCENT[title.kind] || ACCENT.BRAND}`;
      const x0 = Math.round(110 * k);
      const kicker = cleanText(title.kicker, 60), main = cleanText(title.title, 32), pill = cleanText(title.pill, 28), meta = cleanText(title.meta, 70);
      const mainSize = fitSize(main, Math.round(150 * k), Math.round(1600 * k) / 0.42);
      const yKick = Math.round(p.h * 0.36), yMain = yKick + Math.round(52 * k), yBar = yMain + Math.round(mainSize * 1.02 + 14 * k);
      const yPill = yBar + Math.round(34 * k), yMeta = yPill + Math.round(46 * k + 2 * 14 * k + 18 * k);
      const args = [];
      if (bg) args.push('-i', bg);
      else args.push('-f', 'lavfi', '-i', `color=c=0x0d1526:s=${p.w}x${p.h}`, '-frames:v', '1');
      args.push('-i', assets.shade, '-i', assets.logo, '-i', assets.band.BRAND, '-i', assets.whoosh,
        '-f', 'lavfi', '-t', String(r2(T)), '-i', `color=c=${accent}:s=${Math.round(460 * k)}x${Math.max(4, Math.round(8 * k))}:r=${p.fps}`,
        '-f', 'lavfi', '-t', String(r2(T + 0.5)), '-i', 'anullsrc=r=48000:cl=stereo');
      const logoH = Math.round(104 * k);
      const fc = [
        // a slow push-in on the blurred picture (zoompan on a 2x copy: no stepping)
        `[0:v]scale=${p.w * 2}:${p.h * 2}:flags=bicubic,zoompan=z='1.02+${r2(0.07 / frames * 1000) / 1000}*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${p.w}x${p.h}:fps=${p.fps},setsar=1,format=yuv420p,trim=end_frame=${frames},setpts=PTS-STARTPTS[bg0]`,
        loopImg('1:v', p.fps, 'sh'), `[bg0][sh]overlay=0:0:format=yuv420[bg1]`,
        `[2:v]scale=-2:${logoH},format=rgba,loop=loop=-1:size=1:start=0,setpts=N/${p.fps}/TB,fade=t=in:st=0.15:d=0.4:alpha=1[lg]`,
        `[bg1][lg]overlay=x=${x0}:y=${Math.round(64 * k)}:format=yuv420[bg2]`,
        `[5:v]format=rgba[bar]`,
        `[bg2][bar]overlay=x='${x0}-w+w*(1-pow(1-${clampExpr(`(t-0.55)/0.45`)},3))':y=${yBar}:eval=frame:format=yuv420[bg3]`,
        loopImg('3:v', p.fps, 'bt'),
        `[bg3]` + [
          kicker && drawtext({ font: FONTS.body, file: textFile(dir, 'kicker', kicker), size: Math.round(30 * k), color: accent,
            x: `${x0}`, y: `${yKick}+${Math.round(18 * k)}*(1-${clampExpr('(t-0.2)/0.45')})`, alpha: clampExpr('(t-0.2)/0.35') }),
          drawtext({ font: FONTS.display, file: textFile(dir, 'title', main || 'HIGHLIGHTS'), size: mainSize, color: 'white',
            x: `${x0}-${Math.round(70 * k)}*(1-(1-pow(1-${clampExpr('(t-0.32)/0.5')},3)))`, y: `${yMain}`, alpha: clampExpr('(t-0.32)/0.3') }),
          pill && drawtext({ font: FONTS.event, file: textFile(dir, 'pill', pill), size: Math.round(40 * k), color: 'white', box: `${accent}@1.0`, boxBorder: Math.round(14 * k),
            x: `${x0 + Math.round(14 * k)}-${Math.round(40 * k)}*(1-(1-pow(1-${clampExpr('(t-0.7)/0.4')},3)))`, y: `${yPill + Math.round(14 * k)}`, alpha: clampExpr('(t-0.7)/0.25') }),
          meta && drawtext({ font: FONTS.body, file: textFile(dir, 'meta', meta), size: Math.round(30 * k), color: '0xdbe4f0',
            x: `${x0}`, y: `${yMeta}`, alpha: clampExpr('(t-0.9)/0.35') })
        ].filter(Boolean).join(',') + `[txt]`,
        wipeFilters(g, T, null, 'bt', 'txt', 'vout', { head: false, tail: true }),
        `[6:a]atrim=0:${r2(T)},asetpts=PTS-STARTPTS[sil]`,
        `[4:a]atrim=0:${HALF},asetpts=PTS-STARTPTS,adelay=${Math.round((T - HALF) * 1000)}|${Math.round((T - HALF) * 1000)},apad[wt]`,
        `[sil][wt]amix=inputs=2:duration=first:dropout_transition=0,volume=2,atrim=end_sample=${Math.round(T * 48000)}[aout]`
      ].join(';');
      args.push('-filter_complex', fc, '-map', '[vout]', '-map', '[aout]', ...encodeArgs(p), '-frames:v', String(frames), out);
      await run(args, { totalSec: T });
      return { duration: T };
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }

  // End card: the band clears onto the logo and the website, then black.
  async function renderOutro({ bgSrc, bgInfo, kind, profile: p, assets, out, workDir, site }) {
    const dir = fs.mkdtempSync(path.join(workDir, 'outro-'));
    try {
      const g = bandGeom(p), k = p.k, frames = gridLength(OUTRO_SEC, p.fps), T = frames / p.fps;
      const bg = bgSrc ? await stillFrom(bgSrc, bgInfo, p, path.join(dir, 'bg.png'), Math.max(0, (bgInfo && bgInfo.duration || 2) - 1.5)) : null;
      const args = [];
      if (bg) args.push('-i', bg);
      else args.push('-f', 'lavfi', '-i', `color=c=0x0d1526:s=${p.w}x${p.h}`, '-frames:v', '1');
      args.push('-i', assets.logo, '-i', assets.band[kind] || assets.band.BRAND, '-i', assets.whoosh,
        '-f', 'lavfi', '-t', String(r2(T + 0.5)), '-i', 'anullsrc=r=48000:cl=stereo');
      const siteText = cleanText(site || 'allsportslivestreams.com', 48).toLowerCase();
      const logoMax = Math.round(p.h * 0.30 / 2) * 2;
      const yText = Math.round(p.h / 2 + logoMax / 2 + 40 * k);
      const fc = [
        `[0:v]scale=${p.w}:${p.h},setsar=1,format=yuv420p,eq=brightness=-0.22:saturation=0.6,loop=loop=-1:size=1:start=0,setpts=N/${p.fps}/TB,trim=end_frame=${frames}[bg0]`,
        // the logo rises into place as it fades in
        `[1:v]scale=-2:${logoMax},format=rgba,loop=loop=-1:size=1:start=0,setpts=N/${p.fps}/TB,fade=t=in:st=0.3:d=0.35:alpha=1[lg]`,
        `[bg0][lg]overlay=x='(W-w)/2':y='(H-h)/2-${Math.round(30 * k)}+${Math.round(36 * k)}*pow(1-${clampExpr('(t-0.3)/0.5')},3)':eval=frame:format=yuv420[bg1]`,
        loopImg('2:v', p.fps, 'bh'),
        `[bg1]` + drawtext({ font: FONTS.body, file: textFile(dir, 'site', siteText), size: Math.round(40 * k), color: 'white',
          x: '(w-text_w)/2', y: `${yText}`, alpha: clampExpr('(t-0.55)/0.35') }) + `[txt]`,
        wipeFilters(g, T, 'bh', null, 'txt', 'bw', { head: true, tail: false }),
        `[bw]fade=t=out:st=${r2(T - 0.45)}:d=0.45[vout]`,
        `[4:a]atrim=0:${r2(T)},asetpts=PTS-STARTPTS[sil]`,
        `[3:a]atrim=${HALF}:${STING},asetpts=PTS-STARTPTS,apad[wh]`,
        `[sil][wh]amix=inputs=2:duration=first:dropout_transition=0,volume=2,atrim=end_sample=${Math.round(T * 48000)}[aout]`
      ].join(';');
      args.push('-filter_complex', fc, '-map', '[vout]', '-map', '[aout]', ...encodeArgs(p), '-frames:v', String(frames), out);
      await run(args, { totalSec: T });
      return { duration: T };
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }

  // The finished video: the segments' picture copied as it is, their sound
  // encoded once into one AAC track, the index at the front.
  // segs: [{ file, dur }]. Each segment is cut to exactly its own length: the
  // AAC encoder flushes one frame past the end, which would otherwise push the
  // next segment ~20 ms late and leave a jolt at every join.
  async function concat(segs, out, workDir) {
    const list = path.join(workDir, `concat-${Date.now()}.txt`);
    fs.writeFileSync(list, segs.map(s => `file '${String(s.file).replace(/'/g, "'\\''")}'\nduration ${s.dur.toFixed(6)}\noutpoint ${s.dur.toFixed(6)}`).join('\n'));
    try {
      await run(['-f', 'concat', '-safe', '0', '-i', list, '-map', '0:v', '-map', '0:a', '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-f', 'mp4', out]);
    } finally {
      fs.unlink(list, () => {});
    }
  }

  /* ------------------------------------------------------------- cache */
  const segDir = path.join(cacheDir, 'segments');
  fs.mkdirSync(segDir, { recursive: true });
  function segmentKey(clipKey, card, p) { return sha1({ STYLE, clipKey, card, p: p.key }); }
  const inflight = new Map(); // segment key → the render making it
  function cached(key) {
    const f = path.join(segDir, `${key}.mkv`);
    try { const st = fs.statSync(f); if (st.size > 1024) { const now = new Date(); fs.utimesSync(f, now, now); return f; } } catch (e) { /* not there */ }
    return null;
  }
  // Oldest first out once the cache is over its size, or the disk runs low.
  function freeBytes() { try { const st = fs.statfsSync(segDir); return st.bavail * st.bsize; } catch (e) { return Infinity; } }
  function trimCache() {
    try {
      const now = Date.now();
      const files = fs.readdirSync(segDir).map(n => { const f = path.join(segDir, n); const st = fs.statSync(f); return { f, n, size: st.size, at: st.mtimeMs }; })
        .filter(x => { if (/\.part\.mkv$/.test(x.n) && now - x.at > 3600000) { fs.unlink(x.f, () => {}); return false; } return true; }) // an abandoned half-render
        .sort((a, b) => a.at - b.at);
      let total = files.reduce((n, x) => n + x.size, 0);
      let free = freeBytes();
      for (const x of files) {
        if (total <= cacheMaxBytes && free >= 1024 * 1048576) break;
        fs.unlinkSync(x.f); total -= x.size; free += x.size;
      }
    } catch (e) { /* best effort */ }
  }

  /* ---------------------------------------------------------- the whole */
  // clips: [{ file, clipKey, card }] in play order (files already local).
  // title: { kicker, title, pill, meta, kind }. onProgress(0…1, message).
  async function renderHighlight({ clips, title, out, workDir, site, onProgress = () => {} }) {
    const started = Date.now();
    let reused = 0;
    const infos = await Promise.all(clips.map(c => probe(c.file)));
    const usable = clips.map((c, i) => ({ ...c, info: infos[i] })).filter(c => c.info && c.info.duration > 0.8);
    if (!usable.length) throw new Error('no playable clips');
    const p = pickProfile(usable.map(c => c.info));
    onProgress(0.02, 'Getting the graphics ready…');
    const assets = await ensureAssets(p);
    const segs = [];
    const total = usable.reduce((n, c) => n + c.info.duration, 0) + INTRO_SEC + OUTRO_SEC;
    let done = 0;
    const step = (sec, msg) => (f) => onProgress(Math.min(0.97, 0.04 + 0.92 * (done + sec * f) / total), msg);

    const intro = path.join(workDir, 'intro.mkv');
    const introLen = await renderIntro({ title, bgSrc: usable[0].file, bgInfo: usable[0].info, profile: p, assets, out: intro, workDir });
    done += INTRO_SEC; step(0, 'Title card done')(0);
    segs.push({ file: intro, dur: introLen.duration });

    for (let i = 0; i < usable.length; i++) {
      const c = usable[i];
      const msg = `Editing clip ${i + 1} of ${usable.length} — titles & transitions…`;
      const key = c.clipKey ? segmentKey(c.clipKey, c.card, p) : null;
      let seg = key ? cached(key) : null;
      if (!seg && key && inflight.has(key)) seg = await inflight.get(key).catch(() => null); // another video is making it right now
      if (seg) reused++;
      if (!seg) {
        onProgress(Math.min(0.97, 0.04 + 0.92 * done / total), msg);
        const make = (async () => {
          const target = key ? path.join(segDir, `${key}.${process.pid}-${Date.now()}.part.mkv`) : path.join(workDir, `seg-${i}.mkv`);
          try {
            await renderClip({ src: c.file, info: c.info, card: c.card, profile: p, assets, out: target, workDir, onProgress: step(c.info.duration, msg) });
          } catch (e) { fs.unlink(target, () => {}); throw e; }
          if (!key) return target;
          const final = path.join(segDir, `${key}.mkv`);
          fs.renameSync(target, final);
          return final;
        })();
        if (key) inflight.set(key, make);
        try { seg = await make; } finally { if (key) inflight.delete(key); }
      }
      segs.push({ file: seg, dur: clipFrames(c.info, p) / p.fps });
      done += c.info.duration;
    }

    const outro = path.join(workDir, 'outro.mkv');
    const last = usable[usable.length - 1];
    const outroLen = await renderOutro({ bgSrc: last.file, bgInfo: last.info, kind: 'BRAND', profile: p, assets, out: outro, workDir, site });
    segs.push({ file: outro, dur: outroLen.duration });
    onProgress(0.97, 'Putting the video together…');
    await concat(segs, out, workDir);
    trimCache();
    log(`${usable.length} clip(s) at ${p.key} in ${((Date.now() - started) / 1000).toFixed(1)} s (${reused} from the cache)`);
    onProgress(1, 'Done');
    return { profile: p, included: usable.length, skipped: clips.length - usable.length };
  }

  return { renderHighlight, renderClip, renderIntro, renderOutro, concat, probe, pickProfile, ensureAssets, cardForClip, queueLength: () => queued, STYLE,
    // the frame counts it will use (tests): a clip, and the title / end cards
    framesOf: (info, p) => clipFrames(info, p), cardFrames: (p) => ({ intro: gridLength(INTRO_SEC, p.fps), outro: gridLength(OUTRO_SEC, p.fps) }) };
}

module.exports = { createHighlightEditor, cardForClip, STYLE };
