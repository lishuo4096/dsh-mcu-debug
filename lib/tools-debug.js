/**
 * B/C 组：目标操作工具（连目标、读寄存器/内存、烧录、擦除、复位、断点）。
 *
 * ## 这一组唯一的执行入口是 `runTarget()`
 *
 * 所有工具都只做三件事：**拼命令序列 → 交给 `runTarget` → 把结果翻译成人话**。
 * 这样「清断点 / 收尾 / 判据 / 工作目录 / 环境变量剥离」这些纪律只有一份实现，
 * 不可能被某个工具绕过去。
 *
 * ## 每个 openocd 进程的固定形状
 *
 * ```
 *   -s <脚本库>                     ← 隔离副本自带，不依赖环境变量
 *   -f <interface cfg>              ← 探针（含 adapter serial 锁定）
 *   -c <探针参数>                    ← adapter serial / transport
 *   -f <target cfg>                 ← 器件
 *   -c <命令>…                       ← 本工具的实际动作
 *   -c '清断点' -c 'reset run'      ← **收尾，永远在最后**
 * ```
 *
 * 「清断点」必须排在离开目标之前，而不是「等下次进来再清」——用户踩过的坑就是
 * 断点留在调试器侧、之后每次烧录都带着断点。
 *
 * @module lib/tools-debug
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { defineTool } from './define-tool.js';
import { clip, fail, fmtBytes, fmtMs, hexDump, kvBlock, ok, output, stamp } from './result.js';
import { pluginRoot, toSlash } from './env.js';
import {
  DEFAULT_SPEED,
  RBP_ALL,
  RWP_ALL,
  TIMEOUTS,
  breakpointSequence,
  dumpSequence,
  eraseSequence,
  estimateReadSeconds,
  fileBytes,
  flashSequence,
  hexify,
  imageKind,
  memCmd,
  parseOcd,
  probeSequence,
  protectCheckSequence,
  readBankSequence,
  readTimeoutFor,
  resetSequence,
  sysInfoSequence,
  unprotectSequence,
} from './ocd.js';
import { diagnose, planHeader, planRun, probeTable, runTarget, workdirLine } from './run.js';

/** 备份目录：插件根下的 `backups/`（**不在**目标工程里，避免污染用户的源码树）。 */
export function backupsRoot() {
  return join(pluginRoot(), 'backups');
}

/** 相对路径按 cwd 补成绝对路径。 */
export function absPath(p, cwd) {
  const s = String(p ?? '').trim();
  if (!s) return null;
  if (isAbsolute(s)) return s;
  return resolve(cwd ?? process.cwd(), s);
}

function writeOutFile(p, buf) {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, buf);
  return p;
}

/** 结果里的元信息（每个工具的报告都用同一套）。 */
function execInfo(r) {
  return {
    verdict: r.verdict ?? (r.ok ? 'ok' : 'fail'),
    reason: r.reason,
    code: r.code,
    durationMs: r.durationMs,
    errors: r.parsed?.errors ?? [],
    warnings: r.parsed?.warnings ?? [],
    workdir: r.workdir,
    argv: r.argv,
    parsed: r.parsed,
    footer: r.footer,
    footerCmds: r.footerCmds ?? [],
    droppedEnv: r.droppedEnv ?? [],
    target: r.target,
    probe: r.probe,
  };
}

/**
 * 报告尾巴：判据 / 耗时 / Error 原文 / 诊断 / 工作目录 / 收尾命令。
 *
 * 为什么每次都打：openocd 的输出很长，但**真正决定成败的只有几行**。
 * 把这几行固定位置摆出来，就不需要每次去翻整段 stdout。
 */
function reportTail(r, label, { extraLines = [], showWorkdir = true } = {}) {
  const L = [];
  const info = execInfo(r);
  L.push('');
  L.push('=== 判据 ===');
  L.push(
    kvBlock([
      ['结论', `${stamp(r.ok)} ${info.verdict}${info.reason && info.reason !== 'ok' ? `（reason=${info.reason}）` : ''}`],
      ['退出码', info.code === null || info.code === undefined ? '(无)' : String(info.code)],
      ['耗时', info.durationMs !== undefined ? fmtMs(info.durationMs) : '(未知)'],
    ]),
  );

  if (info.errors.length) {
    L.push('');
    L.push(`=== Error 原文（${info.errors.length} 行，判据以它为准，不看退出码）===`);
    for (const e of clip(info.errors, 12).rows) L.push(`  ${e}`);
    if (info.errors.length > 12) L.push(`  …还有 ${info.errors.length - 12} 行`);
  } else {
    L.push('');
    L.push('=== Error 原文 ===');
    L.push('  （没有 Error 行 —— openocd 的失败常常也返回 0，所以这一行才是真判据。）');
  }

  if (info.warnings.length) {
    L.push('');
    L.push(`=== Warning（${info.warnings.length} 行，信息性）===`);
    for (const w of clip(info.warnings, 5).rows) L.push(`  ${w}`);
  }

  if (extraLines.length) {
    L.push('');
    L.push(...extraLines);
  }

  L.push('');
  L.push('=== 诊断 ===');
  L.push(diagnose(r));

  if (showWorkdir) {
    L.push('');
    L.push(`工作目录：${workdirLine(info.workdir)}`);
    L.push(`收尾命令：${info.footerCmds?.length ? info.footerCmds.join('  ;  ') : '(无)'}`);
    if (info.droppedEnv?.length) {
      L.push(
        `已剥离的环境变量：${info.droppedEnv.join(', ')}` +
          '（本机 `OPENOCD_SCRIPTS` 被 EIDE 指向自带的 openocd 脚本库，优先级高于 `-s`，必须剥掉才能保证用的是副本自带的脚本）',
      );
    }
  }
  L.push(`（${label}）`);
  return L.join('\n');
}

