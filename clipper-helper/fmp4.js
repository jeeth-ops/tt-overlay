// ================================================================
// 📼 Fragmented-MP4 recording index — O(new data), not O(recording).
//
// Why: `ffmpeg -i rec.mp4` (duration probe) and `ffmpeg -ss T -i rec.mp4`
// (cut) on a fragmented MP4 that is still being written make ffmpeg's
// mov demuxer read EVERY fragment header in the file (~36 KB of disk
// reads per fragment). Measured: 193 MB of reads for one 18 s cut at the
// 3-hour mark of a 2-second-fragment recording. Over a 6–7 hour match
// that grows to ~0.5–1 GB of reads per probe (every 5 s) and per cut,
// competing with vMix writing the same disk — probes time out, the
// recording length goes stale, and clips start failing hours in.
//
// This walks the file's top-level boxes ONCE, then only the newly
// written ones on each refresh (a few small reads), and knows every
// fragment's byte range + time. A clip is cut by copying just the
// fragments around it (a few MB) into a small standalone fMP4 and
// running ffmpeg on that — constant cost at any point of the match.
//
// Works for fMP4 written by vMix/ffmpeg/OBS (ftyp + moov with mvex, then
// moof+mdat pairs). Anything else (non-fragmented MP4, MKV, TS…) reports
// `supported:false` and the caller falls back to plain ffmpeg.
// ================================================================
const fs = require('fs');

const MAX_BOX_READ = 16 * 1024 * 1024; // moov / moof are small; guard against garbage sizes

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return got === len ? buf : buf.subarray(0, got);
}

// Child boxes inside a box payload: [{type, start, size, hdr}] (offsets relative to `buf`).
function children(buf, from = 0, to = buf.length) {
  const out = [];
  let p = from;
  while (p + 8 <= to) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let hdr = 8;
    if (size === 1) { if (p + 16 > to) break; size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; }
    else if (size === 0) size = to - p;
    if (size < hdr || p + size > to) break;
    out.push({ type, start: p, size, hdr });
    p += size;
  }
  return out;
}
const find = (list, type) => list.find((b) => b.type === type);
const boxHdr = (buf) => (buf.readUInt32BE(0) === 1 ? 16 : 8);

// moov → { videoTrackId, timescale, trex: {trackId: {duration, flags}} }
function parseMoov(buf) {
  const moov = children(buf);
  const info = { videoTrackId: null, timescale: null, trex: {}, fragmented: false };
  for (const trak of moov.filter((b) => b.type === 'trak')) {
    const tk = children(buf, trak.start + trak.hdr, trak.start + trak.size);
    const tkhd = find(tk, 'tkhd');
    const mdia = find(tk, 'mdia');
    if (!tkhd || !mdia) continue;
    const tkv = buf[tkhd.start + tkhd.hdr];
    const trackId = buf.readUInt32BE(tkhd.start + tkhd.hdr + (tkv === 1 ? 20 : 12));
    const md = children(buf, mdia.start + mdia.hdr, mdia.start + mdia.size);
    const mdhd = find(md, 'mdhd');
    const hdlr = find(md, 'hdlr');
    if (!mdhd || !hdlr) continue;
    const handler = buf.toString('latin1', hdlr.start + hdlr.hdr + 8, hdlr.start + hdlr.hdr + 12);
    const mv = buf[mdhd.start + mdhd.hdr];
    const timescale = buf.readUInt32BE(mdhd.start + mdhd.hdr + (mv === 1 ? 20 : 12));
    if (handler === 'vide' && info.videoTrackId == null) { info.videoTrackId = trackId; info.timescale = timescale; }
  }
  const mvex = find(moov, 'mvex');
  if (mvex) {
    info.fragmented = true;
    for (const t of children(buf, mvex.start + mvex.hdr, mvex.start + mvex.size).filter((b) => b.type === 'trex')) {
      const o = t.start + t.hdr + 4;
      info.trex[buf.readUInt32BE(o)] = { duration: buf.readUInt32BE(o + 8), flags: buf.readUInt32BE(o + 16) };
    }
  }
  return info;
}

