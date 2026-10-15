/**
 * OpenOCD 执行与输出解析。
 *
 * ## 判据（哪只眼睛看结果）
 *
 * `openocd.exe` 的**退出码不可单独作为判据**。实测：`-c` 链里的命令失败时它打印
 * `Error: …`，但有时仍以 0 退出。所以判据是三层：
 *   1. 文本里出现 `^Error:` → 判**失败**（无论退出码）；
 *   2. 退出码 ≠ 0 且没有 `Error:` → 判失败，`reason` 标 `exit-code`；
 *   3. 两者都干净 → `ok: true`，并额外报出**正向证据**（`** Verified OK **` 之类）。
 * 报告里永远同时给出 `code`、命中的错误行原文、以及正向证据，不让调用方猜。
 *
 * ## 收尾纪律（比判据更重要）
 *
 * 会话关闭前必须做两件事，顺序不能反：
 *   1. `rbp` 逐个删断点（`catch` 包住）—— 目标在跑时 `rbp` 本就会报
 *      `Target not halted`，那是**无害的清理失败**，不该把会话判成失败。
 *   2. `reset run` —— 让核心**跑起来**再断开。只 halt 不 resume 就 shutdown，
 *      芯片停在调试态，现象与「烧完不跑」一模一样，极易被误判成烧录失败。
 *
 * 本插件把这两步做成**默认且不可省**的（`footer='run'`），并且把收尾命令写进
 * 返回值的 `footerCmds` —— 报告里必须能看见它真的跑过。
 *
 * ## cfg 加载（三条硬规矩）
 *
 * 1. 永远显式 `-s <scripts>` + `-f <接口 cfg> -f <目标 cfg>`，
 *    绝不依赖隐式 source —— 否则 CWD 里的 `ocd.cfg`（很多 IDE 出厂自带）
 *    会把会话顶成别的探针/transport。
 * 2. 永远**由 argv 传 cfg**，绝不在 cfg 文件里写 `source <绝对路径>` ——
 *    Jim-TCL 从文件里读出的非 ASCII 路径按 GBK 解释，必然乱码。
 * 3. 命令里禁止出现**双引号**（会被 `-c` 外层引号吃掉）和**反斜杠**
 *    （TCL 当转义符，`C:\a` 会变成 `C:a`）。
 *
 * ## 多探针
 *
 * 命令序列是**交错的**：`-f interface/…` → `-c "adapter serial …"` →
 * `-c "transport select swd"` → `-f target/…` → 业务命令。
 * 顺序错 = 等于没指定，所以这里不允许用「所有 cfg 在前、所有命令在后」的简化写法。
 *
 * @module lib/ocd
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { execOpenocdRoot, toSlash } from './env.js';
import { RBP_ALL, RWP_ALL, assertPrivateWorkdir, makeSessionDir, newSessionId, writeSessionFile } from './hygiene.js';

/** 默认适配器时钟（kHz）。PY32F030 的 cfg 里就是 `adapter speed 1000`。 */
export const DEFAULT_SPEED = 1000;

/**
 * 实测读速率（毫秒/字节）。
 *
 * CMSIS-DAP 走 HID 批量传输，SWD 读内存比 WCH 的 SDI 快一到两个数量级：
 * 实测 20–60 kB/s 量级。取 0.05 ms/B（=20 kB/s）作**保守**估算，
 * 用来算超时预算；宁可多等，也不要因为超时把一次正常的整片读判成失败。
 */
export const MS_PER_BYTE_READ = 0.05;

/** 读操作的超时：固定开销 + 按字节算，再留 2 倍余量。下限 30 s，上限 20 min。 */
export function readTimeoutFor(bytes, { fixed = 15000, safety = 2 } = {}) {
  const n = Number(bytes);
  const need = fixed + (Number.isFinite(n) && n > 0 ? n * MS_PER_BYTE_READ * safety : 0);
  return Math.max(30000, Math.min(1200000, Math.round(need)));
}

/** 各类操作的默认超时（毫秒）。 */
export const TIMEOUTS = {
  probe: 60000,
  read: 60000,
  flash: 600000,
  erase: 300000,
  reset: 60000,
  sessionBoot: 60000,
  quick: 30000,
};

/** openocd 能吃的固件格式。 */
export const IMAGE_EXT = new Set(['.elf', '.hex', '.bin', '.s19', '.srec']);

/** 清断点常量的**唯一定义**在 `hygiene.js`（那边有完整的机理解释）。 */
export { RBP_ALL, RWP_ALL };

/** 收尾模式。 */
export const FOOTERS = {
  /** 默认：清断点 → 让目标跑起来 → 断开。 */
  run: [RBP_ALL, 'reset run'],
  /** 清断点 → 停在调试态。给「我还要接着用 gdb/session 连」的流程。 */
  halt: [RBP_ALL, 'halt'],
  /** 什么都不做，只 shutdown。危险，只有明确知道自己在干什么才用。 */
  none: [],
};

