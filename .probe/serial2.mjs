import { openPort, readPort, writePort, closePort, hostPorts, hostStatus, listPorts } from '../lib/serial.js';
const log = (...a) => console.log(...a);
log('--- ensure/open ---');
const o = await openPort({ port: 'COM21', baud: 115200 });
log('open:', JSON.stringify(o));
if (!o.ok) { log('hostStatus', JSON.stringify(hostStatus())); process.exit(0); }
const hp = await hostPorts(); log('hostPorts:', JSON.stringify(hp));
const w = await writePort({ port: 'COM21', text: 'AT\r\n' }); log('write:', JSON.stringify(w));
const r = await readPort({ port: 'COM21', timeoutMs: 800 }); log('read:', JSON.stringify({ ok: r.ok, bytes: r.bytes, hex: r.hex, waited: r.waitedMs, err: r.error }));
const p = await (await import('../lib/serial.js')).pinsOf({ port: 'COM21' }); log('pins:', JSON.stringify(p));
const c = await closePort({ port: 'COM21' }); log('close:', JSON.stringify(c));
const h = await (await import('../lib/serial.js')).call('ping', {}); log('ping:', JSON.stringify(h));
const q = (await import('../lib/serial.js')).shutdownHost(); log('shutdown:', JSON.stringify(q));
