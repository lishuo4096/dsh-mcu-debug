# dsh-mcu-debug

DSH 插件：ARM Cortex-M 调试与烧录（**STM32 / PY32**）+ 串口收发。
探针走 CMSIS-DAP / DAPLink，底层是插件自带的 openocd 副本。

## 为什么做这个

不是「又一个 openocd 包装」。它针对两个具体事故：

### 1. 断点残留会被固化进固件

ARM 的软件断点靠**改写指令字节**实现。在 flash 上下了断点之后，如果 openocd
没体面退出，没有人把那个字节改回来；此时若再用「读回内存 → 烧回去」的方式刷固件，
断点指令就被**固化进固件** —— 之后每次上电都停在断点处，程序永远进不了 `main`，
而且日志上看不出来。

本插件的对策是结构性的，不靠自觉：

- 每次 openocd 调用的收尾**固定**是「逐个 `rbp` → `reset run`」，
  清断点在**离开目标之前**做（`lib/ocd.js` 的 `FOOTERS`）；
- openocd 的进程 CWD **永远**是私有会话目录 `<插件>/.run/<id>/`，
  由 `assertPrivateWorkdir()` 焊死，指向 IDE 树或副本体的路径会直接抛异常；
- 于是 openocd 不可能去自动 `source` 工作区里的 `ocd.cfg` / `init.cfg`；
- 每次运行的副本、argv、输出落盘成 `session-record.txt` / `session.json` / `openocd.txt`，
  事后能完整复盘这次到底跑了什么。

### 2. openocd 必须是独立副本

用 `<插件>/vendor/openocd/`（完全拷贝，**932 个文件 / 24.4 MB**），
EIDE 装在 `C:\Users\lishuo\.eide\tools\` 下的两份原件全程只读。

副本还通过一个 NTFS junction 暴露成纯 ASCII 路径
（`%LOCALAPPDATA%\dsh-mcu-debug\openocd` → `vendor/openocd`，`symlinkSync(..., 'junction')`
不需要管理员权限）。原因是 Jim-TCL 从**文件内容**里取的路径走窄字符 `fopen`、按 GBK 解释：
本机插件目录是 `…\插件开发\…`，`py32f030.cfg` 第一行就是 `source [find target/swj-dp.tcl]`，
搜索目录一含中文就会炸（实测报 `couldn't read file "…/鎻掍欢寮€鍙?…"`）。
junction 失败时退回真实复制 24 MB，再失败就退回原路径并在 `mcu_env` 里明说。

### 3. 一个非法 schema 会让**所有**对话崩掉

这不是本插件独有的坑，是 DSH 插件生态里最容易踩、后果最严重的一类：
工具 schema 是打包成一个 `functions` 数组发给 provider 的，**一条非法 → 整个数组被拒
→ 该会话之后每一次请求都失败**，而不是只有那个工具不能用。表现是「装了插件，对话全崩」。

本插件踩过一次：`type: 'json'`（作者侧 DSL，意思是「任意 JSON」）漏进了工具**参数** schema。
provider 的元 schema 把 `type` 约束成一个枚举、枚举本身用 `anyOf` 表达，字面量 `"json"`
不在其中，于是报：

```
Invalid schema for function 'mcu_regs': "json" is not valid under any of the schemas listed in the 'anyOf' keyword
```

`mcu_regs` 只是第一个被点名的受害者。真正的缺口是：**`defineTool` 从来没跑过这道校验**。

对策是两道，都在 `lib/define-tool.js`：

