'use strict';
/* Verify the grouped sheet: INSERTs are zipped with the GOST_FRAME rectangles in
   order, every letter is expanded through its block and checked for the cell
   shape (11 mm tall, shear 15 deg) and the equal left/right padding.
   usage: verify-grouped.js <file.dxf> [slantDeg] [padMm] */
const fs = require('fs');

const file = process.argv[2];
const SLANT = parseFloat(process.argv[3] || '15');
const PAD = parseFloat(process.argv[4] || '0.6944');
const k = Math.tan(SLANT * Math.PI / 180);
const HEIGHT = 11;

const L = fs.readFileSync(file, 'ascii').split(/\r?\n/);
const blocks = new Map();
let inBlocks = false, inEnt = false, name = null, polys = null;
const inserts = [], frames = [];

for (let i = 0; i + 1 < L.length; i += 2) {
  const c = L[i].trim(), v = L[i + 1].trim();
  if (c === '2' && v === 'BLOCKS') { inBlocks = true; continue; }
  if (c === '2' && v === 'ENTITIES') { inBlocks = false; inEnt = true; continue; }
  if (inBlocks) {
    if (c === '0' && v === 'BLOCK') { name = null; polys = []; continue; }
    if (c === '0' && v === 'ENDBLK') { if (name) blocks.set(name, polys || []); polys = null; name = null; continue; }
    if (!polys) continue;
    if (c === '2' && !name) { name = v; continue; }
    if (c === '0' && v === 'POLYLINE') { polys.push({ pts: [] }); continue; }
    if (c === '0' && v === 'VERTEX') { const p = polys[polys.length - 1]; if (p) p.pts.push({ x: 0, y: 0 }); continue; }
    if (c === '10') { const p = polys[polys.length - 1]; if (p && p.pts.length) p.pts[p.pts.length - 1].x = parseFloat(v); }
    if (c === '20') { const p = polys[polys.length - 1]; if (p && p.pts.length) p.pts[p.pts.length - 1].y = parseFloat(v); }
    continue;
  }
  if (!inEnt) continue;
  if (c === '0' && v === 'ENDSEC') break;
  if (c === '0' && v === 'INSERT') { inserts.push({}); continue; }
  const cur = inserts[inserts.length - 1];
  if (!cur) continue;
  if (c === '2') cur.name = v;
  if (c === '10') cur.x = parseFloat(v);
  if (c === '20') cur.y = parseFloat(v);
}

inEnt = false;
for (let i = 0; i + 1 < L.length; i += 2) {
  const c = L[i].trim(), v = L[i + 1].trim();
  if (c === '2' && v === 'ENTITIES') { inEnt = true; continue; }
  if (!inEnt) continue;
  if (c !== '0' || v !== 'POLYLINE') continue;
  let layer = '', pts = [], j = i + 2;
  for (; j + 1 < L.length; j += 2) {
    const cc = L[j].trim(), vv = L[j + 1].trim();
    if (cc === '0' && vv === 'VERTEX') continue;
    if (cc === '0' && (vv === 'SEQEND' || vv === 'ENDSEC')) break;
    if (cc === '8') layer = vv;
    if (cc === '10') pts.push({ x: parseFloat(vv), y: 0 });
    if (cc === '20' && pts.length) pts[pts.length - 1].y = parseFloat(vv);
  }
  if (layer === 'GOST_FRAME') frames.push(pts);
}

const u = (p, base) => p.x - (p.y - base) * k;
let bad = 0, minPadL = 1e9, maxPadL = -1e9, minPadR = 1e9, maxPadR = -1e9;
const shears = [], heights = [];
const tops = new Set();

frames.forEach((f, idx) => {
  const ys = f.map(p => p.y);
  const top = Math.max.apply(null, ys), bot = Math.min.apply(null, ys);
  heights.push(top - bot);
  tops.add(top.toFixed(1));
  const base = bot + HEIGHT;                    /* cellBot = cellTop - 11 */
  const us = f.map(p => u(p, base));
  const f0 = Math.min.apply(null, us), f1 = Math.max.apply(null, us);
  const leftSide = f.filter(p => Math.abs(u(p, base) - f0) < 1e-3);
  if (leftSide.length === 2) shears.push((leftSide[0].x - leftSide[1].x) / (leftSide[0].y - leftSide[1].y));

  const ins = inserts[idx];
  if (!ins) return;
  const src = blocks.get(ins.name) || [];
  let i0 = 1e9, i1 = -1e9;
  for (const p of src) for (const q of p.pts) {
    const uu = u({ x: q.x + ins.x, y: q.y + ins.y }, base);
    if (uu < i0) i0 = uu;
    if (uu > i1) i1 = uu;
  }
  if (i0 > i1) return;
  const padL = i0 - f0, padR = f1 - i1;
  minPadL = Math.min(minPadL, padL); maxPadL = Math.max(maxPadL, padL);
  minPadR = Math.min(minPadR, padR); maxPadR = Math.max(maxPadR, padR);
  if (Math.abs(padL - PAD) > 0.01 || Math.abs(padR - PAD) > 0.01) {
    bad++;
    if (bad < 4) console.log('  cell ' + idx + ' padL=' + padL.toFixed(3) + ' padR=' + padR.toFixed(3));
  }
});

let strokeCount = 0;
for (const a of blocks.values()) strokeCount += a.length;
console.log('blocks=' + blocks.size + ' inserts=' + inserts.length + ' frames=' + frames.length + ' strokedPolys=' + strokeCount);
console.log('rows=' + tops.size + '  frame height ' + Math.min.apply(null, heights).toFixed(4) + '..' + Math.max.apply(null, heights).toFixed(4));
if (shears.length) console.log('frame side slope dx/dy ' + Math.min.apply(null, shears).toFixed(3) + '..' + Math.max.apply(null, shears).toFixed(3) + '  (tan' + SLANT + ' = ' + k.toFixed(3) + ')');
console.log('padding L ' + minPadL.toFixed(3) + '..' + maxPadL.toFixed(3) + '  R ' + minPadR.toFixed(3) + '..' + maxPadR.toFixed(3) + '  target ' + PAD.toFixed(3));
console.log('cells off target: ' + bad);
