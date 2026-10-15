// 直接问 harness：'json' 这个 type 在「参数 schema」与「值 schema」两条路径下分别如何。
import { loadHarness } from './harness.mjs';

const h = await loadHarness();

const tryIt = (label, fn) => {
  try { const r = fn(); console.log('  OK    ' + label + (r === undefined ? '' : '  ->  ' + JSON.stringify(r))); }
  catch (e) { console.log('  THROW ' + label + '  ->  ' + e.message); }
};

console.log('--- assertSupportedJsonSchema ---');
tryIt('{"type":"json"}', () => h.assertSupportedJsonSchema({ type: 'json' }));
tryIt('{}', () => h.assertSupportedJsonSchema({}));
tryIt('{"type":"object"}', () => h.assertSupportedJsonSchema({ type: 'object' }));

console.log('--- assertObjectJsonSchema（工具参数必须对象根）---');
tryIt('{"type":"json"}', () => h.assertObjectJsonSchema({ type: 'json' }));
tryIt('{}', () => h.assertObjectJsonSchema({}));
tryIt('{"type":"object"}', () => h.assertObjectJsonSchema({ type: 'object', properties: {} }));

console.log('--- parameterSchemaSpecToJsonSchema({type:"json"}) ---');
tryIt('param spec', () => h.parameterSchemaSpecToJsonSchema({ type: 'json' }));

console.log('--- valueSchemaSpecToJsonSchema({type:"json"}) ---');
tryIt('value spec', () => h.valueSchemaSpecToJsonSchema({ type: 'json' }));

console.log('--- validateJsonSchemaValue({type:"json"}, 1) ---');
tryIt('value=1', () => h.validateJsonSchemaValue({ type: 'json' }, 1, 'x'));

console.log('--- validateJsonSchemaValue({}, 1) ---');
tryIt('value=1', () => h.validateJsonSchemaValue({}, 1, 'x'));

console.log('--- 形参数 ---');
for (const k of ['assertSupportedJsonSchema', 'assertObjectJsonSchema', 'valueSchemaSpecToJsonSchema', 'parameterSchemaSpecToJsonSchema']) {
  console.log('  ' + k + '(' + h[k]?.length + ')');
}
