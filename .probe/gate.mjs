/**
 * 挂载前的**唯一门禁**：全部通过（exit 0）才允许把插件挂进 profile。
 *
 * 为什么需要它：m00715 那次事故的代价不是「插件不可用」，而是**所有对话全崩** ——
 * 因为一个工具参数的 schema 非法，会让整份 function 列表在 provider 侧校验失败。
 * 所以挂载前必须用 **harness 自己的校验器**（不是我们自己写的判据）把每个工具的
 * 参数 schema 过一遍。
 *
 * 五道门：
 *   ① 复现事故：证明 { type:'json' } 确实会被 harness 拒（判据不是猜的）
 *   ② defineTool 网关：毒 schema / anyOf / allOf / 退化 oneOf 必须在本地被摘掉
 *   ③ 27 个工具的 parameters 必须通过 assertSupportedJsonSchema 且对象根
 *   ④ 27 个工具的 output.schema 必须通过校验
 *   ⑤ 编译产物里不得残留任何非法 type 或子集外关键字
 */
import { loadValidators, HARNESS_HINT } from './harness.mjs';

let dshTools;
try {
  ({ dshTools } = await loadValidators());
} catch (e) {
  console.error('❌ 门禁无法运行：' + e.message);
  console.error('   （' + HARNESS_HINT + '）');
  console.error('   注意：找不到官方校验器时**必须失败**，绝不能退化成自写规则后报绿。');
  process.exit(2);
}

const { assertSupportedJsonSchema: assertSupported, assertObjectJsonSchema: assertObject } = dshTools;
const { defineTool, sanitizeSchema } = await import('../lib/define-tool.js');
const { output: stdOutput } = await import('../lib/result.js');

let pass = 0;
let fail = 0;
const ok = (label) => { pass++; console.log(`  ✓ ${label}`); };
const no = (label, detail = '') => { fail++; console.log(`  ✗ ${label}${detail ? `  ——  ${detail}` : ''}`); };

function mustThrow(label, fn) {
  try { fn(); no(label, '竟然没抛，预期应拒'); }
  catch (e) { ok(`${label} → ${e.message}`); }
}
function mustPass(label, fn) {
  try { fn(); ok(label); }
  catch (e) { no(label, e.message); }
}

console.log('══ 门① 复现事故：毒 schema 到底会不会被 harness 拒 ══');
mustThrow('assertSupportedJsonSchema({type:"json"})', () => assertSupported({ type: 'json' }));
mustThrow('parameterSchemaSpecToJsonSchema({type:"json"})', () => dshTools.parameterSchemaSpecToJsonSchema({ type: 'json' }));
mustPass('assertSupportedJsonSchema({})【注解型/开放 schema 是官方认可的】', () => assertSupported({}));
mustPass('valueSchemaSpecToJsonSchema({type:"json"}) → {}【输出/值路径上 json 合法】', () => dshTools.valueSchemaSpecToJsonSchema({ type: 'json' }));

console.log('\n══ 门② defineTool 注册前网关：不合法的一律本地摘掉 ══');
const noop = async () => ({ ok: true, message: 'x' });
const poison = defineTool({
  name: 'gate_poison', description: 'x', output: stdOutput,
  parameters: { type: 'object', properties: { set: { type: 'json', description: 'd' } } },
  execute: noop,
});
poison.parameters.properties.set.type === undefined
  ? ok('毒 type 在注册前被摘掉（不会漏到 provider）')
  : no('毒 type 漏出去了', JSON.stringify(poison.parameters.properties.set));
mustPass('清洗后的 parameters 通过 harness', () => assertSupported(poison.parameters));

const weird = sanitizeSchema({
  type: 'object',
  properties: {
    a: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    b: { allOf: [{ type: 'string' }] },
    c: { type: 'string', format: 'path', pattern: '^x' },
    d: { type: 'string', oneOf: [{ type: 'string' }] },
    e: { type: 'string', enum: ['x', 'y'], default: 'x', description: 'd' },
    f: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
  },
});
!weird.properties.a.anyOf && !weird.properties.b.allOf && !weird.properties.c.format && !weird.properties.d.oneOf
  ? ok('anyOf / allOf / format / pattern / 退化 oneOf 全部被摘')
  : no('有子集外关键字残留', JSON.stringify(weird.properties));
weird.properties.e.enum && weird.properties.e.default && weird.properties.f.oneOf?.length === 2
  ? ok('合法写法（enum / default / 两支 oneOf）未被误伤')
  : no('误伤了合法写法', JSON.stringify(weird.properties.e) + ' ' + JSON.stringify(weird.properties.f));
mustPass('清洗后的其它关键字通过 harness', () => assertSupported(weird));

console.log('\n══ 门③④⑤ 全量工具验收（用 harness 校验器，不是自说自话）══');
const mcu = await import('../index.js');
const reg = new Map();
mcu.apply({ tools: { register: (t) => reg.set(t.name, t) }, skills: { registerProvider: () => {} } });
console.log(`  已注册 ${reg.size} 个工具`);

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array']);
const KW = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples']);

let badP = 0, badO = 0, badWalk = 0;
const walkBad = [];
function walk(node, path) {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'type' && typeof v === 'string' && !TYPES.has(v)) { badWalk++; walkBad.push(`${path}.type=${v}`); }
    if (!KW.has(k)) { badWalk++; walkBad.push(`${path}.${k} 非子集关键字`); }
    if (v && typeof v === 'object') {
      const kids = Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
      for (const [k2, v2] of kids) walk(v2, `${path}.${k}.${k2}`);
    }
  }
}
for (const [name, t] of reg) {
  try { assertSupported(t.parameters); } catch (e) { badP++; console.log(`  ✗ ${name} parameters: ${e.message}`); }
  try { assertObject(t.parameters); } catch (e) { badP++; console.log(`  ✗ ${name} 非对象根: ${e.message}`); }
  if (t.output?.schema) { try { assertSupported(t.output.schema); } catch (e) { badO++; console.log(`  ✗ ${name} output.schema: ${e.message}`); } }
  walk(t.parameters, name);
}
badP === 0 ? ok(`${reg.size}/${reg.size} 个工具 parameters 合法（受支持子集 + 对象根）`) : no(`${badP} 处参数非法`);
badO === 0 ? ok(`${reg.size}/${reg.size} 个工具 output.schema 合法`) : no(`${badO} 处输出 schema 非法`);
badWalk === 0 ? ok('编译产物无非法 type、无子集外关键字') : no(`${badWalk} 处：${walkBad.slice(0, 8).join(' | ')}`);

console.log('\n' + '='.repeat(66));
const verdict = fail === 0 && badP === 0 && badO === 0 && badWalk === 0;
console.log(`${verdict ? '✅ 门禁通过 —— 可以挂载' : '❌ 门禁未过 —— 禁止挂载'}    断言 ${pass} 通过 / ${fail} 失败；工具 schema 问题 ${badP + badO + badWalk} 处`);
process.exit(verdict ? 0 : 1);
