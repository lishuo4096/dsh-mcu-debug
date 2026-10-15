/**
 * A 组：环境与台账工具（**全部只读，不碰目标、不碰探针**）。
 *
 * 这一组的定位是「动手之前先看清现场」：本机有哪些调试器、隔离副本能不能用、
 * 目标是什么型号、固件在哪、上次有没有留下脏东西。
 *
 * 每个工具都遵守 `lib/result.js` 的返回约定：**返回数据不抛异常**，
 * 普通失败（连不上、目录不存在）是 `ok:false` + `code`，只有参数写错才抛。
 *
 * @module lib/tools-env
 */

import { existsSync } from 'node:fs';
import { defineTool } from './define-tool.js';
import { clip, fail, fmtBytes, kvBlock, ok, output } from './result.js';
import {
  eideRoot,
  findToolchains,
  listIdeOpenocds,
  listOpenocdProcesses,
  powershellExe,
  probeEnvironment,
  runRoot,
  toSlash,
} from './env.js';
import { DEFAULT_TARGET, FAMILIES, listTargets, scanFirmwareProjects, TARGETS, targetSummary } from './devices.js';
import { isPositionSerial, listProbes } from './probes.js';
import { mirrorBytes, mirrorStatus, removeMirror } from './mirror.js';
import { auditWorkspace, listSessionDirs, pruneSessionDirs, quarantineFiles, scanWorkspace } from './hygiene.js';
import { locateOpenocd } from './ocd.js';
import { planProbe, probeArg, readDefaults, writeDefaults } from './run.js';

/** 校验参数（供工具定义用）。 */
const SPEED = { type: 'integer', description: '适配器时钟（kHz）。PY32F030 默认 1000，通信稳的话可以提到 4000。', minimum: 1 };

// ------------------------------------------------------------- mcu_env

function renderEnv(e) {
  const L = [];
  L.push('=== 隔离 openocd ===');
  L.push(
    kvBlock([
      ['执行根', toSlash(e.openocd?.root ?? '(无)')],
      ['形态', e.openocd?.kind === 'mirror' ? 'ASCII 镜像（路径无中文，最稳）' : '插件 vendor 原树'],
      ['exe', toSlash(e.openocd?.exe ?? '(无)')],
      ['exe 存在', e.openocd?.present ? `是（${fmtBytes(e.openocd.bytes)}）` : '否'],
      ['脚本库', toSlash(e.openocd?.scripts ?? '(无)')],
      ['版本', e.openocd?.version ?? '(读不出来)'],
      ['有 PY32 cfg', e.openocd?.hasPy32 ? '是' : '否'],
      ['有 STM32 cfg', e.openocd?.hasStm32 ? '是' : '否'],
    ]),
  );
  L.push('');
  L.push('=== ASCII 镜像 ===');
  L.push(kvBlock([
    ['需要镜像', e.mirror?.needed ? '是（插件路径含非 ASCII）' : '否（插件路径已是纯 ASCII）'],
    ['镜像状态', e.mirror?.usable ? `可用（${e.mirror.kind}）` : `不可用：${e.mirror?.reason ?? '(未知)'}`],
    ['镜像路径', toSlash(e.mirror?.dst ?? '(无)')],
    ['镜像指向', e.mirror?.target ? toSlash(e.mirror.target) : '(不是链接，是复制)'],
    ['openocd.exe', fmtBytes(mirrorBytes())],
  ]));
  L.push('');
  L.push('=== IDE 侧 openocd（**只作对照，永不被本插件执行**）===');
  if (!e.ide?.length) L.push('  （没找到）');
  for (const o of e.ide ?? []) {
    L.push(`  ${toSlash(o.root)}`);
    L.push(`    版本 ${o.version ?? '?'}   PY32 ${o.hasPy32 ? '有' : '无'}   STM32 ${o.hasStm32 ? '有' : '无'}`);
  }
  L.push('');
  L.push('=== ARM 工具链（只有 gdb 是 `mcu_gdb` 必需的）===');
  L.push(
    kvBlock([
      ['gcc', e.toolchain?.gcc ? toSlash(e.toolchain.gcc) : '(没有 —— 不影响调试/烧录)'],
      ['gdb', e.toolchain?.gdb ? toSlash(e.toolchain.gdb) : '(没有 —— `mcu_gdb` 不可用)'],
      ['objcopy', e.toolchain?.objcopy ? toSlash(e.toolchain.objcopy) : '(没有)'],
      ['objdump', e.toolchain?.objdump ? toSlash(e.toolchain.objdump) : '(没有)'],
    ]),
  );
  L.push('');
  L.push('=== 运行态 ===');
  L.push(
    kvBlock([
      ['会话目录根', toSlash(runRoot())],
      ['PowerShell', toSlash(powershellExe())],
      ['残留 openocd', e.openocdProcesses?.length ? `${e.openocdProcesses.length} 个（PID ${e.openocdProcesses.map((p) => p.pid).join(', ')}）` : '无'],
      ['OPENOCD_SCRIPTS', e.openocdScriptsEnv ? `${e.openocdScriptsEnv}  ←spawn 时会被摘掉` : '(未设)'],
      ['记住的探针', readDefaults().probe ? `${readDefaults().probeLabel ?? '?'}（${readDefaults().probe}）` : '(还没记住，第一次用会自动定)'],
    ]),
  );

  if (e.warnings?.length) {
    L.push('');
    L.push('=== 警告 ===');
    for (const w of e.warnings) L.push(`  ! ${w}`);
  } else {
    L.push('');
    L.push('没有警告。');
  }
  return L.join('\n');
}

