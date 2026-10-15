/**
 * 工具 schema 自检 —— 防止「一个非法 `type` 打死所有对话」再发生。
 *
 * ## 背景（真实事故）
 *
 * 插件装上后**每一轮对话**都失败，报错与调用了什么工具无关：
 *
 *     Invalid schema for function 'mcu_regs': "json" is not valid under any of
 *     the schemas listed in the 'anyOf' keyword
 *
 * 根因：`mcu_regs` 的 `set` 参数写成作者侧 DSL 的 `{ type: 'json' }`，而
 * `parameters` 用的是原始 JSON Schema 形状（`{ type:'object', properties:{…} }`），
 * 那条路径当时被 `{ ...spec }` 原样透传、跳过了编译，于是字面量 `"type":"json"`
 * 进了 function schema。provider 校验 function 的 JSON Schema 时，`type` 只认
 * `anyOf[array,boolean,integer,null,number,object,string]`，**一处非法 → 整份
 * 工具列表被拒 → 之后每次请求都失败**。禁用插件即可恢复对话，是与本 bug 一致的
 * 现象（禁用后这份 function 就不再随请求发出）。
 *
 * ## 这个脚本做什么
 *
 * 用假的 `ctx` 把四组工具全注册一遍（与 `index.js` 的 `apply()` 同序、同参数），
 * 然后**逐工具逐节点**复刻 provider 的那条校验：任何位置的 `type` 不在允许集合里
 * 就报错并以非 0 退出。另外顺手检查非数组的 `required:true` 残留（它不是合法
 * JSON Schema 关键字，严格校验器会拒）。
 *
 * ## 怎么跑
 *
 *     node test/check-tool-schemas.mjs
 *
 * 退出码 0 = 所有 function schema 都会被 provider 接受。
 *
 * ⚠️ 校验用的是**编译后的** `tool.parameters` —— 也就是宿主真正发出去的那份，
 * 不是作者写的源码。这才是「provider 会看到什么」的唯一真相。
 */

import { registerEnvTools } from '../lib/tools-env.js';
import { registerDebugTools } from '../lib/tools-debug.js';
import { registerSessionTools } from '../lib/tools-session.js';
import { registerSerialTools } from '../lib/tools-serial.js';
import { SCHEMA_TYPES, findIllegalSchemaTypes, sanitizeSchema, compileNode } from '../lib/define-tool.js';

/** provider 允许的 `type` 取值 —— 与报错信息里的 anyOf 一致。 */
const ALLOWED = SCHEMA_TYPES;

/** 收集注册进来的工具定义。 */
const captured = [];

/** 只实现被 `register*Tools` 真正用到的那些 ctx 面。 */
const fakeCtx = {
  tools: {
    register(tool) {
      captured.push(tool);
      return tool;
    },
  },
  skills: { registerProvider() {} },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  on() {},
  effect() {},
};

const groups = [
  ['环境', registerEnvTools],
  ['目标', registerDebugTools],
  ['会话', registerSessionTools],
  ['串口', registerSerialTools],
];

const problems = [];

for (const [label, fn] of groups) {
  try {
    const names = fn(fakeCtx);
    console.log(`✓ ${label}组：注册 ${names?.length ?? '?'} 个工具`);
  } catch (error) {
    problems.push(`${label}组注册直接抛异常：${error?.stack ?? error}`);
  }
}

console.log(`\n共捕获 ${captured.length} 个工具定义\n`);

/** 是「名字 → 子 schema」的映射表，不是 schema 本身。 */
const NAME_MAPS = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas']);

/** 值是纯注解、不必递归的关键字。 */
const LEAF_KEYS = new Set(['type', 'required', 'description', 'title', 'enum', 'const', 'default', 'format', 'pattern']);

/**
 * 复刻 provider 的校验：非法 `type` + 非法的 `required`。
 *
 * ⚠️ 这里有个容易把自己坑进去的点：`properties` 的值是 **名字 → 子 schema** 的映射表，
 * 名字可以是 `type` / `required` 这种和关键字同名的东西（本插件的 `mcu_bp` 就有一个
 * 叫 `type` 的参数，取值 `bp`/`wp`）。映射表本身**不是** schema，不能拿它当节点查。
 */
