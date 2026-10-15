/**
 * 用 **harness 自己的** JSON Schema 校验器（@deepseek-ai/dsh-tools 的
 * assertSupportedJsonSchema / assertObjectJsonSchema）来验收 mcu-debug 的
 * 全部工具参数 —— 不靠我们自己写的判据自说自话。
 *
 * 这一步要回答两个问题：
 *   ① 当初的毒 schema（{ type:'json' }）harness 是不是真的会拒？（复现事故）
 *   ② 修完之后那种「只有 description、没有 type」的属性，harness 认不认？
 *
 * 只有两问都答上，才能确定插件可以安全挂载。
 */
import { pathToFileURL } from 'node:url';

const HARNESS = pathToFileURL(
  'C:/Users/lishuo/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
).href;

const dshTools = await import(HARNESS);
const names = Object.keys(dshTools).filter((k) => /Schema/i.test(k));
console.log('dsh-tools 导出的 schema 相关符号：');
console.log('  ' + names.join(', '));
console.log('');

const assertSupported = dshTools.assertSupportedJsonSchema;
const assertObject = dshTools.assertObjectJsonSchema;
if (typeof assertSupported !== 'function') {
  console.error('找不到 assertSupportedJsonSchema，无法验收');
  process.exit(2);
}

let pass = 0;
let fail = 0;
function tryIt(label, schema, expectReject) {
  try {
    assertSupported(schema);
    if (expectReject) {
      console.log(`  ✗ ${label}：harness 接受了，但预期应拒`);
      fail++;
    } else {
      console.log(`  ✓ ${label}：harness 接受`);
      pass++;
    }
  } catch (e) {
    if (expectReject) {
      console.log(`  ✓ ${label}：harness 拒绝（预期）—— ${e.message}`);
      pass++;
    } else {
      console.log(`  ✗ ${label}：harness 拒绝 —— ${e.message}`);
      fail++;
    }
  }
}

console.log('── 问题①：当初的毒 schema 能不能复现事故 ──');
tryIt(
  '毒 schema：properties.set = { type: "json" }',
  { type: 'object', properties: { set: { type: 'json' } } },
  true,
);
tryIt('合法：properties.set = { description: "…" }（注解型 / 无 type）', {
  type: 'object',
  properties: { set: { description: '要改的寄存器' } },
}, false);
tryIt('合法：properties.set = {}（全空）', { type: 'object', properties: { set: {} } }, false);
tryIt('合法：properties.set = { type: "object", additionalProperties: true }', {
  type: 'object',
  properties: { set: { type: 'object', additionalProperties: true } },
}, false);

console.log('\n── 问题②：harness 认不认 anyOf / allOf / 多分支 oneOf ──');
tryIt('anyOf（harness 的子集里没有这个关键字）', {
  type: 'object',
  properties: { a: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
}, true);
tryIt('allOf', {
  type: 'object',
  properties: { a: { allOf: [{ type: 'string' }] } },
}, true);
tryIt('oneOf 单分支（文档说 exact-one）', {
  type: 'object',
  properties: { a: { oneOf: [{ type: 'string' }] } },
}, false);
tryIt('oneOf 多分支（文档说 exact-one → 应拒）', {
  type: 'object',
  properties: { a: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
}, true);

console.log('\n── 用 harness 校验器验收 mcu-debug 全部 27 个工具 ──');
const mcu = await import('../index.js');
const registered = new Map();
mcu.apply({ tools: { register: (t) => registered.set(t.name, t) }, skills: { registerProvider: () => {} } });

let bad = 0;
for (const [name, t] of registered) {
  let okS = true;
  let msgS = '';
  try {
    assertSupported(t.parameters);
  } catch (e) {
    okS = false;
    msgS = e.message;
  }
  let okO = true;
  let msgO = '';
  if (t.output?.schema && typeof assertSupported === 'function') {
    try {
      assertSupported(t.output.schema);
    } catch (e) {
      okO = false;
      msgO = e.message;
    }
  }
  if (!okS || !okO) {
    bad++;
    console.log(`  ✗ ${name}${okS ? '' : ' parameters: ' + msgS}${okO ? '' : ' output.schema: ' + msgO}`);
  }
}
console.log(`  ${registered.size - bad}/${registered.size} 个工具的 parameters + output.schema 均通过 harness 校验`);

if (typeof assertObject === 'function') {
  console.log('\n── 对象根校验（assertObjectJsonSchema，工具参数必须对象根）──');
  let bad2 = 0;
  for (const [name, t] of registered) {
    try {
      assertObject(t.parameters);
    } catch (e) {
      bad2++;
      console.log(`  ✗ ${name}: ${e.message}`);
    }
  }
  console.log(`  ${registered.size - bad2}/${registered.size} 个工具参数是合法的对象根 schema`);
  bad += bad2;
}

console.log(`\n${'='.repeat(64)}`);
console.log(`断言通过 ${pass}，失败 ${fail}；工具 schema 不合法 ${bad} 个`);
process.exit(fail || bad ? 1 : 0);
