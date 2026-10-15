/**
 * 探针（调试器）识别与区分。
 *
 * ## 为什么这层必须存在
 *
 * 本机同时插着 **CMSIS-DAPLink**、**WCH-Link**、**两片 FTDI**（FT232H + FT2232 类）。
 * OpenOCD 在没给 `adapter serial` 时，行为是「找到第一个能开的后端就用」——
 * 于是出现最坏的一类故障：**你以为在烧 PY32，实际在跟 WCH-Link 讲话**，
 * 报出来的错却是「target not examined」之类的下游现象，排查方向全歪。
 *
 * 所以本插件的立场是：**先点名，再动手**。任何写操作之前，
 * 探针必须是**唯一确定**的（有序列号，或全机只有一个同类）。
 *
 * ## VID/PID 知识库的来源
 *
 * 全部来自本机实测（`Win32_PnPEntity`）与各厂商公开的 USB ID 分配：
 *   - `0d28:0204` = mbed DAPLink（ARM Ltd 持有 0d28 这一 VID）→ CMSIS-DAP over HID
 *   - `1a86:8010` = WCH-Link（沁恒）→ ARM 模式下也是 CMSIS-DAP，另有厂商私有 SDI 模式
 *   - `0403:6010/6014/6001/6011` = FTDI（FT2232H / FT232H / FT232R / FT4232H）→ 走 ftdi 驱动
 *   - `0483:374x` = ST-LINK/V2、V2-1、V3 → 走 hla/stlink 驱动
 *   - `1366:010x` = SEGGER J-Link → 走 jlink 驱动
 *
 * ## Windows 驱动健康度
 *
 * `ConfigManagerErrorCode` 是这里的**关键字段**，不是装饰：
 *   - `0`  = 正常工作
 *   - `28` = 没装驱动
 *   - `39` = **驱动加载失败**（本机 DAPLink 曾实测命中：mbed 的 `mbedComposite`
 *            驱动是 2009 年的 Legacy 安装，在开了内存完整性/驱动签名的 Win11 上被拒载）
 *   - `43` = 系统因该设备发生过故障而停用
 *   - `45` = 当前没插
 * 代码 39 时，**复合设备的子接口（HID / CDC）根本不会枚举出来**，
 * 因此 openocd 的 hidapi 后端找不到任何 CMSIS-DAP 设备 —— 这不是插件的问题，
 * 也修不好在插件里，必须提权处理驱动。`probes.js` 的职责是**把它说清楚**。
 *
 * @module lib/probes
 */

import { psJson } from './env.js';

/** 设备管理器错误码 → 人话。 */
export const CM_ERROR = {
  0: '正常',
  1: '设备配置不正确',
  3: '驱动损坏或内存不足',
  10: '设备无法启动',
  12: '资源不足',
  14: '需要重新启动',
  18: '需要重新安装驱动',
  19: '注册表配置损坏',
  21: '系统正在移除设备',
  22: '设备被禁用',
  24: '设备未安装或被拆下',
  28: '驱动未安装',
  31: '设备加载驱动失败',
  32: '驱动启动类型被禁用',
  37: '驱动初始化失败',
  39: '驱动加载失败（驱动被签名策略/内存完整性拒绝）',
  43: '系统因该设备发生故障而将其停止',
  45: '当前未连接',
  52: '驱动签名无法验证',
};

/**
 * 探针知识库。
 *
 * `match` 用 `vid:pid` 小写十六进制匹配。`interfaceCfg` 是副本里
 * `scripts/interface/` 下的相对路径（由 `-f` 传入，走 argv，不受非 ASCII 影响）。
 */