/** 把 parseOcd 的 flash 段渲染成人话。 */
function flashLines(f) {
  if (!f) return ['  （没有解析到 flash 信息）'];
  const L = [];
  if (f.banks?.length) {
    for (const b of f.banks) L.push(`  bank${b.bank ?? 0}  ${b.driver ?? '?'}  @ ${b.base ?? '?'}  大小 ${b.size ?? b.sizeKb ? `${b.size ?? b.sizeKb}` : '?'}`);
  }
  if (f.sizeKb) L.push(`  容量：${f.sizeKb} KB`);
  if (f.deviceId) L.push(`  device id：${f.deviceId}`);
  if (f.wroteBytes) L.push(`  已写入：${f.wroteBytes} 字节`);
  if (f.verifiedBytes) L.push(`  已校验：${f.verifiedBytes} 字节`);
  if (f.erasedBytes) L.push(`  已擦除：${f.erasedBytes} 字节`);
  if (f.protect) L.push(`  保护状态：${f.protect}`);
  if (!L.length) L.push('  （没有解析到 flash 信息）');
  return L;
}

/** 从 `parsed` 里挑出目标识别结果。 */
function targetIdentity(parsed) {
  const bits = [];
  if (parsed?.targets?.length) bits.push(`target：${parsed.targets.join(', ')}`);
  if (parsed?.targetNames?.length) bits.push(`已创建：${parsed.targetNames.join(', ')}`);
  if (parsed?.hardware?.dpidr) bits.push(`DPIDR：${parsed.hardware.dpidr}`);
  if (parsed?.hardware?.idcode) bits.push(`IDCODE：${parsed.hardware.idcode}`);
  if (parsed?.hardware?.clockKhz) bits.push(`时钟：${parsed.hardware.clockKhz} kHz`);
  if (parsed?.hardware?.cortex) bits.push(`内核：${parsed.hardware.cortex}`);
  return bits;
}

/** 探针锁定的那段说明（多调试器场景必看）。 */
function probeLockLine(r) {
  const p = r?.probe ?? r?.plan?.probe;
  if (!p) return null;
  const locked = r?.plan?.probeCmds?.find((c) => /adapter serial/i.test(c));
  return (
    `探针：${p.label} [${p.vidpid}] serial=${p.serial ?? '(无)'}` +
    (locked ? `\n锁定命令：${locked}` : '\n**没有锁定序列号** —— 本机插着多个调试器时，openocd 会自己挑一个且不报错。')
  );
}

// ------------------------------------------------------------- 注册

