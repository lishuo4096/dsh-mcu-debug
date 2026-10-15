/**
 * 工作区卫生 —— 本插件存在的**第一理由**。
 *
 * ## 事故机理（必须原样记住）
 *
 * 1. **隐式配置**：openocd 在没有给 `-f` 时会去 CWD（以及 `-s` 搜索目录）里找
 *    `openocd.cfg` / `ocd.cfg` 并**自动 source**。上游 openocd 的 `bin\` 与 `scripts\`
 *    里出厂就带着一批 shadow 配置；只要有一次以那种目录为 CWD 启动且不给 `-f`，
 *    后面那次会话就被顶成别的接口/目标。
 *    本机实证：EIDE 装的两份 openocd（`openocd-0.12.0\`、`openocd_7a1adfbec_mingw32\`）
 *    都带 `ocd.cfg` 一类的隐式配置。
 *
 * 2. **软件断点写进指令内存**：ARM 的软件断点在 flash 上是**改写指令字节**实现的。
 *    在 flash 区下 `bp` 之后，目标被 halt 在该处、指令内存里留着断点指令；此时若
 *    直接断电或让 openocd 异常退出，**没有人把那一个指令字节改回来**。
 *    如果随后又用「读回内存再烧」或 `load_image`/`program` 的方式把这段内存当固件刷进去，
 *    断点指令就被固化进了固件 —— 于是**每次上电都在断点处停住，程序永远进不去 main**。
 *    本机那次事故就是「加了断点监测、没清理工作区」（当时是 WCH 的 RISC-V 芯片，
 *    机理在 ARM 上完全一样）。
 *
 * 3. **残留脚本**：`gdb_bp.tcl` / `init.cfg` 之类被 agent 写进工作区后没删，
 *    下一次会话被 `source` 进去 → 断点复活。同理 `openocd.log` 会被不断追加。
 *
 * ## 本插件的结构性对策（不是靠自觉，是靠代码）
 *
 * - **私有 CWD**：openocd 的进程 CWD **永远**是 `<pluginRoot>\.run\<sessionId>\`，
 *   不接受外部指定。`assertPrivateWorkdir()` 在每次 spawn 之前把这道门焊死。
 * - **禁入名单**：EIDE 工具树、`vendor\openocd` 副本体、副本的 ASCII 镜像，
 *   内部**任何目录**都禁止当 CWD。
 * - **永远显式 `-f`**：每次都 `-f <绝对路径 cfg>`，让隐式 source 没有机会触发。
 * - **卫生收尾**：每次会话结束（正常或异常）自动注入逐个 `rbp`，再 `reset run`/`shutdown`。
 * - **审计工具**：`mcu_clean` 扫私有区 + 副本区，把 `ocd.cfg`、
 *   含断点语句的脚本、卡死的 openocd 进程、端口占用全部点名，可一键隔离。
 *
 * @module lib/hygiene
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { eideRoot, runRoot, toSlash, vendorOpenocdRoot, pluginRoot } from './env.js';
import { asciiOpenocdRoot } from './mirror.js';

/** 会话生命周期被工作区策略挡下时抛这个。 */
export class WorkspaceViolation extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'WorkspaceViolation';
    this.code = 'WORKSPACE_VIOLATION';
    Object.assign(this, detail);
  }
}

/** 名字里命中这些的脚本，一律当成「可能藏着断点/内存改写」的可疑文件。 */
const SUSPICIOUS_FILE = /^(ocd\.cfg|openocd\.cfg|gdb.*\.tcl|.*\.gdb|bp.*\.(cfg|tcl)|init.*\.(cfg|tcl)|debug.*\.(cfg|tcl)|openocd\.log|ocd_try\.(out|err))$/i;

