'use strict';
/**
 * highlight-wheel.js — the animated wagon wheel of the pro highlight edit.
 *
 * The same field as the scorecard's commentary wheels (cricket-scorecard.html,
 * overWheelSvg): boundary radius 100, 30-yard circle 55, the batter at the top
 * end (0, -11.5), a shot's x/y simply where the ball went. Drawn here, frame
 * by frame, as raw RGBA for ffmpeg to lay over a clip:
 *
 *   plate — the field pops in (scale + fade) and then holds;
 *   shot  — on a transparent picture: the shot's line grows from the batter
 *           to where the ball went (a six flies on a curve), a bright head
 *           running along it, then the end marker springs in with a pulse.
 *           A wicket with no shot (bowled, lbw…) flashes the stumps instead.
 *
 * Every frame is computed, so the motion is as smooth as the frame rate.
 * Shapes are signed distances, coverage clamp(0.5 - d), so every edge is
 * anti-aliased. Node core only.
 */

const VIEW = 112;               // field units from the centre to the picture's edge
const BAT = [0, -11.5];         // the batter's end
const STUMPS_MARK = [0, -29];   // a wicket with no shot: its marker, just behind the stumps
const FIELD_COLOURS = { centre: [70, 163, 55], mid: [49, 138, 41], edge: [36, 113, 31], stands: [23, 73, 26] };
// line / marker colours by what the shot was (as on the scorecard's wheels)
const KINDS = {
  SIX: { line: [211, 155, 255], width: 3.8, mark: [155, 76, 240] },
  FOUR: { line: [108, 178, 255], width: 3.6, mark: [47, 127, 240] },
  RUN: { line: [255, 255, 255], width: 2.6, mark: [255, 255, 255] },
  WICKET: { line: [255, 107, 107], width: 3.4, mark: [239, 68, 68] }
};
const PLATE_SEC = 0.36;         // the field popping in
const DRAW_SEC = 0.62;          // the line growing
const POP_SEC = 0.28;           // the end marker springing in
const PULSE_SEC = 0.55;         // one pulse out of the end marker
const SHOT_SEC = DRAW_SEC + POP_SEC + PULSE_SEC + 0.05;
const MARK_R = 8.6;             // the end marker's radius (field units): big enough for its number

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (u) => 1 - Math.pow(1 - u, 3);
const easeOutBack = (u) => 1 + 2.70158 * Math.pow(u - 1, 3) + 1.70158 * Math.pow(u - 1, 2);

// Where a shot ended, in field units: a boundary always reaches the rope; a
// shot with only a region gets the middle of it (scorecard's owPoint).
const ZONE_FROM = { fineleg: 0, squareleg: 45, midwicket: 90, midon: 135, midoff: 180, cover: 225, point: 270, thirdman: 315 };
function shotPoint(shot, toRope) {
  const x = Number(shot && shot.x), y = Number(shot && shot.y);
  if (isFinite(x) && isFinite(y) && (x || y)) {
    const px = x * 100, py = y * 100, r = Math.hypot(px, py);
    return toRope && r ? [px * 100 / r, py * 100 / r] : [px, py];
  }
  const z = shot && ZONE_FROM[shot.zone];
  if (z == null) return null;
  const mid = z + 22.5, deg = (shot.hand === 'L' ? 360 - mid : mid) * Math.PI / 180;
  const r = toRope ? 100 : shot.depth === 'deep' ? 82 : 40;
  return [r * Math.sin(deg), -r * Math.cos(deg)];
}

