'use strict';
/* Build a DXF sheet from the Hershey single-stroke fonts stored in
   hersheydata.py: one-stroke letters + one uniform cell per letter.
   usage: hershey2dxf.js <hersheydata.py> <out.dxf> [capMm] [aMm] [bMm] [gapMm] */
const fs = require('fs');

const py = process.argv[2], out = process.argv[3];
const CAP = parseFloat(process.argv[4] || '6.944');   // cap height, mm
const A = parseFloat(process.argv[5] || '1.0');       // cell side margin, mm
const B = parseFloat(process.argv[6] || '11.0');      // cell height (line pitch), mm
const GAP = parseFloat(process.argv[7] || '6');       // gap between cells, mm
if (!py || !out) { console.log('usage: hershey2dxf.js <hersheydata.py> <out.dxf> [capMm] [aMm] [bMm] [gapMm]'); process.exit(1); }

const src = fs.readFileSync(py, 'utf8');
function fontList(name) {
  const m = src.match(new RegExp('^' + name + ' = (\\[[\\s\\S]*?\\])\\s*$', 'm'));
  if (!m) throw new Error('font not found: ' + name);
  return JSON.parse(m[1]);
}
function parseGlyph(s) {
  const toks = String(s).trim().split(/\s+/);
  let i = 0;
  const nums = [];
  while (i < toks.length && /^-?\d+(\.\d+)?$/.test(toks[i])) nums.push(parseFloat(toks[i++]));
  const left = nums.length > 0 ? nums[0] : 0;
  const right = nums.length > 1 ? nums[1] : 0;
  const strokes = [];
  let cur = null;
  while (i < toks.length) {
    const t = toks[i];
    if (t === 'M' || t === 'L') {
      const x = parseFloat(toks[i + 1]), y = parseFloat(toks[i + 2]);
      i += 3;
      if (!isFinite(x) || !isFinite(y)) continue;
      if (t === 'M') { cur = [{ x: x, y: y }]; strokes.push(cur); }
      else { if (!cur) { cur = []; strokes.push(cur); } cur.push({ x: x, y: y }); }
    } else i++;
  }
  return { left: left, right: right, strokes: strokes };
}

const cyr = fontList('cyrillic');
const lat = fontList('futural');
const CYR_MAP = {
  192: 'A', 193: 'B', 194: 'V', 195: 'G', 196: 'D', 197: '[', 198: 'H', 199: 'Z', 200: 'I', 201: 'E',
  202: 'K', 203: 'L', 204: 'M', 205: 'N', 206: 'O', 207: 'P', 208: 'R', 209: 'S', 210: 'T', 211: 'Y',
  212: 'F', 213: 'X', 214: '`', 215: 'J', 216: 'Q', 217: 'W', 218: ']', 219: '$', 220: '_', 221: 'C',
  222: 'U', 223: '^',
  224: 'a', 225: 'b', 226: 'v', 227: 'g', 228: 'd', 229: '{', 230: 'h', 231: 'z', 232: 'i', 233: 'e',
  234: 'k', 235: 'l', 236: 'm', 237: 'n', 238: 'o', 239: 'p', 240: 'r', 241: 's', 242: 't', 243: 'y',
  244: 'f', 245: 'x', 246: '%', 247: 'j', 248: 'q', 249: 'w', 250: '|', 251: '&', 252: '~', 253: 'c',
  254: 'u', 255: '}'
};
const gCyr = cp => parseGlyph(cyr[CYR_MAP[cp].charCodeAt(0) - 32]);
const gLat = cp => parseGlyph(lat[cp - 32]);
const gDot = () => parseGlyph(lat[0x2E - 32]);

/* Ё / ё: the Hershey Cyrillic set has no diaeresis, build it from Е/е + two dots.
   The dots are aligned with the cap line so the cell height stays the same. */
function withDots(g) {
  let yTop = 1e9, x0 = 1e9, x1 = -1e9;
  for (const st of g.strokes) for (const p of st) { if (p.y < yTop) yTop = p.y; if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; }
  const dot = gDot();
  let dTop = 1e9, dBot = -1e9, dx0 = 1e9, dx1 = -1e9;
  for (const st of dot.strokes) for (const p of st) { if (p.y < dTop) dTop = p.y; if (p.y > dBot) dBot = p.y; if (p.x < dx0) dx0 = p.x; if (p.x > dx1) dx1 = p.x; }
  const ds = Math.min(1, 6 / Math.max(1, dx1 - dx0));
  const cx = (x0 + x1) / 2, off = (x1 - x0) * 0.2, dh = (dBot - dTop) * ds, dy = yTop - dh;
  const res = { left: g.left, right: g.right, strokes: g.strokes.map(s => s.map(p => ({ x: p.x, y: p.y }))) };
  for (const sx of [-off, off]) {
    for (const st of dot.strokes) {
      res.strokes.push(st.map(p => ({ x: (p.x - dx0) * ds + cx + sx, y: (p.y - dTop) * ds + dy })));
    }
  }
  return res;
}

const rows = [];
const up = [], lo = [], latUp = [], latLo = [], dig = [], pun = [];
for (let c = 192; c <= 223; c++) up.push(gCyr(c));
up.splice(6, 0, withDots(gCyr(197)));          // Ё after Е
for (let c = 224; c <= 255; c++) lo.push(gCyr(c));
lo.splice(6, 0, withDots(gCyr(229)));          // ё after е
for (let c = 0x41; c <= 0x5A; c++) latUp.push(gLat(c));
for (let c = 0x61; c <= 0x7A; c++) latLo.push(gLat(c));
for (let c = 0x30; c <= 0x39; c++) dig.push(gLat(c));
for (const ch of '.,;:!?-()/%') pun.push(gLat(ch.charCodeAt(0)));
rows.push({ layer: 'HERSHEY_UPPER', color: 7, glyphs: up },
           { layer: 'HERSHEY_LOWER', color: 1, glyphs: lo },
           { layer: 'HERSHEY_LAT_UP', color: 5, glyphs: latUp },
           { layer: 'HERSHEY_LAT_LOW', color: 6, glyphs: latLo },
           { layer: 'HERSHEY_DIGIT', color: 3, glyphs: dig },
           { layer: 'HERSHEY_PUNCT', color: 5, glyphs: pun });