/** 把 `electron-ish` 的原始探测结果整理成工具返回值。 */
function buildEnvSnapshot() {
  const base = probeEnvironment();
  const loc = locateOpenocd();
  return {
    ...base,
    openocd: {
      root: loc.root,
      exe: loc.exe,
      scripts: loc.scriptsDir,
      present: loc.present,
      kind: loc.kind,
      bytes: base.vendor?.bytes ?? 0,
      version: base.vendor?.version ?? null,
      hasPy32: base.vendor?.hasPy32 ?? false,
      hasStm32: base.vendor?.hasStm32 ?? false,
      note: loc.mirrorNote,
    },
  };
}

// ------------------------------------------------------------- mcu_devices

function renderTargets(rows) {
  const L = [];
  let lastFam = null;
  for (const t of rows) {
    if (t.family !== lastFam) {
      lastFam = t.family;
      L.push('');
      L.push(`--- ${FAMILIES[t.family]?.label ?? t.family} ---`);
    }
    L.push(
      `  ${t.id.padEnd(22)} ${t.cfg.padEnd(30)} ${t.core ?? ''}`.trimEnd() +
        `  约 ${t.flashKb ?? '?'}K/${t.ramKb ?? '?'}K` +
        (t.id === DEFAULT_TARGET ? '   ←本机默认' : ''),
    );
  }
  return L.join('\n').trim();
}

// ------------------------------------------------------------- mcu_probes

function renderProbes(probes, defaults) {
  if (!probes?.length) return '(没有识别到任何 USB 调试器)';
  const L = [];
  for (const p of probes) {
    const flag = p.usable ? '可用' : '不可用';
    L.push(`● ${p.label}  [${p.vidpid}]  ${flag}`);
    L.push(
      kvBlock(
        [
          ['序列号', p.serial ?? '(无)'],
          ['序列号可用', p.serialUsable ? '是（可用作 adapter serial）' : '否 —— 这是总线位置串，换 USB 口就变'],
          ['接口 cfg', p.interfaceCfg ?? '(这一类没有可直接用的 interface cfg)'],
          ['驱动', p.errorCode ? `错误码 ${p.errorCode}：${p.errorText}` : `正常（Service=${p.service || '?'}）`],
          ['实例', p.instanceId],
          ['指名参数', p.usable ? `probe: "${probeArg(p)}"` : '(不可用)'],
        ].map(([k, v]) => [`  ${k}`, v]),
      ),
    );
    for (const c of p.children ?? []) {
      L.push(`    └ 子接口 ${c.interfaceNumber ?? '?'}：${c.name}${c.errorCode ? `  ← 错误码 ${c.errorCode}` : ''}`);
    }
    for (const pr of p.problems ?? []) L.push(`    ! ${pr}`);
    if (p.note) L.push(`    · ${p.note}`);
    L.push('');
  }
  if (defaults?.probe) L.push(`已记住的默认探针：${defaults.probeLabel ?? '?'}（${defaults.probe}）`);
  else L.push('还没有记住默认探针；当全机只有唯一可用探针时会自动定下并写入 defaults.json。');
  return L.join('\n');
}

// ------------------------------------------------------------- mcu_projects

function renderProjects(r) {
  const L = [];
  L.push(`扫描根：${toSlash(r.root)}`);
  L.push(`工程文件：${r.projects.length} 个    固件：${r.firmwares.length} 个`);
  if (r.projects.length) {
    L.push('');
    L.push('=== 工程 ===');
    const { rows } = clip(r.projects, 40);
    for (const p of rows) L.push(`  [${p.kind}] ${toSlash(p.path)}`);
  }
  if (r.firmwares.length) {
    L.push('');
    L.push('=== 固件（按新鲜度排序，最新的在前）===');
    const { rows } = clip(r.firmwares, 40);
    for (const f of rows) {
      const age = Math.round(f.ageMs / 60000);
      L.push(`  ${fmtBytes(f.bytes).padStart(9)}  ${age < 180 ? `${age} 分钟前` : `${Math.round(age / 60)} 小时前`}  ${toSlash(f.path)}`);
    }
  }
  if (r.errors?.length) {
    L.push('');
    L.push('=== 读不下去的目录 ===');
    for (const e of clip(r.errors, 10).rows) L.push(`  ${e}`);
  }
  return L.join('\n');
}