/* ------------------------------------------------------------- the canvas */
// A premultiplied RGBA float canvas, size × size, drawn in field units.
function canvas(size, scale = 1) {
  const px = new Float32Array(size * size * 4);
  const k = size / (2 * VIEW) * scale, c = size / 2;
  const toPx = (u, v) => [c + u * k, c + v * k];
  // Composite colour [r,g,b] (0-255) at alpha a over the pixels of a shape
  // given by its signed distance in PIXELS, within a pixel box.
  function fill(box, dist, rgb, a, shade) {
    const x0 = Math.max(0, Math.floor(box[0])), y0 = Math.max(0, Math.floor(box[1]));
    const x1 = Math.min(size - 1, Math.ceil(box[2])), y1 = Math.min(size - 1, Math.ceil(box[3]));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const cov = clamp01(0.5 - dist(x + 0.5, y + 0.5));
        if (cov <= 0) continue;
        const col = shade ? shade(x + 0.5, y + 0.5) : rgb;
        if (!col) continue;
        const al = a * cov, i = (y * size + x) * 4, inv = 1 - al;
        px[i] = col[0] / 255 * al + px[i] * inv;
        px[i + 1] = col[1] / 255 * al + px[i + 1] * inv;
        px[i + 2] = col[2] / 255 * al + px[i + 2] * inv;
        px[i + 3] = al + px[i + 3] * inv;
      }
    }
  }
  const api = {
    size, k, toPx, px,
    circle(u, v, r, rgb, a, shade) {
      const [cx, cy] = toPx(u, v), R = r * k;
      fill([cx - R - 1, cy - R - 1, cx + R + 1, cy + R + 1], (x, y) => Math.hypot(x - cx, y - cy) - R, rgb, a, shade);
    },
    ring(u, v, r, w, rgb, a, dash) {
      const [cx, cy] = toPx(u, v), R = r * k, W = Math.max(0.6, w * k) / 2;
      fill([cx - R - W - 1, cy - R - W - 1, cx + R + W + 1, cy + R + W + 1], (x, y) => {
        const d = Math.abs(Math.hypot(x - cx, y - cy) - R) - W;
        if (!dash) return d;
        // dashes along the circumference: `on` of every `period` field units
        const along = (Math.atan2(y - cy, x - cx) + Math.PI) * r, ph = along % dash.period;
        return Math.max(d, (ph < dash.on ? 0 : Math.min(ph - dash.on, dash.period - ph)) * k - 0.5);
      }, rgb, a);
    },
    rect(u0, v0, u1, v1, rgb, a) {
      const [x0, y0] = toPx(u0, v0), [x1, y1] = toPx(u1, v1);
      fill([x0 - 1, y0 - 1, x1 + 1, y1 + 1], (x, y) => Math.max(x0 - x, x - x1, y0 - y, y - y1), rgb, a);
    },
    // A round-capped stroke along points (field units), the first `upTo`
    // of its length only (0…1).
    stroke(pts, w, rgb, a, upTo = 1) {
      const P = pts.map(([u, v]) => toPx(u, v)), segs = [];
      let total = 0;
      for (let i = 1; i < P.length; i++) { const l = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); segs.push(l); total += l; }
      let left = total * clamp01(upTo);
      const Q = [P[0]];
      for (let i = 1; i < P.length && left > 0; i++) {
        const l = segs[i - 1];
        if (l <= left) { Q.push(P[i]); left -= l; } else { const t = left / l; Q.push([P[i - 1][0] + (P[i][0] - P[i - 1][0]) * t, P[i - 1][1] + (P[i][1] - P[i - 1][1]) * t]); left = 0; }
      }
      if (Q.length < 2) return Q[0];
      const W = Math.max(0.7, w * k) / 2;
      // the stroke's coverage: each segment's capsule over its own little
      // box (max where they meet), then ONE composite — a joint is never
      // painted twice
      const xs = Q.map(q => q[0]), ys = Q.map(q => q[1]);
      const X0 = Math.max(0, Math.floor(Math.min(...xs) - W - 1)), Y0 = Math.max(0, Math.floor(Math.min(...ys) - W - 1));
      const X1 = Math.min(size - 1, Math.ceil(Math.max(...xs) + W + 1)), Y1 = Math.min(size - 1, Math.ceil(Math.max(...ys) + W + 1));
      const bw = X1 - X0 + 1, cov = new Float32Array(bw * (Y1 - Y0 + 1));
      for (let i = 1; i < Q.length; i++) {
        const ax = Q[i - 1][0], ay = Q[i - 1][1], bx = Q[i][0] - ax, by = Q[i][1] - ay, l2 = bx * bx + by * by;
        const sx0 = Math.max(X0, Math.floor(Math.min(ax, Q[i][0]) - W - 1)), sx1 = Math.min(X1, Math.ceil(Math.max(ax, Q[i][0]) + W + 1));
        const sy0 = Math.max(Y0, Math.floor(Math.min(ay, Q[i][1]) - W - 1)), sy1 = Math.min(Y1, Math.ceil(Math.max(ay, Q[i][1]) + W + 1));
        for (let y = sy0; y <= sy1; y++) {
          for (let x = sx0; x <= sx1; x++) {
            const fx = x + 0.5, fy = y + 0.5, t = l2 ? clamp01(((fx - ax) * bx + (fy - ay) * by) / l2) : 0;
            const c = clamp01(0.5 - (Math.hypot(fx - ax - bx * t, fy - ay - by * t) - W)), j = (y - Y0) * bw + (x - X0);
            if (c > cov[j]) cov[j] = c;
          }
        }
      }
      fill([X0, Y0, X1, Y1], (x, y) => 0.5 - cov[(Math.floor(y) - Y0) * bw + (Math.floor(x) - X0)], rgb, a);
      return Q[Q.length - 1];
    },
    // Straight (premultiplied → plain) RGBA bytes, the picture's alpha × fade.
    bytes(fade = 1) {
      const out = Buffer.alloc(size * size * 4);
      for (let i = 0; i < px.length; i += 4) {
        const al = px[i + 3];
        if (al <= 0) continue;
        out[i] = Math.round(Math.min(1, px[i] / al) * 255);
        out[i + 1] = Math.round(Math.min(1, px[i + 1] / al) * 255);
        out[i + 2] = Math.round(Math.min(1, px[i + 2] / al) * 255);
        out[i + 3] = Math.round(al * fade * 255);
      }
      return out;
    }
  };
  return api;
}

