/* ================================================================
   📄 A SMALL PDF WRITER — just what the volleyball match report needs,
   with no dependency: text in the PDF standard fonts (Helvetica /
   Helvetica-Bold, measured with their real metrics so columns line up and
   long names are cut with "…" instead of running into the next column),
   filled / rounded rectangles, lines, circles, opacity, and pictures.

   Pictures: JPEG is embedded as it is; PNG is decoded here (8-bit, every
   colour type, alpha kept as a soft mask so a transparent badge stays
   transparent); anything else is handed to ffmpeg (the binary server.js
   already has) to read as raw RGBA. A picture that cannot be read is
   skipped — the report is never lost over a logo.

   Coordinates are top-left based, in points (A4 = 595.28 × 841.89); a
   text call's `y` is its baseline.
   ================================================================ */
'use strict';
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const A4 = { w: 595.28, h: 841.89 };

// Adobe AFM advance widths (1/1000 em) for WinAnsi 32..126.
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
// WinAnsi code points outside Latin-1, and their widths (regular, bold)
const WIN_EXTRA = {
  0x2013: [0x96, 556, 556], 0x2014: [0x97, 1000, 1000], 0x2018: [0x91, 222, 278], 0x2019: [0x92, 222, 278],
  0x201C: [0x93, 333, 500], 0x201D: [0x94, 333, 500], 0x2022: [0x95, 350, 350], 0x2026: [0x85, 1000, 1000],
  0x20AC: [0x80, 556, 556], 0x2122: [0x99, 1000, 1000], 0x2192: [0x3E, 584, 584], 0x2190: [0x3C, 584, 584]
};

function encodeWinAnsi(str) {
  const out = [];
  for (const ch of String(str == null ? '' : str)) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c <= 126) out.push(c);
    else if (c >= 160 && c <= 255) out.push(c);
    else if (WIN_EXTRA[c]) out.push(WIN_EXTRA[c][0]);
    else if (c === 9 || c === 10) out.push(32);
    else {
      // strip accents we can't show, keep the letter (é → e)
      const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      const b = base.codePointAt(0);
      out.push(b >= 32 && b <= 126 ? b : 63);
    }
  }
  return out;
}
function charWidth(code, bold) {
  if (code >= 32 && code <= 126) return (bold ? W_BOLD : W_REG)[code - 32];
  for (const k in WIN_EXTRA) if (WIN_EXTRA[k][0] === code) return WIN_EXTRA[k][bold ? 2 : 1];
  if (code >= 192) return bold ? 667 : 611;   // accented capitals / letters
  return 556;
}
function pdfString(codes) {
  let s = '(';
  for (const c of codes) {
    if (c === 40 || c === 41 || c === 92) s += '\\' + String.fromCharCode(c);
    else if (c < 32 || c > 126) s += '\\' + c.toString(8).padStart(3, '0');
    else s += String.fromCharCode(c);
  }
  return s + ')';
}

function hexColor(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return [0, 0, 0];
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, '$&$&');
  const n = parseInt(h, 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
const f3 = (n) => (Math.round(n * 1000) / 1000).toString();

/* ---------- PNG ---------- */
function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let pos = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!width || !height || depth !== 8 || interlace !== 0) return null;   // the uncommon kinds go through ffmpeg
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!ch) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (e) { return null; }
  const stride = width * ch;
  if (raw.length < (stride + 1) * height) return null;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[dst + x - ch] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = x >= ch && y > 0 ? px[dst - stride + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 255;
    }
  }
  const rgb = Buffer.alloc(width * height * 3), alpha = Buffer.alloc(width * height);
  let hasAlpha = false;
  for (let i = 0; i < width * height; i++) {
    let r, g, b, a = 255;
    if (ctype === 0) { r = g = b = px[i]; if (trns && trns.length >= 2 && px[i] === trns.readUInt16BE(0)) a = 0; }
    else if (ctype === 2) { r = px[i * 3]; g = px[i * 3 + 1]; b = px[i * 3 + 2]; }
    else if (ctype === 3) { const k = px[i]; r = palette ? palette[k * 3] : 0; g = palette ? palette[k * 3 + 1] : 0; b = palette ? palette[k * 3 + 2] : 0; if (trns && k < trns.length) a = trns[k]; }
    else if (ctype === 4) { r = g = b = px[i * 2]; a = px[i * 2 + 1]; }
    else { r = px[i * 4]; g = px[i * 4 + 1]; b = px[i * 4 + 2]; a = px[i * 4 + 3]; }
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b; alpha[i] = a;
    if (a !== 255) hasAlpha = true;
  }
  return { width, height, rgb, alpha: hasAlpha ? alpha : null };
}

function jpegInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }
    if (m === 0xd9 || m === 0xda) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), comps: buf[i + 9], progressive: m === 0xc2 };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

// Anything else (WebP, interlaced / 16-bit PNG …): ffmpeg reads it as RGBA.
function decodeWithFfmpeg(buf, ffmpegPath, maxSide) {
  if (!ffmpegPath) return null;
  try {
    const probe = spawnSync(ffmpegPath, ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-vf', `scale='min(${maxSide},iw)':-2`, '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'],
      { input: buf, maxBuffer: 32 * 1024 * 1024, timeout: 8000 });
    if (probe.status !== 0 || !probe.stdout || !probe.stdout.length) return null;
    return decodePng(probe.stdout);
  } catch (e) { return null; }
}

class PdfDoc {
  constructor(opts) {
    opts = opts || {};
    this.size = opts.size || A4;
    this.objects = [];            // index = object number - 1; each a Buffer|string factory
    this.pages = [];
    this.images = [];
    this.gstates = {};
    this.ffmpegPath = opts.ffmpegPath || null;
    this.info = Object.assign({ Producer: 'AllSportsLive', Creator: 'AllSportsLive volleyball' }, opts.info || {});
  }
  addPage() {
    const page = { ops: [], images: new Set(), gstates: new Set() };
    this.pages.push(page);
    this.cur = page;
    return page;
  }
  _y(y) { return this.size.h - y; }
  _op(s) { this.cur.ops.push(s); }
  _gs(opacity) {
    if (opacity == null || opacity >= 1) return '';
    const k = 'GS' + Math.round(opacity * 100);
    this.gstates[k] = opacity;
    this.cur.gstates.add(k);
    return '/' + k + ' gs ';
  }
  _path(x, y, w, h, r) {
    if (!r) return `${f3(x)} ${f3(this._y(y + h))} ${f3(w)} ${f3(h)} re`;
    r = Math.min(r, w / 2, h / 2);
    const k = 0.5523 * r, X = x, Y = this._y(y), R = x + w, B = this._y(y + h);
    return [`${f3(X + r)} ${f3(Y)} m`, `${f3(R - r)} ${f3(Y)} l`, `${f3(R - r + k)} ${f3(Y)} ${f3(R)} ${f3(Y - r + k)} ${f3(R)} ${f3(Y - r)} c`,
      `${f3(R)} ${f3(B + r)} l`, `${f3(R)} ${f3(B + r - k)} ${f3(R - r + k)} ${f3(B)} ${f3(R - r)} ${f3(B)} c`,
      `${f3(X + r)} ${f3(B)} l`, `${f3(X + r - k)} ${f3(B)} ${f3(X)} ${f3(B + r - k)} ${f3(X)} ${f3(B + r)} c`,
      `${f3(X)} ${f3(Y - r)} l`, `${f3(X)} ${f3(Y - r + k)} ${f3(X + r - k)} ${f3(Y)} ${f3(X + r)} ${f3(Y)} c`, 'h'].join(' ');
  }
  rect(x, y, w, h, o) {
    o = o || {};
    if (w <= 0 || h <= 0) return this;
    let s = 'q ' + this._gs(o.opacity);
    if (o.fill) s += hexColor(o.fill).map(f3).join(' ') + ' rg ';
    if (o.stroke) s += hexColor(o.stroke).map(f3).join(' ') + ' RG ' + f3(o.lineWidth || 0.5) + ' w ';
    s += this._path(x, y, w, h, o.radius || 0) + ' ' + (o.fill && o.stroke ? 'B' : o.fill ? 'f' : 'S') + ' Q';
    this._op(s);
    return this;
  }
  line(x1, y1, x2, y2, o) {
    o = o || {};
    this._op(`q ${this._gs(o.opacity)}${hexColor(o.color || '#000').map(f3).join(' ')} RG ${f3(o.width || 0.5)} w ${o.dash ? '[' + o.dash.join(' ') + '] 0 d ' : ''}${f3(x1)} ${f3(this._y(y1))} m ${f3(x2)} ${f3(this._y(y2))} l S Q`);
    return this;
  }
  circle(cx, cy, r, o) {
    o = o || {};
    const k = 0.5523 * r, X = cx, Y = this._y(cy);
    let s = 'q ' + this._gs(o.opacity);
    if (o.fill) s += hexColor(o.fill).map(f3).join(' ') + ' rg ';
    if (o.stroke) s += hexColor(o.stroke).map(f3).join(' ') + ' RG ' + f3(o.lineWidth || 0.5) + ' w ';
    s += `${f3(X + r)} ${f3(Y)} m ${f3(X + r)} ${f3(Y + k)} ${f3(X + k)} ${f3(Y + r)} ${f3(X)} ${f3(Y + r)} c ${f3(X - k)} ${f3(Y + r)} ${f3(X - r)} ${f3(Y + k)} ${f3(X - r)} ${f3(Y)} c ${f3(X - r)} ${f3(Y - k)} ${f3(X - k)} ${f3(Y - r)} ${f3(X)} ${f3(Y - r)} c ${f3(X + k)} ${f3(Y - r)} ${f3(X + r)} ${f3(Y - k)} ${f3(X + r)} ${f3(Y)} c h `;
    s += (o.fill && o.stroke ? 'B' : o.fill ? 'f' : 'S') + ' Q';
    this._op(s);
    return this;
  }
  measure(str, size, bold) {
    let w = 0;
    for (const c of encodeWinAnsi(str)) w += charWidth(c, bold);
    return w * (size || 10) / 1000;
  }
  // Cut to fit `maxWidth`, with an ellipsis — never overflowing a column.
  fit(str, size, bold, maxWidth) {
    str = String(str == null ? '' : str);
    if (!maxWidth || this.measure(str, size, bold) <= maxWidth) return str;
    const chars = Array.from(str);
    while (chars.length && this.measure(chars.join('') + '…', size, bold) > maxWidth) chars.pop();
    return chars.length ? chars.join('').trimEnd() + '…' : '';
  }
  text(str, x, y, o) {
    o = o || {};
    const size = o.size || 10, bold = !!o.bold;
    let s = o.maxWidth ? this.fit(str, size, bold, o.maxWidth) : String(str == null ? '' : str);
    if (!s) return this;
    const w = this.measure(s, size, bold);
    let tx = x;
    if (o.align === 'center') tx = x + ((o.width || 0) - w) / 2;
    else if (o.align === 'right') tx = x + (o.width || 0) - w;
    this._op(`q ${this._gs(o.opacity)}BT /${bold ? 'F2' : 'F1'} ${f3(size)} Tf ${hexColor(o.color || '#111111').map(f3).join(' ')} rg ${o.charSpace ? f3(o.charSpace) + ' Tc ' : ''}${f3(tx)} ${f3(this._y(y))} Td ${pdfString(encodeWinAnsi(s))} Tj ET Q`);
    return this;
  }
  // Wraps a paragraph inside `width`; returns the y after the last line.
  paragraph(str, x, y, width, o) {
    o = o || {};
    const size = o.size || 9, lh = o.lineHeight || size * 1.35;
    const words = String(str || '').split(/\s+/).filter(Boolean);
    let line = '';
    words.forEach((wd) => {
      const t = line ? line + ' ' + wd : wd;
      if (this.measure(t, size, o.bold) > width && line) { this.text(line, x, y, o); y += lh; line = wd; }
      else line = t;
    });
    if (line) { this.text(line, x, y, o); y += lh; }
    return y;
  }
  // A picture (Buffer: PNG / JPEG / anything ffmpeg reads). Returns a
  // handle for image(), or null when it cannot be read.
  loadImage(buf, opts) {
    if (!buf || !buf.length) return null;
    const maxSide = (opts && opts.maxSide) || 512;
    const j = jpegInfo(buf);
    if (j && (j.comps === 3 || j.comps === 1) && !j.progressive) {
      const img = { id: 'Im' + (this.images.length + 1), width: j.width, height: j.height, kind: 'jpeg', data: buf, comps: j.comps };
      this.images.push(img);
      return img;
    }
    const png = decodePng(buf) || decodeWithFfmpeg(buf, this.ffmpegPath, maxSide);
    if (!png) return null;
    const img = { id: 'Im' + (this.images.length + 1), width: png.width, height: png.height, kind: 'raw', rgb: png.rgb, alpha: png.alpha };
    this.images.push(img);
    return img;
  }
  // Draws it inside the box keeping its proportions (never stretched).
  image(img, x, y, w, h, o) {
    if (!img) return this;
    const ar = img.width / img.height;
    let dw = w, dh = h;
    if (w / h > ar) dw = h * ar; else dh = w / ar;
    const dx = x + (w - dw) / 2, dy = y + (h - dh) / 2;
    this.cur.images.add(img.id);
    this._op(`q ${this._gs(o && o.opacity)}${f3(dw)} 0 0 ${f3(dh)} ${f3(dx)} ${f3(this._y(dy + dh))} cm /${img.id} Do Q`);
    return this;
  }
  output() {
    const chunks = [];
    const offsets = [];
    let length = 0;
    const push = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); chunks.push(buf); length += buf.length; };
    let nObj = 0;
    const objs = [];   // [num, body Buffer[]]
    const alloc = () => ++nObj;
    const catalog = alloc(), pagesNum = alloc(), fReg = alloc(), fBold = alloc(), infoNum = alloc();
    const imgNums = {};
    const imgObjs = [];
    this.images.forEach((img) => {
      const num = alloc();
      imgNums[img.id] = num;
      if (img.kind === 'jpeg') {
        imgObjs.push([num, [`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /${img.comps === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.data.length} >>\nstream\n`, img.data, '\nendstream']]);
      } else {
        let smask = '';
        if (img.alpha) {
          const sNum = alloc();
          const a = zlib.deflateSync(img.alpha);
          imgObjs.push([sNum, [`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${a.length} >>\nstream\n`, a, '\nendstream']]);
          smask = ` /SMask ${sNum} 0 R`;
        }
        const d = zlib.deflateSync(img.rgb);
        imgObjs.push([num, [`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smask} /Length ${d.length} >>\nstream\n`, d, '\nendstream']]);
      }
    });
    const gsNums = {};
    Object.keys(this.gstates).forEach((k) => { gsNums[k] = alloc(); objs.push([gsNums[k], [`<< /Type /ExtGState /ca ${f3(this.gstates[k])} /CA ${f3(this.gstates[k])} >>`]]); });
    const pageNums = [];
    this.pages.forEach((p) => {
      const content = zlib.deflateSync(Buffer.from(p.ops.join('\n'), 'latin1'));
      const cNum = alloc(), pNum = alloc();
      pageNums.push(pNum);
      const xo = [...p.images].map((id) => `/${id} ${imgNums[id]} 0 R`).join(' ');
      const gs = [...p.gstates].map((k) => `/${k} ${gsNums[k]} 0 R`).join(' ');
      objs.push([cNum, [`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, content, '\nendstream']]);
      objs.push([pNum, [`<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${f3(this.size.w)} ${f3(this.size.h)}] /Resources << /Font << /F1 ${fReg} 0 R /F2 ${fBold} 0 R >>${xo ? ' /XObject << ' + xo + ' >>' : ''}${gs ? ' /ExtGState << ' + gs + ' >>' : ''} >> /Contents ${cNum} 0 R >>`]]);
    });
    const infoStr = (v) => pdfString(encodeWinAnsi(v));
    const d = new Date();
    const pdfDate = 'D:' + d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
    objs.push([catalog, [`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`]]);
    objs.push([pagesNum, [`<< /Type /Pages /Kids [${pageNums.map((n) => n + ' 0 R').join(' ')}] /Count ${pageNums.length} >>`]]);
    objs.push([fReg, ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']]);
    objs.push([fBold, ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>']]);
    objs.push([infoNum, [`<< ${Object.keys(this.info).map((k) => `/${k} ${infoStr(this.info[k])}`).join(' ')} /CreationDate (${pdfDate}) >>`]]);
    imgObjs.forEach((o) => objs.push(o));
    objs.sort((a, b) => a[0] - b[0]);
    push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    objs.forEach(([num, parts]) => {
      offsets[num] = length;
      push(`${num} 0 obj\n`);
      parts.forEach(push);
      push('\nendobj\n');
    });
    const xref = length;
    let x = `xref\n0 ${nObj + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= nObj; i++) x += String(offsets[i] || 0).padStart(10, '0') + ' 00000 n \n';
    push(x);
    push(`trailer\n<< /Size ${nObj + 1} /Root ${catalog} 0 R /Info ${infoNum} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return Buffer.concat(chunks);
  }
}

module.exports = { PdfDoc, A4, decodePng, jpegInfo, hexColor, encodeWinAnsi };