// ------------------------------------------------------------- mcu_help

const HELP_TOPICS = {
  first_time: [
    '# 从零到烧上（本机已有的硬件）',
    '',
    '1. `mcu_env` —— 看副本、镜像、探针、残留进程。这一步发现的问题，后面所有步骤都受它影响。',
    '2. `mcu_probes` —— **记下你要用的那个探针的 serial**。本机插着不止一个调试器，不锁定就会连错。',
    '3. `mcu_probe` —— 真连一次，确认认得出内核、读得到 flash 容量。带 `probe: "<serial>"`。',
    '4. `mcu_flash` —— 烧固件。**必须给 elf/hex**，裸 bin 要另给 `address`。',
    '5. `mcu_reset mode:"run"` —— 确认程序真的在跑（不要停在调试态）。',
    '6. `mcu_serial_list` 看目标的串口是哪个，再 `mcu_serial_open` 收日志。',
    '',
    '收尾：`mcu_clean action:"audit"` 看这次留下了什么。',
  ].join('\n'),

  not_connecting: [
    '# 连不上（openocd 报 No CMSIS-DAP device / unable to find a matching CMSIS-DAP device）',
    '',
    '**先分清是哪一层断的**，这四层的现象长得一样但修法完全不同：',
    '',
    'A. 驱动层 —— `mcu_probes` 看错误码。',
    '   - 代码 39：驱动被拒绝加载（Windows 内存完整性 / 签名策略）。这是**系统设置**问题，插件改不了。',
    '   - 代码 28：驱动没装。装 WinUSB/libusb 驱动（Zadig 之类）。',
    '   - 代码 52：签名验证失败。',
    'B. **模式层** —— 探针插着、驱动也正常，但它此刻**不说 CMSIS-DAP**。',
    '   典型：WCH-Link 在 RISC-V 模式下（子接口名带 `WCH-LinkRV`）走厂商私有 SDI，',
    '   普通 openocd 打不开；DAPLink 处于 U 盘/引导模式（`0d28:0202/0203`）同理。',
    '   `mcu_probes` 会直接把这个判定写出来 —— **这层最容易被误判成「探针没问题」**，',
    '   因为设备管理器里它一个惊叹号都没有。',
    'C. 占用层 —— 别的进程抓着探针。`mcu_clean action:"scan"` 看有没有残留 openocd，有就 `action:"kill"`。',
    '   注意：IDE 的调试会话、厂商上位机（WCH-LinkUtility）也会占用。',
    'D. 物理/目标层 —— 接线、SWDIO/SWCLK 接反、目标没供电、nRESET 被拉死、SWD 引脚被固件复用成 GPIO。',
    '',
    '判定技巧（按这个顺序切，能一次减一半）：',
    '1. `mcu_probes` 的「不可用」那一栏有没有写出**根因**？写了就先解决它，别往下查。',
    '2. 同一根探针换个目标能不能连？能连 = 问题在目标侧；不能连 = 问题在探针侧。',
    '3. 速度降到 500 kHz 再试（杜邦线长、目标时钟没起振时低速更稳）。',
  ].join('\n'),

  multi_probe: [
    '# 本机插着多个调试器，怎么保证连的是对的那个',
    '',
    '问题：openocd 不带 `adapter serial` 时会自己挑「第一个能打开的设备」——',
    '**不报错**，只是把命令发给了另一个探针。更糟的是这个挑选结果不固定。',
    '',
    '本机实测的四个（`mcu_probes` 每次都会重新枚举）：',
    '  · DAPLink（mbed Composite Device，`0d28:0204`）—— 序列号是一串 32 位十六进制。',
    '    当前状态：**错误码 39，驱动加载失败**，USB 接口根本打不开。',
    '  · WCH-Link（`1a86:8010`）—— 序列号 `75438F06FAE0`。',
    '    当前状态：**处在 RISC-V 模式**（子接口里是 `WCH-LinkRV`），不说 CMSIS-DAP。',
    '    切到 ARM/DAP 模式后就能当 CMSIS-DAP 用。',
    '  · FTDI（`0403:6010` = FT2232H，序列号 `ALT232H0001`）—— **这个芯片本身是能当调试器的**，',
    '    走 `interface/ftdi/*.cfg`（不是 cmsis-dap），要按实际接法选 cfg，本插件不自动挑。',
    '  · FTDI（`0403:6014`）—— 纯 USB 转串口。它的「序列号」形如 `9&3342557&0&3`',
    '    是**总线位置串**不是真序列号，换 USB 口就变，不能用于 adapter serial。',
    '',
    '做法：',
    '1. `mcu_probes` —— 复制你要那个的 `serial`。',
    '2. 之后每个工具都带 `probe: "<serial>"`。',
    '3. 只写一次也行：第一次运行时若全机只有唯一可用探针，插件会把它记进 `.run/defaults.json`；',
    '   之后不传 `probe` 就用记住的那个。用 `mcu_probes` 的 `remember` 参数可以随时改。',
    '',
    '插件**不会在有多个可用探针时替你猜** —— 那正是出错的场景。',
    '它宁可报错并把每个探针的 serial 列出来，也不静默挑一个。',
    '',
    '## 设备管理器的「正常」不等于「能用」',
    '',
    '这是本插件打过的唯一一个真跟头：曾经把「PnP 状态正常」当成「探针可用」，',
    '结果 WCH-Link 在 RISC-V 模式下被报成「可用」，`mcu_probe` 一跑就报',
    '「unable to find a matching CMSIS-DAP device」，而探针表却说它没问题 ——',
    '调用方只能去怀疑接线和插件。',
    '',
    '现在的判据分三级，缺一不可：',
    '  1. 设备管理器没有错误码（驱动层）',
    '  2. 有对应的 interface cfg（插件层）',
    '  3. **模式对得上**（能不能说 CMSIS-DAP）—— 这一条只能从子接口名字里读，',
    '     顶层复合设备看不出来，所以插件必须把子接口挂回父设备。',
  ].join('\n'),

  flash_ok_but_dead: [
    '# 烧录成功，板子却不动',
    '',
    '按可能性排序，逐条排除：',
    '',
    '1. **目标停在调试态**。只 `program` 不 `reset run`，核心停在 halt —— 现象和「烧失败」一模一样。',
    '   本插件默认收尾里就有 `reset run`，报告里的「收尾命令」能看见它跑过。手动验证：`mcu_reset mode:"run"`。',
    '2. **BOOT 引脚 / 启动模式**。BOOT0 被拉高会进系统 bootloader，不跑你的代码。',
    '3. **烧的地址不对**。裸 .bin 必须给 `address`（PY32/STM32 是 `0x08000000`）；',
    '   给了错的地址，内容写进去了但向量表不在它该在的位置。',
    '4. **时钟/复位配置**。例如 PY32 的 cfg 在 `reset-init` 里把 HSI 切到 24 MHz；',
    '   如果你的固件假设别的时钟源，可能跑飞。',
    '5. **flash 读保护**：写进去的可能是被保护区域外的垃圾。`mcu_flash_info` 看保护状态。',
    '6. **硬件**：VDDA/VCAP/复位电容、晶振没起振。',
    '',
    '验证「到底有没有写进去」：`mcu_read_flash` 读回一段和源文件对比。',
  ].join('\n'),

  bp_residue: [
    '# 断点残留：为什么这是本插件最在意的事',
    '',
    '**现象**：某次调试用了断点，之后每次烧录的程序起来都「带着断点」——一跑就停。',
    '',
    '**机理**（两条，都要防）：',
    '',
    '1. **调试器侧的会话状态**。openocd 进程被强杀 / 会话没关就退出，',
    '   断点设置留在调试探针与目标调试单元的上下文里。',
    '2. **Cortex-M 的硬件比较器（FPB）**。`bp <addr>` 在 Cortex-M 上用的是 FPB，',
    '   改的是**调试寄存器**而不是 flash 内容。所以「清断点」是清寄存器，不是重写 flash。',
    '   FPB 只有 2–6 个比较器：用完了再 `bp` 会失败 —— 这是「断点越加越不灵」的真因。',
    '   某些驱动会 fallback 到**软件断点**（把 `bkpt` 写进 flash），那种才真的污染 flash。',
    '',
    '**插件的对策**：',
    '  · 每个写操作（烧录/擦除）**前**都先清一遍断点；',
    '  · 每个会话收尾**必做** `rbp` 逐个清 + `reset run`，顺序不能反；',
    '  · `rbp all` 流传很广但**未在 0.12 手册中确认**，所以插件用 `catch {foreach a [bp] { rbp $a }}` 逐个删；',
    '  · 会话目录里留 `session-record.txt`，能查「这次到底做了什么」。',
    '',
    '**你自己手敲 openocd 时最容易犯的错**：在 IDE 的工具树里直接跑 `openocd.exe` ——',
    '它的 CWD 里有厂商的 `ocd.cfg`，会被隐式 source，可能锁到另一个探针、或带上别的初始化。',
    '本插件永远显式 `-s <脚本库> -f <接口> -f <目标>`，且 CWD 是自己的私有会话目录。',
  ].join('\n'),

  target_support: [
    '# 支持哪些型号（以及不支持时怎么办）',
    '',
    '本插件不硬编码芯片，而是**把型号映射到 OpenOCD 的 target cfg**。',
    '所以「支持范围」= 副本脚本库里有哪些 cfg。',
    '',
    'PY32：`py32f001/f002a/f002b/f003/f030/f031/f040/f071/f072/f07x/f303/f403/l020/m010/m030/m070/c610/c611/c640/c641/c670`。',
    'STM32：F0/F1/F2/F3/F4/F7/G0/G4/H7/L0/L1/L4/L5/U5/WB/WL 各族级 cfg。',
    '',
    '**为什么一律用族级 cfg**：连上后读 IDCODE / DBGMCU_IDCODE 自己认型号，',
    '再由器件寄存器算真实 flash/RAM。比如 PY32F030 有 32K 和 64K 两种，',
    '族级 cfg（`FLASH_SIZE=0`）会读回真实值，写死反而会错。',
    '',
    '**不在表里怎么办**：`mcu_devices` 报「不认识型号」时会给出最近的候选。',
    '若确实没有对应 cfg，可以退一步：用最接近的族级 cfg 试（它会自动探测），',
    '或用 `mcu_ocd` 逃生舱直接给 `-c` 命令自己拼。',
  ].join('\n'),

  serial: [
    '# 收发串口',
    '',
    '本插件**不能用 DAPLink 的串口** —— 本机这个 DAPLink 只枚举出复合设备，没有 CDC 串口子接口。',
    '要收目标日志，得用单独的 USB 转串口：本机的 WCH-Link 带一路 `WCH-Link SERIAL`（COM21），',
    'FTDI 那两片是 COM37 / COM44。',
    '',
    '**接法**：目标的 TX → 转换板的 RX，RX → TX，GND 共地。',
    '',
    '流程：',
    '1. `mcu_serial_list` —— 看有哪些口、哪个是真实硬件（蓝牙虚拟口会被标出来）。',
    '2. `mcu_serial_open port:"COM21" baud:115200` —— 打开。',
    '3. `mcu_serial_rx` —— 收（带超时，收不到就返回已收到的部分，不会一直挂着）。',
    '4. `mcu_serial_tx text:"help\\r\\n"` —— 发。`\\r\\n` 这类转义会被解开。',
    '5. `mcu_serial_close` —— 关。',
    '',
    '**为什么要有 open/close**：串口是**独占资源**。',
    '开着不关，IDE 的串口终端、别的工具都打不开它，而且你也不会知道是谁占着。',
    '`mcu_serial_list` 会报出占用者。',
    '',
    '**收不到数据的顺序排查**：① 波特率；② TX/RX 有没有接反（最常见）；③ 共地；',
    '④ 目标那边是不是压根没 printf（先 `mcu_serial_tx` 发几个字节看有没有回显）；',
    '⑤ 有没有别的程序占着这个口。',
  ].join('\n'),

  sessions: [
    '# 持久会话（gdb server / telnet）',
    '',
    '一次性工具（`mcu_probe` / `mcu_flash` / …）每次都**开-做-关**，跑完自动 `reset run`。',
    '需要在同一连接上做很多事（反复读内存、gdb 单步）时，开持久会话更划算。',
    '',
    '`mcu_session_open target:"py32f030" probe:"<serial>"` → 常驻 openocd，监听 gdb/telnet/tcl 三个端口。',
    '`mcu_session_cmd id:"..." lines:["mdw 0x20000000 8"]` → 走 telnet 发命令。',
    '`mcu_gdb action:"load" elf:"build/app.elf"` → 用 arm-none-eabi-gdb 走 gdb server 下载符号/烧录/单步。',
    '`mcu_session_close id:"..."` → **先 telnet 清断点再 shutdown**，让进程自己退（不是强杀）。',
    '',
    '**为什么关会话要先清断点**：见 `bp_residue` 那篇。',
    '**为什么默认不强杀**：强杀等于跳过收尾 —— 正是「断点残留」的成因。',
    '真要强杀得显式 `force:true`，那时插件会提醒你之后先清断点再烧录。',
  ].join('\n'),

  tools: [
    '# 工具总览',
    '',
    '**环境台账（只读）**',
    '  mcu_env        副本/镜像/工具链/残留进程 一眼看全',
    '  mcu_devices    器件表（型号 → target cfg）',
    '  mcu_probes     **本机所有调试器**（含驱动错误码与可用 serial）',
    '  mcu_projects   扫目录找工程与固件',
    '  mcu_workspace  工作区卫生（audit / quarantine / prune）',
    '  mcu_help       就是你在看的这个',
    '',
    '**一次性操作（开-做-关，默认收尾 reset run）**',
    '  mcu_probe       连接自检（认内核、读 flash 容量、报探针序列号）',
    '  mcu_regs        读内核寄存器',
    '  mcu_mem         读内存（dump 成文件再本地 hexdump）',
    '  mcu_flash_info  flash 容量 / 页大小 / 读保护状态',
    '  mcu_read_flash  读回 flash（支持只读一段）',
    '  mcu_flash       烧录（**需 confirm:true**）',
    '  mcu_erase       擦除（**需 confirm:true**）',
    '  mcu_reset       复位（run / halt / init）',
    '  mcu_bp          断点观察窗：list / set / clear / clear-all + 残留体检（**只读，不写 flash**）',
    '  mcu_ocd         逃生舱：直接跑任意 openocd 命令',
    '',
    '**持久会话**',
    '  mcu_session_open / mcu_session_cmd / mcu_session_close / mcu_session_list / mcu_gdb / mcu_clean',
    '',
    '**串口**',
    '  mcu_serial_list / mcu_serial_open / mcu_serial_tx / mcu_serial_rx / mcu_serial_close',
    '',
    '不确定从哪开始 → `mcu_help topic:"first_time"`。',
  ].join('\n'),
};

