'use strict';
/* Rasterise a DXF (POLYLINE entities) into a PNG so the result can be inspected
   as an image.  usage: render-dxf.js <file.dxf> <out.png> [widthPx] [y0mm] [y1mm]
   Letters are black, the GOST_FRAME cells red, everything else blue. */
const fs = require('fs');
const zlib = require('zlib');

const file = process.argv[2], out = process.argv[3];
if (!file || !out) { console.log('usage: render-dxf.js <file.dxf> <out.png> [widthPx] [y0mm] [y1mm]'); process.exit(1); }
const wantW = parseInt(process.argv[4] || '1600', 10);
const band0 = process.argv[5] !== undefined ? parseFloat(process.argv[5]) : null;
const band1 = process.argv[6] !== undefined ? parseFloat(process.argv[6]) : null;
const bx0 = process.argv[7] !== undefined ? parseFloat(process.argv[7]) : null;
const bx1 = process.argv[8] !== undefined ? parseFloat(process.argv[8]) : null;

const lines = fs.readFileSync(file, 'ascii').split(/\r?\n/);
const polys = [];
let cur = null, inEnt = false;
/* BLOCKS + INSERT: blocks are stored first, expanded when an INSERT is met */
const blocks = new Map();
let inBlocks = false, blockName = null, blockPolys = null;
for (let i = 0; i + 1 < lines.length; i += 2) {
  const code = lines[i].trim(), val = lines[i + 1].trim();
  if (code === '2' && val === 'BLOCKS') { inBlocks = true; continue; }
  if (code === '2' && val === 'ENTITIES') { inBlocks = false; inEnt = true; continue; }
  if (!inBlocks) continue;
  if (code === '0' && val === 'BLOCK') { blockPolys = []; blockName = null; continue; }
  if (code === '0' && val === 'ENDBLK') { if (blockName) blocks.set(blockName, blockPolys || []); blockPolys = null; blockName = null; continue; }
  if (blockPolys) {
    if (code === '2' && !blockName) blockName = val;
    if (code === '0' && val === 'POLYLINE') { blockPolys.push({ pts: [], layer: '0' }); continue; }
    if (code === '0' && val === 'VERTEX') { const p = blockPolys[blockPolys.length - 1]; if (p) p.pts.push({ x: 0, y: 0 }); continue; }
    if (code === '10') { const p = blockPolys[blockPolys.length - 1]; if (p && p.pts.length) p.pts[p.pts.length - 1].x = parseFloat(val); }
    if (code === '20') { const p = blockPolys[blockPolys.length - 1]; if (p && p.pts.length) p.pts[p.pts.length - 1].y = parseFloat(val); }
  }
}
inEnt = false;
for (let i = 0; i + 1 < lines.length; i += 2) {
  const code = lines[i].trim(), val = lines[i + 1];
  if (code === '2' && val.trim() === 'ENTITIES') { inEnt = true; continue; }
  if (!inEnt) continue;
  if (code === '0' && val.trim() === 'INSERT') { cur = { layer: '', pts: [], insert: true }; continue; }
  if (cur && cur.insert) {
    if (code === '8') cur.layer = val.trim();
    if (code === '2') cur.name = val.trim();
    if (code === '10') cur.x = parseFloat(val);
    if (code === '20') {
      cur.y = parseFloat(val);
      const src = blocks.get(cur.name) || [];
      for (const p of src) polys.push({ layer: cur.layer, pts: p.pts.map(q => ({ x: q.x + cur.x, y: q.y + cur.y })), closed: false });
      cur = null;
    }
    continue;
  }
  if (code === '0') {
    const v = val.trim();
    if (v === 'POLYLINE') cur = { layer: '', pts: [], closed: false };
    else if (v === 'VERTEX' && cur) cur.pending = true;
    else if (v === 'SEQEND' && cur) { polys.push(cur); cur = null; }
    else if (v === 'ENDSEC') break;
    continue;
  }
  if (!cur) continue;
  if (code === '8' && !cur.pending) cur.layer = val.trim();
  if (code === '70' && !cur.pending) cur.closed = (parseInt(val, 10) & 1) !== 0;
  if (code === '10' && cur.pending) cur.vx = parseFloat(val);
  if (code === '20' && cur.pending) { cur.vy = parseFloat(val); cur.pts.push({ x: cur.vx, y: cur.vy }); cur.pending = false; }
}

let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
for (const p of polys) for (const q of p.pts) {
  if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
  if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
}
if (band0 !== null) y1 = band0;
if (band1 !== null) y0 = band1;
if (bx0 !== null) x0 = bx0;
if (bx1 !== null) x1 = bx1;
const W = wantW, H = Math.max(40, Math.round((y1 - y0) / (x1 - x0) * W));
const pad = 8;
const sc = (W - 2 * pad) / (x1 - x0);
const px = (x, y) => [pad + (x - x0) * sc, pad + (y1 - y) * sc];

const img = Buffer.alloc(W * H * 3, 255);
const put = (x, y, r, g, b) => {
  const xi = Math.round(x), yi = Math.round(y);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = xi + dx, yy = yi + dy;
    if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
    const o = (yy * W + xx) * 3;
    img[o] = r; img[o + 1] = g; img[o + 2] = b;
  }
};
for (const p of polys) {
  const col = p.layer === 'GOST_FRAME' ? [220, 60, 60] : (p.layer === 'GOST_MARK' ? [60, 160, 60] : [0, 0, 0]);
  const pts = p.pts.slice();
  if (p.closed && pts.length > 2) pts.push(pts[0]);
  for (let i = 1; i < pts.length; i++) {
    const a = px(pts[i - 1].x, pts[i - 1].y), b = px(pts[i].x, pts[i].y);
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.5));
    for (let k = 0; k <= n; k++) put(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n, col[0], col[1], col[2]);
  }
}

/* --- minimal PNG writer (RGB, filter 0) --- */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
  return buf => { let c = -1; for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
})();
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body), 0);
  return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0;
  img.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
  chunk('IEND', Buffer.alloc(0))
]);
fs.writeFileSync(out, png);
console.log('rendered ' + polys.length + ' polylines -> ' + out + ' ' + W + 'x' + H +
  ' px, y range ' + y0.toFixed(2) + '..' + y1.toFixed(2) + ' mm');