export const PROBE_DB = [
  // ---- CMSIS-DAP 家族
  {
    vidpid: ['0d28:0204', '0d28:0206', '0d28:0207'],
    kind: 'cmsis-dap',
    label: 'DAPLink (mbed / ARM Ltd)',
    interfaceCfg: 'interface/cmsis-dap.cfg',
    transports: ['swd', 'jtag'],
    backend: 'hid',
    serialUsable: true,
    note: '标准 CMSIS-DAP，Windows 上走 hidapi 后端。序列号是 32 位十六进制串，可直接用于 adapter serial。',
  },
  {
    vidpid: ['0d28:0202', '0d28:0203'],
    kind: 'msd-bootloader',
    label: 'mbed 接口固件（MSD/引导模式）',
    interfaceCfg: null,
    note: '这是 DAPLink 的 U 盘/升级模式，**不是调试接口**。此时看不到 CMSIS-DAP，需要插拔一次让它退出引导模式。',
  },
  {
    vidpid: ['1a86:8010', '1a86:8012', '1a86:8011'],
    kind: 'wch-link',
    label: 'WCH-Link (沁恒)',
    interfaceCfg: 'interface/cmsis-dap.cfg',
    transports: ['swd', 'jtag'],
    backend: 'hid',
    serialUsable: true,
    note: 'ARM 模式下是 CMSIS-DAP 兼容；RISC-V 模式下走厂商私有 SDI，普通 openocd 用不了。若目标在 RV 模式，本插件帮不上。',
  },
  {
    vidpid: ['2e8a:0004', '2e8a:000c'],
    kind: 'cmsis-dap',
    label: 'Picoprobe (RP2040)',
    interfaceCfg: 'interface/cmsis-dap.cfg',
    transports: ['swd', 'jtag'],
    serialUsable: true,
  },
  {
    vidpid: ['1fc9:0090', '1fc9:0132'],
    kind: 'cmsis-dap',
    label: 'NXP LPC-Link2 / MCU-Link',
    interfaceCfg: 'interface/cmsis-dap.cfg',
    transports: ['swd', 'jtag'],
    serialUsable: true,
  },
  // ---- ST-LINK
  {
    vidpid: ['0483:3744', '0483:3748', '0483:374b', '0483:374e', '0483:374f', '0483:3752', '0483:3753', '0483:3754'],
    kind: 'stlink',
    label: 'ST-LINK / V2 / V2-1 / V3',
    interfaceCfg: 'interface/stlink.cfg',
    transports: ['swd', 'jtag'],
    serialUsable: true,
    note: '走 hla 驱动（不是 cmsis-dap）。某些 V2 固件的序列号不可读，这时只能用「全机唯一」来判定。',
  },
  {
    vidpid: ['0483:374a', '0483:374d'],
    kind: 'stlink-dfu',
    label: 'ST-LINK 升级模式 (DFU)',
    interfaceCfg: null,
    note: '这是 DFU 升级接口，不是调试口。',
  },
  // ---- J-Link
  {
    vidpid: ['1366:0101', '1366:0105', '1366:1015', '1366:1051', '1366:1061'],
    kind: 'jlink',
    label: 'SEGGER J-Link',
    interfaceCfg: 'interface/jlink.cfg',
    transports: ['swd', 'jtag'],
    serialUsable: true,
  },
  // ---- FTDI（本机的 FT232H 与 FT2232 类都落在这里）
  {
    vidpid: ['0403:6010', '0403:6011', '0403:6014', '0403:6001', '0403:6015', '0403:8a88', '0403:8a98'],
    kind: 'ftdi',
    label: 'FTDI (FT2232H / FT4232H / FT232H / FT232R)',
    interfaceCfg: null, // 需按具体接法与通道选 interface/ftdi/*.cfg
    transports: ['swd', 'jtag'],
    serialUsable: true,
    note:
      'FTDI 芯片本身**不是**调试器，要配合具体板子的 layout 才能当 SWD/JTAG 用。' +
      '而且若 EEPROM 没烧序列号，Windows 报出的「序列号」其实是位置串（形如 9&3342557&0&3），' +
      '换 USB 口就变 —— 这种值**不能**用于 adapter serial，只能靠单机唯一来判定。',
  },
];

/** 用一个 `vid:pid` 找知识库条目。 */
export function lookup(vidpid) {
  const key = String(vidpid ?? '').toLowerCase();
  return PROBE_DB.find((e) => e.vidpid.includes(key)) ?? null;
}

/**
 * 从 PnP InstanceId 里取 `vid:pid`。
 * 形如 `USB\VID_0D28&PID_0204\68D7…` 或 `USB\VID_1A86&PID_8010&MI_01\…`。
 */