1. `compileNode` 把作者侧 `type:'json'` 一律编译成开放 schema + `description`；
2. `sanitizeSchema` 在**注册前**对整棵树做最后清洗 —— 白名单对齐 harness 子集
   （`type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解），
   摘掉非法 `type`、`anyOf`/`allOf`/`format`/`pattern`、少于两支的 `oneOf`。

**摘掉而不是抛错**是刻意的：门槛设成 throw，作者写错一个字符插件连加载都过不去；
摘掉则该参数退化成「任意 JSON」，工具照常可用，同时留一条 alarm 让人来修。

## 挂载前门禁

改过任何工具的 `parameters` 之后，**挂载前**跑：

```bash
node .probe/gate.mjs
```

它用 **harness 自己的校验器**（`@deepseek-ai/dsh-tools` 的
`assertSupportedJsonSchema` / `assertObjectJsonSchema`）验收全部 27 个工具 ——
不是我们自己写的规则自说自话。五道门：① 复现事故（证明 `{type:'json'}` 确实会被拒）
② 注册前网关有效 ③④ 参数与输出 schema 全量合法 ⑤ 编译产物无残留。

> 找不到 harness 时门禁会**报错退出**，绝不退化成自写规则后报绿 ——
> 假绿比没有门禁更危险。跨机器用 `DSH_TOOLS_PATH` 指定
> `.../@deepseek-ai/dsh-tools/lib/index.js`。

审计别的插件（正在挂载中的也要查）：

```bash
node .probe/audit-plugin.mjs ../dsh-wch-debug
```

## 安装

```
plugin_manager({ action: "install_bundle", target: "C:\\Users\\lishuo\\Documents\\DSH_Project\\插件开发\\dsh-mcu-debug" })
```

它会往 profile 的 `package.json` 写 `"@local/dsh-mcu-debug": "link:<绝对路径>"`
并把包名加进 `dsh.profile.bundles`。`cordis.patch.yml` 里的 `id` 必须与
`index.js` 的 `export const name`（`mcu-debug`）逐字一致。

手工挂载的话，只用往 profile 的 `dsh.profile.bundles` 数组加一行
`"@local/dsh-mcu-debug"`（`dependencies` 里的 `link:` 路径要指到插件根目录）。

零 npm 依赖：`define-tool.js` 是自实现的工具定义层（插件以 `link:` 安装时
Node 从真实路径向上找 `node_modules`，宿主模块图里的 `@deepseek-ai/dsh-tools` 找不到，
`import` 会以 `ERR_MODULE_NOT_FOUND` 失败、整行插件加载不了）。

## 工具（27 个，前缀 `mcu_`）

| 组 | 工具 |
|---|---|
| 环境（A） | `mcu_env` `mcu_probes` `mcu_devices` `mcu_projects` `mcu_workspace` `mcu_help` |
| 目标（B/C） | `mcu_probe` `mcu_regs` `mcu_mem` `mcu_flash_info` `mcu_read_flash` `mcu_flash` `mcu_erase` `mcu_reset` `mcu_bp` `mcu_ocd` |
| 会话（D/E） | `mcu_session_open` `mcu_session_cmd` `mcu_session_list` `mcu_session_close` `mcu_gdb` `mcu_clean` |
| 串口（F） | `mcu_serial_list` `mcu_serial_open` `mcu_serial_tx` `mcu_serial_rx` `mcu_serial_close` |

配一个技能包：`skills/mcu-debug/SKILL.md`（触发词：STM32 / PY32 / Cortex-M /
单片机 / 烧录 / 固件 / DAPLink / CMSIS-DAP / SWD / openocd / 断点 / 寄存器 / 串口日志）。

## 多探针区分

本机同时插着 mbed DAPLink（`0d28:0204`）、WCH-Link（`1a86:8010`）、两块 FTDI
（`0403:6014` / `0403:6010`）。CMSIS-DAP 后端会**自己挑一个设备而且不报错**，
所以本插件把 `adapter serial <序列号>` 注入 `-c` 序列里锁死探针 ——
注入点在 `lib/run.js` 的 `planProbe()`，是唯一入口，绕不过去。

顺序是有讲究的，不是风格问题（openocd 按出现顺序处理 `-c`）：

```
-f interface/cmsis-dap.cfg
-c "adapter serial <serial>"     ← 必须在适配器初始化前生效
-c "transport select swd"        ← 必须在 target cfg 里 swd_newdap 之前生效
-f target/py32f030.cfg
-c <业务命令>…
-c '逐个 rbp' -c 'reset run'      ← 收尾
```

`mcu_probes` 给出的 `probe:` 参数接受序列号 / `vid:pid` / 名字片段三种写法。
多个同类探针同时插着时**必须给序列号** —— 给 vid:pid 也会因为不唯一而报错，
这是故意的：宁可不选，也不猜错。

## 目录布局

```
dsh-mcu-debug/
  index.js               注册入口（export const name = 'mcu-debug'）
  cordis.patch.yml       宿主补丁（insert id 必须与 name 一致）
  package.json
  lib/
    define-tool.js       零依赖工具定义层
    result.js            统一返回约定（ok / fail / hexDump / kvBlock）
    frontmatter.js       极简 YAML frontmatter
    skills.js            包内 skills/**/SKILL.md → 技能 provider
    hygiene.js           工作区卫生（第一理由）
    env.js               路径、工具链、PowerShell 桥（-EncodedCommand）
    mirror.js            vendor 副本的 ASCII junction 镜像
    probes.js            探针识别（VID/PID 知识库 + 选择策略）
    devices.js           PY32 / STM32 器件表 + 型号解析 + 工程扫描
    ocd.js               执行层（argv 构造、判据、收尾、命令序列）
    run.js               执行入口（planProbe → planRun → runTarget）
    serial.js            串口宿主客户端（JSON 行协议）
    serial-host.ps1      串口常驻宿主（PowerShell，持有 SerialPort 句柄）
    tools-env.js         A 组
    tools-debug.js       B/C 组
    tools-session.js     D/E 组
    tools-serial.js      F 组
  skills/mcu-debug/SKILL.md
  vendor/openocd/        openocd 0.12.0 隔离副本（932 文件 / 24.4 MB，GPLv2，原样保留）
  .probe/                自检脚本（见「挂载前门禁」）
  test/                  define-tool 与工具 schema 的单元检查
  .run/                  私有运行区（会话目录、注册表）—— 随用随删
  backups/               烧录前备份的固件
