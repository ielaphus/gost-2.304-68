'use strict';
/* Build the CNC sheet from the hand-drawn GOST letter sheet
   (cnc/Чертеж1.dxf, exported as TSV by dxf2tsv.js).
   Rows  = bands of ink (y projection).
   Letters = connected intervals of the x projection inside a row, so no ink is
   ever dropped or moved to a neighbour letter.
   The two letters drawn to the right of the block (Й й) are pulled out by the
   largest horizontal gap and inserted at their GOST position.
   usage: cnc-sheet.js <in.txt> probe
          cnc-sheet.js <in.txt> out <dxf> [capMm] [aMm] [bMm] [gapMm] [slantDeg] */
const fs = require('fs');
const file = process.argv[2];
const mode = process.argv[3] || 'probe';
/* ---------------- read TSV ---------------- */
const strokes = [];
for (const ln of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  if (!ln.trim()) continue;
  const f = ln.split('\t');
  if (f.length < 4) continue;
  if (f[1] === 'GOST_FRAME') continue;
  const n = f[3].split(',').map(Number);
  const pts = [];
  for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: n[i], y: n[i + 1] });
  if (pts.length >= 2) strokes.push(pts);
}
if (!strokes.length) { console.log('no strokes'); process.exit(1); }
const bboxOf = pts => {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  return { x0, x1, y0, y1 };
};
const BB = strokes.map(bboxOf);
const pct = (arr, q) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
};
const mode1d = (arr, step) => {
  const h = new Map();
  for (const v of arr) { const k = Math.round(v / step); h.set(k, (h.get(k) || 0) + 1); }
  let bk = null, bn = -1;
  for (const [k, n] of h) if (n > bn) { bn = n; bk = k; }
  return bk === null ? 0 : bk * step;
};
/* ---------------- ink bands ---------------- */
let yLo = 1e9, yHi = -1e9;
for (const b of BB) { if (b.y0 < yLo) yLo = b.y0; if (b.y1 > yHi) yHi = b.y1; }
const BIN = 0.1;
const nb = Math.ceil((yHi - yLo) / BIN) + 2;
const hist = new Int32Array(nb);
for (const pts of strokes) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.05));
    for (let k = 0; k <= n; k++) {
      const y = a.y + (b.y - a.y) * k / n;
      hist[Math.min(nb - 1, Math.max(0, Math.floor((y - yLo) / BIN)))]++;
    }
  }
}
const bands = [];
let s0 = -1;
for (let i = 0; i < nb; i++) {
  if (hist[i] > 0 && s0 < 0) s0 = i;
  if ((hist[i] === 0 || i === nb - 1) && s0 >= 0) {
    if ((i - s0) * BIN >= 1) bands.push({ y0: yLo + s0 * BIN, y1: yLo + i * BIN });
    s0 = -1;
  }
}
bands.sort((a, b) => b.y1 - a.y1);
/* ---------------- x intervals = letters ---------------- */
function intervalsOf(idxs, gapTol) {
  const iv = idxs.map(i => ({ x0: BB[i].x0, x1: BB[i].x1 })).sort((a, b) => a.x0 - b.x0);
  const out = [];
  for (const r of iv) {
    const last = out[out.length - 1];
    if (last && r.x0 - last.x1 <= gapTol) last.x1 = Math.max(last.x1, r.x1);
    else out.push({ x0: r.x0, x1: r.x1 });
  }
  return out;
}
const rows = [];
for (const b of bands) {
  const idxs = [];
  for (let i = 0; i < strokes.length; i++) {
    const c = (BB[i].y0 + BB[i].y1) / 2;
    if (c <= b.y1 + 0.2 && c >= b.y0 - 0.2) idxs.push(i);
  }
  if (!idxs.length) continue;
  const base = mode1d(idxs.map(i => BB[i].y0), 0.05);
  const intervals = intervalsOf(idxs, 0.25);
  rows.push({ band: b, idxs, base, intervals });
}

