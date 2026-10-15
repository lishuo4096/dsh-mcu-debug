/**
 * ASCII 路径镜像 —— 专治 OpenOCD 的 GBK 路径病。
 *
 * ## 病是什么
 *
 * Jim-TCL（OpenOCD 内嵌的解释器）在 Windows 上**从文件内容里**取到的路径会走窄字符
 * `fopen`，按系统 ANSI 代码页（本机是 GBK）解释。于是含中文的路径必然乱码失败：
 *
 * ```
 * Error: couldn't read file "C:/…/DSH_Project/鎻掍欢寮€鍙?dsh-mcu-debug/…": No such file or directory
 * ```
 *
 * `-f` / `-c` 由 argv 传入时走的是 Windows 宽字符接口，**不受影响**；
 * 但 `[find target/swj-dp.tcl]` 这类由**脚本内部**发起的路径拼接，
 * 是拿 `-s <搜索目录>` 的字符串去拼的 —— 搜索目录一旦含中文就踩雷。
 * 而 `py32f030.cfg` 第一行就是 `source [find target/swj-dp.tcl]`，**必踩**。
 *
 * ## 解法
 *
 * 在 `%LOCALAPPDATA%\dsh-mcu-debug\openocd` 建一个 **NTFS junction** 指向
 * `vendor/openocd`。junction 是内核级重定向，用户态看到的路径是纯 ASCII 的：
 *
 * ```
 * -s C:/Users/lishuo/AppData/Local/dsh-mcu-debug/openocd/scripts
 * ```
 *
 * 副本**一份不复制**、磁盘占用为零、`vendor/` 仍是唯一真源；
 * 本机 `%LOCALAPPDATA%` 是 `C:\Users\lishuo\AppData\Local`（纯 ASCII），成立。
 * 万一 junction 建不起来（跨卷、权限），退回**真复制**（24 MB，一次性）；
 * 再不行就退回原路径，并在环境自检里把这件事明说 —— 不静默降级。
 *
 * @module lib/mirror
 */

import { existsSync, mkdirSync, cpSync, lstatSync, readlinkSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 包根（与 env.js 同算法，这里自带一份以避免模块循环依赖）。 */
function root() {
  return resolve(HERE, '..');
}

/** 镜像基座：`%LOCALAPPDATA%\dsh-mcu-debug`。 */
export function asciiBase() {
  const local = process.env.LOCALAPPDATA ?? process.env.APPDATA ?? '';
  return local ? join(local, 'dsh-mcu-debug') : null;
}

/** 镜像里的 openocd 根。 */
export function asciiOpenocdRoot() {
  const base = asciiBase();
  return base ? join(base, 'openocd') : null;
}

/** 源（真源，永远在插件里）。 */
export function sourceOpenocdRoot() {
  return join(root(), 'vendor', 'openocd');
}

/** 路径里有没有非 ASCII 字符。 */
export function hasNonAscii(p) {
  return /[^\x00-\x7F]/.test(String(p ?? ''));
}

/**
 * 查镜像当前状态（只读，不建任何东西）。
 *
 * @returns `{needed, exists, kind, target, base, reason}`
 */
export function mirrorStatus() {
  const src = sourceOpenocdRoot();
  const dst = asciiOpenocdRoot();
  const needed = hasNonAscii(src);
  const out = { needed, exists: false, kind: null, target: null, base: asciiBase(), src, dst };
  if (!needed) {
    out.reason = '插件所在路径本来就是纯 ASCII，不需要镜像。';
    return out;
  }
  if (!dst) {
    out.reason = '解析不到 %LOCALAPPDATA%，无法建镜像。';
    return out;
  }
  if (!existsSync(dst)) {
    out.reason = '镜像尚未创建（首次执行 openocd 时会自动建）。';
    return out;
  }
  out.exists = true;
  try {
    const st = lstatSync(dst);
    if (st.isSymbolicLink()) {
      out.kind = 'junction';
      out.target = readlinkSync(dst);
    } else {
      out.kind = 'copy';
      out.target = null;
      out.reason = '镜像是一份真复制（junction 当时没建成）。';
    }
    if (existsSync(join(dst, 'bin', 'openocd.exe'))) {
      out.usable = true;
    } else {
      out.usable = false;
      out.reason = '镜像目录里没有 bin/openocd.exe，需要重建。';
    }
  } catch (error) {
    out.kind = 'unknown';
    out.reason = `读镜像状态失败：${String(error?.message ?? error)}`;
  }
  return out;
}

/**
 * 确保镜像可用，返回**应当用于执行**的 openocd 根。
 *
 * @returns `{root, kind, created, note}` —— `kind` 为 `direct`/`junction`/`copy`
 */
export function ensureMirror() {
  const src = sourceOpenocdRoot();
  const dst = asciiOpenocdRoot();

  if (!hasNonAscii(src)) {
    return { root: src, kind: 'direct', created: false, note: '源路径已是纯 ASCII，直接用。' };
  }
  if (!dst) {
    return { root: src, kind: 'direct', created: false, note: '没有 %LOCALAPPDATA%，退回原路径（含中文，可能触发 TCL 路径乱码）。' };
  }

  // 已存在且完好
  const st = mirrorStatus();
  if (st.exists && st.usable) {
    return { root: dst, kind: st.kind, created: false, note: `复用已有镜像（${st.kind}）。` };
  }

  // 存在但坏了 —— 清掉重建
  if (existsSync(dst) && !st.usable) {
    try {
      rmSync(dst, { recursive: true, force: true });
    } catch {
      /* 删不掉就往下走，后面的创建会失败并如实报告 */
    }
  }

  try {
    mkdirSync(dirname(dst), { recursive: true });
    // Node 原生支持 junction，**不需要管理员权限**（symlink 才需要）
    symlinkSync(src, dst, 'junction');
    if (existsSync(join(dst, 'bin', 'openocd.exe'))) {
      return { root: dst, kind: 'junction', created: true, note: `已创建 NTFS junction：${dst} → ${src}` };
    }
  } catch (error) {
    // 落到复制
    try {
      cpSync(src, dst, { recursive: true, force: true });
      return { root: dst, kind: 'copy', created: true, note: `junction 建失败（${String(error?.message ?? error)}），已改为真复制 24 MB。` };
    } catch (error2) {
      return {
        root: src,
        kind: 'direct',
        created: false,
        note: `镜像创建失败（junction：${String(error?.message ?? error)}；复制：${String(error2?.message ?? error2)}），退回含中文的原路径。`,
      };
    }
  }
  return { root: dst, kind: 'junction', created: true, note: '已创建 junction。' };
}

/** 删掉镜像（幂等；只删镜像，绝不动 vendor 真源）。 */
export function removeMirror() {
  const dst = asciiOpenocdRoot();
  if (!dst || !existsSync(dst)) return { ok: true, message: '镜像不存在，无需删除。' };
  try {
    rmSync(dst, { recursive: true, force: true });
    return { ok: true, message: `已删除镜像 ${dst}` };
  } catch (error) {
    return { ok: false, message: `删除失败：${String(error?.message ?? error)}` };
  }
}

/** 镜像目录体积（junction 时返回真源体积，供报告展示）。 */
export function mirrorBytes() {
  const st = mirrorStatus();
  const target = st.exists ? st.dst : sourceOpenocdRoot();
  try {
    return statSync(join(target, 'bin', 'openocd.exe')).size;
  } catch {
    return 0;
  }
}