```

## 串口为什么用 PowerShell 子进程

Node 没有内置串口 API。与其塞一个 `serialport` 原生模块（要编译、要 ABI 匹配），
不如起一个常驻 `powershell.exe` 持有 `[System.IO.Ports.SerialPort]` 对象，
用 JSON 行协议（`{"id":..,"op":"open","port":"COM21",..}` ↔ `{"id":..,"ok":true,..}`）
通信 —— 和 `lib/serial-host.ps1` 里实现的一样。

这样做的额外好处是**句柄能一直保持打开**：每次收发都重开口会重新拉一遍 DTR，
而很多板子把 DTR 接在 RESET 上，等于每读一行日志就把目标复位一次。

`serial-host.ps1` 会先被转存到 `%LOCALAPPDATA%\dsh-mcu-debug\` 再执行 ——
PowerShell 5.1 的 `-File` 在含中文的路径上会失败，这是已知的兼容性坑。

## 只写两个地方

- `<插件>/.run/` —— 会话目录与注册表
- `<插件>/backups/` —— 烧录前备份

EIDE 的 openocd 原件树、目标工程的源码目录，全程只读。
`mcu_clean action:"audit"` 会扫私有区并报出可疑文件与外泄迹象。

## 验证

| 脚本 | 作用 |
|---|---|
| `.probe/gate.mjs` | **挂载前门禁**，5 道门 + 27 个工具的 schema 验收 |
| `.probe/audit-plugin.mjs <dir>` | 用 harness 校验器审计任意插件的全部工具 |
| `.probe/sanitize-test.mjs` | 注册前网关的 15 条断言（含「合法写法不被误伤」） |
| `.probe/ask-harness.mjs` | 直接问 harness：哪些 schema 写法合法/非法 |
| `.probe/compiled-params.mjs` | 看运行时**编译产物**，而不是源码文本 |
| `.probe/imports.mjs` | 15 个模块的导入自检 |
| `.probe/run-readonly.mjs` | 实跑只读工具组 |
| `.probe/run-target.mjs <tool> <json>` | 真机链路（探针 + 目标） |
| `.probe/run-serial.mjs` | 串口端到端（open → tx → rx → close） |
| `test/check-define-tool.mjs`、`test/check-tool-schemas.mjs` | 单元检查 |

看运行时编译出来的参数 schema（源码里写着 `type:'json'` 不代表它漏进了 function schema）：

```bash
node .probe/compiled-params.mjs
```

## License

MIT —— 见 [LICENSE](LICENSE)。版权归 lishuo4096。

`vendor/openocd/` 是 OpenOCD 0.12.0 的**原样再分发**，其自身许可是 **GNU GPL v2**，
许可证文本完整保留在该目录内（`license-openocd.txt` 等）。上面的 MIT 只覆盖本插件自身源码。