/* strokes that live in a hair-thin band of their own (the two dots of Ё above
   the cap line) must not get lost: attach them to the row they belong to */
{
  const assigned = new Set();
  for (const r of rows) for (const i of r.idxs) assigned.add(i);
  const rest = [];
  for (let i = 0; i < strokes.length; i++) if (!assigned.has(i)) rest.push(i);
  for (const i of rest) {
    const b = BB[i], cx = (b.x0 + b.x1) / 2;
    let best = null, bd = 1e9;
    for (const r of rows) {
      const nearX = r.intervals.some(iv => cx >= iv.x0 - 1.5 && cx <= iv.x1 + 1.5);
      if (!nearX) continue;
      const d = b.y0 > r.band.y1 ? b.y0 - r.band.y1 : (b.y1 < r.band.y0 ? r.band.y0 - b.y1 : 0);
      if (d < bd && d <= 2.0) { bd = d; best = r; }
    }
    if (best) { best.idxs.push(i); if (process.env.DUMPIV) console.log('  orphan x' + ((b.x0 + b.x1) / 2).toFixed(1) + ' y' + b.y0.toFixed(2) + '..' + b.y1.toFixed(2) + ' -> row base ' + best.base.toFixed(2) + ' d=' + bd.toFixed(2)); }
  }
  for (const r of rows) r.intervals = intervalsOf(r.idxs, 0.25);
  if (rest.length) console.log('re-attached ' + rest.length + ' stroke(s) that fell between the rows');
}
/* ---------------- the floating Й / й pair ---------------- */
let tail = [], tailRow = -1;
for (let ri = 0; ri < rows.length; ri++) {
  const r = rows[ri];
  let bi = -1, bg = 0;
  for (let i = 1; i < r.intervals.length; i++) {
    const g = r.intervals[i].x0 - r.intervals[i - 1].x1;
    if (g > bg) { bg = g; bi = i; }
  }
  if (bi > 0 && bg > 8 && r.intervals.length - bi <= 3) { tail = r.intervals.splice(bi); tailRow = ri; break; }
}
/* glyph = the strokes inside one x interval; `baseline` is the row baseline the
   letter stands on (descenders hang below it, they must not lift the letter) */
const glyphOf = (iv, pool, baseline) => {
  const st = pool.filter(i => {
    const cx = (BB[i].x0 + BB[i].x1) / 2;
    return cx >= iv.x0 - 1e-6 && cx <= iv.x1 + 1e-6;
  });
  const box = bboxOf(st.flatMap(i => strokes[i]));
  return { strokes: st.map(i => strokes[i]), box, base: baseline === undefined ? box.y0 : baseline };
};
if (mode === 'probe') {
  console.log('strokes=' + strokes.length + ' bands=' + rows.length + ' tail=' + tail.length + (tailRow >= 0 ? ' in row ' + (tailRow + 1) : ''));
  rows.forEach((r, i) => {
    const gs = r.intervals.map(iv => glyphOf(iv, r.idxs));
    console.log('row ' + (i + 1) + ' y ' + r.band.y1.toFixed(1) + '..' + r.band.y0.toFixed(1) +
      ' strokes=' + r.idxs.length + ' letters=' + r.intervals.length +
      ' base=' + r.base.toFixed(2) + ' cap=' + pct(gs.map(g => g.box.y1 - r.base), 0.9).toFixed(2) +
      ' x ' + r.intervals[0].x0.toFixed(1) + '..' + r.intervals[r.intervals.length - 1].x1.toFixed(1));
  });
  if (tail.length) {
    const all = rows.flatMap(r => r.idxs);
    const tg = tail.map(iv => glyphOf(iv, all));
    console.log('tail: ' + tg.map(g => (g.box.x1 - g.box.x0).toFixed(1) + 'x' + (g.box.y1 - g.box.y0).toFixed(1) + '@' + g.box.x0.toFixed(1) + ' base' + g.base.toFixed(1)).join(' | '));
  }
  process.exit(0);
}
/* ---------------- build ---------------- */
const outPath = process.argv[4];
const CAP = parseFloat(process.argv[5] || '6.944');
const A = parseFloat(process.argv[6] || (0.2 * CAP).toFixed(4));   /* GOST letter spacing a = 0.2 h */
const B = parseFloat(process.argv[7] || '11.0');
const GAP = parseFloat(process.argv[8] || '6');
const SLANT = parseFloat(process.argv[9] || '0');
const k = Math.tan(SLANT * Math.PI / 180);
const WANT = (process.env.WANT || '32,32,26,26,10,16').split(',').map(Number);
/* bring every row to its wanted letter count by folding the narrowest interval
   (a bare stem such as the right stroke of Ы) into its closest neighbour */