// moof → video track's { decodeTime, duration, sync, hasTfdt, baseOffsetPatches:[relPos] }
function parseMoof(buf, info) {
  const res = { decodeTime: null, duration: 0, sync: null, hasTfdt: false, basePatches: [] };
  for (const traf of children(buf).filter((b) => b.type === 'traf')) {
    const tb = children(buf, traf.start + traf.hdr, traf.start + traf.size);
    const tfhd = find(tb, 'tfhd');
    if (!tfhd) continue;
    let p = tfhd.start + tfhd.hdr;
    const tfFlags = buf.readUInt32BE(p) & 0xffffff; p += 4;
    const trackId = buf.readUInt32BE(p); p += 4;
    // Absolute base offsets must be rewritten when fragments are copied.
    if (tfFlags & 0x1) { res.basePatches.push(p); p += 8; }
    if (tfFlags & 0x2) p += 4;
    let defDur = null, defFlags = null;
    if (tfFlags & 0x8) { defDur = buf.readUInt32BE(p); p += 4; }
    if (tfFlags & 0x10) p += 4;
    if (tfFlags & 0x20) { defFlags = buf.readUInt32BE(p); p += 4; }
    if (trackId !== info.videoTrackId) continue;
    const trex = info.trex[trackId] || {};
    if (defDur == null) defDur = trex.duration || 0;
    if (defFlags == null) defFlags = trex.flags != null ? trex.flags : null;
    const tfdt = find(tb, 'tfdt');
    if (tfdt) {
      const v = buf[tfdt.start + tfdt.hdr];
      res.decodeTime = v === 1 ? Number(buf.readBigUInt64BE(tfdt.start + tfdt.hdr + 4)) : buf.readUInt32BE(tfdt.start + tfdt.hdr + 4);
      res.hasTfdt = true;
    }
    for (const trun of tb.filter((b) => b.type === 'trun')) {
      let q = trun.start + trun.hdr;
      const trFlags = buf.readUInt32BE(q) & 0xffffff; q += 4;
      const count = buf.readUInt32BE(q); q += 4;
      if (trFlags & 0x1) q += 4;
      let firstFlags = null;
      if (trFlags & 0x4) { firstFlags = buf.readUInt32BE(q); q += 4; }
      const per = ((trFlags & 0x100) ? 4 : 0) + ((trFlags & 0x200) ? 4 : 0) + ((trFlags & 0x400) ? 4 : 0) + ((trFlags & 0x800) ? 4 : 0);
      for (let i = 0; i < count; i++) {
        let r = q + i * per;
        let dur = defDur;
        if (trFlags & 0x100) { dur = buf.readUInt32BE(r); r += 4; }
        if (trFlags & 0x200) r += 4;
        let sflags = defFlags;
        if (trFlags & 0x400) sflags = buf.readUInt32BE(r);
        if (i === 0 && firstFlags != null) sflags = firstFlags;
        if (i === 0 && res.sync == null && sflags != null) res.sync = ((sflags >>> 16) & 1) === 0;
        res.duration += dur;
      }
    }
  }
  return res;
}

class Fmp4Index {
  constructor(file) {
    this.file = file;
    this.supported = null;     // null = unknown yet, false = not an fMP4 (use ffmpeg)
    this.info = null;
    this.initEnd = 0;          // bytes [0, initEnd) = ftyp + moov (+ anything before the 1st moof)
    this.next = 0;             // next top-level box offset to read
    this.frags = [];           // { moofOff, moofSize, mdatOff, mdatSize, t?: parsed times }
    this.pendingMoof = null;
    this.firstTime = null;     // decode time (ticks) of fragment 0
    this.cumTicks = 0;         // running start (ticks) when tfdt is absent
    this.refreshing = null;
    this.size = 0;
  }

  // Reads only boxes written since the last call.
  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this._refresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async _refresh() {
    if (this.supported === false) return this;
    const fh = await fs.promises.open(this.file, 'r');
    try {
      const { size } = await fh.stat();
      if (size < this.size) { Object.assign(this, new Fmp4Index(this.file)); } // file was replaced — start over
      this.size = size;
      while (this.next + 8 <= size) {
        const h = await readAt(fh, this.next, 16);
        if (h.length < 8) break;
        let bsize = h.readUInt32BE(0);
        const type = h.toString('latin1', 4, 8);
        if (bsize === 1) { if (h.length < 16) break; bsize = Number(h.readBigUInt64BE(8)); }
        else if (bsize === 0) break; // "to end of file" — only the last box of a finished file
        if (bsize < 8 || !/^[\x20-\x7e]{4}$/.test(type)) { if (!this.frags.length) this.supported = false; break; }
        if (this.next + bsize > size) break; // still being written — pick it up next time
        if (type === 'moov') {
          if (bsize > MAX_BOX_READ) { this.supported = false; break; }
          const buf = await readAt(fh, this.next, bsize);
          this.info = parseMoov(buf.subarray(boxHdr(buf)));
          if (!this.info.fragmented || this.info.videoTrackId == null || !this.info.timescale) { this.supported = false; break; }
        } else if (type === 'moof') {
          if (!this.info) { this.supported = false; break; }
          if (!this.initEnd) this.initEnd = this.next;
          this.pendingMoof = { moofOff: this.next, moofSize: bsize };
        } else if (type === 'mdat') {
          if (this.pendingMoof) {
            this.frags.push({ ...this.pendingMoof, mdatOff: this.next, mdatSize: bsize, t: null });
            this.pendingMoof = null;
          } else if (!this.info) { this.supported = false; break; } // media before any index = plain MP4
        }
        this.next += bsize;
      }
      if (this.info && this.frags.length && this.supported !== false) {
        this.supported = true;
        // Times: fragment 0 and the newest one are always parsed; others on demand.
        await this._times(fh, 0);
        await this._times(fh, this.frags.length - 1);
      }
    } finally {
      await fh.close();
    }
    return this;
  }

