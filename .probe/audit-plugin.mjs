/**
 * 通用插件 schema 审计：对任意本地插件的 index.js 做「注册 + harness 校验」。
 *
 * 用法：node audit-plugin.mjs <插件目录>
 *
 * 判据全部来自 harness 自己的 @deepseek-ai/dsh-tools，不用自写规则：
 *   - assertSupportedJsonSchema : 是否落在 provider 支持的关键字子集内
 *   - assertObjectJsonSchema    : 工具参数是否对象根
 *
 * 只读，不写盘、不改插件、不跑 openocd。
 */
import { loadValidators } from './harness.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const { assertSupported, assertObject } = await loadValidators();

const dir = resolve(process.argv[2] ?? '.');
console.log(`审计目标：${dir}\n`);

let mod;
try {
  mod = await import(pathToFileURL(resolve(dir, 'index.js')).href);
} catch (e) {
  console.log(`  ✗ 导入失败：${e.message}`);
  process.exit(1);
}
console.log(`  插件名（export const name）= ${JSON.stringify(mod.name)}`);
console.log(`  inject = ${JSON.stringify(mod.inject)}`);

const reg = new Map();
const providers = [];
try {
  mod.apply({
    tools: { register: (t) => reg.set(t.name, t) },
    skills: { registerProvider: (p) => providers.push(p) },
  });
} catch (e) {
  console.log(`  ✗ apply() 抛异常：${e.message}`);
  process.exit(1);
}
console.log(`  注册工具数 = ${reg.size}；技能 provider 数 = ${providers.length}\n`);

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array']);
const KW = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples']);
const problems = [];
function walk(node, path, tool) {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' && typeof v === 'string' && !TYPES.has(v)) problems.push(`${tool}: ${path}.type = ${JSON.stringify(v)}  ← 致命：provider 会拒掉整份 function 列表`);
    if (!KW.has(k)) problems.push(`${tool}: ${path}.${k} 是子集外关键字`);
    if (v && typeof v === 'object') {
      const kids = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
      for (const [k2, v2] of kids) walk(v2, `${path}.${k}.${k2}`, tool);
    }
  }
}

for (const [name, t] of reg) {
  try { assertSupported(t.parameters); } catch (e) { problems.push(`${name}: parameters 被 harness 拒 —— ${e.message}`); }
  try { assertObject(t.parameters); } catch (e) { problems.push(`${name}: parameters 非对象根 —— ${e.message}`); }
  if (t.output?.schema) { try { assertSupported(t.output.schema); } catch (e) { problems.push(`${name}: output.schema 被 harness 拒 —— ${e.message}`); } }
  walk(t.parameters, name, name);
}

if (problems.length === 0) {
  console.log(`  ✅ ${reg.size} 个工具全部通过 harness 校验 —— 挂载不会崩会话`);
  process.exit(0);
}
console.log(`  ❌ 发现 ${problems.length} 处问题：`);
for (const p of problems.slice(0, 30)) console.log(`     - ${p}`);
process.exit(1);