export function registerDebugTools(ctx) {
  const tools = [
    defineTool({
      name: 'mcu_probe',
      description:
        '**动手前第一件事**：连上目标做一次只读自检。会报出探针锁定情况、目标识别结果（IDCODE/DPIDR）、' +
        'flash 容量与保护状态、当前 PC。不写任何东西、不擦不烧，收尾统一 `reset run`。' +
        '连不上时的第一嫌疑**不是插件**：先看 `mcu_probes` 里探针的驱动错误码，再看是不是锁错了探针。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: `型号，默认 py32f030。支持 py32f0xx / stm32f103c8t6 / stm32f4 这类写法。` },
          probe: { type: 'string', description: '探针：序列号 / vid:pid / 名字片段（如 "0d28" "cmis-dap"）。省略则用记住的默认探针。' },
          serial: { type: 'string', description: '直接指定探针序列号（多个 DAPLink 时用它精确锁定）' },
          speed: { type: 'integer', description: `适配器时钟 kHz，默认 ${DEFAULT_SPEED}` },
          timeoutMs: { type: 'integer', description: `超时 ms，默认 ${TIMEOUTS.probe}` },
        },
      },
      output,
      async execute(args, exec) {
        const r = runTarget({
          target: args.target,
          probe: args.probe,
          serial: args.serial,
          cmds: probeSequence(),
          speed: args.speed,
          timeoutMs: args.timeoutMs ?? TIMEOUTS.probe,
          label: 'probe',
          footer: 'run',
        });
        if (r.phase === 'plan') {
          const L = [`计划阶段就失败了：${r.spawnError}`];
          if (r.plan?.probes?.length) L.push('', '本机探针：', probeTable(r.plan.probes));
          return fail('plan-failed', L.join('\n'), { plan: r.plan });
        }

        const L = [];
        L.push(`=== 目标自检 ===`);
        L.push(planHeader(r));
        const lock = probeLockLine(r);
        if (lock) {
          L.push('');
          L.push(lock);
        }
        L.push('');
        L.push('=== 识别结果 ===');
        const id = targetIdentity(r.parsed);
        L.push(id.length ? id.map((x) => `  ${x}`).join('\n') : '  （openocd 没有报出 target/IDCODE —— 通常意味着根本没连上）');
        L.push('');
        L.push('=== flash ===');
        L.push(flashLines(r.parsed?.flash).join('\n'));
        if (r.parsed?.registers && Object.keys(r.parsed.registers).length) {
          L.push('');
          L.push('=== 关键寄存器 ===');
          for (const [k, v] of Object.entries(r.parsed.registers).slice(0, 8)) L.push(`  ${k} = ${v}`);
        }
        L.push(
          reportTail(r, 'mcu_probe', {
            extraLines: [
              '',
              '=== 下一步的判据 ===',
              r.ok
                ? '  连上了。要烧录就用 `mcu_flash`；要看内存用 `mcu_mem`；要读回整片用 `mcu_read_flash`。'
                : '  没连上。按 `诊断` 那几行走；**先确认探针**，再怀疑接线，最后才怀疑插件。',
            ],
          }),
        );
        return r.ok
          ? ok(L.join('\n'), { ...execInfo(r), identity: id })
          : fail('probe-failed', L.join('\n'), execInfo(r));
      },
    }),

    defineTool({
      name: 'mcu_regs',
      description:
        '读/写 CPU 寄存器（Cortex-M 内核寄存器，不是外设寄存器）。默认读 PC/SP/LR/xPSR 与 R0–R12。' +
        '也支持在 halt 状态下改 PC 跳转到别的地址（调试「程序跑飞了想从某处重来」时有用）。收尾 `reset run`。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '型号，默认 py32f030' },
          probe: { type: 'string', description: '探针（序列号 / vid:pid / 名字片段）' },
          serial: { type: 'string', description: '探针序列号' },
          speed: { type: 'integer', description: '适配器时钟 kHz' },
          set: { type: 'json', description: '要改的寄存器，如 {"pc":"0x08000100"}。给了它就必须 halt（本工具会先 halt）。' },
          extra: { type: 'array', items: { type: 'string' }, description: '额外的 openocd 命令（如 "reg xpsr"）。**禁双引号与反斜杠**。' },
        },
      },
      output,
      async execute(args) {
        const cmds = ['init', 'halt', RBP_ALL, 'reg pc', 'reg sp', 'reg lr', 'reg xpsr'];
        for (let i = 0; i <= 12; i++) cmds.push(`reg r${i}`);
        for (const [k, v] of Object.entries(args.set ?? {})) {
          cmds.push(`reg ${k} ${hexify(v) ?? v}`);
        }
        for (const e of args.extra ?? []) cmds.push(String(e));
        cmds.push('reg pc', 'reg sp');

        const r = runTarget({
          target: args.target,
          probe: args.probe,
          serial: args.serial,
          speed: args.speed,
          cmds,
          timeoutMs: TIMEOUTS.probe,
          label: 'regs',
          footer: 'run',
        });
        if (r.phase === 'plan') return fail('plan-failed', `计划阶段失败：${r.spawnError}`, { plan: r.plan });

        const regs = r.parsed?.registers ?? {};
        const L = [];
        L.push(planHeader(r));
        L.push('');
        L.push(`=== 寄存器（${Object.keys(regs).length} 个）===`);
        const order = ['pc', 'sp', 'lr', 'xpsr'];
        const seen = new Set();
        for (const k of order) {
          if (regs[k] !== undefined) {
            L.push(`  ${k.padEnd(6)} = ${regs[k]}`);
            seen.add(k);
          }
        }
        for (const [k, v] of Object.entries(regs)) {
          if (seen.has(k)) continue;
          L.push(`  ${k.padEnd(6)} = ${v}`);
        }
        if (!Object.keys(regs).length) L.push('  （一个都没解析到 —— 没连上，或目标没 halt 住）');

        const pc = regs.pc;
        if (pc) {
          L.push('');
          L.push('=== 读法 ===');
          L.push(`  PC = ${pc}。`);
          L.push('  0x08000000 一带 = flash 里的代码（正常执行中）；0x20000000 一带 = RAM（跑飞/在 RAM 里跑）；');
          L.push('  0xFFFFFFF_ 一带 = HardFault/系统异常处理里。看 `mcu_mem address:"' + pc + '" length:64` 能看 PC 处的指令。');
        }
        L.push(reportTail(r, 'mcu_regs'));
        return r.ok ? ok(L.join('\n'), { ...execInfo(r), registers: regs }) : fail('regs-failed', L.join('\n'), execInfo(r));
      },
    }),

    defineTool({
      name: 'mcu_mem',
      description:
        '读/写目标内存。`action:"read"`（默认）通过 `dump_image` 落盘再本地 hexdump —— 比解析 `mdw` 文本可靠。' +
        '`action:"write"` 用 `mww`（4 字节）/`mwh`（2 字节）/`mwb`（1 字节）。' +
        '写内存**会改变目标状态**，需要 `confirm:true`。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '型号，默认 py32f030' },
          probe: { type: 'string', description: '探针' },
          serial: { type: 'string', description: '探针序列号' },
          speed: { type: 'integer', description: '适配器时钟 kHz' },
          action: { type: 'string', enum: ['read', 'write'], description: '默认 read' },
          address: { type: 'string', description: '地址，如 0x20000000 或 "20000000"' },
          length: { type: 'integer', description: 'read：读多少字节（默认 256，上限 262144）' },
          values: { type: 'array', items: { type: 'string' }, description: 'write：要写的值列表，如 ["0x12345678","0"]' },
          width: { type: 'integer', enum: [1, 2, 4], description: 'write 的写宽度（字节），默认 4' },
          confirm: { type: 'boolean', description: 'write 必填 true' },
          out: { type: 'string', description: 'read：另存到哪个文件（默认只放在会话目录里）' },
        },
        required: ['address'],
      },
      output,
      async execute(args) {
        const name = `mem-${String(args.address).replace(/^0x/i, '')}`;

        if ((args.action ?? 'read') === 'write') {
          if (!args.confirm) {
            return fail(
              'need-confirm',
              `要往 ${args.address} 写数据，但没给 confirm:true。\n` +
                '写内存会**直接改变目标状态**（覆盖变量、踩掉栈、把代码段写花），所以这一步必须显式确认。\n' +
                '确认要写就加上 `confirm:true`。',
            );
          }
          const vals = (args.values ?? []).map((v) => hexify(v) ?? v);
          if (!vals.length) return fail('no-values', 'write 需要 values（要写的值列表）。');
          const w = Number(args.width ?? 4);
          const op = w === 1 ? 'mwb' : w === 2 ? 'mwh' : 'mww';
          const cmds = ['init', 'halt', RBP_ALL, `${op} ${hexify(args.address)} ${vals.join(' ')}`];
          const r = runTarget({
            target: args.target,
            probe: args.probe,
            serial: args.serial,
            speed: args.speed,
            cmds,
            timeoutMs: TIMEOUTS.probe,
            label: 'mem-write',
            footer: 'run',
          });
          if (r.phase === 'plan') return fail('plan-failed', `计划阶段失败：${r.spawnError}`, { plan: r.plan });
          const L = [
            planHeader(r),
            '',
            `已写 ${vals.length} 个 ${w} 字节值到 ${hexify(args.address)}：${vals.join(', ')}`,
            `（命令：${op}）`,
            '注意：写内存**不落 flash** —— 断电/复位后就没了。要持久化得写进 flash。',
            reportTail(r, 'mcu_mem(write)'),
          ];
          return r.ok ? ok(L.join('\n'), execInfo(r)) : fail('mem-write-failed', L.join('\n'), execInfo(r));
        }

        const len = Math.max(1, Math.min(Number(args.length ?? 256), 262144));
        const plan = planRun({
          target: args.target,
          probe: args.probe,
          serial: args.serial,
          speed: args.speed,
        });
        if (!plan.ok) return fail('plan-failed', `计划阶段失败：${plan.error}`, { plan });

        const sessionDir = join(pluginRoot(), '.run', `oneshot-${Date.now().toString(36)}`);
        mkdirSync(sessionDir, { recursive: true });
        const dumpFile = join(sessionDir, `${name}.bin`);

        const r = runTarget({
          target: args.target,
          probe: args.probe,
          serial: args.serial,
          speed: args.speed,
          cmds: dumpSequence({ filePath: dumpFile, address: args.address, length: len }),
          timeoutMs: readTimeoutFor(len, { fixed: TIMEOUTS.read }),
          label: 'mem-read',
          footer: 'run',
          workdir: sessionDir,
        });
        if (r.phase === 'plan') return fail('plan-failed', `计划阶段失败：${r.spawnError}`, { plan: r.plan });

        const L = [planHeader(r), ''];
        let bytes = null;
        if (existsSync(dumpFile)) {
          bytes = readFileSync(dumpFile);
          L.push(`已 dump ${fmtBytes(bytes.length)} → ${toSlash(dumpFile)}`);
          L.push('');
          L.push('=== hexdump ===');
          L.push(hexDump(bytes, Number(args.address) || 0, 16));
          let saved = null;
          if (args.out) {
            saved = absPath(args.out, process.cwd());
            writeOutFile(saved, bytes);
            L.push('');
            L.push(`已另存：${toSlash(saved)}`);
          }
        } else {
          L.push('**没有生成 dump 文件** —— openocd 的 dump_image 没成功（多半是目标没连上/地址非法）。');
        }
        L.push(reportTail(r, 'mcu_mem(read)'));
        return r.ok && bytes
          ? ok(L.join('\n'), { ...execInfo(r), dumpFile, bytes: bytes.length })
          : fail('mem-read-failed', L.join('\n'), execInfo(r));
      },
    }),

    defineTool({
      name: 'mcu_flash_info',
      description:
        'flash 详情（只读）：flash bank 列表、容量、device id、**读保护状态**。' +
        '保护状态只有 `flash protect_check` 会报 —— `flash probe` 不报。' +
        '要烧录前先跑它：处于读保护时烧录一定失败，得先 `mcu_erase mode:"unprotect"`。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '型号，默认 py32f030' },
          probe: { type: 'string', description: '探针' },
          serial: { type: 'string', description: '探针序列号' },
          speed: { type: 'integer', description: '适配器时钟 kHz' },
        },
      },
      output,
      async execute(args) {
        const r = runTarget({
          target: args.target,
          probe: args.probe,
          serial: args.serial,
          speed: args.speed,
          cmds: sysInfoSequence(),
          timeoutMs: TIMEOUTS.probe,
          label: 'flash-info',
          footer: 'run',
        });
        if (r.phase === 'plan') return fail('plan-failed', `计划阶段失败：${r.spawnError}`, { plan: r.plan });
        const f = r.parsed?.flash ?? {};
        const L = [planHeader(r), '', '=== flash ===', flashLines(f).join('\n')];
        const id = targetIdentity(r.parsed);
        if (id.length) {
          L.push('');
          L.push('=== 识别 ===');
          L.push(id.map((x) => `  ${x}`).join('\n'));
        }
        const prot = String(f.protect ?? '');
        if (/enabled|currently enabled/i.test(prot)) {
          L.push('');
          L.push('**读保护是开着的。** 烧录前必须先解除：`mcu_erase mode:"unprotect"`（会整片擦除，内容全丢）。');
        }
        L.push(reportTail(r, 'mcu_flash_info'));
        return r.ok ? ok(L.join('\n'), { ...execInfo(r), flash: f }) : fail('flash-info-failed', L.join('\n'), execInfo(r));
      },
    }),

    defineTool({
      name: 'mcu_read_flash',
      description:
        '把目标 flash 读回成文件（备份 / 比对 / 抠出厂固件都靠它）。' +
        '走 `flash read_bank`，比逐地址 mdw 快得多。**速度是硬限制**（约 20 KB/s，取决于探针），' +
        '读整片 64 KB 要几十秒 —— 报告里会先给出预估耗时，别把它当卡死。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '型号，默认 py32f030' },
          probe: { type: 'string', description: '探针' },
          serial: { type: 'string', description: '探针序列号' },
          speed: { type: 'integer', description: '适配器时钟 kHz' },
          address: { type: 'string', description: '起始地址，默认 0x08000000（flash 基址）' },
          length: { type: 'integer', description: '读多少字节。省略 = 整片（按器件表容量）' },
          out: { type: 'string', description: '输出文件路径（默认写到插件 backups/）' },
          compare: { type: 'string', description: '给一个参考固件路径，读回后逐字节比对并报出第一处差异' },
        },
      },
      output,
      async execute(args) {
        const plan = planRun({ target: args.target, probe: args.probe, serial: args.serial, speed: args.speed });
        if (!plan.ok) return fail('plan-failed', `计划阶段失败：${plan.error}`, { plan });

        const totalKb = plan.target?.flashKb ?? 32;
        const len = Number(args.length ?? 0) > 0 ? Number(args.length) : totalKb * 1024;
        const est = estimateReadSeconds(len);

        const d = new Date();
        const tag = `${d.toISOString().slice(0, 10).replace(/-/g, '')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
        const out = args.out
          ? absPath(args.out, process.cwd())
          : join(backupsRoot(), `${plan.target.id}-${totalKb}K-${tag}.bin`);

        const r = runTarget({
          target: args.target,
          probe: args.probe,
          serial: args.serial,
          speed: args.speed,
          cmds: readBankSequence({ filePath: out, address: args.address ?? '0x08000000', length: len }),
          timeoutMs: readTimeoutFor(len, { fixed: TIMEOUTS.read }),
          label: 'read-flash',
          footer: 'run',
        });
        if (r.phase === 'plan') return fail('plan-failed', `计划阶段失败：${r.spawnError}`, { plan: r.plan });

        const got = fileBytes(out);
        const L = [];
        L.push(planHeader(r));
        L.push('');
        L.push(`=== 读取 ===`);
        L.push(
          kvBlock([
            ['范围', `${hexify(args.address ?? '0x08000000')} … +${fmtBytes(len)}（${totalKb} KB，按器件表容量；openocd 连上后按 IDCODE 校正）`],
            ['预估耗时', est === null ? '(未知)' : `约 ${est} 秒（探针通道的物理限制，不是卡死）`],
            ['实际耗时', r.durationMs !== undefined ? fmtMs(r.durationMs) : '(未知)'],
            ['产出', got ? `${fmtBytes(got)} → ${toSlash(out)}` : '**没有生成文件**'],
          ]),
        );

        if (got && args.compare) {
          const ref = absPath(args.compare, process.cwd());
          if (!existsSync(ref)) {
            L.push('');
            L.push(`比对：参考文件不存在 ${toSlash(ref)}`);
          } else {
            const a = readFileSync(ref);
            const b = readFileSync(out);
            const n = Math.min(a.length, b.length);
            let diff = -1;
            for (let i = 0; i < n; i++) {
              if (a[i] !== b[i]) {
                diff = i;
                break;
              }
            }
            L.push('');
            L.push('=== 与参考固件比对 ===');
            if (diff < 0 && a.length === b.length) {
              L.push(`  逐字节完全一致（${fmtBytes(n)}）。`);
            } else if (diff < 0) {
              L.push(`  前 ${fmtBytes(n)} 一致，但长度不同：参考 ${fmtBytes(a.length)} vs 读回 ${fmtBytes(b.length)}。`);
            } else {
              const at = (Number(args.address ?? 0x08000000) || 0) + diff;
              L.push(
                `  第一处差异在偏移 ${diff}（目标地址 0x${at.toString(16)}）：参考 0x${a[diff].toString(16).padStart(2, '0')} vs 读回 0x${b[diff].toString(16).padStart(2, '0')}`,
              );
              const s = Math.max(0, diff - 8);
              L.push(`  参考：${[...a.slice(s, s + 24)].map((x) => x.toString(16).padStart(2, '0')).join(' ')}`);
              L.push(`  读回：${[...b.slice(s, s + 24)].map((x) => x.toString(16).padStart(2, '0')).join(' ')}`);
            }
          }
        }

        L.push(reportTail(r, 'mcu_read_flash'));
        return r.ok && got ? ok(L.join('\n'), { ...execInfo(r), out, bytes: got }) : fail('read-flash-failed', L.join('\n'), execInfo(r));
      },
    }),

    defineTool({
      name: 'mcu_flash',
      description:
        '**烧录固件**。默认先把目标现有内容备份成文件（断电断线也能回到旧版本），再清断点、擦、写、校验，' +
        '最后清一次断点 + `reset run`。' +
        '`.elf`/`.hex`/`.s19` 自带地址；裸 `.bin` **必须**给 `address`（否则 openocd 会报 no memory address）。' +
        '需要 `confirm:true`。',
      parameters: {
        type: 'object',
        properties: {
          image: { type: 'string', description: '固件路径（.elf/.hex/.bin/.s19/.srec），相对路径按当前工作目录解析' },
          target: { type: 'string', description: '型号，默认 py32f030' },
          probe: { type: 'string', description: '探针' },
          serial: { type: 'string', description: '探针序列号' },
          speed: { type: 'integer', description: '适配器时钟 kHz（连不稳就降到 500/1000）' },
          address: { type: 'string', description: '裸 .bin 的装载地址，如 0x08000000' },
          verify: { type: 'boolean', description: '是否校验，默认 true' },
          confirm: { type: 'boolean', description: '必填 true —— 烧录会覆盖目标上原有的内容' },
          backup: { type: 'boolean', description: '烧录前备份现有内容，默认 true' },
          unprotect: { type: 'boolean', description: '先解除读保护，默认 false（**会整片擦除**）' },
        },
        required: ['image'],
      },
      output,
      async execute(args, exec) {
        const img = absPath(args.image, exec?.cwd ?? process.cwd());
        if (!img || !existsSync(img)) {
          return fail(
            'no-image',
            `固件文件不存在：${toSlash(img ?? '(空)')}\n` +
              `（相对路径按当前工作目录解析。用 \`mcu_projects root:"…"\` 可以扫出目录里的固件。）`,
          );
        }
        const kind = imageKind(img);
        if (!kind) {
          return fail('bad-image', `不认识的固件扩展名：${basename(img)}（只认 .elf/.hex/.bin/.s19/.srec）`);
        }
        if (kind === 'bin' && !args.address) {
          return fail(
            'need-address',
            '裸 .bin **必须**给 address（它里面没有地址信息，openocd 会报 "no memory address"）。\n' +
              '绝大多数 Cortex-M 的 flash 基址是 `0x08000000`。',
          );
        }
        if (!args.confirm) {
          const sz = fmtBytes(fileBytes(img));
          return fail(
            'need-confirm',
            `要烧录 ${basename(img)}（${sz}，${kind}）到目标，但没给 confirm:true。\n` +
              '烧录会**覆盖目标 flash 上原有的内容**，所以这一步必须显式确认。\n' +
              '确认要烧就加上 `confirm:true`。没底的话先 `mcu_read_flash` 备份一份。',
          );
        }

        const plan = planRun({ target: args.target, probe: args.probe, serial: args.serial, speed: args.speed });
        if (!plan.ok) return fail('plan-failed', `计划阶段失败：${plan.error}`, { plan });

        const L = [planHeader({ target: plan.target, probe: plan.probe, plan }), ''];
        L.push(`固件：${toSlash(img)}\n格式：${kind}（${fmtBytes(fileBytes(img))}）${args.address ? `  装载地址：${args.address}` : '  （自带地址）'}`);

        // 1) 备份
        let backupFile = null;
        if (args.backup !== false) {
          const totalKb = plan.target?.flashKb ?? 32;
          const d = new Date();
          const tag = `${d.toISOString().slice(0, 10).replace(/-/g, '')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
          backupFile = join(backupsRoot(), `${plan.target.id}-before-flash-${tag}.bin`);
          const br = runTarget({
            target: args.target,
            probe: args.probe,
            serial: args.serial,
            speed: args.speed,
            cmds: readBankSequence({ filePath: backupFile, address: '0x08000000', length: totalKb * 1024 }),
            timeoutMs: readTimeoutFor(totalKb * 1024, { fixed: TIMEOUTS.read }),
            label: 'pre-flash-backup',
            footer: 'run',
          });
          const got = fileBytes(backupFile);
          L.push('');
          L.push(
            `=== 烧录前备份 ===\n` +
              (got ? `  ${fmtBytes(got)} → ${toSlash(backupFile)}` : `  备份**没成功**（${br.spawnError ?? (br.parsed?.errors ?? []).slice(0, 1).join('') ?? '未知原因'}）`) +
              `\n  备份走的是 flash read_bank，约 ${estimateReadSeconds(totalKb * 1024)} 秒。` +
              `\n  不想等就传 backup:false。`,
          );
        } else {
          L.push('');
          L.push('=== 烧录前备份 ===\n  已跳过（backup:false）—— 目标上原有内容将不可恢复。');
        }

        // 2) 烧录
        const r = runTarget({
          target: args.target,
          probe: args.probe,
          serial: args.serial,
          speed: args.speed,
          cmds: flashSequence({ imagePath: img, verify: args.verify !== false, address: args.address, unprotect: Boolean(args.unprotect) }),
          timeoutMs: TIMEOUTS.flash,
          label: 'flash',
          footer: 'run',
        });
        if (r.phase === 'plan') return fail('plan-failed', `计划阶段失败：${r.spawnError}`, { plan: r.plan });

        L.push('');
        L.push('=== 烧录 ===');
        L.push(flashLines(r.parsed?.flash).join('\n'));
        if (args.verify !== false) {
          const v = r.parsed?.flash?.verifiedBytes;
          L.push(v ? `  校验通过：${v} 字节` : '  **没有看到校验成功的那一行** —— 看下面的 Error 原文。');
        }
        L.push(
          '\n**烧录成功 ≠ 板子在跑。** 收尾命令已经把断点清干净并 `reset run` 了；' +
            '若是烧完没反应，看 `mcu_help topic:"flash_ok_but_dead"`。',
        );
        L.push(reportTail(r, 'mcu_flash'));
        return r.ok
          ? ok(L.join('\n'), { ...execInfo(r), image: img, backupFile })
          : fail('flash-failed', L.join('\n'), { ...execInfo(r), image: img, backupFile });
      },
    }),

    defineTool({
      name: 'mcu_erase',
      description:
        '擦除。`mode:"chip"`（默认）整片擦；`mode:"address"` 擦指定区间；`mode:"unprotect"` 解除读保护（**会整片擦**）。' +
        '擦除后 flash 全 `0xFF`。需要 `confirm:true`。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '型号，默认 py32f030' },
          probe: { type: 'string', description: '探针' },
          serial: { type: 'string', description: '探针序列号' },
          speed: { type: 'integer', description: '适配器时钟 kHz' },
          mode: { type: 'string', enum: ['chip', 'address', 'unprotect'], description: '默认 chip' },
          address: { type: 'string', description: 'mode:"address" 的起始地址' },
          length: { type: 'integer', description: 'mode:"address" 的长度（字节）' },
          confirm: { type: 'boolean', description: '必填 true' },
        },
      },
      output,
      async execute(args) {
        const mode = args.mode ?? 'chip';
        if (!args.confirm) {
          return fail(
            'need-confirm',
            `要执行擦除（mode=${mode}），但没给 confirm:true。\n` +
              (mode === 'unprotect'
                ? '解除读保护**必然整片擦除**（这是芯片行为，不是我们多擦了一步），原有固件全丢。'
                : '擦除会让目标上的固件消失。') +
              '\n确认要擦就加上 `confirm:true`。没底就先 `mcu_read_flash` 备份。',
          );
        }

        let cmds;
        if (mode === 'unprotect') cmds = unprotectSequence({});
        else if (mode === 'address') {
          if (!args.address || !args.length) return fail('need-range', 'mode:"address" 需要 address 与 length。');
          cmds = eraseSequence({ mode: 'address', address: args.address, length: args.length });
        } else cmds = eraseSequence({ mode: 'chip' });

        const r = runTarget({
          target: args.target,
          probe: args.probe,
          serial: args.serial,
          speed: args.speed,
          cmds,
          timeoutMs: TIMEOUTS.erase,
          label: `erase-${mode}`,
          footer: 'run',
        });
        if (r.phase === 'plan') return fail('plan-failed', `计划阶段失败：${r.spawnError}`, { plan: r.plan });

        const L = [planHeader(r), '', `=== 擦除（mode=${mode}）===`];
        L.push(flashLines(r.parsed?.flash).join('\n'));
        L.push(
          '\n提示：**不需要先手动擦除再烧录** —— `mcu_flash` 里的 `program` 自己会先擦要写的扇区。' +
            '单独擦一般只用在「要一块干净的全 0xFF 板子」或「解除保护」这两种场景。',
        );
        L.push(reportTail(r, 'mcu_erase'));
        return r.ok ? ok(L.join('\n'), execInfo(r)) : fail('erase-failed', L.join('\n'), execInfo(r));
      },
    }),

    defineTool({
      name: 'mcu_reset',
      description:
        '复位目标。`mode:"run"`（默认，复位后让它跑）/`"halt"`（复位后停住，接着可以读寄存器查启动故障）' +
        '/`"init"`（`reset init`，跑 cfg 里的 reset-init 钩子 —— PY32 的 cfg 会在这一步把时钟切到 HSI 24MHz 并提速）。' +
        '两种情况用它：① 烧完没反应想强制重跑；② 程序跑飞了想抓启动现场（用 halt）。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '型号，默认 py32f030' },
          probe: { type: 'string', description: '探针' },
          serial: { type: 'string', description: '探针序列号' },
          speed: { type: 'integer', description: '适配器时钟 kHz' },
          mode: { type: 'string', enum: ['run', 'halt', 'init'], description: '默认 run' },
        },
      },
      output,
      async execute(args) {
        const mode = args.mode ?? 'run';
        const cmds = resetSequence({ kind: mode === 'init' ? 'init' : mode === 'halt' ? 'halt' : 'reset' });
        const r = runTarget({
          target: args.target,
          probe: args.probe,
          serial: args.serial,
          speed: args.speed,
          cmds,
          timeoutMs: TIMEOUTS.reset,
          label: `reset-${mode}`,
          // halt 模式下**不要**在收尾里 reset run，否则刚停住的现场立刻又跑掉了
          footer: mode === 'halt' ? 'halt' : 'run',
        });
        if (r.phase === 'plan') return fail('plan-failed', `计划阶段失败：${r.spawnError}`, { plan: r.plan });

        const L = [planHeader(r), '', `=== 复位（mode=${mode}）===`];
        if (mode === 'halt') {
          const regs = r.parsed?.registers ?? {};
          L.push('已于 halt 状态停下。当前寄存器：');
          for (const [k, v] of Object.entries(regs).slice(0, 14)) L.push(`  ${k} = ${v}`);
          L.push('');
          L.push(
            '注意：**本工具在 halt 模式下不做 `reset run` 收尾**（否则现场立刻跑掉）。' +
              '但断点仍然清干净了。看完现场记得用 `mcu_reset mode:"run"` 让它跑起来，' +
              '否则目标会一直停着 —— 目标停着的时候，串口上什么都看不到。',
          );
        } else {
          L.push('目标已复位并放开运行。');
          if (mode === 'init') L.push('（`reset init` 会执行器件 cfg 的 reset-init 钩子：PY32F030 在这一步把时钟切到 HSI 24MHz 并把适配器提到 4MHz。）');
        }
        L.push(reportTail(r, `mcu_reset(${mode})`));
        return r.ok ? ok(L.join('\n'), execInfo(r)) : fail('reset-failed', L.join('\n'), execInfo(r));
      },
    }),

    defineTool({
      name: 'mcu_bp',
      description:
        '断点管理。**本插件的招牌能力**：断点在这里是一等公民 —— 可以列、可以设、可以显式清，' +
        '而且**每次操作结束都会自动清干净再 `reset run`**。' +
        'Cortex-M 的断点靠 FPB 单元（硬件比较器，只有 2–6 个），不动 flash 内容；' +
        '但断点留在调试器侧没清，就会让之后每次烧录都带着断点 —— 这正是本插件要防的事。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '型号，默认 py32f030' },
          probe: { type: 'string', description: '探针' },
          serial: { type: 'string', description: '探针序列号' },
          speed: { type: 'integer', description: '适配器时钟 kHz' },
          action: { type: 'string', enum: ['list', 'set', 'clear', 'clear-all'], description: '默认 list' },
          address: { type: 'string', description: 'action:"set" 的地址' },
          number: { type: 'integer', description: 'action:"clear" 的断点号（list 会报出来）' },
          length: { type: 'integer', description: 'action:"set" 的监视长度（字节）' },
          type: { type: 'string', enum: ['bp', 'wp'], description: 'bp=执行断点（默认）/ wp=数据观察点' },
        },
      },
      output,
      async execute(args) {
        const action = args.action ?? 'list';
        let body;
        try {
          body = breakpointSequence({ op: action, address: args.address, number: args.number, length: args.length, type: args.type });
        } catch (error) {
          return fail('bad-args', String(error?.message ?? error));
        }

        // 收尾：先清断点再放它跑。`list` 也要清 —— 因为连进来之前的断点同样是残留。
        const cmds = ['init', 'halt', ...body, 'bp', 'wp'];
        const r = runTarget({
          target: args.target,
          probe: args.probe,
          serial: args.serial,
          speed: args.speed,
          cmds,
          timeoutMs: TIMEOUTS.probe,
          label: `bp-${action}`,
          footer: 'run',
        });
        if (r.phase === 'plan') return fail('plan-failed', `计划阶段失败：${r.spawnError}`, { plan: r.plan });

        const L = [planHeader(r), '', `=== 断点（action=${action}${args.type === 'wp' ? ', 类型=观察点' : ''}）===`];
        const bpLines = (r.parsed?.info ?? []).filter((x) => /^Breakpoint|^Watchpoint|^\d+:\s/.test(x));
        L.push(bpLines.length ? bpLines.map((x) => `  ${x}`).join('\n') : '  （当前没有断点。）');
        if (action === 'set' && args.address) {
          L.push('');
          L.push(`已在 ${hexify(args.address)} 下断点。注意 FPB 比较器**有限（通常 4 个）**，下满了再加会失败。`);
        }
        L.push('');
        L.push(
          '=== 收尾 ===\n' +
            `  本次操作最后执行了：${(r.footerCmds ?? []).join('  ;  ')}\n` +
            '  ← **这就是「断点不会残留」的机制**：清断点在离开目标之前做，而不是等下次进来再清。',
        );
        L.push(reportTail(r, `mcu_bp(${action})`));
        return r.ok ? ok(L.join('\n'), execInfo(r)) : fail('bp-failed', L.join('\n'), execInfo(r));
      },
    }),

    defineTool({
      name: 'mcu_ocd',
      description:
        '逃生舱：直接跑一段 openocd 脚本。用于本插件还没封装的场景。' +
        '**仍然走同一套纪律**：隔离副本、`-f` 绝对路径、探针锁定、剥掉 `OPENOCD_SCRIPTS`、' +
        '清断点收尾、私有工作目录。所以「用逃生舱就会留下脏现场」在这里不成立。' +
        '破坏性命令（program/erase/mww/load_image/power）需要 `writes:true` 才放行。',
      parameters: {
        type: 'object',
        properties: {
          cmds: { type: 'array', items: { type: 'string' }, description: 'openocd 命令列表（每条一个 -c）。**禁双引号与反斜杠**。' },
          target: { type: 'string', description: '型号，默认 py32f030' },
          probe: { type: 'string', description: '探针' },
          serial: { type: 'string', description: '探针序列号' },
          speed: { type: 'integer', description: '适配器时钟 kHz' },
          footer: { type: 'string', enum: ['run', 'halt', 'none'], description: '收尾：run（默认，清断点+reset run）/halt（清断点+停住）/none（不清）' },
          writes: { type: 'boolean', description: 'true = 放行破坏性命令（program/erase/mww/flash write 等）' },
          timeoutMs: { type: 'integer', description: '超时 ms' },
        },
        required: ['cmds'],
      },
      output,
      async execute(args) {
        const cmds = (args.cmds ?? []).map((c) => String(c));
        if (!cmds.length) return fail('no-cmds', 'cmds 是空的。');

        const DESTRUCTIVE = /\b(program|flash\s+(write|erase|protect)|mww|mwh|mwb|load_image|fast_load|power|reset\s+run)\b/i;
        const risky = cmds.filter((c) => DESTRUCTIVE.test(c));
        if (risky.length && !args.writes) {
          return fail(
            'need-writes',
            `脚本里有 ${risky.length} 条**破坏性**命令，没给 writes:true：\n` +
              risky.map((c) => `  ${c}`).join('\n') +
              '\n\n这些命令会改目标 flash 或内存（`power` 还能直接拉掉供电）。' +
              '\n确认要执行就加 `writes:true`。想先看会跑什么 → 直接调 `mcu_ocd` 时它会把这行打出来。',
            { risky },
          );
        }

        const footer = args.footer ?? 'run';
        const r = runTarget({
          target: args.target,
          probe: args.probe,
          serial: args.serial,
          speed: args.speed,
          cmds: ['init', 'halt', ...cmds],
          timeoutMs: args.timeoutMs ?? TIMEOUTS.flash,
          label: 'ocd-raw',
          footer,
          noFooter: footer === 'none',
        });
        if (r.phase === 'plan') return fail('plan-failed', `计划阶段失败：${r.spawnError}`, { plan: r.plan });

        const L = [];
        L.push('=== 实际执行的命令行 ===');
        L.push(`  ${toSlash(r.argv?.[0] ?? '(exe)')}`);
        for (const a of (r.argv ?? []).slice(1)) L.push(`    ${a.startsWith('-') ? a : `"${a}"`}`);
        L.push('');
        L.push('=== 原始输出 ===');
        const raw = String(r.stdout ?? '') + String(r.stderr ?? '');
        const lines = raw.split('\n').filter((x) => x.trim());
        L.push(clip(lines, 120).rows.map((x) => `  ${x}`).join('\n') || '  (无输出)');
        if (lines.length > 120) L.push(`  …还有 ${lines.length - 120} 行（完整在会话目录的 openocd.txt）`);
        L.push(`\n本次收尾：footer=${footer}（${(r.footerCmds ?? []).join(' ; ') || '无'}）`);
        L.push(reportTail(r, 'mcu_ocd', { showWorkdir: true }));
        return r.ok ? ok(L.join('\n'), execInfo(r)) : fail('ocd-failed', L.join('\n'), execInfo(r));
      },
    }),
  ];

  for (const t of tools) ctx.tools.register(t);
  return tools.map((t) => t.name);
}

/** 本组工具名。 */
export const DEBUG_TOOL_NAMES = [
  'mcu_probe',
  'mcu_regs',
  'mcu_mem',
  'mcu_flash_info',
  'mcu_read_flash',
  'mcu_flash',
  'mcu_erase',
  'mcu_reset',
  'mcu_bp',
  'mcu_ocd',
];

