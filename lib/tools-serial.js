/**
 * F 组：串口收发工具。
 *
 * 定位：烧完固件之后「板子到底在说什么」——日志、命令行、AT 指令、
 * 以及那些只能靠串口看出来的启动期信息（HardFault 前的最后一行、
 * bootloader 的握手、时钟树配错时的乱码）。
 *
 * ## 与调试器的关系
 *
 * 串口和 SWD 是**两条独立的路**：可以同时用。调试器负责停/走/读内存，
 * 串口负责看程序自发打印的东西。所以这两个工具组之间没有互斥。
 *
 * ## 关于 DTR/RTS 的默认值
 *
 * 默认 `dtr:false`、`rts:false`。这不是随意的：大量 USB 转串口板子把 DTR 接到目标
 * RESET（Arduino 就是这么干的），默认拉高会把目标一直按在复位里 —— 表现是
 * 「口打开了、写进去了、但一个字节都收不到」，而且没有任何报错。
 *
 * @module lib/tools-serial
 */

import { defineTool } from './define-tool.js';
import { clip, fail, kvBlock, ok, output } from './result.js';
import { toSlash } from './env.js';
import {
  DEFAULT_BAUD,
  closePort,
  escapeCtl,
  flushPort,
  hostPorts,
  hostStatus,
  listPorts,
  openPort,
  pinsOf,
  readPort,
  renderPortRow,
  renderReadResult,
  setPins,
  writePort,
} from './serial.js';

const PORT_ARG = { type: 'string', description: '串口号，如 COM21（大小写不敏感）' };

/** 把换行参数翻译成真实字符。 */
function newlineOf(v) {
  if (v === undefined || v === null || v === false) return '';
  if (v === true) return '\r\n';
  const k = String(v).toLowerCase();
  if (k === 'cr') return '\r';
  if (k === 'lf') return '\n';
  if (k === 'crlf' || k === 'rn') return '\r\n';
  if (k === 'none' || k === '') return '';
  return v; // 直接给字符串就按原样
}

/** 渲染宿主状态的一小段（出错时附在消息里）。 */
function hostFoot() {
  const hs = hostStatus();
  if (hs.alive) return `串口宿主：pid ${hs.pid}（${toSlash(hs.exe)}）`;
  const bits = ['串口宿主：**没在跑**'];
  if (hs.exited) bits.push(`上次退出 code=${hs.exited.code}`);
  if (hs.stderrTail) bits.push(`stderr 尾巴：${hs.stderrTail.split('\n').slice(-2).join(' | ')}`);
  return bits.join('；');
}

// ------------------------------------------------------------- 注册