/* scale: baseline at y=+9, cap top at y=-12 -> 21 units = CAP mm */
const sc = CAP / 21;
const toMm = (x, y) => ({ x: x * sc, y: (9 - y) * sc });

/* uniform head line: the tallest ink of the whole sheet (measured above the
   baseline) + 0.01 mm */
let topUnits = -1e9;
for (const row of rows) for (const g of row.glyphs) for (const st of g.strokes) for (const p of st) {
  const hh = 9 - p.y;
  if (hh > topUnits) topUnits = hh;
}
const cellTop = CAP + 0.01;   // head line = cap height, same as the other sheets
const cellBot = cellTop - B;

const rowGap = Math.max(18, CAP * 2.6);
let y = 0;
const frames = [];
for (const row of rows) {
  let pen = 0;
  row.polys = [];
  for (const g of row.glyphs) {
    let bx0 = 1e9, bx1 = -1e9;
    for (const st of g.strokes) {
      if (st.length < 2) continue;
      const pts = st.map(p => { const q = toMm(p.x + pen / sc, p.y); return { x: q.x, y: q.y + y }; });
      for (const q of pts) { if (q.x < bx0) bx0 = q.x; if (q.x > bx1) bx1 = q.x; }
      row.polys.push({ pts: pts, closed: false });
    }
    if (bx1 > bx0) frames.push({ x0: bx0 - A / 2, x1: bx1 + A / 2, y: y });
    pen += (g.right - g.left) * sc + GAP;
  }
  y -= rowGap;
}
const framePolys = frames.map(f => ({
  closed: true,
  pts: [{ x: f.x0, y: f.y + cellTop }, { x: f.x1, y: f.y + cellTop },
        { x: f.x1, y: f.y + cellBot }, { x: f.x0, y: f.y + cellBot }]
}));
rows.push({ layer: 'GOST_FRAME', color: 4, polys: framePolys });

/* ---- DXF R12 ---- */
const NL = '\r\n';
function polylineEntity(layer, pts, closed) {
  let s = ['0', 'POLYLINE', '8', layer, '66', '1', '70', closed ? '1' : '0', ''].join(NL);
  for (const p of pts) s += ['0', 'VERTEX', '8', layer, '10', p.x.toFixed(4), '20', p.y.toFixed(4), '30', '0.0', ''].join(NL);
  return s + ['0', 'SEQEND', '8', layer, ''].join(NL);
}
let ents = '';
for (const row of rows) for (const p of row.polys) ents += polylineEntity(row.layer, p.pts, p.closed);
let dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '0', 'ENDSEC', ''].join(NL);
dxf += ['0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', String(rows.length), ''].join(NL);
for (const row of rows) dxf += ['0', 'LAYER', '2', row.layer, '70', '0', '62', String(row.color), '6', 'CONTINUOUS', ''].join(NL);
dxf += ['0', 'ENDTAB', '0', 'ENDSEC', ''].join(NL);
dxf += ['0', 'SECTION', '2', 'ENTITIES', ''].join(NL) + ents + ['0', 'ENDSEC', '0', 'EOF', ''].join(NL);
fs.writeFileSync(out, dxf, 'ascii');

/* SVG preview */
let sMinX = 1e9, sMaxX = -1e9, sMinY = 1e9, sMaxY = -1e9;
for (const row of rows) for (const p of row.polys) for (const q of p.pts) {
  if (q.x < sMinX) sMinX = q.x; if (q.x > sMaxX) sMaxX = q.x;
  if (q.y < sMinY) sMinY = q.y; if (q.y > sMaxY) sMaxY = q.y;
}
const pad = 2;
const w = (sMaxX - sMinX) + 2 * pad, h = (sMaxY - sMinY) + 2 * pad;
let paths = '';
for (const row of rows) for (const p of row.polys) {
  const d = p.pts.map((q, i) => (i ? 'L' : 'M') + (q.x - sMinX + pad).toFixed(3) + ',' + (sMaxY - q.y + pad).toFixed(3)).join(' ') + (p.closed ? ' Z' : '');
  paths += '<path stroke="' + (row.layer === 'GOST_FRAME' ? '#c04040' : '#000000') + '" d="' + d + '"/>\n';
}
fs.writeFileSync(out.replace(/\.dxf$/i, '.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="' + w.toFixed(2) + 'mm" height="' + h.toFixed(2) + 'mm" viewBox="0 0 ' + w.toFixed(2) + ' ' + h.toFixed(2) + '">\n<g fill="none" stroke-width="0.08">\n' + paths + '</g>\n</svg>\n', 'ascii');

const total = rows.reduce((n, r) => n + r.polys.length, 0);
console.log('written ' + out + ' polylines=' + total + ' cells=' + framePolys.length);
console.log('cap=' + CAP + ' mm  cellTop=baseline+' + cellTop.toFixed(3) + '  cellBot=' + cellBot.toFixed(3) +
  '  height=' + (cellTop - cellBot).toFixed(3) + '  rowGap=' + rowGap.toFixed(2));
console.log('rows: ' + rows.map(r => r.layer + '=' + r.polys.length).join(' '));