// ------------------------------------------------------------- 路径

/** openocd 的脚本搜索目录（`scripts` 或 `share/openocd/scripts`）。 */
export function scriptsDir(root) {
  if (!root) return null;
  for (const rel of ['scripts', join('share', 'openocd', 'scripts')]) {
    const d = join(root, rel);
    if (existsSync(d)) return d;
  }
  return null;
}

/**
 * 解析出隔离副本的 exe 与搜索目录。
 *
 * **注意**：这里用的是 `execOpenocdRoot()` —— 可能落在 `%LOCALAPPDATA%` 的
 * ASCII 镜像上（junction），而不是插件里的 `vendor/`。原因见 `lib/mirror.js`。
 *
 * @returns `{root, exe, searchDirs, present, kind, mirrorNote}`
 */
export function locateOpenocd(vendorRootOverride) {
  const eff = execOpenocdRoot(vendorRootOverride);
  const root = eff.root;
  const exe = root ? join(root, 'bin', 'openocd.exe') : null;
  const sd = scriptsDir(root);
  return {
    root,
    exe,
    scriptsDir: sd,
    searchDirs: sd ? [sd] : [],
    present: Boolean(exe && existsSync(exe)),
    kind: eff.kind,
    mirrorNote: eff.note,
    created: eff.created,
  };
}

/**
 * 把器件表里的相对 cfg（`target/py32f030.cfg`）解析成绝对路径。
 * 也接受直接给的绝对路径（自定义 cfg）。
 */
export function resolveCfgPath(rel, vendorRootOverride) {
  if (!rel) return { rel: null, path: null, present: false, custom: false };
  const s = String(rel);
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/') || s.startsWith('\\\\')) {
    return { rel: s, path: s, present: existsSync(s), custom: true };
  }
  const eff = execOpenocdRoot(vendorRootOverride);
  const sd = scriptsDir(eff.root);
  const path = sd ? join(sd, s.replace(/^[\\/]+/, '')) : null;
  return { rel: s, path, present: Boolean(path && existsSync(path)), custom: false, scriptsDir: sd };
}

// ------------------------------------------------------------- 参数拼装

/**
 * 拼 openocd 命令行。
 *
 * ## 两种用法
 *
 * 1. **交错序列**（推荐，多探针必需）：`sequence: [{cfg}, {cmd}, {cfg}, …]`
 * 2. 老式：`cfgPath` / `cfgPaths` 全排在 `cmds` 前面
 *
 * ## 为什么 cfg 一律走 `-f` 而**不**走 `source`
 *
 * `-f` 走 Windows 宽字符 argv，非 ASCII 路径正常；而 cfg 文件里写的
 * `source {C:/…/插件开发/…}` 会被 Jim-TCL 按 GBK 解释成乱码。
 *
 * ## 为什么命令里禁双引号与反斜杠
 *
 * `-c` 已是一层引号，命令里再出现 `"` 会被外层吃掉；
 * `\` 在 TCL 里是转义引导符，`C:\Users\x\a.bin` 会被静默吃成 `C:Usersxa.bin`。
 * 两者都**直接抛错**，而不是交给 openocd 报天书。
 */
export function buildArgs({
  sequence = null,
  cfgPath,
  cfgPaths,
  cmds = [],
  searchDirs = [],
  debugLevel,
  logFile,
  footer = 'run',
  noFooter = false,
}) {
  const args = [];
  for (const d of searchDirs) args.push('-s', toSlash(d));
  if (logFile) args.push('-l', toSlash(logFile));
  if (Number.isFinite(debugLevel) && debugLevel > 0) args.push(`-d${Math.min(Math.floor(debugLevel), 3)}`);

  const pushCfg = (p) => {
    if (!p) throw new Error('buildArgs: cfg 路径为空');
    if (!existsSync(p) && !String(p).includes('/')) {
      // 相对名（靠 -s 解析）不做存在性检查，其余必须存在
    }
    args.push('-f', toSlash(p));
  };
  const pushCmd = (c) => {
    if (c === undefined || c === null || c === '') return;
    const s = String(c);
    if (s.includes('"')) throw new Error(`openocd 命令里不能包含双引号（会被 -c 的外层引号吃掉）：${s}`);
    if (s.includes('\\')) {
      const win = /[A-Za-z]:\\/.test(s);
      throw new Error(
        `${win ? 'openocd 命令里出现了 Windows 反斜杠路径' : 'openocd 命令里出现了反斜杠'}（TCL 会把它当转义符，路径会被静默改坏）。改用正斜杠：${toSlash(s)}`,
      );
    }
    if (/^\s*shutdown\s*$/.test(s)) return; // shutdown 由收尾统一负责
    args.push('-c', s);
  };

  if (sequence?.length) {
    for (const step of sequence) {
      if (!step) continue;
      if (step.cfg) pushCfg(step.cfg);
      else if (step.cmd !== undefined) pushCmd(step.cmd);
      else if (Array.isArray(step.raw)) args.push(...step.raw.map(String));
    }
  } else {
    const cs = [cfgPath, ...(cfgPaths ?? [])].filter(Boolean);
    if (cs.length === 0) throw new Error('buildArgs 至少要一个 cfg 路径（cfgPath / cfgPaths / sequence）');
    for (const c of cs) pushCfg(c);
    for (const c of cmds) pushCmd(c);
  }

  if (!noFooter) {
    for (const f of FOOTERS[footer] ?? FOOTERS.run) args.push('-c', f);
    args.push('-c', 'shutdown');
  }
  return args;
}

