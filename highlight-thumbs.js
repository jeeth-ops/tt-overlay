/* 🖼️ highlight-thumbs.js — the Highlight Studio's thumbnail designer.
 *
 * Draws a highlight's thumbnail on a canvas, in the browser, from the match's
 * own data (the same verified words and figures as the video's title card —
 * /api/highlights/title), the teams' real logos in their own shape, and — in
 * the photo mode — a real frame of the footage (or a photo the operator
 * uploads). Nothing is invented: no figure that is not in the data, no face,
 * no generated player.
 *
 * Two modes, each with three designs of its own (different layouts, picture
 * places, type, logo places, backgrounds, shapes, colour treatments — not one
 * template recoloured), and every design composed separately for 16:9
 * (1920 x 1080: YouTube, the website) and 9:16 (1080 x 1920: Shorts, Reels):
 *
 *   WITH PLAYER PHOTO   1 Cinematic Player Poster   2 Dynamic Action   3 Premium Broadcast
 *   WITHOUT PLAYER PHOTO 1 Cinematic Stadium        2 Dynamic Cricket Graphic   3 Premium Minimal
 *
 * The photo-free designs draw no person and no silhouette of one: stadium,
 * ground, pitch, stumps, ball, light, type and logos only (and the brand as a
 * word mark — the AllSportsLive badge has figures in it).
 *
 * Every drawing is checked as it is made (render(...).qa): the size; every
 * name, headline and figure drawn whole (never cut, never squashed — shrunk
 * to fit, or flagged); nothing important overlapping or outside the safe
 * area (9:16: the middle 3:4 that profile grids show, clear of the app's
 * buttons; 16:9: clear of YouTube's time stamp); text against its background;
 * every logo drawn at its own proportions; the photo there (or absent in the
 * photo-free mode) and not blown up past its own resolution.
 *
 *   await HighlightThumbs.ready();                         // the fonts
 *   const logo = await HighlightThumbs.prepareLogo(url, 'sticker', '#ffffff');
 *   const { canvas, qa } = HighlightThumbs.render({ mode: 'photo', variation: 1, format: '16:9', data, photo, seed });
 */
