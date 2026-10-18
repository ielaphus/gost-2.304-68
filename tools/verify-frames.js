'use strict';
/* Independent re-parse of a generated DXF: checks the GOST_FRAME cells and
   whether the glyph geometry stays inside them.  ASCII output only. */
const fs = require('fs');

const file = process.argv[2];
if (!file) { console.log('usage: verify-frames.js <file.dxf>'); process.exit(1); }
const lines = fs.readFileSync(file, 'ascii').split(/\r?\n/);

/* entity scan: POLYLINE ... VERTEX ... SEQEND on any layer */
const polys = [];
let cur = null, inEnt = false;
for (let i = 0; i + 1 < lines.length; i += 2) {
  const code = lines[i].trim(), val = lines[i + 1];
  if (code === '2' && val === 'ENTITIES') { inEnt = true; continue; }
  if (!inEnt) continue;
  if (code === '0') {
    const v = val.trim();
    if (v === 'POLYLINE') cur = { layer: '', pts: [] };
    else if (v === 'VERTEX' && cur) cur.pending = true;
    else if (v === 'SEQEND' && cur) { polys.push(cur); cur = null; }
    else if (v === 'ENDSEC') break;
    continue;
  }
  if (!cur) continue;
  if (code === '8' && !cur.pending) cur.layer = val.trim();
  if (code === '8' && cur.pending) cur.vertexLayer = val.trim();
  if (code === '10' && cur.pending) cur.vx = parseFloat(val);
  if (code === '20' && cur.pending) {
    cur.vy = parseFloat(val);
    cur.pts.push({ x: cur.vx, y: cur.vy });
    cur.pending = false;
  }
}

const frames = polys.filter(p => p.layer === 'GOST_FRAME');
const glyphs = polys.filter(p => p.layer !== 'GOST_FRAME' && p.layer !== 'GOST_MARK');
console.log('entities=' + polys.length + ' frames=' + frames.length + ' glyphPolylines=' + glyphs.length);

/* frame boxes */
const boxes = frames.map(f => {
  const ys = f.pts.map(p => p.y), xs = f.pts.map(p => p.x);
  return {
    n: f.pts.length,
    top: Math.max.apply(null, ys), bot: Math.min.apply(null, ys),
    x0: Math.min.apply(null, xs), x1: Math.max.apply(null, xs)
  };
});
const bad = boxes.filter(b => b.n !== 4);
console.log('frames with !=4 vertices: ' + bad.length);
const hs = boxes.map(b => b.top - b.bot);
hs.sort((a, b) => a - b);
console.log('frame height min/max = ' + hs[0].toFixed(4) + ' / ' + hs[hs.length - 1].toFixed(4) + ' mm');

/* group frames into rows by top y */
const tops = [];
for (const b of boxes) if (!tops.some(t => Math.abs(t - b.top) < 1e-6)) tops.push(b.top);
tops.sort((a, b) => b - a);
console.log('distinct frame tops = ' + tops.length + ' (rows): ' + tops.map(t => t.toFixed(4)).join(', '));
const bots = [];
for (const b of boxes) if (!bots.some(t => Math.abs(t - b.bot) < 1e-6)) bots.push(b.bot);
bots.sort((a, b) => b - a);
console.log('distinct frame bottoms = ' + bots.length + ': ' + bots.map(t => t.toFixed(4)).join(', '));
const perRow = tops.map(t => boxes.filter(b => Math.abs(b.top - t) < 1e-6).length);
console.log('frames per row = ' + perRow.join('+') + ' = ' + perRow.reduce((a, b) => a + b, 0));

/* row pitch and shear of the top edge vs the bottom edge */
if (tops.length > 1) {
  const pitch = [];
  for (let i = 1; i < tops.length; i++) pitch.push(tops[i - 1] - tops[i]);
  console.log('row pitch (top-to-top) = ' + pitch.map(p => p.toFixed(4)).join(', ') + ' mm');
}
const row0 = boxes.filter(b => Math.abs(b.top - tops[0]) < 1e-6);
const sample = row0[0];
console.log('first row: top=' + sample.top.toFixed(4) + ' bot=' + sample.bot.toFixed(4) +
  ' left=' + sample.x0.toFixed(4) + ' right=' + sample.x1.toFixed(4));

/* shear check: for one frame, the top edge must be shifted sideways vs its bottom edge */
const one = frames[0];
const oy = one.pts.map(p => p.y), otop = Math.max.apply(null, oy), obot = Math.min.apply(null, oy);
const otx = one.pts.filter(p => Math.abs(p.y - otop) < 1e-9).map(p => p.x);
const obx = one.pts.filter(p => Math.abs(p.y - obot) < 1e-9).map(p => p.x);
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
console.log('frame1 top edge x mid=' + mean(otx).toFixed(4) + ' bottom edge x mid=' + mean(obx).toFixed(4) +
  '  shear delta=' + (mean(otx) - mean(obx)).toFixed(4) + ' mm over ' + (otop - obot).toFixed(3) + ' mm height');

/* glyph containment per row band */
const bands = tops.map((t, i) => ({ top: t, bot: bots[i], above: 0, below: 0, maxY: -1e9, minY: 1e9 }));
let nan = 0, minY = 1e9, maxY = -1e9;
for (const g of glyphs) for (const p of g.pts) {
  if (!isFinite(p.x) || !isFinite(p.y)) { nan++; continue; }
  if (p.y < minY) minY = p.y;
  if (p.y > maxY) maxY = p.y;
  for (const b of bands) {
    if (p.y <= b.top + 1e-9 && p.y >= b.bot - 1e-9) {
      if (p.y > b.maxY) b.maxY = p.y;
      if (p.y < b.minY) b.minY = p.y;
      break;
    }
    /* outside: attribute to the nearest band vertically */
  }
}
/* attribute out-of-band vertices to the band whose centre is nearest */
for (const g of glyphs) for (const p of g.pts) {
  if (!isFinite(p.y)) continue;
  let best = null, bd = 1e9;
  for (const b of bands) {
    if (p.y <= b.top + 1e-9 && p.y >= b.bot - 1e-9) { best = null; break; }
    const d = Math.abs(p.y - (b.top + b.bot) / 2);
    if (d < bd) { bd = d; best = b; }
  }
  if (best) {
    if (p.y > best.top) { best.above++; if (p.y - best.top > (best.over || 0)) best.over = p.y - best.top; }
    else { best.below++; if (best.bot - p.y > (best.under || 0)) best.under = best.bot - p.y; }
  }
}
console.log('glyph vertices: y range ' + minY.toFixed(4) + ' .. ' + maxY.toFixed(4) + '  NaN: ' + nan);
let tot = 0;
bands.forEach((b, i) => {
  tot += b.above + b.below;
  if (b.above || b.below) {
    console.log('  row ' + (i + 1) + ': top=' + b.top.toFixed(4) + ' bot=' + b.bot.toFixed(4) +
      ' above=' + b.above + ' below=' + b.below +
      ' maxOvershoot=' + (b.over || 0).toFixed(4) + ' maxUndershoot=' + (b.under || 0).toFixed(4) +
      ' (glyph y within band ' + b.minY.toFixed(4) + ' .. ' + b.maxY.toFixed(4) + ')');
  }
});
console.log('=> vertices outside their own cell: ' + tot);
