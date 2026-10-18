'use strict';
/* Preview of the Hershey single-stroke fonts from hersheydata.py
   usage: hershey2png.js <hersheydata.py> <out.png> [sizePx]  */
const fs = require('fs');
const zlib = require('zlib');

const py = process.argv[2], out = process.argv[3];
const capPx = parseInt(process.argv[4] || '64', 10);
if (!py || !out) { console.log('usage: hershey2png.js <hersheydata.py> <out.png> [capPx]'); process.exit(1); }
const src = fs.readFileSync(py, 'utf8');

function fontList(name) {
  const re = new RegExp('^' + name + ' = (\\[[\\s\\S]*?\\])\\s*$', 'm');
  const m = src.match(re);
  if (!m) throw new Error('font not found: ' + name);
  return JSON.parse(m[1]);
}

/* glyph string -> { left, right, strokes: [[{x,y},...]] } */
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
const gCyr = i => parseGlyph(cyr[i - 32]);
const gLat = i => parseGlyph(lat[i - 32]);

/* cp1251 -> Hershey slot, table copied from hershey.py (convert_cyrillic) */
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
const gCyrCh = cp => parseGlyph(cyr[CYR_MAP[cp].charCodeAt(0) - 32]);

const CYR_UP = [], CYR_LO = [];
for (let c = 192; c <= 223; c++) CYR_UP.push(gCyrCh(c));
for (let c = 224; c <= 255; c++) CYR_LO.push(gCyrCh(c));
const LAT_UP = [], LAT_LO = [], DIG = [];
for (let c = 0x41; c <= 0x5A; c++) LAT_UP.push(parseGlyph(lat[c - 32]));
for (let c = 0x61; c <= 0x7A; c++) LAT_LO.push(parseGlyph(lat[c - 32]));
for (let c = 0x30; c <= 0x39; c++) DIG.push(parseGlyph(lat[c - 32]));

/* layout: baseline at y = +9 (Hershey), cap top at y = -12 -> 21 units */
const UNITS = 21;
const sc = capPx / UNITS;
const PAD = 12;
const lines = [
  { glyphs: CYR_UP },
  { glyphs: CYR_LO },
  { glyphs: LAT_UP },
  { glyphs: LAT_LO },
  { glyphs: DIG }
];
const LINE_GAP = capPx * 1.75;

let W = 0;
for (const ln of lines) {
  let x = 0;
  for (const g of ln.glyphs) {
    ln.w = (ln.w || 0);
    x += (g.right - g.left) * sc;
    ln.w = x;
  }
  if (ln.w + 2 * PAD > W) W = Math.round(ln.w + 2 * PAD);
}
const H = Math.round(PAD * 2 + LINE_GAP * (lines.length - 1) + capPx * 1.6);
W = Math.min(W, 4000);

const img = Buffer.alloc(W * H * 3, 255);
const put = (x, y) => {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
  const o = (yi * W + xi) * 3;
  img[o] = 0; img[o + 1] = 0; img[o + 2] = 0;
};
lines.forEach((ln, li) => {
  const baseY = PAD + capPx + li * LINE_GAP;      // y of the baseline (Hershey y=+9)
  let pen = PAD;
  for (const g of ln.glyphs) {
    for (const st of g.strokes) {
      for (let k = 1; k < st.length; k++) {
        const a = st[k - 1], b = st[k];
        const ax = pen + a.x * sc, ay = baseY + (a.y - 9) * sc;
        const bx = pen + b.x * sc, by = baseY + (b.y - 9) * sc;
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.6));
        for (let s = 0; s <= n; s++) put(ax + (bx - ax) * s / n, ay + (by - ay) * s / n);
      }
    }
    pen += (g.right - g.left) * sc + 1.5;
  }
});

/* PNG writer */
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
fs.writeFileSync(out, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))
]));
console.log('font lists: cyrillic=' + cyr.length + ' futural=' + lat.length + ' -> ' + out + ' ' + W + 'x' + H);
const sample = CYR_UP[0];
console.log('sample A: bearings=' + sample.left + '..' + sample.right + ' strokes=' + sample.strokes.length +
  ' pts=' + (sample.strokes[0] ? sample.strokes[0].length : 0));
