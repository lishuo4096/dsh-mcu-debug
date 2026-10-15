/**
 * 「解析目标 + 锁定探针 + 拼序列 + 跑」这一整条链的唯一实现。
 *
 * 调试/烧录/会话/串口四条路径全部走这里，保证**同一个探针、同一套 cfg、
 * 同一份收尾纪律**，不会出现「烧录时锁了 DAPLink、读回时却撞上 WCH-Link」这种事。
 *
 * ## 探针为什么默认不猜
 *
 * 本机插着不止一个调试器（DAPLink + WCH-Link + FTDI）。openocd 不带
 * `adapter serial` 时会**自己挑第一个能打开的**，于是「我以为在烧 PY32，
 * 其实命令发给了另一个探针」——这种错误不会报错，只会静默连错目标。
 * 所以：
 *   - 只有一个可用探针 → 自动选定，并把选择**记进 defaults.json**；
 *   - 有多个 → **报错并把每个探针的 serial 列出来**，不替调用方决定；
 *   - 显式给了 serial → 必须精确命中，命中不了就报错（不退回自动选）。
 *
 * @module lib/run
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRoot, toSlash } from './env.js';
import { DEFAULT_TARGET, resolveTarget, targetSummary } from './devices.js';
import { listProbes, probeCommands, renderProbeTable, selectProbe } from './probes.js';
import {
  DEFAULT_SPEED,
  TIMEOUTS,
  buildSessionSequence,
  locateOpenocd,
  resolveCfgPath,
  runOpenocd,
} from './ocd.js';

// ------------------------------------------------------------- 默认探针记忆

function defaultsPath() {
  return join(runRoot(), 'defaults.json');
}

/** 读 defaults.json（不存在/坏了都返回 `{}`，绝不抛）。 */
export function readDefaults() {
  const p = defaultsPath();
  try {
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

/** 写 defaults.json。 */
export function writeDefaults(patch) {
  const p = defaultsPath();
  try {
    mkdirSync(runRoot(), { recursive: true });
    const next = { ...readDefaults(), ...patch, updatedAt: new Date().toISOString() };
    writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
    return { ok: true, path: p, value: next };
  } catch (error) {
    return { ok: false, path: p, error: String(error?.message ?? error) };
  }
}

// ------------------------------------------------------------- 解析

/** 解析型号。失败时把候选一并带回。 */
export function planTarget(spec) {
  const r = resolveTarget(spec ?? DEFAULT_TARGET);
  if (!r.ok) return { ok: false, error: `${r.reason}。${candidateHint(r.candidates)}`, candidates: r.candidates };
  return { ok: true, target: r.target, reason: r.reason };
}

function candidateHint(cands) {
  if (!cands?.length) return '用 `mcu_devices` 看完整器件表。';
  return `最接近的是：${cands.map((c) => c.id).join('、')}。用 \`mcu_devices\` 看完整器件表。`;
}

/**
 * 选探针。
 *
 * @param probe 一个字符串：序列号（前缀匹配）| `vid:pid` | 种类（`cmsis-dap`）| 名字片段
 */
export function planProbe({ probe, serial, vidpid, probeKind, enumerate = true } = {}) {
  const remembered = readDefaults().probe ?? null;
  const want = probe ?? serial ?? remembered;
  const kind = probeKind ?? null;
  const vid = vidpid ?? null;

  const list = listProbes();
  if (!list.ok) {
    return {
      ok: false,
      error: `枚举 USB 设备失败：${list.error}。若 PowerShell 被策略限制，可直接用 serial 或 vidpid 跳过枚举（但本机有多个调试器，**强烈建议先修好枚举**，否则无法保证锁定了哪个）。`,
      probes: [],
    };
  }

  // 字符串参数智能分流：长得像 vid:pid 就当 vidpid，像 hex 串就当 serial，否则当 kind/名字
  let sSerial = serial ?? null;
  let sVid = vid;
  let sKind = kind;
  let sLabel = null;
  if (typeof probe === 'string' && probe.trim()) {
    const s = probe.trim();
    if (/^[0-9a-f]{4}:[0-9a-f]{4}$/i.test(s)) sVid = s;
    else if (/^[0-9a-f]{8,}$/i.test(s)) sSerial = s;
    else if (['cmsis-dap', 'stlink', 'jlink', 'wch-link'].includes(s.toLowerCase())) sKind = s.toLowerCase();
    else sLabel = s;
  }

  // 1) 名字/序列号前缀匹配（用户手抄了一截序列号是最常见情况）
  if (!sSerial && !sVid && !sKind && sLabel) {
    const n = sLabel.toLowerCase();
    const hits = list.probes.filter((p) =>
      [p.label, p.kind, p.serial, p.vidpid, p.instanceId].some((v) => String(v ?? '').toLowerCase().includes(n)),
    );
    if (hits.length === 1) return { ok: true, probe: hits[0], reason: `按名字片段「${sLabel}」命中 ${hits[0].label}`, probes: list.probes };
    if (hits.length === 0) return { ok: false, error: `没有探针的名字/序列号包含「${sLabel}」。`, probes: list.probes };
    return { ok: false, error: `「${sLabel}」同时命中 ${hits.length} 个：${hits.map(probeShort).join('；')}`, probes: hits };
  }

  // 2) 序列号前缀（用户通常只会抄一部分）
  if (sSerial && !list.probes.some((p) => String(p.serial ?? '').toLowerCase() === String(sSerial).toLowerCase())) {
    const pre = list.probes.filter((p) => String(p.serial ?? '').toLowerCase().startsWith(String(sSerial).toLowerCase()));
    if (pre.length === 1) return { ok: true, probe: pre[0], reason: `按序列号前缀 ${sSerial} 命中 ${pre[0].label}`, probes: list.probes };
    if (pre.length > 1) return { ok: false, error: `序列号前缀 ${sSerial} 命中 ${pre.length} 个，请给完整串。`, probes: pre };
  }

  const sel = selectProbe(list.probes, { serial: sSerial, vidpid: sVid, kind: sKind });
  if (!sel.ok) return { ok: false, error: sel.reason, probes: sel.candidates };

  // 自动选中时记下来，后续调用就不必每次纠结
  if (!sSerial && !sVid && !sKind && !remembered) {
    writeDefaults({ probe: probeArg(sel.probe), probeLabel: sel.probe.label });
  }
  return { ok: true, probe: sel.probe, reason: sel.reason, probes: list.probes };
}

/** 一个探针下次可用的「指名参数」。 */
export function probeArg(p) {
  if (!p) return null;
  if (p.serial && p.serialUsable) return p.serial;
  return p.vidpid;
}

function probeShort(p) {
  return `${p.label} [${p.vidpid}] serial=${p.serial ?? '(无)'}`;
}

// ------------------------------------------------------------- 计划

/**
 * 把「目标 + 探针 + 要跑的命令」拼成一个可执行的计划。
 *
 * @returns `{ok, target, probe, sequence, interfaceCfg, targetCfg, probeCmds, targetCmds, error}`
 */
export function planRun({
  target,
  probe,
  serial,
  vidpid,
  probeKind,
  transport = 'swd',
  vendorRoot,
  cmds = [],
  targetCmds = [],
  preCmds = [],
  speed,
  noTargetCfg = false,
} = {}) {
  const loc = locateOpenocd(vendorRoot);
  if (!loc.present) {
    return { ok: false, error: `隔离副本里的 openocd.exe 不存在：${loc.exe ?? '(解析不到插件根)'}。` };
  }

  const t = planTarget(target);
  if (!t.ok) return { ok: false, error: t.error, candidates: t.candidates };

  const p = planProbe({ probe, serial, vidpid, probeKind });
  if (!p.ok) return { ok: false, error: p.error, probes: p.probes };

  if (!p.probe.interfaceCfg) {
    return {
      ok: false,
      error:
        `${p.probe.label} [${p.probe.vidpid}] 没有对应的 interface cfg，本插件不能直接拿它调目标。` +
        (p.probe.note ? `\n原因：${p.probe.note}` : ''),
      probes: p.probes,
    };
  }

  const iface = resolveCfgPath(p.probe.interfaceCfg, vendorRoot);
  if (!iface.present) {
    return { ok: false, error: `接口 cfg 不存在：${iface.path ?? p.probe.interfaceCfg}（隔离副本的脚本库可能不完整）` };
  }

  let tgt = null;
  if (!noTargetCfg) {
    tgt = resolveCfgPath(t.target.cfg, vendorRoot);
    if (!tgt.present) {
      return {
        ok: false,
        error:
          `目标 cfg 不存在：${tgt.path ?? t.target.cfg}。` +
          '若这是 PY32，说明副本的脚本库不是 0.12.0+（老版本没有 py32*.cfg）；`mcu_env` 会报出副本版本。',
      };
    }
  }

  const tSpeed = Number.isFinite(speed) && speed > 0 ? Math.floor(speed) : null;
  const pCmds = probeCommands(p.probe, { transport, serial: p.probe.serialUsable ? p.probe.serial : null });
  const tCmds = [...(tSpeed ? [`adapter speed ${tSpeed}`] : []), ...targetCmds];

  const sequence = buildSessionSequence({
    interfaceCfg: iface.path,
    targetCfg: tgt?.path ?? null,
    probeCmds: pCmds,
    targetCmds: tCmds,
    preCmds,
    cmds,
  });

  return {
    ok: true,
    target: t.target,
    targetReason: t.reason,
    probe: p.probe,
    probeReason: p.reason,
    interfaceCfg: iface.path,
    targetCfg: tgt?.path ?? null,
    probeCmds: pCmds,
    targetCmds: tCmds,
    sequence,
    openocdRoot: loc.root,
    openocdRootKind: loc.kind,
    speed: tSpeed ?? DEFAULT_SPEED,
  };
}

/**
 * 跑一次（计划 + 执行 + 诊断）。
 *
 * 这是调试工具层唯一的入口。
 */
export function runTarget(options = {}) {
  const plan = planRun(options);
  if (!plan.ok) {
    return {
      ok: false,
      phase: 'plan',
      reason: 'plan',
      spawnError: plan.error,
      plan,
      target: plan.target ?? null,
      probe: plan.probe ?? null,
      parsed: { errors: [], warnings: [], info: [], notes: [], targets: [], targetNames: [], registers: {}, flash: {}, memory: {}, hardware: {}, ports: {} },
      footerCmds: [],
    };
  }

  const timeoutMs = options.timeoutMs ?? TIMEOUTS.probe;
  const r = runOpenocd({
    sequence: plan.sequence,
    workdir: options.workdir,
    vendorRoot: options.vendorRoot,
    timeoutMs,
    sessionId: options.sessionId,
    label: options.label,
    footer: options.footer ?? 'run',
    noFooter: options.noFooter ?? false,
    logFile: options.logFile,
    probe: plan.probe,
  });

  return {
    ...r,
    phase: 'run',
    plan,
    target: plan.target,
    probe: plan.probe,
  };
}

/**
 * 把一次运行的结果翻译成「下一步该干什么」。
 *
 * 每条都带**具体动作**，不写「请检查硬件」这种没用的话。
 */
export function diagnose(r) {
  if (!r) return '（没有运行结果）';
  if (r.phase === 'plan') return `计划阶段就失败了：${r.spawnError}`;

  const errs = r.parsed?.errors ?? [];
  const joined = errs.join('\n');
  const tips = [];

  if (!r.spawnError && r.spawnError === undefined && r.reason === 'openocd-missing') {
    return `隔离副本缺 openocd.exe。把一份 0.12.0+ 的 openocd 树放回 \`vendor/openocd/\`（需要 bin/openocd.exe + scripts/）。`;
  }
  if (r.reason === 'cfg-missing') return `cfg 找不到：${r.spawnError}`;
  if (r.reason === 'bad-cmd') return `命令里带了 openocd 不接受的字符：${r.spawnError}`;
  if (r.reason === 'timeout') {
    return (
      'openocd 超时未退出 —— **多半是它连着目标但不肯松手**。' +
      '下一步：`mcu_clean` 看还有没有残留进程，然后 `action: "kill"` 清掉再重试。' +
      '读大块 flash 时把 `-c` 数改小或加大 timeoutMs。'
    );
  }

  if (/No CMSIS-DAP device found|Could not find.*CMSIS-DAP|Failed to open CMSIS-DAP|unable to find a matching CMSIS-DAP/i.test(joined)) {
    /*
     * 这一条是本插件最容易把人带偏的失败，所以单独把探针表里的**模式判定**接进来。
     *
     * 原因：`unable to find a matching CMSIS-DAP device` 是 openocd 的一句笼统话，
     * 底下可能是三件完全不同的事 —— 驱动没加载、探针在别的模式里、或者探针压根没插。
     * 不把探针表的证据摆出来，调用方会默认去怀疑接线和插件。
     */
    const cap = r?.probe?.capability;
    const probeBit = r?.probe
      ? `你锁的是 ${r.probe.label} [${r.probe.vidpid}] serial=${r.probe.serial ?? '(无)'}。`
      : '';
    if (cap?.blocks && cap.fix) {
      tips.push(
        `CMSIS-DAP 打不开，而且**探针表已经指出了原因**：${cap.reason}\n` +
          `${probeBit}\n` +
          `→ ${cap.fix}\n` +
          `（这条不是插件的问题，换探针参数重试也没用 —— 得先把探针弄到能说 CMSIS-DAP 的状态。）`,
      );
    } else {
      tips.push(
        'CMSIS-DAP 打不开。按序查：① `mcu_probes` 看目标探针的**驱动错误码与模式**' +
          '（39 = 驱动被签名策略拒了；WCH-Link 处在 RISC-V 模式时不说 CMSIS-DAP —— 这两种都不是插件问题）；' +
          `② 有没有别的进程占着探针（\`mcu_clean\`）；③ \`adapter serial\` 是否已锁到实际插着的那个。${probeBit}`,
      );
    }
  }
  if (/adapter serial .* not found|device with serial/i.test(joined)) {
    tips.push('`adapter serial` 指定的序列号没找到 —— 序列号抄错了，或那个探针没插/被换了。`mcu_probes` 列的是当前真实值。');
  }
  if (/Target not halted|target not halted/i.test(joined)) {
    tips.push('目标没停住。这是**清理断点时的正常失败**（清断点必须在 halt 状态）；若出现在别处，加 `-c halt` 或先 `mcu_reset kind:"halt"`。');
  }
  if (/was not expecting value|invalid command name/i.test(joined)) {
    tips.push('TCL 说命令不存在或参数不对 —— 常见原因是 cfg 名字写错、或命令里混进了双引号/反斜杠。');
  }
  if (/Read-Protect Status Currently Enabled|protected/i.test(joined) && /erase|program|write/i.test(joined)) {
    tips.push('flash 处于**读保护**：先跑 `mcu_erase mode:"unprotect"`（会整片解除保护，注意这会擦掉全部内容）。');
  }
  if (/Could not open file|No such file or directory/i.test(joined)) {
    tips.push(
      '有文件打不开。若路径含中文，是 Jim-TCL 的 GBK 解释问题 —— `mcu_env` 会报出 ASCII 镜像状态；' +
        '镜像没建好时插件第一次跑 openocd 会自动建。',
    );
  }
  if (/JTAG scan chain interrogation failed|SWD.*failed|Cannot read IDR|Error: Error connecting DP/i.test(joined)) {
    tips.push(
      '连不上 DP —— 接线/SWD 引脚/复位线/目标供电。**注意**：这条与「探针选错」在日志里长得一样，所以先用 `mcu_probes` 确认锁对了探针。',
    );
  }
  if (/auto-detect|Cannot identify target|unknown device/i.test(joined)) {
    tips.push('自动识别型号失败：型号猜错了，或这颗芯片不在 cfg 支持列表里。用 `mcu_devices` 换个族级 cfg 再试。');
  }
  if (/clock speed|adapter speed/i.test(joined) && /fail/i.test(joined)) {
    tips.push('时钟设太快/太慢。降速：把 `speed` 设成 1000 或 500（kHz）。');
  }
  if (/Timed out.*waiting for target/i.test(joined)) {
    tips.push('等目标响应超时 —— 通常是**目标没上电**或 nRESET 被拉死。');
  }

  if (tips.length === 0) {
    if (errs.length === 0 && r.ok) return '没有发现异常。';
    return errs.length ? '见上面的 Error 行原文。' : '没有匹配到已知症状，看完整 stdout（报告里已附）。';
  }
  return tips.join('\n');
}

/** 目标 + 探针的一段人话摘要（每个报告头部都用它）。 */
export function planHeader(r) {
  const t = r?.target;
  const p = r?.probe;
  const lines = [];
  if (t) lines.push(`目标 ：${t.id}  （${t.cfg}，${t.core ?? '内核以 cfg 为准'}）`);
  if (p) {
    lines.push(
      `探针 ：${p.label}  [${p.vidpid}]  serial=${p.serial ?? '(无)'}` +
        (p.serialUsable ? '' : '  ←这个序列号不可用于 adapter serial'),
    );
  }
  if (r?.plan?.probeReason) lines.push(`选择 ：${r.plan.probeReason}`);
  if (r?.plan?.targetReason) lines.push(`目标解析：${r.plan.targetReason}`);
  return lines.join('\n');
}

/** 目标详情块（给报告用）。 */
export function targetBlock(t) {
  return targetSummary(t);
}

/** 把探针表渲染成文本（给 `mcu_probes` 用）。 */
export function probeTable(probes) {
  return renderProbeTable(probes);
}

/** 报告里统一的工作目录展示。 */
export function workdirLine(dir) {
  return dir ? toSlash(dir) : '(未创建)';
}