/**
 * 拼「接口 + 探针锁定 + transport + 目标」的交错序列。
 *
 * 这个顺序**不是风格问题**：openocd 按出现顺序处理 `-c`，
 * `adapter serial` 必须在适配器初始化之前生效，`transport select` 必须在
 * target cfg 里 `swd_newdap` 之前生效，否则等于没设。
 *
 * @param interfaceCfg 接口 cfg 的绝对路径（`scripts/interface/cmsis-dap.cfg`）
 * @param targetCfg    目标 cfg 的绝对路径（`scripts/target/py32f030.cfg`）
 * @param probeCmds    探针锁定命令（`adapter serial …` / `transport select …`）
 * @param targetCmds   目标 cfg **之后**的覆写（例如 `adapter speed 4000`）
 * @param cmds         业务命令（会在最前自动补 `init`/`halt`）
 */
export function buildSessionSequence({ interfaceCfg, targetCfg, probeCmds = [], targetCmds = [], cmds = [], preCmds = [] }) {
  const seq = [];
  if (interfaceCfg) seq.push({ cfg: interfaceCfg });
  for (const c of preCmds) seq.push({ cmd: c });
  for (const c of probeCmds) seq.push({ cmd: c });
  if (targetCfg) seq.push({ cfg: targetCfg });
  for (const c of targetCmds) seq.push({ cmd: c });
  for (const c of cmds) seq.push({ cmd: c });
  return seq;
}

/**
 * 会话记录文件（**不是**给 openocd 读的 cfg）。
 *
 * 故意落一份人能看的记录：这次到底用了哪个探针、哪个目标 cfg、完整 argv 是什么。
 * ⚠️ 头几行是给未来 agent 的警告 —— 别把它 `source` 进去。
 */
