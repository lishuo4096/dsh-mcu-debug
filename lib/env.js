/**
 * 路径解析与环境探测。
 *
 * ## 本插件对「环境」的三条立场
 *
 * 1. **只认自己的 OpenOCD 副本**。`vendor/openocd/` 是插件的私有资产，随包分发。
 *    IDE（EIDE / VSCode）那套 `openocd.exe` 只被**枚举出来给用户看**，永远不执行 ——
 *    历史事故就是「借 IDE 的 openocd 用一次」，用完没清现场，之后所有烧录都带断点。
 * 2. **探测要分得清是哪一个探针**。本机同时插着 CMSIS-DAPLink、WCH-Link 和两片 FTDI，
 *    openocd 不带 `adapter serial` 时会「挑第一个能用的」，于是你以为在烧 PY32，
 *    实际在跟 WCH-Link 说话。所有探针信息都必须带 VID/PID + 序列号。
 * 3. **PowerShell 只用来「看」**。枚举 USB、查进程、查串口都走 PowerShell，
 *    但一律经 `-EncodedCommand`（UTF-16LE base64）传入，绕开中文参数与引号转义这两个
 *    老大难；结果统一走 JSON，不让文本解析去猜。
 *
 * @module lib/env
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureMirror, mirrorStatus, sourceOpenocdRoot, hasNonAscii } from './mirror.js';

/** 本模块所在目录（`…/lib`）。 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** 包根目录（`…/dsh-mcu-debug`）。 */
export function pluginRoot() {
  return resolve(HERE, '..');
}

/**
 * 隔离副本的 OpenOCD 根目录。
 *
 * 可用环境变量 `DSH_MCU_OPENOCD_ROOT` 覆盖（指向另一份完整 openocd 安装树），
 * 但**不接受**指向 IDE 原件 —— 那是本插件存在的理由。
 */
export function vendorOpenocdRoot(override) {
  const env = process.env.DSH_MCU_OPENOCD_ROOT;
  const p = override ?? (env && env.trim() ? env.trim() : join(pluginRoot(), 'vendor', 'openocd'));
  return p ? resolve(p) : null;
}

/** 副本的**真源**位置：永远在插件里，两份（真源 / 镜像）中唯一的那份资产。 */
export function vendorOpenocdSource() {
  return sourceOpenocdRoot();
}

/**
 * **执行时**实际使用的 openocd 根。
 *
 * 与 `vendorOpenocdRoot()`（真源，用于探测与禁入判定）分开，是因为
 * OpenOCD 的 Jim-TCL 有 GBK 路径病：`[find target/py32f030.cfg]` 这类
 * **脚本内部**发起的路径拼接走窄字符 `fopen`，搜索目录含中文必炸。
 * 所以执行时优先走 `%LOCALAPPDATA%\dsh-mcu-debug\openocd` 这个 ASCII 镜像
 * （NTFS junction 指向真源，零拷贝）。详见 `lib/mirror.js`。
 *
 * @returns `{root, kind, created, note}`
 */
export function execOpenocdRoot(override) {
  const forced = override ?? (process.env.DSH_MCU_OPENOCD_ROOT && process.env.DSH_MCU_OPENOCD_ROOT.trim()) ?? null;
  if (forced) {
    return { root: resolve(forced), kind: 'direct', created: false, note: '由 override / DSH_MCU_OPENOCD_ROOT 指定，跳过镜像。' };
  }
  return ensureMirror();
}

/** 私有运行区（会话目录的父目录）。openocd 的 CWD 只能落在这里面。 */
export function runRoot() {
  return join(pluginRoot(), '.run');
}

/** Windows 反斜杠 → 正斜杠。openocd 的 `-c` 里出现反斜杠会被 TCL 当转义符吃掉。 */
export function toSlash(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

/** 相对化（仅用于报告展示）。 */
export function relTo(base, p) {
  if (!base || !p) return p;
  try {
    const r = relative(base, p);
    return r && !r.startsWith('..') ? r : p;
  } catch {
    return p;
  }
}

// ------------------------------------------------------------- EIDE / IDE 侧（只读）

/** EIDE 的本地工具根：`%USERPROFILE%\.eide`。 */
export function eideRoot() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return home ? join(home, '.eide') : null;
}

/**
 * 枚举 EIDE 装过的 OpenOCD（**只用于展示与版本对照，永不被本插件执行**）。
 *
 * @returns `[{root, exe, version, hasPy32, hasStm32, sizeMb}]`
 */
