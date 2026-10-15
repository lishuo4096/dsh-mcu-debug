/**
 * 原始诊断：直接拿插件的 ocd.js 起 openocd，把 CMSIS-DAP 的设备扫描过程打出来。
 * 目的：搞清「mcu_probes 说 WCH-Link 可用」与「openocd 说找不到 CMSIS-DAP 设备」为什么不一致。
 */
import { runOpenocd, locateOpenocd } from '../lib/ocd.js';

const loc = locateOpenocd();
console.log(JSON.stringify(loc, null, 2));

const CASES = [
  { label: 'cmsis-dap + 序列号 + swd', iface: 'interface/cmsis-dap.cfg', probeCmds: ['adapter serial 75438F06FAE0'], transport: 'swd' },
  { label: 'cmsis-dap 不锁序列号 + swd', iface: 'interface/cmsis-dap.cfg', probeCmds: [], transport: 'swd' },
  { label: 'cmsis-dap 不锁 + hid 后端', iface: 'interface/cmsis-dap.cfg', probeCmds: [], transport: 'swd', extra: ['cmsis-dap backend hid'] },
];

for (const c of CASES) {
  console.log(`\n${'#'.repeat(78)}\n# ${c.label}\n${'#'.repeat(78)}`);
  const r = runOpenocd({
    sequence: [
      { cfg: c.iface },
      ...c.probeCmds.map((cmd) => ({ cmd })),
      ...(c.extra ?? []).map((cmd) => ({ cmd })),
      { cmd: `transport select ${c.transport}` },
      { cmd: 'init' },
      { cmd: 'targets' },
      { cmd: 'shutdown' },
    ],
    footer: 'none',
    label: 'diag',
    timeoutMs: 45000,
    debugLevel: 3,
  });
  const lines = String(r.text ?? '').split('\n');
  const interesting = lines.filter((l) =>
    /cmsis_dap|CMSIS-DAP|cmsis-dap|usb_bulk|hidapi|0d28|1a86|0403|serial|VID|PID|Error|Could not|adapter|transport/i.test(l),
  );
  console.log(interesting.slice(0, 45).join('\n'));
  console.log(`\n[退出码 ${r.code}] [${r.durationMs} ms] 判据=${r.ok ? 'ok' : r.reason}`);
  if (r.parsed?.errors?.length) console.log(`Error 行：${r.parsed.errors.join(' | ')}`);
}
