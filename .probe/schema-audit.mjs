/**
 * 严格自检：把每个工具**最终送给 provider 的 function schema** 完整验证一遍。
 *
 * 事故：挂载插件 → 所有 DeepSeek 会话立刻崩，
 *   Invalid schema for function 'mcu_regs': "json" is not valid under any of the
 *   schemas listed in the 'anyOf' keyword
 * provider 对 `type` 只认 anyOf[array,boolean,integer,null,number,object,string]，
 * **一处非法就拒掉整份工具列表** → 之后每一轮请求都失败。
 *
 * 本地 `defineTool` 只校验调用参数，不校验自己吐出的 schema，所以必须专门扫。
 */
import { findIllegalSchemaTypes, SCHEMA_TYPES } from '../lib/define-tool.js';
import * as mcu from '../index.js';

/** provider 允许的 JSON Schema 关键字（多余的关键字也可能被严格实现拒掉）。 */
const KNOWN = new Set([
  'type', 'description', 'enum', 'const', 'default', 'items', 'properties', 'required',
  'additionalProperties', 'anyOf', 'oneOf', 'allOf', 'not', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength',
  'pattern', 'format', 'minItems', 'maxItems', 'uniqueItems', 'title', 'examples',
  'nullable', '$schema', '$ref', '$defs', 'definitions', 'minProperties', 'maxProperties',
  'propertyNames', 'patternProperties', 'if', 'then', 'else', 'dependentRequired',
]);

/** 深度遍历：收集所有问题（不用任何早退，避免漏检）。 */
function audit(node, path, tool, bad) {
  if (node === null || node === undefined) return;
  if (typeof node !== 'object' || Array.isArray(node)) {
    bad.push(`${tool}  ${path}: 不是 schema 对象而是 ${JSON.stringify(node)}`);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    const here = `${path}.${k}`;
    if (!KNOWN.has(k)) bad.push(`${tool}  ${here}: 未知关键字（值=${JSON.stringify(v).slice(0, 60)}）`);

    if (k === 'type') {
      const list = Array.isArray(v) ? v : [v];
      for (const t of list) {
        if (typeof t !== 'string' || !SCHEMA_TYPES.has(t)) {
          bad.push(`${tool}  ${here}: 非法 type ${JSON.stringify(t)} —— provider 会因此拒掉整份工具列表`);
        }
      }
      continue;
    }
    if (k === 'enum' || k === 'const' || k === 'default' || k === 'examples') continue; // 任意值
    if (k === 'required') {
      if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
        bad.push(`${tool}  ${here}: required 必须是字符串数组`);
      }
      continue;
    }
    if (k === 'properties' || k === 'patternProperties' || k === 'definitions' || k === '$defs') {
      if (typeof v !== 'object' || Array.isArray(v)) {
        bad.push(`${tool}  ${here}: 必须是对象`);
        continue;
      }
      for (const [pk, pv] of Object.entries(v)) audit(pv, `${here}.${pk}`, tool, bad);
      continue;
    }
    if (k === 'items') {
      if (Array.isArray(v)) v.forEach((s, i) => audit(s, `${here}[${i}]`, tool, bad));
      else audit(v, here, tool, bad);
      continue;
    }
    if (k === 'anyOf' || k === 'oneOf' || k === 'allOf') {
      if (!Array.isArray(v) || v.length === 0) {
        bad.push(`${tool}  ${here}: 必须是**非空**数组`);
        continue;
      }
      v.forEach((s, i) => audit(s, `${here}[${i}]`, tool, bad));
      continue;
    }
    if (['additionalProperties', 'not', 'propertyNames', 'if', 'then', 'else'].includes(k)) {
      if (typeof v === 'object') audit(v, here, tool, bad);
      continue;
    }
    // 其余标量关键字（description/format/pattern/数值边界）不再深入
  }
  // 叶子节点得有实际约束，否则它是「没有 type 的裸对象」
  const keys = Object.keys(node);
  if (keys.length === 0) bad.push(`${tool}  ${path}: 空对象 {}`);
}

function scan(pluginName, mod) {
  const registered = new Map();
  try {
    mod.apply({
      tools: { register: (t) => registered.set(t.name, t) },
      skills: { registerProvider: () => {} },
    });
  } catch (e) {
    console.log(`[${pluginName}] apply() 抛错：${e.message}`);
    return new Map();
  }

  const bad = [];
  for (const [name, t] of registered) {
    if (!t.parameters) bad.push(`${name}  parameters: 缺失`);
    else audit(t.parameters, 'parameters', name, bad);
    const stray = findIllegalSchemaTypes(t.parameters);
    for (const s of stray) bad.push(`${name}  ${s}（findIllegalSchemaTypes 命中）`);
    if (t.output?.schema) audit(t.output.schema, 'output.schema', name, bad);
  }

  console.log(`[${pluginName}] 注册 ${registered.size} 个工具，问题 ${bad.length} 处。`);
  for (const b of bad) console.log('   ' + b);

  // 直接搜字面量 "json"，那是本次事故的指纹
  const fingerprints = [...registered]
    .filter(([, t]) => JSON.stringify(t.parameters ?? {}).includes('"json"'))
    .map(([n]) => n);
  console.log(
    `[${pluginName}] 参数 schema 含字面量 "json" 的工具：${fingerprints.length ? fingerprints.join(', ') : '（无）'}`,
  );
  return registered;
}

console.log('='.repeat(72));
const reg = scan('dsh-mcu-debug', mcu);
console.log('='.repeat(72));
console.log(`mcu_regs 的 set 参数编译结果：`);
console.log('   ' + JSON.stringify(reg.get('mcu_regs')?.parameters?.properties?.set));
console.log(`mcu_regs 的 output.schema：${JSON.stringify(reg.get('mcu_regs')?.output?.schema)}`);