function checkNode(node, path, toolName, sink) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => checkNode(v, `${path}[${i}]`, toolName, sink));
    return;
  }
  if ('type' in node && (typeof node.type !== 'string' || !ALLOWED.has(node.type))) {
    sink.push(`${toolName}: ${path}.type=${JSON.stringify(node.type)} —— 不在 provider 允许的 ${[...ALLOWED].join('/')} 里`);
  }
  if ('required' in node && !Array.isArray(node.required)) {
    sink.push(`${toolName}: ${path}.required=${JSON.stringify(node.required)} —— 必须是数组（作者侧 DSL 的 required:true 不该出现在这里）`);
  }
  for (const [key, value] of Object.entries(node)) {
    if (LEAF_KEYS.has(key)) continue;
    if (NAME_MAPS.has(key) && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, sub] of Object.entries(value)) {
        checkNode(sub, `${path ? path + '.' : ''}${key}["${name}"]`, toolName, sink);
      }
      continue;
    }
    checkNode(value, path ? `${path}.${key}` : key, toolName, sink);
  }
}

const seen = new Set();
for (const tool of captured) {
  const name = tool?.name ?? '(无名)';
  if (seen.has(name)) problems.push(`工具名重复注册：${name}`);
  seen.add(name);

  if (!tool?.parameters || tool.parameters.type !== 'object' || typeof tool.parameters.properties !== 'object') {
    problems.push(`${name}: parameters 不是对象根 schema（收到 ${JSON.stringify(tool?.parameters)?.slice(0, 120)}）`);
    continue;
  }

  checkNode(tool.parameters, 'parameters', name, problems);

  const illegal = findIllegalSchemaTypes(tool.parameters);
  if (illegal.length) problems.push(`${name}: findIllegalSchemaTypes 命中 ${illegal.join(', ')}`);
}

/**
 * 原始参数表里还残留多少「开放 schema」参数 —— 作者侧写 `type:'json'` 的地方。
 * 编译后它们只剩 `{}` 或 `{ description }`，这是**正常**且合法的（provider 接受空 schema）。
 * 这里只是为了把「哪些参数变成了无约束」列清楚，方便对照审查。
 */
const openSchemas = [];
for (const t of captured) {
  for (const [k, v] of Object.entries(t?.parameters?.properties ?? {})) {
    if (v && typeof v === 'object' && Object.keys(v).every((key) => key === 'description')) {
      openSchemas.push([`${t.name}.${k}`, v]);
    }
  }
}

console.log(`\n有 ${openSchemas.length} 个参数被编译成「开放 schema」（作者侧 type:'json'）—— 合法，仅列出备查：`);
for (const [k, v] of openSchemas) console.log(`  - ${k}: ${JSON.stringify(v)}`);

/** 把关键工具的编译结果原样打出来，出问题时一眼能对。 */
const dump = ['mcu_regs', 'mcu_session_open', 'mcu_session_cmd'];
for (const name of dump) {
  const t = captured.find((x) => x?.name === name);
  if (!t) continue;
  console.log(`\n--- ${name} parameters (编译后，即 provider 看到的那份) ---`);
  console.log(JSON.stringify(t.parameters, null, 2));
}

if (problems.length) {
  console.error(`\n❌ 发现 ${problems.length} 个会让 provider 拒掉整份工具列表的问题：\n`);
  for (const p of problems) console.error(`  * ${p}`);
  process.exitCode = 1;
} else {
  console.log(`\n✅ ${captured.length} 个工具的 function schema 全部合法 —— provider 不会再因 schema 拒掉请求。`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 反向对照（negative control）：一个抓不住原 bug 的检查等于没有检查。
//
// 下面这份 spec 就是触发那次事故的最小复现：`parameters` 写成原始 JSON Schema 形状，
// 里面某个参数用了作者侧 DSL 的 `type:'json'`。旧实现（`{ ...spec }` 原样透传）
// 会让它原封不动地进到 function schema。
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== 反向对照：原 bug 的最小复现 ===');

const preFixSpec = {
  type: 'object',
  properties: {
    target: { type: 'string', description: '型号' },
    set: { type: 'json', description: '要改的寄存器' },
  },
};

const asOldCodeDid = { ...preFixSpec };
const oldIllegal = findIllegalSchemaTypes(asOldCodeDid);
console.log(`旧实现产物：${JSON.stringify(asOldCodeDid)}`);
console.log(`  → findIllegalSchemaTypes = ${JSON.stringify(oldIllegal)}（必须非空，否则检查本身是坏的）`);

const fixed = sanitizeSchema(compileNode(preFixSpec));
const newIllegal = findIllegalSchemaTypes(fixed);
console.log(`修复后产物：${JSON.stringify(fixed)}`);
console.log(`  → findIllegalSchemaTypes = ${JSON.stringify(newIllegal)}（必须为空）`);

if (oldIllegal.length === 0 || newIllegal.length !== 0) {
  console.error('\n❌ 反向对照失败：检查逻辑或修复逻辑至少有一个不对。');
  process.exitCode = 1;
} else {
  console.log('\n✅ 反向对照通过：旧写法会被抓出来，新写法已被修好。');
}