export function vidPidOf(instanceId) {
  const m = /VID_([0-9A-Fa-f]{4})&PID_([0-9A-Fa-f]{4})/i.exec(String(instanceId ?? ''));
  return m ? `${m[1].toLowerCase()}:${m[2].toLowerCase()}` : null;
}

/** InstanceId 里有没有 `&MI_xx`（有 = 这是复合设备的子接口）。 */
export function isChildInterface(instanceId) {
  return /&MI_[0-9A-Fa-f]{2}/i.test(String(instanceId ?? ''));
}

/** 取 InterfaceNumber（`&MI_01` → 1）。 */
export function interfaceNumber(instanceId) {
  const m = /&MI_([0-9A-Fa-f]{2})/i.exec(String(instanceId ?? ''));
  return m ? parseInt(m[1], 16) : null;
}

/** 去掉 `&MI_xx` 及其后的部分，得到顶层复合设备的实例 id。 */
export function topInstance(instanceId) {
  return String(instanceId ?? '').split('&MI_')[0].replace(/\\$/, '');
}

/**
 * 取设备的「序列号」——即 InstanceId 最后一段。
 *
 * ⚠️ 只有**顶层**设备这一段才是序列号；子接口的最后一段是 `6&1f…&0&0001` 这种位置串。
 * 另外 FTDI 在 EEPROM 未烧序列号时，顶层段也会退化成 `9&3342557&0&3`（位置串）。
 * 用 `isPositionSerial()` 判定，别拿位置串去喂 `adapter serial`。
 */
export function serialOf(instanceId) {
  if (isChildInterface(instanceId)) return null;
  const parts = String(instanceId ?? '').split('\\');
  return parts.length >= 3 ? parts[parts.length - 1] : null;
}

/** 看起来像「总线位置串」而不是真序列号（形如 `9&3342557&0&3`）。 */
export function isPositionSerial(serial) {
  return /^\d+&[0-9a-f]+&\d+&\d+$/i.test(String(serial ?? ''));
}

// ------------------------------------------------------------- 枚举

/**
 * 枚举本机所有 USB 设备（含复合设备的子接口）。只读，走一次 PowerShell。
 *
 * 这里**刻意不去查 `DEVPKEY_Device_Parent`**，虽然那是最准确的父子关系来源。
 * 实测：本机 `Get-PnpDeviceProperty -KeyName DEVPKEY_Device_Parent` 单次调用约
 * **14.5 秒**（15 个子接口 = 220 秒），WMI 这条路走不通。父子关系改在 JS 侧
 * 按 VID/PID 结构推断，见 `groupByTop()`。
 */
export function enumerateUsb() {
  const script = [
    'Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |',
    "  Where-Object { $_.PNPDeviceID -like 'USB\\*' } |",
    '  Select-Object Name,PNPDeviceID,Manufacturer,Service,Status,ConfigManagerErrorCode |',
    '  ConvertTo-Json -Depth 4 -Compress',
  ].join('\n');
  const r = psJson(script, { timeoutMs: 60000 });
  if (!r.ok) return { ok: false, devices: [], error: r.error };
  const devices = r.rows.map((d) => ({
    name: d.Name ?? '',
    instanceId: d.PNPDeviceID ?? '',
    manufacturer: d.Manufacturer ?? '',
    service: d.Service ?? '',
    status: d.Status ?? '',
    // CIM 的 ConfigManagerErrorCode 查不到时给 null 而不是 undefined ——
    // 否则下游「errCode !== null && errCode !== 0」会把「未知」误判成「驱动故障」。
    errorCode: d.ConfigManagerErrorCode === undefined || d.ConfigManagerErrorCode === null ? null : Number(d.ConfigManagerErrorCode),
  }));
  return { ok: true, devices, error: null };
}

