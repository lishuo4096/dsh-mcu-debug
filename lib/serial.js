/**
 * 串口收发（Node 侧驱动）。
 *
 * ## 为什么要有「宿主进程」这一层
 *
 * 串口是**独占资源**，而且「打开 → 收发 → 关闭」必须落在同一个进程里才有意义。
 * Node 没有内置串口 API，最省事的做法是每次收发都起一个 PowerShell —— 但那样
 * **每次都会重新打开一次口**，而重新打开会把 DTR 重新拉一遍（很多板子把 DTR 接在
 * RESET 上，等于每次读一行日志都把目标复位一次）。
 *
 * 所以这里起**一个常驻的 PowerShell 宿主**（`serial-host.ps1`），串口句柄留在它手里，
 * 插件只通过 stdin/stdout 的 JSON 行协议跟它说话。
 *
 * ## 生命周期
 *
 * - 懒启动：第一次真正用串口时才起宿主。
 * - 自清理：宿主 stdin 关闭（= 插件进程死了）→ 宿主退出；
 *   另外空闲 20 分钟且没开着任何口时宿主也会自己退，不留残留进程。
 *
 * ## 为什么「读不到数据」不算失败
 *
 * 串口上「目标没输出」是**常态**（程序没跑、波特率不对、线没接、TX/RX 反了）。
 * `read` 到点返回已收到的部分（可能 0 字节），`ok:true` —— 由调用方看字节数判断，
 * 而不是把「安静」当异常抛出来。
 *
 * @module lib/serial
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asArray, powershellExe, psJson, runRoot, toSlash } from './env.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 宿主脚本路径（源）。 */
export const HOST_SCRIPT = join(HERE, 'serial-host.ps1');

/**
 * 把宿主脚本**转存一份带 BOM 的副本**到私有运行目录，返回副本路径。
 *
 * 为什么必须这么做：宿主脚本里有大量中文注释，而 Windows PowerShell 5.1
 * 读 `.ps1` 时**只看 BOM**——没有 BOM 就按系统 ANSI 代码页（本机是 GBK）解，
 * 中文注释立刻变成乱码，乱码里只要出现一个引号/反引号就 `ParserError: UnexpectedToken`，
 * 宿主一启动就死。而仓库里的文件是 UTF-8 无 BOM 的，所以这一步不是可选项。
 *
 * 顺带的好处：跑的是我们自己目录里的副本，脚本被换掉也不会影响正在跑的宿主
 * （副本按 size+mtime 缓存，源变了才会重写）。
 *
 * @returns 副本绝对路径；源不存在时返回 null。
 */
export function stageHostScript() {
  if (!existsSync(HOST_SCRIPT)) return null;
  let stamp;
  try {
    const st = statSync(HOST_SCRIPT);
    stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
  } catch {
    stamp = 'unknown';
  }
  if (staged && staged.stamp === stamp && existsSync(staged.path)) return staged.path;

  const dir = runRoot();
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, 'serial-host.ps1');
  try {
    let text = readFileSync(HOST_SCRIPT, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    writeFileSync(dst, `\ufeff${text.replace(/\r?\n/g, '\r\n')}`, 'utf8');
  } catch {
    return HOST_SCRIPT;
  }
  staged = { path: dst, stamp };
  return dst;
}

/** @type {{path:string,stamp:string}|null} */
let staged = null;

/** 缺省波特率。 */
export const DEFAULT_BAUD = 115200;

/** 各种操作的等待上限（ms）。 */
export const SERIAL_TIMEOUTS = {
  host: 15000,
  open: 15000,
  write: 10000,
  read: 90000,
  close: 15000,
};

/** 关掉 DTR/RTS 的提示（默认值，写进工具描述里让用户知道）。 */
export const DEFAULT_PINS = { dtr: false, rts: false };

// ------------------------------------------------------------- 宿主进程