/**
 * 文件内容里命中这些的，说明它真的在下断点或写内存。
 *
 * 为什么写 flash 那条要这么长：第一版用的是 `/^\s*(flash\s+)?write(_image|_bank)?\b/im`，
 * 结果把插件自己生成的 `serial-host.ps1` 判成了污染 —— 因为 `-m` 开了逐行匹配，
 * PowerShell 的 `Write-Output` 被 `^write\b` 命中（`e` 和 `-` 之间是词边界）。
 * 一个裸的 `write` 太泛了：它是几乎所有语言的动词。
 * 现在要求出现**带参数的 openocd 写命令**，并且 `write` 后面必须直接跟地址或文件名。
 */
const SUSPICIOUS_CONTENT = [
  { re: /^\s*(\w+\.)?bp\s+/im, why: '含有 `bp` 下断点语句' },
  { re: /^\s*rbp\s+/im, why: '含有 `rbp`（清理用，说明有人手动补救过）' },
  { re: /^\s*wp\s+|^\s*rwp\s+/im, why: '含有 watchpoint 语句' },
  { re: /^\s*(flash\s+)?write(?:_image|_bank)?\s+(\{|[0-9.$"'\w]|0x)/im, why: '含有写 flash 语句' },
  { re: /^\s*load_image\s+/im, why: '含有 `load_image`（会把当前内存状态写进目标）' },
  { re: /^\s*mww?\s+0x/im, why: '含有写内存语句' },
  { re: /gdb_breakpoint_override|breakpoint\s+override/im, why: '改过断点实现方式' },
];

/**
 * 插件自己生成、放在私有运行区里的基础设施文件 —— 不是会话产物，不该按残留物审。
 * 现在只有串口宿主脚本（它被复制到 `.run/` 是因为 PS 5.1 的 `-File` 在含中文的
 * 路径上会失败，必须换到一个 ASCII 路径去执行）。名单刻意写死而不是按前缀放行：
 * 放行范围越小，将来出问题时越容易被发现。
 */
const SELF_GENERATED = new Set(['serial-host.ps1', 'cleanup.ps1']);

/** 规格化路径用于比较：绝对化、去掉尾部 `\`、统一小写（Windows 大小写不敏感）。 */
function canon(p) {
  if (!p) return '';
  let s = resolve(p);
  while (s.length > 3 && (s.endsWith(sep) || s.endsWith('/'))) s = s.slice(0, -1);
  return s.toLowerCase();
}

/** `child` 是否等于 `parent` 或在其内部。 */
export function isInside(child, parent) {
  const c = canon(child);
  const p = canon(parent);
  if (!c || !p) return false;
  if (c === p) return true;
  return c.startsWith(p + sep) || c.startsWith(p + '/');
}

/**
 * **执行前的门禁**。openocd 进程的 CWD 必须落在私有运行区里。
 * 这不是「建议」——不满足就抛，调用方没有绕过路径。
 */
export function assertPrivateWorkdir(cwd) {
  const privateRoot = runRoot();
  if (!privateRoot) {
    throw new WorkspaceViolation('解析不到插件根目录，无法确定私有运行区；拒绝启动 openocd。');
  }
  if (!existsSync(privateRoot)) {
    mkdirSync(privateRoot, { recursive: true });
  }
  if (!cwd || !isInside(cwd, privateRoot)) {
    throw new WorkspaceViolation(
      `拒绝以 ${cwd ?? '(空)'} 作为 openocd 工作目录：它不在私有运行区 ${privateRoot} 内。` +
        '外部工作区可能带 openocd 的隐式配置（ocd.cfg）或上一轮残留的断点脚本，会把这次会话带偏。',
      { cwd, privateRoot },
    );
  }
  return cwd;
}

/**
 * 禁入名单：IDE 原件树、本插件的 openocd 副本体、以及副本的 ASCII 镜像。
 *
 * 三条各自的理由：
 * - **IDE 原件树**（`C:\Users\lishuo\.eide`）：出厂自带 `openocd.exe` 与 `scripts\`，
 *   一旦被当工作区用过、或被人往里写东西，污染会跨插件传播。
 * - **副本体**：副本被写脏 = 本插件所有会话一起中毒。
 * - **镜像**（junction 指向副本；若是真实复制则是一份独立拷贝）：同理，它是执行入口，
 *   不是工作区。
 */
export function forbiddenRoots({ ideRoot, mounriverRoot, vendorRoot, mirrorRoot } = {}) {
  const ide = ideRoot ?? mounriverRoot ?? eideRoot();
  const vendor = vendorRoot ?? vendorOpenocdRoot();
  let mirror = mirrorRoot ?? null;
  if (!mirror) {
    try {
      mirror = asciiOpenocdRoot();
    } catch {
      mirror = null;
    }
  }
  return [
    ide && { path: ide, why: 'IDE（EIDE/VSCode）工具树 —— 里面的 openocd 是原件，我们只读它' },
    vendor && { path: vendor, why: '本插件的 OpenOCD 隔离副本（一旦被写脏，所有会话一起中毒）' },
    mirror && { path: mirror, why: '副本的 ASCII 镜像（执行入口，不是工作区）' },
  ].filter(Boolean);
}

/**
 * 检查一个目录能不能安全使用。返回 `{ok, reason}`，不抛 —— 给审计报告用。
 */
export function inspectWorkdir(cwd, opts = {}) {
  const privateRoot = runRoot();
  for (const f of forbiddenRoots(opts)) {
    if (isInside(cwd, f.path)) {
      return { ok: false, reason: `在禁入名单内：${f.why}`, cwd, matchedRoot: f.path };
    }
  }
  if (privateRoot && isInside(cwd, privateRoot)) return { ok: true, reason: '私有运行区', cwd };
  return { ok: false, reason: `在私有运行区之外（${privateRoot}）`, cwd, privateRoot };
}

// ------------------------------------------------------------- 会话目录

let seq = 0;

/** 生成一个可读的会话 id：`<target>-<UTC 时间戳>-<序号><随机>`。 */
export function newSessionId(target = 'mcu', now = new Date()) {
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const rand = Math.random().toString(36).slice(2, 5);
  seq = (seq + 1) % 1000;
  return `${String(target).toLowerCase()}-${ts}-${String(seq).padStart(3, '0')}${rand}`;
}

/** 创建（并返回）一个私有会话目录。 */
export function makeSessionDir(id) {
  const root = runRoot();
  if (!root) throw new WorkspaceViolation('解析不到插件根目录，无法创建私有会话目录。');
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  assertPrivateWorkdir(dir);
  return dir;
}

/** 列出私有运行区里现存的会话目录及大小。 */
export function listSessionDirs({ maxAgeHours } = {}) {
  const root = runRoot();
  if (!root || !existsSync(root)) return [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  const now = Date.now();
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(root, e.name);
    if (e.name === '_quarantine') continue;
    let files = [];
    let bytes = 0;
    let mtime = 0;
    try {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (!f.isFile()) continue;
        const p = join(dir, f.name);
        const st = statSync(p);
        files.push({ name: f.name, bytes: st.size, mtime: st.mtime.toISOString() });
        bytes += st.size;
        mtime = Math.max(mtime, st.mtimeMs);
      }
    } catch {
      /* 忽略 */
    }
    const ageHours = mtime ? (now - mtime) / 3600000 : Infinity;
    out.push({
      id: e.name,
      dir,
      files,
      bytes,
      ageHours: Number.isFinite(ageHours) ? Number(ageHours.toFixed(2)) : null,
      stale: Number.isFinite(maxAgeHours) ? ageHours > maxAgeHours : false,
    });
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}

/** 删掉一个会话目录（幂等）。 */
export function removeSessionDir(dir) {
  if (!dir) return { ok: false, message: '没有给出目录' };
  if (!isInside(dir, runRoot())) {
    return { ok: false, message: `拒绝删除 ${dir}：不在私有运行区内。` };
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, message: `已删除 ${dir}` };
  } catch (error) {
    return { ok: false, message: `删除失败：${String(error?.message ?? error)}` };
  }
}

/** 清理超过 `maxAgeHours` 的陈旧会话目录。 */
export function pruneSessionDirs({ maxAgeHours = 24 } = {}) {
  const removed = [];
  for (const s of listSessionDirs({ maxAgeHours })) {
    if (s.stale) {
      const r = removeSessionDir(s.dir);
      removed.push({ id: s.id, ...r });
    }
  }
  return removed;
}

// ------------------------------------------------------------- 断点清理常量

/**
 * ## ⛔ 这里曾经有一个 `renderSessionCfg()`，被**故意删掉**了
 *
 * 它生成的是这种 cfg：
 *
 * ```tcl
 * source {C:/…/插件开发/dsh-wch-debug/vendor/openocd/bin/wch-riscv.cfg}
 * adapter speed 6000
 * ```
 *
 * 在本机**必然失败**。实测（OpenOCD 0.11.0+dev-snapshot，Windows）：
 *
 * ```
 * session.cfg:6: Error: couldn't read file "C:/…/DSH_Project/鎻掍欢寮€鍙?dsh-wch-debug/vendor/openocd/bin/wch-riscv.cfg": No such file or directory
 * ```
 *
 * 路径里的 `插件开发` 被按系统 ANSI 代码页（GBK）解释成了 `鎻掍欢寮€鍙?`。
 * Jim-TCL 从**文件内容**里取到的路径走窄字符 `fopen`，非 ASCII 必然乱码；
 * 而 `-f` 走的是 Windows 宽字符 argv，同一路径完全正常。
 *
 * **结论（别再改回去）**：cfg 一律用 `-f` 由 argv 传，永不在文件里 `source` 路径。
 * 会话目录里那份 `session-record.txt` 只是给人看的抄本，不喂给 openocd。
 * 详见 `lib/ocd.js` 的 `buildArgs()` 与 `renderSessionRecordText()`。
 */

/**
 * 逐个清软件断点的 TCL。
 *
 * ## 为什么是「逐个」而不是 `rbp all`
 *
 * `rbp all` 流传很广，但未在 OpenOCD 0.11 手册中确认；手册确认过的是
 * 「`bp` 不带参返回全部断点号」+「`rbp <num>` 删指定断点」。逐个删才是可复现的。
 *
 * ## 为什么这件事值得写成一个常量
 *
 * 软件断点在 **flash 上是改指令字节**实现的（RISC-V 上是 `ebreak`），
 * 只有 `rbp` 时才写回原指令。会话异常终止、或清理没做完就断开，
 * 断点残值会随镜像一起被编程进 flash —— 之后每一次烧录都会带上它，
 * 表现为「烧好的单片机一上电就停在原地，永远进不了 main」。
 * 用户就是因为踩过这个坑才要求把 openocd 完全隔离出来。
 *
 * 外面套 `catch`：目标在跑时 `rbp` 本就会报 `Target not halted`，
 * 这是**无害的清理失败**，不该把会话判成失败。
 */
export const RBP_ALL = 'catch {foreach a [bp] { rbp $a }}';

/** 逐条清数据/访问断点。只动 DM 寄存器、不碰 flash，属可选卫生。 */
export const RWP_ALL = 'catch {foreach w [wp] { rwp $w }}';

/** 把内容写进会话目录，返回路径。 */
export function writeSessionFile(dir, name, content) {
  assertPrivateWorkdir(dir);
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

// ------------------------------------------------------------- 审计

/**
 * 扫一个目录，找出「可能污染 openocd 会话」的文件。
 *
 * @returns {{dir:string, exists:boolean, files:object[], suspicious:object[], leaks:string[]}}
 */
export function scanWorkspace(dir) {
  // `existsSync(undefined)` 在新版 Node 会打 DEP0187 警告，先挡掉
  const out = { dir, exists: Boolean(dir) && existsSync(dir), files: [], suspicious: [], leaks: [] };
  if (!out.exists) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    out.error = String(error?.message ?? error);
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.files.push({ name: e.name, type: 'dir' });
      continue;
    }
    let size = 0;
    let text = '';
    try {
      size = statSync(p).size;
      // 只读 256KB，防手滑读巨型日志
      if (size <= 256 * 1024) text = readFileSync(p, 'utf8');
    } catch {
      /* 忽略 */
    }
    out.files.push({ name: e.name, type: 'file', bytes: size });
    // 插件自己生成的宿主脚本不是残留物 —— 跳过判定，但仍在 files 里列出来（保持透明）。
    if (SELF_GENERATED.has(e.name)) continue;
    const why = [];
    if (SUSPICIOUS_FILE.test(e.name)) why.push('文件名像 openocd 隐式配置或调试脚本');
    for (const c of SUSPICIOUS_CONTENT) {
      if (c.re.test(text)) why.push(c.why);
    }
    if (why.length) out.suspicious.push({ name: e.name, path: p, bytes: size, why, preview: firstLines(text, 4) });
  }

  // 泄漏检查：cfg 里是否写着 vendor/IDE 的路径（说明它被当工作区用过）
  for (const f of out.suspicious) {
    if (/MounRiver|\.eide[\\/]tools[\\/]openocd|components[\\/]WCH[\\/]OpenOCD/i.test(f.preview)) {
      out.leaks.push(`${f.name} 里引用了 IDE 原件路径 —— 这份脚本是从别处抄来的，别 source 它。`);
    }
  }
  return out;
}

function firstLines(text, n) {
  return String(text || '').split(/\r?\n/).slice(0, n).join('\n');
}

/**
 * 全量卫生审计：私有运行区 + 隔离副本 bin + IDE 原件 bin。
 * 只读。
 */
export function auditWorkspace({ ideRoot, mounriverRoot, vendorRoot } = {}) {
  const vRoot = vendorRoot ?? vendorOpenocdRoot();
  const report = {
    privateRoot: runRoot(),
    pluginRoot: pluginRoot(),
    privateRun: null,
    vendorBin: null,
    ideBins: [],
    findings: [],
  };

  const priv = runRoot();
  if (priv) {
    report.privateRun = scanWorkspace(priv);
    for (const s of report.privateRun.suspicious) {
      report.findings.push({
        severity: 'P1',
        where: s.path,
        what: s.why.join('；'),
        fix: 'mcu_clean(action:"prune") 清陈旧会话，或直接删掉这个文件。',
      });
    }
  }

  const vBin = vRoot ? join(vRoot, 'bin') : null;
  if (vBin && existsSync(vBin)) {
    report.vendorBin = scanWorkspace(vBin);
    for (const s of report.vendorBin.suspicious) {
      const isShipped = /^ocd\.cfg$|^ocd_try\./i.test(s.name);
      report.findings.push({
        severity: isShipped ? 'P1' : 'P2',
        where: s.path,
        what: `${s.why.join('；')}${isShipped ? '（这是上游 openocd 出厂自带的文件，不是谁写坏的）' : ''}`,
        fix: isShipped
          ? 'mcu_clean(action:"quarantine") 把它挪进 .run\\_quarantine\\，隐式 source 就失效了。'
          : '确认没用就删掉。',
      });
    }
  }

  const ideRoot_ = ideRoot ?? mounriverRoot ?? eideRoot();
  if (ideRoot_ && existsSync(ideRoot_)) {
    const bins = [];
    const walk = (dir, depth) => {
      if (depth > 9 || bins.length > 8) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name === 'bin') {
          const cand = join(dir, e.name);
          try {
            if (readdirSync(cand).some((n) => /^openocd\.exe$/i.test(n))) bins.push(cand);
          } catch {
            /* 忽略 */
          }
        }
        if (/^(node_modules|\.git)$/i.test(e.name)) continue;
        walk(join(dir, e.name), depth + 1);
      }
    };
    walk(ideRoot_, 0);
    for (const b of bins) {
      const scan = scanWorkspace(b);
      report.ideBins.push(scan);
      for (const s of scan.suspicious) {
        report.findings.push({
          severity: 'P1',
          where: s.path,
          what: `**IDE 原件区**：${s.why.join('；')}。任何以该目录为 CWD 且不给 -f 的 openocd 启动都会被它带偏。`,
          fix: '不要以该目录为工作区；本插件已强制私有 CWD。若确有残留，建议原地重命名为 *.bak（改 IDE 树前先确认不影响 IDE 本身）。',
        });
      }
    }
  }

  report.summary = {
    findings: report.findings.length,
    p1: report.findings.filter((f) => f.severity === 'P1').length,
    p2: report.findings.filter((f) => f.severity === 'P2').length,
  };
  return report;
}