export function listIdeOpenocds() {
  const tools = eideRoot() ? join(eideRoot(), 'tools') : null;
  if (!tools || !existsSync(tools)) return [];
  const out = [];
  let entries;
  try {
    entries = readdirSync(tools, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    if (!e.isDirectory() || !/openocd/i.test(e.name)) continue;
    const root = join(tools, e.name);
    const exe = join(root, 'bin', 'openocd.exe');
    // 有的打包形态是 share/openocd/scripts，有的是 scripts
    const scriptsA = join(root, 'share', 'openocd', 'scripts');
    const scriptsB = join(root, 'scripts');
    const scripts = existsSync(scriptsA) ? scriptsA : existsSync(scriptsB) ? scriptsB : null;
    if (!existsSync(exe)) continue;
    out.push({
      root,
      exe,
      scripts,
      version: ideOpenocdVersion(exe),
      hasPy32: Boolean(scripts && existsSync(join(scripts, 'target', 'py32f030.cfg'))),
      hasStm32: Boolean(scripts && existsSync(join(scripts, 'target', 'stm32f1x.cfg'))),
    });
  }
  return out;
}

function ideOpenocdVersion(exe) {
  try {
    const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const m = /Open On-Chip Debugger\s+(\S+)/i.exec(`${r.stdout ?? ''}${r.stderr ?? ''}`);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * 找 ARM 工具链（gcc / gdb / objcopy / objdump）。
 *
 * 优先 PATH，其次 EIDE 自带的 `tools/gcc_arm/bin`（本机实测就是这个位置）。
 */
export function findToolchains() {
  const wanted = ['arm-none-eabi-gcc', 'arm-none-eabi-gdb', 'arm-none-eabi-objcopy', 'arm-none-eabi-objdump'];
  const found = {};
  for (const w of wanted) found[w] = pickTool(w);

  const eide = eideRoot() ? join(eideRoot(), 'tools', 'gcc_arm', 'bin') : null;
  if (eide && existsSync(eide)) {
    for (const w of wanted) {
      if (found[w]) continue;
      const exe = join(eide, `${w}.exe`);
      if (existsSync(exe)) found[w] = exe;
    }
  }
  // 其它常见安装点（Arm GNU Toolchain 官方安装器 / MSYS2 / xPack）
  const extraRoots = [
    'C:\\Program Files (x86)\\Arm GNU Toolchain arm-none-eabi',
    'C:\\Program Files\\Arm GNU Toolchain arm-none-eabi',
    join(process.env.LOCALAPPDATA ?? '', 'xPacks', '@xpack-dev-tools'),
  ].filter((p) => p && existsSync(p));
  for (const root of extraRoots) {
    for (const w of wanted) {
      if (found[w]) continue;
      const hit = findDeep(root, `${w}.exe`, 5);
      if (hit) found[w] = hit;
    }
  }
  return {
    gcc: found['arm-none-eabi-gcc'] ?? null,
    gdb: found['arm-none-eabi-gdb'] ?? null,
    objcopy: found['arm-none-eabi-objcopy'] ?? null,
    objdump: found['arm-none-eabi-objdump'] ?? null,
    present: Boolean(found['arm-none-eabi-gcc']),
  };
}

function findDeep(root, name, maxDepth, depth = 0) {
  if (depth > maxDepth) return null;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return join(root, e.name);
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (/^(node_modules|\.git)$/i.test(e.name)) continue;
    const hit = findDeep(join(root, e.name), name, maxDepth, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** 在 PATH 与若干常见位置找一个可执行文件。 */
export function pickTool(name) {
  const exts = ['.exe', '.cmd', '.bat', ''];
  const dirs = (process.env.PATH ?? '').split(';').filter(Boolean);
  for (const d of dirs) {
    for (const ext of exts) {
      const p = join(d, name + ext);
      try {
        if (existsSync(p) && statSync(p).isFile()) return p;
      } catch {
        /* 跳过不可访问的 PATH 项 */
      }
    }
  }
  return null;
}

// ------------------------------------------------------------- 执行辅助

/**
 * 跑一个进程并回读文本。
 *
 * @returns `{ok, code, stdout, stderr, error}`
 */
export function tryExec(cmd, args = [], opts = {}) {
  try {
    const r = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 30000,
      windowsHide: true,
      maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
      cwd: opts.cwd,
      env: opts.env ?? process.env,
    });
    return {
      ok: !r.error && r.status === 0,
      code: r.status,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      error: r.error ? String(r.error.message ?? r.error) : null,
    };
  } catch (error) {
    return { ok: false, code: null, stdout: '', stderr: '', error: String(error?.message ?? error) };
  }
}

/** 找到可用的 PowerShell（优先 pwsh 7，回退系统自带 5.1）。 */
let cachedPs = null;
export function powershellExe() {
  if (cachedPs) return cachedPs;
  cachedPs = pickTool('pwsh') ?? pickTool('powershell') ?? 'powershell.exe';
  return cachedPs;
}

/**
 * 跑一段 PowerShell 脚本，把它的 stdout 当 **JSON** 解析。
 *
 * 为什么走 `-EncodedCommand`：脚本里必然有中文（设备名、路径）和引号，
 * 走 `-Command` 会被 Node → cmd → PowerShell 三层转义反复洗礼；
 * `-EncodedCommand` 收 UTF-16LE base64，**零转义**，中文也不经过 ANSI 代码页。
 *
 * 约定：脚本只需把对象 `ConvertTo-Json -Depth 8 -Compress` 输出即可。
 * 单个对象与数组都会被规整成数组（`asArray`）。
 */
export function psJson(script, opts = {}) {
  const body = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$ErrorActionPreference = "Stop"',
    '$ProgressPreference = "SilentlyContinue"',
    script,
  ].join('\n');
  const encoded = Buffer.from(body, 'utf16le').toString('base64');
  const r = tryExec(powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    timeoutMs: opts.timeoutMs ?? 40000,
  });
  const text = (r.stdout || '').trim();
  if (!text) {
    return { ok: false, rows: [], error: r.error ?? (r.stderr || '').trim() ?? 'PowerShell 无输出' };
  }
  try {
    const parsed = JSON.parse(text);
    return { ok: true, rows: asArray(parsed), raw: parsed };
  } catch (error) {
    return { ok: false, rows: [], error: `JSON 解析失败：${String(error?.message ?? error)}`, text: text.slice(0, 800) };
  }
}

/** 单对象 / null 都规整成数组，调用方不必分情况。 */
export function asArray(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** 跑一段 PowerShell 脚本，回读纯文本。 */
export function psText(script, opts = {}) {
  const body = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$ErrorActionPreference = "SilentlyContinue"',
    '$ProgressPreference = "SilentlyContinue"',
    script,
  ].join('\n');
  const encoded = Buffer.from(body, 'utf16le').toString('base64');
  const r = tryExec(powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    timeoutMs: opts.timeoutMs ?? 30000,
  });
  return { ok: r.ok, text: (r.stdout ?? '').trim(), error: r.error ?? (r.stderr ?? '').trim() };
}

