/**
 * 器件表：型号 → OpenOCD target cfg。
 *
 * ## 为什么要「族级映射」而不是「一型号一条」
 *
 * OpenOCD 的 STM32/PY32 target cfg 分两种写法：
 *   - **族级**（`stm32f1x.cfg`、`py32f030.cfg`）：连上后读 IDCODE / DBGMCU_IDCODE
 *     自己认出具体型号，再由器件寄存器算出真实 flash/RAM 大小。
 *   - **型号级**：把型号写死。
 *
 * 我们一律走**族级**。理由：ID 寄存器是硬件事实，比人填的表可靠；
 * 而且用户手上那台 PY32F030 有两种 flash 容量（32K/64K），
 * 写死反而会错。`py32f030.cfg` 里 `FLASH_SIZE` 默认就是 `0`（= autodetect），
 * 正是这个设计。
 *
 * ## 别名策略
 *
 * 用户会说 `PY32F030`、`py32f030k18`、`stm32f103c8t6`、`F103`……
 * 这些都要能落到同一个 cfg 上。匹配顺序：精确 id → 别名 → 前缀 → 族关键字，
 * 全都不中就**报错并列出候选**，绝不猜。
 *
 * @module lib/devices
 */

import { existsSync, readdirSync, statSync } from 'node:fs';

/** 器件族元信息。 */
export const FAMILIES = {
  py32: {
    id: 'py32',
    label: 'PY32（普冉 Puya）',
    vendor: 'Puya',
    cfgPrefix: 'target/py32',
    core: 'Cortex-M0+ / M4（按型号）',
    flashBase: '0x08000000',
    ramBase: '0x20000000',
    defaultSpeed: 1000,
    note: 'PY32 需要 OpenOCD ≥ 0.12.0 的脚本库（older 版本里没有 py32f030.cfg）。',
  },
  stm32: {
    id: 'stm32',
    label: 'STM32（STMicroelectronics）',
    vendor: 'ST',
    cfgPrefix: 'target/stm32',
    core: 'Cortex-M0/M0+/M3/M4/M7/M33',
    flashBase: '0x08000000',
    ramBase: '0x20000000',
    defaultSpeed: 1000,
  },
};

/**
 * 目标定义表。
 *
 * `aliases` 一律**小写无分隔符**（匹配前会先规范化）。
 * `flashKb` / `ramKb` 只作为**兜底估算**（超时预算、报告展示），
 * 真值以 openocd 连上后读回的为准 —— 凡是写死的都是「典型值」。
 */
