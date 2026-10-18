'use strict';
/* TSV strokes -> sheet. Letters are found by 1-D interval clustering inside a
   text row with an auto-tuned tolerance so that the glyph count matches the
   number of characters in that row.
   usage: sheet4.js <in.txt> <out.dxf> <counts,comma> [capMm] [aMm] [bMm] [gapMm] [slantDeg] */
const fs = require('fs');
const src = process.argv[2], out = process.argv[3];
const NPERROW = (process.argv[4] || '').split(',').filter(Boolean).map(Number);
const CAP = parseFloat(process.argv[5] || '6.944');
const A = parseFloat(process.argv[6] || '1.0');
const B = parseFloat(process.argv[7] || '11.0');
const GAP = parseFloat(process.argv[8] || '6');
const SLANT = parseFloat(process.argv[9] || '0');
const k = Math.tan(SLANT * Math.PI / 180);
if (!src || !out) { console.log('usage: sheet4.js <in.txt> <out.dxf> <counts> [capMm] [aMm] [bMm] [gapMm] [slantDeg]'); process.exit(1); }

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
if (!strokes.length) { console.log('no strokes'); process.exit(1); }
const capUnits = Math.max.apply(null, strokes.map(s => s.y1)) - Math.min.apply(null, strokes.map(s => s.y0));
const sc = CAP / capUnits;

/* rows by k-means on the vertical centre */
const K = Math.max(1, NPERROW.length);
const cyc = strokes.map(s => (s.y0 + s.y1) / 2);
let cent = [];
{
  const ys = cyc.slice().sort((a, b) => b - a);
  for (let i = 0; i < K; i++) cent.push(ys[Math.floor((i + 0.5) * ys.length / K)]);
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

/* split one row into letters: interval clustering on x with auto-tuned tolerance */
function splitRow(items, want) {
  const sorted = items.slice().sort((a, b) => a.x0 - b.x0);
  const clusterAt = tol => {
    const out = [];
    let cur = null;
    for (const s of sorted) {
      if (cur && s.x0 <= cur.x1 + tol) {
        cur.items.push(s);
        if (s.x1 > cur.x1) cur.x1 = s.x1;
      } else {
        cur = { items: [s], x0: s.x0, x1: s.x1 };
        out.push(cur);
      }
    }
    return out;
  };
  if (!want) return clusterAt(0.02 * capUnits);
  let best = null;
  for (let f = 0.002; f <= 0.30; f += 0.002) {
    const g = clusterAt(f * capUnits);
    if (!best || Math.abs(g.length - want) < Math.abs(best.g.length - want)) best = { g, f };
    if (g.length === want) break;
  }
  return best.g;
}

const cellTop = CAP + 0.01, cellBot = cellTop - B;
const rowGap = Math.max(18, CAP * 2.6);
const PERROW = 26;
const outRows = [], frames = [];
let y = 0, total = 0;
const info = [];
for (let ri = 0; ri < rows.length; ri++) {
  const want = NPERROW[ri] || 0;
  const letters = splitRow(rows[ri].items, want);
  info.push(rows[ri].items.length + '->' + letters.length + (want ? '/' + want : ''));
  const rowBase = Math.max.apply(null, letters.map(l => Math.max.apply(null, l.items.map(s => s.y0))));
  for (let i = 0; i < letters.length; i += PERROW) {
    const chunk = letters.slice(i, i + PERROW);
    let pen = 0;
    const polys = [];
    for (const l of chunk) {
      const x0 = l.x0, w = l.x1 - l.x0;
      const ox = pen - x0 * sc;
      for (const s of l.items) {
        const pts = s.pts.map(q => { const yy = (q.y - rowBase) * sc + y; return { x: q.x * sc + ox + (yy - y) * k, y: yy }; });
        polys.push(pts);
      }
      frames.push({ x0: pen - A / 2, x1: pen + w * sc + A / 2, y });
      pen += w * sc + A + GAP;
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
console.log('strokes=' + strokes.length + ' rows=' + rows.length + ' cells=' + total +
  ' capUnits=' + capUnits.toFixed(2) + ' scale=' + sc.toFixed(4) + ' slant=' + SLANT);
console.log('rows: ' + info.join(' '));
