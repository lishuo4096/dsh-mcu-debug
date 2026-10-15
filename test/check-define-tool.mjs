/**
 * `defineTool` 行为测试 —— 确认 schema 修复没有改变**运行期**语义。
 *
 * 那个 `"type":"json"` 的修复只该动「发出去的 function schema」，
 * 不该动「参数怎么校验、execute 收到什么」。这个文件把两件事都钉住：
 *
 *   1. 两种 `parameters` 写法编译出来的东西一致（扁平 DSL / 原始 JSON Schema）；
 *   2. `validateArgs` 的既有语义没被顺手改掉：
 *        - 开放 schema（作者侧 `type:'json'`）**什么都收**，不凭空收紧；
 *        - 显式 `required:['x']` 与子节点 `required:true` 都仍然强制；
 *        - `enum` / `oneOf` / `additionalProperties` 原样保留；
 *        - 非数组的 `required`（作者侧 DSL 的 `required:true`）绝不漏进 JSON Schema。
 *
 * 跑法：node test/check-define-tool.mjs
 */

import {
  compileNode,
  sanitizeSchema,
  findIllegalSchemaTypes,
  parameterSchemaSpecToJsonSchema,
  validateArgs,
  defineTool,
  SCHEMA_TYPES,
} from '../lib/define-tool.js';

let failed = 0;
let passed = 0;

/** 极简断言：失败就记账，最后统一汇报（不中途抛，能一次看全）。 */
function check(label, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}${extra !== undefined ? ` —— ${JSON.stringify(extra)}` : ''}`);
  }
}

/** 造一个最小工具定义，只关心 parameters 的编译结果。 */
function paramsOf(spec) {
  const tool = defineTool({
    name: 'probe_tool',
    description: 'test',
    parameters: spec,
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: '' }] },
    execute: async () => 'x',
  });
  return tool.parameters;
}

console.log('\n[1] 两种 parameters 写法编译结果一致');

// 扁平 DSL
const flat = parameterSchemaSpecToJsonSchema({
  target: { type: 'string', description: '型号' },
  extra: { type: 'array', items: { type: 'string' } },
});
// 原始 JSON Schema 形状（本插件 4 个 tools-*.js 实际用的写法）
const raw = compileNode({
  type: 'object',
  properties: {
    target: { type: 'string', description: '型号' },
    extra: { type: 'array', items: { type: 'string' } },
  },
});
check('扁平 DSL 与原始形状产出同一个 schema', JSON.stringify(flat) === JSON.stringify(raw), { flat, raw });

console.log('\n[2] 作者侧 type:\'json\' → 合法的开放 schema');

const withJsonParam = paramsOf({
  type: 'object',
  properties: {
    set: { type: 'json', description: '要改的寄存器' },
  },
});
check(
  'type:\'json\' 不再以字面量漏出去',
  findIllegalSchemaTypes(withJsonParam).length === 0,
  withJsonParam,
);
check('开放 schema 保留了 description', withJsonParam.properties.set.description === '要改的寄存器', withJsonParam.properties.set);
check('开放 schema 不含 type 键', !('type' in withJsonParam.properties.set), withJsonParam.properties.set);
check('开放 schema 什么都不拦（object 通过）', validateArgs(withJsonParam, { set: { pc: '0x08000100' } }).length === 0);
check('开放 schema 什么都不拦（string 通过）', validateArgs(withJsonParam, { set: 'pc=0x08000100' }).length === 0);
check('开放 schema 什么都不拦（array 通过）', validateArgs(withJsonParam, { set: ['a', 'b'] }).length === 0);

console.log('\n[3] required 语义');

const reqSpec = paramsOf({
  type: 'object',
  properties: {
    id: { type: 'string' },
    cmd: { type: 'json' },
  },
  required: ['cmd'],
});
check('显式 required:["cmd"] 被保留', JSON.stringify(reqSpec.required) === '["cmd"]', reqSpec.required);
check('缺 cmd 时报错', validateArgs(reqSpec, { id: 's1' }).some((v) => v.includes('cmd')), validateArgs(reqSpec, { id: 's1' }));
check('给了 cmd 就通过', validateArgs(reqSpec, { cmd: 'halt' }).length === 0);

const reqTrue = paramsOf({
  type: 'object',
  properties: {
    address: { type: 'string', required: true },
    length: { type: 'integer' },
  },
});
check('子节点 required:true 被折算成顶层 required', JSON.stringify(reqTrue.required) === '["address"]', reqTrue.required);
check('非数组的 required 没有漏进 JSON Schema', !('required' in reqTrue.properties.address), reqTrue.properties.address);
check('缺 address 时报错', validateArgs(reqTrue, { length: 4 }).length > 0);

console.log('\n[4] 已有约束原样保留');

const constrained = paramsOf({
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['run', 'halt'] },
    width: { type: 'integer', enum: [1, 2, 4] },
    nested: { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } },
    either: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
  },
});
check('enum 保留', JSON.stringify(constrained.properties.mode.enum) === '["run","halt"]', constrained.properties.mode);
check('enum 仍然拦非法值', validateArgs(constrained, { mode: 'nope' }).length > 0);
check('additionalProperties:false 保留', constrained.properties.nested.additionalProperties === false, constrained.properties.nested);
check('oneOf 保留', Array.isArray(constrained.properties.either.oneOf), constrained.properties.either);
check('oneOf 两分支都能过', validateArgs(constrained, { either: 'x' }).length === 0 && validateArgs(constrained, { either: 3 }).length === 0);

console.log('\n[5] 非法 type 一律被拦下');

check('拼错的 type 不再出现在产物里', findIllegalSchemaTypes(paramsOf({
  type: 'object',
  properties: { weird: { type: 'notatype' } },
})).length === 0);
check('裸非法 type 被 compileNode 降级为开放 schema', JSON.stringify(compileNode({ type: 'json' })) === '{}', compileNode({ type: 'json' }));
check('sanitizeSchema 深度清洗', findIllegalSchemaTypes(sanitizeSchema({
  type: 'object',
  properties: { a: { type: 'object', properties: { b: { type: 'wat', description: 'd' } } } },
})).length === 0);
check('SCHEMA_TYPES 与 provider 的 anyOf 一致', ['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']
  .every((t) => SCHEMA_TYPES.has(t)) && SCHEMA_TYPES.size === 7, [...SCHEMA_TYPES]);

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} 通过 / ${failed} 失败`);
if (failed) process.exitCode = 1;
