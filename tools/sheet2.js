'use strict';
/* TSV strokes (pairs) -> sheet DXF: letters grouped automatically + one cell each.
   usage: sheet2.js <in.txt> <out.dxf> [capMm] [aMm] [bMm] [gapMm] [slantDeg] */
const fs = require('fs');
const src = process.argv[2], out = process.argv[3];
const CAP = parseFloat(process.argv[4] || '6.944');
const A = parseFloat(process.argv[5] || '1.0');
const B = parseFloat(process.argv[6] || '11.0');
const GAP = parseFloat(process.argv[7] || '6');
const SLANT = parseFloat(process.argv[8] || '0');
const k = Math.tan(SLANT * Math.PI / 180);
if (!src || !out) { console.log('usage: sheet2.js <in.txt> <out.dxf> [capMm] [aMm] [bMm] [gapMm] [slantDeg]'); process.exit(1); }

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
const tol = 0.055 * capUnits;

/* ---- union-find: strokes of one letter touch each other ---- */
const n = strokes.length, par = new Int32Array(n);
for (let i = 0; i < n; i++) par[i] = i;
const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) par[b] = a; };
const box = s => ({ x0: s.x0 - tol, x1: s.x1 + tol, y0: s.y0 - tol, y1: s.y1 + tol });
const inter = (a, b) => !(a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0);
for (let i = 0; i < n; i++) {
  const bi = box(strokes[i]);
  for (let j = i + 1; j < n; j++) if (inter(bi, box(strokes[j]))) uni(i, j);
}
const groups = {};
strokes.forEach((s, i) => { const r = find(i); (groups[r] = groups[r] || []).push(s); });
const letters = Object.keys(groups).map(r => {
  const items = groups[r];
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const s of items) { if (s.x0 < x0) x0 = s.x0; if (s.x1 > x1) x1 = s.x1; if (s.y0 < y0) y0 = s.y0; if (s.y1 > y1) y1 = s.y1; }
  return { items, x0, x1, y0, y1 };
});
/* ---- rows: letters whose vertical spans overlap ---- */
letters.sort((a, b) => b.y1 - a.y1);
const rows = [];
for (const l of letters) {
  let row = rows.find(r => l.y1 > r.y0 + 0.35 * capUnits && l.y0 < r.y1 - 0.35 * capUnits);
  if (!row) { row = { y0: l.y0, y1: l.y1, items: [] }; rows.push(row); }
  row.items.push(l);
  if (l.y0 < row.y0) row.y0 = l.y0;
  if (l.y1 > row.y1) row.y1 = l.y1;
}
rows.sort((a, b) => b.y1 - a.y1);
const baseRow = Math.max.apply(null, letters.map(l => l.y0));   // most common bottom = baseline reference
const sc = CAP / capUnits;
const cellTop = CAP + 0.01, cellBot = cellTop - B;
const rowGap = Math.max(18, CAP * 2.6);
const PERROW = 26;

const outRows = [], frames = [];
let y = 0, count = 0;
for (const row of rows) {
  const items = row.items.slice().sort((a, b) => a.x0 - b.x0);
  for (let i = 0; i < items.length; i += PERROW) {
    const chunk = items.slice(i, i + PERROW);
    let pen = 0;
    const polys = [];
    for (const l of chunk) {
      const ox = pen - l.x0 * sc;
      for (const s of l.items) {
        const pts = s.pts.map(q => { const yy = q.y * sc + (y - baseRow * sc); return { x: q.x * sc + ox + (yy - y) * k, y: yy }; });
        polys.push(pts);
      }
      const cx0 = pen - A / 2, cx1 = pen + (l.x1 - l.x0) * sc + A / 2;
      frames.push({ x0: cx0, x1: cx1, y: y });
      pen = cx1 + GAP;
      count++;
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
console.log('strokes=' + strokes.length + ' letters=' + letters.length + ' rows=' + rows.length +
  ' cells=' + frames.length + ' -> ' + out);
console.log('capUnits=' + capUnits.toFixed(2) + ' scale=' + sc.toFixed(4) + ' slant=' + SLANT +
  ' cellTop=+' + cellTop.toFixed(3) + ' cellBot=' + cellBot.toFixed(3));
