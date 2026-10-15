/**
 * dsh-mcu-debug —— 给 DSH 的 ARM Cortex-M 调试插件（STM32 / PY32，CMSIS-DAP / DAPLink）。
 *
 * ## 它到底解决什么问题
 *
 * 不是「又一个 openocd 包装」。它解决两个具体的事故：
 *
 * ### 1. 断点残留会被固化进固件
 *
 * ARM 的软件断点靠**改写指令字节**实现。在 flash 上下了断点之后，如果 openocd
 * 异常退出，没有人把那个字节改回来；此时若再用「读回内存 → 烧回去」的方式刷固件，
 * 断点指令就被**固化进固件**——之后每次上电都停在断点处，程序永远进不了 `main`。
 *
 * 本插件的对策不是「小心一点」，而是结构性的：
 * - 每次 openocd 调用的**收尾固定**是 `逐个 rbp` → `reset run`，清断点在**离开目标之前**做；
 * - 工作目录永远是私有会话目录（`<插件>/.run/<id>/`），openocd 不可能去 source
 *   工作区里的 `ocd.cfg` / `init.cfg`；
 * - 进程 CWD 由 `assertPrivateWorkdir()` 焊死，指向 IDE 与副本体的路径会被抛异常挡住。
 *
 * ### 2. openocd 必须是**独立副本**
 *
 * 用的是 `<插件>/vendor/openocd/`（完整拷贝，932 个文件 / 24.4 MB），
 * 全程只读 EIDE 的那两份原件。副本还通过一个 NTFS junction 暴露成纯 ASCII 路径
 * （`%LOCALAPPDATA%\dsh-mcu-debug\openocd`），绕开 Jim-TCL 对非 ASCII 路径按 GBK 解释的毛病
 * —— 本机插件目录里有中文（`插件开发`），这个绕法是必需的。
 *
 * ## 工具分组
 *
 * | 组 | 工具 | 用途 |
 * |---|---|---|
 * | A 环境 | `mcu_env` `mcu_probes` `mcu_chips` `mcu_projects` `mcu_workspace` `mcu_help` | 自检、器件表、工程扫描、剧本 |
 * | B/C 目标 | `mcu_probe` `mcu_regs` `mcu_mem` `mcu_flash_info` `mcu_read_flash` `mcu_flash` `mcu_erase` `mcu_reset` `mcu_bp` `mcu_ocd` | 连、读、烧、擦、复位、断点 |
 * | D/E 会话 | `mcu_session_open` `mcu_session_cmd` `mcu_session_list` `mcu_session_close` `mcu_gdb` `mcu_clean` | 常驻会话、gdb、清现场 |
 * | F 串口 | `mcu_serial_list` `mcu_serial_open` `mcu_serial_tx` `mcu_serial_rx` `mcu_serial_close` | 收发串口 |
 *
 * ## 多调试器怎么区分
 *
 * 本机同时插着 mbed DAPLink（VID 0D28）、WCH-Link（1A86:8010）、
 * 两块 FTDI（0403:6014 / 0403:6010）。CMSIS-DAP 后端会**自己挑一个设备且不报错**，
 * 所以本插件**必须**把 `adapter serial <序列号>` 注进 `-c` 序列里锁死探针；
 * 这个注入点在 `lib/run.js` 的 `planProbe()`，是唯一入口，绕不过去。
 *
 * @module dsh-mcu-debug
 */

import { registerEnvTools } from './lib/tools-env.js';
import { registerDebugTools } from './lib/tools-debug.js';
import { registerSessionTools } from './lib/tools-session.js';
import { registerSerialTools } from './lib/tools-serial.js';
import { createProvider } from './lib/skills.js';

/**
 * 插件名。
 *
 * ⚠️ 必须与 `cordis.patch.yml` 里 `insert[].id` **逐字一致**，
 * 否则宿主会加载不到（报一个语焉不详的 "plugin not found"）。
 */
export const name = 'mcu-debug';

/** 需要宿主提供的服务。 */
export const inject = ['tools', 'skills'];

/**
 * 注册入口。
 *
 * 四组分开 try/catch：一组出问题不该把整行插件拖垮 ——
 * 串口组挂了的时候，调试组照样能用。
 */
export function apply(ctx) {
  const groups = [
    ['环境', registerEnvTools],
    ['目标', registerDebugTools],
    ['会话', registerSessionTools],
    ['串口', registerSerialTools],
  ];

  const done = [];
  const failed = [];
  for (const [label, fn] of groups) {
    try {
      const names = fn(ctx);
      done.push(`${label}(${names.length})`);
    } catch (error) {
      failed.push(`${label}: ${String(error?.message ?? error)}`);
      console.error(`[mcu-debug] ${label}组注册失败：`, error);
    }
  }

  try {
    ctx.skills.registerProvider((control) => createProvider(control));
  } catch (error) {
    failed.push(`skills: ${String(error?.message ?? error)}`);
    console.error('[mcu-debug] 技能 provider 注册失败：', error);
  }

  console.log(
    `[mcu-debug] 已注册 ${done.join(' + ')} 组工具，技能包 provider 就绪` +
      (failed.length ? `；**失败 ${failed.length} 项**：${failed.join(' | ')}` : ''),
  );
}

export * from './lib/tools-env.js';
export * from './lib/tools-debug.js';
export * from './lib/tools-session.js';
export * from './lib/tools-serial.js';
export * from './lib/skills.js';
export * from './lib/serial.js';
export * from './lib/probes.js';
export * from './lib/devices.js';
export * from './lib/ocd.js';
export * from './lib/run.js';
export * from './lib/mirror.js';
export * from './lib/env.js';
export * from './lib/hygiene.js';
