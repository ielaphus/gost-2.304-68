/*
 * ttf2dxf.js - TrueType -> DXF polylines (R12) for CAD / CNC / 3D print.
 *
 *   node ttf2dxf.js info <font.ttf>
 *   node ttf2dxf.js dump <font.ttf> <cpHex,cpHex,...>
 *   node ttf2dxf.js dxf  <font.ttf> <out.dxf> [lowerMm] [slantDeg] [outline|wire|center]
 *
 * outline : every contour as a closed polyline  (GOST / TrueType look, ready to
 *           extrude or to cut outlines)
 * wire    : hairline ribbon -> the outbound half of the ribbon loop, i.e. one
 *           line per stroke (CamBam stick fonts)
 * center  : true centreline = midpoint between the two walls of a thin stroke
 *           (needs a hairline font; refuses thick contours)
 */
'use strict';
const fs = require('fs');

/* ------------------------------- TTF reader ------------------------------- */
function loadFont(file) {
  const buf = fs.readFileSync(file);
  const u8 = o => buf.readUInt8(o);
  const u16 = o => buf.readUInt16BE(o);
  const i16 = o => buf.readInt16BE(o);
  const u32 = o => buf.readUInt32BE(o);
  const f2 = o => i16(o) / 16384;

  const numTables = u16(4);
  const t = {};
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    t[buf.toString('ascii', o, o + 4)] = { offset: u32(o + 8), length: u32(o + 12) };
  }
  const { head, maxp, hhea, hmtx, loca, glyf, cmap } = t;
  if (!head || !maxp || !hhea || !hmtx || !loca || !glyf || !cmap) throw new Error('missing required table');

  const unitsPerEm = u16(head.offset + 18);
  const indexToLocFormat = i16(head.offset + 50);
  const numGlyphs = u16(maxp.offset + 4);
  const numberOfHMetrics = u16(hhea.offset + 34);

  const locaArr = new Array(numGlyphs + 1);
  for (let i = 0; i <= numGlyphs; i++) {
    locaArr[i] = indexToLocFormat === 0 ? u16(loca.offset + i * 2) * 2 : u32(loca.offset + i * 4);
  }
  const advance = gid => gid < numberOfHMetrics ? u16(hmtx.offset + gid * 4) : u16(hmtx.offset + (numberOfHMetrics - 1) * 4);

  let best = null, bestScore = -1;
  const nSub = u16(cmap.offset + 2);
  for (let i = 0; i < nSub; i++) {
    const rec = cmap.offset + 4 + i * 8;
    const pid = u16(rec), eid = u16(rec + 2), off = u32(rec + 4);
    let score = 0;
    if (pid === 3 && eid === 1) score = 4;
    else if (pid === 3 && eid === 10) score = 3;
    else if (pid === 0) score = 2;
    else if (pid === 3 && eid === 0) score = 1;
    if (score > bestScore) { bestScore = score; best = cmap.offset + off; }
  }
  const fmt = u16(best);
  const map = new Map();
  if (fmt === 4) {
    const segX2 = u16(best + 6), seg = segX2 / 2;
    const endO = best + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
    for (let s = 0; s < seg; s++) {
      const end = u16(endO + 2 * s), start = u16(startO + 2 * s);
      const delta = i16(deltaO + 2 * s), ro = u16(rangeO + 2 * s);
      if (start === 0xffff) continue;
      for (let c = start; c <= end; c++) {
        let g;
        if (ro === 0) g = (c + delta) & 0xffff;
        else { g = u16(rangeO + 2 * s + ro + 2 * (c - start)); if (g !== 0) g = (g + delta) & 0xffff; }
        if (g !== 0) map.set(c, g);
      }
    }
  } else if (fmt === 12) {
    const nGroups = u32(best + 12);
    for (let i = 0; i < nGroups; i++) {
      const o = best + 16 + i * 12;
      const s = u32(o), e = u32(o + 4), g = u32(o + 8);
      for (let c = s; c <= e; c++) map.set(c, g + (c - s));
    }
  } else throw new Error('unsupported cmap format ' + fmt);

  function simpleGlyph(base, nc) {
    const endPts = [];
    for (let i = 0; i < nc; i++) endPts.push(u16(base + 10 + 2 * i));
    let o = base + 10 + 2 * nc;
    const instrLen = u16(o); o += 2 + instrLen;
    const n = endPts[nc - 1] + 1;
    const flags = [];
    while (flags.length < n) {
      const f = u8(o++); flags.push(f);
      if (f & 8) { const r = u8(o++); for (let k = 0; k < r; k++) flags.push(f); }
    }
    const xs = new Array(n), ys = new Array(n);
    let v = 0;
    for (let i = 0; i < n; i++) {
      const f = flags[i];
      if (f & 2) { const d = u8(o++); v += (f & 16) ? d : -d; }
      else if (!(f & 16)) { v += i16(o); o += 2; }
      xs[i] = v;
    }
    v = 0;
    for (let i = 0; i < n; i++) {
      const f = flags[i];
      if (f & 4) { const d = u8(o++); v += (f & 32) ? d : -d; }
      else if (!(f & 32)) { v += i16(o); o += 2; }
      ys[i] = v;
    }
    const out = [];
    let start = 0;
    for (const e of endPts) {
      const c = [];
      for (let i = start; i <= e; i++) c.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) });
      out.push(c); start = e + 1;
    }
    return out;
  }

  function compositeGlyph(base, depth, comps) {
    let o = base + 10, more = true;
    const out = [];
    while (more) {
      const flags = u16(o); o += 2;
      const gid = u16(o); o += 2;
      let dx, dy;
      if (flags & 1) { dx = i16(o); dy = i16(o + 2); o += 4; }
      else { dx = (u8(o) << 24) >> 24; dy = (u8(o + 1) << 24) >> 24; o += 2; }
      let a = 1, b = 0, c = 0, d = 1;
      if (flags & 8) { a = d = f2(o); o += 2; }
      else if (flags & 0x40) { a = f2(o); d = f2(o + 2); o += 4; }
      else if (flags & 0x80) { a = f2(o); b = f2(o + 2); c = f2(o + 4); d = f2(o + 6); o += 8; }
      if (comps) comps.push({ gid, dx, dy });
      for (const ctr of rawGlyph(gid, depth + 1)) {
        out.push(ctr.map(p => ({ x: a * p.x + c * p.y + dx, y: b * p.x + d * p.y + dy, on: p.on })));
      }
      more = !!(flags & 0x20);
    }
    return out;
  }

  const rawCache = new Map();
  function rawGlyph(gid, depth) {
    depth = depth || 0;
    if (depth > 5) return [];
    if (rawCache.has(gid)) return rawCache.get(gid);
    const off = locaArr[gid], next = locaArr[gid + 1];
    let res = [];
    if (gid < numGlyphs && next > off) {
      const nc = i16(glyf.offset + off);
      res = nc >= 0 ? simpleGlyph(glyf.offset + off, nc) : compositeGlyph(glyf.offset + off, depth, null);
    }
    rawCache.set(gid, res);
    return res;
  }

  function glyphMeta(gid) {
    const off = locaArr[gid], next = locaArr[gid + 1];
    if (gid >= numGlyphs || next <= off) return { gid, off, len: 0, nc: null, composite: false, comps: [] };
    const base = glyf.offset + off;
    const nc = i16(base);
    let comps = null;
    if (nc < 0) { comps = []; compositeGlyph(base, 0, comps); }
    return { gid, off, len: next - off, nc, composite: nc < 0, comps: comps || [] };
  }

  return { unitsPerEm, numGlyphs, map, gidFor: cp => map.get(cp) || 0, rawGlyph, advance, glyphMeta };
}

/* ----------------------------- geometry utils ----------------------------- */
function flatten(contour, steps) {
  let pts = contour.slice();
  const n = pts.length;
  if (n === 0) return [];
  let idx = pts.findIndex(p => p.on);
  if (idx < 0) {
    const mid = [];
    for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; mid.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true }); }
    pts = mid; idx = 0;
  }
  pts = pts.slice(idx).concat(pts.slice(0, idx));
  const seq = [];
  for (let i = 0; i < pts.length; i++) {
    const cur = pts[i], next = pts[(i + 1) % pts.length];
    seq.push(cur);
    if (!cur.on && !next.on) seq.push({ x: (cur.x + next.x) / 2, y: (cur.y + next.y) / 2, on: true });
  }
  seq.push(seq[0]);
  const out = [{ x: seq[0].x, y: seq[0].y }];
  for (let i = 0; i < seq.length - 1; i++) {
    const p0 = seq[i], p1 = seq[i + 1];
    if (p1.on) out.push({ x: p1.x, y: p1.y });
    else {
      const p2 = seq[i + 2];
      for (let s = 1; s <= steps; s++) {
        const t = s / steps, mt = 1 - t;
        out.push({ x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x, y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y });
      }
      i++;
    }
  }
  return out;
}

