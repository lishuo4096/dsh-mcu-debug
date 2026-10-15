/**
 * D/E 组：持久会话 + GDB + 清现场。
 *
 * ## 为什么要有「持久会话」
 *
 * 一次性 openocd（`mcu_probe` 那类）每次都要重新 `init`：连目标、认芯片、复位。
 * 排查「跑一会儿才出问题」的故障时这很致命 —— 你刚让程序跑起来，一读变量就得
 * 重新连一遍，程序又从头开始了。
 *
 * 持久会话把 openocd **留在后台**（带 gdb/telnet/tcl 三个端口），
 * 之后可以反复用 telnet 或 gdb 连它，目标一直是同一个、状态一直连续。
 *
 * ## 会话的纪律（和一次性跑的是同一套）
 *
 * - 私有的会话目录（`<插件>/.run/<id>/`），日志留在里面。
 * - `-s` 指向**隔离副本**的脚本库，剥掉 `OPENOCD_SCRIPTS`。
 * - 退出必须走 `closeSession`：先 telnet 发 `halt` + 清断点 + `shutdown`，
 *   **让它自己体面退出**；只有明确 `force:true` 才强杀。强杀会跳过清断点那一步 ——
 *   这正是「断点残留」的来源。
 *
 * @module lib/tools-session
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, openSync, readFileSync, closeSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { defineTool } from './define-tool.js';
import { clip, fail, fmtMs, kvBlock, ok, output, stamp } from './result.js';
import { findToolchains, killProcess, listOpenocdProcesses, portOwners, toSlash, runRoot } from './env.js';
import {
  DEFAULT_SPEED,
  RBP_ALL,
  RWP_ALL,
  buildArgs,
  locateOpenocd,
} from './ocd.js';
import {
  assertPrivateWorkdir,
  listSessionDirs,
  makeSessionDir,
  newSessionId,
  pruneSessionDirs,
  quarantineFiles,
  removeSessionDir,
  scanWorkspace,
} from './hygiene.js';
import { planRun } from './run.js';
import { hostStatus } from './serial.js';

/** 会话默认端口。 */
export const DEFAULT_PORTS = { gdb: 3333, telnet: 4444, tcl: 6666 };

/** 会话注册表（放在私有运行区里）。 */
export function registryPath() {
  return join(runRoot(), 'sessions.json');
}

/** 读注册表。坏文件不抛异常 —— 当成空的重建。 */
export function readRegistry() {
  const p = registryPath();
  try {
    if (!existsSync(p)) return { version: 1, sessions: {} };
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (!j || typeof j !== 'object' || typeof j.sessions !== 'object') return { version: 1, sessions: {} };
    return j;
  } catch {
    return { version: 1, sessions: {} };
  }
}

export function writeRegistry(reg) {
  const p = registryPath();
  try {
    writeFileSync(p, JSON.stringify(reg, null, 2), 'utf8');
    return { ok: true, path: p };
  } catch (error) {
    return { ok: false, path: p, error: String(error?.message ?? error) };
  }
}

/** 进程还活着吗。 */
export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

/** 找会话：给 id 就精确找；不给且只有一个活的就返回它。 */
export function findSession(id) {
  const reg = readRegistry();
  const all = Object.values(reg.sessions ?? {});
  if (id) {
    const hit = all.find((s) => s.id === id);
    if (!hit) return { ok: false, error: `没有 ${id} 这个会话记录。`, all };
    return { ok: true, session: hit, alive: isAlive(hit.pid), all };
  }
  const live = all.filter((s) => isAlive(s.pid));
  if (live.length === 1) return { ok: true, session: live[0], alive: true, all };
  if (!live.length) return { ok: false, error: '当前没有活着的会话。先 `mcu_session_open`。', all };
  return { ok: false, error: `有 ${live.length} 个活着的会话，需要指定 id。`, all, candidates: live };
}

// ------------------------------------------------------------- 起会话

/**
 * 起一个后台 openocd 会话。
 *
 * @returns `{ok, session?, error?, ports?, notes?}`
 */