  async _times(fh, i) {
    const f = this.frags[i];
    if (f.t) return f.t;
    const buf = await readAt(fh, f.moofOff, Math.min(f.moofSize, MAX_BOX_READ));
    const m = parseMoof(buf.subarray(boxHdr(buf)), this.info);
    if (!m.hasTfdt) {
      // No tfdt: times are cumulative — walk from the last parsed fragment.
      let j = i; while (j > 0 && !this.frags[j - 1].t) j--;
      let start = j === 0 ? 0 : this.frags[j - 1].t.end;
      for (let k = j; k < i; k++) {
        const b = await readAt(fh, this.frags[k].moofOff, Math.min(this.frags[k].moofSize, MAX_BOX_READ));
        const mk = parseMoof(b.subarray(boxHdr(b)), this.info);
        this.frags[k].t = { start, end: start + mk.duration, sync: mk.sync, basePatches: mk.basePatches };
        start += mk.duration;
      }
      f.t = { start, end: start + m.duration, sync: m.sync, basePatches: m.basePatches };
    } else {
      f.t = { start: m.decodeTime, end: m.decodeTime + m.duration, sync: m.sync, basePatches: m.basePatches };
    }
    if (i === 0) this.firstTime = f.t.start;
    return f.t;
  }

  // Seconds of complete fragments written so far.
  get durationSec() {
    if (!this.supported || !this.frags.length) return 0;
    const last = this.frags[this.frags.length - 1].t;
    const first = this.frags[0].t;
    if (!last || !first) return 0;
    return (last.end - first.start) / this.info.timescale;
  }

  // Copies init + the fragments covering [fromSec, toSec] (seconds from the
  // recording's start) into `outFile`, starting on a keyframe fragment.
  // Returns { startSec } = recording time of the first copied fragment, so
  // the caller cuts with -ss (fromSec - startSec) on the small file.
  async extract(fromSec, toSec, outFile, { leadSec = 4, maxBackSec = 60 } = {}) {
    if (!this.supported) throw new Error('not a fragmented MP4');
    const ts = this.info.timescale;
    const base = this.firstTime || 0;
    const want0 = base + Math.max(0, fromSec - leadSec) * ts;
    const want1 = base + toSec * ts;
    const fh = await fs.promises.open(this.file, 'r');
    let out;
    try {
      // Newest fragment backwards to the one containing want0 (times are monotonic).
      let hi = this.frags.length - 1;
      let lo = hi;
      while (lo > 0) {
        const t = await this._times(fh, lo);
        if (t.start <= want0) break;
        lo--;
      }
      // Start on a keyframe (when the file says which fragments start with one).
      const limit = base + Math.max(0, fromSec - maxBackSec) * ts;
      while (lo > 0) {
        const t = await this._times(fh, lo);
        if (t.sync !== false || t.start <= limit) break;
        lo--;
      }
      while (hi > lo) {
        const t = await this._times(fh, hi - 1);
        if (t.end < want1) break;
        hi--;
      }
      const first = await this._times(fh, lo);
      out = await fs.promises.open(outFile, 'w');
      const init = await readAt(fh, 0, this.initEnd);
      await out.write(init, 0, init.length, 0);
      let pos = init.length;
      for (let i = lo; i <= hi; i++) {
        const f = this.frags[i];
        const t = await this._times(fh, i);
        const moof = await readAt(fh, f.moofOff, f.moofSize);
        for (const rel of t.basePatches) { // absolute base_data_offset → new position
          const at = boxHdr(moof) + rel;
          const old = Number(moof.readBigUInt64BE(at));
          moof.writeBigUInt64BE(BigInt(old - f.moofOff + pos), at);
        }
        await out.write(moof, 0, moof.length, pos);
        pos += moof.length;
        // mdat in 4 MB chunks.
        for (let o = 0; o < f.mdatSize; o += 4 * 1024 * 1024) {
          const chunk = await readAt(fh, f.mdatOff + o, Math.min(4 * 1024 * 1024, f.mdatSize - o));
          await out.write(chunk, 0, chunk.length, pos);
          pos += chunk.length;
        }
      }
      return { startSec: (first.start - base) / ts, bytes: pos, fragments: hi - lo + 1 };
    } finally {
      if (out) await out.close();
      await fh.close();
    }
  }
}

module.exports = { Fmp4Index };
