'use strict';
/* SHX (AutoCAD-86 unifont) -> DXF sheet: single-stroke letters + one cell each.
   PORT of the byte-code logic from tatarize/shxparser (MIT).
   usage: shx2dxf.js <font.shx> <out.dxf> [capMm] [aMm] [bMm] [gapMm] */
const fs = require('fs');

const file = process.argv[2], out = process.argv[3];
const CAP = parseFloat(process.argv[4] || '6.944');
const A = parseFloat(process.argv[5] || '1.0');
const B = parseFloat(process.argv[6] || '11.0');
const GAP = parseFloat(process.argv[7] || '6');
const SLANT = parseFloat(process.argv[8] || '0');
const k = Math.tan(SLANT * Math.PI / 180);
if (!file || !out) { console.log('usage: shx2dxf.js <font.shx> <out.dxf> [capMm] [aMm] [bMm] [gapMm]'); process.exit(1); }

const buf = fs.readFileSync(file);
const END = 0, PEN_DOWN = 1, PEN_UP = 2, DIVIDE = 3, MULTIPLY = 4, PUSH = 5, POP = 6, SUBSHAPE = 7,
      XY = 8, POLYXY = 9, OCTANT = 0xA, FRACTIONAL = 0xB, BULGE = 0xC, POLYBULGE = 0xD, CONDMODE2 = 0xE;