export const TARGETS = [
  // ================= PY32 =================
  { id: 'py32f001', family: 'py32', cfg: 'target/py32f001.cfg', aliases: ['f001'], flashKb: 16, ramKb: 2, note: 'PY32F001/F011 小容量入门型号。' },
  { id: 'py32f002a', family: 'py32', cfg: 'target/py32f002a.cfg', aliases: ['f002a', '002a'], flashKb: 20, ramKb: 3 },
  { id: 'py32f002b', family: 'py32', cfg: 'target/py32f002b.cfg', aliases: ['f002b', '002b'], flashKb: 24, ramKb: 3 },
  { id: 'py32f003', family: 'py32', cfg: 'target/py32f003.cfg', aliases: ['f003'], flashKb: 32, ramKb: 4 },
  {
    id: 'py32f030',
    family: 'py32',
    cfg: 'target/py32f030.cfg',
    aliases: ['f030', 'py32f030k18', 'py32f030c8', 'py32f030f16', 'py32f030x6', 'py32f030x8', 'py32f030k1', 'py32f030k6'],
    flashKb: 32,
    ramKb: 4,
    note: '本机实测目标就是这颗（Cortex-M0+，SWD）。cfg 里 FLASH_SIZE=0 = 自动探测真实容量（32K/64K 两种都有）。',
  },
  { id: 'py32f031', family: 'py32', cfg: 'target/py32f031.cfg', aliases: ['f031'], flashKb: 64, ramKb: 8 },
  { id: 'py32f040', family: 'py32', cfg: 'target/py32f040.cfg', aliases: ['f040'], flashKb: 64, ramKb: 8 },
  { id: 'py32f071', family: 'py32', cfg: 'target/py32f071.cfg', aliases: ['f071'], flashKb: 128, ramKb: 16 },
  { id: 'py32f072', family: 'py32', cfg: 'target/py32f072.cfg', aliases: ['f072'], flashKb: 128, ramKb: 16 },
  { id: 'py32f07x', family: 'py32', cfg: 'target/py32f07x.cfg', aliases: ['f07x'], flashKb: 128, ramKb: 16, note: 'F071/F072 的通用入口，容量交给自动探测。' },
  { id: 'py32f303', family: 'py32', cfg: 'target/py32f303.cfg', aliases: ['f303'], flashKb: 64, ramKb: 8 },
  { id: 'py32f403', family: 'py32', cfg: 'target/py32f403.cfg', aliases: ['f403'], core: 'Cortex-M4', flashKb: 256, ramKb: 32 },
  { id: 'py32l020', family: 'py32', cfg: 'target/py32l020.cfg', aliases: ['l020'], flashKb: 64, ramKb: 8, note: '低功耗系列。' },
  { id: 'py32m010', family: 'py32', cfg: 'target/py32m010.cfg', aliases: ['m010'], flashKb: 32, ramKb: 4 },
  { id: 'py32m030', family: 'py32', cfg: 'target/py32m030.cfg', aliases: ['m030'], flashKb: 64, ramKb: 8 },
  { id: 'py32m070', family: 'py32', cfg: 'target/py32m070.cfg', aliases: ['m070'], flashKb: 128, ramKb: 16 },
  { id: 'py32c610', family: 'py32', cfg: 'target/py32c610.cfg', aliases: ['c610'], flashKb: 32, ramKb: 4 },
  { id: 'py32c611', family: 'py32', cfg: 'target/py32c611.cfg', aliases: ['c611'], flashKb: 64, ramKb: 8 },
  { id: 'py32c640', family: 'py32', cfg: 'target/py32c640.cfg', aliases: ['c640'], flashKb: 64, ramKb: 8 },
  { id: 'py32c641', family: 'py32', cfg: 'target/py32c641.cfg', aliases: ['c641'], flashKb: 128, ramKb: 16 },
  { id: 'py32c670', family: 'py32', cfg: 'target/py32c670.cfg', aliases: ['c670'], flashKb: 128, ramKb: 16 },

  // ================= STM32（族级） =================
  {
    id: 'stm32f0x',
    family: 'stm32',
    cfg: 'target/stm32f0x.cfg',
    aliases: ['f0', 'stm32f030', 'stm32f031', 'stm32f042', 'stm32f051', 'stm32f070', 'stm32f071', 'stm32f072', 'stm32f091', 'stm32f030c8t6'],
    core: 'Cortex-M0',
    flashKb: 64,
    ramKb: 8,
    note: 'F0 全系（F030/F031/F042/F051/F070/F071/F072/F091…）。型号前缀匹配按「最长 id 优先」，所以 stm32f030x8 会落到这里、stm32f103c8t6 会落到 stm32f1x，不会互相抢。',
  },
  { id: 'stm32f1x', family: 'stm32', cfg: 'target/stm32f1x.cfg', aliases: ['f1', 'stm32f100', 'stm32f101', 'stm32f102', 'stm32f103', 'stm32f103c8t6', 'stm32f103cbt6', 'stm32f103zet6', 'stm32f105', 'stm32f107', 'c8t6', 'bluepill'], core: 'Cortex-M3', flashKb: 64, ramKb: 20 },
  { id: 'stm32f2x', family: 'stm32', cfg: 'target/stm32f2x.cfg', aliases: ['f2', 'stm32f205', 'stm32f207', 'stm32f215', 'stm32f217'], core: 'Cortex-M3', flashKb: 1024, ramKb: 128 },
  { id: 'stm32f3x', family: 'stm32', cfg: 'target/stm32f3x.cfg', aliases: ['f3', 'stm32f301', 'stm32f302', 'stm32f303', 'stm32f334', 'stm32f373', 'stm32f398'], core: 'Cortex-M4', flashKb: 256, ramKb: 40 },
  { id: 'stm32f4x', family: 'stm32', cfg: 'target/stm32f4x.cfg', aliases: ['f4', 'stm32f401', 'stm32f405', 'stm32f407', 'stm32f411', 'stm32f429', 'stm32f446', 'stm32f469'], core: 'Cortex-M4', flashKb: 1024, ramKb: 192 },
  { id: 'stm32f7x', family: 'stm32', cfg: 'target/stm32f7x.cfg', aliases: ['f7', 'stm32f722', 'stm32f745', 'stm32f746', 'stm32f767', 'stm32f779'], core: 'Cortex-M7', flashKb: 1024, ramKb: 320 },
  { id: 'stm32g0x', family: 'stm32', cfg: 'target/stm32g0x.cfg', aliases: ['g0', 'stm32g030', 'stm32g031', 'stm32g041', 'stm32g051', 'stm32g061', 'stm32g070', 'stm32g071', 'stm32g081', 'stm32g0b1'], core: 'Cortex-M0+', flashKb: 128, ramKb: 36 },
  { id: 'stm32g4x', family: 'stm32', cfg: 'target/stm32g4x.cfg', aliases: ['g4', 'stm32g431', 'stm32g441', 'stm32g474', 'stm32g484', 'stm32g491'], core: 'Cortex-M4', flashKb: 512, ramKb: 128 },
  { id: 'stm32h7x', family: 'stm32', cfg: 'target/stm32h7x.cfg', aliases: ['h7', 'stm32h723', 'stm32h743', 'stm32h745', 'stm32h750', 'stm32h753'], core: 'Cortex-M7', flashKb: 2048, ramKb: 1024, note: '单 bank 用法。双 bank 变体见 stm32h7x_dual_bank。' },
  { id: 'stm32h7x_dual_bank', family: 'stm32', cfg: 'target/stm32h7x_dual_bank.cfg', aliases: ['h7dual', 'stm32h745dual', 'stm32h747'], core: 'Cortex-M7 + M4', flashKb: 2048, ramKb: 1024 },
  { id: 'stm32l0', family: 'stm32', cfg: 'target/stm32l0.cfg', aliases: ['l0', 'stm32l010', 'stm32l021', 'stm32l031', 'stm32l041', 'stm32l051', 'stm32l071', 'stm32l081'], core: 'Cortex-M0+', flashKb: 192, ramKb: 20, note: '注意 cfg 文件名是 `stm32l0.cfg`（不带 x）。' },
  { id: 'stm32l0_dual_bank', family: 'stm32', cfg: 'target/stm32l0_dual_bank.cfg', aliases: ['l0dual'], core: 'Cortex-M0+', flashKb: 192, ramKb: 20 },
  { id: 'stm32l1', family: 'stm32', cfg: 'target/stm32l1.cfg', aliases: ['l1', 'stm32l100', 'stm32l151', 'stm32l152', 'stm32l162'], core: 'Cortex-M3', flashKb: 512, ramKb: 80, note: '注意 cfg 文件名是 `stm32l1.cfg`（不带 x）。' },
  { id: 'stm32l1x_dual_bank', family: 'stm32', cfg: 'target/stm32l1x_dual_bank.cfg', aliases: ['l1dual'], core: 'Cortex-M3', flashKb: 512, ramKb: 80 },
  { id: 'stm32l4x', family: 'stm32', cfg: 'target/stm32l4x.cfg', aliases: ['l4', 'stm32l431', 'stm32l432', 'stm32l451', 'stm32l452', 'stm32l471', 'stm32l475', 'stm32l476', 'stm32l496'], core: 'Cortex-M4', flashKb: 1024, ramKb: 128 },
  { id: 'stm32l5x', family: 'stm32', cfg: 'target/stm32l5x.cfg', aliases: ['l5', 'stm32l552', 'stm32l562'], core: 'Cortex-M33', flashKb: 512, ramKb: 256 },
  { id: 'stm32u5x', family: 'stm32', cfg: 'target/stm32u5x.cfg', aliases: ['u5', 'stm32u535', 'stm32u545', 'stm32u575', 'stm32u585', 'stm32u595'], core: 'Cortex-M33', flashKb: 2048, ramKb: 786 },
  { id: 'stm32wbx', family: 'stm32', cfg: 'target/stm32wbx.cfg', aliases: ['wb', 'stm32wb55', 'stm32wb15', 'stm32wb35', 'stm32wb50', 'stm32wb5m'], core: 'Cortex-M4 + M0+', flashKb: 1024, ramKb: 256 },
  { id: 'stm32wlx', family: 'stm32', cfg: 'target/stm32wlx.cfg', aliases: ['wl', 'stm32wl54', 'stm32wl55', 'stm32wle5'], core: 'Cortex-M4 + M0+', flashKb: 256, ramKb: 64 },
];

