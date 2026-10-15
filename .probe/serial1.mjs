import { listPorts, hostStatus, ensureHost } from '../lib/serial.js';
const r = listPorts();
console.log('list ok =', r.ok, r.error ?? '');
for (const row of r.rows) console.log(`${row.kind.padEnd(8)} ${String(row.port).padEnd(7)} ${row.vidpid ?? '--'}  ${row.vendor ?? ''} | ${row.label}`);
console.log('--- host ---');
console.log(JSON.stringify(hostStatus(), null, 1).slice(0, 900));