/**
 * 把指定文件挪进 `.run\_quarantine\<时间戳>\`。
 * 只挪 **隔离副本** 与 **私有运行区** 里的文件；不碰 IDE 原件树（那是 IDE 的资源）。
 */
export function quarantineFiles(paths, { stamp = new Date().toISOString().replace(/[:.]/g, '-') } = {}) {
  const root = runRoot();
  if (!root) return { ok: false, message: '解析不到私有运行区' };
  const dest = join(root, '_quarantine', stamp);
  const results = [];
  const vRoot = vendorOpenocdRoot();
  for (const p of paths) {
    const allowed = isInside(p, runRoot()) || isInside(p, vRoot);
    if (!allowed) {
      results.push({ path: p, ok: false, message: '不在隔离副本或私有运行区内，拒绝移动。' });
      continue;
    }
    if (!existsSync(p)) {
      results.push({ path: p, ok: false, message: '文件不存在' });
      continue;
    }
    try {
      mkdirSync(dest, { recursive: true });
      const target = join(dest, `${basename(p)}`);
      renameSync(p, target);
      results.push({ path: p, ok: true, movedTo: target });
    } catch (error) {
      // 跨卷 rename 会失败：退回「原地改名 + 留说明」
      try {
        const bak = `${p}.quarantined-${stamp}`;
        renameSync(p, bak);
        results.push({ path: p, ok: true, movedTo: bak, note: '目录不可跨卷移动，已原地改名' });
      } catch (error2) {
        results.push({ path: p, ok: false, message: String(error2?.message ?? error2) });
      }
    }
  }
  return { ok: true, quarantineDir: dest, results };
}

/**
 * 给所有工具共用的「卫生收尾」命令序列。
 *
 * ⚠️ 这里的每一项都必须是幂等且**不会因为目标状态而失败**的：
 * 收尾命令跑在会话最后，它报错会把「本来成功的烧录」判成失败，
 * 而真正的问题（断点没清）反倒被淹没。
 */
export function hygieneFooter({ clearBreakpoints = true, resume = false } = {}) {
  const cmds = [];
  if (clearBreakpoints) cmds.push(RBP_ALL);
  if (resume) cmds.push('reset run');
  return cmds;
}

/** 报告里展示相对路径。 */
export function shortPath(p) {
  const r = runRoot();
  if (r && isInside(p, r)) return `.run\\${relative(r, p)}`;
  const pl = pluginRoot();
  if (pl && isInside(p, pl)) return relative(pl, p);
  return p;
}

/** 判断一个路径是否绝对且存在，报告里统一用。 */
export function plainExists(p) {
  if (!p) return false;
  try {
    return existsSync(isAbsolute(p) ? p : resolve(p));
  } catch {
    return false;
  }
}