function dedupe(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    if (i === 0 || Math.hypot(pts[i].x - out[out.length - 1].x, pts[i].y - out[out.length - 1].y) > 1e-6) out.push(pts[i]);
  }
  if (out.length > 2 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1e-6) out.pop();
  return out;
}

function resample(a, spacing) {
  const out = [{ x: a[0].x, y: a[0].y }];
  let carry = spacing;
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = a[(i + 1) % a.length];
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < 1e-9) continue;
    let t = carry;
    while (t < d) {
      const k = t / d;
      out.push({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k });
      t += spacing;
    }
    carry = t - d;
  }
  return out;
}

function rdp(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    const a = pts[i0], b = pts[i1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    let imax = -1, dmax = tol;
    for (let i = i0 + 1; i < i1; i++) {
      const p = pts[i];
      const d = len < 1e-9 ? Math.hypot(p.x - a.x, p.y - a.y)
        : Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
      if (d > dmax) { dmax = d; imax = i; }
    }
    if (imax > 0) { keep[imax] = 1; stack.push([i0, imax], [imax, i1]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function contourAreaPerim(a) {
  let area = 0, per = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = a[(i + 1) % a.length];
    area += p.x * q.y - q.x * p.y;
    per += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return { area: Math.abs(area / 2), per };
}

/* --------------------------- contour -> polylines -------------------------- */
function contourToPiece(poly, policy) {
  const a = dedupe(poly);
  if (a.length < 2) return null;
  if (policy === 'outline') return { closed: true, pts: a };
  const { area, per } = contourAreaPerim(a);
  const ref = per * per / (4 * Math.PI);
  const thin = ref > 0 && area / ref <= 0.03;
  if (!thin) return { closed: true, pts: a };      // thick shape: keep as is
  const n = a.length;
  let cx = 0, cy = 0;
  for (const p of a) { cx += p.x; cy += p.y; }
  cx /= n; cy /= n;
  let far = 0, fd = -1;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(a[i].x - cx, a[i].y - cy);
    if (d > fd) { fd = d; far = i; }
  }
  const out = a.slice(0, far + 1);
  return out.length >= 2 ? { closed: false, pts: out } : null;
}

function glyphPolys(font, cp, steps, policy) {
  const res = [];
  for (const c of font.rawGlyph(font.gidFor(cp), 0)) {
    const poly = flatten(c, steps);
    if (poly.length < 2) continue;
    const p = contourToPiece(poly, policy);
    if (p) res.push(p);
  }
  return res;
}

/* True centreline: pair each boundary point with the nearest point of the
   opposite wall; the midpoint lies on the centreline. Only for hairlines. */
function centerPolys(font, cp, steps, maxWidthEm) {
  const conts = [];
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, area = 0;
  const ribbons = [];
  const rawConts = font.rawGlyph(font.gidFor(cp), 0);
  for (const c of rawConts) {
    const a = dedupe(flatten(c, steps));
    if (a.length < 3) continue;
    const ap = contourAreaPerim(a);
    area += ap.area;
    if (ap.per > 0) ribbons.push(ap.area / ap.per * 2);
    for (const p of a) {
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    conts.push(resample(a, 5));
  }
  if (!conts.length) return [];
  // a small solid dot (period, dieresis) is better as its own outline
  const bw = x1 - x0, bh = y1 - y0;
  if (bh > 0 && bw > 0 && bh < 0.35 * font.unitsPerEm && area / (bw * bh) > 0.45) {
    const res = [];
    for (const c of rawConts) {
      const a = dedupe(flatten(c, steps));
      if (a.length >= 3) res.push({ closed: true, pts: a });
    }
    res.meanWidth = 0;
    return res;
  }
  // wall-to-wall search radius: must exceed the stroke width but stay below
  // the gap between separate strokes, so a fixed fraction of the em is used
  const maxW = maxWidthEm * font.unitsPerEm;
  const flat = [];
  conts.forEach((a, ci) => a.forEach((p, pi) => flat.push({ x: p.x, y: p.y, ci, pi })));
  const nn = new Int32Array(flat.length).fill(-1);
  const nd = new Float64Array(flat.length).fill(1e18);
  for (let i = 0; i < flat.length; i++) {
    const p = flat[i];
    for (let j = 0; j < flat.length; j++) {
      if (j === i) continue;
      const q = flat[j];
      if (q.ci === p.ci) {
        const n = conts[p.ci].length;
        const dIdx = Math.abs(q.pi - p.pi);
        if (dIdx < 10 || n - dIdx < 10) continue;
      }
      const dx = q.x - p.x, dy = q.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < nd[i]) { nd[i] = d2; nn[i] = j; }
    }
  }
  const mids = [];
  let widthSum = 0, widthN = 0;
  for (let i = 0; i < flat.length; i++) {
    const j = nn[i];
    if (j < 0 || nn[j] !== i || nd[i] > maxW * maxW) continue;   // mutual nearest only
    const w = Math.sqrt(nd[i]);
    widthSum += w; widthN++;
    mids.push({ x: (flat[i].x + flat[j].x) / 2, y: (flat[i].y + flat[j].y) / 2 });
  }
  if (!mids.length) return [];
  const meanW = widthN ? widthSum / widthN : 0;
  const seqs = [];
  let cur = [mids[0]];
  for (let i = 1; i < mids.length; i++) {
    const a = mids[i - 1], b = mids[i];
    if (Math.hypot(b.x - a.x, b.y - a.y) > Math.max(20, 4 * meanW)) { seqs.push(cur); cur = [b]; }
    else cur.push(b);
  }
  seqs.push(cur);
  const res = [];
  for (let s of seqs) {
    if (s.length < 2) continue;
    let closed = Math.hypot(s[0].x - s[s.length - 1].x, s[0].y - s[s.length - 1].y) < 12;
    if (closed) s = s.slice(0, s.length - 1);
    const simp = rdp(s, 2.5);
    if (simp.length < 2) continue;
    let len = 0;
    for (let i = 1; i < simp.length; i++) len += Math.hypot(simp[i].x - simp[i - 1].x, simp[i].y - simp[i - 1].y);
    if (len < Math.max(15, 3 * meanW)) continue;                 // junction crumbs
    res.push({ closed: closed && simp.length > 2, pts: simp });
  }
  res.meanWidth = meanW;
  return res;
}

/* ------------------- centreline skeleton (CNC tool path) ------------------- */
/* The letters are constant width strokes, so the medial axis of the filled
   outline IS the tool path: rasterise the glyph, take the ridge of the distance
   transform and trace it into polylines.  Free ends are then moved by
   (stroke/2 - tool radius) so the milled groove starts and ends exactly on the
   letter outline.  TOOL_R_UNITS is filled in by buildGeometry. */
let TOOL_R_UNITS = 0;

function signedAreaPerim(a) {
  let area = 0, per = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = a[(i + 1) % a.length];
    area += p.x * q.y - q.x * p.y;
    per += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return { area: area / 2, per };
}

function circlePoly(cx, cy, r, n) {
  n = n || 16;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = i / n * 2 * Math.PI;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return { closed: true, pts };
}

function skeletonDebug(font, cp, steps) {
  const dbg = {};
  const polys = skeletonPolys(font, cp, steps, dbg);
  dbg.out = polys.map(p => ({ closed: !!p.closed, n: p.pts.length }));
  dbg.meanWidth = Math.round(polys.meanWidth || 0);
  return dbg;
}

/* --- stitch skeleton fragments into continuous tool paths ------------------ */
/* average the raster staircase away, ends stay put */
function smoothPath(pts, closed, passes) {
  const n = pts.length;
  if (n < 5) return pts;
  let cur = pts.map(p => ({ x: p.x, y: p.y }));
  for (let pass = 0; pass < (passes || 2); pass++) {
    const next = cur.map(p => ({ x: p.x, y: p.y }));
    for (let i = 0; i < n; i++) {
      if (!closed && (i === 0 || i === n - 1)) continue;
      const a = cur[(i - 1 + n) % n], b = cur[i], c = cur[(i + 1) % n];
      next[i] = { x: (a.x + 2 * b.x + c.x) / 4, y: (a.y + 2 * b.y + c.y) / 4 };
    }
    cur = next;
  }
  return cur;
}

/* drop points that only add a wiggle: nearly straight corners and small spikes */
function cleanPath(pts, d, closed) {
  let p = pts.slice();
  for (let guard = 0; guard < 30; guard++) {
    const n = p.length;
    if (n < (closed ? 4 : 3)) break;
    const out = [];
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (!closed && (i === 0 || i === n - 1)) { out.push(p[i]); continue; }
      const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n];
      const v1x = b.x - a.x, v1y = b.y - a.y, v2x = c.x - b.x, v2y = c.y - b.y;
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
      if (l1 < 1e-9 || l2 < 1e-9) { changed = true; continue; }
      const cosang = (v1x * v2x + v1y * v2y) / (l1 * l2);
      const ang = Math.acos(Math.max(-1, Math.min(1, cosang))) * 180 / Math.PI;
      const l3 = Math.hypot(c.x - a.x, c.y - a.y);
      const detour = l3 > 1e-9 ? Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / l3 : 0;
      /* nearly straight -> drop (raster staircase); sharp turn with a tiny
         detour -> drop (spike).  Anything else is real geometry, including the
         sampled arcs of О, В, Б ... */
      if (ang < 4 || (ang > 45 && detour < 0.5 * Math.min(l1, l2))) { changed = true; continue; }
      out.push(p[i]);
    }
    if (out.length < (closed ? 3 : 2)) break;
    p = out;
    if (!changed) break;
  }
  return p;
}

/* a junction corner makes the walker step out and come straight back: remove
   such peninsulas (short excursion, long detour) but keep real sharp corners,
   whose apex lies far from the chord */
function removePeninsulas(pts, d) {
  let p = pts.slice();
  for (let guard = 0; guard < 12; guard++) {
    const n = p.length;
    let cut = null;
    for (let i = 0; i < n - 2 && !cut; i++) {
      for (let j = i + 2; j < n; j++) {
        const chord = Math.hypot(p[j].x - p[i].x, p[j].y - p[i].y);
        let arc = 0, maxdev = 0;
        for (let k = i + 1; k <= j; k++) arc += Math.hypot(p[k].x - p[k - 1].x, p[k].y - p[k - 1].y);
        if (arc < 1e-9 || arc > 2.4 * d) continue;
        if (arc < 1.8 * chord) continue;
        const l3 = chord;
        for (let k = i + 1; k < j; k++) {
          const dev = l3 > 1e-9
            ? Math.abs((p[k].x - p[i].x) * (p[j].y - p[i].y) - (p[k].y - p[i].y) * (p[j].x - p[i].x)) / l3
            : Math.hypot(p[k].x - p[i].x, p[k].y - p[i].y);
          if (dev > maxdev) maxdev = dev;
        }
        if (maxdev > 0.6 * d) continue;
        cut = { i, j };
        break;
      }
    }
    if (!cut) break;
    const next = p.slice(0, cut.i + 1).concat(p.slice(cut.j));
    if (next.length < 2) break;
    p = next;
  }
  return p;
}

/* the medial axis grows a little hook where a stroke ends with a rounded cap;
   a terminal segment that is short and turns sharply is such a hook, not part
   of the letter */
function trimEndHooks(pts, d) {
  let p = pts.slice();
  for (let guard = 0; guard < 8; guard++) {
    if (p.length < 3) break;
    let changed = false;
    const n = p.length;
    const tryEnd = (atStart) => {
      const i2 = atStart ? 1 : n - 2, i3 = atStart ? 2 : n - 3;
      if (i3 < 0 || i3 >= n) return false;
      const A = atStart ? p[0] : p[n - 1], B = p[i2], C = p[i3];
      const v1 = { x: A.x - B.x, y: A.y - B.y };
      const l1 = Math.hypot(v1.x, v1.y);
      if (l1 > 0.55 * d) return false;
      const v0 = { x: B.x - C.x, y: B.y - C.y };
      const l0 = Math.hypot(v0.x, v0.y);
      if (l0 < 1e-9) return false;
      const cosang = (v1.x * v0.x + v1.y * v0.y) / (l1 * l0);
      const ang = Math.acos(Math.max(-1, Math.min(1, cosang))) * 180 / Math.PI;
      if (ang < 45) return false;
      if (atStart) p.shift(); else p.pop();
      return true;
    };
    if (tryEnd(false)) changed = true;
    else if (tryEnd(true)) changed = true;
    if (!changed) break;
  }
  return p;
}

/* the centreline of one stroke stops half a stroke short of the piece it runs
   into, so two paths that should meet at a junction end a hair apart and leave
   a visible step; extend both to the corner where their directions cross */
function joinEndpoints(polys, d) {
  const eps = 1.4 * d;
  const endOf = (p, atStart) => atStart ? p.pts[0] : p.pts[p.pts.length - 1];
  const dirOf = (p, atStart) => {
    const a = endOf(p, atStart), b = atStart ? p.pts[1] : p.pts[p.pts.length - 2];
    if (!b) return null;
    const dx = a.x - b.x, dy = a.y - b.y, l = Math.hypot(dx, dy);
    return l > 1e-9 ? { x: dx / l, y: dy / l } : null;
  };
  for (let i = 0; i < polys.length; i++) {
    const P = polys[i];
    if (P.closed || P.pts.length < 2) continue;
    for (const ei of [true, false]) {
      const A = endOf(P, ei);
      let best = null, bd = eps;
      for (let j = 0; j < polys.length; j++) {
        const Q = polys[j];
        if (j === i || Q.closed || Q.pts.length < 2) continue;
        for (const ej of [true, false]) {
          const B = endOf(Q, ej);
          const dist = Math.hypot(A.x - B.x, A.y - B.y);
          if (dist < bd) { bd = dist; best = { Q, ej }; }
        }
      }
      if (!best) continue;
      const B = endOf(best.Q, best.ej);
      const dA = dirOf(P, ei), dB = dirOf(best.Q, best.ej);
      let target = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
      if (dA && dB) {
        const den = dA.x * dB.y - dA.y * dB.x;
        if (Math.abs(den) > 0.2) {
          const t = ((B.x - A.x) * dB.y - (B.y - A.y) * dB.x) / den;
          const s = ((B.x - A.x) * dA.y - (B.y - A.y) * dA.x) / den;
          if (t > -0.1 * d && t < 1.2 * d && s > -0.1 * d && s < 1.2 * d) {
            target = { x: A.x + dA.x * t, y: A.y + dA.y * t };
          }
        }
      }
      A.x = target.x; A.y = target.y;
      B.x = target.x; B.y = target.y;
    }
  }
  return polys;
}

/* where two strokes meet, the medial axis often runs to the outer corner and
   back, leaving a little antenna past the junction (the apex of "А" is the
   classic case).  If a path end reaches another path's end within a stroke
   width, cut the part beyond that meeting point. */
function trimTailsPastJunction(polys, d) {
  const ends = [];
  for (const p of polys) {
    if (p.closed || p.pts.length < 2) continue;
    ends.push({ p, atStart: true });
    ends.push({ p, atStart: false });
  }
  const endPt = e => e.atStart ? e.p.pts[0] : e.p.pts[e.p.pts.length - 1];
  for (const p of polys) {
    if (p.closed || p.pts.length < 4) continue;
    for (const atStart of [true, false]) {
      const n = p.pts.length;
      let acc = 0;
      for (let k = 0; k + 1 < n; k++) {
        const i = atStart ? k : n - 1 - k;
        const j = atStart ? k + 1 : n - 2 - k;
        let hit = false;
        for (const e of ends) {
          if (e.p === p) continue;
          const q = endPt(e);
          if (Math.hypot(q.x - p.pts[j].x, q.y - p.pts[j].y) < 0.35 * d) { hit = true; break; }
        }
        if (hit) {
          if (atStart) { if (j >= 1 && n - j >= 2) p.pts = p.pts.slice(j); }
          else { if (n - 1 - j >= 2) p.pts = p.pts.slice(0, j + 1); }
          break;
        }
        acc += Math.hypot(p.pts[j].x - p.pts[i].x, p.pts[j].y - p.pts[i].y);
        if (acc > 1.5 * d) break;
      }
    }
  }
  return polys;
}

function polyEndDir(p, atStart) {
  const a = atStart ? p.pts[0] : p.pts[p.pts.length - 1];
  const b = atStart ? p.pts[1] : p.pts[p.pts.length - 2];
  const dx = a.x - b.x, dy = a.y - b.y, n = Math.hypot(dx, dy) || 1;
  return { x: dx / n, y: dy / n };
}

function polyLength(p) {
  let len = 0;
  for (let i = 1; i < p.pts.length; i++) len += Math.hypot(p.pts[i].x - p.pts[i - 1].x, p.pts[i].y - p.pts[i - 1].y);
  if (p.closed && p.pts.length > 2) len += Math.hypot(p.pts[0].x - p.pts[p.pts.length - 1].x, p.pts[0].y - p.pts[p.pts.length - 1].y);
  return len;
}

function mergePaths(polys, d) {
  const open = [];
  const done = [];
  for (const p of polys) (p.closed && p.pts.length > 2 ? done : open).push(p);
  const near = d * 0.95;
  for (let guard = 0; guard < 400; guard++) {
    let merged = false;
    for (let i = 0; i < open.length && !merged; i++) {
      for (let j = i + 1; j < open.length && !merged; j++) {
        const A = open[i], B = open[j];
        for (const si of [true, false]) {
          for (const sj of [true, false]) {
            const ia = si ? 0 : A.pts.length - 1, ib = sj ? 0 : B.pts.length - 1;
            const pa = A.pts[ia], pb = B.pts[ib];
            const dist = Math.hypot(pa.x - pb.x, pa.y - pb.y);
            if (dist > near) continue;
            const da = polyEndDir(A, si), db = polyEndDir(B, sj);
            const dot = da.x * db.x + da.y * db.y;
            if (dot > -0.3) continue;                          // only continue straight on
            const ptsA = si ? A.pts.slice().reverse() : A.pts.slice();
            const ptsB = sj ? B.pts.slice() : B.pts.slice().reverse();
            const m = { closed: false, pts: ptsA.concat(ptsB) };
            open.splice(j, 1);
            open.splice(i, 1);
            open.push(m);
            merged = true;
            break;
          }
          if (merged) break;
        }
      }
    }
    if (!merged) break;
  }
  return done.concat(open);
}

function distToPath(p, pt) {
  let best = Infinity;
  const n = p.pts.length;
  const seg = (a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(pt.x - (a.x + dx * t), pt.y - (a.y + dy * t));
    if (d < best) best = d;
  };
  for (let i = 1; i < n; i++) seg(p.pts[i - 1], p.pts[i]);
  if (p.closed && n > 2) seg(p.pts[n - 1], p.pts[0]);
  return best;
}

/* stretch (or trim) the free ends of a path by `ext` so the groove stops
   exactly on the letter outline */
function adjustFreeEnds(polys, d, ext) {
  for (const p of polys) {
    if (p.closed || p.pts.length < 2) continue;
    for (const atStart of [true, false]) {
      const end = atStart ? p.pts[0] : p.pts[p.pts.length - 1];
      let free = true;
      for (const q of polys) {
        if (q === p) continue;
        if (distToPath(q, end) < d * 0.6) { free = false; break; }
      }
      if (!free) continue;
      const A = atStart ? p.pts[0] : p.pts[p.pts.length - 1];
      /* direction from a point further along the path: the immediate neighbour
         is still affected by the raster staircase and would bend the end */
      let B = null, acc = 0;
      if (atStart) {
        for (let i = 1; i < p.pts.length; i++) {
          acc += Math.hypot(p.pts[i].x - p.pts[i - 1].x, p.pts[i].y - p.pts[i - 1].y);
          B = p.pts[i];
          if (acc >= 0.4 * d || i >= 2) break;
        }
      } else {
        for (let i = p.pts.length - 2; i >= 0; i--) {
          acc += Math.hypot(p.pts[i + 1].x - p.pts[i].x, p.pts[i + 1].y - p.pts[i].y);
          B = p.pts[i];
          if (acc >= 0.4 * d || i <= p.pts.length - 3) break;
        }
      }
      if (!B) continue;
      const len = Math.hypot(A.x - B.x, A.y - B.y);
      if (len < 1e-9) continue;
      const k2 = Math.max(-0.9, Math.min(1.5, ext / len));
      A.x += (A.x - B.x) * k2; A.y += (A.y - B.y) * k2;
    }
  }
  return polys;
}

function skeletonPolys(font, cp, steps, dbg) {
  const rawConts = font.rawGlyph(font.gidFor(cp), 0);
  const conts = [];
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, sArea = 0, per = 0;
  for (const c of rawConts) {
    const a = dedupe(flatten(c, steps));
    if (a.length < 3) continue;
    const ap = signedAreaPerim(a);
    sArea += ap.area; per += ap.per;
    for (const p of a) {
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    conts.push(a);
  }
  if (!conts.length) return [];
  const bw = x1 - x0, bh = y1 - y0;
  if (!(bw > 0) || !(bh > 0)) return [];
  const em = font.unitsPerEm;
  let d = per > 0 ? 2 * Math.abs(sArea) / per : 0;    // mean stroke width
  if (!(d > 0) || d > bh) d = bh / 14;
  if (dbg) { dbg.conts = conts.length; dbg.bbox = [x0, y0, x1, y1].map(v => Math.round(v)); dbg.ink = Math.round(Math.abs(sArea)); dbg.per = Math.round(per); dbg.d = d.toFixed(1); }
  const out = [];
  /* small solid blobs (period, dieresis) are milled as a tiny circle: with a
     tool of radius TOOL_R_UNITS the hole comes out the size of the dot */
  const free = [];
  for (const a of conts) {
    let ax0 = 1e9, ay0 = 1e9, ax1 = -1e9, ay1 = -1e9;
    for (const p of a) {
      if (p.x < ax0) ax0 = p.x; if (p.x > ax1) ax1 = p.x;
      if (p.y < ay0) ay0 = p.y; if (p.y > ay1) ay1 = p.y;
    }
    const aw = ax1 - ax0, ah = ay1 - ay0;
    const fill = aw > 0 && ah > 0 ? Math.abs(signedAreaPerim(a).area) / (aw * ah) : 0;
    if (aw < 0.25 * em && ah < 0.25 * em && fill > 0.55) {
      let cx = 0, cy = 0;
      for (const p of a) { cx += p.x; cy += p.y; }
      cx /= a.length; cy /= a.length;
      const size = Math.sqrt(Math.abs(signedAreaPerim(a).area));
      out.push(circlePoly(cx, cy, Math.max(0.15 * d, size / 2 - TOOL_R_UNITS), 12));
    } else free.push(a);
  }
  if (free.length) {
    const s = Math.max(0.5, Math.min(d / 10, bh / 200, bw / 200));
    const pad = 2 * s;
    const gx0 = x0 - pad, gy0 = y0 - pad;
    const W = Math.ceil((bw + 2 * pad) / s) + 1, H = Math.ceil((bh + 2 * pad) / s) + 1;
    if (dbg) { dbg.s = s.toFixed(2); dbg.W = W; dbg.H = H; dbg.dots = out.length; }
    const mask = new Uint8Array(W * H);
    for (let r = 0; r < H; r++) {
      const yy = gy0 + (r + 0.5) * s, cross = [];
      for (const a of free) for (let i = 0; i < a.length; i++) {
        const p = a[i], q = a[(i + 1) % a.length];
        if ((p.y <= yy && q.y > yy) || (q.y <= yy && p.y > yy)) {
          cross.push({ x: p.x + (q.x - p.x) * (yy - p.y) / (q.y - p.y), dir: q.y > p.y ? 1 : -1 });
        }
      }
      /* TrueType fills with the non-zero winding rule: contours of a glyph may
         overlap (the bar of "е" is a separate rectangle), so even-odd would eat
         the middle of such letters */
      cross.sort((m, n) => m.x - n.x);
      let wind = 0;
      for (let k = 0; k + 1 < cross.length; k++) {
        wind += cross[k].dir;
        if (wind === 0) continue;
        let c0 = Math.ceil((cross[k].x - gx0) / s - 0.5), c1 = Math.floor((cross[k + 1].x - gx0) / s - 0.5);
        if (c0 < 0) c0 = 0; if (c1 > W - 1) c1 = W - 1;
        for (let c = c0; c <= c1; c++) mask[r * W + c] = 1;
      }
    }
    /* distance to the nearest background cell (chamfer 1 / sqrt2) */
    const D = new Float64Array(W * H);
    for (let i = 0; i < W * H; i++) D[i] = mask[i] ? 1e9 : 0;
    const w2 = Math.SQRT2;
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (!mask[i]) continue;
      let v = D[i];
      if (r > 0) { v = Math.min(v, D[i - W] + 1); if (c > 0) v = Math.min(v, D[i - W - 1] + w2); if (c + 1 < W) v = Math.min(v, D[i - W + 1] + w2); }
      if (c > 0) v = Math.min(v, D[i - 1] + 1);
      D[i] = v;
    }
    for (let r = H - 1; r >= 0; r--) for (let c = W - 1; c >= 0; c--) {
      const i = r * W + c;
      if (!mask[i]) continue;
      let v = D[i];
      if (r + 1 < H) { v = Math.min(v, D[i + W] + 1); if (c > 0) v = Math.min(v, D[i + W - 1] + w2); if (c + 1 < W) v = Math.min(v, D[i + W + 1] + w2); }
      if (c + 1 < W) v = Math.min(v, D[i + 1] + 1);
      D[i] = v;
    }
    /* Ridge = cells that are a local maximum of the clearance along the normal
       to the nearest wall: exactly the medial axis of a constant width stroke,
       i.e. the line the tool has to follow.  Comparing with the single opposite
       cell (instead of the whole neighbourhood) keeps it stable against the one
       cell jitter of the discretised distance. */
    const OFF = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    const band = new Uint8Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (!mask[i]) continue;
      let bd = Infinity, br = 0, bc2 = 0;
      for (const o of OFF) {
        const rr = r + o[1], cc = c + o[0];
        if (rr < 0 || rr >= H || cc < 0 || cc >= W) continue;
        const j = rr * W + cc;
        const v = mask[j] ? D[j] : 0;              // outside counts as wall
        if (v < bd) { bd = v; br = o[1]; bc2 = o[0]; }
      }
      const orr = r - br, occ = c - bc2;
      const opp = (orr >= 0 && orr < H && occ >= 0 && occ < W) ? D[orr * W + occ] : 0;
      if (D[i] >= opp) band[i] = 1;
    }
    /* Zhang-Suen thinning keeps the ridge one cell wide */
    const components = img => {
      const seen = new Uint8Array(W * H);
      let n = 0;
      for (let s0 = 0; s0 < W * H; s0++) {
        if (!img[s0] || seen[s0]) continue;
        n++;
        const st = [s0];
        seen[s0] = 1;
        while (st.length) {
          const i = st.pop(), r = Math.floor(i / W), c = i % W;
          for (const o of OFF) {
            const rr = r + o[1], cc = c + o[0];
            if (rr < 0 || rr >= H || cc < 0 || cc >= W) continue;
            const j = rr * W + cc;
            if (img[j] && !seen[j]) { seen[j] = 1; st.push(j); }
          }
        }
      }
      return n;
    };
    /* close the small gaps of the discretised ridge, then thin it */
    {
      const CLOSE = 3;
      let cur = band;
      for (let k = 0; k < CLOSE; k++) {
        const dil = new Uint8Array(W * H);
        for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
          const i = r * W + c;
          if (cur[i]) { dil[i] = 1; continue; }
          for (const o of OFF) {
            const rr = r + o[1], cc = c + o[0];
            if (rr < 0 || rr >= H || cc < 0 || cc >= W) continue;
            if (cur[rr * W + cc]) { dil[i] = 1; break; }
          }
        }
        cur = dil;
      }
      for (let k = 0; k < CLOSE; k++) {
        const ero = new Uint8Array(W * H);
        for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
          const i = r * W + c;
          ero[i] = (cur[i] && r > 0 && cur[i - W] && r + 1 < H && cur[i + W] && c > 0 && cur[i - 1] && c + 1 < W && cur[i + 1]) ? 1 : 0;
        }
        cur = ero;
      }
      band.set(cur);
    }
    if (dbg) dbg.compPre = components(band);
    for (let guard = 0, changed = true; changed && guard < 80; guard++) {
      changed = false;
      for (let step = 0; step < 2; step++) {
        const del = [];
        for (let r = 1; r < H - 1; r++) for (let c = 1; c < W - 1; c++) {
          const i = r * W + c;
          if (!band[i]) continue;
          const p2 = band[i - W], p3 = band[i - W + 1], p4 = band[i + 1], p5 = band[i + W + 1],
                p6 = band[i + W], p7 = band[i + W - 1], p8 = band[i - 1], p9 = band[i - W - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let A = 0;
          for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[k + 1] === 1) A++;
          if (A !== 1) continue;
          if (step === 0) { if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue; }
          else { if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue; }
          del.push(i);
        }
        if (del.length) { changed = true; for (const i of del) band[i] = 0; }
      }
    }
    /* stroke width from the ridge itself (clearance = d/2) */
    {
      const vals = [];
      for (let i = 0; i < W * H; i++) if (band[i]) vals.push(D[i]);
      if (vals.length > 2) {
        vals.sort((a, b) => a - b);
        d = 2 * vals[Math.floor(vals.length / 2)] * s;
      }
    }
    if (dbg) dbg.compPost = components(band);
    if (dbg) {
      /* fine view of a few rows: '#' = ridge, '+' = filled */
      const lines = [];
      for (let k = 0; k < 10; k++) {
        const r = Math.min(H - 1, Math.round(H * (k + 0.5) / 10));
        let s1 = '';
        for (let c = 0; c < W; c++) {
          const i = r * W + c;
          s1 += band[i] ? '#' : (mask[i] ? '+' : '.');
        }
        lines.push('r' + r + ' ' + s1);
      }
      dbg.maskAscii = lines;
    }
    if (dbg) {
      let mc = 0, mx = 0, bc = 0;
      for (let i = 0; i < W * H; i++) { if (mask[i]) { mc++; if (D[i] > mx) mx = D[i]; } if (band[i]) bc++; }
      dbg.maskCells = mc; dbg.maxD = mx.toFixed(2); dbg.dEst = d.toFixed(1); dbg.bandCells = bc;
    }
    const adj = new Array(W * H).fill(null);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (!band[i]) continue;
      const lst = [];
      for (const o of OFF) {
        const rr = r + o[1], cc = c + o[0];
        if (rr < 0 || rr >= H || cc < 0 || cc >= W) continue;
        const j = rr * W + cc;
        if (band[j]) lst.push(j);
      }
      adj[i] = lst;
    }
    /* Follow the ridge cell by cell, always taking the straightest free
       continuation.  This walks through junctions and through the staircases of
       a slanted stroke without breaking the path. */
    const visited = new Uint8Array(W * H);
    const chains = [];
    const starts = [];
    for (let i = 0; i < W * H; i++) if (band[i]) starts.push(i);
    starts.sort((a, b) => (adj[a] ? adj[a].length : 0) - (adj[b] ? adj[b].length : 0));
    for (const s0 of starts) {
      if (visited[s0]) continue;
      visited[s0] = 1;
      const chain = [s0];
      let cur = s0, dirx = 0, diry = 0;
      for (;;) {
        let best = -1, bestScore = -2;
        for (const n of adj[cur] || []) {
          if (visited[n]) continue;
          const dr = Math.floor(n / W) - Math.floor(cur / W), dc = (n % W) - (cur % W);
          const len = Math.hypot(dr, dc) || 1;
          const score = (dirx === 0 && diry === 0) ? 0 : (dr * dirx + dc * diry) / len;
          if (score > bestScore) { bestScore = score; best = n; }
        }
        if (best < 0) break;
        if (chain.length > 1 && bestScore < -0.1) break;      // do not double back
        const dr = Math.floor(best / W) - Math.floor(cur / W), dc = (best % W) - (cur % W);
        const len = Math.hypot(dr, dc) || 1;
        dirx = dr / len; diry = dc / len;
        visited[best] = 1;
        chain.push(best);
        cur = best;
      }
      if (chain.length >= 2) {
        const last = chain[chain.length - 1];
        if (chain.length > 4 && (adj[last] || []).indexOf(s0) >= 0) chain.push(s0);   // closed loop (О, Э, 0, 8)
        chains.push(chain);
      }
    }
    const minCells = Math.max(3, Math.round(0.2 * d / s));
    if (dbg) dbg.chains = chains.map(c => c.length).join(',');
    const raw = [];
    for (const ch of chains) {
      if (ch.length < minCells) continue;
      const closed = ch[0] === ch[ch.length - 1];
      let src = ch.map(i => ({ x: gx0 + ((i % W) + 0.5) * s, y: gy0 + (Math.floor(i / W) + 0.5) * s }));
      if (closed) src = src.slice(0, -1);
      src = smoothPath(src, closed, 20);
      let simp = rdp(src, s * 1.0);
      simp = cleanPath(simp, d, closed);
      if (simp.length < 2) continue;
      raw.push({ closed: closed && simp.length > 2, pts: simp });
    }
    const merged = mergePaths(raw, d);
    /* a short branch that hangs off another path is a junction crumb, not a stroke */
    const touching = (p, q) => {
      for (const end of [p.pts[0], p.pts[p.pts.length - 1]]) {
        if (distToPath(q, end) < 0.7 * d) return true;
      }
      return false;
    };
    const pruned = [];
    for (const p of merged) {
      if (p.closed || polyLength(p) > 2.0 * d) { pruned.push(p); continue; }
      let hangs = false;
      for (const q of merged) if (q !== p && touching(p, q)) { hangs = true; break; }
      if (!hangs) pruned.push(p);
    }
    const kept = pruned.filter(p => p.closed || polyLength(p) > 1.5 * d)
      .map(p => {
        if (p.closed) return { closed: true, pts: cleanPath(p.pts, d, true) };
        let q = cleanPath(p.pts, d, false);
        q = removePeninsulas(q, d);
        q = trimEndHooks(cleanPath(q, d, false), d);
        return { closed: false, pts: q };
      })
      .filter(p => p.pts.length >= 2);
    adjustFreeEnds(kept, d, d / 2 - TOOL_R_UNITS);
    joinEndpoints(kept, d);
    trimTailsPastJunction(kept, d);
    for (const p of kept) out.push(p);
    if (dbg) dbg.merged = merged.length + '->' + pruned.length + '->' + kept.length;
    if (dbg) dbg.pathLens = kept.map(p => Math.round(polyLength(p)) + (p.closed ? 'c' : '')).join(',');
    if (dbg) dbg.pathEnds = kept.map(p => Math.round(p.pts[0].x) + ',' + Math.round(p.pts[0].y) + '..' +
      Math.round(p.pts[p.pts.length - 1].x) + ',' + Math.round(p.pts[p.pts.length - 1].y)).join(' ');
    if (dbg) dbg.pathPts = kept.map(p => p.pts.map(q => Math.round(q.x) + ':' + Math.round(q.y)).join(' ')).join(' | ');
    if (dbg) dbg.termSeg = kept.map(p => {
      const n = p.pts.length;
      if (n < 2) return '0/0';
      const d1 = Math.hypot(p.pts[1].x - p.pts[0].x, p.pts[1].y - p.pts[0].y);
      const d2 = Math.hypot(p.pts[n - 1].x - p.pts[n - 2].x, p.pts[n - 1].y - p.pts[n - 2].y);
      return Math.round(d1) + '/' + Math.round(d2);
    }).join(' ');
  }
  out.meanWidth = d;
  return out;
}