// ------------------------------------------------------------- 进程与端口

/**
 * 列出正在跑的 openocd 进程。
 *
 * 这是「用了没清现场」最直接的症状：上一轮的 openocd 还占着探针，
 * 下一轮 openocd 连不上，报出来的却是 `No CMSIS-DAP device found` 之类的
 * 误导性错误。每次写操作前都该看一眼。
 */
export function listOpenocdProcesses() {
  const r = psJson(
    'Get-CimInstance Win32_Process -Filter "Name=\'openocd.exe\'" | ' +
      'Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Depth 4 -Compress',
  );
  if (!r.ok) return [];
  return r.rows
    .map((p) => ({
      pid: Number(p.ProcessId),
      ppid: p.ParentProcessId === undefined ? null : Number(p.ParentProcessId),
      startedAt: p.CreationDate ? String(p.CreationDate) : null,
      commandLine: p.CommandLine ?? '',
    }))
    .filter((p) => Number.isFinite(p.pid));
}

/** 结束一个进程（尽力而为，返回是否成功）。 */
export function killProcess(pid, { force = true } = {}) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, message: `非法 pid：${pid}` };
  const script = `Stop-Process -Id ${n} ${force ? '-Force' : ''} -ErrorAction Stop; 'ok'`;
  const r = psText(script);
  return r.ok ? { ok: true, message: `已结束 PID ${n}` } : { ok: false, message: r.error || '结束失败' };
}

/**
 * 查哪些进程占着给定端口（openocd 默认 telnet 4444 / gdb 3333）。
 * `ports` 省略时查这五个常用端口。
 */
