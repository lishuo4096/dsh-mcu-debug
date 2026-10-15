// 验证 defineTool 注册前的清洗网关：毒 schema 必须在**本地**被摘掉，
// 绝不能像 m00715 那次一样漏到 provider 才炸（代价是所有对话全挂）。
//
// 判据来自 @deepseek-ai/dsh-tools 的 assertSupportedJsonSchema 子集。
import { loadValidators } from './harness.mjs';

const { dshTools: harness } = await loadValidators();

const { defineTool, sanitizeSchema, SUPPORTED_KEYWORDS } = await import('../lib/define-tool.js');
const { output: stdOutput } = await import('../lib/result.js');

let pass = 0, fail = 0;
function t(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`); }
}

const noop = async () => ({ ok: true, message: 'x' });

console.log('\n── 用例①：毒 schema（当年那次事故的原形）──');
const poison = defineTool({
  name: 'poison_tool',
  description: 'x',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string' },
      set: { type: 'json', description: '寄存器名到值的映射' },
    },
  },
  output: stdOutput,
  execute: noop,
});
const pSet = poison.parameters.properties.set;
t('毒 type 被摘掉', pSet.type === undefined, `实际 type=${JSON.stringify(pSet.type)}`);
t('description 保留（退化成人能看懂的注解型）', typeof pSet.description === 'string');
if (harness?.assertSupportedJsonSchema) {
  let ok = true, msg = '';
  try { harness.assertSupportedJsonSchema(poison.parameters); } catch (e) { ok = false; msg = e.message; }
  t('harness assertSupportedJsonSchema 接受清洗后的结果', ok, msg);
}

console.log('\n── 用例②：子集外的关键字（anyOf / allOf / format）──');
const weird = sanitizeSchema({
  type: 'object',
  properties: {
    a: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    b: { allOf: [{ type: 'string' }] },
    c: { type: 'string', format: 'path', pattern: '^x' },
    d: { type: 'string', oneOf: [{ type: 'string' }] },
  },
});
t('anyOf 被摘', weird.properties.a.anyOf === undefined);
t('allOf 被摘', weird.properties.b.allOf === undefined);
t('format/pattern 被摘', weird.properties.c.format === undefined && weird.properties.c.pattern === undefined);
t('type 仍在（这个是对的）', weird.properties.c.type === 'string');
t('单支 oneOf 被摘（子集要求至少两支）', weird.properties.d.oneOf === undefined);
if (harness?.assertSupportedJsonSchema) {
  let ok = true, msg = '';
  try { harness.assertSupportedJsonSchema(weird); } catch (e) { ok = false; msg = e.message; }
  t('harness 接受清洗后的结果', ok, msg);
}

console.log('\n── 用例③：合法写法不能被误伤 ──');
const good = sanitizeSchema({
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['a', 'b'], description: 'd', default: 'a' },
    n: { type: 'integer' },
    items: { type: 'array', items: { type: 'string' } },
    nested: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false },
    branches: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
  },
  required: ['mode'],
});
t('enum 保留', JSON.stringify(good.properties.mode.enum) === '["a","b"]');
t('annotation 保留（description/default）', good.properties.mode.description === 'd' && good.properties.mode.default === 'a');
t('items 保留', good.properties.items.items.type === 'string');
t('嵌套 properties/required/additionalProperties 保留', good.properties.nested.required[0] === 'x' && good.properties.nested.additionalProperties === false);
t('两支 oneOf 保留', Array.isArray(good.properties.branches.oneOf) && good.properties.branches.oneOf.length === 2);

console.log('\n── 关键字白名单自检 ──');
t('白名单恰好是 harness 子集 + 注解', SUPPORTED_KEYWORDS.size === 8, `size=${SUPPORTED_KEYWORDS.size}`);

console.log(`\n断言通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
