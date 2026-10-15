/**
 * 定位 harness 自带的 `@deepseek-ai/dsh-tools`。
 *
 * 为什么非要找到它：判断一个工具参数 schema 合不合法，**唯一权威**是 provider 侧的
 * 那道校验。我们自己写的规则再像也只是模仿，模仿得再像也可能漏掉一条规则 ——
 * 而漏掉一条的代价是「插件一挂载，所有对话全崩」（见 README「事故」一节）。
 * 所以门禁一律调用 harness 自己的 `assertSupportedJsonSchema` / `assertObjectJsonSchema`。
 *
 * 查找顺序：
 *   1. 环境变量 `DSH_TOOLS_PATH`（直接指向 lib/index.js，跨机器/跨版本最稳）
 *   2. 直接 `import('@deepseek-ai/dsh-tools')`（插件在 harness 进程内跑时可用）
 *   3. Windows 默认安装位置 %LOCALAPPDATA%\Programs\DeepSeek Harness\...
 *   4. 在 %LOCALAPPDATA%\Programs 下浅层搜索该包
 *
 * 找不到就抛带指引的错误，绝不静默降级成「用自己写的规则代替」——
 * 那样门禁会变成绿灯假象，比没有门禁更糟。
 */
import { pathToFileURL } from 'node:url';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REL = join('node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');

function localAppData() {
  return process.env.LOCALAPPDATA ?? process.env.HOME ?? '';
}

function probeInstallRoots() {
  const roots = [];
  const base = join(localAppData(), 'Programs');
  if (!existsSync(base)) return roots;
  for (const name of ['DeepSeek Harness', 'DeepseekHarness', 'dsh']) {
    const p = join(base, name);
    if (existsSync(p)) roots.push(p);
  }
  // 兜底：Programs 下任何名字里带 har / deep 的目录
  try {
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (/harness|deepseek|dsh/i.test(e.name) && !roots.includes(join(base, e.name))) {
        roots.push(join(base, e.name));
      }
    }
  } catch { /* ignore */ }
  return roots;
}

/** 在某个安装根下浅层搜 app/dsh/node_modules/... */
function searchUnder(root, depth = 4) {
  const hits = [];
  const walk = (dir, d) => {
    if (d > depth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules') {
        const cand = join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
        if (existsSync(cand)) { hits.push(cand); continue; }
      }
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(join(dir, e.name), d + 1);
    }
  };
  walk(root, 0);
  return hits;
}

const tried = [];

export async function loadHarness({ required = true } = {}) {
  // 1. 环境变量
  const envPath = process.env.DSH_TOOLS_PATH;
  if (envPath) {
    tried.push(`DSH_TOOLS_PATH=${envPath}`);
    const p = envPath.endsWith('.js') ? envPath : join(envPath, REL);
    if (existsSync(p)) return await import(pathToFileURL(p).href);
    tried.push('  → 该路径不存在');
  }

  // 2. 裸 import（在 harness 进程内时）
  try {
    tried.push("import('@deepseek-ai/dsh-tools')");
    return await import('@deepseek-ai/dsh-tools');
  } catch { /* next */ }

  // 3/4. Windows 默认安装位置
  for (const root of probeInstallRoots()) {
    tried.push(`搜索 ${root}`);
    for (const hit of searchUnder(root)) {
      tried.push(`  → 命中 ${hit}`);
      return await import(pathToFileURL(hit).href);
    }
  }

  if (!required) return null;
  throw new Error(
    '找不到 harness 的 @deepseek-ai/dsh-tools，无法用官方校验器验收 schema。\n' +
    '请设置环境变量 DSH_TOOLS_PATH 指向 .../@deepseek-ai/dsh-tools/lib/index.js，例如：\n' +
    '  $env:DSH_TOOLS_PATH="$env:LOCALAPPDATA\\Programs\\DeepSeek Harness\\resources\\app\\dsh\\node_modules\\@deepseek-ai\\dsh-tools\\lib\\index.js"\n' +
    '尝试过：\n  ' + tried.join('\n  '),
  );
}

export const HARNESS_HINT = '设置 DSH_TOOLS_PATH 以指定 @deepseek-ai/dsh-tools/lib/index.js';

/** 直接拿三个校验函数，最常用 */
export async function loadValidators() {
  const h = await loadHarness();
  return {
    dshTools: h,
    assertSupported: h.assertSupportedJsonSchema,
    assertObject: h.assertObjectJsonSchema,
  };
}

/** 是否已安装 harness（用于跳过而不是伪装通过） */
export function harnessAvailable() {
  if (process.env.DSH_TOOLS_PATH && existsSync(process.env.DSH_TOOLS_PATH)) return true;
  for (const root of probeInstallRoots()) if (searchUnder(root).length) return true;
  return false;
}

void statSync; // 保留：某些分支可能想校验文件类型