export function registerSerialTools(ctx) {
  const tools = [
    defineTool({
      name: 'mcu_serial_list',
      description:
        '列出本机串口（**带来源分类**）以及串口宿主的现状。分类是本工具的重点：' +
        '本机蓝牙虚拟串口有十几个（COM3…COM31 一堆），真正接在 USB 上的目标板串口只有两三个 —— ' +
        '不分类的话这张表没法看，也容易打开错的口，然后对着空气读半天。' +
        '列表里 `硬件` = USB 桥/板载 CDC；`虚拟` = 蓝牙等软件口（打开需要 force）；`其它` = 身份不明。',
      parameters: {
        type: 'object',
        properties: {
          all: { type: 'boolean', description: 'true = 连蓝牙虚拟口也完整列出（默认也列，但排在后面且标注清楚）' },
        },
      },
      output,
      async execute() {
        const r = listPorts();
        if (!r.ok) return fail('enum-failed', `枚举串口失败：${r.error ?? '(未知)'}\n${hostFoot()}`, { error: r.error });

        const hw = r.rows.filter((x) => x.kind === 'usb');
        const other = r.rows.filter((x) => x.kind === 'other');
        const virt = r.rows.filter((x) => x.kind === 'virtual');

        const L = [];
        L.push(`本机串口共 ${r.rows.length} 个：硬件 ${hw.length} 个，其它 ${other.length} 个，蓝牙虚拟 ${virt.length} 个。`);
        L.push('');
        L.push('=== 硬件串口（可能是目标板）===');
        L.push(hw.length ? hw.map(renderPortRow).join('\n') : '  （一个都没有）');
        if (hw.some((x) => x.note)) {
          L.push('');
          for (const x of hw.filter((y) => y.note)) L.push(`  ${x.port}：${x.note}`);
        }
        if (other.length) {
          L.push('');
          L.push('=== 其它 ===');
          L.push(other.map(renderPortRow).join('\n'));
        }
        if (virt.length) {
          L.push('');
          L.push('=== 蓝牙虚拟串口（不是目标板；打开需要 force:true）===');
          L.push(clip(virt, 40).rows.map(renderPortRow).join('\n'));
        }

        L.push('');
        L.push('=== 宿主 ===');
        const hs = hostStatus();
        L.push(
          kvBlock([
            ['状态', hs.alive ? `在跑（pid ${hs.pid}）` : '没在跑（第一次收发时会自动起）'],
            ['解释器', toSlash(hs.exe ?? '(未知)')],
            ['脚本', toSlash(hs.script ?? '(无)')],
            ['运行时长', hs.uptimeMs ? `${Math.round(hs.uptimeMs / 1000)} 秒` : '—'],
          ]),
        );

        const opened = hs.alive ? await hostPorts() : { ok: true, open: [] };
        if (opened.ok && opened.open?.length) {
          L.push('');
          L.push('=== 已打开 ===');
          for (const p of opened.open) {
            L.push(
              `  ${p.port}  ${p.baud} ${p.dataBits}${String(p.parity)[0]}${p.stopBits === 'One' ? '1' : p.stopBits}  ` +
                `dtr=${p.dtr} rts=${p.rts}  待读 ${p.bytesToRead} 字节`,
            );
          }
        } else {
          L.push('');
          L.push('（当前没有打开任何串口。）');
        }

        L.push('');
        L.push(
          '下一步：`mcu_serial_open port:"COM21" baud:115200` 打开；然后 `mcu_serial_rx` 看目标在说什么。\n' +
            '**DAPLink 的串口在哪里**：DAPLink 是复合设备，串口是它的一个子接口，' +
            '要装 mbedserial 驱动才会出现；驱动不正常时这个口**根本不会出现在列表里**。',
        );
        return ok(L.join('\n'), { ports: r.rows, host: hs, opened: opened.open ?? [] });
      },
    }),

    defineTool({
      name: 'mcu_serial_open',
      description:
        '打开一个串口并**保持打开**（句柄留在常驻宿主进程里，后续 tx/rx 直接复用）。' +
        '这样可以避免每次收发都重开口 —— 重开口会重新拉一遍 DTR，很多板子 DTR 接 RESET，' +
        '等于每读一行日志就把目标复位一次。' +
        '默认 dtr/rts 都是 false，除非你明确知道板子的自动复位电路。',
      parameters: {
        type: 'object',
        properties: {
          port: PORT_ARG,
          baud: { type: 'integer', description: `波特率，默认 ${DEFAULT_BAUD}` },
          dataBits: { type: 'integer', enum: [5, 6, 7, 8], description: '数据位，默认 8' },
          parity: { type: 'string', enum: ['none', 'odd', 'even', 'mark', 'space'], description: '校验，默认 none' },
          stopBits: { type: 'string', enum: ['1', '1.5', '2'], description: '停止位，默认 1' },
          dtr: { type: 'boolean', description: '是否拉 DTR，默认 false' },
          rts: { type: 'boolean', description: '是否拉 RTS，默认 false' },
          force: { type: 'boolean', description: 'true = 允许打开蓝牙虚拟串口（默认拒绝，避免开错口）' },
        },
        required: ['port'],
      },
      output,
      async execute(args) {
        const port = String(args.port).trim().toUpperCase();
        const lr = listPorts();
        const info = lr.ok ? lr.rows.find((x) => x.port === port) : null;

        if (lr.ok && !info) {
          const near = lr.rows.filter((x) => x.kind === 'usb').map((x) => x.port);
          return fail(
            'no-such-port',
            `本机没有 ${port} 这个串口。` + (near.length ? `当前硬件串口有：${near.join(', ')}。` : '当前一个硬件串口都没有。') +
              '\n用 `mcu_serial_list` 看完整列表。',
            { ports: lr.rows },
          );
        }
        if (info && info.kind === 'virtual' && !args.force) {
          return fail(
            'virtual-port',
            `${port} 是**蓝牙虚拟串口**（${info.label}），不是接在 USB 上的目标板。` +
              '\n这类口打开也不会收到目标板的数据。确定要开就加 `force:true`。' +
              '\n真正的硬件串口：' +
              (lr.rows.filter((x) => x.kind === 'usb').map((x) => `${x.port}（${x.label}）`).join('、') || '（一个都没有）'),
            { port: info },
          );
        }

        const r = await openPort({
          port,
          baud: args.baud ?? DEFAULT_BAUD,
          dataBits: args.dataBits,
          parity: args.parity,
          stopBits: args.stopBits,
          dtr: args.dtr ?? false,
          rts: args.rts ?? false,
        });

        if (!r.ok) {
          return fail(
            'open-failed',
            `打开 ${port} 失败：${r.error ?? '(未知)'}\n${hostFoot()}\n` +
              '排查顺序：① 口被别的程序占着（IDE 串口终端 / 厂商上位机 / 上一次没收干净的会话）—— 这是最常见的；' +
              '② 口号变了（重新插拔 USB 会换号）；③ 驱动没装。',
            { port: info, error: r.error },
          );
        }

        const L = [];
        L.push(`已打开 ${r.port}：${r.baud} ${r.dataBits}${String(r.parity)[0]}${r.stopBits === 'One' ? '1' : r.stopBits}`);
        L.push(`DTR=${r.dtr}  RTS=${r.rts}（默认都不拉 —— 板子的自动复位电路若把 DTR 接 RESET，拉了会把目标按住）`);
        if (info) L.push(`设备：${info.label}${info.vidpid ? ` [${info.vidpid}]` : ''}  ${info.vendor ?? ''}${info.bridge ? ` / ${info.bridge}` : ''}`);
        L.push(`句柄留在宿主进程里（pid ${hostStatus().pid ?? '(?)'}），后续 tx/rx 直接复用。`);
        L.push('');
        L.push(`下一步：\`mcu_serial_rx port:"${r.port}" timeoutMs:2000\` 看目标在说什么。`);
        return ok(L.join('\n'), { open: r, device: info });
      },
    }),

    defineTool({
      name: 'mcu_serial_tx',
      description:
        '向已打开的串口写数据。text 默认按 UTF-8 编码，配 newline 追加换行（很多固件的命令行只认 CRLF）。' +
        'hex:true 时 text 是十六进制串（如 "7f0a"），用于发非文本协议或单个字节。' +
        '写成功不代表目标收到了 —— 要**随后用 rx 看回显**才算闭环。',
      parameters: {
        type: 'object',
        properties: {
          port: PORT_ARG,
          text: { type: 'string', description: '要发的内容' },
          newline: { type: 'string', enum: ['crlf', 'lf', 'cr', 'none'], description: '追加的换行，默认 none（CRLF 最常用，很多固件只认它）' },
          hex: { type: 'boolean', description: 'true = text 是十六进制串' },
          encoding: { type: 'string', enum: ['utf8', 'ascii'], description: '默认 utf8' },
        },
        required: ['port'],
      },
      output,
      async execute(args) {
        const port = String(args.port).trim().toUpperCase();
        if (args.text === undefined && !args.hex) {
          return fail('no-text', 'tx 需要 text（或 hex:true + 十六进制串）。');
        }
        const payload = `${args.text ?? ''}${args.hex ? '' : newlineOf(args.newline)}`;
        if (!payload && !args.hex) {
          return fail('empty', 'text 是空的，没有可发的内容。');
        }

        const r = await writePort({ port, text: payload, hex: Boolean(args.hex), encoding: args.encoding ?? 'utf8' });
        if (!r.ok) {
          return fail(
            'tx-failed',
            `写 ${port} 失败：${r.error ?? '(未知)'}\n${hostFoot()}\n` +
              '若提示「口没有打开」，先 `mcu_serial_open`；宿主重启过的话句柄会丢，需要重开。',
            { error: r.error },
          );
        }

        const shown = args.hex ? `hex ${JSON.stringify(payload)}` : JSON.stringify(escapeCtl(payload));
        return ok(
          `已写入 ${port}：${r.wrote} 字节  ${shown}\n` +
            `下一步：\`mcu_serial_rx port:"${port}" timeoutMs:1500\` 看有没有回显。**没有回显不等于没写进去** —— ` +
            '串口是单向可观测的：能确认的只有「写成功了」。',
          { wrote: r.wrote, sent: payload },
        );
      },
    }),

    defineTool({
      name: 'mcu_serial_rx',
      description:
        '从已打开的串口读数据。到点返回**已收到的部分**（可能 0 字节，那不算失败）。' +
        '三种收法（可叠加）：① 固定窗口 timeoutMs；② `until` 收到指定字符串就提前结束（等握手/等提示符）；' +
        '③ `lines` 收满 N 行就结束（收日志）。' +
        '六成以上的「读不到」其实不是插件问题：TX/RX 接反、没共地、波特率不对、DTR 把目标按住了。',
      parameters: {
        type: 'object',
        properties: {
          port: PORT_ARG,
          timeoutMs: { type: 'integer', description: '最多等多久（ms），默认 1500' },
          until: { type: 'string', description: '收到这个子串就提前结束（如 ">" 或 "OK"）' },
          lines: { type: 'integer', description: '收满这么多行就结束' },
          maxBytes: { type: 'integer', description: '单次最多读多少字节，默认 65536' },
          hex: { type: 'boolean', description: 'true = 以 hex 显示（查乱码/非文本协议时用）' },
          maxText: { type: 'integer', description: '文本最多显示多少字符，默认 2000（超出部分截断提示）' },
          flush: { type: 'boolean', description: 'true = 先丢掉缓冲里已有的旧数据（想看「从现在开始」的输出时用）' },
        },
        required: ['port'],
      },
      output,
      async execute(args) {
        const port = String(args.port).trim().toUpperCase();
        const total = args.timeoutMs ?? 1500;
        const wantUntil = args.until ? String(args.until) : null;
        const wantLines = Number(args.lines ?? 0);

        if (args.flush) {
          const f = await flushPort({ port });
          if (!f.ok) return fail('flush-failed', `flush ${port} 失败：${f.error}`, { error: f.error });
        }

        let acc = '';
        let bytes = 0;
        let waited = 0;
        let rounds = 0;
        let hitUntil = false;
        const started = Date.now();
        const budget = Math.max(200, total);

        // 循环读直到满足任一结束条件。每次读一个短窗口，这样 until/lines 能及时生效。
        while (Date.now() - started < budget) {
          const left = budget - (Date.now() - started);
          rounds += 1;
          const r = await readPort({ port, timeoutMs: Math.min(600, Math.max(200, left)), maxBytes: args.maxBytes ?? 65536 });
          if (!r.ok) {
            if (rounds === 1) {
              return fail(
                'rx-failed',
                `读 ${port} 失败：${r.error ?? '(未知)'}\n${hostFoot()}\n` +
                  '若提示「口没有打开」，先 `mcu_serial_open`。',
                { error: r.error },
              );
            }
            break;
          }
          bytes += Number(r.bytes ?? 0);
          waited += Number(r.waitedMs ?? 0);
          acc += String(r.text ?? '');
          if (wantUntil && acc.includes(wantUntil)) {
            hitUntil = true;
            break;
          }
          if (wantLines > 0 && acc.split('\n').length - 1 >= wantLines) break;
          if (Number(r.bytes ?? 0) === 0 && rounds >= 2 && !wantUntil && wantLines === 0) break;
        }

        const r = { ok: true, bytes, text: acc, waitedMs: waited, remaining: 0 };
        const shown = renderReadResult(r, { hex: Boolean(args.hex), maxText: args.maxText ?? 2000 });

        const head = [
          `读 ${port}：${rounds} 轮，${Math.round(waited)} ms 窗口${hitUntil ? `，命中 until=${JSON.stringify(wantUntil)}` : ''}`,
          shown,
        ].join('\n');

        return ok(head, { bytes, text: acc, rounds, hitUntil, waitedMs: waited });
      },
    }),

    defineTool({
      name: 'mcu_serial_close',
      description:
        '关闭串口（省略 port = 关掉宿主里所有口）。**用完就关**：串口是独占资源，' +
        '留着会挡住 IDE 的上位机/串口终端，也会让宿主的空闲自退机制失效。' +
        'action:"shutdown" 会把宿主进程一起收掉（清现场）。',
      parameters: {
        type: 'object',
        properties: {
          port: { type: 'string', description: '要关的口；省略 = 关全部' },
          action: { type: 'string', enum: ['close', 'pins', 'shutdown'], description: 'close（默认）/ pins（读回 DTR/RTS/CTS/DSR）/ shutdown（连宿主一起收掉）' },
          dtr: { type: 'boolean', description: '配 action:"pins" 时设置 DTR' },
          rts: { type: 'boolean', description: '配 action:"pins" 时设置 RTS' },
        },
      },
      output,
      async execute(args) {
        const action = args.action ?? 'close';
        const port = args.port ? String(args.port).trim().toUpperCase() : null;

        if (action === 'pins') {
          if (!port) return fail('no-port', 'action:"pins" 需要 port。');
          if (args.dtr === undefined && args.rts === undefined) {
            const p = await pinsOf({ port });
            if (!p.ok) return fail('pins-failed', `读 ${port} 引脚失败：${p.error}`, { error: p.error });
            return ok(
              `${port} 引脚状态：DTR=${p.dtr} RTS=${p.rts} CTS=${p.cts} DSR=${p.dsr} CD=${p.cd} BREAK=${p.breakState}\n` +
                '（CTS/DSR 是**输入**，能看出对方（目标板）有没有在拉；DTR/RTS 是我们输出的。）',
              { pins: p },
            );
          }
          const s = await setPins({ port, dtr: args.dtr, rts: args.rts });
          if (!s.ok) return fail('pins-failed', `设置 ${port} 引脚失败：${s.error}`, { error: s.error });
          return ok(
            `${port} 引脚已设置：DTR=${s.dtr} RTS=${s.rts}\n` +
              '提示：若板子把 DTR 接在 RESET 上，拉一次 = 复位一次；NRST 上常见的是「DTR 拉低再放」的脉冲，' +
              '本工具只做静态电平，做不出脉冲 —— 要复位请用 `mcu_reset`。',
            { pins: s },
          );
        }

        if (action === 'shutdown') {
          const { shutdownHost } = await import('./serial.js');
          const before = hostStatus();
          const r = shutdownHost();
          return ok(
            `已请求串口宿主收工：${r.note}（pid ${r.pid ?? before.pid ?? '(无)'}）\n` +
              '宿主会先关掉所有串口再退出。下一次收发时会自动重新起一个干净的。',
            { shutdown: r, before },
          );
        }

        const r = await closePort(port ? { port } : {});
        if (!r.ok) return fail('close-failed', `关闭失败：${r.error}\n${hostFoot()}`, { error: r.error });
        const closed = r.closed ?? [];
        const L = [];
        L.push(closed.length ? `已关闭：${closed.join(', ')}` : '（没有需要关闭的口）');
        if (r.open?.length) L.push(`宿主里还开着：${r.open.join(', ')}`);
        else L.push('宿主里已没有打开的口 —— 空闲 20 分钟后它会自己退出，也可以用 `action:"shutdown"` 立刻收掉。');
        return ok(L.join('\n'), { closed, open: r.open ?? [] });
      },
    }),
  ];

  for (const t of tools) ctx.tools.register(t);
  return tools.map((t) => t.name);
}

/** 本组工具名。 */
export const SERIAL_TOOL_NAMES = ['mcu_serial_list', 'mcu_serial_open', 'mcu_serial_tx', 'mcu_serial_rx', 'mcu_serial_close'];