/* -------------------------------------------------------------- the field */
function drawField(cv) {
  const { k, toPx } = cv, [cx, cy] = toPx(0, 0);
  // a dark plate round the field, so it reads over any picture
  cv.circle(0, 0, 111, [8, 14, 28], 0.82);
  // grass: lighter in the middle, the stands' dark ring outside the rope
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  cv.circle(0, 0, 108, null, 1, (x, y) => {
    const r = Math.hypot(x - cx, y - cy) / k;
    if (r > 100.4) return FIELD_COLOURS.stands;
    return r < 65 ? mix(FIELD_COLOURS.centre, FIELD_COLOURS.mid, r / 65) : mix(FIELD_COLOURS.mid, FIELD_COLOURS.edge, (r - 65) / 35);
  });
  // mowing stripes: every other 22.5° wedge a touch lighter
  cv.circle(0, 0, 100, null, 0.06, (x, y) => {
    const a = (Math.atan2(x - cx, -(y - cy)) * 180 / Math.PI + 360) % 360;
    return Math.floor(a / 22.5) % 2 ? null : [255, 255, 255];
  });
  cv.ring(0, 0, 55, 1, [255, 255, 255], 0.5, { on: 3, period: 5.6 });
  cv.ring(0, 0, 100, 2, [255, 255, 255], 0.92);
  cv.rect(-4.2, -15, 4.2, 15, [216, 181, 122], 1);
  cv.rect(-5.5, -11.9, 5.5, -11.1, [255, 255, 255], 0.9);
  cv.rect(-5.5, 11.1, 5.5, 11.9, [255, 255, 255], 0.9);
  cv.circle(BAT[0], BAT[1], 3.3, [21, 128, 61], 1);
  cv.circle(BAT[0], BAT[1], 2.4, [255, 255, 255], 1);
}

/* ---------------------------------------------------------------- frames */
// A drawn canvas scaled about its centre by s (bilinear, premultiplied), as
// straight RGBA bytes faded by `fade`.
function scaledBytes(cv, s, fade) {
  const { size, px } = cv, c = size / 2, out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const sy = c + (y + 0.5 - c) / s - 0.5, y0 = Math.floor(sy), fy = sy - y0;
    if (y0 < -1 || y0 >= size) continue;
    for (let x = 0; x < size; x++) {
      const sx = c + (x + 0.5 - c) / s - 0.5, x0 = Math.floor(sx), fx = sx - x0;
      if (x0 < -1 || x0 >= size) continue;
      const acc = [0, 0, 0, 0];
      [[x0, y0, (1 - fx) * (1 - fy)], [x0 + 1, y0, fx * (1 - fy)], [x0, y0 + 1, (1 - fx) * fy], [x0 + 1, y0 + 1, fx * fy]].forEach(([xx, yy, wgt]) => {
        if (xx < 0 || yy < 0 || xx >= size || yy >= size || !wgt) return;
        const i = (yy * size + xx) * 4;
        acc[0] += px[i] * wgt; acc[1] += px[i + 1] * wgt; acc[2] += px[i + 2] * wgt; acc[3] += px[i + 3] * wgt;
      });
      if (acc[3] <= 0) continue;
      const o = (y * size + x) * 4;
      out[o] = Math.round(Math.min(1, acc[0] / acc[3]) * 255);
      out[o + 1] = Math.round(Math.min(1, acc[1] / acc[3]) * 255);
      out[o + 2] = Math.round(Math.min(1, acc[2] / acc[3]) * 255);
      out[o + 3] = Math.round(acc[3] * fade * 255);
    }
  }
  return out;
}