export function portOwners(ports = [4444, 3333, 3334, 6666, 50001]) {
  const list = ports.map((p) => Number(p)).filter(Number.isFinite);
  if (list.length === 0) return [];
  const filter = list.map((p) => `LocalPort=${p}`).join(' or ');
  const r = psJson(
    `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { ${filter} } | ` +
      'Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Depth 3 -Compress',
  );
  if (!r.ok) return [];
  return r.rows.map((c) => ({
    address: `${c.LocalAddress}:${c.LocalPort}`,
    port: Number(c.LocalPort),
    pid: Number(c.OwningProcess),
  }));
}

// ------------------------------------------------------------- 汇总

/**
 * 一次把「本机能不能干活」全看一遍。
 * 只读，不改任何东西。
 */
export function probeEnvironment() {
  const root = pluginRoot();
  const vRoot = vendorOpenocdSource();
  const vExe = vRoot ? join(vRoot, 'bin', 'openocd.exe') : null;
  const vScripts = vRoot
    ? [join(vRoot, 'share', 'openocd', 'scripts'), join(vRoot, 'scripts')].find((d) => existsSync(d)) ?? null
    : null;
  const warnings = [];

  const vendor = {
    root: vRoot,
    exe: vExe,
    present: Boolean(vExe && existsSync(vExe)),
    scripts: vScripts,
    version: vExe && existsSync(vExe) ? ideOpenocdVersion(vExe) : null,
    hasPy32: Boolean(vScripts && existsSync(join(vScripts, 'target', 'py32f030.cfg'))),
    hasStm32: Boolean(vScripts && existsSync(join(vScripts, 'target', 'stm32f1x.cfg'))),
    bytes: vExe && existsSync(vExe) ? statSync(vExe).size : 0,
  };
  if (!vendor.present) {
    warnings.push(`隔离副本缺失：${vExe ?? '(解析不到插件根)'}。插件无法工作，请把 openocd 树放回 vendor/openocd/。`);
  }
  if (vendor.present && !vendor.hasPy32) {
    warnings.push('副本里没有 target/py32f030.cfg —— PY32 无法调试。需要 0.12.0 及以上的 openocd 脚本库。');
  }

  const ide = listIdeOpenocds();
  const idePy32 = ide.filter((o) => o.hasPy32);
  if (vendor.present && idePy32.length === 0) {
    warnings.push('IDE 侧也没发现带 PY32 脚本的 openocd；若以后要升级副本，没有可对照的源。');
  }

  const toolchain = findToolchains();
  if (!toolchain.gcc) {
    warnings.push('没找到 arm-none-eabi-gcc —— 不能编译，但烧录/调试不受影响（本插件只做调试侧）。');
  }
  if (!toolchain.gdb) {
    warnings.push('没找到 arm-none-eabi-gdb —— `mcu_gdb` 起不来；基础烧录/读回不受影响。');
  }

  const openocdProcesses = listOpenocdProcesses();
  if (openocdProcesses.length > 0) {
    warnings.push(
      `有 ${openocdProcesses.length} 个 openocd 进程还活着（PID ${openocdProcesses.map((p) => p.pid).join(', ')}）——` +
        '旧进程占着探针会让新会话连不上，也让「上次到底清没清断点」失去保证。',
    );
  }

  const envTrap = process.env.OPENOCD_SCRIPTS;
  if (envTrap) {
    warnings.push(
      `环境变量 OPENOCD_SCRIPTS=${envTrap} 会**优先于**副本自带脚本库（EIDE 装的）。` +
        '本插件在每次 spawn 前会把它从子进程环境里摘掉，但你自己手敲 openocd 时要当心。',
    );
  }

  const mirror = mirrorStatus();
  if (hasNonAscii(root) && mirror.needed && !mirror.usable) {
    warnings.push(
      `插件路径含非 ASCII 字符（${root}），而 ASCII 镜像尚未就绪（${mirror.reason}）——` +
        '首次执行 openocd 时会自动创建；若创建失败，`[find …]` 形式的脚本路径会因 GBK 解释而报「No such file or directory」。',
    );
  }

  return {
    pluginRoot: root,
    vendor,
    mirror,
    ide,
    toolchain,
    runRoot: runRoot(),
    openocdProcesses,
    powershell: powershellExe(),
    openocdScriptsEnv: envTrap ?? null,
    warnings,
  };
}

/** 判断一个路径是绝对路径（报告里统一用）。 */
export function isAbs(p) {
  return Boolean(p) && isAbsolute(p);
}

export { sep };