/**
 * 把「顶层设备」与「复合设备子接口」归并。
 *
 * 为什么需要归并：WCH-Link 这类复合设备，**模式信息只出现在子接口的名字里**
 * （`WCH-LinkRV` = RISC-V 模式 / `WCH-LinkARM` = ARM 模式），顶层复合设备本身
 * 只叫「WCH-Link」。子接口要是丢了，探针表就会把一个处在 RISC-V 模式、
 * 根本不能说 CMSIS-DAP 的 Link 报成「可用」。
 *
 * 为什么不用系统给的父实例：`Get-PnpDeviceProperty(DEVPKEY_Device_Parent)`
 * 单次 ~14.5 秒（见 `enumerateUsb` 的注释）。改用结构推断：
 * 子接口实例形如 `USB\VID_1A86&PID_8010&MI_01\A&468B9A0&0&0001`，它必然属于某个
 * 顶层 `USB\VID_1A86&PID_8010\<序列号>`。
 *
 * **只在唯一时才断言父子关系**：同 VID/PID 的顶层设备存在多个时（比如插了两个
 * 一模一样的 DAPLink），结构推断无法区分，此时挂到一个明确标注「归属不明」的
 * 占位记录上，把不确定性说出来 —— 而不是随便挑一个，让调用方以为配对是确定的。
 */
export function groupByTop(devices) {
  const tops = new Map(); // 规范化 vidpid → 顶层实例 ID 数组
  for (const d of devices) {
    if (isChildInterface(d.instanceId)) continue;
    const vp = vidPidOf(d.instanceId);
    if (!vp) continue;
    if (!tops.has(vp)) tops.set(vp, []);
    tops.get(vp).push(d.instanceId);
  }

  const groups = new Map(); // 父实例 ID（或占位键）→ {name, instanceId, children[], syntheticParent?, ambiguous?}
  const ownerOf = (instanceId) => {
    if (!isChildInterface(instanceId)) return instanceId;
    const vp = vidPidOf(instanceId);
    const cands = tops.get(vp) ?? [];
    if (cands.length === 1) return cands[0];
    // 0 个 → 父设备没枚举出来；≥2 个 → 认不出是哪个。两种都当「归属不明」，
    // 键就用子接口自己的实例 ID，保证占位记录指向具体设备而不是一个假 ID。
    return instanceId;
  };

  /*
   * **必须分两趟**：先建顶层，再挂子接口。
   *
   * 一趟写下来的话，子接口先被遍历到时会用一个只有 `children` 的空壳占住
   * `groups` 的键，等顶层设备轮到时 `groups.has(key)` 已经成立 —— 种子数据
   * （名字、序列号、错误码）被**静默丢掉**了，只留下一个没有 instanceId 的空壳。
   * 症状不是报错，而是设备**从列表里消失**：实测 WCH-Link 与那块 FTDI 6010
   * 就这么没的（它们都是有子接口的复合设备，DAPLink 和 FTDI 6014 没有子接口，
   * 所以活了下来 —— 这正是它难查的原因：看起来「部分正常」）。
   */
  for (const d of devices) {
    if (isChildInterface(d.instanceId)) continue;
    groups.set(d.instanceId, { ...d, children: [] });
  }

  for (const d of devices) {
    if (!isChildInterface(d.instanceId)) continue;
    const key = ownerOf(d.instanceId);
    if (key === d.instanceId) {
      const vp = vidPidOf(d.instanceId);
      const n = (tops.get(vp) ?? []).length;
      if (!groups.has(key)) {
        groups.set(key, {
          name: n === 0 ? '(父设备未枚举)' : '(同类设备多个，归属不明)',
          instanceId: key,
          children: [],
          syntheticParent: true,
          ambiguous: n > 1,
        });
      }
    }
    groups.get(key).children.push(d);
  }
  return [...groups.values()];
}

/**
 * 把所有 USB 设备按「顶层设备 + 子接口」归并，再识别成探针。
 *
 * @returns `{ok, probes, unknown, error, deviceCount}`
 */
