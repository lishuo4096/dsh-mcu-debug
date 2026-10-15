/**
 * 扫全部已注册工具的 JSON Schema，找**会让 LLM 服务端拒绝**的结构。
 *
 * 事故背景：挂载插件后所有 DeepSeek 会话直接崩，报
 *   Invalid schema for function 'mcu_regs': "json" is not valid under any of the
 *   schemas listed in the 'anyOf' keyword
 * 也就是说我们发出去的某个函数 schema 里，`anyOf` 数组里混进了一个**字符串 "json"**，
 * 而不是 schema 对象。这类错误只在真实调用 LLM 时才暴露 —— 本地 `defineTool`
 * 只校验调用参数，不校验自己吐出去的 schema 合不合法，所以必须专门扫一遍。
 */
import { apply } from '../index.js';

const VALID_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const SCHEMA_KEYS = new Set([
  'type', 'description', 'enum', 'const', 'default', 'items', 'properties',
  'required', 'additionalProperties', 'anyOf', 'oneOf', 'allOf', 'not',
  'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems',
  'pattern', 'format', 'title', 'examples', 'nullable', '$schema', '$ref',
  'definitions', '$defs', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'propertyNames',
]);

const problems = [];

function walk(node, path, tool) {
  if (node === null || typeof node !== 'object') {
    problems.push(`${tool}  ${path}: 不是对象而是 ${JSON.stringify(node)}（${typeof node}）`);
    return;
  }
  if (Array.isArray(node)) {
    problems.push(`${tool}  ${path}: 期望对象却拿到数组`);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (!SCHEMA_KEYS.has(k)) {
      problems.push(`${tool}  ${path}: 未知关键字 ${k}=${JSON.stringify(v).slice(0, 60)}`);
      continue;
    }
    if (k === 'type') {
      const types = Array.isArray(v) ? v : [v];
      for (const t of types) {
        if (!VALID_TYPES.has(t)) problems.push(`${tool}  ${path}.type: 非法类型 ${JSON.stringify(t)}`);
      }
    }
    if (k === 'anyOf' || k === 'oneOf' || k === 'allOf') {
      if (!Array.isArray(v)) {
        problems.push(`${tool}  ${path}.${k}: 必须是数组`);
      } else {
        v.forEach((sub, i) => walk(sub, `${path}.${k}[${i}]`, tool));
      }
      continue;
    }
    if (k === 'properties') {
      for (const [pk, pv] of Object.entries(v)) walk(pv, `${path}.properties.${pk}`, tool);
      continue;
    }
    if (k === 'items') {
      if (Array.isArray(v)) v.forEach((s, i) => walk(s, `${path}.items[${i}]`, tool));
      else walk(v, `${path}.items`, tool);
      continue;
    }
    if (typeof v === 'object' && v !== null) walk(v, `${path}.${k}`, tool);
  }
  // 一个「对象」schema 必须说明它是什么，否则服务端可能拒绝
  if (!node.type && !node.anyOf && !node.oneOf && !node.allOf && !node.$ref && !node.enum && !node.const) {
    const keys = Object.keys(node);
    const onlyDocs = keys.every((k) => k === 'description' || k === 'default' || k === 'title');
    if (!onlyDocs) problems.push(`${tool}  ${path}: 既没有 type 也没有 anyOf/oneOf/allOf（键：${keys.join(',')}）`);
  }
}

const registered = new Map();
apply({
  tools: { register: (t) => registered.set(t.name, t) },
  skills: { registerProvider: () => {} },
});

for (const [name, t] of registered) {
  walk(t.parameters, 'parameters', name);
  if (t.output?.schema) walk(t.output.schema, 'output.schema', name);
}

console.log(`扫了 ${registered.size} 个工具。`);
if (problems.length === 0) {
  console.log('没有发现非法结构。');
} else {
  console.log(`\n发现 ${problems.length} 处问题：`);
  for (const p of problems) console.log('  ' + p);
}

// 额外：找出任何在 schema 里出现裸字符串 "json" 的地方
const raw = [...registered].map(([n, t]) => [n, JSON.stringify(t.parameters)]);
const hits = raw.filter(([, s]) => s.includes('"json"'));
console.log(`\n参数 schema 里含裸字符串 "json" 的工具：${hits.length ? hits.map(([n]) => n).join(', ') : '（无）'}`);