// ------------------------------------------------------------- 注册

export function registerEnvTools(ctx) {
  const tools = [
    defineTool({
      name: 'mcu_env',
      description:
        '环境自检（只读）：隔离 openocd 副本的路径/版本/PY32 与 STM32 cfg 是否齐、ASCII 镜像状态、' +
        'IDE 侧 openocd（只作对照）、ARM 工具链、残留 openocd 进程、记住的默认探针。' +
        '动手前先跑它——副本缺失或镜像没建好，后面所有工具都会以奇怪的方式失败。',
      parameters: { type: 'object', properties: { rebuildMirror: { type: 'boolean', description: 'true = 强制重建 ASCII 镜像（copy 方式失败时用）。默认 false 只报告状态。' } } },
      output,
      async execute(args) {
        const e = buildEnvSnapshot();
        if (args.rebuildMirror) {
          const r = removeMirror();
          const after = buildEnvSnapshot();
          return ok(`${renderEnv(after)}\n\n（已请求重建镜像：${r.message ?? r.error ?? 'ok'}）`, { env: after });
        }
        return ok(renderEnv(e), { env: e });
      },
    }),

    defineTool({
      name: 'mcu_devices',
      description:
        '器件表：型号 → OpenOCD target cfg 的映射。不带参数时列全部；带 name 时解析型号（支持别名、' +
        '带封装的全型号、cfg 路径），解析失败会给出最近的候选而不是猜。' +
        '插件一律走**族级 cfg**（连上后由 IDCODE 自动认型号与容量），所以 PY32F030 的 32K/64K 两种都能对。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '型号或别名，如 py32f030 / PY32F030K18 / stm32f103c8t6 / f103 / target/stm32f4x.cfg' },
          family: { type: 'string', enum: ['py32', 'stm32'], description: '只列某一族' },
          grep: { type: 'string', description: '按关键字过滤' },
        },
      },
      output,
      async execute(args) {
        if (args.name) {
          const r = listTargets({ grep: args.name, limit: 8 });
          const t = TARGETS.find((x) => x.id.toLowerCase() === String(args.name).trim().toLowerCase());
          if (t) return ok(targetSummary(t), { target: t });
          return ok(
            `器件表里没有「${args.name}」这个精确条目。相近的有：\n${renderTargets(r.rows)}\n\n` +
              '（提示：多数情况下直接用型号名即可，插件会按别名/前缀自动落到族级 cfg。）',
            { rows: r.rows },
          );
        }
        const r = listTargets({ family: args.family, grep: args.grep });
        const head = `器件表共 ${TARGETS.length} 条，当前列出 ${r.rows.length} 条（默认目标是 ${DEFAULT_TARGET}）。`;
        const tail =
          '\n\n用法：把型号名直接传给 `target` 参数（如 target:"py32f030"）。' +
          '\n工具内一律使用**族级 cfg**：连上后读 IDCODE / DBGMCU_IDCODE 自动认型号与 flash/RAM，' +
          '所以同族不同容量（例如 PY32F030 的 32K 与 64K）都不会认错。';
        return ok(`${head}\n${renderTargets(r.rows)}${tail}`, { rows: r.rows, total: r.total });
      },
    }),

    defineTool({
      name: 'mcu_probes',
      description:
        '**本机有哪些调试器**（只读）。列出每个探针的 vid:pid、序列号、对应 interface cfg、' +
        'Windows 驱动错误码，以及能不能用作 adapter serial。多个调试器同时插着时，' +
        '必须先用它拿到 serial 再去调目标——openocd 不指定 serial 时会自己挑一个且不报错。' +
        '用 remember 参数可以把某个探针记为默认。',
      parameters: {
        type: 'object',
        properties: {
          remember: { type: 'string', description: '把这个值记为默认探针（serial / vid:pid / 名字片段），写进 .run/defaults.json' },
          forget: { type: 'boolean', description: 'true = 清掉记住的默认探针' },
          all: { type: 'boolean', description: 'true = 连"不可用"的也照原样列出（默认也会列，只是排在后面）' },
        },
      },
      output,
      async execute(args) {
        if (args.forget) {
          const w = writeDefaults({ probe: null, probeLabel: null });
          return ok(`已清掉记住的默认探针。${w.ok ? '' : `（写入失败：${w.error}）`}\n\n当前探针：\n${renderProbes(listProbes().probes, readDefaults())}`, {
            defaults: readDefaults(),
          });
        }
        if (args.remember) {
          const r = planProbe({ probe: args.remember });
          if (!r.ok) return fail('probe-not-found', `记不下这个探针：${r.error}`);
          const w = writeDefaults({ probe: probeArg(r.probe), probeLabel: r.probe.label });
          return ok(
            `已记住默认探针：${r.probe.label}（${probeArg(r.probe)}）${w.ok ? '' : `\n（写 defaults.json 失败：${w.error}）`}\n\n${renderProbes(listProbes().probes, readDefaults())}`,
            { probe: r.probe, defaults: readDefaults() },
          );
        }
        const list = listProbes();
        if (!list.ok) return fail('enum-failed', `枚举 USB 设备失败：${list.error}`, { error: list.error });
        return ok(renderProbes(list.probes, readDefaults()), { probes: list.probes, defaults: readDefaults(), deviceCount: list.deviceCount });
      },
    }),

    defineTool({
      name: 'mcu_projects',
      description:
        '扫一个目录找工程文件（Keil .uvprojx / CubeMX .ioc / EIDE .eide.json / CMakeLists / platformio.ini）' +
        '与固件（.elf/.hex/.bin/.s19）。只找入口，不解析私有格式。用来回答「固件在哪、是哪个工程产的」。',
      parameters: {
        type: 'object',
        properties: { root: { type: 'string', description: '扫描根目录（绝对路径）。省略则扫当前工作目录。' } },
      },
      output,
      async execute(args, exec) {
        const root = args.root ?? exec?.cwd ?? process.cwd();
        if (!existsSync(root)) return fail('no-such-dir', `目录不存在：${toSlash(root)}`);
        const r = scanFirmwareProjects(root);
        return ok(renderProjects(r), { scan: r });
      },
    }),

    defineTool({
      name: 'mcu_workspace',
      description:
        '工作区卫生。audit = 报告插件运行目录里有什么（会话目录、疑似被污染的 cfg/tcl/日志）；' +
        'quarantine = 把疑似污染文件挪进隔离区；prune = 删掉过期的会话目录；' +
        'sessions = 只列会话目录。本插件永远在自己的私有目录里干活，这个工具用来证明这一点、并收拾残局。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['audit', 'scan', 'quarantine', 'prune', 'sessions'], description: '默认 audit', default: 'audit' },
          dir: { type: 'string', description: '要审计的目录（默认插件运行目录 .run）' },
          maxAgeHours: { type: 'integer', description: 'prune 的过期阈值（小时），默认 24' },
          paths: { type: 'array', items: { type: 'string' }, description: 'quarantine：要挪走的文件绝对路径列表' },
        },
      },
      output,
      async execute(args) {
        const action = args.action ?? 'audit';
        if (action === 'sessions') {
          const dirs = listSessionDirs({});
          if (!dirs.length) return ok('没有会话目录。', { sessions: [] });
          return ok(
            `会话目录 ${dirs.length} 个（根：${toSlash(runRoot())}）：\n` +
              dirs
                .map(
                  (d) =>
                    `  ${d.id}  ${fmtBytes(d.bytes ?? 0)}  ${d.files?.length ?? 0} 文件  ` +
                    `${d.mtime ? new Date(d.mtime).toLocaleString() : ''}${d.stale ? '  ←已过期' : ''}`,
                )
                .join('\n'),
            { sessions: dirs },
          );
        }
        if (action === 'prune') {
          const rs = pruneSessionDirs({ maxAgeHours: Number(args.maxAgeHours ?? 24) });
          const gone = rs.filter((r) => r.ok);
          return ok(
            `阈值 ${args.maxAgeHours ?? 24} 小时：检查 ${rs.length} 个，删掉 ${gone.length} 个。\n` +
              (gone.length ? gone.map((r) => `  - ${r.id}：${r.message ?? '已删'}`).join('\n') : '  （没有需要删的）'),
            { prune: rs },
          );
        }
        if (action === 'quarantine') {
          if (!args.paths?.length) return fail('no-paths', 'quarantine 需要 paths 参数（要挪走的文件列表）。');
          const rs = quarantineFiles(args.paths);
          const okN = rs.filter((r) => r.ok).length;
          return ok(
            `隔离 ${okN}/${rs.length} 个文件。\n` +
              rs.map((r) => `  ${r.ok ? '→' : '!'} ${toSlash(r.path)}${r.movedTo ? ` → ${toSlash(r.movedTo)}` : ''}${r.message ? `  (${r.message})` : ''}`).join('\n'),
            { quarantine: rs },
          );
        }
        const dir = args.dir ?? runRoot();
        const a = auditWorkspace({});
        const scan = scanWorkspace(dir);
        const L = [];
        L.push(`审计目录：${toSlash(dir)}`);
        L.push(`文件 ${scan.files?.length ?? 0} 个   疑似污染 ${scan.suspicious?.length ?? 0} 个   外泄迹象 ${scan.leaks?.length ?? 0} 个`);
        if (a.findings?.length) {
          L.push('');
          L.push('=== 审计发现 ===');
          for (const f of clip(a.findings, 30).rows) L.push(`  [${f.severity}] ${toSlash(f.where)}\n      ${f.what}\n      修法：${f.fix}`);
        }
        if (scan.suspicious?.length) {
          L.push('');
          L.push('=== 疑似污染（*.cfg / *.tcl / 日志 / 含 bp 命令）===');
          for (const s of clip(scan.suspicious, 40).rows) {
            L.push(`  ${toSlash(s.path)}${s.why?.length ? `   ← ${s.why.join('；')}` : ''}`);
          }
          L.push('');
          L.push('（这些多半是**别人**留下的：IDE 出厂自带、或历史人工操作。本插件的会话记录刻意不叫 *.cfg，就是为了能在这里一眼区分。）');
        }
        if (scan.leaks?.length) {
          L.push('');
          L.push('=== 外泄迹象 ===');
          for (const s of clip(scan.leaks, 20).rows) L.push(`  ${toSlash(s.path ?? s)}`);
        }
        if ((scan.files?.length ?? 0) > 0 && (scan.suspicious?.length ?? 0) === 0) {
          L.push('');
          L.push('=== 目录内容 ===');
          for (const f of clip(scan.files, 40).rows) L.push(`  ${f.type === 'dir' ? '[目录]' : fmtBytes(f.bytes ?? 0).padStart(9)}  ${f.name}`);
        }
        L.push('');
        L.push('私有运行区与副本体之外的目录**永不被本插件写入** —— 这个工具就是用来证明这一点的。');
        return ok(L.join('\n'), { audit: a, scan });
      },
    }),

    defineTool({
      name: 'mcu_help',
      description:
        '排错剧本。topic: first_time（从零到烧上）/ not_connecting（连不上）/ multi_probe（本机多个调试器怎么区分）' +
        '/ flash_ok_but_dead（烧成功但板子不动）/ bp_residue（断点残留的机理与本插件的对策）' +
        '/ target_support（型号覆盖范围）/ serial（串口收发）/ sessions（持久会话）/ tools（工具总览）。' +
        '不带 topic 时给工具总览。',
      parameters: { type: 'object', properties: { topic: { type: 'string', description: '剧本名，省略 = tools' } } },
      output,
      async execute(args) {
        const key = String(args.topic ?? 'tools').trim();
        const text = HELP_TOPICS[key];
        if (!text) return fail('no-topic', `没有「${key}」这个剧本。可选：${Object.keys(HELP_TOPICS).join(' / ')}`, { topics: Object.keys(HELP_TOPICS) });
        return ok(text, { topic: key });
      },
    }),
  ];

  for (const t of tools) ctx.tools.register(t);
  return tools.map((t) => t.name);
}

/** 本组工具名。 */
export const ENV_TOOL_NAMES = ['mcu_env', 'mcu_devices', 'mcu_probes', 'mcu_projects', 'mcu_workspace', 'mcu_help'];

export { HELP_TOPICS };