rows.forEach((r, i) => {
  const want = WANT[i];
  if (!want) return;
  while (r.intervals.length > want && r.intervals.length > 1) {
    let bi = 0, bw = 1e9;
    for (let j = 0; j < r.intervals.length; j++) {
      const w = r.intervals[j].x1 - r.intervals[j].x0;
      if (w < bw) { bw = w; bi = j; }
    }
    const a = r.intervals[bi - 1], b = r.intervals[bi], c = r.intervals[bi + 1];
    const gapL = a ? b.x0 - a.x1 : 1e9, gapR = c ? c.x0 - b.x1 : 1e9;
    const target = r.intervals[gapL <= gapR ? bi - 1 : bi + 1], victim = r.intervals[bi];
    target.x0 = Math.min(target.x0, victim.x0);
    target.x1 = Math.max(target.x1, victim.x1);
    r.intervals.splice(bi, 1);
  }
});
if (process.env.DUMPIV) rows.forEach((r, i) => { console.log('R' + i + ' intervals=' + r.intervals.length + ' ' + r.intervals.map(iv => '[' + iv.x0.toFixed(1) + '-' + iv.x1.toFixed(1) + '|' + r.idxs.filter(j => { const cx = (BB[j].x0 + BB[j].x1) / 2; return cx >= iv.x0 - 1e-6 && cx <= iv.x1 + 1e-6; }).length + ']').join(' ')); });
const rowsOut = rows.map((r, i) => {
  const glyphs = r.intervals.map(iv => glyphOf(iv, r.idxs, r.base));
  const cap = pct(glyphs.map(g => g.box.y1 - r.base), 0.9) || 1;
  return { glyphs, base: r.base, cap };
});
const groups = ['up', 'lo', 'lu', 'll', 'dg', 'pn'];
rowsOut.forEach((r, i) => { r.group = groups[i] || ('r' + i); });
const NL = '\r\n';
const poly = (layer, pts, closed) => {
  let s = ['0', 'POLYLINE', '8', layer, '66', '1', '70', closed ? '1' : '0', ''].join(NL);
  for (const p of pts) s += ['0', 'VERTEX', '8', layer, '10', p.x.toFixed(4), '20', p.y.toFixed(4), '30', '0.0', ''].join(NL);
  return s + ['0', 'SEQEND', '8', layer, ''].join(NL);
};
const LAYER = { up: ['GOST_UPPER', 7], lo: ['GOST_LOWER', 1], lu: ['GOST_LAT_UP', 5], ll: ['GOST_LAT_LOW', 6], dg: ['GOST_DIGIT', 3], pn: ['GOST_PUNCT', 2] };
const ROW_PITCH = Math.max(18.05, CAP * 2.6);
const layers = Object.keys(LAYER).map(g => ({ layer: LAYER[g][0], colour: LAYER[g][1] }));
layers.push({ layer: 'GOST_FRAME', colour: 4 });
/* the floating pair: the taller letter goes into the cap row, the other one
   into the x-height row */
if (tail.length) {
  const all = rows.flatMap(r => r.idxs);
  const tg = tail.map(iv => glyphOf(iv, all)).sort((a, b) => (b.box.y1 - b.box.y0) - (a.box.y1 - a.box.y0));
  const put = (rowIndex, g) => {
    const r = rowsOut[rowIndex];
    if (!r || !g || r.glyphs.length !== 32) return;
    r.glyphs.splice(10, 0, g);
  };
  put(0, tg[0]);
  put(1, tg[1] || null);
}
/* one scale for the whole sheet: the cap height of the letters row */
const capGlobal = rowsOut[0] ? pct(rowsOut[0].glyphs.map(g => g.box.y1 - rowsOut[0].base), 0.9) : 1;
const SC = CAP / (capGlobal || 1);
/* left/right padding inside a cell: GOST 2.304 letter spacing a = 0.2 h,
   so half of it on each side of the letter */
const PAD = A / 2;

/* place everything first, then set the head line from the real ink so that
   dots and breves stay inside the cells */
const cellsInfo = [];
let yRow = 0;
const stat = [];
for (const row of rowsOut) {
  const layer = LAYER[row.group][0];
  let pen = 0;
  for (let gi = 0; gi < row.glyphs.length; gi++) {
    const g = row.glyphs[gi];
    const polys = g.strokes.map(pts => pts.map(p => ({
      u: pen + (p.x - g.box.x0) * SC,
      y: (p.y - g.base) * SC + yRow
    })));
    /* the cell is built from the real ink of the letter, so the padding is
       exactly PAD on both sides */
    let uMin = 1e9, uMax = -1e9;
    for (const pts of polys) for (const q of pts) { if (q.u < uMin) uMin = q.u; if (q.u > uMax) uMax = q.u; }
    cellsInfo.push({ polys, u0: uMin - PAD, u1: uMax + PAD, y: yRow, layer, group: row.group, idx: gi });
    pen = uMax + PAD + GAP;
  }
  stat.push(row.group + '=' + row.glyphs.length);
  yRow -= ROW_PITCH;
}

