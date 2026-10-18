'use strict';
/* DXF -> TSV strokes (same format as the AutoCAD COM dump):
   NAME <tab> layer <tab> closed <tab> x,y,x,y,...   */
const fs = require('fs');
const file = process.argv[2], out = process.argv[3];
if (!file || !out) { console.log('usage: dxf2tsv.js <in.dxf> <out.txt>'); process.exit(1); }
const L = fs.readFileSync(file, 'latin1').split(/\r?\n/);
const lines = [];
let cur = null, inEnt = false, ent = null;
const push = () => { if (cur && cur.pts.length >= 2) lines.push(cur); cur = null; };
for (let i = 0; i + 1 < L.length; i += 2) {
  const code = L[i].trim(), val = L[i + 1];
  if (code === '0') {
    const v = val.trim();
    if (v === 'VERTEX') { if (cur) cur.vstart = true; continue; }
    if (v === 'SEQEND') { if (cur) push(); continue; }
    if (cur) push();
    if (v === 'ENDSEC' && inEnt) break;
    if (v === 'SECTION') { ent = null; continue; }
    if (!inEnt) continue;
    if (v === 'POLYLINE') { cur = { n: 'POLYLINE', layer: '', closed: false, pts: [] }; continue; }
    if (v === 'LWPOLYLINE') { cur = { n: 'LWPOLYLINE', layer: '', closed: false, pts: [] }; continue; }
    if (v === 'LINE') { cur = { n: 'LINE', layer: '', closed: false, pts: [] }; continue; }
    continue;
  }
  if (code === '2' && val.trim() === 'ENTITIES') { inEnt = true; continue; }
  if (!inEnt || !cur) continue;
  if (code === '8') cur.layer = val.trim();
  if (code === '70') cur.closed = (parseInt(val, 10) & 1) !== 0;
  if (code === '10') { if (cur.n === 'POLYLINE' && !cur.vstart) continue; cur.vx = parseFloat(val); }
  if (code === '20' && cur.vx !== undefined) { cur.pts.push(cur.vx, parseFloat(val)); cur.vx = undefined; }
  if (code === '11') cur.vx2 = parseFloat(val);
  if (code === '21' && cur.vx2 !== undefined) { cur.pts.push(cur.vx2, parseFloat(val)); cur.vx2 = undefined; }
}
push();
const cnt = {};
const recs = [];
for (const c of lines) {
  cnt[c.n] = (cnt[c.n] || 0) + 1;
  const vals = [];
  for (let i = 0; i + 1 < c.pts.length; i += 2) vals.push(c.pts[i].toFixed(4), c.pts[i + 1].toFixed(4));
  recs.push(c.n + '\t' + c.layer + '\t' + (c.closed ? '1' : '0') + '\t' + vals.join(',') + '\t');
}
fs.writeFileSync(out, recs.join('\r\n') + '\r\n', 'ascii');
console.log('entities: ' + JSON.stringify(cnt));
console.log('written ' + out + ' strokes=' + recs.length);