export function listProbes() {
  const { ok, devices, error } = enumerateUsb();
  if (!ok) return { ok: false, probes: [], unknown: [], error };

  const tops = groupByTop(devices);

  const probes = [];
  const unknown = [];

  for (const t of tops.values()) {
    const vidpid = vidPidOf(t.instanceId);
    if (!vidpid) continue;
    const entry = lookup(vidpid);
    const serial = serialOf(t.instanceId);
    const errCode = t.errorCode;

    // 只在「知识库里认得，或者名字像调试器」时才当成探针，避免把键鼠/音频全列出来
    const nameLikeProbe = /\b(dap|link|debug|jtag|swd|st-?link|j-?link|cmsis|ftdi|ft232|ft2232|picoprobe|probe)\b/i.test(
      `${t.name} ${t.service} ${t.manufacturer}`,
    );
    if (!entry && !nameLikeProbe) continue;

    const problems = [];
    if (errCode !== null && errCode !== 0) {
      problems.push(`设备管理器错误码 ${errCode}：${CM_ERROR[errCode] ?? '未知'}`);
    }
    if (entry?.interfaceCfg === null) {
      problems.push('这一类 USB ID 不是可直接用于调试的接口形态（需要按具体接法选 interface cfg，或是升级/引导模式）。');
    }
    if (serial && isPositionSerial(serial)) {
      problems.push(`「序列号」${serial} 是总线位置串，不是真序列号 —— 换 USB 口就变，不能用于 adapter serial。`);
    }
    if (t.syntheticParent) {
      problems.push('顶层复合设备没有出现在枚举里（父设备驱动未加载），子接口成了孤儿。');
    }

    /*
     * 模式判定 —— 这是本插件吃过一次亏才补上的。
     *
     * 教训：只看「设备管理器里没有惊叹号」就断定探针可用是错的。WCH-Link 在
     * RISC-V 模式下 PnP 状态完全正常（它就是个健康的 USB 复合设备），但它**不说
     * CMSIS-DAP**。实测 openocd 对它报的是：
     *     cmsis_dap_usb_bulk.c:105 could not open device 0x1a86:0x8010:
     *     Operation not supported or unimplemented on this platform
     * 而插件的探针表却写着「可用」—— 于是 mcu_probe 失败时调用方会去怀疑接线和插件，
     * 真正的原因（探针在错的模式里）反而没人看。
     *
     * 判据只能从**子接口的名字**上取：WCH-Link 的模式会写在它的接口名里
     * （WCH-LinkRV / WCH-LinkARM / WCH-LinkDAP），顶层复合设备本身看不出来。
     */
    const cap = cmsisDapCapability(t, entry, errCode);
    if (cap.blocks) problems.push(cap.reason);

    probes.push({
      vidpid,
      instanceId: t.instanceId,
      name: t.name,
      manufacturer: t.manufacturer,
      service: t.service,
      status: t.status,
      errorCode: errCode,
      errorText: errCode === null ? null : CM_ERROR[errCode] ?? '未知',
      kind: entry?.kind ?? 'unknown',
      label: entry?.label ?? t.name,
      interfaceCfg: entry?.interfaceCfg ?? null,
      transports: entry?.transports ?? ['swd', 'jtag'],
      backend: entry?.backend ?? null,
      serial: serial ?? null,
      serialUsable: Boolean(serial) && !isPositionSerial(serial) && Boolean(entry?.serialUsable ?? true),
      note: entry?.note ?? null,
      children: t.children.map((c) => ({
        instanceId: c.instanceId,
        name: c.name,
        service: c.service,
        interfaceNumber: interfaceNumber(c.instanceId),
        errorCode: c.errorCode,
        errorText: c.errorCode === null ? null : CM_ERROR[c.errorCode] ?? '未知',
      })),
      problems,
      capability: cap,
      /** 能不能真的拿去调目标：认得型号 + 驱动正常 + 有可用 interface cfg + 模式对得上。 */
      usable: Boolean(entry?.interfaceCfg) && (errCode === 0 || errCode === null) && !t.syntheticParent && !cap.blocks,
    });
  }

  // 排个序：能用的在前，CMSIS-DAP 优先（本任务目标）
  const rank = (p) => (p.usable ? 0 : 100) + (p.kind === 'cmsis-dap' ? 0 : p.kind === 'stlink' ? 1 : p.kind === 'jlink' ? 2 : 3);
  probes.sort((a, b) => rank(a) - rank(b) || a.vidpid.localeCompare(b.vidpid));

  return { ok: true, probes, unknown, error: null, deviceCount: devices.length };
}