/* head line and tail line of the whole sheet: the cell must hold the tallest ink
   above the baseline and the deepest descender below it, height stays B */
let topNeed = -1e9, botNeed = -1e9;
for (const c of cellsInfo) for (const pts of c.polys) for (const q of pts) {
  const h = q.y - c.y;
  if (h > topNeed) topNeed = h;
  if (-h > botNeed) botNeed = -h;
}
if (topNeed + botNeed > B - 0.02) {
  console.log('note: deepest ink is ' + ((topNeed + botNeed) - (B - 0.01)).toFixed(2) + ' mm below the cell bottom (descenders)');
}
const cellTop = topNeed + 0.01;
const cellBot = cellTop - B;

/* the cell sides run along the shear direction, so the letter keeps an equal
   left/right padding at every height */
const shear = (c, u, y) => u + (y - c.y) * k;

const BLOCK_PREFIX = { up: 'UP', lo: 'LO', lu: 'LU', ll: 'LL', dg: 'DG', pn: 'PN' };
const pad2 = n => (n < 10 ? '0' + n : String(n));
const blockName = c => (BLOCK_PREFIX[c.group] || 'G') + pad2(c.idx + 1);

const GROUPED = process.env.GROUPED !== '0';
let ents = '';
for (const c of cellsInfo) {
  if (GROUPED) {
    const bx = shear(c, c.u0, c.y + cellBot), by = c.y + cellBot;
    ents += ['0', 'INSERT', '8', c.layer, '2', blockName(c), '10', bx.toFixed(4), '20', by.toFixed(4), '30', '0.0', ''].join(NL);
  } else {
    for (const pts of c.polys) {
      ents += poly(c.layer, pts.map(p => ({ x: shear(c, p.u, p.y), y: p.y })), false);
    }
  }
}
for (const c of cellsInfo) {
  ents += poly('GOST_FRAME', [
    { x: shear(c, c.u0, c.y + cellTop), y: c.y + cellTop },
    { x: shear(c, c.u1, c.y + cellTop), y: c.y + cellTop },
    { x: shear(c, c.u1, c.y + cellBot), y: c.y + cellBot },
    { x: shear(c, c.u0, c.y + cellBot), y: c.y + cellBot }], true);
}

let blocks = '';
if (GROUPED) {
  for (const c of cellsInfo) {
    const bx = shear(c, c.u0, c.y + cellBot), by = c.y + cellBot;
    const name = blockName(c);
    blocks += ['0', 'BLOCK', '8', c.layer, '2', name, '70', '0', '10', '0.0', '20', '0.0', '30', '0.0', '3', name, '1', ''].join(NL) + NL;   /* the empty xref line must stay a value line */
    for (const pts of c.polys) blocks += poly('0', pts.map(p => ({ x: shear(c, p.u, p.y) - bx, y: p.y - by })), false);
    blocks += ['0', 'ENDBLK', '8', c.layer, ''].join(NL);
  }
}

const cells = cellsInfo.length;
let dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '0', 'ENDSEC', ''].join(NL);
dxf += ['0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', String(layers.length + 1), ''].join(NL);
dxf += ['0', 'LAYER', '2', '0', '70', '0', '62', '7', '6', 'CONTINUOUS', ''].join(NL);
for (const l of layers) dxf += ['0', 'LAYER', '2', l.layer, '70', '0', '62', String(l.colour), '6', 'CONTINUOUS', ''].join(NL);
dxf += ['0', 'ENDTAB', '0', 'ENDSEC', ''].join(NL);
if (GROUPED) dxf += ['0', 'SECTION', '2', 'BLOCKS', ''].join(NL) + blocks + ['0', 'ENDSEC', ''].join(NL);
dxf += ['0', 'SECTION', '2', 'ENTITIES', ''].join(NL) + ents + ['0', 'ENDSEC', '0', 'EOF', ''].join(NL);
fs.writeFileSync(outPath, dxf, 'ascii');
console.log('written ' + outPath + ' cells=' + cells + ' rows=' + stat.join(',') +
  ' pad=' + PAD.toFixed(3) + ' grouped=' + (GROUPED ? 'blocks' : 'flat'));