function glyphLines(font, cp, steps, policy) {
  if (policy === 'center' || policy === 'cnc' || policy === 'skeleton') {
    return skeletonPolys(font, cp, steps);
  }
  if (policy === 'center-old') {
    const r = centerPolys(font, cp, steps, 0.06);
    r.meanWidth = r.meanWidth;
    return r;
  }
  return glyphPolys(font, cp, steps, policy);
}

/* Empty Ё/ё (common in free GOST fonts) -> Е/е plus two dots from "." */
function glyphFor(font, cp, steps, policy) {
  let polys = glyphLines(font, cp, steps, policy);
  let adv = font.advance(font.gidFor(cp));
  if (polys.length === 0 && (cp === 0x0401 || cp === 0x0451)) {
    const baseCp = cp === 0x0401 ? 0x0415 : 0x0435;
    const base = glyphLines(font, baseCp, steps, policy);
    const dot = glyphLines(font, 0x002e, steps, policy);
    const bb = bboxOf(font, baseCp, steps, 'outline');
    const db = bboxOf(font, 0x002e, steps, 'outline');
    if (base.length && dot.length && bb && db && db.h > 0) {
      const s = (bb.h * 0.15) / db.h;
      const dotY = bb.y1 + bb.h * 0.13;
      const cx = (bb.x0 + bb.x1) / 2;
      const dx = bb.w * 0.23;
      const place = tx => dot.map(p => ({
        closed: p.closed,
        pts: p.pts.map(q => ({ x: cx + tx + (q.x - db.x0) * s, y: dotY + (q.y - db.y0) * s }))
      }));
      polys = base.concat(place(-dx), place(dx));
      adv = font.advance(font.gidFor(baseCp));
      return { polys, adv, synthesized: true };
    }
  }
  return { polys, adv, synthesized: false };
}