export function spawnSession({ target, probe, serial, speed, ports, label, vendorRoot, extraCmds = [] } = {}) {
  const p = { ...DEFAULT_PORTS, ...(ports ?? {}) };
  if (p.gdb === p.telnet || p.gdb === p.tcl || p.telnet === p.tcl) {
    return { ok: false, error: `三个端口不能相同（gdb=${p.gdb} telnet=${p.telnet} tcl=${p.tcl}）` };
  }

  const busy = portOwners([p.gdb, p.telnet, p.tcl]);
  const taken = (busy ?? []).filter((x) => x && x.listening && x.process);
  if (taken.length) {
    return {
      ok: false,
      error:
        `端口已被占用：\n` +
        taken.map((t) => `  ${t.port} 被 pid ${t.process.ProcessId}（${t.process.Name}）占着`).join('\n') +
        '\n换一组端口（ports:{gdb:3334,telnet:4445,tcl:6667}），或先 `mcu_clean action:"all"` 收拾掉旧会话。',
      busy: taken,
    };
  }

  const plan = planRun({ target, probe, serial, vendorRoot });
  if (!plan.ok) return { ok: false, error: plan.error, plan };

  const loc = locateOpenocd(vendorRoot);
  if (!loc.present) return { ok: false, error: `隔离副本里没有 openocd.exe：${loc.exe}` };

  const id = newSessionId(plan.target?.id ?? 'mcu');
  const dir = makeSessionDir(id);
  const logFile = join(dir, 'openocd.log');

  const cmds = [
    `adapter speed ${Number(speed) > 0 ? Math.floor(speed) : DEFAULT_SPEED}`,
    `gdb_port ${p.gdb}`,
    `telnet_port ${p.telnet}`,
    `tcl_port ${p.tcl}`,
    'init',
    ...extraCmds,
  ];

  const argv = buildArgs({
    sequence: [...plan.sequence, ...cmds.map((c) => ({ cmd: c }))],
    searchDirs: loc.searchDirs ?? [],
    noFooter: true,
  });

  const childEnv = { ...process.env };
  const droppedEnv = [];
  for (const k of ['OPENOCD_SCRIPTS']) {
    if (k in childEnv) {
      delete childEnv[k];
      droppedEnv.push(k);
    }
  }

  let fd;
  try {
    fd = openSync(logFile, 'a');
  } catch (error) {
    return { ok: false, error: `打不开会话日志 ${toSlash(logFile)}：${String(error?.message ?? error)}` };
  }

  let child;
  try {
    child = spawn(loc.exe, argv, {
      cwd: dir,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: childEnv,
    });
  } catch (error) {
    closeSync(fd);
    return { ok: false, error: `起不了 openocd：${String(error?.message ?? error)}` };
  }
  child.unref();
  try {
    closeSync(fd);
  } catch {
    /* 父进程不需要这个句柄 */
  }

  const record = {
    id,
    label: label ?? plan.target?.id ?? 'mcu',
    target: plan.target?.id ?? null,
    cfg: plan.targetCfg,
    interfaceCfg: plan.interfaceCfg,
    probe: plan.probe ? { label: plan.probe.label, vidpid: plan.probe.vidpid, serial: plan.probe.serial } : null,
    exe: loc.exe,
    argv,
    pid: child.pid,
    ports: p,
    workdir: dir,
    logFile,
    droppedEnv,
    startedAt: new Date().toISOString(),
    cmdCount: 0,
  };

  const reg = readRegistry();
  reg.sessions = reg.sessions ?? {};
  reg.sessions[id] = record;
  writeRegistry(reg);

  return { ok: true, session: record, notes: plan };
}

/**
 * 等会话就绪：日志里出现三个 `Listening on port N for <kind> connections`。
 *
 * 判据是**日志文本**而不是「进程还活着」—— openocd 起得来但连不上目标时，
 * 进程活着但端口不会开。
 */
export function waitForReady(record, timeoutMs = 40000) {
  const started = Date.now();
  const found = new Set();
  while (Date.now() - started < timeoutMs) {
    if (!isAlive(record.pid)) {
      const tail = readTail(record.logFile, 12);
      return { ok: false, error: `openocd（pid ${record.pid}）在就绪前就退出了。`, tail };
    }
    let text = '';
    try {
      text = readFileSync(record.logFile, 'utf8');
    } catch {
      text = '';
    }
    for (const m of text.matchAll(/Listening on port (\d+) for (\w+) connections/g)) {
      found.add(m[2]);
    }
    if (/^Error:/m.test(text)) {
      return { ok: false, error: 'openocd 报错了（见日志）。', errors: text.split('\n').filter((l) => /^Error:/i.test(l)).slice(0, 6), tail: readTail(record.logFile, 12) };
    }
    if (found.has('gdb') && found.has('telnet') && found.has('tcl')) {
      return { ok: true, readyMs: Date.now() - started, listening: [...found] };
    }
    // 忙等一小会儿。会话启动是秒级的，不值得上异步。
    sleep(220);
  }
  return {
    ok: false,
    error: `等 ${Math.round(timeoutMs / 1000)} 秒仍没看到三个端口就绪（只看到：${[...found].join(', ') || '无'}）。`,
    tail: readTail(record.logFile, 12),
  };
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* 忙等：会话启动是秒级操作，且这里没有别的事可做 */
  }
}