/** @type {{child:import('node:child_process').ChildProcess, buf:string, pending:Map<string,{resolve:Function,timer:any}>, seq:number, stderr:string, startedAt:number, exe:string, exited?:{code:number|null,signal:string|null}, spawnError?:string, noise?:string}|null} */
let host = null;

/** 'exit' 钩子只装一次（每个进程一条就够）。 */
let exitHookInstalled = false;

/** 宿主是否还活着。 */
function hostAlive() {
  return Boolean(host && host.child && host.child.exitCode === null && !host.child.killed && !host.spawnError);
}

/**
 * 起（或复用）串口宿主进程。
 *
 * @returns `{ok, pid?, reused?, exe?, error?}`
 */
export function ensureHost() {
  if (hostAlive()) return { ok: true, pid: host.child.pid, reused: true, exe: host.exe };
  if (!existsSync(HOST_SCRIPT)) {
    return { ok: false, error: `串口宿主脚本不在：${toSlash(HOST_SCRIPT)}（插件的 lib/ 目录不完整）` };
  }

  const script = stageHostScript();
  if (!script) return { ok: false, error: `串口宿主脚本转存失败：${toSlash(HOST_SCRIPT)}` };

  const exe = powershellExe();
  let child;
  try {
    child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-IdleMinutes', '20'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    return { ok: false, error: `起不了串口宿主（${toSlash(exe)}）：${String(error?.message ?? error)}` };
  }

  host = { child, buf: '', pending: new Map(), seq: 0, stderr: '', startedAt: Date.now(), exe, script };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', onStdout);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    host.stderr = (host.stderr + d).slice(-6000);
  });
  child.on('error', (error) => {
    if (host && host.child === child) host.spawnError = String(error?.message ?? error);
  });
  child.on('exit', (code, signal) => {
    if (!host || host.child !== child) return;
    host.exited = { code, signal };
    for (const [, p] of host.pending) {
      clearTimeout(p.timer);
      p.resolve({ id: null, ok: false, code: 'host-exited', error: hostErrorText(code, signal) });
    }
    host.pending.clear();
  });

  /*
   * 把宿主从父进程的事件循环里摘出去。
   *
   * 这是必须的：宿主是**常驻**的（这是设计 —— 串口句柄要跨工具调用保持打开），
   * 但它的三条管道默认会把父进程的事件循环钉住。后果是 DSH 主进程想退出时退不掉，
   * 命令行脚本更是会永远挂着（实测：一个只读探针脚本被拖到 180 秒还在跑）。
   *
   * unref 只影响「是否让事件循环保持存活」，不影响事件照常投递 ——
   * 收发该收到的一个字节都不会少。宿主的存活改由它自己的 `-IdleMinutes` 空转退出兜底。
   */
  child.unref();
  child.stdin.unref?.();
  child.stdout.unref?.();
  child.stderr.unref?.();

  // 父进程真要走了，别留孤儿进程在后台占着串口。
  // 走 'exit' 而不是 'beforeExit'：后者在管道还 ref 着的时候根本不会触发，
  // 而且 'exit' 里只做同步的 kill —— 异步活儿在这里做不完。
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      try {
        if (hostAlive()) host.child.kill();
      } catch {
        /* 退出路径上不报错 */
      }
    });
  }

  return { ok: true, pid: child.pid, reused: false, exe };
}