export function renderSessionRecordText({ interfaceCfg, targetCfg, probe, speed, argv, note }) {
  const s = Number.isFinite(speed) && speed > 0 ? speed : DEFAULT_SPEED;
  return [
    '# ============================================================',
    '# dsh-mcu-debug 会话记录（RECORD ONLY）',
    '# 这是「这次怎么跑的」的抄本，不是配置文件。不要 source 它，不要复制到别处，',
    '# 不要写进任何持久 cfg —— 会话目录随用随删，路径随时失效。',
    `# 探针  ：${probe ? `${probe.label} [${probe.vidpid}] serial=${probe.serial ?? '(无)'}` : '(未指定)'}`,
    `# 接口  ：${toSlash(interfaceCfg ?? '(无)')}`,
    `# 目标  ：${toSlash(targetCfg ?? '(无)')}`,
    `# 速度  ：${Math.floor(s)} kHz`,
    note ? `# 备注  ：${note}` : null,
    '# ------------------------------------------------------------',
    '# 实际命令行：',
    `# openocd ${(argv ?? []).join(' ')}`,
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

// ------------------------------------------------------------- 执行

/**
 * 跑一次 openocd。
 *
 * `workdir` **必须**是私有会话目录（不给就现建一个）。
 * `assertPrivateWorkdir()` 会把任何指向 IDE 树或副本体的路径挡住。
 */
export function runOpenocd({
  sequence,
  cfgPath,
  cfgPaths,
  cmds = [],
  workdir,
  vendorRoot,
  timeoutMs = TIMEOUTS.probe,
  speed,
  sessionId,
  label,
  env: envOverride,
  footer = 'run',
  noFooter = false,
  debugLevel,
  logFile,
  probe = null,
} = {}) {
  const loc = locateOpenocd(vendorRoot);
  if (!loc.present) {
    return fail('openocd-missing', `隔离副本里的 openocd.exe 不存在：${loc.exe ?? '(解析不到插件根)'}`, {
      workdir,
      mirrorNote: loc.mirrorNote,
    });
  }
  if (!sequence?.length && (!cfgPath || !existsSync(cfgPath))) {
    return fail('cfg-missing', `cfg 文件不存在：${cfgPath ?? '(未指定)'}`, { workdir });
  }

  let dir = workdir;
  if (!dir) dir = makeSessionDir(sessionId ?? newSessionId(label ?? 'oneshot'));
  assertPrivateWorkdir(dir);

  // 速度覆写走 -c（纯 ASCII 字面量），不写进任何 cfg 文件
  const speedCmds = [];
  if (Number.isFinite(speed) && speed > 0) speedCmds.push(`adapter speed ${Math.floor(speed)}`);

  const effectiveSequence = sequence?.length
    ? sequence.map((s) => (s.cmd === undefined && !s.cfg ? s : s))
    : null;

  const logPath = logFile ? (typeof logFile === 'string' ? logFile : join(dir, 'openocd.log')) : null;

  let argv;
  try {
    argv = buildArgs(
      effectiveSequence
        ? { sequence: effectiveSequence, searchDirs: loc.searchDirs, debugLevel, footer, noFooter, logFile: logPath }
        : { cfgPath, cfgPaths, cmds: [...speedCmds, ...cmds], searchDirs: loc.searchDirs, debugLevel, footer, noFooter, logFile: logPath },
    );
  } catch (error) {
    return fail('bad-cmd', String(error?.message ?? error), { workdir: dir, cfgPath });
  }

  // 落盘的名字刻意不叫 *.cfg：插件自己的「脏工作区扫描」会把目录里的 *.cfg 当污染上报
  const ifaceCfg = effectiveSequence?.find((s) => s.cfg && /interface[\\/]/i.test(s.cfg))?.cfg ?? cfgPath ?? null;
  const tgtCfg = effectiveSequence?.filter((s) => s.cfg && /target[\\/]/i.test(s.cfg)).pop()?.cfg ?? null;
  const recordPath = writeSessionFile(
    dir,
    'session-record.txt',
    renderSessionRecordText({ interfaceCfg: ifaceCfg, targetCfg: tgtCfg, probe, speed, argv, note: label }),
  );
  const meta = {
    label,
    interfaceCfg: toSlash(ifaceCfg ?? ''),
    targetCfg: toSlash(tgtCfg ?? ''),
    probe: probe ? { label: probe.label, vidpid: probe.vidpid, serial: probe.serial } : null,
    speed: speed ?? DEFAULT_SPEED,
    footer,
    argv,
    openocdRoot: toSlash(loc.root),
    openocdRootKind: loc.kind,
    startedAt: new Date().toISOString(),
  };
  writeSessionFile(dir, 'session.json', JSON.stringify(meta, null, 2));

  // 环境隔离：OPENOCD_SCRIPTS 被 IDE 指向它自己的脚本库，**优先于**我们的 -s，
  // 留着它会让 cfg 解析莫名失败且提示完全不指向这个变量。一律摘掉。
  const childEnv = { ...process.env, ...(envOverride ?? {}) };
  const droppedEnv = [];
  if (envOverride?.OPENOCD_SCRIPTS === undefined && childEnv.OPENOCD_SCRIPTS !== undefined) {
    droppedEnv.push(`OPENOCD_SCRIPTS=${childEnv.OPENOCD_SCRIPTS}`);
    delete childEnv.OPENOCD_SCRIPTS;
  }

  const started = Date.now();
  const r = spawnSync(loc.exe, argv, {
    cwd: dir,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: childEnv,
  });
  const durationMs = Date.now() - started;
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  // 默认不给 -l：openocd 一旦重定向日志，Error: 就不在捕获的 stdout/stderr 里，judge 会漏判。
  // 给了 -l 就必须读回来合并。
  let logText = '';
  if (logPath) {
    try {
      logText = readFileSync(logPath, 'utf8');
    } catch {
      /* 没生成就算了 */
    }
  }
  const combined = `${stdout}${stderr}`;
  const text = `${combined}${logText && !combined.includes(logText.trim().slice(0, 40)) ? `\n${logText}` : ''}`;
  const parsed = parseOcd(text);
  const verdict = judge({ code: r.status, parsed, spawnError: r.error });

  try {
    writeSessionFile(dir, 'openocd.txt', text);
  } catch {
    /* 写不下也不能改变结论 */
  }

  return {
    ok: verdict.ok,
    code: r.status,
    text,
    stdout,
    stderr,
    parsed,
    argv,
    workdir: dir,
    logFile: logPath ?? undefined,
    recordFile: recordPath,
    droppedEnv: droppedEnv.length ? droppedEnv : undefined,
    durationMs,
    reason: verdict.reason,
    verdict: verdict.detail,
    evidence: verdict.evidence,
    spawnError: r.error ? String(r.error.message ?? r.error) : undefined,
    timedOut: r.error && /ETIMEDOUT|timed? ?out/i.test(String(r.error.message ?? r.error)) ? true : undefined,
    openocdRoot: loc.root,
    openocdRootKind: loc.kind,
    mirrorNote: loc.mirrorNote,
    footer: noFooter ? null : footer,
    footerCmds: noFooter ? [] : (FOOTERS[footer] ?? FOOTERS.run),
  };
}

function fail(reason, message, extra = {}) {
  return {
    ok: false,
    code: null,
    text: '',
    stdout: '',
    stderr: '',
    parsed: { errors: [], warnings: [], info: [], targets: [], ports: {}, registers: {}, flash: {}, memory: {}, hardware: {}, notes: [] },
    argv: [],
    durationMs: 0,
    reason,
    spawnError: message,
    evidence: [],
    ...extra,
  };
}

// ------------------------------------------------------------- 判据

/** 有没有 `Error:` —— 这是**主判据**。 */
export function hasErrors(text) {
  return /^Error:/m.test(String(text ?? ''));
}

/**
 * 正向证据：**成功的硬标志**。
 *
 * 「没有 Error」是弱证据（可能只是没跑到那一步）；这些才是强证据。
 * 报告里必须把它单独列出来，否则 agent 只能靠「没报错」推断成功。
 */
const EVIDENCE_RULES = [
  { re: /\*\*\s*Verified OK\s*\*\*/i, what: '校验通过（** Verified OK **）' },
  { re: /\*\*\s*Programming Finished\s*\*\*/i, what: '编程完成（** Programming Finished **）' },
  { re: /wrote\s+(\d+)\s+bytes/i, what: '写入字节数已回报' },
  { re: /Target successfully examined/i, what: '目标已成功识别（Target successfully examined）' },
  { re: /Cortex-M\d+\s+r\d+p\d+\s+processor detected/i, what: '已探测到 Cortex-M 内核' },
  { re: /flash size\s*=\s*\d+\s*kbytes/i, what: 'flash 容量已读出' },
  { re: /erased\s+.*?\d+\s+bytes/i, what: '擦除已回报字节数' },
];

/** 从解析结果里挑出命中的正向证据（去重）。 */
export function positiveEvidence(parsed, text) {
  const hay = text ?? (parsed?.info ?? []).join('\n');
  const out = [];
  for (const r of EVIDENCE_RULES) {
    if (r.re.test(hay) && !out.includes(r.what)) out.push(r.what);
  }
  return out;
}

/** 综合判据。 */
export function judge({ code, parsed, spawnError, text }) {
  if (spawnError) {
    const msg = String(spawnError.message ?? spawnError);
    if (/ETIMEDOUT|timed? ?out/i.test(msg)) {
      return { ok: false, reason: 'timeout', detail: `openocd 超时未退出：${msg}`, evidence: [] };
    }
    return { ok: false, reason: 'spawn', detail: `进程启动失败：${msg}`, evidence: [] };
  }
  const errs = parsed?.errors ?? [];
  const evidence = positiveEvidence(parsed, text ?? parsed?.lines?.join?.('\n'));
  if (errs.length) {
    return {
      ok: false,
      reason: code === 0 ? 'text-error-with-zero-exit' : 'error',
      detail:
        `命中 ${errs.length} 行 \`Error:\`（退出码 ${code}）。` +
        (code === 0 ? '退出码是 0 —— 这正是「不能只看退出码」的原因，判据取文本。' : '') +
        `\n首行：${errs[0]}`,
      evidence,
    };
  }
  if (code !== 0) {
    return {
      ok: false,
      reason: 'exit-code',
      detail: `没有 Error: 行，但退出码是 ${code}（可能被外部杀掉，或脚本自己 exit 了）。`,
      evidence,
    };
  }
  return {
    ok: true,
    reason: 'ok',
    detail: evidence.length
      ? `无 Error: 行，退出码 0；正向证据：${evidence.join('、')}。`
      : '无 Error: 行，退出码 0（无正向证据 —— 对语义为「探测/读取」的操作这是正常的）。',
    evidence,
  };
}

// ------------------------------------------------------------- 输出解析

/**
 * 把 openocd 输出拆成结构。
 * 保守匹配：宁可少认，不猜。
 */
export function parseOcd(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = {
    lines: lines.length,
    errors: [],
    warnings: [],
    info: [],
    targets: [],
    targetNames: [],
    ports: {},
    registers: {},
    flash: {},
    memory: {},
    hardware: {},
    notes: [],
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    if (/^Error:/i.test(line)) {
      out.errors.push(line);
      continue;
    }
    if (/^Warn(ing)?:/i.test(line)) {
      out.warnings.push(line);
    } else if (/^Info:/i.test(line)) {
      out.info.push(line);
    }

    // openocd 的 target 名藏在 `Info : [stm32f1x.cpu] …` 的前缀里 —— 这是自动拿到
    // target 名的**最可靠**方式（比猜 cfg 里的变量强）。
    const tm = /^\[([\w.\-]+)\]\s+(.*)$/.exec(line.replace(/^(Info|Warn(?:ing)?)\s*:\s*/i, ''));
    if (tm) {
      const name = tm[1];
      const rest = tm[2];
      if (!out.targetNames.includes(name)) out.targetNames.push(name);
      if (/Target successfully examined/i.test(rest)) {
        out.targets.push({ name, examined: true });
      }
      const cm = /Cortex-M(\d+)\s+(r\d+p\d+)\s+processor detected/i.exec(rest);
      if (cm) {
        out.hardware.core = `Cortex-M${cm[1]}`;
        out.hardware.coreRevision = cm[2];
      }
      if (/target halted/i.test(rest)) out.hardware.halted = true;
      const pc = /PC=(0x[0-9a-fA-F]+)/i.exec(rest);
      if (pc) out.registers.pc = pc[1];
    }

    // CMSIS-DAP 适配器自报家门（含 VID/PID 与序列号 —— 用来确认**确实是哪一个探针**）
    let m = /CMSIS-DAP:\s*USB device.*?VID[:=]\s*(0x[0-9a-fA-F]+).*?PID[:=]\s*(0x[0-9a-fA-F]+)/i.exec(line);
    if (m) out.hardware.adapter = { vid: m[1], pid: m[2] };
    m = /CMSIS-DAP:\s*Serial(?:\s+number)?[:=]\s*([0-9a-fA-F]+)/i.exec(line);
    if (m) out.hardware.adapterSerial = m[1];
    if (/CMSIS-DAP:\s*Interface Initialised/i.test(line)) {
      const t = /\((\w+)\)/.exec(line);
      out.hardware.adapterTransport = t ? t[1] : null;
      out.hardware.adapterInit = true;
    }
    if (/Failed to open CMSIS-DAP device|No CMSIS-DAP device found|Could not find.*CMSIS-DAP/i.test(line)) {
      out.notes.push(
        '没找到 CMSIS-DAP 设备。按这个顺序查：① 探针驱动是否正常（设备管理器错误码 39/28）；' +
          '② `adapter serial` 是否指向了实际插着的那个；③ 有没有别的进程（上一次没退出的 openocd / IDE 的调试会话）占着它。',
      );
    }

    m = /clock speed\s+(\d+)\s*kHz/i.exec(line);
    if (m) out.hardware.clockKhz = Number(m[1]);

    m = /SWD DPIDR\s+(0x[0-9a-fA-F]+)/i.exec(line);
    if (m) out.hardware.dpidr = m[1];
    m = /JTAG tap:\s*\S+\s+expected id\s+(0x[0-9a-fA-F]+)/i.exec(line);
    if (m) out.hardware.tapid = m[1];

    m = /device id\s*=\s*(0x[0-9a-fA-F]+)/i.exec(line);
    if (m) out.flash.deviceId = m[1];
    m = /flash size\s*=\s*(\d+)\s*kbytes/i.exec(line);
    if (m) out.flash.sizeKb = Number(m[1]);
    m = /core.*?(\d+)\s*kbytes\s+flash.*?(\d+)\s*kbytes\s+RAM/i.exec(line);
    if (m) {
      out.flash.sizeKb = out.flash.sizeKb ?? Number(m[1]);
      out.flash.ramKb = Number(m[2]);
    }
    m = /flash '([\w.]+)' found at (0x[0-9a-fA-F]+)/i.exec(line);
    if (m) out.flash.bank = { name: m[1], base: m[2] };
    m = /wrote\s+(\d+)\s+bytes?/i.exec(line);
    if (m) out.flash.wroteBytes = (out.flash.wroteBytes ?? 0) + Number(m[1]);
    if (/\*\*\s*Verified OK\s*\*\*/i.test(line)) out.flash.verified = true;
    m = /erased\s+.*?(\d+)\s+bytes/i.exec(line);
    if (m) out.flash.erasedBytes = Number(m[1]);
    m = /erased sectors?\s+(\d+)\s+through\s+(\d+)/i.exec(line);
    if (m) out.flash.erasedSectors = `${m[1]}–${m[2]}`;

    m = /Code Read-Protect\s+status\s+(Enable|Disable)/i.exec(line);
    if (m) {
      out.flash.readProtect = /^enable$/i.test(m[1]) ? 'enabled' : 'disabled';
      out.flash.readProtectRaw = line.trim();
    }
    if (/Read-Protect Status Currently Enabled/i.test(line)) {
      out.flash.readProtect = 'enabled';
      out.notes.push('flash 处于**读保护**状态：erase / program 会被拒。先解除保护（`flash protect 0 0 <last> off`）再写。');
    }
    if (/cleared protection for sectors/i.test(line)) {
      const mm = /cleared protection for sectors\s+(\d+)\s+through\s+(\d+)/i.exec(line);
      if (mm) out.flash.protectCleared = `sectors ${mm[1]}–${mm[2]}`;
    }

    m = /Listening on port (\d+) for (\w+) connections/i.exec(line);
    if (m) out.ports[m[2]] = Number(m[1]);
    m = /starting gdb server for ([\w.\-]+) on (\d+)/i.exec(line);
    if (m) {
      out.ports.gdb = Number(m[2]);
      out.ports.gdbTarget = m[1];
    }

    m = /^([\w$]+)\s*(?:\(\/\d+\))?\s*:\s*(0x[0-9a-fA-F]+|\d+)/.exec(line);
    if (m) out.registers[m[1]] = m[2];

    m = /^(0x[0-9a-fA-F]+):\s*((?:[0-9a-fA-F]{2,8}\s*)+)$/.exec(line);
    if (m) out.memory[m[1]] = m[2].trim();

    if (/Ready for Remote Connections/i.test(line)) out.notes.push('会话已就绪（Ready for Remote Connections）。');
    if (/Transport "\w+" was already selected/i.test(line)) out.notes.push('`Transport … was already selected` 是无害噪声。');
    if (/in procedure '\w+' called at|invalid command name/i.test(line)) {
      out.notes.push('TCL 报「命令不存在/调用栈」：多半是 cfg 名字写错，或 `-s` 搜索目录不对。');
    }
    if (/Could not open file|No such file or directory/i.test(line)) {
      out.notes.push('有文件打不开：若路径含中文，多半是 Jim-TCL 的 GBK 解释问题 —— 检查 ASCII 镜像是否已建（`mcu_env`）。');
    }
  }

  return out;
}

// ------------------------------------------------------------- 常用序列

function preClean() {
  return [RBP_ALL];
}

/** 前置：连上并停住。 */
export function preamble() {
  return ['init', 'halt'];
}

/** 探测：清断点 → 探 flash → 列 target → 读 PC。 */
export function probeSequence() {
  return ['init', 'halt', ...preClean(), 'flash probe 0', 'targets', 'reg pc'];
}

/** 系统信息：DPIDR / IDCODE / flash 容量 / 保护状态。 */
export function sysInfoSequence() {
  return ['init', 'halt', ...preClean(), 'flash probe 0', 'targets', 'flash protect_check 0'];
}

/** 只读：连上、读寄存器与可选内存。 */
export function readSequence(extra = []) {
  return ['init', 'halt', ...preClean(), 'reg pc', 'reg sp', ...extra];
}

/** 复位。`mode` 为 `run`（默认）或 `halt`。 */
export function resetSequence({ mode = 'run', kind = 'reset' } = {}) {
  const seq = ['init', ...preClean()];
  if (kind === 'init') seq.push('reset init');
  else if (kind === 'halt') seq.push('reset halt');
  else seq.push(mode === 'halt' ? 'reset halt' : 'reset run');
  return seq;
}

/**
 * 擦除。
 *
 * `mode: 'chip'` 用 `flash erase_sector 0 0 last` —— `last` 是 OpenOCD 0.12
 * flash 命令的合法关键字（「最后一个扇区」），由 flash 驱动自己算扇区表，
 * 比人手工算 `容量/页大小-1` 可靠（PY32/STM32 各自的页大小完全不同）。
 */
export function eraseSequence({ mode = 'chip', address, length, unprotect = false, bank = 0 } = {}) {
  const seq = ['init', 'halt', ...preClean(), 'flash probe 0'];
  if (unprotect) seq.push(`flash protect ${bank} 0 last off`, `flash protect_check ${bank}`);
  if (mode === 'address' && address !== undefined && length !== undefined) {
    const a = hexify(address);
    const l = hexify(length);
    seq.push(`flash erase_address ${a} ${l}`);
  } else {
    seq.push(`flash erase_sector ${bank} 0 last`);
  }
  seq.push('flash probe 0');
  return seq;
}

/**
 * 烧录。
 *
 * 用 openocd 内建 `program`（自己处理 erase → write → verify）。
 * **不写 `exit` / `reset`** —— 让收尾统一做 `reset run`。
 *
 * 裸 `.bin` 必须显式给地址（`program` 否则报 no memory address）；
 * elf/hex 自带地址，给了反而可能冲突。
 */
export function flashSequence({ imagePath, verify = true, address, unprotect = false, bank = 0 } = {}) {
  const parts = ['program', `{${toSlash(imagePath)}}`];
  const a = address === undefined || address === null || address === '' ? null : hexify(address);
  if (a) parts.push(a);
  if (verify) parts.push('verify');
  const seq = ['init', 'halt', ...preClean(), 'flash probe 0'];
  if (unprotect) seq.push(`flash protect ${bank} 0 last off`, `flash protect_check ${bank}`);
  return [...seq, parts.join(' ')];
}

/** 查读保护状态。`flash probe` 不报保护位，只有 `flash protect_check` 会。 */
export function protectCheckSequence({ bank = 0 } = {}) {
  return ['init', 'halt', ...preClean(), 'flash probe 0', `flash protect_check ${bank}`];
}

/** 解除读保护。 */
export function unprotectSequence({ bank = 0 } = {}) {
  return ['init', 'halt', ...preClean(), 'flash probe 0', `flash protect ${bank} 0 last off`, `flash protect_check ${bank}`];
}

/** 从路径判断固件格式，返回 `elf`/`hex`/`bin`/… 或 null。 */
export function imageKind(p) {
  const ext = extname(String(p ?? '')).toLowerCase();
  return IMAGE_EXT.has(ext) ? ext.slice(1) : null;
}

/** 地址/长度统一成 `0x…`。 */
export function hexify(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) return s.toLowerCase();
    if (/^\d+$/.test(s)) return `0x${Number(s).toString(16)}`;
    return s;
  }
  return `0x${Number(v).toString(16)}`;
}