const sign8 = b => (b > 127 ? b - 256 : b);
const DX = [1, 1, 1, 0.5, 0, -0.5, -1, -1, -1, -1, -1, -0.5, 0, 0.5, 1, 1];
const DY = [0, 0.5, 1, 1, 1, 1, 1, 0.5, 0, -0.5, -1, -1, -1, -1, -1, -0.5];
const u16 = o => buf[o] | (buf[o + 1] << 8);
const s16 = o => { const v = u16(o); return v & 0x8000 ? v - 0x10000 : v; };
const u32 = o => (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0;

/* ---------- header ---------- */
let pos = 0;
let sig = '';
while (pos < buf.length) { const c = buf[pos++]; if (c === 0 || c === 10 || c === 13) break; sig += String.fromCharCode(c); }
pos += 2;
const parts = sig.split(' ');
const ftype = parts[1];
let glyphs = {};
let name = '', above = 21, below = -6, modes = 0;
if (ftype === 'unifont') {
  const count = u32(pos); pos += 4;
  const length = u16(pos); pos += 2;
  pos += 5;                                   // as in the reference parser
  let p = pos;
  while (p < buf.length) { const c = buf[p++]; if (c === 0 || c === 10 || c === 13) break; name += String.fromCharCode(c); }
  pos = p;
  above = buf[pos++]; below = sign8(buf[pos++]); modes = buf[pos++];
  pos += 3;                                   // encoding/embedded/ignore
  for (let i = 0; i < count - 1 && pos + 4 <= buf.length; i++) {
    const index = u16(pos), len = u16(pos + 2); pos += 4;
    if (pos + len > buf.length) break;
    glyphs[index] = buf.slice(pos, pos + len);
    pos += len;
  }
} else {
  console.log('unsupported shx type: ' + ftype); process.exit(1);
}
console.log('font="' + name + '" type=' + ftype + ' glyphs=' + Object.keys(glyphs).length +
  ' above=' + above + ' below=' + below + ' modes=' + modes);

/* glyph records may start with a NUL-terminated ASCII name */
function stripName(d) {
  const z = d.indexOf(0);
  if (z < 0 || z > 120) return d;
  if (z === 0) return d.slice(1);   // empty name
  for (let k = 0; k < z; k++) {
    const c = d[k];
    if (c !== 0x20 && (c < 0x28 || c > 0x7E)) return d;   // not text -> real shape data
  }
  return d.slice(z + 1);
}

/* ---------- run one glyph, return polyline strokes in font units ---------- */
function glyphStrokes(cp, depth) {
  let data = glyphs[cp];
  if (!data) return null;
  data = stripName(data);
  const strokes = [];
  let cur = null, pen = true;
  let x = 0, y = 0, lx = 0, ly = 0, scale = 1;
  const stack = [];
  let i = 0;
  const code = () => { if (i >= data.length) throw new Error('eof'); return data[i++]; };
  const push = (px, py) => { if (cur) cur.push({ x: px, y: py }); };
  const moveTo = (nx, ny) => { cur = null; };
  const ensureCur = () => { if (!cur) { cur = [{ x: lx, y: ly }]; strokes.push(cur); } };
  const lineTo = (nx, ny) => {
    if (!pen) { cur = null; return; }
    ensureCur();
    cur.push({ x: nx, y: ny });
  };
  /* 3-point arc -> points */
  const arcPts = (x0, y0, xm, ym, x1, y1, n) => {
    const d = 2 * (x0 * (ym - y1) + xm * (y1 - y0) + x1 * (y0 - ym));
    if (Math.abs(d) < 1e-9) return [{ x: x1, y: y1 }];
    const ux = ((x0 * x0 + y0 * y0) * (ym - y1) + (xm * xm + ym * ym) * (y1 - y0) + (x1 * x1 + y1 * y1) * (y0 - ym)) / d;
    const uy = ((x0 * x0 + y0 * y0) * (x1 - xm) + (xm * xm + ym * ym) * (x0 - x1) + (x1 * x1 + y1 * y1) * (xm - x0)) / d;
    const r = Math.hypot(x0 - ux, y0 - uy);
    if (!isFinite(r) || r > 2000) return [{ x: x1, y: y1 }];
    const norm = a => { while (a < 0) a += 2 * Math.PI; while (a >= 2 * Math.PI) a -= 2 * Math.PI; return a; };
    const a0 = Math.atan2(y0 - uy, x0 - ux), am = Math.atan2(ym - uy, xm - ux), a1 = Math.atan2(y1 - uy, x1 - ux);
    let sweep = norm(a1 - a0);
    if (norm(am - a0) > sweep) sweep -= 2 * Math.PI;
    const pts = [];
    for (let k = 1; k <= n; k++) {
      const a = a0 + sweep * k / n;
      pts.push({ x: ux + r * Math.cos(a), y: uy + r * Math.sin(a) });
    }
    return pts;
  };
  const doArc = (x0, y0, xm, ym, x1, y1) => {
    if (!pen) { cur = null; return; }
    ensureCur();
    for (const p of arcPts(x0, y0, xm, ym, x1, y1, 16)) cur.push(p);
  };
  const handleLen = (dir, len) => {
    if (pen) {
      ensureCur();
    }
    const fx = DX[dir], fy = DY[dir];
    const nx = x + fx * len * scale, ny = y + fy * len * scale;
    if (pen) { ensureCur(); cur.push({ x: nx, y: ny }); } else { cur = null; }
    x = nx; y = ny; lx = x; ly = y;
  };
  const handleSpecial = sp => {
    if (sp === END) { cur = null; while (i < data.length && data[i] !== 0) i++; if (i < data.length) i++; }
    else if (sp === PEN_DOWN) { pen = true; ensureCur(); }
    else if (sp === PEN_UP) { pen = false; }
    else if (sp === DIVIDE) { const f = code(); if (f) scale /= f; }
    else if (sp === MULTIPLY) { const f = code(); if (f) scale *= f; }
    else if (sp === PUSH) { stack.push([x, y]); }
    else if (sp === POP) { const s = stack.pop(); if (s) { x = s[0]; y = s[1]; lx = x; ly = y; cur = null; } }
    else if (sp === SUBSHAPE) {
      /* reference to another glyph: decode it on its own and offset by the pen */
      const idx = (data[i] << 8) | data[i + 1]; i += 2;
      if ((depth || 0) < 6) {
        const subStrokes = glyphStrokes(idx, (depth || 0) + 1);
        if (subStrokes) {
          for (const st of subStrokes) strokes.push(st.map(p => ({ x: p.x + x, y: p.y + y })));
        }
      }
    }
    else if (sp === XY) {
      const dx = sign8(code()) * scale, dy = sign8(code()) * scale;
      const nx = x + dx, ny = y + dy;
      if (pen) { ensureCur(); cur.push({ x: nx, y: ny }); } else { cur = null; }
      x = nx; y = ny; lx = x; ly = y;
    } else if (sp === POLYXY) {
      for (;;) {
        const dx = sign8(code()) * scale, dy = sign8(code()) * scale;
        if (dx === 0 && dy === 0) break;
        const nx = x + dx, ny = y + dy;
        if (pen) { ensureCur(); cur.push({ x: nx, y: ny }); } else { cur = null; }
        x = nx; y = ny; lx = x; ly = y;
      }
    } else if (sp === OCTANT) {
      const radius = code() * scale, sc = sign8(code());
      let s = (sc >> 4) & 7, c = sc & 7;
      const ccw = (sc >> 7) & 1;
      if (c === 0) c = 8;
      if (ccw) s = -s;
      const oct = Math.PI / 4, sa = s * oct, ea = (c + s) * oct, ma = (sa + ea) / 2;
      const cx = x - radius * Math.cos(sa), cy = y - radius * Math.sin(sa);
      const mx = cx + radius * Math.cos(ma), my = cy + radius * Math.sin(ma);
      const nx = cx + radius * Math.cos(ea), ny = cy + radius * Math.sin(ea);
      doArc(lx, ly, mx, my, nx, ny); x = nx; y = ny; lx = x; ly = y;
    } else if (sp === FRACTIONAL) {
      const so = Math.PI / 4 * code() / 256, eo = Math.PI / 4 * code() / 256;
      const radius = (256 * code() + code()) * scale, sc = sign8(code());
      let s = (sc >> 4) & 7, c = sc & 7;
      const ccw = (sc >> 7) & 1;
      if (c === 0) c = 8;
      if (ccw) s = -s;
      const oct = Math.PI / 4;
      const sa = so + s * oct, ea = (c + s) * oct + eo, ma = (sa + ea) / 2;
      const cx = x - radius * Math.cos(sa), cy = y - radius * Math.sin(sa);
      const mx = cx + radius * Math.cos(ma), my = cy + radius * Math.sin(ma);
      const nx = cx + radius * Math.cos(ea), ny = cy + radius * Math.sin(ea);
      doArc(lx, ly, mx, my, nx, ny); x = nx; y = ny; lx = x; ly = y;
    } else if (sp === BULGE || sp === POLYBULGE) {
      for (;;) {
        const dx = sign8(code()) * scale, dy = sign8(code()) * scale;
        if (dx === 0 && dy === 0) { if (sp === POLYBULGE) break; break; }
        const h = sign8(code());
        const r = Math.hypot(dx, dy) / 2, bulge = h / 127;
        const bx = x + dx / 2, by = y + dy / 2, ba = Math.atan2(dy, dx) - Math.PI / 2;
        const mx = bx + r * bulge * Math.cos(ba), my = by + r * bulge * Math.sin(ba);
        const nx = x + dx, ny = y + dy;
        if (Math.abs(bulge) < 1e-6) { if (pen) { ensureCur(); cur.push({ x: nx, y: ny }); } else { cur = null; } }
        else doArc(lx, ly, mx, my, nx, ny);
        x = nx; y = ny; lx = x; ly = y;
      }
    }
  };
  let i0 = 0;
  try {
    while (i < data.length) {
      const b = code();
      const len = (b & 0xF0) >> 4, dir = b & 0x0F;
      i0 = i;
      if (len === 0) handleSpecial(dir); else handleLen(dir, len);
    }
  } catch (e) { /* ignore broken glyph tails */ }
  return strokes.filter(s => s.length >= 2);
}

if (process.argv[8] === 'debug') {
  for (const cp of [0x43, 0x6F, 0x65, 0x73]) {
    const st = glyphStrokes(cp);
    const g = glyphs[cp];
    console.log('U+' + cp.toString(16) + ' bytes=' + (g ? g.length : 0) + ' hex=' + (g ? Array.prototype.map.call(g, b => b.toString(16).padStart(2,'0')).join(' ') : ''));
    if (st) console.log('   strokes=' + st.length + ' ' + JSON.stringify(st[0] && st[0].slice(0, 5)));
  }
  process.exit(0);
}

/* ---------- layout ---------- */
const cp = i => String.fromCodePoint(i);
const CYR_UP = []; for (let i = 0; i < 32; i++) CYR_UP.push(cp(0x410 + i)); CYR_UP.splice(6, 0, cp(0x401));
const CYR_LO = []; for (let i = 0; i < 32; i++) CYR_LO.push(cp(0x430 + i)); CYR_LO.splice(6, 0, cp(0x451));
const ROWS = [
  { name: 'SHX_UPPER', color: 7, text: CYR_UP },
  { name: 'SHX_LOWER', color: 1, text: CYR_LO },
  { name: 'SHX_LAT_UP', color: 5, text: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('') },
  { name: 'SHX_LAT_LOW', color: 6, text: 'abcdefghijklmnopqrstuvwxyz'.split('') },
  { name: 'SHX_DIGIT', color: 3, text: '0123456789'.split('') },
  { name: 'SHX_PUNCT', color: 5, text: '.,;:!?-()/%'.split('').concat([cp(0xAB), cp(0xBB), cp(0x2116)]) }
];
const sc = CAP / above;
const cellTop = CAP + 0.01, cellBot = cellTop - B;
const rowGap = Math.max(18, CAP * 2.6);
const rows = [], frames = [];
let y = 0, missing = [];
for (const row of ROWS) {
  let pen = 0;
  const polys = [];
  for (const ch of row.text) {
    const cp = ch.codePointAt(0);
    const strokes = glyphStrokes(cp);
    if (!strokes || !strokes.length) { missing.push(ch); pen += 3; continue; }
    let bx0 = 1e9, bx1 = -1e9;
    for (const st of strokes) {
      const pts = st.map(p => { const yy = p.y * sc + y; return { x: p.x * sc + pen + (yy - y) * k, y: yy }; });
      for (const p of pts) { if (p.x < bx0) bx0 = p.x; if (p.x > bx1) bx1 = p.x; }
      polys.push(pts);
    }
    if (bx1 > bx0) frames.push({ x0: bx0 - A / 2, x1: bx1 + A / 2, y: y });
    pen = bx1 + GAP + A;
  }
  rows.push({ layer: row.name, color: row.color, polys: polys });
  y -= rowGap;
}
const framePolys = frames.map(f => ({
  closed: true,
  pts: [{ x: f.x0 + cellTop * k, y: f.y + cellTop }, { x: f.x1 + cellTop * k, y: f.y + cellTop },
        { x: f.x1 + cellBot * k, y: f.y + cellBot }, { x: f.x0 + cellBot * k, y: f.y + cellBot }]
}));
rows.push({ layer: 'GOST_FRAME', color: 4, polys: framePolys });

/* ---------- DXF R12 ---------- */
const NL = '\r\n';
const ent = (layer, pts, closed) => {
  let s = ['0', 'POLYLINE', '8', layer, '66', '1', '70', closed ? '1' : '0', ''].join(NL);
  for (const p of pts) s += ['0', 'VERTEX', '8', layer, '10', p.x.toFixed(4), '20', p.y.toFixed(4), '30', '0.0', ''].join(NL);
  return s + ['0', 'SEQEND', '8', layer, ''].join(NL);
};
let ents = '';
for (const row of rows) for (const p of row.polys) {
  const pts = Array.isArray(p) ? p : p.pts;
  ents += ent(row.layer, pts, !!p.closed);
}
let dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '0', 'ENDSEC', ''].join(NL);
dxf += ['0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', String(rows.length), ''].join(NL);
for (const row of rows) dxf += ['0', 'LAYER', '2', row.layer, '70', '0', '62', String(row.color), '6', 'CONTINUOUS', ''].join(NL);
dxf += ['0', 'ENDTAB', '0', 'ENDSEC', ''].join(NL);
dxf += ['0', 'SECTION', '2', 'ENTITIES', ''].join(NL) + ents + ['0', 'ENDSEC', '0', 'EOF', ''].join(NL);
fs.writeFileSync(out, dxf, 'ascii');