function readTail(file, lines) {
  try {
    const t = readFileSync(file, 'utf8').split('\n').filter((x) => x.trim());
    return t.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

// ------------------------------------------------------------- telnet / gdb

/**
 * 跟 openocd 的 telnet 端口说几句话，收回显。
 *
 * 结束判据：连上后**空闲** idleMs 毫秒没有新数据 = 这段命令输出完了。
 * 比「等固定时间」快，也比「等提示符」稳（提示符是 `> `，但 echo 会干扰）。
 */
export function telnetExchange(port, lines, { timeoutMs = 25000, idleMs = 600, host = '127.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    let buf = '';
    let done = false;
    let idleTimer = null;

    const hardTimer = setTimeout(() => finish('timeout'), timeoutMs);
    function finish(why, error) {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
      try {
        sock.destroy();
      } catch {
        /* 已经断了 */
      }
      resolve({ ok: !error, why, error: error ? String(error) : null, text: clean(buf) });
    }
    const bumpIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish('idle'), idleMs);
    };

    sock.setEncoding('utf8');
    sock.on('connect', () => {
      for (const l of lines) sock.write(`${l}\n`);
      bumpIdle();
    });
    sock.on('data', (d) => {
      buf += d;
      bumpIdle();
    });
    sock.on('error', (e) => finish('error', e?.message ?? e));
    sock.on('close', () => finish('closed'));
  });
}

/** 去掉 telnet 回显与 `> ` 提示符，让输出能看。 */
function clean(s) {
  return String(s ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.replace(/^>\s?/, ''))
    .join('\n')
    .trim();
}

/** 体面关掉一个会话。 */
export function closeSession(record, { force = false } = {}) {
  if (!isAlive(record.pid)) {
    const reg = readRegistry();
    delete reg.sessions?.[record.id];
    writeRegistry(reg);
    return { ok: true, already: true, message: `进程 ${record.pid} 已经不在跑了。` };
  }

  const script = ['halt', RBP_ALL, RWP_ALL, 'shutdown'];
  const r = telnetExchangeSync(record.ports?.telnet, script);

  // 等它自己退
  for (let i = 0; i < 16; i++) {
    if (!isAlive(record.pid)) break;
    sleep(250);
  }

  if (isAlive(record.pid)) {
    if (!force) {
      return {
        ok: false,
        refused: true,
        telnet: r,
        message:
          `openocd（pid ${record.pid}）在收到 halt + 清断点 + shutdown 之后**仍然活着**。` +
          '\n我没有强杀它 —— 强杀会跳过「清断点」那一步，而这正是「以后每次烧录都带断点」的来源。' +
          '\n\n先试：① telnet 端口是不是被别的东西占了；② 手动 telnet 进去发 `shutdown`；' +
          `③ 确认要强杀就再加 \`force:true\`，然后**紧接着**用 \`mcu_clean action:"kill"\` 并重新 \`mcu_flash\` 一次（重烧会自然覆盖）。`,
      };
    }
    const k = killProcess(record.pid, { force: true });
    const dead = !isAlive(record.pid);
    const reg = readRegistry();
    delete reg.sessions?.[record.id];
    writeRegistry(reg);
    return {
      ok: true,
      forced: true,
      telnet: r,
      kill: k,
      message:
        `已强杀 pid ${record.pid}${dead ? '（确认已退出）' : '（**还在！**手动 taskkill 试试）'}。` +
        '\n提醒：强杀跳过了收尾清断点。**下一步请重烧一次固件**，重烧流程自带清断点。',
    };
  }

  const reg = readRegistry();
  delete reg.sessions?.[record.id];
  writeRegistry(reg);
  return { ok: true, telnet: r, message: `会话 ${record.id} 已体面退出（halt → 清断点 → shutdown）。` };
}

/** telnet 的同步包装（closeSession 里用，避免把 async 传染到整个调用链）。 */
function telnetExchangeSync(port, lines) {
  if (!port) return { ok: false, error: '没有 telnet 端口' };
  let out = { ok: false, error: '未执行' };
  let settled = false;
  telnetExchange(port, lines, { timeoutMs: 12000, idleMs: 500 }).then((r) => {
    out = r;
    settled = true;
  });
  const end = Date.now() + 13000;
  while (!settled && Date.now() < end) {
    sleep(120);
  }
  return out;
}

// ------------------------------------------------------------- GDB

/** 找 arm-none-eabi-gdb。 */
export function pickGdb() {
  const tc = findToolchains();
  return tc.gdb ? { ok: true, path: tc.gdb, toolchain: tc } : { ok: false, error: '找不到 arm-none-eabi-gdb', toolchain: tc };
}

/**
 * 生成 gdb 批处理脚本。
 *
 * 为什么用 `--batch -x script` 而不是一长串 `-ex`：
 * 脚本能落盘到会话目录，出问题时可以直接看、可以重放，而 `-ex` 串只能看命令行。
 */