/** 拼一条 `mdw`/`mww` 类命令。 */
export function memCmd(op, addr, value) {
  const a = hexify(addr) ?? addr;
  return value === undefined ? `${op} ${a}` : `${op} ${a} ${value}`;
}

/** 把一段内存 dump 成文件（会话目录里），再读回来 —— 比解析 `mdw` 文本可靠。 */
export function dumpSequence({ filePath, address, length }) {
  return ['init', 'halt', ...preClean(), `dump_image {${toSlash(filePath)}} ${hexify(address)} ${Number(length)}`];
}

/** 读 flash 的首选方式：`flash read_bank <bank> <file> [addr] [len]`。 */
export function readBankSequence({ filePath, address, length, bank = 0 } = {}) {
  const parts = ['flash', 'read_bank', String(bank), `{${toSlash(filePath)}}`];
  if (address !== undefined && address !== null && address !== '') {
    parts.push(hexify(address));
    if (length !== undefined && length !== null && Number(length) > 0) parts.push(String(Number(length)));
  } else if (length !== undefined && length !== null && Number(length) > 0) {
    parts.push('0x00000000', String(Number(length)));
  }
  return ['init', 'halt', ...preClean(), 'flash probe 0', parts.join(' ')];
}

// ------------------------------------------------------------- 断点（本插件的招牌能力）

