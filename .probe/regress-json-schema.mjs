/**
 * 回归测试：当初打死所有对话的那条报错，必须再也出不来。
 *
 * 原始报错（用户实测，逐字）：
 *   Invalid schema for function 'mcu_regs': "json" is not valid under any of the
 *   schemas listed in the 'anyOf' keyword
 *
 * 机理：`parameters` 有两种写法，第二种（原始 JSON Schema 形状）以前被 `{ ...spec }`
 * 原样透传，于是作者侧标记 `{ type: 'json' }` 没被编译成 `{}`，字面量 `"json"`
 * 直接进了 function schema。provider 对 `type` 只认
 * anyOf[array,boolean,integer,null,number,object,string]，**一处非法 → 整份工具列表被拒
 * → 之后每一轮请求都失败**（跟调用什么工具无关）。
 *
 * 这里用 `defineTool` 单独喂几种「能写出 type:'json' 的写法」，断言编译结果里
 * 既没有非法 type、也不含字面量 "json"。
 */
import { defineTool, findIllegalSchemaTypes, SCHEMA_TYPES, sanitizeSchema } from '../lib/define-tool.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${label}`);
  } catch (e) {
    fail++;
    failures.push(`${label}: ${e.message}`);
    console.log(`  ✗ ${label} —— ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** 注册一个工具并取回它最终送出去的 parameters（走真实 defineTool 路径）。 */
function paramsOf(parameters) {
  const t = defineTool({
    name: 'probe_tool',
    description: '测试用',
    parameters,
    output: { schema: { type: 'json' }, render: () => [] },
    execute: () => ({}),
  });
  return t.parameters;
}

/** 一个 function schema 能否被 provider 接受：不含非法 type、不含字面量 "json"。 */
function assertAcceptable(p, label) {
  const illegal = findIllegalSchemaTypes(p);
  assert(illegal.length === 0, `${label}: findIllegalSchemaTypes 命中 ${illegal.join(', ')}`);
  const raw = JSON.stringify(p);
  assert(!raw.includes('"json"'), `${label}: schema 里仍有字面量 "json" → ${raw.slice(0, 200)}`);
  // 逐个 type 再核一遍（不依赖自家函数）
  const seen = [];
  (function walk(n) {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return;
    if (n.type !== undefined) {
      for (const t of Array.isArray(n.type) ? n.type : [n.type]) {
        seen.push(t);
        assert(SCHEMA_TYPES.has(t), `${label}: 非法 type ${JSON.stringify(t)}`);
      }
    }
    if (n.properties) for (const v of Object.values(n.properties)) walk(v);
    if (n.items) Array.isArray(n.items) ? n.items.forEach(walk) : walk(n.items);
    for (const k of ['oneOf', 'anyOf', 'allOf']) if (Array.isArray(n[k])) n[k].forEach(walk);
  })(p);
  assert(seen.length > 0, `${label}: 一个 type 都没有，说明结构被吃空了`);
}

console.log('回归测试：type:\'json\' 不能再漏进 function schema\n');

console.log('写法 1 —— 扁平 DSL（当前插件全用这种）');
check(`mcu_regs 同款：{ set: { type:'json', description } }`, () => {
  const p = paramsOf({
    target: { type: 'string', description: '型号' },
    set: { type: 'json', description: '要改的寄存器，如 {"pc":"0x08000100"}' },
  });
  assertAcceptable(p, '扁平 DSL');
  assert(p.properties.set.type === undefined, `set 不该有 type，实际 ${JSON.stringify(p.properties.set.type)}`);
  assert(p.properties.set.description.includes('pc'), 'set 的 description 必须保留');
});

console.log('\n写法 2 —— 原始 JSON Schema 形状（当初出事的写法，必须也走编译）');
check(`{ type:'object', properties:{ set:{ type:'json' } } }`, () => {
  const p = paramsOf({
    type: 'object',
    properties: {
      target: { type: 'string', description: '型号' },
      set: { type: 'json', description: '要改的寄存器' },
      extra: { type: 'array', items: { type: 'string' }, description: '额外命令' },
    },
  });
  assertAcceptable(p, '原始 JSON Schema 形状');
  assert(p.type === 'object', '根节点必须是 object');
  assert(p.properties.set.type === undefined, 'set 仍漏出了 type');
});

console.log('\n写法 3 —— 上面那种写法里 required 也给上');
check('带 required 数组', () => {
  const p = paramsOf({
    type: 'object',
    required: ['port'],
    properties: {
      port: { type: 'string', required: true, description: '口' },
      cmd: { type: 'json', description: '一条命令或多条' },
    },
  });
  assertAcceptable(p, 'required 形状');
});

console.log('\n写法 4 —— 嵌套在 oneOf / items 里（最深的漏点）');
check('oneOf 里套 type:json', () => {
  const p = paramsOf({
    type: 'object',
    properties: {
      a: { oneOf: [{ type: 'json', description: '任意' }, { type: 'string', description: '字串' }] },
    },
  });
  assertAcceptable(p, 'oneOf 嵌套');
});
check('array items 里套 type:json', () => {
  const p = paramsOf({
    type: 'object',
    properties: { a: { type: 'array', items: { type: 'json', description: '任意元素' } } },
  });
  assertAcceptable(p, 'items 嵌套');
});

console.log('\n写法 5 —— 别的 DSL 抄来的非法类型名（拼错也要拦住）');
for (const bogus of ['Json', 'JSON', 'any', 'text', 'dict', 'list', 'float', 'int']) {
  check(`type:'${bogus}' → 退化成开放 schema 而不是漏出去`, () => {
    const p = paramsOf({ type: 'object', properties: { x: { type: bogus, description: 'x' } } });
    assertAcceptable(p, `type:'${bogus}'`);
  });
}

console.log('\n写法 6 —— 手工构造毒节点，只走 sanitizeSchema 也该被摘掉');
check('sanitizeSchema 能摘掉深层的 type:json', () => {
  const poisoned = {
    type: 'object',
    properties: {
      ok: { type: 'string' },
      deep: { type: 'array', items: { type: 'object', properties: { bad: { type: 'json' } } } },
    },
    required: 'not-an-array',
  };
  const cleaned = sanitizeSchema(poisoned);
  assertAcceptable(cleaned, 'sanitizeSchema');
  assert(cleaned.required === undefined, '非数组的 required 必须被摘掉');
});

console.log('\n写法 7 —— 空 / 异常输入不该崩');
for (const [label, spec] of [
  ['undefined', undefined],
  ['null', null],
  ['空对象', {}],
  ['布尔根 true', true],
  ['字段值为 null', { type: 'object', properties: { a: null } }],
  ['字段值是字符串', { type: 'object', properties: { a: 'oops' } }],
]) {
  check(`parameters=${label}`, () => {
    const p = paramsOf(spec);
    assert(p && typeof p === 'object', '没返回对象');
    assert(!JSON.stringify(p).includes('"json"'), '漏出 "json"');
  });
}

console.log(`\n${'='.repeat(60)}`);
console.log(`通过 ${pass}，失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  ' + f);
}
process.exit(fail ? 1 : 0);
