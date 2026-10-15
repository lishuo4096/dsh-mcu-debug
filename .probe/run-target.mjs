/**
 * 真机连接测试。走完整的 工具 → run.js → ocd.js → 独立副本 openocd → 探针 → 目标 链路。
 * 用法：node .probe\run-target.mjs <tool> <jsonArgs>
 * 例：  node .probe\run-target.mjs mcu_probe '{"target":"py32f030"}'
 */
import { apply } from '../index.js';

const [, , tool, jsonArgs = '{}'] = process.argv;
const args = JSON.parse(jsonArgs);

const registered = new Map();
apply({
  tools: { register: (t) => registered.set(t.name, t) },
  skills: { registerProvider: () => {} },
});

const t = registered.get(tool);
if (!t) { console.log(`!! 没有 ${tool}`); process.exit(1); }

console.log(`>>> ${tool} ${JSON.stringify(args)}`);
const t0 = Date.now();
const v = await t.execute(args, { cwd: process.cwd() });
console.log(t.output.render(args, v)[0].text);
console.log(`\n[${Date.now() - t0} ms] ok=${v?.ok}`);