/* SVG preview */
let mnX = 1e9, mxX = -1e9, mnY = 1e9, mxY = -1e9;
for (const row of rows) for (const p of row.polys) {
  const pts = Array.isArray(p) ? p : p.pts;
  for (const q of pts) {
    if (q.x < mnX) mnX = q.x; if (q.x > mxX) mxX = q.x;
    if (q.y < mnY) mnY = q.y; if (q.y > mxY) mxY = q.y;
  }
}
const pad = 2, W = (mxX - mnX) + 2 * pad, H = (mxY - mnY) + 2 * pad;
let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W.toFixed(2) + 'mm" height="' + H.toFixed(2) + 'mm" viewBox="0 0 ' + W.toFixed(2) + ' ' + H.toFixed(2) + '">\n<g fill="none" stroke-width="0.08">\n';
for (const row of rows) for (const p of row.polys) {
  const pts = Array.isArray(p) ? p : p.pts;
  const d = pts.map((q, k) => (k ? 'L' : 'M') + (q.x - mnX + pad).toFixed(3) + ',' + (mxY - q.y + pad).toFixed(3)).join(' ') + (p.closed ? ' Z' : '');
  svg += '<path stroke="' + (row.layer === 'GOST_FRAME' ? '#c04040' : '#000') + '" d="' + d + '"/>\n';
}
fs.writeFileSync(out.replace(/\.dxf$/i, '.svg'), svg + '</g>\n</svg>\n', 'ascii');

const total = rows.reduce((n, r) => n + r.polys.length, 0);
console.log('written ' + out + ' polylines=' + total + ' cells=' + framePolys.length);
console.log('cap=' + CAP + '  cellTop=+' + cellTop.toFixed(3) + '  cellBot=' + cellBot.toFixed(3) +
  '  height=' + (cellTop - cellBot).toFixed(3) + '  rowGap=' + rowGap.toFixed(2));
console.log('rows: ' + rows.map(r => r.layer + '=' + r.polys.length).join(' '));
if (missing.length) console.log('MISSING: ' + missing.join(' '));