// The field popping in, then holding: n frames of size × size RGBA. Drawn
// once; each frame of the pop is that drawing, scaled.
function plateFrames({ size, fps }) {
  const n = Math.max(1, Math.round(PLATE_SEC * fps));
  const base = canvas(size);
  drawField(base);
  const frames = [];
  for (let j = 0; j < n; j++) {
    const u = clamp01((j + 1) / n);
    frames.push(u >= 1 ? base.bytes() : scaledBytes(base, 0.86 + 0.14 * easeOutBack(u), easeOut(u)));
  }
  return { n, data: Buffer.concat(frames) };
}

// The path a shot takes on the field: a six flies (a curve), the rest run
// along the ground (scorecard's overWheelSvg).
function shotPath(spec) {
  const [ex, ey] = spec.end;
  if (spec.kind !== 'SIX') return [BAT, [ex, ey]];
  const [bx, by] = BAT, qx = (bx + ex) / 2 + (ey - by) * 0.18, qy = (by + ey) / 2 - (ex - bx) * 0.18, pts = [];
  for (let i = 0; i <= 32; i++) { const t = i / 32; pts.push([(1 - t) * (1 - t) * bx + 2 * (1 - t) * t * qx + t * t * ex, (1 - t) * (1 - t) * by + 2 * (1 - t) * t * qy + t * t * ey]); }
  return pts;
}

// The shot on a transparent picture (to lay over the plate). spec: { kind:
// SIX | FOUR | RUN | WICKET, end: [x, y] field units, or null for a wicket at
// the stumps }.
function shotFrames({ size, fps, spec }) {
  const n = Math.max(2, Math.round(SHOT_SEC * fps));
  const look = KINDS[spec.kind] || KINDS.RUN, frames = [];
  const path = spec.end ? shotPath(spec) : null;
  for (let j = 0; j < n; j++) {
    const t = (j + 1) / fps, cv = canvas(size);
    if (path) {
      const f = easeOut(clamp01(t / DRAW_SEC));
      cv.stroke(path, look.width + 3.2, [5, 30, 10], 0.5, f);                 // a dark halo under the line
      const head = cv.stroke(path, look.width, look.line, 1, f);
      if (f < 1 && head) {                                                    // the bright head running along it
        const u = (head[0] - cv.size / 2) / cv.k, v = (head[1] - cv.size / 2) / cv.k;
        cv.circle(u, v, look.width * 1.5, [255, 255, 255], 0.35);
        cv.circle(u, v, look.width * 0.75, [255, 255, 255], 0.95);
      }
    }
    const at = path ? path[path.length - 1] : STUMPS_MARK;
    const tp = t - (path ? DRAW_SEC - 0.06 : 0.12);
    if (tp > 0) {
      // one pulse out of the end (or the stumps)
      const up = clamp01(tp / PULSE_SEC), from = path ? at : BAT;
      if (up < 1) cv.ring(from[0], from[1], MARK_R + 18 * easeOut(up), 1.6, look.mark, 0.75 * (1 - up));
      // the marker springs in
      const s = easeOutBack(clamp01(tp / POP_SEC));
      cv.circle(at[0], at[1], (MARK_R + 1.5) * s, [255, 255, 255], 1);
      cv.circle(at[0], at[1], MARK_R * s, look.mark, 1);
    }
    if (!path) {                                                              // the stumps, flashing red
      const red = clamp01(t / 0.18);
      const col = [255, 255 - 160 * red, 255 - 160 * red];
      [-1.7, 0, 1.7].forEach(dx => cv.rect(BAT[0] + dx - 0.5, BAT[1] - 7.5, BAT[0] + dx + 0.5, BAT[1] - 1, col, 1));
      cv.rect(BAT[0] - 2.4, BAT[1] - 8.4, BAT[0] + 2.4, BAT[1] - 7.6, col, 1);
    }
    frames.push(cv.bytes());
  }
  return { n, data: Buffer.concat(frames) };
}

// Where (in pixels of a size × size wheel) the end marker sits, and its
// radius — for the number drawn on it.
function markerPx(size, spec) {
  const k = size / (2 * VIEW), c = size / 2;
  const at = spec.end || STUMPS_MARK;
  return { x: c + at[0] * k, y: c + at[1] * k, r: MARK_R * k };
}

module.exports = { shotPoint, plateFrames, shotFrames, markerPx, timings: { PLATE_SEC, DRAW_SEC, POP_SEC, PULSE_SEC, SHOT_SEC } };