/**
 * 判定一个探针**能不能说 CMSIS-DAP** —— 而不是「它驱动装没装好」。
 *
 * 这两件事在 Windows 上是独立的：驱动装好了不代表它此刻在能当 CMSIS-DAP 的模式里。
 * 返回值 `{blocks, mode, reason, fix}`：
 *   - `blocks:true` → 不该被当成可用探针（会把调用方引向错误的排查方向）
 *   - `blocks:false` 但 `mode` 有值 → 可用，附带状态说明
 *
 * @param {{children?:Array<{name?:string,service?:string}>, name?:string, service?:string}} t
 * @param {{kind?:string}|null} entry  知识库条目
 * @param {number|null} errCode        设备管理器错误码
 */
export function cmsisDapCapability(t, entry, errCode) {
  // 驱动层就先过不去 —— 这一条最硬，其余都不用看了
  if (errCode !== null && errCode !== 0) {
    return {
      blocks: true,
      mode: 'driver-error',
      reason: `设备管理器的错误码是 ${errCode}（${CM_ERROR[errCode] ?? '未知'}）—— 驱动没加载成功，USB 接口打不开，openocd 只会报一句「unable to find a matching CMSIS-DAP device」。`,
      fix:
        errCode === 39
          ? '驱动被签名策略/内存完整性拒绝了。以管理员身份 `pnputil /delete-driver <inf> /uninstall /force` 后重新插拔，让 Windows 用通用 usbccgp 重新枚举。'
          : '按错误码处理（28 = 还没装驱动；43 = 被上层策略停用）。',
    };
  }

  const hay = `${t.name ?? ''} ${t.service ?? ''} ` +
    (t.children ?? []).map((c) => `${c.name ?? ''} ${c.service ?? ''}`).join(' ');

  // WCH-Link 的三个模式：接口名里带 RV 的是 RISC-V，openocd 的 cmsis-dap 驱动连不上
  if (/WCH-?Link/i.test(hay) || /^1a86:801[0-2]$/i.test(String(entry?.vidpid?.join?.(' ') ?? ''))) {
    if (/WCHLink_?RV|WCH-?Link\s*RV|RISC-?V/i.test(hay)) {
      return {
        blocks: true,
        mode: 'wch-riscv',
        reason:
          'WCH-Link 正处在 **RISC-V 模式**（子接口名里有 WCH-LinkRV）—— 这个模式下它走厂商私有 SDI 协议，**不说 CMSIS-DAP**。设备管理器里它一切正常，所以特别容易被误判成「探针没问题」。',
        fix:
          '要让 WCH-Link 调 ARM（PY32/STM32 都是 ARM Cortex-M），得先把它切到 **ARM 模式**或 **DAP 模式**：用 WCH-LinkUtility、或沁恒的 MounRiver/WCH Toolchain 里的模式切换按钮，切完重新插拔。切换是写进 Link 固件的，不用重刷。',
      };
    }
    if (/WCHLink_?ARM|WCH-?Link\s*ARM|WCHLink_?DAP|DAP/i.test(hay)) {
      return { blocks: false, mode: 'wch-arm', reason: 'WCH-Link 在 ARM/DAP 模式，可作 CMSIS-DAP 使用。', fix: null };
    }
  }

  // DAPLink：驱动正常但 HID 接口没枚举出来时，hidapi 后端一样打不开
  const kids = t.children ?? [];
  const hidKid = kids.some((c) => /HID/i.test(`${c.name ?? ''} ${c.service ?? ''}`));
  if (/0d28:020[467]/i.test(String(entry?.vidpid?.join?.(' ') ?? '')) && kids.length > 0 && !hidKid) {
    return {
      blocks: true,
      mode: 'daplink-no-hid',
      reason:
        'DAPLink 枚举出了子接口，但里面**没有 HID 接口** —— openocd 在 Windows 上就是靠 hidapi 打开 DAPLink 的，没有 HID 接口就无从下手（bulk 后端在 Windows 上会报 "Operation not supported or unimplemented on this platform"）。',
      fix: '多半是驱动装得不对（mbedserial/mbedComposite 版本过旧）。重装 mbed 的 Windows 驱动，或让它退回通用 usbccgp 枚举。',
    };
  }

  return { blocks: false, mode: entry?.kind ?? 'unknown', reason: null, fix: null };
}

