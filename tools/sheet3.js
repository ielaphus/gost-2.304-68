'use strict';
/* TSV strokes -> sheet: rows by vertical overlap, letters split at the widest
   gaps inside a row, one uniform cell per letter.
   usage: sheet3.js <in.txt> <out.dxf> [capMm] [aMm] [bMm] [gapMm] [slantDeg] */
const fs = require('fs');
const src = process.argv[2], out = process.argv[3];
const CAP = parseFloat(process.argv[4] || '6.944');
const A = parseFloat(process.argv[5] || '1.0');
const B = parseFloat(process.argv[6] || '11.0');
const GAP = parseFloat(process.argv[7] || '6');
const SLANT = parseFloat(process.argv[8] || '0');
const k = Math.tan(SLANT * Math.PI / 180);
const NPERROW = (process.argv[9] || '33,33,26,26,10,17').split(',').map(Number);   // letters per row, top to bottom

const strokes = [];
for (const ln of fs.readFileSync(src, 'utf8').split(/\r?\n/)) {
  if (!ln) continue;
  const p = ln.split('\t');
  if (p.length < 4) continue;
  const v = p[3].split(',').map(Number).filter(x => isFinite(x));
  const pts = [];
  for (let i = 0; i + 1 < v.length; i += 2) pts.push({ x: v[i], y: v[i + 1] });
  if (pts.length < 2) continue;
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const q of pts) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
  strokes.push({ pts, x0, x1, y0, y1 });
}
const allTop = Math.max.apply(null, strokes.map(s => s.y1));
const allBot = Math.min.apply(null, strokes.map(s => s.y0));
const capUnits = allTop - allBot;
const sc = CAP / capUnits;

/* rows: k-means on the vertical centre of the strokes (the number of text rows
   is known from the glyph counts) */
const KROWS = NPERROW.length;
const cyc = strokes.map(s => (s.y0 + s.y1) / 2);
let cent = [];
{
  const ys = cyc.slice().sort((a, b) => b - a);
  for (let i = 0; i < KROWS; i++) cent.push(ys[Math.floor((i + 0.5) * ys.length / KROWS)]);
}
for (let it = 0; it < 40; it++) {
  const sum = cent.map(() => 0), cnt = cent.map(() => 0);
  for (let i = 0; i < cyc.length; i++) {
    let bi = 0, bd = 1e18;
    for (let c = 0; c < cent.length; c++) { const d = Math.abs(cyc[i] - cent[c]); if (d < bd) { bd = d; bi = c; } }
    sum[bi] += cyc[i]; cnt[bi]++;
  }
  for (let c = 0; c < cent.length; c++) if (cnt[c]) cent[c] = sum[c] / cnt[c];
}
const rows = cent.map(c => ({ c, items: [] }));
for (let i = 0; i < cyc.length; i++) {
  let bi = 0, bd = 1e18;
  for (let c = 0; c < cent.length; c++) { const d = Math.abs(cyc[i] - cent[c]); if (d < bd) { bd = d; bi = c; } }
  rows[bi].items.push(strokes[i]);
}
rows.sort((a, b) => b.c - a.c);

const cellTop = CAP + 0.01, cellBot = cellTop - B;
const rowGap = Math.max(18, CAP * 2.6);
const PERROW = 26;
const outRows = [], frames = [];
let y = 0, total = 0, splitInfo = [];
for (let ri = 0; ri < rows.length; ri++) {
  const row = rows[ri];
  const items = row.items.slice().sort((a, b) => a.x0 - b.x0);
  const want = NPERROW[ri] || 0;
  const gaps = [];
  let curMax = items[0].x1;
  for (let i = 1; i < items.length; i++) { gaps.push({ i, g: items[i].x0 - curMax }); if (items[i].x1 > curMax) curMax = items[i].x1; }
  let cuts = [];
  if (want > 1 && want - 1 <= gaps.length) {
    cuts = gaps.slice().sort((a, b) => b.g - a.g).slice(0, want - 1).map(o => o.i).sort((a, b) => a - b);
  } else {
    const gs = gaps.map(o => o.g).sort((a, b) => b - a);
    const thr = gs.length ? gs[Math.min(gs.length - 1, 5)] : 0;
    cuts = gaps.filter(o => o.g >= thr).map(o => o.i);
  }
  splitInfo.push(items.length + '->' + (cuts.length + 1));
  const letters = [];
  let from = 0;
  for (const c of cuts.concat([items.length])) {
    const grp = items.slice(from, c);
    from = c;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const s of grp) { if (s.x0 < x0) x0 = s.x0; if (s.x1 > x1) x1 = s.x1; if (s.y0 < y0) y0 = s.y0; if (s.y1 > y1) y1 = s.y1; }
    letters.push({ items: grp, x0, x1, y0, y1 });
  }
  const rowBase = Math.max.apply(null, letters.map(l => l.y0));
  for (let i = 0; i < letters.length; i += PERROW) {
    const chunk = letters.slice(i, i + PERROW);
    let pen = 0;
    const polys = [];
    for (const l of chunk) {
      const ox = pen - l.x0 * sc;
      for (const s of l.items) {
        const pts = s.pts.map(q => { const yy = (q.y - rowBase) * sc + y; return { x: (q.x - l.x0) * sc + ox + (yy - y) * k, y: yy }; });
        polys.push(pts);
      }
      const cx0 = pen - A / 2, cx1 = pen + (l.x1 - l.x0) * sc + A / 2;
      frames.push({ x0: cx0, x1: cx1, y });
      pen = cx1 + GAP;
      total++;
    }
    outRows.push({ layer: 'SHX_LETTERS', color: 7, polys });
    y -= rowGap;
  }
}
const framePolys = frames.map(f => ({
  closed: true,
  pts: [{ x: f.x0 + cellTop * k, y: f.y + cellTop }, { x: f.x1 + cellTop * k, y: f.y + cellTop },
        { x: f.x1 + cellBot * k, y: f.y + cellBot }, { x: f.x0 + cellBot * k, y: f.y + cellBot }]
}));
outRows.push({ layer: 'GOST_FRAME', color: 4, polys: framePolys });

const NL = '\r\n';
const ent = (layer, pts, closed) => {
  let s = ['0', 'POLYLINE', '8', layer, '66', '1', '70', closed ? '1' : '0', ''].join(NL);
  for (const p of pts) s += ['0', 'VERTEX', '8', layer, '10', p.x.toFixed(4), '20', p.y.toFixed(4), '30', '0.0', ''].join(NL);
  return s + ['0', 'SEQEND', '8', layer, ''].join(NL);
};
let ents = '';
for (const row of outRows) for (const p of row.polys) ents += ent(row.layer, Array.isArray(p) ? p : p.pts, !!p.closed);
let dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '0', 'ENDSEC', ''].join(NL);
dxf += ['0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', String(outRows.length), ''].join(NL);
for (const row of outRows) dxf += ['0', 'LAYER', '2', row.layer, '70', '0', '62', String(row.color), '6', 'CONTINUOUS', ''].join(NL);
dxf += ['0', 'ENDTAB', '0', 'ENDSEC', ''].join(NL);
dxf += ['0', 'SECTION', '2', 'ENTITIES', ''].join(NL) + ents + ['0', 'ENDSEC', '0', 'EOF', ''].join(NL);
fs.writeFileSync(out, dxf, 'ascii');
console.log('strokes=' + strokes.length + ' rows=' + rows.length + ' cells=' + total + ' slant=' + SLANT +
  ' capUnits=' + capUnits.toFixed(2) + ' scale=' + sc.toFixed(4));
console.log('row splits (strokes->letters): ' + splitInfo.join(' '));