export function gdbScript({ action = 'inspect', port = DEFAULT_PORTS.gdb, elf = null, cmds = [] } = {}) {
  const L = [
    '# dsh-mcu-debug 生成的 gdb 脚本（RECORD ONLY，不要复用）',
    'set confirm off',
    'set pagination off',
    'set height 0',
    'set width 0',
    'set print pretty off',
  ];
  const offline = action === 'symbols';
  if (!offline) {
    L.push('set remotetimeout 20');
    L.push(`target extended-remote localhost:${port}`);
  }
  if (elf) L.push(`file ${toSlash(elf)}`);

  if (action === 'symbols') {
    L.push('info functions');
    L.push('info variables');
  } else if (action === 'load') {
    L.push('monitor reset halt');
    L.push('load');
    L.push('compare-sections');
    L.push('monitor reset run');
  } else if (action === 'inspect') {
    L.push('monitor halt');
    L.push('info registers');
    L.push('bt');
    L.push('info frame');
    L.push('x/16xw $sp');
    L.push('monitor reset run');
  } else {
    for (const c of cmds) L.push(String(c));
  }

  const hasReset = L.some((l) => /monitor reset run/.test(l));
  if (!offline) {
    if (!hasReset) L.push('monitor reset run');
    L.push('disconnect');
  }
  L.push('quit');
  return L.join('\n');
}

/** 跑一次 gdb（批处理）。 */
export function runGdb({ action, port, elf, cmds, timeoutMs = 120000 } = {}) {
  const g = pickGdb();
  if (!g.ok) {
    return {
      ok: false,
      error:
        `${g.error}。gdb 只在这两个动作里需要：\`symbols\`（离线看符号表）和带符号的 \`inspect\`。` +
        '\n没有 gdb 也能用：`mcu_mem`（读内存）、`mcu_regs`（读寄存器）、`mcu_ocd`（任意 openocd 命令）。' +
        '\n工具链探测结果见 `mcu_env`。',
      toolchain: g.toolchain,
    };
  }
  const script = gdbScript({ action, port, elf, cmds });
  const scriptPath = join(runRoot(), `gdb-${Date.now().toString(36)}.gdb`);
  try {
    writeFileSync(scriptPath, script, 'utf8');
  } catch (error) {
    return { ok: false, error: `gdb 脚本写不进去：${String(error?.message ?? error)}` };
  }

  const args = ['-nx', '-q', '--batch', '-x', scriptPath];
  if (elf) args.push(elf);
  const r = spawnSync(g.path, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    cwd: runRoot(),
  });

  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return {
    ok: !r.error && !/^Error in sourced command file|Remote communication error|No such file/m.test(text),
    code: r.status,
    text,
    script,
    scriptPath,
    gdb: g.path,
    error: r.error ? String(r.error.message ?? r.error) : null,
  };
}

// ------------------------------------------------------------- 注册

