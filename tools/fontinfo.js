'use strict';
/* print readable name-table strings of a font */
const fs = require('fs');
for (const f of process.argv.slice(2)) {
  const b = fs.readFileSync(f, 'latin1');
  const runs = (b.match(/[\x20-\x7E]{8,}/g) || []).filter(s => /[A-Za-z]{4}/.test(s) && !/^[\x20-\x2F]/.test(s));
  console.log('--- ' + f.split('\\').pop() + ' (unitsPerEm probe) ---');
  for (const s of runs.slice(0, 14)) console.log('   ' + s.substr(0, 90));
}