/**
 * 断点/观察点管理序列。
 *
 * ## 为什么这块要单独做
 *
 * 用户踩过的坑就是「断点没清，之后每次烧录都带着断点」。所以本插件把断点
 * 当成**一等公民**：可以显式设、显式列、显式清，而且每次会话结束都自动清。
 *
 * ## 关键事实
 *
 * - Cortex-M 的 `bp` 由 OpenOCD 的 **FPB 单元**实现（硬件比较器，改的是调试寄存器，
 *   **不动 flash 内容**）。FPB 只有 2–6 个比较器，用完了再加就会失败 —— 这是
 *   「断点越加越不灵」的真正原因，而不是 flash 被写坏。
 * - 但 `-c` 里手动写 `bp` 之后若 openocd 异常退出，断点会留在**调试器侧的会话状态**里；
 *   更麻烦的是某些驱动会 fallback 到「软件断点」（写 `bkpt` 指令进 flash）。
 *   所以清理纪律对两类实现都必要。
 * - `rbp all` 流传很广，但**未在 0.12 手册中确认**；手册确认的是
 *   「`bp` 不带参返回全部断点号」+「`rbp <num>` 删指定断点」。所以逐个删。
 */
export function breakpointSequence({ op, address, number, length, type = 'bp' } = {}) {
  const cmd = type === 'wp' ? 'wp' : 'bp';
  switch (String(op ?? 'list')) {
    case 'set': {
      const a = hexify(address);
      if (!a) throw new Error('set 需要 address');
      // `bp <addr> [<length>] [hw]`；Cortex-M 只有硬件断点可用
      return [length ? `${cmd} ${a} ${Number(length)} hw` : `${cmd} ${a} hw`];
    }
    case 'clear':
      return [`rbp ${Number(number)}`];
    case 'clear-all':
      return [RBP_ALL];
    case 'list':
    default:
      return [cmd];
  }
}

/**
 * 播放人话版读耗时预估 —— 报告里必须写出来。
 * 不然「读整片要几十秒」会被当成「卡死了」，agent 会去杀进程、去重试，反而更糟。
 */
export function estimateReadSeconds(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round((n * MS_PER_BYTE_READ) / 10) / 100;
}

/** 文件大小（不存在返回 0）。 */
export function fileBytes(p) {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}