function bboxOf(font, cp, steps, policy) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, any = false;
  for (const p of glyphPolys(font, cp, steps, 'outline')) {
    for (const q of p.pts) {
      any = true;
      if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
      if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
    }
  }
  return any ? { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 } : null;
}

/* ------------------------------- layout / DXF ------------------------------ */
const ROWS = [
  { layer: 'GOST_UPPER', text: 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', color: 7 },
  { layer: 'GOST_LOWER', text: 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя', color: 1 },
  { layer: 'GOST_LAT_UP', text: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', color: 5 },
  { layer: 'GOST_LAT_LOW', text: 'abcdefghijklmnopqrstuvwxyz', color: 6 },
  { layer: 'GOST_DIGIT', text: '0123456789', color: 3 },
  { layer: 'GOST_PUNCT', text: '.,;:!?-()«»№/%', color: 5 },
  { layer: 'GOST_SAMPLE', text: 'СПЕЦИФИКАЦИЯ 12-345', color: 2 }
];

const MARK_LAYER = 'GOST_MARK';
const FRAME_LAYER = 'GOST_FRAME';
const CNC_LAYER = 'GOST_CNC';      // all centreline tool paths of the CNC set

function buildGeometry(font, lowerMm, slantDeg, steps, policy, marks, toolMm) {
  marks = marks || { on: false, aMm: 1.0, bMm: 11.0, gapMm: 1.6 };
  const xh = bboxOf(font, 0x0445, steps) || bboxOf(font, 0x043e, steps);
  if (!xh || xh.h <= 0) throw new Error('cannot measure x-height');
  const scale = lowerMm / xh.h;
  const k = Math.tan(slantDeg * Math.PI / 180);
  const upBox = bboxOf(font, 0x0410, steps);
  const rowGap = Math.max(upBox ? upBox.h * scale : lowerMm, lowerMm) * 2.6;
  const space = marks.gapMm / scale;
  /* CNC: the groove is cut by a tool of diameter toolMm, so the centreline ends
     move by (stroke/2 - tool radius), and the cell is pushed out by the tool
     radius so that the inner edge of the milled groove stays on the nominal
     GOST cell.  Both are zero for the printing set (toolMm = 0). */
  const cnc = policy === 'center' || policy === 'cnc' || policy === 'skeleton';
  TOOL_R_UNITS = (toolMm > 0 ? toolMm / 2 : 0) / scale;
  const framePad = (cnc && toolMm > 0 ? toolMm / 2 : 0) / scale;   // font units
  const rows = [];
  const missing = [];
  const synth = [];
  const widths = [];
  const markPolys = [];
  const framePolys = [];
  const pendingFrames = [];
  let headU = upBox ? upBox.h : 0;   // never below the GOST head line (cap height)
  let y = 0;
  for (const row of ROWS) {
    let pen = 0;
    const polys = [];
    for (const ch of row.text) {
      const cp = ch.codePointAt(0);
      const gf = glyphFor(font, cp, steps, policy);
      if (gf.polys.length === 0 && cp !== 0x20) missing.push('U+' + cp.toString(16).toUpperCase());
      if (gf.synthesized) synth.push('U+' + cp.toString(16).toUpperCase());
      if (gf.polys.meanWidth) widths.push(gf.polys.meanWidth * scale);
      let bx0 = 1e9, by0 = 1e9, bx1 = -1e9, by1 = -1e9;      // placed (sheared) bbox
      let ux0 = 1e9, uy1 = -1e9, ux1 = -1e9;                 // unsheared bbox of the glyph
      /* the cell is measured on the outline, so printing and CNC sets share
         exactly the same cells */
      const fg = cnc ? glyphFor(font, cp, steps, 'outline') : gf;
      for (const p of (cnc ? fg.polys : gf.polys)) {
        const q = p.pts;
        for (const v of q) {
          if (v.x < ux0) ux0 = v.x; if (v.x > ux1) ux1 = v.x;
          if (v.y > uy1) uy1 = v.y;
        }
      }
      for (const p of gf.polys) {
        const pts = p.pts.map(q => ({ x: (q.x + q.y * k) * scale + pen * scale, y: q.y * scale + y }));
        for (const q of pts) {
          if (q.x < bx0) bx0 = q.x; if (q.x > bx1) bx1 = q.x;
          if (q.y < by0) by0 = q.y; if (q.y > by1) by1 = q.y;
        }
        polys.push({ closed: p.closed, pts });
      }
      if (marks.on && bx1 > bx0) {
        if (marks.mode === 'frame') {
          // One uniform cell for every letter, read top-to-bottom like a text line:
          // the TOP edge is a common horizontal line and the cell hangs b below it.
          // The line is the tallest letter of the sheet + 0.01 mm, so diacritics
          // (Й, Ё) and descenders (д, у, р, ц, щ) all stay inside; with
          // marks.headLine === 'cap' it is instead the GOST head line (cap height).
          pendingFrames.push({ ux0, ux1, pen, y, top: uy1 });
          if (marks.headLine !== 'cap' && uy1 > headU) headU = uy1;
        } else {
          const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
          markPolys.push({ closed: false, pts: [{ x: cx - marks.aMm / 2, y: cy }, { x: cx + marks.aMm / 2, y: cy }] });
          markPolys.push({ closed: false, pts: [{ x: cx, y: cy - marks.bMm / 2 }, { x: cx, y: cy + marks.bMm / 2 }] });
        }
      }
      pen += gf.adv + space;
    }
    rows.push({ layer: cnc ? CNC_LAYER : row.layer, color: cnc ? 7 : row.color, y, polys });
    y -= rowGap;
  }
  if (pendingFrames.length) {
    const halfA = (marks.aMm / 2) / scale + framePad;
    const topU = headU + 0.01 / scale + framePad;   // common head line + 0.01 mm
    const botU = topU - marks.bMm / scale - 2 * framePad;   // cell hangs b down (line pitch)
    for (const f of pendingFrames) {
      const x0u = f.ux0 - halfA, x1u = f.ux1 + halfA;
      const corner = q => ({ x: (q.x + q.y * k) * scale + f.pen * scale, y: q.y * scale + f.y });
      framePolys.push({
        closed: true, pts: [
          corner({ x: x0u, y: topU }), corner({ x: x1u, y: topU }),
          corner({ x: x1u, y: botU }), corner({ x: x0u, y: botU })
        ]
      });
    }
  }
  if (markPolys.length) rows.push({ layer: MARK_LAYER, color: 4, y: 0, polys: markPolys });
  if (framePolys.length) rows.push({ layer: FRAME_LAYER, color: 4, y: 0, polys: framePolys });
  return { rows, scale, rowGap, upBox, xh, missing, synth, widths, lowerMm, marks, markCount: markPolys.length, frameCount: framePolys.length,
    cellTopMm: framePolys.length ? Math.max.apply(null, framePolys[0].pts.map(p => p.y)) : 0,
    cellBotMm: framePolys.length ? Math.min.apply(null, framePolys[0].pts.map(p => p.y)) : 0 };
}

function polylineEntity(layer, pts, closed) {
  const NL = '\r\n';
  let s = ['0', 'POLYLINE', '8', layer, '66', '1', '70', closed ? '1' : '0', ''].join(NL);
  for (const p of pts) s += ['0', 'VERTEX', '8', layer, '10', p.x.toFixed(4), '20', p.y.toFixed(4), '30', '0.0', ''].join(NL);
  return s + ['0', 'SEQEND', '8', layer, ''].join(NL);
}

function dxfFile(geom) {
  const NL = '\r\n';
  let ents = '';
  for (const row of geom.rows) for (const p of row.polys) ents += polylineEntity(row.layer, p.pts, p.closed);
  let s = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '0', 'ENDSEC', ''].join(NL);
  s += ['0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', String(geom.rows.length), ''].join(NL);
  for (const row of geom.rows) s += ['0', 'LAYER', '2', row.layer, '70', '0', '62', String(row.color), '6', 'CONTINUOUS', ''].join(NL);
  s += ['0', 'ENDTAB', '0', 'ENDSEC', ''].join(NL);
  s += ['0', 'SECTION', '2', 'ENTITIES', ''].join(NL) + ents + ['0', 'ENDSEC', '0', 'EOF', ''].join(NL);
  return s;
}

function svgFile(geom) {
  let paths = '';
  let minY = 0;
  for (const row of geom.rows) {
    for (const p of row.polys) {
      paths += '  <path d="' + p.pts.map((q, i) => (i ? 'L' : 'M') + q.x.toFixed(3) + ' ' + (-q.y).toFixed(3)).join(' ') + (p.closed ? ' Z' : '') + '"/>\n';
      for (const q of p.pts) if (-q.y > minY) minY = -q.y;
    }
  }
  const h = minY + 20;
  return '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="420mm" height="' + h.toFixed(1) + 'mm" viewBox="0 0 420 ' + h.toFixed(1) + '">\n' +
    '<rect width="100%" height="100%" fill="#ffffff"/>\n<g fill="none" stroke="#000000" stroke-width="0.2">\n' + paths + '</g>\n</svg>\n';
}

/* ---------------------------------- CLI ----------------------------------- */
const mode = process.argv[2], file = process.argv[3];
if (!mode || !file) {
  console.log('usage: info <font> | dump <font> <cpHex,...> | ascii <font> <cpHex,...> [outline|wire|center] [rows] | dxf <font> <out.dxf> [lowerMm] [slantDeg] [outline|wire|center]');
  process.exit(1);
}
const font = loadFont(file);
const steps = 10;

if (mode === 'info') {
  console.log('unitsPerEm=' + font.unitsPerEm + ' numGlyphs=' + font.numGlyphs + ' cmapEntries=' + font.map.size);
  for (const [name, a, b] of [['CYR_UPPER', 0x0410, 0x042f], ['CYR_LOWER', 0x0430, 0x044f], ['DIGITS', 0x30, 0x39]]) {
    let have = 0;
    for (let c = a; c <= b; c++) if (font.map.get(c)) have++;
    console.log(name + ': ' + have + '/' + (b - a + 1));
  }
} else if (mode === 'lean') {
  /* measure the slant of every glyph: mean x of the ink in the top band minus
     the bottom band, normalised by the height -> tan(angle) */
  const chars = [];
  for (const row of ROWS) for (const ch of row.text) if (ch !== ' ' && chars.indexOf(ch) < 0) chars.push(ch);
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    const polys = glyphPolys(font, cp, steps, 'outline');
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const p of polys) for (const q of p.pts) {
      if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
      if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
    }
    if (!(y1 > y0)) continue;
    const h = y1 - y0;
    let tSum = 0, tN = 0, bSum = 0, bN = 0;
    for (const p of polys) for (const q of p.pts) {
      if (q.y >= y1 - 0.2 * h) { tSum += q.x; tN++; }
      if (q.y <= y0 + 0.2 * h) { bSum += q.x; bN++; }
    }
    if (!tN || !bN) continue;
    const lean = ((tSum / tN) - (bSum / bN)) / (0.6 * h);
    console.log('U+' + cp.toString(16).toUpperCase() + ' lean=' + (lean * 100).toFixed(1).padStart(6) +
      '%  angle=' + (Math.atan(lean) * 180 / Math.PI).toFixed(1).padStart(6) + ' deg');
  }
} else if (mode === 'slant') {
  /* slant of the *straight left edge* of a glyph: fit the leftmost contour
     point of every horizontal band.  For an upright letter the slope is 0,
     for an oblique (наклонный) letter it is tan(15 deg) = 0.268. */
  const cps = (process.argv[4] || '413,415,41d,41f,433,435,43d,43f').split(',').filter(Boolean).map(s => parseInt(s, 16));
  for (const cp of cps) {
    const polys = glyphPolys(font, cp, steps, 'outline');
    let y0 = 1e9, y1 = -1e9;
    for (const p of polys) for (const q of p.pts) { if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
    const h = y1 - y0;
    if (!(h > 0)) continue;
    const NB = 24, xmin = new Array(NB).fill(1e9), ymid = new Array(NB).fill(0);
    for (let b = 0; b < NB; b++) ymid[b] = y0 + (b + 0.5) * h / NB;
    for (const p of polys) for (const q of p.pts) {
      let b = Math.floor((q.y - y0) / h * NB);
      if (b < 0) b = 0; if (b >= NB) b = NB - 1;
      if (q.x < xmin[b]) xmin[b] = q.x;
    }
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let b = 4; b < NB - 4; b++) {
      if (xmin[b] > 1e8) continue;
      n++; sx += ymid[b]; sy += xmin[b]; sxx += ymid[b] * ymid[b]; sxy += ymid[b] * xmin[b];
    }
    if (n < 4) { console.log('U+' + cp.toString(16).toUpperCase() + '  (no straight edge)'); continue; }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    console.log('U+' + cp.toString(16).toUpperCase() + ' leftEdgeSlope=' + slope.toFixed(3).padStart(6) +
      '  angle=' + (Math.atan(slope) * 180 / Math.PI).toFixed(1).padStart(5) + ' deg');
  }
} else if (mode === 'check') {
  /* objective sanity check over the sheet: centreline length should be close to
     ink area / stroke width (a missing stroke shows up as a low ratio) */
  const chars = [];
  for (const row of ROWS) for (const ch of row.text) if (ch !== ' ' && chars.indexOf(ch) < 0) chars.push(ch);
  let bad = 0;
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    const dbg = {};
    const polys = skeletonPolys(font, cp, steps, dbg);
    let len = 0;
    for (const p of polys) len += polyLength(p);
    const d = parseFloat(dbg.dEst || 0) || 1;
    const ink = dbg.ink || 0;
    const exp = ink / d;
    const ratio = exp > 0 ? len / exp : 0;
    const flag = (ratio < 0.75 || ratio > 1.25) ? '  <-- CHECK' : '';
    if (flag) bad++;
    console.log(('U+' + cp.toString(16).toUpperCase()).padEnd(8) + ' paths=' + String(polys.length).padEnd(3) +
      ' len=' + len.toFixed(0).padStart(6) + ' exp=' + exp.toFixed(0).padStart(6) +
      ' ratio=' + ratio.toFixed(2) + ' d=' + d.toFixed(1) + flag);
  }
  console.log('glyphs=' + chars.length + ' suspicious=' + bad);
} else if (mode === 'skel') {
  /* diagnostics for the centreline extractor */
  const cps = (process.argv[4] || '').split(',').filter(Boolean).map(s => parseInt(s, 16));
  const showMap = (process.argv[5] || '') === 'map';
  for (const cp of cps) {
    const r = skeletonDebug(font, cp, steps);
    if (showMap && r.maskAscii) {
      console.log('U+' + cp.toString(16).toUpperCase() + ' sample=' + r.s + ' d=' + r.dEst);
      for (const l of r.maskAscii) console.log(l);
      continue;
    }
    delete r.maskAscii;
    console.log('U+' + cp.toString(16).toUpperCase() + ' ' + JSON.stringify(r));
  }
} else if (mode === 'ascii') {
  /* quick visual check of any font/policy: render glyphs side by side as text art */
  const cps = (process.argv[4] || '').split(',').filter(Boolean).map(s => parseInt(s, 16));
  const pol = (process.argv[5] || 'outline').toLowerCase();
  const rowsN = parseInt(process.argv[6] || '20', 10);
  const blocks = cps.map(cp => {
    const gf = glyphFor(font, cp, steps, pol);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const p of gf.polys) for (const q of p.pts) {
      if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
      if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
    }
    if (!(x1 > x0) || !(y1 > y0)) return { cp: cp, rows: ['(empty)'], label: 'U+' + cp.toString(16).toUpperCase() };
    const w = Math.max(3, Math.round(rowsN * ((x1 - x0) / (y1 - y0)) * 0.5));
    const g = [];
    for (let r = 0; r < rowsN; r++) g.push(new Array(w).fill(' '));
    const put = (x, y) => {
      const c = Math.round((x - x0) / (x1 - x0) * (w - 1));
      const r = rowsN - 1 - Math.round((y - y0) / (y1 - y0) * (rowsN - 1));
      if (r >= 0 && r < rowsN && c >= 0 && c < w) g[r][c] = '#';
    };
    for (const p of gf.polys) {
      for (let i = 0; i + 1 < p.pts.length; i++) {
        const a = p.pts[i], b = p.pts[i + 1];
        const n = Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / ((x1 - x0) / (w * 2))));
        for (let k = 0; k <= n; k++) put(a.x + (b.x - a.x) * k / n, a.y + (b.y - a.y) * k / n);
      }
      if (p.closed && p.pts.length > 2) {
        const a = p.pts[p.pts.length - 1], b = p.pts[0];
        const n = Math.max(1, Math.ceil(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / ((x1 - x0) / (w * 2))));
        for (let k = 0; k <= n; k++) put(a.x + (b.x - a.x) * k / n, a.y + (b.y - a.y) * k / n);
      }
    }
    return { cp: cp, rows: g.map(r => r.join('')), label: 'U+' + cp.toString(16).toUpperCase() + ' p' + gf.polys.length };
  });
  const width = Math.max.apply(null, blocks.map(b => b.rows[0].length));
  console.log(blocks.map(b => (b.label + ' ').substr(0, width) + ' '.repeat(Math.max(0, width - b.label.length))).join(' | '));
  for (let r = 0; r < rowsN; r++) {
    console.log(blocks.map(b => (b.rows[r] || '').padEnd ? (b.rows[r] + ' '.repeat(width)).substr(0, width) : b.rows[r]).join(' | '));
  }
} else if (mode === 'dump') {
  const cps = (process.argv[4] || '').split(',').filter(Boolean).map(s => parseInt(s, 16));
  for (const cp of cps) {
    const gid = font.gidFor(cp);
    const m = font.glyphMeta(gid);
    const out = glyphPolys(font, cp, steps, 'outline');
    const wire = glyphPolys(font, cp, steps, 'wire');
    const ctr = centerPolys(font, cp, steps, 0.06);
    const w = [];
    for (const p of out) {
      const ap = contourAreaPerim(p.pts);
      if (p.closed && ap.per > 0) w.push(ap.area / ap.per * 2);
    }
    console.log('U+' + cp.toString(16).toUpperCase() + ' gid=' + gid + ' adv=' + font.advance(gid) +
      ' nc=' + m.nc + ' comp=' + m.composite + ' raw=' + font.rawGlyph(gid, 0).length +
      ' outline=' + out.length + ' wire=' + wire.length + ' center=' + ctr.length +
      ' meansWidth=' + ((ctr.meanWidth || 0)).toFixed(1) +
      ' ribbon2A/P=' + (w.length ? Math.min.apply(null, w).toFixed(1) + '..' + Math.max.apply(null, w).toFixed(1) : '-'));
  }
} else if (mode === 'dxf') {
  const out = process.argv[4] || 'font.dxf';
  const lowerMm = parseFloat(process.argv[5] || '5');
  const slant = parseFloat(process.argv[6] || '0');
  const policy = (process.argv[7] || 'outline').toLowerCase();
  const markArg = (process.argv[8] || '0').toLowerCase();
  const marksOn = markArg !== '0';
  const markMode = (markArg === 'frame' || markArg === 'framehead') ? 'frame' : 'cross';
  const headLine = markArg === 'framehead' ? 'cap' : 'glyph';
  const aMm = parseFloat(process.argv[9] || '1.0');
  const bMm = parseFloat(process.argv[10] || '11.0');
  const gapMm = parseFloat(process.argv[11] || '6');
  const toolMm = parseFloat(process.argv[12] || '0');
  const geom = buildGeometry(font, lowerMm, slant, steps, policy, { on: marksOn, mode: markMode, headLine, aMm, bMm, gapMm }, toolMm);
  const dxf = dxfFile(geom);
  fs.writeFileSync(out, dxf, 'ascii');
  fs.writeFileSync(out.replace(/\.dxf$/i, '.svg'), svgFile(geom), 'ascii');
  const total = geom.rows.reduce((n, r) => n + r.polys.length, 0);
  console.log('written ' + out + ' bytes=' + Buffer.byteLength(dxf, 'ascii') + ' policy=' + policy);
  console.log('scale=' + geom.scale.toFixed(6) + ' mm/unit rowGap=' + geom.rowGap.toFixed(2) + ' mm polylines=' + total);
  console.log('x-height=' + geom.xh.h + ' units -> ' + lowerMm + ' mm; uppercase=' +
    (geom.upBox ? (geom.upBox.h * geom.scale).toFixed(3) : '?') + ' mm');
  console.log('rows: ' + geom.rows.map(r => r.layer + '=' + r.polys.length).join(' '));
  if (marksOn && markMode === 'frame') console.log('frames: ' + geom.frameCount + ' cells on layer ' + FRAME_LAYER +
    ' (uniform: top = ' + headLine + ' + 0.01 mm, cell hangs ' + bMm + ' mm down; top at baseline + ' +
    geom.cellTopMm.toFixed(3) + ' mm, bottom at ' + geom.cellBotMm.toFixed(3) + ' mm; sides +/- ' + (aMm / 2) + ' mm, sheet gap ' + gapMm + ' mm' +
    (toolMm > 0 ? '; cells pushed out by the tool radius ' + (toolMm / 2) + ' mm' : '') + ')');
  if (toolMm > 0) console.log('tool: ' + toolMm + ' mm cutter = GOST stroke d = h/14 = ' +
    ((geom.upBox ? geom.upBox.h * geom.scale : 7) / 14).toFixed(3) + ' mm at h=' +
    (geom.upBox ? geom.upBox.h * geom.scale : 7).toFixed(3) + ' mm; centreline ends moved by (stroke/2 - r_tool)');
  if (marksOn && markMode === 'cross') console.log('marks: ' + geom.markCount + ' segments on layer ' + MARK_LAYER +
    ' (horizontal ' + aMm + ' mm, vertical ' + bMm + ' mm, sheet gap ' + gapMm + ' mm)');
  if (geom.widths.length) {
    const s = geom.widths.slice().sort((a, b) => a - b);
    console.log('measured stroke width min/med/max = ' + s[0].toFixed(3) + ' / ' + s[Math.floor(s.length / 2)].toFixed(3) + ' / ' + s[s.length - 1].toFixed(3) + ' mm');
  }
  if (geom.missing.length) console.log('MISSING ' + geom.missing.join(','));
  if (geom.synth.length) console.log('SYNTHESIZED (base letter + period dots) ' + geom.synth.join(','));
}