// ------------------------------------------------------------- 选择与呈现

/**
 * 一个探针「为什么用不了」的一句话总结 —— 优先给出**根因**而不是症状清单。
 *
 * 顺序是有意的：驱动错误码与模式判定是根因（说出来就有明确的下一步），
 * 而 `problems` 里那些「序列号是位置串」之类的属于附带瑕疵，不该抢答。
 */
export function blockReasonOf(p) {
  if (p?.capability?.reason && p.capability.blocks) return p.capability.reason;
  if (p?.errorCode) return `设备管理器错误码 ${p.errorCode}（${p.errorText ?? '未知'}）`;
  if (p?.problems?.length) return p.problems.join('；');
  if (!p?.interfaceCfg) return '这一类 USB ID 没有对应的 interface cfg，本插件不知道怎么用它调目标。';
  return '原因不明（`mcu_probes action:"all"` 看完整设备信息）。';
}

/**
 * 从探针列表里挑一个**确定的**目标。
 *
 * 优先级有意做成「宁可不选，也不猜」：
 *   1. 显式给了序列号 → 必须精确命中，命中不了就报错（不退回自动选）；
 *   2. 显式给了 vid:pid → 该类只有一个才选，多个就要求补序列号；
 *   3. 都没给 → 只有当**可用探针恰好只有一个**时才自动选；
 *      有多个可用探针时返回 `ambiguous`，把选择权交回给人。
 *
 * @returns `{ok, probe, reason, candidates}`
 */
export function selectProbe(probes, { serial, vidpid, kind } = {}) {
  const usable = (probes ?? []).filter((p) => p.usable);
  const wanted = vidpid ? String(vidpid).toLowerCase() : null;

  if (serial) {
    const want = String(serial).trim().toLowerCase();
    const hits = (probes ?? []).filter((p) => String(p.serial ?? '').toLowerCase() === want);
    if (hits.length === 0) {
      return { ok: false, reason: `没有任何探针的序列号等于 ${serial}（识别到 ${usable.length} 个可用探针）`, candidates: usable };
    }
    if (hits.length > 1) {
      return { ok: false, reason: `序列号 ${serial} 同时命中 ${hits.length} 个设备，无法区分`, candidates: hits };
    }
    if (!hits[0].usable) {
      return { ok: false, reason: `序列号 ${serial} 命中的探针当前不可用：${hits[0].problems.join('；')}`, candidates: hits };
    }
    return { ok: true, probe: hits[0], reason: `按序列号精确命中 ${hits[0].label}` };
  }

  if (wanted) {
    let pool = usable.filter((p) => p.vidpid === wanted);
    if (kind) pool = pool.filter((p) => p.kind === kind);
    if (pool.length === 0) {
      /*
       * 这里**必须把「认出来了但用不了」的设备连同原因一起说**。
       * 只回一句「没有可用的 1a86:8010 探针」，调用方会以为是自己参数写错，
       * 然后一遍遍换参数重试 —— 而真实原因（探针在 RISC-V 模式 / 驱动错误码 39）
       * 就在同一张表里躺着，白白浪费掉。
       */
      const same = (probes ?? []).filter((p) => p.vidpid === wanted);
      if (same.length) {
        return {
          ok: false,
          reason:
            `识别到 ${same.length} 个 ${wanted} 设备，**但都不可用**：\n` +
            same.map((p) => `  - ${p.label} serial=${p.serial ?? '(无)'}：${blockReasonOf(p)}`).join('\n') +
            `\n（换探针参数重试没用 —— 得先解决上面这条。）`,
          candidates: same,
        };
      }
      return { ok: false, reason: `本机没有 ${wanted} 这个 USB ID 的设备。`, candidates: usable };
    }
    if (pool.length > 1) {
      return {
        ok: false,
        reason: `${wanted} 上有 ${pool.length} 个可用设备，必须用 serial 指定是哪一个：${pool.map((p) => p.serial ?? '(无序列号)').join(', ')}`,
        candidates: pool,
      };
    }
    return { ok: true, probe: pool[0], reason: `按 vid:pid 命中唯一设备 ${pool[0].label}` };
  }

  if (usable.length === 0) {
    /*
     * 「没有可用探针」是最需要说清楚的一句话，因为它是**死路**：
     * 再试也不会变。所以这里不走「只看驱动错误码」的老路，
     * 而是把每个认出来的探针**按各自的阻塞原因**逐条列出来。
     */
    const known = (probes ?? []).filter((p) => p.kind !== 'unknown');
    if (known.length) {
      const reasons = known.map((p) => `  - ${p.label} [${p.vidpid}] serial=${p.serial ?? '(无)'}：${blockReasonOf(p)}`);
      const fixes = [...new Set(known.map((p) => p.capability?.fix).filter(Boolean))];
      return {
        ok: false,
        reason:
          `本机插着 ${known.length} 个调试器，**但一个都不能用来调 ARM 目标**：\n${reasons.join('\n')}` +
          (fixes.length ? `\n\n怎么修：\n${fixes.map((f) => `  → ${f}`).join('\n')}` : ''),
        candidates: probes ?? [],
      };
    }
    return { ok: false, reason: '没有识别到任何调试器。确认探针插好了（`mcu_probes action:"all"` 可以看全部 USB 设备）。', candidates: probes ?? [] };
  }
  if (usable.length > 1) {
    return {
      ok: false,
      reason:
        `本机有 ${usable.length} 个可用调试器，**不会替你猜**。用 serial 或 vidpid 指定：` +
        usable.map((p) => `${p.label} [${p.vidpid}] serial=${p.serial ?? '(无)'}`).join('；'),
      candidates: usable,
    };
  }
  return { ok: true, probe: usable[0], reason: `全机只有唯一可用探针 ${usable[0].label}，自动选定` };
}

