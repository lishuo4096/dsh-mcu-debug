/**
 * 端到端冒烟：用 mock ctx 把 27 个工具全注册一遍，然后挑只读的实跑。
 * 目的：证明「工具定义 → validateArgs → execute → 渲染」这条链没断。
 */
import { apply, name } from '../index.js';

const registered = new Map();
let skillProvider = null;

const ctx = {
  tools: {
    register(t) {
      if (!t?.name) throw new Error('注册了没有 name 的工具');
      if (registered.has(t.name)) throw new Error(`工具名重复：${t.name}`);
      registered.set(t.name, t);
    },
  },
  skills: {
    registerProvider(fn) {
      skillProvider = fn({ signal: undefined });
    },
  },
};

const t0 = Date.now();
apply(ctx);
console.log(`apply() 用了 ${Date.now() - t0} ms`);

console.log(`\n注册了 ${registered.size} 个工具：`);
for (const [n, t] of registered) {
  const keys = Object.keys(t.parameters?.properties ?? {});
  const req = t.parameters?.required ?? [];
  console.log(`  ${n.padEnd(20)} 参数 ${keys.length} 个${req.length ? `（必填 ${req.join(',')}）` : ''}  schema=${t.output?.schema ? 'ok' : 'MISSING'}`);
}

// 技能 provider
if (skillProvider) {
  const l = await skillProvider.list({});
  console.log(`\n技能 provider：name=${skillProvider.name}, complete=${l.complete}, 候选 ${l.candidates?.length ?? 0} 个`);
  for (const c of l.candidates ?? []) console.log(`  ${c.name} — ${c.description?.slice(0, 60)}…`);
  const g = await skillProvider.get(l.candidates?.[0]);
  console.log(`  取回 ${g?.name}：正文 ${g?.content?.length ?? 0} 字符，resourceBase=${g?.resourceBase?.path ?? '无'}`);
}

// 实跑选定的只读工具
const RUN = process.argv.slice(2);
if (RUN.length) {
  for (const spec of RUN) {
    const [tool, jsonArgs] = spec.split('=', 2);
    const t = registered.get(tool);
    if (!t) {
      console.log(`\n!! 没有 ${tool} 这个工具`);
      continue;
    }
    const args = jsonArgs ? JSON.parse(jsonArgs) : {};
    console.log(`\n${'='.repeat(78)}\n>>> ${tool} ${JSON.stringify(args)}\n${'='.repeat(78)}`);
    const started = Date.now();
    try {
      const v = await t.execute(args, { cwd: process.cwd() });
      const rendered = t.output?.render?.(args, v);
      const text = rendered?.[0]?.text ?? String(v?.message ?? '');
      console.log(text);
      console.log(`\n[${Date.now() - started} ms] ok=${v?.ok}`);
    } catch (e) {
      console.log(`!! 抛异常（这不该发生 —— 约定是普通失败返回 ok:false）：${e?.name}: ${e?.message}`);
      if (e?.violations) console.log('   violations:', e.violations);
      console.log(e?.stack?.split('\n').slice(0, 6).join('\n'));
    }
  }
}