function hostErrorText(code, signal) {
  const bits = [`串口宿主退出了（code=${code}${signal ? `，signal=${signal}` : ''}）`];
  if (host?.stderr?.trim()) bits.push(`宿主 stderr：${host.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  bits.push('下一步：再调一次串口工具会重新起宿主；若反复退出，说明 PowerShell 里缺 System.IO.Ports。');
  return bits.join('\n');
}

/** 切分宿主 stdout 的 JSON 行。 */
function onStdout(chunk) {
  if (!host) return;
  host.buf += chunk;
  let idx;
  while ((idx = host.buf.indexOf('\n')) >= 0) {
    const line = host.buf.slice(0, idx).replace(/\r$/, '').trim();
    host.buf = host.buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      host.noise = ((host.noise ?? '') + line + '\n').slice(-2000);
      continue;
    }
    const id = String(msg.id ?? '');
    let entry = host.pending.get(id);
    // 宿主在解析不出 id 时会用空 id 报错 —— 只有一条在等时才认领它
    if (!entry && !id && host.pending.size === 1) entry = [...host.pending.values()][0];
    if (!entry) continue;
    clearTimeout(entry.timer);
    for (const [k, v] of host.pending) if (v === entry) host.pending.delete(k);
    entry.resolve(msg);
  }
}

/**
 * 发一条命令给宿主并等回应。
 *
 * @returns Promise<`{id, ok, ...}`> —— **不抛异常**，失败也是 `ok:false`。
 */
export function call(op, payload = {}, { timeoutMs = SERIAL_TIMEOUTS.host } = {}) {
  const ready = ensureHost();
  if (!ready.ok) return Promise.resolve({ id: null, ok: false, code: 'no-host', error: ready.error });

  const h = host;
  const id = String(++h.seq);
  const line = `${JSON.stringify({ id, op, ...payload })}\n`;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      h.pending.delete(id);
      resolve({
        id,
        ok: false,
        code: 'host-timeout',
        error:
          `串口宿主 ${timeoutMs} ms 没回应（op=${op}）。宿主一般卡在一个阻塞的串口调用上 —— ` +
          '把 timeoutMs 调大，或用 mcu_serial_close 强制关掉这个口再试。',
      });
    }, timeoutMs);
    h.pending.set(id, { resolve, timer });
    try {
      h.child.stdin.write(line);
    } catch (error) {
      clearTimeout(timer);
      h.pending.delete(id);
      resolve({ id, ok: false, code: 'host-write-failed', error: String(error?.message ?? error) });
    }
  });
}

/** 宿主现状（给 mcu_env / mcu_serial_list 用）。 */
export function hostStatus() {
  const alive = hostAlive();
  return {
    alive,
    pid: alive ? host.child.pid : host?.child?.pid ?? null,
    exe: host?.exe ?? powershellExe(),
    script: host?.script ?? stageHostScript() ?? HOST_SCRIPT,
    source: HOST_SCRIPT,
    scriptPresent: existsSync(HOST_SCRIPT),
    startedAt: host?.startedAt ?? null,
    uptimeMs: host?.startedAt && alive ? Date.now() - host.startedAt : 0,
    exited: host?.exited ?? null,
    spawnError: host?.spawnError ?? null,
    stderrTail: host?.stderr?.trim()?.split('\n').slice(-3).join('\n') ?? '',
    noise: host?.noise ?? '',
    pending: host?.pending?.size ?? 0,
  };
}

/** 主动收工（插件卸载时可用；不调也会因 stdin 关闭而自退）。 */
export function shutdownHost() {
  if (!hostAlive()) return { ok: true, note: '宿主本来就没在跑' };
  try {
    host.child.stdin.write(`${JSON.stringify({ id: 'quit', op: 'quit' })}\n`);
  } catch {
    /* 写不进去就直接杀 */
  }
  const pid = host.child.pid;
  setTimeout(() => {
    try {
      if (hostAlive()) host.child.kill();
    } catch {
      /* 已经退了 */
    }
  }, 1200).unref?.();
  return { ok: true, pid, note: '已请求宿主关闭所有串口并退出' };
}

// ------------------------------------------------------------- 收发的语义封装

/** `open`。 */
export function openPort({ port, baud = DEFAULT_BAUD, dataBits, parity, stopBits, dtr = false, rts = false, readTimeoutMs, writeTimeoutMs } = {}) {
  return call('open', { port, baud, dataBits, parity, stopBits, dtr, rts, readTimeoutMs, writeTimeoutMs }, { timeoutMs: SERIAL_TIMEOUTS.open });
}

/** `write`。text 走编码，hex=true 时 text 是十六进制串。 */
export function writePort({ port, text = '', hex = false, encoding = 'utf8' } = {}) {
  const need = Math.min(SERIAL_TIMEOUTS.write + text.length * 2, 60000);
  return call('write', { port, text, hex, encoding }, { timeoutMs: need });
}

/** `read` —— 到点返回已收到的部分。 */
export function readPort({ port, timeoutMs = 1000, maxBytes = 65536 } = {}) {
  return call('read', { port, timeoutMs, maxBytes }, { timeoutMs: timeoutMs + SERIAL_TIMEOUTS.read });
}

/** `readline` —— 读到换行或超时。 */
export function readlinePort({ port, timeoutMs = 3000, maxLineBytes = 4096 } = {}) {
  return call('readline', { port, timeoutMs, maxLineBytes }, { timeoutMs: timeoutMs + SERIAL_TIMEOUTS.read });
}

/** `flush`。 */
export function flushPort({ port } = {}) {
  return call('flush', { port }, { timeoutMs: SERIAL_TIMEOUTS.open });
}

/** `pins`。 */
export function pinsOf({ port } = {}) {
  return call('pins', { port }, { timeoutMs: SERIAL_TIMEOUTS.open });
}

/** `setpins`。 */
export function setPins({ port, dtr, rts } = {}) {
  return call('setpins', { port, dtr, rts }, { timeoutMs: SERIAL_TIMEOUTS.open });
}

/** `close`（port 省略 = 关全部）。 */
export function closePort({ port } = {}) {
  return call('close', port ? { port } : {}, { timeoutMs: SERIAL_TIMEOUTS.close });
}

/** `list`（本宿主当前打开的口）。 */
export function hostPorts() {
  return call('list', {}, { timeoutMs: SERIAL_TIMEOUTS.host });
}

// ------------------------------------------------------------- 端口枚举与分类

/**
 * 本机的串口清单，带**来源分类**。
 *
 * 为什么必须分类：本机蓝牙虚拟串口有十几个（COM3…COM31 一堆），
 * 真实硬件串口只有两三个。不分类的话「COM 列表」根本没法看，
 * 也容易把蓝牙口当成目标板的口打开，然后对着空气读半天。
 *
 * @returns `{ok, rows: Array<{port,label,service,manufacturer,instanceId,status,bus,kind,note}>, error}`
 */
export function listPorts() {
  const script = [
    '$names = @()',
    'try { $names = [System.IO.Ports.SerialPort]::GetPortNames() } catch { }',
    '$ents = @()',
    'try { $ents = Get-CimInstance Win32_PnPEntity -ErrorAction Stop | Where-Object { $_.Name -match "\\((COM\\d+)\\)" } } catch { }',
    '$rows = @()',
    'foreach ($n in ($names | Sort-Object { [int]($_.ToString() -replace "\\D","") })) {',
    '  $pat = "(" + $n + ")"',
    '  $m = $ents | Where-Object { $_.Name -like "*$pat*" } | Select-Object -First 1',
    '  $label = ""; $svc = ""; $man = ""; $iid = ""; $st = "Unknown"',
    '  if ($m) {',
    '    $label = ($m.Name -replace "\\s*\\((COM\\d+)\\)\\s*$", "").Trim()',
    '    $svc = [string] $m.Service',
    '    $man = [string] $m.Manufacturer',
    '    $iid = [string] $m.PNPDeviceID',
    '    $st = [string] $m.Status',
    '  }',
    '  $rows += [pscustomobject]@{ port = $n; label = $label; service = $svc; manufacturer = $man; instanceId = $iid; status = $st }',
    '}',
    '$rows | ConvertTo-Json -Depth 5',
  ].join('\n');

  const r = psJson(script, { timeoutMs: 40000 });
  if (!r.ok) {
    return { ok: false, rows: [], error: r.error ?? 'PowerShell 枚举串口失败' };
  }
  const rows = asArray(r.rows).map(classifyPort).filter(Boolean);
  rows.sort((a, b) => rank(a) - rank(b) || num(a.port) - num(b.port));
  return { ok: true, rows };
}

function num(p) {
  const m = /(\d+)/.exec(String(p ?? ''));
  return m ? Number(m[1]) : 9999;
}

function rank(row) {
  return row.kind === 'usb' ? 0 : row.kind === 'other' ? 1 : 2;
}

/**
 * 给一个串口打标签：是不是 USB 真实硬件、是哪个厂商的桥。
 *
 * 判据（按可靠性排序）：
 * 1. `service` 里有 `BTHMODEM` 或厂商是 Microsoft → 蓝牙虚拟口；
 * 2. `instanceId` 里能抠出 VID/PID → USB 桥，进一步按 VID 认出 WCH / FTDI / SiLab / Prolific / CH340；
 * 3. 都没有 → 当成「其它」并列在旁边，不当真实硬件推荐。
 */
function classifyPort(row) {
  if (!row) return null;
  const port = String(row.port ?? '').trim().toUpperCase();
  if (!port) return null;
  const service = String(row.service ?? '');
  const man = String(row.manufacturer ?? '');
  const iid = String(row.instanceId ?? '');
  const label = String(row.label ?? '').trim();

  const vidpid = extractVidPid(iid);
  const isBt = /BTHMODEM|Bluetooth/i.test(service) || /Bluetooth/i.test(label) || /Microsoft/i.test(man);

  let kind = 'other';
  let vendor = null;
  let bridge = '';
  let note = '';

  if (isBt) {
    kind = 'virtual';
    vendor = 'Bluetooth';
    bridge = '蓝牙虚拟串口';
    note = '这是蓝牙把本机串口服务映射出来的口，**不是接在 USB 上的目标板**。列出来只是让你知道它占着号码。';
  } else if (vidpid) {
    kind = 'usb';
    const v = VID_VENDORS[vidpid.vid];
    vendor = v?.name ?? `VID_${vidpid.vid}`;
    bridge = v ? v.bridge : 'USB 串口桥';
    note = v?.note ?? '';
  } else {
    kind = 'other';
    note = '没有 USB 身份信息（可能是主板自带串口、或驱动没报 instanceId）。';
  }

  return {
    port,
    label: label || '(无名)',
    service,
    manufacturer: man,
    instanceId: iid,
    status: String(row.status ?? ''),
    vidpid: vidpid ? `${vidpid.vid}:${vidpid.pid}` : null,
    vid: vidpid?.vid ?? null,
    pid: vidpid?.pid ?? null,
    kind,
    vendor,
    bridge,
    note,
  };
}

/** 从 instanceId 抠 VID/PID，同时认 `VID_xxxx&PID_yyyy`（USB）与 `VID_xxxx+PID_yyyy`（FTDIBUS）。 */
export function extractVidPid(instanceId) {
  const s = String(instanceId ?? '');
  let m = /VID_([0-9A-Fa-f]{4})[&+]PID_([0-9A-Fa-f]{4})/.exec(s);
  if (m) return { vid: m[1].toLowerCase(), pid: m[2].toLowerCase() };
  m = /VID_([0-9A-Fa-f]{4})/i.exec(s);
  return m ? { vid: m[1].toLowerCase(), pid: null } : null;
}

/**
 * 常见 USB 转串口桥的 VID 表。
 *
 * 只放**真的会出现在开发板上**的那些。表里没有的不会被隐藏，
 * 只是标成 `VID_xxxx` 让你自己认。
 */
export const VID_VENDORS = {
  '1a86': { name: 'WCH 沁恒', bridge: 'CH340 / CH343 / CH9102 / WCH-Link 串口', note: 'WCH-Link 自己带的那个串口就在这一族里（VID_1A86&PID_8010 的子接口）。' },
  '0403': { name: 'FTDI', bridge: 'FT232R / FT2232 / FT4232', note: 'FTDI 芯片。注意 FT2232/FT4232 同时是**调试器**（可以当 adapter）——同一个芯片的 A/B 两个通道各当一路用。' },
  '10c4': { name: 'Silicon Labs', bridge: 'CP2102 / CP2104 / CP2105' },
  '067b': { name: 'Prolific', bridge: 'PL2303' },
  '2341': { name: 'Arduino', bridge: '板载 USB CDC' },
  '2a03': { name: 'Arduino (org)', bridge: '板载 USB CDC' },
  '0d28': { name: 'ARM / mbed', bridge: 'DAPLink 的 CDC 串口', note: 'DAPLink 复合设备里的串口子接口。**驱动不正常时它根本不会出现**（要装 mbedserial 驱动）。' },
  '0483': { name: 'STMicroelectronics', bridge: 'ST-Link VCP / STM32 虚拟串口', note: 'ST-Link 自带的那路虚拟串口。' },
  'c251': { name: 'Keil / ARM', bridge: 'CMSIS-DAP 设备' },
  '0d28b': { name: '—', bridge: '—' },
};

// ------------------------------------------------------------- 渲染

/** 把一个口渲染成一行（给 mcu_serial_list 用）。 */
export function renderPortRow(row) {
  const badge = row.kind === 'usb' ? '硬件' : row.kind === 'virtual' ? '虚拟' : '其它';
  const vid = row.vidpid ? ` [${row.vidpid}]` : '';
  const who = row.vendor ? `  ${row.vendor}${row.bridge ? ` / ${row.bridge}` : ''}` : '';
  const st = row.status && row.status !== 'OK' ? `  ←状态：${row.status}` : '';
  return `${badge}  ${String(row.port).padEnd(8)} ${row.label}${vid}${who}${st}`;
}

/** 把一次 read 结果渲染成人话（同时给文本与 hex）。 */
export function renderReadResult(r, { hex = false, maxText = 2000 } = {}) {
  if (!r.ok) return `读失败：${r.error ?? '(未知)'}`;
  const bytes = Number(r.bytes ?? 0);
  const head = `${bytes} 字节（等了 ${r.waitedMs ?? 0} ms${r.remaining ? `，缓冲里还剩 ${r.remaining}` : ''}）`;
  if (bytes === 0) {
    return (
      `${head}\n（这段窗口里没有任何数据。）\n` +
      '串口上「安静」是常态，不是故障。按序查：① 目标程序真的在往外打吗；' +
      '② **波特率对不对**（错波特率通常是乱码而不是静默，但差得离谱时就全是垃圾或空）；' +
      '③ TX/RX 有没有接反（这是最常见的）；④ GND 共地了没有；' +
      '⑤ 用 `pins` 看 DTR/RTS 有没有把目标按住复位。'
    );
  }
  const text = String(r.text ?? '');
  const shown = text.length > maxText ? `${text.slice(0, maxText)}\n…（还有 ${text.length - maxText} 字符，调 maxText 或分段读）` : text;
  if (hex) {
    const h = String(r.hex ?? '');
    const parts = [];
    for (let i = 0; i < h.length; i += 32) parts.push(`${String(i / 2).padStart(5)}: ${h.slice(i, i + 32)}`);
    return `${head}\nhex：\n${parts.slice(0, 64).join('\n')}`;
  }
  return `${head}\n文本（不可打印字符保持原样，控制字符已转义）：\n${escapeCtl(shown)}`;
}

/** 把控制字符转义成可见形式，免得终端被 ANSI 转义序列搅乱。 */
export function escapeCtl(s) {
  return String(s ?? '')
    .replace(/\u001b/g, '\\e')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