/** 把探针列表排成给人看的表。 */
export function renderProbeTable(probes) {
  if (!probes?.length) return '(没有识别到 USB 调试器)';
  const rows = probes.map((p) => {
    const state = p.usable ? '可用' : '不可用';
    const kids = p.children.length ? ` | 子接口 ${p.children.length} 个` : '';
    const err = p.errorCode ? ` | 错误码 ${p.errorCode}(${p.errorText})` : '';
    return [
      `- ${p.label}  [${p.vidpid}]  ${state}${err}`,
      `    serial : ${p.serial ?? '(无)'}${p.serial && isPositionSerial(p.serial) ? '  ←位置串，不可用于 adapter serial' : ''}`,
      `    接口   : ${p.interfaceCfg ?? '(无对应的 interface cfg)'}`,
      `    实例   : ${p.instanceId}${kids}`,
    ].join('\n');
  });
  return rows.join('\n');
}

/**
 * 生成探针相关的 openocd `-c` 前置命令。
 *
 * 返回**有序**命令数组，调用方必须把它们插在 `interface/*.cfg` 之后、
 * `target/*.cfg` 之前（openocd 按出现顺序处理，顺序错了就等于没指定）。
 */
export function probeCommands(probe, { transport = 'swd', serial } = {}) {
  const cmds = [];
  const sn = serial ?? (probe?.serialUsable ? probe?.serial : null);
  if (sn) cmds.push(`adapter serial ${sn}`);
  if (transport) {
    // ST-LINK 走 **hla** 驱动：`interface/stlink.cfg` 自己就 `transport select hla_swd`，
    // 我们再补一句 `transport select swd` 会被它当非法 transport 直接报错。
    // 所以这一族由 cfg 自己决定，插件不插手。
    if (TRANSPORT_SELF_MANAGED.has(String(probe?.kind ?? ''))) {
      // 交给 cfg
    } else {
      cmds.push(`transport select ${transport}`);
    }
  }
  return cmds;
}

/** 自己管 transport 的探针族（插件不得再补 `transport select`）。 */
export const TRANSPORT_SELF_MANAGED = new Set(['stlink', 'stlink-dfu']);
