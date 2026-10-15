// 决定性检查：直接看**运行时编译出来的** parameters，而不是源码文本。
// 源码里写着 type:'json' 不等于它漏进了 function schema —— 要看编译产物。
const mcu = await import('../index.js');
const reg = new Map();
mcu.apply({ tools: { register: (t) => reg.set(t.name, t) }, skills: { registerProvider: () => {} } });

const SUSPECTS = [
  ['mcu_regs', 'set'],
  ['mcu_session_open', 'ports'],
  ['mcu_session_cmd', 'cmd'],
];

console.log('已注册工具数：' + reg.size + '\n');
console.log('── 三处疑似投毒点的**运行时编译产物** ──');
for (const [tool, prop] of SUSPECTS) {
  const t = reg.get(tool);
  if (!t) { console.log(`  ✗ ${tool}: 工具不存在`); continue; }
  const p = t.parameters?.properties?.[prop];
  console.log(`  ${tool}.${prop} = ${JSON.stringify(p)}`);
}

console.log('\n── 全量扫描：所有工具参数里还有没有非法 type ──');
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array']);
const KW = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples']);
let bad = 0;
function walk(node, path) {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' && typeof v === 'string' && !TYPES.has(v)) { console.log(`  ✗ ${path}.type = ${JSON.stringify(v)}`); bad++; }
    if (!KW.has(k) && !['name', 'parameters', 'properties', 'output', 'schema'].includes(k)) { console.log(`  ✗ ${path}.${k} 非子集关键字`); bad++; }
    if (k === 'items' || k === 'additionalProperties' || k === 'properties' || k === 'output' || k === 'schema' || k === 'oneOf' || k === 'default' || k === 'examples' || k === 'const' || k === 'enum') {
      const kids = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
      for (const [k2, v2] of kids) walk(v2, `${path}.${k}.${k2}`);
    }
  }
}
for (const [name, t] of reg) walk(t.parameters, name);
console.log(bad === 0 ? '  ✓ 全部合法（无非法 type、无子集外关键字）' : `  ✗ 共 ${bad} 处`);
process.exit(bad ? 1 : 0);