(function (root) {
  'use strict';

  const FONT_DIR = '/assets/highlights/fonts/';
  const FAM = { display: 'ASL Display', event: 'ASL Event', body: 'ASL Body' };
  const FONT_FILES = { display: 'BigShoulders-Bold.ttf', event: 'InterDisplay-BlackItalic.otf', body: 'Inter-SemiBold.otf' };
  const BRAND = { deep: '#060b16', navy: '#0b1220', ink: '#0d1526', amber: '#f59e0b', orange: '#f4a23c', teal: '#38b2c1', red: '#d0262a', paper: '#f8fafc' };
  const KIND = { SIX: '#a855f7', FOUR: '#3b82f6', WICKET: '#ef4444', HIGHLIGHT: '#22c55e', BRAND: '#f59e0b' };
  const SIZES = { '16:9': [1920, 1080], '9:16': [1080, 1920] };
  // where what matters must be: 9:16 — the middle 3:4 (what Instagram's grid
  // shows of a reel's cover), inside the side margins; 16:9 — inside the title-safe margins
  const SAFE = { '16:9': { x: 80, y: 54, w: 1760, h: 972 }, '9:16': { x: 64, y: 236, w: 952, h: 1448 } };
  // never under YouTube's time stamp (bottom right of a 16:9 thumbnail)
  const NO_GO = { '16:9': [{ x: 1640, y: 980, w: 280, h: 100, why: "YouTube's time stamp" }], '9:16': [] };

  const VARIATIONS = {
    photo: [
      { n: 1, key: 'poster', name: 'Cinematic Player Poster', blurb: 'The photo full height, the name huge beside it, stadium light' },
      { n: 2, key: 'action', name: 'Dynamic Action', blurb: 'A slanted photo panel, diagonal team-colour slabs, the headline big' },
      { n: 3, key: 'broadcast', name: 'Premium Broadcast', blurb: 'A framed photo, a team identity panel and a figures bar' }
    ],
    graphic: [
      { n: 1, key: 'stadium', name: 'Cinematic Stadium', blurb: 'A floodlit ground at night, the name in the sky, the logo on the field' },
      { n: 2, key: 'pitch', name: 'Dynamic Cricket Graphic', blurb: 'Diagonal panels, the pitch from above, the ball in flight' },
      { n: 3, key: 'minimal', name: 'Premium Minimal', blurb: 'A fine ground plan, the logo at its centre, quiet type' }
    ]
  };
  const MODE_NAME = { photo: 'With player photo', graphic: 'Without player photo' };

  /* ------------------------------------------------------------ helpers */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const HEX = /^#[0-9a-f]{6}$/i;
  function rgb(h) { const x = HEX.test(h || '') ? h : '#f59e0b'; return [parseInt(x.slice(1, 3), 16), parseInt(x.slice(3, 5), 16), parseInt(x.slice(5, 7), 16)]; }
  const hex = (c) => '#' + c.map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => { const A = rgb(a), B = rgb(b); return hex(A.map((v, i) => v + (B[i] - v) * t)); };
  const rgba = (h, a) => { const c = rgb(h); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lumOf = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const lum = (h) => { const c = rgb(h); return lumOf(c[0], c[1], c[2]); };
  const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const satOf = (h) => { const c = rgb(h).map(v => v / 255), mx = Math.max(...c), mn = Math.min(...c); return mx === 0 ? 0 : (mx - mn) / mx; };
  // a team's colour made usable as light on a dark design: too dark → lifted,
  // washed-out grey → the brand's amber instead
  function accentOf(c) {
    if (!HEX.test(c || '')) return BRAND.amber;
    let a = c;
    if (lum(a) < 0.07) a = mix(a, '#ffffff', 0.38);
    if (satOf(a) < 0.18 && lum(a) < 0.6) return BRAND.amber;
    return a;
  }
  function mulberry(seed) { let t = (seed >>> 0) || 1; return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
  const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
  const up = (s) => String(s || '').toUpperCase();

  /* --------------------------------------------------------------- fonts */
  let fontsP = null;
  function ready() {
    if (fontsP) return fontsP;
    if (typeof FontFace === 'undefined' || !document.fonts) { fontsP = Promise.resolve(false); return fontsP; }
    fontsP = Promise.all(Object.keys(FAM).map(k => {
      const f = new FontFace(FAM[k], `url(${FONT_DIR}${FONT_FILES[k]})`);
      return f.load().then(ff => { document.fonts.add(ff); return true; }, () => false);
    })).then(r => r.every(Boolean));
    return fontsP;
  }
  const fontsOk = () => !!(document.fonts && [FAM.display, FAM.event, FAM.body].every(f => document.fonts.check(`40px "${f}"`)));
  const font = (fam, size) => `${Math.round(size)}px "${FAM[fam]}", ${fam === 'body' ? 'system-ui, sans-serif' : 'Impact, sans-serif'}`;

  /* ---------------------------------------------------------------- logos */
  // A logo read once: its own outline cut from a plain white / black ground
  // (an opaque JPEG badge), trimmed to what shows — or, when the picture is
  // its own coloured rectangle, kept whole as a tile. Never stretched later.
  function loadImage(src) {
    return new Promise((res) => {
      if (!src) return res(null);
      const img = new Image();
      if (/^https?:/i.test(src) && !src.startsWith(location.origin)) img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = src;
    });
  }
  function keyGround(px, W, H) {
    const N = W * H;
    if (W < 8 || H < 8) return false;
    const ring = [];
    for (const y of [0, 1, H - 2, H - 1]) for (let x = 0; x < W; x++) ring.push(y * W + x);
    for (let y = 2; y < H - 2; y++) for (const x of [0, 1, W - 2, W - 1]) ring.push(y * W + x);
    const G = [0, 0, 0];
    ring.forEach(i => { G[0] += px[i * 4]; G[1] += px[i * 4 + 1]; G[2] += px[i * 4 + 2]; });
    G[0] /= ring.length; G[1] /= ring.length; G[2] /= ring.length;
    const dist = (i) => { const o = i * 4, a = px[o] - G[0], b = px[o + 1] - G[1], c = px[o + 2] - G[2]; return Math.sqrt(a * a + b * b + c * c); };
    let near = 0, dev = 0;
    ring.forEach(i => { const d = dist(i); if (d < 40) { near++; dev += d * d; } });
    if (near < ring.length * 0.9) return false;
    const black = Math.max(G[0], G[1], G[2]) < 64, white = Math.min(G[0], G[1], G[2]) > 196;
    if (!black && !white) return false;
    const T1 = Math.min(64, Math.max(30, Math.sqrt(dev / near) * 3 + 22)), T2 = T1 + 72;
    const bg = new Uint8Array(N), q = new Int32Array(N);
    let qt = 0;
    const visit = (j) => { if (!bg[j] && dist(j) <= T1) { bg[j] = 1; q[qt++] = j; } };
    ring.forEach(visit);
    for (let qh = 0; qh < qt; qh++) {
      const i = q[qh], x = i % W;
      if (x > 0) visit(i - 1);
      if (x < W - 1) visit(i + 1);
      if (i >= W) visit(i - W);
      if (i < N - W) visit(i + W);
    }
    if (qt < N * 0.04 || qt > N * 0.92) return false;
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      if (bg[i]) { px[o + 3] = 0; continue; }
      const x = i % W;
      if (!((x > 0 && bg[i - 1]) || (x < W - 1 && bg[i + 1]) || (i >= W && bg[i - W]) || (i < N - W && bg[i + W]))) continue;
      const d = dist(i);
      if (d >= T2) continue;
      const a = (d - T1) / (T2 - T1);
      if (a < 0.08) { px[o + 3] = 0; continue; }
      for (let c = 0; c < 3; c++) px[o + c] = clamp(Math.round((px[o + c] - (1 - a) * G[c]) / a), 0, 255);
      px[o + 3] = Math.round(a * 255);
    }
    return true;
  }
  const logoCache = new Map();
  function prepareLogo(src, style, bg) {
    const pref = { style: style === 'circle' ? 'circle' : 'sticker', bg: HEX.test(bg || '') ? bg.toLowerCase() : '#ffffff' };
    if (!src) return Promise.resolve(null);
    if (!logoCache.has(src)) {
      logoCache.set(src, loadImage(src).then(img => {
        if (!img) return null;
        const nw = img.naturalWidth || img.width || 512, nh = img.naturalHeight || img.height || 512;
        const long = Math.max(nw, nh), s = long > 768 ? 768 / long : long < 320 ? 320 / long : 1;
        const W = Math.max(1, Math.round(nw * s)), H = Math.max(1, Math.round(nh * s));
        const work = canvasOf(W, H), x = work.getContext('2d', { willReadFrequently: true });
        x.imageSmoothingQuality = 'high';
        x.drawImage(img, 0, 0, W, H);
        let data;
        try { data = x.getImageData(0, 0, W, H); } catch (e) { return { kind: 'tile', art: work, ar: W / H, tone: 0.5, rf: 1, srcAr: nw / nh }; }
        const px = data.data, N = W * H;
        let clear = 0;
        for (let i = 3; i < px.length; i += 4) if (px[i] < 250) clear++;
        let keyed = false;
        if (clear < N * 0.01) {
          keyed = keyGround(px, W, H);
          if (!keyed) return { kind: 'tile', art: work, ar: W / H, tone: 0.5, rf: 1, srcAr: nw / nh };
        }
        let x0 = W, y0 = H, x1 = -1, y1 = -1, fn = 0, fl = 0;
        for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
          const o = (y * W + xx) * 4, a = px[o + 3];
          if (a > 16) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y; }
          if (a >= 128) { fn++; fl += lumOf(px[o], px[o + 1], px[o + 2]); }
        }
        if (x1 < 0 || !fn) return null;
        if (keyed) x.putImageData(data, 0, 0);
        const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        let R = 0;
        for (let y = y0; y <= y1; y += 2) for (let xx = x0; xx <= x1; xx += 2) { if (px[(y * W + xx) * 4 + 3] > 40) { const d = (xx - cx) * (xx - cx) + (y - cy) * (y - cy); if (d > R) R = d; } }
        const rf = Math.min(1, (Math.sqrt(R) + 1) / (0.5 * Math.sqrt(cw * cw + ch * ch)));
        const art = canvasOf(cw, ch);
        art.getContext('2d').drawImage(work, x0, y0, cw, ch, 0, 0, cw, ch);
        return { kind: 'cut', art, ar: cw / ch, tone: fl / fn, rf, keyed, srcAr: nw / nh };
      }));
    }
    return logoCache.get(src).then(info => info && Object.assign({}, info, pref));
  }
  // the backing a logo is drawn on: its team's chosen colour — unless the logo
  // would vanish on it (a white logo on white), then a deep navy instead
  const backOf = (L) => L && L.tone != null && Math.abs(L.tone - lum(L.bg)) < 0.16 ? (lum(L.bg) > 0.5 ? '#141b2d' : '#ffffff') : L.bg;

  /* --------------------------------------------------------- photo input */
  // An image (a frame, an upload) ready to draw: decoded, with its size.
  function prepareImage(src) {
    return loadImage(src).then(img => img && { img, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height });
  }

  /* ------------------------------------------------------------------ QA */
  function makeQA(S) {
    const items = [], issues = [], passed = [];
    const add = (it) => { items.push(it); return it; };
    const issue = (level, code, msg) => issues.push({ level, code, msg });
    const inside = (r, a) => r.x >= a.x - 0.5 && r.y >= a.y - 0.5 && r.x + r.w <= a.x + a.w + 0.5 && r.y + r.h <= a.y + a.h + 0.5;
    const meet = (a, b, m) => a.x < b.x + b.w - m && b.x < a.x + a.w - m && a.y < b.y + b.h - m && b.y < a.y + a.h - m;
    function finish() {
      const safe = SAFE[S.format], W = S.W, H = S.H;
      if (S.canvas.width !== Math.round(W * S.k) || S.canvas.height !== Math.round(H * S.k)) issue('error', 'size', `the picture is ${S.canvas.width} x ${S.canvas.height}, not ${W} x ${H}`);
      else passed.push(`${W} x ${H} (${S.format})`);
      if (!fontsOk()) issue('error', 'fonts', 'the AllSportsLive fonts did not load - a stand-in font was used');
      const crit = items.filter(i => i.critical);
      crit.forEach(i => {
        if (!inside(i.rect, { x: 0, y: 0, w: W, h: H })) issue('error', 'cut', `${i.name} goes off the picture`);
        else if (!inside(i.rect, { x: safe.x - 8, y: safe.y - 8, w: safe.w + 16, h: safe.h + 16 })) issue('warn', 'safe', `${i.name} is outside the ${S.format === '9:16' ? 'middle 3:4 (cropped in profile grids)' : 'safe margins'}`);
        NO_GO[S.format].forEach(z => { if (meet(i.rect, z, 2)) issue('warn', 'nogo', `${i.name} is under ${z.why}`); });
      });
      for (let a = 0; a < crit.length; a++) for (let b = a + 1; b < crit.length; b++) {
        const A = crit[a], B = crit[b];
        if (A.group && A.group === B.group) continue;
        if (meet(A.rect, B.rect, 3)) issue('error', 'overlap', `${A.name} overlaps ${B.name}`);
      }
      // and never crowded: two blocks one above the other keep clear air between them
      for (let a = 0; a < crit.length; a++) for (let b = a + 1; b < crit.length; b++) {
        const A = crit[a], B = crit[b];
        if ((A.group && A.group === B.group) || A.kind !== 'text' || B.kind !== 'text') continue;
        const xo = Math.min(A.rect.x + A.rect.w, B.rect.x + B.rect.w) - Math.max(A.rect.x, B.rect.x);
        if (xo <= 0 || meet(A.rect, B.rect, 3)) continue;
        const gap = Math.max(B.rect.y - (A.rect.y + A.rect.h), A.rect.y - (B.rect.y + B.rect.h));
        const need = Math.max(14, 0.16 * Math.min(A.rect.h, B.rect.h));
        if (gap >= 0 && gap < need) issue('error', 'crowded', `${A.name} is crowded against ${B.name} (${Math.round(gap)} px apart)`);
      }
      if (!issues.some(i => i.code === 'cut' || i.code === 'overlap' || i.code === 'crowded')) passed.push('nothing important overlaps, crowds or is cut off');
      items.filter(i => i.kind === 'text').forEach(i => {
        if (i.contrast != null && i.contrast < (i.assist ? 2.2 : 3)) issue('warn', 'contrast', `${i.name} is hard to read on its background (contrast ${i.contrast.toFixed(1)}:1)`);
        if (i.shrunk) issue('warn', 'shrunk', `${i.name} was shortened to fit: "${i.drawn}"`);
      });
      if (!issues.some(i => i.code === 'contrast')) passed.push('every text readable on its background');
      items.filter(i => i.kind === 'logo').forEach(i => {
        if (i.arDrawn && i.arOwn && Math.abs(i.arDrawn / i.arOwn - 1) > 0.01) issue('error', 'logo', `${i.name} is not at its own proportions`);
      });
      if (items.some(i => i.kind === 'logo')) passed.push('logos at their own proportions, uncropped');
      if (S.mode === 'photo') {
        const ph = items.find(i => i.kind === 'photo');
        if (!ph) issue('error', 'photo', 'no photo - choose a frame or upload one');
        else if (ph.upscale > 1.6) issue('warn', 'photo-res', `the photo is enlarged ${ph.upscale.toFixed(1)}x past its own resolution (it may look soft) - use a sharper frame or less zoom`);
        else passed.push('the real photo, at its own resolution or better');
      } else {
        if (items.some(i => i.kind === 'photo')) issue('error', 'photo', 'a photo was drawn in the photo-free design');
        else passed.push('no photo, no person, no silhouette');
      }
      return { ok: !issues.some(i => i.level === 'error'), issues, passed, items: items.map(i => ({ name: i.name, kind: i.kind, rect: i.rect, text: i.drawn || null })) };
    }
    return { add, issue, finish, items };
  }

  /* -------------------------------------------------------------- drawing */
  // The context S each design draws with: ctx (in design pixels), W, H,
  // portrait, data, photo, rng, qa, the accent, the brand colours.
  function measure(ctx, text, fam, size, track) {
    ctx.font = font(fam, size);
    const m = ctx.measureText(text);
    const w = m.width + (track ? track * Math.max(0, text.length - 1) : 0);
    const asc = m.actualBoundingBoxAscent || size * 0.74, desc = m.actualBoundingBoxDescent || size * 0.06;
    // the ink's own left edge (big type has side bearings) — for the checks
    const inkL = !track && m.actualBoundingBoxLeft != null ? -m.actualBoundingBoxLeft : 0;
    const inkW = !track && m.actualBoundingBoxRight != null ? m.actualBoundingBoxRight + m.actualBoundingBoxLeft : w;
    return { w, asc, desc, inkL, inkW };
  }
  // the biggest size (≤ max) at which text fits maxW; min reached → shortened with an ellipsis
  function fit(ctx, text, fam, max, min, maxW, track) {
    let size = max;
    let m = measure(ctx, text, fam, size, track ? track * size : 0);
    if (m.w > maxW) { size = Math.max(min, Math.floor(max * maxW / m.w)); m = measure(ctx, text, fam, size, track ? track * size : 0); }
    while (m.w > maxW && size > min) { size -= 2; m = measure(ctx, text, fam, size, track ? track * size : 0); }
    let drawn = text, shrunk = false;
    if (m.w > maxW) {
      shrunk = true;
      while (drawn.length > 1 && measure(ctx, drawn + '\u2026', fam, size, track ? track * size : 0).w > maxW) drawn = drawn.slice(0, -1);
      drawn = drawn.trim() + '\u2026';
      m = measure(ctx, drawn, fam, size, track ? track * size : 0);
    }
    return { size, drawn, shrunk, w: m.w, asc: m.asc, desc: m.desc, inkL: m.inkL, inkW: m.inkW };
  }
  function sampleLum(S, r) {
    const k = S.k, x = Math.max(0, Math.floor(r.x * k)), y = Math.max(0, Math.floor(r.y * k));
    const w = Math.min(S.canvas.width - x, Math.ceil(r.w * k)), h = Math.min(S.canvas.height - y, Math.ceil(r.h * k));
    if (w < 1 || h < 1) return null;
    let d;
    try { d = S.ctx.getImageData(x, y, w, h).data; } catch (e) { return null; }
    const step = Math.max(1, Math.floor((w * h) / 900)) * 4;
    let s = 0, n = 0;
    for (let i = 0; i < d.length; i += step) { s += lumOf(d[i], d[i + 1], d[i + 2]); n++; }
    return n ? s / n : null;
  }
  // Text: { fam, size | fit:{max,min,maxW}, color | fill (gradient fn), align, track (em), shadow, stroke, name, critical, assist, group }
  function text(S, str, x, y, o) {
    const ctx = S.ctx;
    const t = String(str || '');
    if (!t) return null;
    const track = o.track || 0;
    const f = o.fit ? fit(ctx, t, o.fam, o.fit.max, o.fit.min, o.fit.maxW, track) : (() => { const m = measure(ctx, t, o.fam, o.size, track * o.size); return { size: o.size, drawn: t, shrunk: false, w: m.w, asc: m.asc, desc: m.desc, inkL: m.inkL, inkW: m.inkW }; })();
    const tr = track * f.size;
    const ang = o.angle || 0;
    const x0 = ang ? 0 : o.align === 'center' ? x - f.w / 2 : o.align === 'right' ? x - f.w : x;
    let rect = { x: x0 + (f.inkL || 0), y: y - f.asc, w: f.inkW || f.w, h: f.asc + f.desc };
    if (ang) {
      // turned about (x, y): the bounds of the turned box
      const c = Math.cos(ang), sn = Math.sin(ang), L = (f.inkL || 0), R2 = L + (f.inkW || f.w);
      const pts = [[L, -f.asc], [R2, -f.asc], [R2, f.desc], [L, f.desc]].map(([px, py]) => [x + px * c - py * sn, y + px * sn + py * c]);
      const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
      rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    const item = { kind: 'text', name: o.name || `"${t}"`, rect, drawn: f.drawn, shrunk: f.shrunk, critical: o.critical !== false, assist: !!(o.shadow || o.stroke || o.assist), group: o.group };
    const bgL = o.name && o.check !== false ? sampleLum(S, rect) : null;
    ctx.save();
    if (ang) { ctx.translate(x, y); ctx.rotate(ang); y = 0; }
    ctx.font = font(o.fam, f.size);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    const fill = typeof o.fill === 'function' ? o.fill(rect) : (o.color || '#ffffff');
    if (bgL != null) item.contrast = contrast(lum(o.colorForCheck || (typeof o.color === 'string' ? o.color : '#ffffff')), bgL);
    if (o.shadow) { ctx.shadowColor = o.shadow.color || 'rgba(0,0,0,0.55)'; ctx.shadowBlur = o.shadow.blur || 0; ctx.shadowOffsetX = o.shadow.x || 0; ctx.shadowOffsetY = o.shadow.y || 0; }
    const draw = (fn) => {
      if (!tr) { fn(f.drawn, x0); return; }
      let cx = x0;
      for (const ch of f.drawn) { fn(ch, cx); cx += ctx.measureText(ch).width + tr; }
    };
    if (o.stroke) { ctx.lineJoin = 'round'; ctx.strokeStyle = o.stroke.color; ctx.lineWidth = o.stroke.width; draw((c, cx) => ctx.strokeText(c, cx, y)); ctx.shadowColor = 'transparent'; }
    ctx.fillStyle = fill;
    draw((c, cx) => ctx.fillText(c, cx, y));
    ctx.restore();
    if (o.name) S.qa.add(item);
    return Object.assign({ rect, size: f.size }, f);
  }
  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y); ctx.arcTo(x + w, y, x + w, y + h, rr); ctx.arcTo(x + w, y + h, x, y + h, rr); ctx.arcTo(x, y + h, x, y, rr); ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
  function poly(ctx, pts) { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); }
  // the photo, covering `rect` (or the path's bounds), from its focus point,
  // graded for print: a touch more contrast and colour
  function photoIn(S, rect, o) {
    const P = S.photo, ctx = S.ctx;
    if (!P || !P.img) return null;
    const zoom = clamp(Number(P.zoom) || 1, 1, 3);
    const s = Math.max(rect.w / P.w, rect.h / P.h) * zoom;
    const sw = rect.w / s, sh = rect.h / s;
    const fx = clamp(P.focusX == null ? 0.5 : P.focusX, 0, 1), fy = clamp(P.focusY == null ? 0.45 : P.focusY, 0, 1);
    const sx = clamp(fx * P.w - sw / 2, 0, P.w - sw), sy = clamp(fy * P.h - sh / 2, 0, P.h - sh);
    ctx.save();
    if (o && o.clip) { o.clip(); ctx.clip(); }
    if ('filter' in ctx) ctx.filter = (o && o.grade) || 'contrast(1.08) saturate(1.12) brightness(0.97)';
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(P.img, sx, sy, sw, sh, rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
    S.qa.add({ kind: 'photo', name: 'the photo', rect, upscale: s * S.k, critical: false });
    return { s };
  }
  // A team logo inside `box`, whole and at its own proportions, in the team's
  // look: 'circle' — a round badge of its colour with the logo inside; 'sticker'
  // — the logo's own outline on a die-cut backing; a 'tile' logo (its own
  // rectangle) on a rounded card. No logo → the team's initials in its colour.
  function logo(S, L, team, box, o) {
    const ctx = S.ctx, name = (o && o.name) || `the ${(team && (team.short || team.name)) || 'team'} logo`;
    const D = Math.min(box.w, box.h), cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const style = (o && o.style) || (L && L.style) || 'sticker';
    const shadow = (blur, dy, a) => { ctx.shadowColor = `rgba(0,0,0,${a == null ? 0.45 : a})`; ctx.shadowBlur = blur; ctx.shadowOffsetY = dy; };
    let drawn = null;
    ctx.save();
    if (!L) {
      // initials badge (the team's own short name — nothing invented)
      const col = HEX.test((team && team.color) || '') ? team.color : BRAND.navy;
      shadow(D * 0.08, D * 0.03);
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(cx, cy, D / 2, 0, Math.PI * 2); ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = D * 0.035; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.beginPath(); ctx.arc(cx, cy, D / 2 - D * 0.04, 0, Math.PI * 2); ctx.stroke();
      // its short name, or the first letters of its name's words
      const ini = (team && team.short ? up(team.short).replace(/[^A-Z0-9]/g, '') : up((team && team.name) || '').split(/\s+/).map(w => w.replace(/[^A-Z0-9]/g, '')[0] || '').join('')).slice(0, 4) || '?';
      const f = fit(ctx, ini, 'display', D * 0.46, D * 0.2, D * 0.74, 0);
      ctx.font = font('display', f.size); ctx.fillStyle = lum(col) > 0.45 ? BRAND.navy : '#ffffff';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(f.drawn, cx - f.w / 2, cy + f.asc / 2 - f.desc / 2);
      ctx.restore();
      S.qa.add({ kind: 'logo', name, rect: { x: cx - D / 2, y: cy - D / 2, w: D, h: D }, critical: true, group: o && o.group });
      S.qa.issue('info', 'no-logo', `${(team && team.name) || 'A team'} has no logo - its initials are shown`);
      return { x: cx - D / 2, y: cy - D / 2, w: D, h: D };
    }
    const art = L.art, ar = art.width / art.height;
    if (style === 'circle') {
      const back = backOf(L);
      shadow(D * 0.07, D * 0.03);
      ctx.fillStyle = back; ctx.beginPath(); ctx.arc(cx, cy, D / 2, 0, Math.PI * 2); ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.lineWidth = Math.max(2, D * 0.014); ctx.strokeStyle = lum(back) > 0.5 ? 'rgba(15,23,42,0.18)' : 'rgba(255,255,255,0.35)';
      ctx.beginPath(); ctx.arc(cx, cy, D / 2 - ctx.lineWidth / 2, 0, Math.PI * 2); ctx.stroke();
      // the logo whole inside the circle: its farthest point within the rim
      const half = 0.5 * Math.hypot(ar, 1);
      const reach = (L.kind === 'cut' ? L.rf : 1) * half;
      const h = (D * 0.4) / reach, w = h * ar;
      drawn = { x: cx - w / 2, y: cy - h / 2, w, h };
      ctx.drawImage(art, drawn.x, drawn.y, drawn.w, drawn.h);
    } else if (L.kind === 'tile') {
      const fitS = Math.min(box.w / ar, box.h);
      const h = fitS, w = h * ar;
      drawn = { x: cx - w / 2, y: cy - h / 2, w, h };
      shadow(D * 0.06, D * 0.025);
      roundRect(ctx, drawn.x, drawn.y, w, h, Math.min(w, h) * 0.1);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.save(); roundRect(ctx, drawn.x, drawn.y, w, h, Math.min(w, h) * 0.1); ctx.clip();
      ctx.drawImage(art, drawn.x, drawn.y, w, h); ctx.restore();
    } else {
      // die-cut sticker: the outline grown evenly all round, the team's colour
      const pad = 0.07;
      const inner = { w: box.w / (1 + 2 * pad), h: box.h / (1 + 2 * pad) };
      const h = Math.min(inner.h, inner.w / ar), w = h * ar;
      drawn = { x: cx - w / 2, y: cy - h / 2, w, h };
      const r = Math.max(w, h) * 0.05;
      const sil = canvasOf(w * S.k + 2, h * S.k + 2), sg = sil.getContext('2d');
      sg.drawImage(art, 0, 0, sil.width, sil.height); sg.globalCompositeOperation = 'source-in'; sg.fillStyle = backOf(L); sg.fillRect(0, 0, sil.width, sil.height);
      const lay = canvasOf((w + 4 * r) * S.k, (h + 4 * r) * S.k), lg = lay.getContext('2d');
      const ox = 2 * r * S.k, oy = 2 * r * S.k;
      for (let i = 0; i < 28; i++) { const t = i / 28 * Math.PI * 2; for (const f of [1, 0.55]) lg.drawImage(sil, ox + Math.cos(t) * r * S.k * f, oy + Math.sin(t) * r * S.k * f, w * S.k, h * S.k); }
      lg.drawImage(sil, ox, oy, w * S.k, h * S.k);
      shadow(Math.max(w, h) * 0.06, Math.max(w, h) * 0.03, 0.5);
      ctx.drawImage(lay, drawn.x - 2 * r, drawn.y - 2 * r, w + 4 * r, h + 4 * r);
      ctx.shadowColor = 'transparent';
      ctx.drawImage(art, drawn.x, drawn.y, w, h);
    }
    ctx.restore();
    S.qa.add({ kind: 'logo', name, rect: style === 'circle' ? { x: cx - D / 2, y: cy - D / 2, w: D, h: D } : drawn, arDrawn: drawn.w / drawn.h, arOwn: ar, critical: true, group: o && o.group });
    return drawn;
  }
  // The brand as a word mark: ALL (orange) SPORTS (teal) LIVE (red), as on the badge.
  function wordmark(S, x, y, size, o) {
    const ctx = S.ctx, parts = [['ALL ', BRAND.orange], ['SPORTS ', BRAND.teal], ['LIVE', o && o.onLight ? BRAND.red : '#ff4d4f']];
    ctx.save();
    ctx.font = font('display', size);
    const widths = parts.map(p => ctx.measureText(p[0]).width + size * 0.04 * p[0].length);
    const total = widths.reduce((a, b) => a + b, 0);
    let cx = o && o.align === 'center' ? x - total / 2 : o && o.align === 'right' ? x - total : x;
    const x0 = cx;
    if (o && o.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = size * 0.3; }
    parts.forEach((p, i) => {
      ctx.fillStyle = p[1];
      let px = cx;
      for (const ch of p[0]) { ctx.fillText(ch, px, y); px += ctx.measureText(ch).width + size * 0.04; }
      cx += widths[i];
    });
    ctx.restore();
    S.qa.add({ kind: 'brand', name: 'the AllSportsLive mark', rect: { x: x0, y: y - size * 0.74, w: total, h: size * 0.8 }, critical: false });
  }
  function grain(S, alpha) {
    const ctx = S.ctx;
    if (!grain.tile) {
      const c = canvasOf(220, 220), g = c.getContext('2d'), d = g.createImageData(220, 220), r = mulberry(7);
      for (let i = 0; i < d.data.length; i += 4) { const v = 110 + r() * 145; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
      g.putImageData(d, 0, 0);
      grain.tile = c;
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = ctx.createPattern(grain.tile, 'repeat');
    ctx.fillRect(0, 0, S.W, S.H);
    ctx.restore();
  }
  function vignette(S, a, inner) {
    const ctx = S.ctx, g = ctx.createRadialGradient(S.W / 2, S.H / 2, Math.min(S.W, S.H) * (inner || 0.35), S.W / 2, S.H / 2, Math.hypot(S.W, S.H) * 0.62);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${a})`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, S.W, S.H);
  }
  function glow(S, x, y, r, color, a) {
    const ctx = S.ctx, g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(color, a)); g.addColorStop(0.45, rgba(color, a * 0.35)); g.addColorStop(1, rgba(color, 0));
    ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r); ctx.restore();
  }
  // verified figures as cells: { value, label, sub }
  function statsRow(S, stats, x, y, o) {
    const ctx = S.ctx, list = (stats || []).slice(0, o.max || 3);
    if (!list.length) return null;
    const gap = o.gap || 44, vs = o.valueSize || 84, ls = o.labelSize || 22;
    const labelOf = (c) => up(c.label) + (c.sub ? ' \u00b7 ' + up(c.sub) : '');
    const widths = list.map(c => Math.max(measure(ctx, String(c.value), 'display', vs, 0).w, measure(ctx, labelOf(c), 'body', ls * (c.sub ? 0.86 : 1), ls * (c.sub ? 0.86 : 1) * 0.14).w));
    const total = widths.reduce((a, b) => a + b, 0) + gap * 2 * (list.length - 1);
    const scale = o.maxW && total > o.maxW ? o.maxW / total : 1;
    let cx = o.align === 'center' ? x - total * scale / 2 : x;
    list.forEach((c, i) => {
      const w = widths[i] * scale;
      if (o.chip) {
        ctx.save();
        roundRect(ctx, cx - 22 * scale, y - vs * 0.82 * scale - 18, w + 44 * scale, vs * 0.82 * scale + ls * 1.9 + 30, 16);
        ctx.fillStyle = o.chip; ctx.fill();
        if (o.chipLine) { ctx.strokeStyle = o.chipLine; ctx.lineWidth = 2; ctx.stroke(); }
        ctx.restore();
      }
      text(S, String(c.value), cx, y, { fam: 'display', size: vs * scale, color: o.valueColor || '#ffffff', name: `the figure ${c.value} ${c.label}`, group: 'stat' + i, shadow: o.shadow });
      text(S, labelOf(c), cx, y + ls * 1.55, { fam: 'body', size: ls * scale * (c.sub ? 0.86 : 1), track: 0.14, color: o.labelColor || '#94a3b8', name: `the label ${c.label}`, group: 'stat' + i, check: false });
      if (o.rules && i < list.length - 1) {
        ctx.save(); ctx.fillStyle = o.rules; ctx.fillRect(cx + w + gap * scale - 1, y - vs * 0.72 * scale, 2, vs * 0.72 * scale + ls * 1.7); ctx.restore();
      }
      cx += w + gap * 2 * scale;
    });
    return { w: total * scale };
  }
  function bandName(S, N, fam, max, maxW) {
    const full = [N.first, N.last].filter(Boolean).join(' ');
    const tries = [full, N.first ? `${N.first[0]}. ${N.last}` : null, N.last].filter(Boolean);
    for (const t of tries) { const f = fit(S.ctx, t, fam, max, max * 0.62, maxW, 0); if (!f.shrunk && f.size >= max * 0.62) { if (t !== full) S.qa.issue('info', 'name-short', `the name is shown as "${t}" to fit the band`); return t; } }
    return tries[tries.length - 1];
  }
  const splitCount = (h) => { const m = /^(\d+)\s+(.+)$/.exec(String(h || '').trim()); return m ? { num: m[1], word: m[2] } : null; };
  // the name as the design shows it: first (small) and last (big); a team or a match: one line
  const nameOf = (d) => ({ first: up(d.first || ''), last: up(d.last || d.title || '') });
  const teamsOf = (d) => (d.teams || []).filter(Boolean).slice(0, 2);
  const lineOf = (d) => [d.line, d.venue].filter(Boolean).join('  \u00b7  ');

  /* ============================================================ MODE A */
  const designs = { photo: {}, graphic: {} };

  // 1 — Cinematic Player Poster: the photo full height on the right, graded,
  // stadium light in the team's colour, the name huge in a column on the left.
  designs.photo.poster = function (S) {
    const { ctx, W, H, data: d } = S, A = S.accent, N = nameOf(d), teams = teamsOf(d);
    ctx.fillStyle = BRAND.deep; ctx.fillRect(0, 0, W, H);
    if (!S.portrait) {
      photoIn(S, { x: 560, y: 0, w: 1360, h: 1080 }, { grade: 'contrast(1.12) saturate(1.1) brightness(0.92)' });
      let g = ctx.createLinearGradient(560, 0, 1180, 0);
      g.addColorStop(0, rgba(BRAND.deep, 1)); g.addColorStop(0.55, rgba(BRAND.deep, 0.55)); g.addColorStop(1, rgba(BRAND.deep, 0));
      ctx.fillStyle = g; ctx.fillRect(560, 0, 640, H);
      g = ctx.createLinearGradient(0, 700, 0, H); g.addColorStop(0, rgba(BRAND.deep, 0)); g.addColorStop(1, rgba(BRAND.deep, 0.92));
      ctx.fillStyle = g; ctx.fillRect(0, 700, W, H - 700);
      glow(S, 1560 + S.rng() * 200, 120, 900, A, 0.34);
      glow(S, 260, 940, 620, A, 0.18);
      grain(S, 0.07); vignette(S, 0.55, 0.4);
      const x0 = 110;
      ctx.fillStyle = A; ctx.fillRect(x0, 128, 8, 46);
      text(S, up(d.kicker), x0 + 28, 166, { fam: 'body', fit: { max: 30, min: 20, maxW: 820 }, track: 0.18, color: '#cbd5e1', name: 'the tournament', critical: false });
      let y = 236;
      if (N.first) { const t = text(S, N.first, x0, y + 70, { fam: 'display', fit: { max: 92, min: 60, maxW: 860 }, track: 0.04, color: 'rgba(255,255,255,0.88)', colorForCheck: '#e2e8f0', name: 'the first name' }); y = t.rect.y + t.rect.h + 18; }
      const last = text(S, N.last, x0 - 6, y + 222, { fam: 'display', fit: { max: 240, min: 110, maxW: 880 }, color: '#ffffff', name: 'the name', shadow: { color: 'rgba(0,0,0,0.6)', blur: 30, y: 8 } });
      y = last.rect.y + last.rect.h;
      const hl = text(S, up(d.headline), x0, y + 104, { fam: 'event', fit: { max: 84, min: 40, maxW: 860 }, name: 'the headline', colorForCheck: BRAND.amber,
        fill: (r) => { const gg = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0); gg.addColorStop(0, BRAND.amber); gg.addColorStop(1, BRAND.orange); return gg; }, shadow: { color: 'rgba(0,0,0,0.5)', blur: 18, y: 4 } });
      y = hl.rect.y + hl.rect.h;
      statsRow(S, d.stats, x0, Math.min(y + 116, 790), { max: 3, valueSize: 80, labelSize: 20, gap: 40, rules: 'rgba(255,255,255,0.22)', maxW: 860 });
      // the team(s) and the match, at the foot
      if (teams.length === 2) {
        logo(S, teams[0].logo, teams[0], { x: x0, y: 860, w: 130, h: 130 }, { group: 'foot' });
        logo(S, teams[1].logo, teams[1], { x: x0 + 150, y: 860, w: 130, h: 130 }, { group: 'foot' });
        text(S, lineOf(d), x0 + 310, 940, { fam: 'body', fit: { max: 28, min: 18, maxW: 560 }, color: '#cbd5e1', name: 'the match', critical: false });
      } else {
        if (teams[0]) logo(S, teams[0].logo, teams[0], { x: x0, y: 856, w: 140, h: 140 });
        text(S, up(teams[0] ? teams[0].name : ''), x0 + 170, 910, { fam: 'body', fit: { max: 30, min: 18, maxW: 600 }, track: 0.12, color: '#ffffff', name: 'the team name' });
        text(S, lineOf(d), x0 + 170, 958, { fam: 'body', fit: { max: 26, min: 16, maxW: 640 }, color: '#94a3b8', name: 'the match', critical: false });
      }
      wordmark(S, 1820, 104, 44, { align: 'right', shadow: true });
    } else {
      photoIn(S, { x: 0, y: 0, w: 1080, h: 1260 }, { grade: 'contrast(1.12) saturate(1.1) brightness(0.93)' });
      let g = ctx.createLinearGradient(0, 760, 0, 1270); g.addColorStop(0, rgba(BRAND.deep, 0)); g.addColorStop(0.7, rgba(BRAND.deep, 0.85)); g.addColorStop(1, rgba(BRAND.deep, 1));
      ctx.fillStyle = g; ctx.fillRect(0, 760, W, 520);
      g = ctx.createLinearGradient(0, 0, 0, 300); g.addColorStop(0, rgba(BRAND.deep, 0.75)); g.addColorStop(1, rgba(BRAND.deep, 0));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, 300);
      glow(S, 900, 140, 760, A, 0.3); glow(S, 120, 1500, 700, A, 0.16);
      grain(S, 0.07); vignette(S, 0.5, 0.45);
      wordmark(S, 64, 128, 46, { shadow: true });
      text(S, up(d.kicker), 64, 182, { fam: 'body', fit: { max: 26, min: 18, maxW: 952 }, track: 0.16, color: '#e2e8f0', name: 'the tournament', critical: false, shadow: { blur: 10 } });
      if (teams.length === 2) {
        logo(S, teams[0].logo, teams[0], { x: 64, y: 1010, w: 150, h: 150 }, { group: 'head' });
        logo(S, teams[1].logo, teams[1], { x: 234, y: 1010, w: 150, h: 150 }, { group: 'head' });
      } else if (teams[0]) logo(S, teams[0].logo, teams[0], { x: 64, y: 1000, w: 170, h: 170 });
      let y = 1196;
      if (N.first) { const t = text(S, N.first, 64, y + 60, { fam: 'display', fit: { max: 84, min: 54, maxW: 952 }, track: 0.04, color: '#e2e8f0', name: 'the first name' }); y = t.rect.y + t.rect.h + 10; }
      const last = text(S, N.last, 58, y + 196, { fam: 'display', fit: { max: 214, min: 100, maxW: 952 }, color: '#ffffff', name: 'the name', shadow: { color: 'rgba(0,0,0,0.6)', blur: 26, y: 6 } });
      y = last.rect.y + last.rect.h;
      const hl = text(S, up(d.headline), 64, y + 84, { fam: 'event', fit: { max: 66, min: 36, maxW: 952 }, name: 'the headline', colorForCheck: BRAND.amber,
        fill: (r) => { const gg = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0); gg.addColorStop(0, BRAND.amber); gg.addColorStop(1, BRAND.orange); return gg; } });
      y = hl.rect.y + hl.rect.h;
      statsRow(S, d.stats, 64, Math.min(y + 104, 1640), { max: 3, valueSize: 70, labelSize: 19, gap: 34, rules: 'rgba(255,255,255,0.22)', maxW: 952 });
      text(S, lineOf(d), 64, 1792, { fam: 'body', fit: { max: 26, min: 16, maxW: 952 }, color: '#94a3b8', name: 'the match', critical: false });
    }
  };

  // 2 — Dynamic Action: a slanted photo panel, diagonal slabs in the team's
  // colour, speed lines, the headline as a giant figure, the name on a band.
  designs.photo.action = function (S) {
    const { ctx, W, H, data: d, rng } = S, A = S.accent, N = nameOf(d), teams = teamsOf(d);
    const deepA = mix(A, BRAND.deep, 0.72);
    ctx.fillStyle = BRAND.ink; ctx.fillRect(0, 0, W, H);
    // fine diagonal hatching across the whole ground
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.045)'; ctx.lineWidth = 2;
    for (let i = -H; i < W + H; i += 26) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i - H * 0.45, H); ctx.stroke(); }
    ctx.restore();
    const nameLine = [N.first, N.last].filter(Boolean).join(' ');
    const cnt = splitCount(up(d.headline));
    if (!S.portrait) {
      // the colour slab, then the photo in its slanted panel
      let g = ctx.createLinearGradient(0, 0, 980, 1080); g.addColorStop(0, A); g.addColorStop(1, deepA);
      ctx.fillStyle = g; poly(ctx, [[0, 0], [960, 0], [640, 1080], [0, 1080]]); ctx.fill();
      ctx.save(); poly(ctx, [[0, 0], [960, 0], [640, 1080], [0, 1080]]); ctx.clip();
      for (let yy = 0; yy < H; yy += 22) for (let xx = (yy / 22) % 2 ? 11 : 0; xx < 980; xx += 22) {
        const r = 3.2 * (1 - xx / 980); if (r < 0.4) continue;
        ctx.fillStyle = 'rgba(255,255,255,0.13)'; ctx.beginPath(); ctx.arc(xx, yy, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      const panel = [[820, 0], [1920, 0], [1920, 1080], [500, 1080]];
      photoIn(S, { x: 500, y: 0, w: 1420, h: 1080 }, { clip: () => poly(ctx, panel), grade: 'contrast(1.16) saturate(1.18) brightness(0.95)' });
      g = ctx.createLinearGradient(0, 760, 0, 1080); g.addColorStop(0, 'rgba(6,11,22,0)'); g.addColorStop(1, 'rgba(6,11,22,0.7)');
      ctx.save(); poly(ctx, panel); ctx.clip(); ctx.fillStyle = g; ctx.fillRect(500, 760, 1420, 320); ctx.restore();
      // the edge: white, with a parallel line of the accent and speed lines
      ctx.save(); ctx.lineCap = 'butt';
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 12; ctx.beginPath(); ctx.moveTo(820, 0); ctx.lineTo(500, 1080); ctx.stroke();
      ctx.strokeStyle = A; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(862, 0); ctx.lineTo(542, 1080); ctx.stroke();
      // speed streaks running with the edge, just inside the photo
      const ex = -320 / Math.hypot(320, 1080), ey = 1080 / Math.hypot(320, 1080);
      for (let i = 0; i < 7; i++) {
        const along = 80 + rng() * 820, off = 34 + i * 16 + rng() * 10, len = 120 + rng() * 220;
        const sx = 820 + ex * along + off, sy = ey * along;
        const sg = ctx.createLinearGradient(sx, sy, sx + ex * len, sy + ey * len);
        sg.addColorStop(0, 'rgba(255,255,255,0)'); sg.addColorStop(0.5, `rgba(255,255,255,${0.25 + rng() * 0.3})`); sg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.strokeStyle = sg; ctx.lineWidth = 2 + rng() * 2;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + ex * len, sy + ey * len); ctx.stroke();
      }
      ctx.restore();
      grain(S, 0.06);
      // the brand and the tournament, top left; the logo(s)
      if (teams.length === 2) {
        logo(S, teams[0].logo, teams[0], { x: 96, y: 64, w: 120, h: 120 }, { group: 'top' });
        logo(S, teams[1].logo, teams[1], { x: 232, y: 64, w: 120, h: 120 }, { group: 'top' });
      } else if (teams[0]) logo(S, teams[0].logo, teams[0], { x: 96, y: 60, w: 140, h: 140 });
      text(S, up(d.kicker), teams.length === 2 ? 376 : 262, 140, { fam: 'body', fit: { max: 26, min: 16, maxW: 460 }, track: 0.14, color: '#ffffff', colorForCheck: '#ffffff', name: 'the tournament', critical: false, shadow: { blur: 8 } });
      // the headline: a giant figure and its word — or the words, big
      if (cnt) {
        const n = text(S, cnt.num, 92, 560, { fam: 'event', fit: { max: 380, min: 200, maxW: 420 }, color: '#ffffff', name: 'the headline figure', shadow: { color: 'rgba(0,0,0,0.35)', blur: 30, y: 10 }, group: 'hl' });
        // (on the slab: its edge is at x 960 - 320 y / 1080)
        text(S, cnt.word, 92 + n.w + 28, 540, { fam: 'event', fit: { max: 132, min: 56, maxW: Math.max(160, 960 - 320 * 540 / 1080 - 40 - (92 + n.w + 28)) }, color: '#ffffff', name: 'the headline', shadow: { color: 'rgba(0,0,0,0.35)', blur: 20, y: 6 }, group: 'hl' });
      } else {
        const words = up(d.headline).split(/\s+/);
        const cut = Math.ceil(words.length / 2);
        text(S, words.slice(0, cut).join(' '), 92, 380, { fam: 'event', fit: { max: 150, min: 60, maxW: 680 }, color: '#ffffff', name: 'the headline', shadow: { color: 'rgba(0,0,0,0.35)', blur: 20, y: 6 }, group: 'hl' });
        if (words.length > 1) text(S, words.slice(cut).join(' '), 92, 540, { fam: 'event', fit: { max: 150, min: 60, maxW: 620 }, color: '#ffffff', name: 'the headline (2nd line)', shadow: { color: 'rgba(0,0,0,0.35)', blur: 20, y: 6 }, group: 'hl' });
      }
      // the name band, slanted, crossing onto the photo
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = 10;
      ctx.fillStyle = '#ffffff'; poly(ctx, [[0, 640], [1180, 640], [1140, 786], [0, 786]]); ctx.fill(); ctx.restore();
      ctx.fillStyle = A; poly(ctx, [[0, 786], [1140, 786], [1132, 812], [0, 812]]); ctx.fill();
      text(S, bandName(S, N, 'display', 124, 1000), 96, 752, { fam: 'display', fit: { max: 124, min: 60, maxW: 1000 }, color: BRAND.navy, name: 'the name' });
      statsRow(S, d.stats, 116, 932, { max: 3, valueSize: 64, labelSize: 18, gap: 46, chip: 'rgba(6,11,22,0.78)', chipLine: rgba(A, 0.9), maxW: 1180 });
      wordmark(S, 1824, 96, 42, { align: 'right', shadow: true });
    } else {
      let g = ctx.createLinearGradient(0, 1100, 1080, 1500); g.addColorStop(0, A); g.addColorStop(1, deepA);
      ctx.fillStyle = g; poly(ctx, [[0, 1240], [1080, 1080], [1080, 1920], [0, 1920]]); ctx.fill();
      ctx.save(); poly(ctx, [[0, 1240], [1080, 1080], [1080, 1920], [0, 1920]]); ctx.clip();
      for (let yy = 1080; yy < H; yy += 22) for (let xx = (yy / 22) % 2 ? 11 : 0; xx < W; xx += 22) {
        const r = 3 * (yy - 1080) / 840; if (r < 0.4) continue;
        ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.beginPath(); ctx.arc(xx, yy, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      const panel = [[0, 330], [1080, 200], [1080, 1080], [0, 1240]];
      photoIn(S, { x: 0, y: 200, w: 1080, h: 1040 }, { clip: () => poly(ctx, panel), grade: 'contrast(1.16) saturate(1.18) brightness(0.95)' });
      ctx.save(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 12;
      ctx.beginPath(); ctx.moveTo(0, 330); ctx.lineTo(1080, 200); ctx.stroke();
      ctx.strokeStyle = A; ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(0, 296); ctx.lineTo(1080, 166); ctx.stroke();
      for (let i = 0; i < 8; i++) {
        const x0 = rng() * 900, y0 = 300 - x0 * 0.12 + 30 + rng() * 60, len = 80 + rng() * 200;
        ctx.strokeStyle = `rgba(255,255,255,${0.2 + rng() * 0.35})`; ctx.lineWidth = 2 + rng() * 2;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + len, y0 - len * 0.12); ctx.stroke();
      }
      ctx.restore();
      grain(S, 0.06);
      wordmark(S, 64, 120, 44, { shadow: true });
      text(S, up(d.kicker), 64, 172, { fam: 'body', fit: { max: 24, min: 16, maxW: 952 }, track: 0.14, color: '#cbd5e1', name: 'the tournament', critical: false });
      if (teams.length === 2) {
        logo(S, teams[0].logo, teams[0], { x: 726, y: 256, w: 140, h: 140 }, { group: 'top' });
        logo(S, teams[1].logo, teams[1], { x: 876, y: 256, w: 140, h: 140 }, { group: 'top' });
      } else if (teams[0]) logo(S, teams[0].logo, teams[0], { x: 836, y: 250, w: 170, h: 170 });
      // the name band across the photo's foot
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 26; ctx.shadowOffsetY = 8;
      ctx.fillStyle = '#ffffff'; poly(ctx, [[0, 1130], [1080, 1036], [1080, 1170], [0, 1264]]); ctx.fill(); ctx.restore();
      text(S, bandName(S, N, 'display', 112, 900), 72, 1222, { fam: 'display', fit: { max: 112, min: 56, maxW: 900 }, color: BRAND.navy, name: 'the name', angle: Math.atan2(-94, 1080) });
      if (cnt) {
        const n = text(S, cnt.num, 76, 1530, { fam: 'event', fit: { max: 300, min: 160, maxW: 380 }, color: '#ffffff', name: 'the headline figure', shadow: { color: 'rgba(0,0,0,0.35)', blur: 26, y: 8 }, group: 'hl' });
        text(S, cnt.word, 76 + n.w + 24, 1500, { fam: 'event', fit: { max: 120, min: 50, maxW: 952 - n.w - 24 }, color: '#ffffff', name: 'the headline', shadow: { color: 'rgba(0,0,0,0.35)', blur: 18, y: 6 }, group: 'hl' });
      } else {
        text(S, up(d.headline), 76, 1460, { fam: 'event', fit: { max: 120, min: 50, maxW: 930 }, color: '#ffffff', name: 'the headline', shadow: { color: 'rgba(0,0,0,0.35)', blur: 18, y: 6 } });
      }
      statsRow(S, d.stats, 82, 1632, { max: 3, valueSize: 56, labelSize: 17, gap: 40, chip: 'rgba(6,11,22,0.78)', chipLine: rgba(A, 0.9), maxW: 900 });
      text(S, lineOf(d), 64, 1800, { fam: 'body', fit: { max: 24, min: 16, maxW: 952 }, color: '#e2e8f0', name: 'the match', critical: false });
    }
  };

  // 3 — Premium Broadcast: a framed photo, a team identity panel, a figures bar.
  designs.photo.broadcast = function (S) {
    const { ctx, W, H, data: d } = S, A = S.accent, N = nameOf(d), teams = teamsOf(d);
    let g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#0e1a33'); g.addColorStop(1, '#060b16');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.035)'; ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 48) { ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 48) { ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke(); }
    ctx.restore();
    const frame = (r) => {
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 50; ctx.shadowOffsetY = 18;
      roundRect(ctx, r.x, r.y, r.w, r.h, 28); ctx.fillStyle = '#0b1220'; ctx.fill(); ctx.restore();
      photoIn(S, r, { clip: () => roundRect(ctx, r.x, r.y, r.w, r.h, 28), grade: 'contrast(1.06) saturate(1.06)' });
      const gg = ctx.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h); gg.addColorStop(0, A); gg.addColorStop(0.5, 'rgba(255,255,255,0.7)'); gg.addColorStop(1, A);
      ctx.save(); roundRect(ctx, r.x, r.y, r.w, r.h, 28); ctx.strokeStyle = gg; ctx.lineWidth = 5; ctx.stroke(); ctx.restore();
    };
    const panelFill = (r) => {
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 14;
      const pg = ctx.createLinearGradient(r.x, r.y, r.x + r.w * 0.6, r.y + r.h); pg.addColorStop(0, mix(A, '#ffffff', 0.08)); pg.addColorStop(1, mix(A, BRAND.deep, 0.62));
      roundRect(ctx, r.x, r.y, r.w, r.h, 28); ctx.fillStyle = pg; ctx.fill(); ctx.restore();
      ctx.save(); roundRect(ctx, r.x, r.y, r.w, r.h, 28); ctx.clip();
      const sh = ctx.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h * 0.6); sh.addColorStop(0, 'rgba(255,255,255,0.16)'); sh.addColorStop(0.4, 'rgba(255,255,255,0)');
      ctx.fillStyle = sh; ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = 'rgba(0,0,0,0.18)'; poly(ctx, [[r.x + r.w * 0.55, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x + r.w * 0.25, r.y + r.h]]); ctx.fill();
      ctx.restore();
    };
    const bar = (r) => {
      ctx.save(); roundRect(ctx, r.x, r.y, r.w, r.h, 20); ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
      ctx.fillStyle = A; ctx.fillRect(r.x + 28, r.y, 120, 5);
    };
    const pillText = (str, x, y, size, maxW) => {
      const f = fit(ctx, up(str), 'event', size, size * 0.6, maxW - 48, 0);
      ctx.save(); roundRect(ctx, x, y - f.asc - 18, f.w + 48, f.asc + f.desc + 36, (f.asc + 36) / 2); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.restore();
      text(S, f.drawn, x + 24, y, { fam: 'event', size: f.size, color: BRAND.navy, name: 'the headline' });
    };
    if (!S.portrait) {
      frame({ x: 80, y: 72, w: 1090, h: 768 });
      g = ctx.createLinearGradient(0, 640, 0, 840); g.addColorStop(0, 'rgba(6,11,22,0)'); g.addColorStop(1, 'rgba(6,11,22,0.85)');
      ctx.save(); roundRect(ctx, 80, 72, 1090, 768, 28); ctx.clip(); ctx.fillStyle = g; ctx.fillRect(80, 640, 1090, 200); ctx.restore();
      // the tournament chip, on the photo
      const kf = fit(ctx, up(d.kicker), 'body', 24, 16, 760, 0.12);
      ctx.save(); roundRect(ctx, 112, 104, kf.w + 44, 52, 26); ctx.fillStyle = 'rgba(6,11,22,0.72)'; ctx.fill(); ctx.restore();
      text(S, up(d.kicker), 134, 139, { fam: 'body', fit: { max: 24, min: 16, maxW: 760 }, track: 0.12, color: '#ffffff', name: 'the tournament', critical: false });
      text(S, lineOf(d), 116, 806, { fam: 'body', fit: { max: 28, min: 18, maxW: 1020 }, color: '#e2e8f0', name: 'the match', critical: false });
      const P = { x: 1206, y: 72, w: 634, h: 768 };
      panelFill(P);
      if (teams.length === 2) {
        logo(S, teams[0].logo, teams[0], { x: 1266, y: 112, w: 200, h: 200 }, { group: 'id' });
        logo(S, teams[1].logo, teams[1], { x: 1580, y: 112, w: 200, h: 200 }, { group: 'id' });
        text(S, 'VS', 1523, 232, { fam: 'display', size: 52, color: '#ffffff', align: 'center', name: 'VS', critical: false });
      } else if (teams[0]) {
        logo(S, teams[0].logo, teams[0], { x: 1413, y: 104, w: 220, h: 220 });
      }
      text(S, up(teams.length === 2 ? '' : teams[0] ? teams[0].name : ''), 1523, 372, { fam: 'body', fit: { max: 30, min: 18, maxW: 560 }, track: 0.14, color: '#ffffff', align: 'center', name: 'the team name', assist: true });
      ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.fillRect(1266, 404, 514, 2);
      let y = 470;
      if (N.first) { const t = text(S, N.first, 1523, y + 40, { fam: 'display', fit: { max: 70, min: 44, maxW: 560 }, track: 0.05, color: 'rgba(255,255,255,0.9)', colorForCheck: '#f1f5f9', align: 'center', name: 'the first name', assist: true }); y = t.rect.y + t.rect.h + 12; }
      const last = text(S, N.last, 1523, y + 136, { fam: 'display', fit: { max: 156, min: 64, maxW: 566 }, color: '#ffffff', align: 'center', name: 'the name', shadow: { color: 'rgba(0,0,0,0.35)', blur: 16, y: 4 } });
      const hf = fit(ctx, up(d.headline), 'event', 40, 24, 520, 0);
      pillText(d.headline, 1523 - (hf.w + 48) / 2, Math.min(last.rect.y + last.rect.h + 92, 806), 40, 560);
      bar({ x: 80, y: 870, w: 1760, h: 100 });
      const st = (d.stats || []).slice(0, 4);
      if (st.length) statsRow(S, st, 140, 932, { max: 4, valueSize: 60, labelSize: 18, gap: 56, rules: 'rgba(255,255,255,0.16)', maxW: 1180 });
      wordmark(S, 1800, 936, 40, { align: 'right' });
    } else {
      frame({ x: 56, y: 236, w: 968, h: 726 });
      g = ctx.createLinearGradient(0, 780, 0, 962); g.addColorStop(0, 'rgba(6,11,22,0)'); g.addColorStop(1, 'rgba(6,11,22,0.85)');
      ctx.save(); roundRect(ctx, 56, 236, 968, 726, 28); ctx.clip(); ctx.fillStyle = g; ctx.fillRect(56, 780, 968, 182); ctx.restore();
      text(S, lineOf(d), 88, 932, { fam: 'body', fit: { max: 26, min: 16, maxW: 900 }, color: '#e2e8f0', name: 'the match', critical: false });
      wordmark(S, 56, 132, 44);
      text(S, up(d.kicker), 56, 190, { fam: 'body', fit: { max: 24, min: 16, maxW: 968 }, track: 0.14, color: '#94a3b8', name: 'the tournament', critical: false });
      const P = { x: 56, y: 992, w: 968, h: 520 };
      panelFill(P);
      if (teams.length === 2) {
        logo(S, teams[0].logo, teams[0], { x: 96, y: 1028, w: 150, h: 150 }, { group: 'id' });
        logo(S, teams[1].logo, teams[1], { x: 262, y: 1028, w: 150, h: 150 }, { group: 'id' });
      } else if (teams[0]) logo(S, teams[0].logo, teams[0], { x: 96, y: 1024, w: 170, h: 170 });
      const tx = teams.length === 2 ? 440 : 294;
      text(S, up(teams.length === 2 ? `${teams[0].short || teams[0].name} vs ${teams[1].short || teams[1].name}` : teams[0] ? teams[0].name : ''), tx, 1120, { fam: 'body', fit: { max: 30, min: 18, maxW: 1000 - tx }, track: 0.12, color: '#ffffff', name: 'the team name', assist: true });
      let y = 1226;
      if (N.first) { const t = text(S, N.first, 96, y + 50, { fam: 'display', fit: { max: 64, min: 40, maxW: 888 }, track: 0.05, color: 'rgba(255,255,255,0.9)', colorForCheck: '#f1f5f9', name: 'the first name', assist: true }); y = t.rect.y + t.rect.h + 8; }
      const last = text(S, N.last, 92, y + 130, { fam: 'display', fit: { max: 150, min: 64, maxW: 888 }, color: '#ffffff', name: 'the name', shadow: { color: 'rgba(0,0,0,0.35)', blur: 14, y: 4 } });
      pillText(d.headline, 96, Math.min(last.rect.y + last.rect.h + 76, 1478), 38, 888);
      bar({ x: 56, y: 1540, w: 968, h: 132 });
      statsRow(S, d.stats, 104, 1614, { max: 3, valueSize: 58, labelSize: 17, gap: 44, rules: 'rgba(255,255,255,0.16)', maxW: 880 });
    }
  };

  /* ============================================================ MODE B */
  // A floodlit ground at night, drawn: sky, stands (lights only — no people),
  // four floodlight towers with their beams, the outfield's mowing stripes in
  // perspective, the rope, the pitch with its creases and stumps.
  function stadium(S, horizon, o) {
    const { ctx, W, H, rng } = S, A = S.accent;
    let g = ctx.createLinearGradient(0, 0, 0, horizon);
    g.addColorStop(0, '#03060f'); g.addColorStop(0.6, mix(A, '#070d1c', 0.82)); g.addColorStop(1, mix(A, '#0b1430', 0.6));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, horizon + 4);
    // the stands: a dark bowl, rows of tiny lights
    const top = (x) => horizon - (o.standH || 150) - Math.pow((x / W - 0.5) * 2, 2) * (o.bowl || 70);
    ctx.save(); ctx.beginPath(); ctx.moveTo(0, horizon + 2);
    for (let x = 0; x <= W; x += 20) ctx.lineTo(x, top(x));
    ctx.lineTo(W, horizon + 2); ctx.closePath();
    g = ctx.createLinearGradient(0, horizon - 260, 0, horizon); g.addColorStop(0, '#0b1222'); g.addColorStop(1, '#141d33');
    ctx.fillStyle = g; ctx.fill(); ctx.clip();
    for (let i = 0; i < (o.dots || 900); i++) {
      const x = rng() * W, y = top(x) + 8 + rng() * (horizon - top(x) - 10);
      const warm = rng() < 0.7;
      ctx.fillStyle = warm ? `rgba(255,236,200,${0.08 + rng() * 0.35})` : rgba(A, 0.12 + rng() * 0.3);
      ctx.beginPath(); ctx.arc(x, y, 0.8 + rng() * 1.8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    // the roof's light strip
    ctx.save(); ctx.strokeStyle = 'rgba(255,240,210,0.55)'; ctx.lineWidth = 3; ctx.beginPath();
    for (let x = 0; x <= W; x += 20) (x ? ctx.lineTo(x, top(x)) : ctx.moveTo(x, top(x)));
    ctx.stroke(); ctx.restore();
    // floodlights
    (o.towers || [0.08, 0.3, 0.7, 0.92]).forEach((fx, i) => {
      const x = fx * W, base = top(x), headY = o.towerTop + (i % 2 ? 30 : 0) * (o.portrait ? 1.6 : 1);
      ctx.save();
      ctx.strokeStyle = '#1b2438'; ctx.lineWidth = o.portrait ? 9 : 7; ctx.beginPath(); ctx.moveTo(x, base); ctx.lineTo(x, headY + 30); ctx.stroke();
      // the beam down onto the field
      const bg = ctx.createLinearGradient(x, headY, W / 2, horizon + (H - horizon) * 0.4);
      bg.addColorStop(0, 'rgba(255,248,230,0.22)'); bg.addColorStop(1, 'rgba(255,248,230,0)');
      ctx.globalCompositeOperation = 'screen'; ctx.fillStyle = bg;
      poly(ctx, [[x - 40, headY + 20], [x + 40, headY + 20], [W / 2 + (x - W / 2) * 0.25 + 260, horizon + (H - horizon) * 0.5], [W / 2 + (x - W / 2) * 0.25 - 260, horizon + (H - horizon) * 0.5]]); ctx.fill();
      ctx.restore();
      ctx.save();
      const bw = o.portrait ? 96 : 84, bh = o.portrait ? 50 : 44;
      ctx.fillStyle = '#20293f'; roundRect(ctx, x - bw / 2, headY, bw, bh, 6); ctx.fill();
      for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) { ctx.fillStyle = '#fffaf0'; ctx.fillRect(x - bw / 2 + 8 + c * ((bw - 16) / 5), headY + 7 + r * ((bh - 10) / 3), (bw - 16) / 5 - 4, (bh - 10) / 3 - 4); }
      ctx.restore();
      glow(S, x, headY + bh / 2, o.portrait ? 300 : 260, '#fff6e0', 0.75);
      glow(S, x, headY + bh / 2, o.portrait ? 620 : 520, A, 0.18);
    });
    // the outfield
    const fieldTop = horizon;
    g = ctx.createRadialGradient(W / 2, fieldTop + (H - fieldTop) * 0.55, 20, W / 2, fieldTop + (H - fieldTop) * 0.55, Math.max(W, H - fieldTop) * 0.9);
    g.addColorStop(0, '#2f8a3e'); g.addColorStop(0.55, '#1c5a2a'); g.addColorStop(1, '#0b2613');
    ctx.fillStyle = g; ctx.fillRect(0, fieldTop, W, H - fieldTop);
    const vpY = fieldTop - (H - fieldTop) * 0.9, n = 18;
    ctx.save(); ctx.beginPath(); ctx.rect(0, fieldTop, W, H - fieldTop); ctx.clip();
    for (let i = -n; i < n; i += 2) {
      const xt = W / 2 + i * 34, xt2 = W / 2 + (i + 1) * 34, k = (H - vpY) / (fieldTop - vpY);
      const xb = W / 2 + i * 34 * k, xb2 = W / 2 + (i + 1) * 34 * k;
      ctx.fillStyle = 'rgba(255,255,255,0.045)'; poly(ctx, [[xt, fieldTop], [xt2, fieldTop], [xb2, H], [xb, H]]); ctx.fill();
    }
    ctx.restore();
    // the rope, the pitch, its creases and the far stumps
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(W / 2, fieldTop + (H - fieldTop) * 1.05, W * 0.62, (H - fieldTop) * 1.0, 0, Math.PI * 1.06, Math.PI * 1.94); ctx.stroke(); ctx.restore();
    const pT = fieldTop + (H - fieldTop) * (o.pitchTop || 0.22), pB = H + 40, wT = o.portrait ? 56 : 70, wB = o.portrait ? 300 : 360;
    g = ctx.createLinearGradient(0, pT, 0, pB); g.addColorStop(0, '#b59d70'); g.addColorStop(1, '#d6c193');
    ctx.fillStyle = g; poly(ctx, [[W / 2 - wT / 2, pT], [W / 2 + wT / 2, pT], [W / 2 + wB / 2, pB], [W / 2 - wB / 2, pB]]); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2;
    const crease = (t, ext) => { const y = pT + (pB - pT) * t, hw = (wT + (wB - wT) * t) / 2 * ext; ctx.beginPath(); ctx.moveTo(W / 2 - hw, y); ctx.lineTo(W / 2 + hw, y); ctx.stroke(); };
    crease(0.035, 1.5); crease(0.075, 1.5);
    ctx.fillStyle = '#f3ead6';
    for (const dx of [-7, 0, 7]) ctx.fillRect(W / 2 + dx - 1.5, pT - 26, 3, 30);
    ctx.fillRect(W / 2 - 9, pT - 27, 18, 3);
    g = ctx.createLinearGradient(0, horizon - 90, 0, horizon + 140); g.addColorStop(0, 'rgba(210,225,255,0)'); g.addColorStop(0.5, 'rgba(210,225,255,0.10)'); g.addColorStop(1, 'rgba(210,225,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, horizon - 90, W, 230);
  }
  designs.graphic.stadium = function (S) {
    const { ctx, W, H, data: d } = S, A = S.accent, N = nameOf(d), teams = teamsOf(d);
    if (!S.portrait) {
      stadium(S, 610, { standH: 170, bowl: 80, towerTop: 70, dots: 1100, pitchTop: 0.3 });
      vignette(S, 0.6, 0.38); grain(S, 0.05);
      wordmark(S, 96, 1030, 36, { shadow: true });
      text(S, up(d.kicker), W / 2, 150, { fam: 'body', fit: { max: 30, min: 18, maxW: 1200 }, track: 0.22, color: '#e2e8f0', align: 'center', name: 'the tournament', critical: false, shadow: { blur: 12 } });
      let y = 190;
      if (N.first) { const t = text(S, N.first, W / 2, y + 84, { fam: 'display', fit: { max: 92, min: 56, maxW: 1300 }, track: 0.08, color: '#f1f5f9', align: 'center', name: 'the first name', shadow: { color: 'rgba(0,0,0,0.6)', blur: 20 } }); y = t.rect.y + t.rect.h + 14; }
      const last = text(S, N.last, W / 2, y + 236, { fam: 'display', fit: { max: 262, min: 110, maxW: 1560 }, color: '#ffffff', align: 'center', name: 'the name', shadow: { color: rgba(A, 0.85), blur: 60 } });
      text(S, up(d.headline), W / 2, last.rect.y + last.rect.h + 86, { fam: 'event', fit: { max: 64, min: 36, maxW: 1300 }, color: BRAND.amber, align: 'center', name: 'the headline', shadow: { color: 'rgba(0,0,0,0.7)', blur: 18, y: 4 } });
      // the logo(s) on the field, in a pool of light
      glow(S, W / 2, 812, 380, '#ffffff', 0.32);
      if (teams.length === 2) {
        logo(S, teams[0].logo, teams[0], { x: W / 2 - 330, y: 690, w: 220, h: 220 }, { group: 'field' });
        logo(S, teams[1].logo, teams[1], { x: W / 2 + 110, y: 690, w: 220, h: 220 }, { group: 'field' });
        ctx.save(); ctx.fillStyle = 'rgba(6,11,22,0.78)'; ctx.beginPath(); ctx.arc(W / 2, 800, 58, 0, Math.PI * 2); ctx.fill(); ctx.restore();
        text(S, 'VS', W / 2, 826, { fam: 'display', size: 64, color: '#ffffff', align: 'center', name: 'VS', critical: false });
      } else if (teams[0]) logo(S, teams[0].logo, teams[0], { x: W / 2 - 125, y: 672, w: 250, h: 250 });
      statsRow(S, d.stats, W / 2, 996, { max: 3, valueSize: 58, labelSize: 16, gap: 40, chip: 'rgba(6,11,22,0.72)', chipLine: 'rgba(255,255,255,0.18)', align: 'center', maxW: 1000 });
      text(S, lineOf(d), 96, 982, { fam: 'body', fit: { max: 22, min: 15, maxW: 420 }, color: '#e2e8f0', name: 'the match', critical: false, shadow: { blur: 8 } });
    } else {
      stadium(S, 1180, { standH: 200, bowl: 60, towerTop: 120, dots: 900, pitchTop: 0.18, portrait: true, towers: [0.1, 0.9] });
      vignette(S, 0.55, 0.4); grain(S, 0.05);
      wordmark(S, W / 2, 140, 46, { align: 'center', shadow: true });
      text(S, up(d.kicker), W / 2, 196, { fam: 'body', fit: { max: 26, min: 16, maxW: 940 }, track: 0.2, color: '#e2e8f0', align: 'center', name: 'the tournament', critical: false, shadow: { blur: 10 } });
      glow(S, W / 2, 420, 340, '#ffffff', 0.22);
      if (teams.length === 2) {
        logo(S, teams[0].logo, teams[0], { x: W / 2 - 290, y: 290, w: 220, h: 220 }, { group: 'top' });
        logo(S, teams[1].logo, teams[1], { x: W / 2 + 70, y: 290, w: 220, h: 220 }, { group: 'top' });
        text(S, 'VS', W / 2, 424, { fam: 'display', size: 64, color: '#ffffff', align: 'center', name: 'VS', critical: false });
      } else if (teams[0]) logo(S, teams[0].logo, teams[0], { x: W / 2 - 130, y: 280, w: 260, h: 260 });
      let y = 600;
      if (N.first) { const t = text(S, N.first, W / 2, y + 80, { fam: 'display', fit: { max: 88, min: 54, maxW: 940 }, track: 0.08, color: '#f1f5f9', align: 'center', name: 'the first name', shadow: { color: 'rgba(0,0,0,0.6)', blur: 18 } }); y = t.rect.y + t.rect.h + 12; }
      const last = text(S, N.last, W / 2, y + 210, { fam: 'display', fit: { max: 232, min: 100, maxW: 950 }, color: '#ffffff', align: 'center', name: 'the name', shadow: { color: rgba(A, 0.85), blur: 54 } });
      text(S, up(d.headline), W / 2, last.rect.y + last.rect.h + 84, { fam: 'event', fit: { max: 62, min: 34, maxW: 940 }, color: BRAND.amber, align: 'center', name: 'the headline', shadow: { color: 'rgba(0,0,0,0.7)', blur: 16, y: 4 } });
      statsRow(S, d.stats, W / 2, 1576, { max: 3, valueSize: 56, labelSize: 17, gap: 38, chip: 'rgba(6,11,22,0.72)', chipLine: 'rgba(255,255,255,0.18)', align: 'center', maxW: 900 });
      text(S, lineOf(d), W / 2, 1790, { fam: 'body', fit: { max: 24, min: 15, maxW: 940 }, color: '#e2e8f0', align: 'center', name: 'the match', critical: false, shadow: { blur: 8 } });
    }
  };

  // The ball, drawn: red leather, its light, the seam and its stitches.
  function ball(S, x, y, r, angle) {
    const ctx = S.ctx;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = r * 0.35; ctx.shadowOffsetY = r * 0.12;
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
    g.addColorStop(0, '#ff6a55'); g.addColorStop(0.35, '#d5261d'); g.addColorStop(0.8, '#8c1010'); g.addColorStop(1, '#4a0606');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.clip();
    ctx.translate(x, y); ctx.rotate(angle);
    for (const off of [-r * 0.07, r * 0.07]) {
      ctx.strokeStyle = 'rgba(255,240,225,0.9)'; ctx.lineWidth = r * 0.025;
      ctx.beginPath(); ctx.ellipse(off * 2.2, 0, r * 0.36, r * 1.05, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,245,235,0.85)'; ctx.lineWidth = r * 0.02;
    for (let i = 0; i < 26; i++) {
      const t = (i / 26) * Math.PI * 2, ex = Math.cos(t) * r * 0.36, ey = Math.sin(t) * r * 1.05;
      ctx.beginPath(); ctx.moveTo(ex - r * 0.07, ey); ctx.lineTo(ex + r * 0.07, ey - r * 0.03); ctx.stroke();
    }
    ctx.restore();
    const sp = ctx.createRadialGradient(x - r * 0.42, y - r * 0.48, 0, x - r * 0.42, y - r * 0.48, r * 0.5);
    sp.addColorStop(0, 'rgba(255,255,255,0.55)'); sp.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sp; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  // The pitch from above: the strip, the grass either side, the creases, three stumps at each end.
  function pitchTop(S, cx, cy, len, wid, angle) {
    const ctx = S.ctx;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(angle);
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 16;
    ctx.fillStyle = '#1f6a31'; roundRect(ctx, -len / 2 - 60, -wid / 2 - 70, len + 120, wid + 140, 20); ctx.fill();
    ctx.shadowColor = 'transparent';
    for (let i = 0; i < 8; i++) { ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'; ctx.fillRect(-len / 2 - 60 + i * (len + 120) / 8, -wid / 2 - 70, (len + 120) / 8, wid + 140); }
    const g = ctx.createLinearGradient(0, -wid / 2, 0, wid / 2); g.addColorStop(0, '#c9b17f'); g.addColorStop(0.5, '#dcc796'); g.addColorStop(1, '#c2a874');
    ctx.fillStyle = g; ctx.fillRect(-len / 2, -wid / 2, len, wid);
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 4;
    for (const s of [-1, 1]) {
      const xe = s * (len / 2 - len * 0.06), xp = s * (len / 2 - len * 0.12);
      ctx.beginPath(); ctx.moveTo(xe, -wid * 0.75); ctx.lineTo(xe, wid * 0.75); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(xp, -wid * 0.85); ctx.lineTo(xp, wid * 0.85); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(xe, -wid * 0.42); ctx.lineTo(xp, -wid * 0.42); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(xe, wid * 0.42); ctx.lineTo(xp, wid * 0.42); ctx.stroke();
      ctx.fillStyle = '#f6efe0';
      for (const dy of [-wid * 0.13, 0, wid * 0.13]) { ctx.beginPath(); ctx.arc(xe, dy, 7, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = '#e7d7b3'; ctx.fillRect(xe - 3, -wid * 0.13, 6, wid * 0.26);
    }
    ctx.restore();
  }
  designs.graphic.pitch = function (S) {
    const { ctx, W, H, data: d, rng } = S, A = S.accent, N = nameOf(d), teams = teamsOf(d);
    const A2 = mix(A, BRAND.deep, 0.55), A3 = mix(A, '#ffffff', 0.25);
    let g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, mix(A, BRAND.deep, 0.35)); g.addColorStop(1, BRAND.deep);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const nameLine = [N.first, N.last].filter(Boolean).join(' ');
    const cnt = splitCount(up(d.headline));
    // layered slabs at the same slant
    const slab = (x, w, col, a) => { ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = col; const k = H * 0.55; poly(ctx, [[x, 0], [x + w, 0], [x + w - k, H], [x - k, H]]); ctx.fill(); ctx.restore(); };
    if (!S.portrait) {
      slab(980, 520, A, 0.85); slab(1440, 90, A3, 0.9); slab(1580, 420, A2, 0.9); slab(860, 40, BRAND.amber, 0.95);
      ctx.save(); ctx.fillStyle = 'rgba(255,255,255,0.09)';
      for (let yy = 0; yy < H; yy += 20) for (let xx = 0; xx < 900; xx += 20) { const r = 3 * (1 - xx / 900) * (0.4 + 0.6 * yy / H); if (r > 0.4) { ctx.beginPath(); ctx.arc(xx, yy, r, 0, Math.PI * 2); ctx.fill(); } }
      ctx.restore();
      pitchTop(S, 1380, 600, 980, 150, -0.5);
      // the ball in flight, its trail behind it
      const bx = 1560, by = 290, br = 118;
      ctx.save(); ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < 6; i++) { const t = i / 6; ctx.strokeStyle = `rgba(255,255,255,${0.32 - t * 0.05})`; ctx.lineWidth = br * (0.7 - t * 0.1);
        ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(bx - 60, by + 30); ctx.quadraticCurveTo(bx - 400 - i * 20, by + 120 + i * 18, bx - 760 - rng() * 60, by + 340 + i * 30); ctx.globalAlpha = 0.12; ctx.stroke(); }
      ctx.restore();
      ball(S, bx, by, br, -0.6);
      grain(S, 0.06);
      wordmark(S, 96, 92, 40, { shadow: true });
      text(S, up(d.kicker), 96, 146, { fam: 'body', fit: { max: 24, min: 16, maxW: 760 }, track: 0.16, color: '#e2e8f0', name: 'the tournament', critical: false });
      if (cnt) {
        const n = text(S, cnt.num, 84, 540, { fam: 'event', fit: { max: 380, min: 200, maxW: 440 }, color: '#ffffff', name: 'the headline figure', stroke: { color: rgba(A, 0.9), width: 16 }, group: 'hl' });
        text(S, cnt.word, 96 + n.w + 26, 520, { fam: 'event', fit: { max: 150, min: 60, maxW: 860 - n.w - 26 }, color: '#ffffff', name: 'the headline', group: 'hl', shadow: { color: 'rgba(0,0,0,0.4)', blur: 16, y: 6 } });
      } else {
        const words = up(d.headline).split(/\s+/), cut = Math.ceil(words.length / 2);
        text(S, words.slice(0, cut).join(' '), 90, 360, { fam: 'event', fit: { max: 160, min: 60, maxW: 820 }, color: '#ffffff', name: 'the headline', group: 'hl', shadow: { color: 'rgba(0,0,0,0.4)', blur: 16, y: 6 } });
        if (words.length > 1) text(S, words.slice(cut).join(' '), 90, 530, { fam: 'event', fit: { max: 160, min: 60, maxW: 820 }, color: '#ffffff', name: 'the headline (2nd line)', group: 'hl', shadow: { color: 'rgba(0,0,0,0.4)', blur: 16, y: 6 } });
      }
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 8;
      ctx.fillStyle = BRAND.deep; poly(ctx, [[0, 640], [1060, 640], [1000, 790], [0, 790]]); ctx.fill(); ctx.restore();
      ctx.fillStyle = BRAND.amber; ctx.fillRect(0, 640, 1040, 6);
      text(S, bandName(S, N, 'display', 124, 880), 96, 752, { fam: 'display', fit: { max: 124, min: 60, maxW: 880 }, color: '#ffffff', name: 'the name' });
      statsRow(S, d.stats, 118, 930, { max: 3, valueSize: 62, labelSize: 18, gap: 44, chip: 'rgba(6,11,22,0.62)', chipLine: 'rgba(255,255,255,0.3)', maxW: 1000 });
      if (teams.length === 2) {
        logo(S, teams[0].logo, teams[0], { x: 1330, y: 744, w: 190, h: 190 }, { group: 'logos' });
        logo(S, teams[1].logo, teams[1], { x: 1580, y: 744, w: 190, h: 190 }, { group: 'logos' });
        text(S, 'VS', 1550, 860, { fam: 'display', size: 54, color: '#ffffff', align: 'center', name: 'VS', critical: false, shadow: { blur: 12 } });
      } else if (teams[0]) logo(S, teams[0].logo, teams[0], { x: 1560, y: 720, w: 230, h: 230 });
      text(S, lineOf(d), 96, 1034, { fam: 'body', fit: { max: 22, min: 15, maxW: 900 }, color: '#cbd5e1', name: 'the match', critical: false });
    } else {
      slab(560, 600, A, 0.85); slab(1050, 80, A3, 0.9); slab(1170, 500, A2, 0.9); slab(470, 34, BRAND.amber, 0.95);
      pitchTop(S, 600, 1010, 1100, 150, -0.95);
      const bx = 840, by = 470, br = 120;
      ctx.save(); ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < 6; i++) { ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = br * (0.7 - i * 0.08); ctx.lineCap = 'round'; ctx.globalAlpha = 0.12;
        ctx.beginPath(); ctx.moveTo(bx - 50, by + 40); ctx.quadraticCurveTo(bx - 300, by + 220 + i * 18, bx - 560 - rng() * 40, by + 560 + i * 26); ctx.stroke(); }
      ctx.restore();
      ball(S, bx, by, br, -0.6);
      grain(S, 0.06);
      wordmark(S, 64, 130, 46, { shadow: true });
      text(S, up(d.kicker), 64, 186, { fam: 'body', fit: { max: 24, min: 16, maxW: 952 }, track: 0.16, color: '#e2e8f0', name: 'the tournament', critical: false });
      if (teams.length === 2) {
        logo(S, teams[0].logo, teams[0], { x: 64, y: 262, w: 180, h: 180 }, { group: 'logos' });
        logo(S, teams[1].logo, teams[1], { x: 262, y: 262, w: 180, h: 180 }, { group: 'logos' });
      } else if (teams[0]) logo(S, teams[0].logo, teams[0], { x: 64, y: 252, w: 210, h: 210 });
      if (cnt) {
        const n = text(S, cnt.num, 80, 1500, { fam: 'event', fit: { max: 330, min: 160, maxW: 400 }, color: '#ffffff', name: 'the headline figure', stroke: { color: rgba(A, 0.9), width: 14 }, group: 'hl' });
        text(S, cnt.word, 92 + n.w + 24, 1480, { fam: 'event', fit: { max: 130, min: 50, maxW: 952 - n.w - 30 }, color: '#ffffff', name: 'the headline', group: 'hl', shadow: { color: 'rgba(0,0,0,0.4)', blur: 14, y: 5 } });
      } else {
        text(S, up(d.headline), 76, 1460, { fam: 'event', fit: { max: 130, min: 50, maxW: 930 }, color: '#ffffff', name: 'the headline', shadow: { color: 'rgba(0,0,0,0.4)', blur: 14, y: 5 } });
      }
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 22; ctx.shadowOffsetY = 8;
      ctx.fillStyle = BRAND.deep; poly(ctx, [[0, 1100], [1080, 1040], [1080, 1180], [0, 1240]]); ctx.fill(); ctx.restore();
      ctx.fillStyle = BRAND.amber; poly(ctx, [[0, 1100], [1080, 1040], [1080, 1046], [0, 1106]]); ctx.fill();
      text(S, bandName(S, N, 'display', 110, 900), 72, 1196, { fam: 'display', fit: { max: 110, min: 56, maxW: 900 }, color: '#ffffff', name: 'the name', angle: Math.atan2(-60, 1080) });
      statsRow(S, d.stats, 86, 1640, { max: 3, valueSize: 56, labelSize: 17, gap: 40, chip: 'rgba(6,11,22,0.62)', chipLine: 'rgba(255,255,255,0.3)', maxW: 900 });
      text(S, lineOf(d), 64, 1800, { fam: 'body', fit: { max: 24, min: 15, maxW: 952 }, color: '#e2e8f0', name: 'the match', critical: false });
    }
  };

  // The ground from above, in fine lines: the rope, the 30-yard circle, the pitch.
  function groundPlan(S, cx, cy, rx, ry, A) {
    const ctx = S.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.09)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(cx, cy, rx * 1.06, ry * 1.06, 0, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.stroke();
    ctx.setLineDash([10, 12]); ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath(); ctx.ellipse(cx, cy, rx * 0.52, ry * 0.56, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    const pw = rx * 0.07, ph = ry * 0.42;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.strokeRect(cx - pw / 2, cy - ph / 2, pw, ph);
    ctx.beginPath(); ctx.moveTo(cx - pw, cy - ph / 2 + ph * 0.06); ctx.lineTo(cx + pw, cy - ph / 2 + ph * 0.06); ctx.moveTo(cx - pw, cy + ph / 2 - ph * 0.06); ctx.lineTo(cx + pw, cy + ph / 2 - ph * 0.06); ctx.stroke();
    // the one accent: an arc of the rope in the team's colour
    ctx.strokeStyle = A; ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, -Math.PI * 0.62, -Math.PI * 0.28); ctx.stroke();
    ctx.restore();
  }
  designs.graphic.minimal = function (S) {
    const { ctx, W, H, data: d } = S, A = S.accent, N = nameOf(d), teams = teamsOf(d);
    let g = ctx.createRadialGradient(W * 0.62, H * 0.42, 40, W * 0.55, H * 0.5, Math.hypot(W, H) * 0.7);
    g.addColorStop(0, '#162036'); g.addColorStop(0.55, '#0a101d'); g.addColorStop(1, '#04070d');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const rule = (x, y, w) => { ctx.fillStyle = A; ctx.fillRect(x, y, w, 3); };
    if (!S.portrait) {
      groundPlan(S, 1340, 540, 520, 400, A);
      glow(S, 1340, 540, 360, A, 0.16);
      if (teams.length === 2) {
        logo(S, teams[0].logo, teams[0], { x: 1110, y: 430, w: 200, h: 200 }, { group: 'plan', style: 'circle' });
        logo(S, teams[1].logo, teams[1], { x: 1370, y: 430, w: 200, h: 200 }, { group: 'plan', style: 'circle' });
        text(S, 'VS', 1340, 548, { fam: 'body', size: 26, track: 0.3, color: '#94a3b8', align: 'center', name: 'VS', critical: false });
      } else if (teams[0]) logo(S, teams[0].logo, teams[0], { x: 1220, y: 420, w: 240, h: 240 }, { style: 'circle' });
      grain(S, 0.04);
      wordmark(S, 140, 150, 34);
      text(S, up(d.kicker), 140, 300, { fam: 'body', fit: { max: 24, min: 16, maxW: 820 }, track: 0.32, color: mix(A, '#ffffff', 0.5), name: 'the tournament', critical: false });
      let y = 330;
      if (N.first) { const t = text(S, N.first, 140, y + 70, { fam: 'body', fit: { max: 52, min: 30, maxW: 820 }, track: 0.24, color: '#cbd5e1', name: 'the first name' }); y = t.rect.y + t.rect.h + 18; }
      const last = text(S, N.last, 134, y + 210, { fam: 'display', fit: { max: 230, min: 96, maxW: 860 }, color: '#ffffff', name: 'the name' });
      rule(140, last.rect.y + last.rect.h + 40, 120);
      text(S, up(d.headline), 140, last.rect.y + last.rect.h + 112, { fam: 'body', fit: { max: 34, min: 20, maxW: 820 }, track: 0.26, color: '#ffffff', name: 'the headline' });
      statsRow(S, d.stats, 140, Math.min(last.rect.y + last.rect.h + 260, 930), { max: 3, valueSize: 72, labelSize: 17, gap: 48, valueColor: '#ffffff', labelColor: '#7c8aa0', maxW: 820 });
      text(S, lineOf(d), 1340, 1010, { fam: 'body', fit: { max: 22, min: 14, maxW: 620 }, track: 0.08, color: '#64748b', align: 'center', name: 'the match', critical: false });
    } else {
      groundPlan(S, 540, 600, 430, 340, A);
      glow(S, 540, 600, 330, A, 0.16);
      if (teams.length === 2) {
        logo(S, teams[0].logo, teams[0], { x: 320, y: 500, w: 200, h: 200 }, { group: 'plan', style: 'circle' });
        logo(S, teams[1].logo, teams[1], { x: 560, y: 500, w: 200, h: 200 }, { group: 'plan', style: 'circle' });
      } else if (teams[0]) logo(S, teams[0].logo, teams[0], { x: 420, y: 480, w: 240, h: 240 }, { style: 'circle' });
      grain(S, 0.04);
      text(S, up(d.kicker), W / 2, 1060, { fam: 'body', fit: { max: 24, min: 15, maxW: 940 }, track: 0.3, color: mix(A, '#ffffff', 0.5), align: 'center', name: 'the tournament', critical: false });
      let y = 1080;
      if (N.first) { const t = text(S, N.first, W / 2, y + 66, { fam: 'body', fit: { max: 48, min: 28, maxW: 940 }, track: 0.24, color: '#cbd5e1', align: 'center', name: 'the first name' }); y = t.rect.y + t.rect.h + 16; }
      const last = text(S, N.last, W / 2, y + 196, { fam: 'display', fit: { max: 210, min: 90, maxW: 950 }, color: '#ffffff', align: 'center', name: 'the name' });
      rule(W / 2 - 60, last.rect.y + last.rect.h + 36, 120);
      text(S, up(d.headline), W / 2, last.rect.y + last.rect.h + 104, { fam: 'body', fit: { max: 32, min: 18, maxW: 940 }, track: 0.26, color: '#ffffff', align: 'center', name: 'the headline' });
      statsRow(S, d.stats, W / 2, Math.min(last.rect.y + last.rect.h + 236, 1610), { max: 3, valueSize: 64, labelSize: 16, gap: 44, labelColor: '#7c8aa0', align: 'center', maxW: 900 });
      wordmark(S, W / 2, 1760, 34, { align: 'center' });
      text(S, lineOf(d), W / 2, 1820, { fam: 'body', fit: { max: 22, min: 14, maxW: 940 }, track: 0.08, color: '#64748b', align: 'center', name: 'the match', critical: false });
    }
  };

  /* ---------------------------------------------------------------- API */
  function variationOf(mode, n) { return (VARIATIONS[mode] || []).find(v => v.n === Number(n)) || null; }
  // render({ mode, variation, format, data, photo, seed, scale }) → { canvas, qa, meta }
  function render(o) {
    const mode = o.mode === 'photo' ? 'photo' : 'graphic', V = variationOf(mode, o.variation) || VARIATIONS[mode][0];
    const format = o.format === '9:16' ? '9:16' : '16:9', [W, H] = SIZES[format], k = clamp(Number(o.scale) || 1, 0.1, 1);
    const canvas = o.canvas || canvasOf(W * k, H * k);
    canvas.width = Math.round(W * k); canvas.height = Math.round(H * k);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const d = Object.assign({ teams: [], stats: [] }, o.data || {});
    const lead = teamsOf(d)[0];
    const S = { ctx, canvas, W, H, k, format, portrait: format === '9:16', mode, data: d, photo: mode === 'photo' ? o.photo || null : null,
      rng: mulberry((Number(o.seed) || 1) * 7919 + V.n * 131 + (format === '9:16' ? 17 : 0)), accent: accentOf(lead && lead.color) };
    S.qa = makeQA(S);
    if (mode === 'photo' && !(S.photo && S.photo.img)) {
      ctx.fillStyle = BRAND.ink; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#94a3b8'; ctx.font = font('body', 42); ctx.textAlign = 'center';
      ctx.fillText('Choose a frame or upload a photo', W / 2, H / 2);
    } else {
      designs[mode][V.key](S);
    }
    const qa = S.qa.finish();
    return { canvas, qa, meta: { mode, modeName: MODE_NAME[mode], variation: V.n, key: V.key, name: V.name, format, width: W, height: H } };
  }
  // A good first choice from what there is: the photo (if any, and sharp), the
  // kind of highlight, how much the figures say, how long the name is. The
  // operator can always pick another.
  function autoSelect(d, photo) {
    d = d || {};
    const hasPhoto = !!(photo && photo.img) && !(photo.score != null && photo.score < 25);
    const N = nameOf(d), long = (N.last || '').length > 11, stats = (d.stats || []).length, two = teamsOf(d).length === 2;
    const kind = String(d.kind || '').toUpperCase(), boundaries = kind === 'SIX' || kind === 'FOUR';
    const score = {}, why = {};
    const add = (k, v, w) => { score[k] = (score[k] || 0) + v; if (w) (why[k] = why[k] || []).push(w); };
    VARIATIONS.photo.forEach(v => add('photo:' + v.n, hasPhoto ? 3 : -100, hasPhoto ? 'a sharp real frame of the player' : ''));
    VARIATIONS.graphic.forEach(v => add('graphic:' + v.n, 0));
    add('photo:1', long ? -1 : 1, long ? '' : 'a name short enough to set huge');
    add('photo:2', boundaries ? 2 : 0, boundaries ? 'a reel of boundaries - a dynamic design' : '');
    add('photo:3', stats >= 3 ? 2 : 0, stats >= 3 ? 'verified figures to show in the broadcast bar' : '');
    add('graphic:1', two ? 2 : 1, two ? 'both teams on the field' : 'a floodlit poster');
    add('graphic:2', boundaries || kind === 'WICKET' ? 2 : 0, boundaries ? 'boundaries - the ball in flight' : kind === 'WICKET' ? 'wickets - the stumps and the ball' : '');
    add('graphic:3', long ? 1 : 0, long ? 'a long name - room for it in the minimal layout' : '');
    const best = Object.keys(score).sort((a, b) => score[b] - score[a])[0];
    const [mode, n] = best.split(':');
    return { mode, variation: Number(n), name: variationOf(mode, n).name, reason: (why[best] || []).filter(Boolean).join('; ') || 'a balanced design for this highlight' };
  }
  // AllSportsLive_HarshMendon_WithPhoto_Variation1_16x9.jpg
  function fileName(d, mode, n, format) {
    const N = nameOf(d || {});
    const who = [N.first, N.last].filter(Boolean).join(' ').toLowerCase().replace(/(^|\s)\S/g, s => s.toUpperCase()).replace(/[^A-Za-z0-9]+/g, '') || 'Highlights';
    return `AllSportsLive_${who}_${mode === 'photo' ? 'WithPhoto' : 'NoPhoto'}_Variation${n}_${format === '9:16' ? '9x16' : '16x9'}.jpg`;
  }
  // Headlines this highlight can honestly carry: what its clips are, and the
  // verified figures (never a claim the clips or the scorecard do not show).
  function headlines(d) {
    d = d || {};
    const c = d.counts || {}, out = [];
    const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const push = (s) => { s = up(s); if (s && !out.includes(s)) out.push(s); };
    if (d.headline) push(d.headline);
    const kinds = ['sixes', 'fours', 'wickets'].filter(k => c[k] > 0);
    if (kinds.length === 1 && kinds[0] === 'sixes') push(pl(c.sixes, 'SIX', 'SIXES'));
    if (kinds.length === 1 && kinds[0] === 'fours') push(pl(c.fours, 'FOUR', 'FOURS'));
    if (kinds.length === 1 && kinds[0] === 'wickets') push(pl(c.wickets, 'WICKET', 'WICKETS'));
    if (c.sixes && c.fours && !c.wickets) { push(`${pl(c.sixes, 'SIX', 'SIXES')} & ${pl(c.fours, 'FOUR', 'FOURS')}`); push('SIXES AND FOURS'); push('BOUNDARY HIGHLIGHTS'); }
    const st = d.stats || [];
    const runs = st.find(x => x.label === 'RUNS'), wk = st.find(x => /^WICKETS?$/.test(x.label));
    if (runs && runs.sub) { const b = /^(\d+)/.exec(runs.sub); if (b) push(`${runs.value} OFF ${b[1]}`); }
    if (wk && wk.sub) { const r = /^(\d+)/.exec(wk.sub); if (r) push(`${wk.value} FOR ${r[1]}`); }
    if (d.subject === 'player') { push(c.wickets && !c.sixes && !c.fours ? 'WICKET HIGHLIGHTS' : 'BATTING HIGHLIGHTS'); if (c.wickets) push('BOWLING HIGHLIGHTS'); }
    if (d.subject === 'team') push('TEAM HIGHLIGHTS');
    push('MATCH HIGHLIGHTS');
    return out.slice(0, 8);
  }
  function toBlob(canvas, quality) {
    return new Promise((res) => canvas.toBlob(b => res(b), 'image/jpeg', quality || 0.92));
  }

  root.HighlightThumbs = { ready, render, autoSelect, fileName, headlines, prepareLogo, prepareImage, toBlob, VARIATIONS, MODE_NAME, SIZES, SAFE, accentOf, fontsOk };
})(typeof window !== 'undefined' ? window : this);
