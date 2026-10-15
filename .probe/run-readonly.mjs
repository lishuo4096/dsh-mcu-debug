/**
 * 只读工具组的实跑。工具调用写在这里（不走命令行，避免 PowerShell 引号吃掉 JSON）。
 * 用法：node .probe\run-readonly.mjs
 */
import { apply } from '../index.js';

const CALLS = [
  ['mcu_devices', { name: 'py32f030' }],
  ['mcu_devices', { family: 'stm32', grep: 'f103' }],
  ['mcu_probes', {}],
  ['mcu_serial_list', {}],
  ['mcu_session_list', {}],
  ['mcu_workspace', { action: 'audit' }],
];

const registered = new Map();
apply({
  tools: { register: (t) => registered.set(t.name, t) },
  skills: { registerProvider: () => {} },
});

const only = process.argv.slice(2);
for (const [tool, args] of CALLS) {
  if (only.length && !only.includes(tool)) continue;
  const t = registered.get(tool);
  if (!t) { console.log(`!! 没有 ${tool}`); continue; }
  console.log(`\n${'='.repeat(78)}\n>>> ${tool} ${JSON.stringify(args)}\n${'='.repeat(78)}`);
  const started = Date.now();
  try {
    const v = await t.execute(args, { cwd: process.cwd() });
    console.log(t.output.render(args, v)[0].text);
    console.log(`\n[${Date.now() - started} ms] ok=${v?.ok}`);
  } catch (e) {
    console.log(`!! 抛异常：${e?.name}: ${e?.message}`);
    if (e?.violations) console.log('   violations:', e.violations);
  }
}