export function registerSessionTools(ctx) {
  const tools = [
    defineTool({
      name: 'mcu_session_open',
      description:
        '起一个**后台常驻**的 openocd 会话（带 gdb/telnet/tcl 三个端口）。' +
        '一次性的 `mcu_probe` 每次都从零连一遍（整个目标会复位重来），排查「跑一会儿才出问题」的故障时不够用；' +
        '会话让目标的状态**连续**，可以反复用 telnet/gdb 连它看现场。' +
        '会话目录与日志都在插件的私有运行区里，退出请走 `mcu_session_close`（它会先清断点再关）。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '型号，默认 py32f030' },
          probe: { type: 'string', description: '探针（序列号 / vid:pid / 名字片段）' },
          serial: { type: 'string', description: '探针序列号' },
          speed: { type: 'integer', description: '适配器时钟 kHz' },
          label: { type: 'string', description: '给会话起个名，方便在 list 里认出来' },
          ports: { type: 'json', description: '自定义端口，如 {"gdb":3333,"telnet":4444,"tcl":6666}' },
        },
      },
      output,
      async execute(args) {
        const s = spawnSession({
          target: args.target,
          probe: args.probe,
          serial: args.serial,
          speed: args.speed,
          label: args.label,
          ports: args.ports,
        });
        if (!s.ok) return fail('session-failed', `起会话失败：${s.error}`, { spawn: s });

        const rec = s.session;
        const ready = waitForReady(rec);

        const L = [];
        L.push(`会话 ${rec.id} 已起：pid ${rec.pid}`);
        L.push(
          kvBlock([
            ['目标', `${rec.target ?? '(?)'}`],
            ['cfg', toSlash(rec.cfg ?? '(无)')],
            ['探针', rec.probe ? `${rec.probe.label} serial=${rec.probe.serial ?? '(无)'}` : '(未指定)'],
            ['端口', `gdb ${rec.ports.gdb} / telnet ${rec.ports.telnet} / tcl ${rec.ports.tcl}`],
            ['日志', toSlash(rec.logFile)],
            ['状态', ready.ok ? `就绪（${fmtMs(ready.readyMs)}）` : `**未就绪**：${ready.error}`],
          ]),
        );

        if (!ready.ok) {
          L.push('');
          L.push('=== 日志尾巴 ===');
          L.push(ready.tail || '(空)');
          if (ready.errors?.length) {
            L.push('');
            L.push('=== Error 行 ===');
            for (const e of ready.errors) L.push(`  ${e}`);
          }
          L.push('');
          L.push(
            '会话没就绪。它**还在后台跑着**（进程没退）—— 收拾它用 `mcu_session_close id:"' + rec.id + '" force:true` 或 `mcu_clean action:"kill"`。',
          );
          return fail('not-ready', L.join('\n'), { session: rec, ready });
        }

        L.push('');
        L.push('=== 怎么用它 ===');
        L.push(`  停住目标：   mcu_session_cmd cmd:"halt"`);
        L.push(`  读现场：     mcu_session_cmd cmd:"info registers"`);
        L.push(`  看内存：     mcu_session_cmd cmd:"x/16xw 0x20000000"`);
        L.push(`  让它继续跑： mcu_session_cmd cmd:"resume"`);
        L.push(`  带符号调试： mcu_gdb action:"inspect" elf:"…elf" port:${rec.ports.gdb}`);
        L.push(`  收工：       mcu_session_close id:"${rec.id}"`);
        L.push('');
        L.push('⚠️ 用完**一定要关**：会话占着探针（别的工具会连不上）和三个 TCP 端口。');
        return ok(L.join('\n'), { session: rec, ready });
      },
    }),

    defineTool({
      name: 'mcu_session_cmd',
      description:
        '往会话的 telnet 端口发 openocd 命令并收回显。' +
        '注意：**这里发的命令不受「自动清断点」保护** —— 你设的断点会留在这个会话里。' +
        '没关系，`mcu_session_close` 的收尾会清干净（`halt` → 清所有断点 → `shutdown`）。' +
        '多条命令可以用 cmd 数组，一次连接里顺序发。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '会话 id（只有一个活着的会话时可以省略）' },
          cmd: { type: 'json', description: '一条命令（字符串）或多条（数组），如 ["halt","mdw 0x20000000 8"]' },
          timeoutMs: { type: 'integer', description: '总超时，默认 25000' },
          tail: { type: 'integer', description: '只显示回显的最后 N 行（默认 120；输出很长时有用）' },
        },
        required: ['cmd'],
      },
      output,
      async execute(args) {
        const f = findSession(args.id);
        if (!f.ok) {
          const cands = (f.candidates ?? []).map((s) => `${s.id}（${s.label}）`).join('、');
          return fail('no-session', f.error + (cands ? `\n候选：${cands}` : ''), { sessions: f.all });
        }
        if (!f.alive) {
          return fail(
            'dead-session',
            `会话 ${f.session.id}（pid ${f.session.pid}）已经不在了 —— 大概是自己退了或被杀过。` +
              '\n用 `mcu_session_list` 看现状，再 `mcu_session_open` 起一个新的。',
            { session: f.session },
          );
        }

        const lines = Array.isArray(args.cmd) ? args.cmd.map(String) : [String(args.cmd)];
        const r = await telnetExchange(f.session.ports.telnet, lines, { timeoutMs: args.timeoutMs ?? 25000 });

        const L = [];
        L.push(`会话 ${f.session.id}（telnet ${f.session.ports.telnet}）收到 ${lines.length} 条命令：`);
        for (const c of lines) L.push(`  > ${c}`);
        L.push('');
        L.push(`=== 回显（结束原因：${r.why}，${r.ok ? 'ok' : `error: ${r.error}`}）===`);
        const rows = String(r.text ?? '').split('\n');
        const tail = Number(args.tail ?? 120);
        const shown = rows.length > tail ? rows.slice(-tail) : rows;
        L.push(shown.map((x) => `  ${x}`).join('\n') || '  (无回显)');
        if (rows.length > tail) L.push(`  …前面还有 ${rows.length - tail} 行`);

        const reg = readRegistry();
        if (reg.sessions?.[f.session.id]) {
          reg.sessions[f.session.id].cmdCount = (reg.sessions[f.session.id].cmdCount ?? 0) + lines.length;
          reg.sessions[f.session.id].lastCmdAt = new Date().toISOString();
          writeRegistry(reg);
        }

        return r.ok ? ok(L.join('\n'), { session: f.session, text: r.text, why: r.why }) : fail('telnet-failed', L.join('\n'), { session: f.session, error: r.error });
      },
    }),

    defineTool({
      name: 'mcu_session_list',
      description: '列出会话（活着的与已死的），标出哪些进程还在、日志在哪、已经发了多少条命令。',
      parameters: { type: 'object', properties: {} },
      output,
      async execute() {
        const reg = readRegistry();
        const all = Object.values(reg.sessions ?? {});
        const rows = all.map((s) => ({ ...s, alive: isAlive(s.pid) }));

        const L = [];
        if (!rows.length) {
          L.push('没有任何会话记录。用 `mcu_session_open` 起一个。');
        } else {
          const live = rows.filter((r) => r.alive);
          L.push(`会话共 ${rows.length} 个，其中**还活着 ${live.length} 个**。`);
          L.push('');
          for (const r of rows) {
            L.push(`${r.alive ? '● 活着' : '○ 已退'}  ${r.id}  ${r.label}`);
            L.push(
              `         pid ${r.pid}  目标 ${r.target ?? '?'}  端口 gdb=${r.ports?.gdb} telnet=${r.ports?.telnet} tcl=${r.ports?.tcl}`,
            );
            L.push(`         起于 ${r.startedAt}  命令 ${r.cmdCount ?? 0} 条${r.lastCmdAt ? `（最后一次 ${r.lastCmdAt}）` : ''}`);
            L.push(`         日志 ${toSlash(r.logFile ?? '(无)')}`);
          }
          if (live.length) {
            L.push('');
            L.push(`活着的会话占着探针与端口 —— 不用了请 \`mcu_session_close id:"${live[0].id}"\`。`);
          }
        }
        L.push('');
        L.push(`注册表：${toSlash(registryPath())}`);
        return ok(L.join('\n'), { sessions: rows });
      },
    }),

    defineTool({
      name: 'mcu_session_close',
      description:
        '**体面地**关掉会话：先 telnet 发 `halt` + 清所有断点 + `shutdown`，让它自己退。' +
        '只有进程赖着不走、且明确给了 `force:true` 才会强杀 —— 强杀会跳过清断点那一步，' +
        '而那正是「以后每次烧录都带断点」的来源。所以本工具默认**拒绝**强杀，要你亲口说要。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '会话 id（只有一个活着的会话时可以省略）' },
          force: { type: 'boolean', description: 'true = 体面关失败时强杀（**会跳过清断点**，之后请重烧一次固件）' },
        },
      },
      output,
      async execute(args) {
        const f = findSession(args.id);
        if (!f.ok) return fail('no-session', f.error, { sessions: f.all });

        const r = closeSession(f.session, { force: Boolean(args.force) });
        const L = [];
        L.push(`会话 ${f.session.id}（pid ${f.session.pid}）`);
        if (r.message) L.push(r.message);
        if (r.telnet) {
          L.push('');
          L.push('=== telnet 收尾回显 ===');
          L.push(`  发了：halt  /  ${RBP_ALL}  /  ${RWP_ALL}  /  shutdown`);
          L.push(clip(String(r.telnet.text ?? '').split('\n'), 20).rows.map((x) => `  ${x}`).join('\n') || '  (无回显)');
        }
        if (r.refused) {
          L.push('');
          L.push('仍然活着，且没有 force:true → **我没有杀它**。');
        }
        L.push('');
        L.push(`注册表里${r.ok ? '已清掉' : '仍保留'}这条记录：${toSlash(registryPath())}`);

        return r.ok ? ok(L.join('\n'), { close: r }) : fail('close-refused', L.join('\n'), { close: r });
      },
    }),

    defineTool({
      name: 'mcu_gdb',
      description:
        '用 arm-none-eabi-gdb 连会话（或纯离线看符号）。' +
        'action:"symbols" **不连目标**，只读 elf 的符号表 —— 查「这个地址是哪个函数」时用它；' +
        '"inspect" 连上后打印寄存器/调用栈/栈内存（这是**故障现场**最有用的三样）；' +
        '"load" 走 gdb 的 load（自带符号，但比 openocd 的 program 慢）；' +
        '"raw" 跑你给的一串 gdb 命令。' +
        '所有非离线动作都会自己 `monitor reset run` 收尾（除非你的 raw 里已经写了）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['inspect', 'symbols', 'load', 'raw'], description: '默认 inspect' },
          elf: { type: 'string', description: 'elf 路径（symbols 必填；inspect 给了就能显示函数名与行号）' },
          id: { type: 'string', description: '会话 id（省略则用唯一活着的会话）' },
          port: { type: 'integer', description: '直接给 gdb 端口（不给就用会话的）' },
          cmds: { type: 'array', items: { type: 'string' }, description: 'action:"raw" 的 gdb 命令列表' },
          timeoutMs: { type: 'integer', description: '超时，默认 120000' },
        },
      },
      output,
      async execute(args) {
        const action = args.action ?? 'inspect';
        let port = args.port;
        let session = null;

        if (action !== 'symbols') {
          if (!port) {
            const f = findSession(args.id);
            if (!f.ok || !f.alive) {
              return fail(
                'no-session',
                `${f.ok ? `会话 ${f.session.id} 已经不在了` : f.error}\n` +
                  'gdb 连的是**会话**的 gdb 端口，所以要先 `mcu_session_open`。' +
                  '\n临时调试用不着 gdb：`mcu_regs` / `mcu_mem` / `mcu_ocd` 都是一次性就能跑的。',
                { sessions: f.all },
              );
            }
            session = f.session;
            port = f.session.ports.gdb;
          }
        }

        if (action === 'symbols' && !args.elf) {
          return fail('need-elf', 'action:"symbols" 需要 elf 路径（符号表在 elf 里，不在芯片里）。');
        }
        if (args.elf && !existsSync(args.elf)) {
          return fail('no-elf', `elf 不存在：${toSlash(args.elf)}`);
        }

        const r = runGdb({ action, port, elf: args.elf, cmds: args.cmds, timeoutMs: args.timeoutMs });

        const L = [];
        L.push(`=== mcu_gdb（action=${action}）===`);
        L.push(
          kvBlock([
            ['gdb', toSlash(r.gdb ?? '(未找到)')],
            ['端口', port ? String(port) : '(离线)'],
            ['elf', args.elf ? toSlash(args.elf) : '(未给)'],
            ['脚本', toSlash(r.scriptPath ?? '(未生成)')],
            ['结论', r.ok ? `${stamp(true)} ok` : `${stamp(false)} ${r.error ?? 'gdb 报了错'}`],
          ]),
        );
        L.push('');
        L.push('=== 本次执行的 gdb 脚本 ===');
        L.push(String(r.script ?? '').split('\n').map((x) => `  ${x}`).join('\n'));
        L.push('');
        L.push('=== gdb 输出 ===');
        const rows = String(r.text ?? '').split('\n').filter((x) => x.trim());
        L.push(clip(rows, 150).rows.map((x) => `  ${x}`).join('\n') || '  (无输出)');

        if (action === 'inspect') {
          L.push('');
          L.push(
            '=== 怎么读现场 ===\n' +
              '  `bt` 的每一层看 FRAME 的 PC —— 用 `info line *0x…` 或 mcu_gdb action:"symbols" 对回函数名。\n' +
              '  `HardFault_Handler` 在最外层 = 程序跑飞了。真正的原因看 CFSR/HFSR：\n' +
              '     `mcu_mem address:"0xE000ED28" length:4`（CFSR）与 `0xE000ED2C`（HFSR）。\n' +
              '     CFSR 的 IMMARVALID/BFARVALID 位亮 = 访问了非法地址，看 `0xE000ED38`（BFAR）拿到那个地址。',
          );
        }
        L.push('');
        L.push('注意：gdb 连上后会 `monitor reset run` 收尾 —— 目标不会被留在停住状态。');

        return r.ok ? ok(L.join('\n'), { gdb: r }) : fail('gdb-failed', L.join('\n'), { gdb: r });
      },
    }),

    defineTool({
      name: 'mcu_clean',
      description:
        '清现场。`action:"audit"`（默认）报告插件私有运行区里有什么、有没有疑似被污染的 cfg/tcl/日志；' +
        '`"kill"` 干掉残留的 openocd 进程（**先尝试体面关会话，再才强杀**）；' +
        '`"prune"` 删过期会话目录；`"scan"` 扫私有区的文件；`"quarantine"` 把可疑文件挪进隔离区；' +
        '`"all"` 上面全做一遍。' +
        '**什么时候需要它**：连不上目标、端口被占、怀疑上一次的 openocd 没退干净。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['audit', 'kill', 'prune', 'scan', 'quarantine', 'all'], description: '默认 audit' },
          maxAgeHours: { type: 'integer', description: 'prune 的过期阈值（小时），默认 24' },
          paths: { type: 'array', items: { type: 'string' }, description: 'quarantine：要挪走的文件列表' },
          includeSessions: { type: 'boolean', description: 'kill 时是否连**会话**也一起体面关掉，默认 true' },
        },
      },
      output,
      async execute(args) {
        const action = args.action ?? 'audit';
        const L = [];
        const payload = {};

        const procs = listOpenocdProcesses();
        L.push(`=== openocd 进程（${procs.length} 个）===`);
        if (!procs.length) L.push('  （没有残留的 openocd 进程。）');
        else {
          for (const p of procs) {
            L.push(`  pid ${p.ProcessId}  父 ${p.ParentProcessId}  ${toSlash(p.CommandLine ?? p.ExecutablePath ?? '')}`);
          }
        }
        payload.processes = procs;

        if (action === 'scan' || action === 'all' || action === 'audit') {
          const sc = scanWorkspace(runRoot());
          payload.scan = sc;
          L.push('');
          L.push(`=== 私有运行区 ${toSlash(runRoot())} ===`);
          L.push(`  文件 ${sc.files?.length ?? 0} 个，疑似污染 ${sc.suspicious?.length ?? 0} 个，外泄迹象 ${sc.leaks?.length ?? 0} 个`);
          if (sc.suspicious?.length) {
            L.push('  疑似污染：');
            for (const s of clip(sc.suspicious, 20).rows) L.push(`    ${toSlash(s.path)}   ← ${(s.why ?? []).join('；')}`);
          }
          if (sc.leaks?.length) {
            L.push('  **外泄迹象**（本不该出现在这里的东西）：');
            for (const s of clip(sc.leaks, 10).rows) L.push(`    ${toSlash(s.path ?? s)}`);
          }
          if (!sc.suspicious?.length && !sc.leaks?.length) {
            L.push('  没有疑似污染，也没有外泄迹象 —— 本插件只在自己的私有区里干活。');
          }
        }

        if (action === 'kill' || action === 'all') {
          L.push('');
          L.push('=== kill ===');
          const sess = readRegistry().sessions ?? {};
          const liveSessions = Object.values(sess).filter((s) => isAlive(s.pid));
          if (args.includeSessions !== false && liveSessions.length) {
            for (const s of liveSessions) {
              const r = closeSession(s, { force: true });
              L.push(`  会话 ${s.id}（pid ${s.pid}）：${r.message ?? '已关'}`);
            }
          }
          const left = listOpenocdProcesses();
          if (!left.length) {
            L.push('  没有需要杀的进程。');
            payload.killed = [];
          } else {
            const killed = [];
            for (const p of left) {
              const r = killProcess(p.ProcessId, { force: true });
              killed.push({ pid: p.ProcessId, ok: r.ok, message: r.message ?? r.error });
              L.push(`  pid ${p.ProcessId}：${r.ok ? '已杀' : `杀失败（${r.message ?? r.error}）`}`);
            }
            payload.killed = killed;
            payload.serial = hostStatus();
            L.push('');
            L.push(
              '  **强杀过的进程跳过了「清断点」收尾。**下一步请重烧一次固件 —— `mcu_flash` 的流程自带清断点。',
            );
          }
        }

        if (action === 'prune' || action === 'all') {
          const rs = pruneSessionDirs({ maxAgeHours: Number(args.maxAgeHours ?? 24) });
          payload.prune = rs;
          const gone = rs.filter((r) => r.ok);
          L.push('');
          L.push(`=== prune（阈值 ${args.maxAgeHours ?? 24} 小时）===`);
          L.push(gone.length ? gone.map((r) => `  已删 ${r.id}：${r.message ?? ''}`).join('\n') : '  （没有过期的会话目录）');
        }

        if (action === 'quarantine') {
          if (!args.paths?.length) return fail('no-paths', 'quarantine 需要 paths（要挪走的文件列表）。');
          const rs = quarantineFiles(args.paths);
          payload.quarantine = rs;
          L.push('');
          L.push('=== quarantine ===');
          if (!rs.ok) L.push(`  ${rs.message ?? '失败'}`);
          for (const r of rs.results ?? []) L.push(`  ${r.ok ? '→' : '!'} ${toSlash(r.path)}${r.movedTo ? ` → ${toSlash(r.movedTo)}` : ''}${r.message ? `  (${r.message})` : ''}`);
          if (rs.quarantineDir) L.push(`  隔离区：${toSlash(rs.quarantineDir)}`);
        }

        if (action === 'audit' || action === 'all') {
          const sd = listSessionDirs({});
          payload.sessions = sd;
          L.push('');
          L.push(`=== 会话目录（${sd.length} 个）===`);
          if (!sd.length) L.push('  （空）');
          else {
            for (const d of clip(sd, 30).rows) {
              L.push(
                `  ${d.id}  ${d.files?.length ?? 0} 文件 / ${d.bytes ?? 0} 字节  ` +
                  `${d.ageHours === null || d.ageHours === undefined ? '' : `（${d.ageHours} 小时前）`}${d.stale ? '  ←已过期' : ''}`,
              );
            }
          }
        }

        L.push('');
        L.push('=== 边界 ===');
        L.push('  本插件**只写**两个地方：自己的私有运行区（`.run/`）和 `backups/`。');
        L.push('  EIDE 的 openocd 原件树、目标工程的源码目录，全程只读。');
        L.push(`  注册表：${toSlash(registryPath())}`);

        return ok(L.join('\n'), payload);
      },
    }),
  ];

  for (const t of tools) ctx.tools.register(t);
  return tools.map((t) => t.name);
}

/** 本组工具名。 */
export const SESSION_TOOL_NAMES = [
  'mcu_session_open',
  'mcu_session_cmd',
  'mcu_session_list',
  'mcu_session_close',
  'mcu_gdb',
  'mcu_clean',
];

export { assertPrivateWorkdir, removeSessionDir };