/** 默认目标：本机实测那颗。 */
export const DEFAULT_TARGET = 'py32f030';

/** 规范化：小写、去掉 `-_/ ` 与常见封装后缀干扰。 */
export function normalize(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-_]/g, '')
    .replace(/^stm32/, 'stm32')
    .replace(/\.cfg$/, '');
}

/**
 * 解析型号 → 目标定义。
 *
 * @returns `{ok, target, reason, candidates}`
 */
export function resolveTarget(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return { ok: false, reason: '没有给型号', candidates: [] };

  // cfg 路径直接给也行：`target/py32f030.cfg` 或 `py32f030.cfg`
  const byCfg = TARGETS.find((t) => t.cfg.toLowerCase().endsWith(normalize(raw).replace(/^target\//, '') + '.cfg'));
  if (byCfg) return { ok: true, target: byCfg, reason: `按 cfg 名命中 ${byCfg.id}` };

  const n = normalize(raw);

  // 1) 精确 id
  const exact = TARGETS.find((t) => normalize(t.id) === n);
  if (exact) return { ok: true, target: exact, reason: `精确命中 ${exact.id}` };

  // 2) 别名精确
  const alias = TARGETS.find((t) => t.aliases.some((a) => normalize(a) === n));
  if (alias) return { ok: true, target: alias, reason: `按别名命中 ${alias.id}` };

  // 3) 前缀：用户给了带封装的完整型号（py32f030k18 / stm32f103c8t6）
  //    取「最长 id 前缀」那个，避免 f0 抢走 f030。
  const prefixed = TARGETS.filter((t) => n.startsWith(normalize(t.id))).sort((a, b) => b.id.length - a.id.length);
  if (prefixed.length && prefixed[0].id.length >= 4) {
    return { ok: true, target: prefixed[0], reason: `按型号前缀命中 ${prefixed[0].id}` };
  }

  // 4) 别名前缀
  for (const t of TARGETS) {
    for (const a of t.aliases) {
      if (a.length >= 4 && n.startsWith(normalize(a))) {
        return { ok: true, target: t, reason: `按别名前缀 ${a} 命中 ${t.id}` };
      }
    }
  }

  // 5) 给个近邻建议（编辑距离式：只看公共前缀长度）
  const near = TARGETS.map((t) => ({ t, score: commonPrefix(n, normalize(t.id)) }))
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((x) => x.t);
  return { ok: false, reason: `不认识型号「${raw}」`, candidates: near };
}

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** 列表查询。 */
export function listTargets({ family, grep, limit = 80 } = {}) {
  let rows = TARGETS;
  if (family) rows = rows.filter((t) => t.family === String(family).toLowerCase());
  if (grep) {
    const g = normalize(grep);
    rows = rows.filter(
      (t) => normalize(t.id).includes(g) || t.aliases.some((a) => normalize(a).includes(g)) || normalize(t.cfg).includes(g),
    );
  }
  return { rows: rows.slice(0, limit), total: rows.length };
}

/** 一条目标的人话摘要（报告里用）。 */
export function targetSummary(t) {
  if (!t) return '(未指定目标)';
  const fam = FAMILIES[t.family];
  return [
    `型号入口 ：${t.id}`,
    `厂商族   ：${fam?.label ?? t.family}`,
    `target cfg：${t.cfg}`,
    `内核     ：${t.core ?? fam?.core ?? '(以 cfg 为准)'}`,
    `flash/RAM：约 ${t.flashKb ?? '?'} KB / ${t.ramKb ?? '?'} KB（openocd 连上后按 IDCODE 自动校正）`,
    t.note ? `备注     ：${t.note}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

// ------------------------------------------------------------- 工程扫描（只读）

/**
 * 扫一个目录，找可能含固件/工程配置的地方。
 *
 * 只找**入口**（工程文件与产出目录），不解析它们 ——
 * 解析各 IDE 的私有格式是另一件事，本插件只需要知道「固件在哪、用什么器件」。
 */
export function scanFirmwareProjects(root) {
  const out = { root, projects: [], firmwares: [], errors: [] };
  if (!root) return out;
  if (!existsSync(root)) {
    out.errors.push(`目录不存在：${root}`);
    return out;
  }
  const walk = (dir, depth) => {
    if (depth > 5 || out.projects.length + out.firmwares.length > 200) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      out.errors.push(`${dir}: ${String(e?.message ?? e)}`);
      return;
    }
    for (const e of entries) {
      const p = `${dir}\\${e.name}`;
      if (e.isDirectory()) {
        if (/^(node_modules|\.git|\.run|vendor)$/i.test(e.name)) continue;
        walk(p, depth + 1);
        continue;
      }
      if (/\.(uvprojx|uvproj|ioc|eide\.json)$/i.test(e.name) || /^CMakeLists\.txt$/i.test(e.name) || /^platformio\.ini$/i.test(e.name)) {
        out.projects.push({ path: p, kind: projectKind(e.name) });
        continue;
      }
      if (/\.(elf|hex|bin|s19|srec)$/i.test(e.name)) {
        let bytes = 0;
        try {
          bytes = statSync(p).size;
        } catch {
          /* 忽略 */
        }
        out.firmwares.push({ path: p, bytes, ageMs: Date.now() - safeMtime(p) });
      }
    }
  };
  walk(root, 0);
  out.firmwares.sort((a, b) => a.ageMs - b.ageMs);
  return out;
}

function projectKind(name) {
  if (/\.uvprojx?$/i.test(name)) return 'Keil MDK';
  if (/\.ioc$/i.test(name)) return 'STM32CubeMX';
  if (/eide\.json$/i.test(name)) return 'EIDE';
  if (/^CMakeLists\.txt$/i.test(name)) return 'CMake';
  if (/^platformio\.ini$/i.test(name)) return 'PlatformIO';
  return '未知';
}

function safeMtime(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
