---
name: mcu-debug
description: 调试、烧录、读回 STM32 与 PY32 单片机（ARM Cortex-M，CMSIS-DAP/DAPLink 探针）。也包含串口收发。当用户提到 STM32 / PY32 / Cortex-M / 单片机 / 烧录 / 固件 / DAPLink / CMSIS-DAP / SWD / openocd / 断点 / 寄存器 / 串口日志 时使用本技能。
metadata:
  user-invocable: true
---

# 单片机调试（STM32 / PY32）

用 `mcu_*` 工具组连目标、读寄存器与内存、烧录、读回、收发串口。

## 最要紧的三件事

**一、这个插件存在的唯一理由是「断点不会残留」。**

ARM 的软件断点靠**改写指令字节**实现。下了断点但 openocd 没体面退出，那个字节就留在
flash 里；之后如果又用「读回内存 → 烧回去」的方式刷固件，断点指令被**固化进固件** ——
每次上电都停在断点处，程序永远进不了 `main`，而且从日志上完全看不出来。

所以每次 openocd 调用的收尾**固定**是「逐个 `rbp` → `reset run`」，清断点在离开目标之前做。
你不需要记得清断点，也不该自己绕过这个收尾。

**二、用的是插件自带的 openocd 副本，不是 EIDE 里的那份。**

`<插件>/vendor/openocd/`（完整拷贝）。EIDE 的两份原件只读不写。原因：原件树里带着
厂商出厂的隐式配置，一旦以它为工作目录启动、又不给 `-f`，openocd 会自动 `source` 那些
配置，把会话顶成别的接口 —— 这是上一个插件踩过的坑。

**三、本机同时插着多个调试器，必须锁序列号。**

CMSIS-DAP 后端会**自己挑一个设备而且不报错**。本机有 mbed DAPLink（0D28:0204）、
WCH-Link（1A86:8010）、两块 FTDI。所以第一件事永远是 `mcu_probes`。

---

## 三十秒上手

```
1. mcu_probes                     ← 看有哪几个探针、驱动是否正常、序列号是什么
2. mcu_probe  target:"py32f030"   ← 连上做只读自检（认 IDCODE、报 flash 容量）
3. mcu_flash  image:"build/app.elf" confirm:true
                                  ← 烧录（自动先备份现有内容）
4. mcu_serial_open port:"COM21" baud:115200
   mcu_serial_rx  port:"COM21" timeoutMs:2000
                                  ← 看板子在说什么
```

`mcu_probe` 失败了**不要重试**。它是只读的，重试一百次也是同一个结果。
按它的「诊断」段走：先看探针，再看接线。

---

## 工具地图

| 组 | 工具 | 什么时候用 |
|---|---|---|
| 环境 | `mcu_env` | 怀疑环境有问题（找不到 openocd / gdb / 副本没就绪） |
| | `mcu_probes` | **每轮对话的第一条命令**，多调试器环境下必跑 |
| | `mcu_devices` | 查支持哪些型号、某个型号用哪个 cfg |
| | `mcu_projects` | 在目录里找固件（elf/hex/bin）与工程文件 |
| | `mcu_workspace` | 私有运行区的卫生审计 |
| | `mcu_help` | 排错剧本（见下） |
| 只读 | `mcu_probe` | 连接自检。**第一步** |
| | `mcu_regs` | 读 CPU 寄存器（PC/SP/LR/xPSR/R0-12） |
| | `mcu_mem` | 读内存（dump 成文件再本地 hexdump） |
| | `mcu_flash_info` | flash 容量、device id、**读保护状态** |
| | `mcu_read_flash` | 读回整片成文件（备份/抠固件/比对） |
| 写 | `mcu_flash` | 烧录（先备份 → 清断点 → 擦写校验 → 清断点 + reset run） |
| | `mcu_erase` | 擦除 / 解除读保护 |
| | `mcu_reset` | 复位（run / halt 抓启动现场 / init） |
| | `mcu_bp` | 断点：列 / 设 / 清 / 全清 |
| | `mcu_ocd` | 逃生舱：直接跑 openocd 命令（仍走同一套纪律） |
| 会话 | `mcu_session_open` | 起常驻 openocd（要反复看同一个现场时） |
| | `mcu_session_cmd` | 往会话发 openocd 命令 |
| | `mcu_session_close` | **体面关**（halt → 清断点 → shutdown） |
| | `mcu_gdb` | gdb：符号表 / 故障现场 / load |
| | `mcu_clean` | 清现场（残留进程、陈旧会话目录、可疑文件） |
| 串口 | `mcu_serial_list` | 列串口（**带来源分类**，蓝牙口会被点名） |
| | `mcu_serial_open` | 打开并保持 |
| | `mcu_serial_tx` / `mcu_serial_rx` | 发 / 收 |
| | `mcu_serial_close` | 关（`action:"shutdown"` 连宿主一起收） |

---

## 排错剧本

`mcu_help topic:"…"` 里有九套：

| topic | 用在 |
|---|---|
| `first_time` | 从零到上板 |
| `not_connecting` | 连不上（**先看探针**） |
| `multi_probe` | 分不清哪个探针是哪个 |
| `flash_ok_but_dead` | 烧录成功但板子没反应 |
| `bp_residue` | 怀疑断点残留 / 程序停在不是自己下的地方 |
| `target_support` | 型号支持与 cfg 选择 |
| `serial` | 串口收不到 / 收到乱码 |
| `sessions` | 常驻会话怎么用、怎么收 |
| `tools` | 工具全表 |

### 连不上时按这个顺序查（别跳步）

**第 0 步：`mcu_probes` 的「不可用」那一栏有没有直接写出根因？写了就先解决它。**

探针表会说清是哪一层断的。这四层现象一样、修法完全不同：

| 层 | 现象 | 怎么确认 |
|---|---|---|
| A 驱动层 | 设备管理器错误码 39 / 28 / 52 | 探针表直接给错误码 |
| B **模式层** | 插着、驱动也正常，但它**不说 CMSIS-DAP** | 探针表读出子接口名（`WCH-LinkRV` 等） |
| C 占用层 | 别的进程抓着探针 | `mcu_clean action:"scan"` |
| D 物理层 | 接线 / 供电 / 引脚复用 | 换目标试 |

**B 层最阴**：设备管理器里它一个惊叹号都没有，看起来完全正常。
典型案例就是 WCH-Link 处在 RISC-V 模式 —— PnP 健康，但它走厂商私有 SDI 协议，
openocd 打不开。这时候去查接线是白费功夫。

剩下的常规步骤：

1. 锁对了吗？serial 是否真的是目标那一个？`mcu_probe` 的报告里会打出锁定命令。
2. 接线：SWDIO/SWCLK/GND/3V3 四根，**共地是必须的**；NRST 可选。
3. 降到 500 kHz 或更低试一次（`speed:500`）—— 杜邦线长、目标时钟没起振时低速更稳。
4. 目标是否在低功耗模式（PY32 的 cfg 已经在 `examine-end` 里关掉 STOP 下的
   调试器失能，但深度睡眠/断电模式仍会掉线）。

**判定技巧**：同一根探针换个目标能不能连。能连 = 问题在目标侧；不能连 = 问题在探针侧。

### 烧录成功但板子没反应

- 先 `mcu_reset mode:"run"`（按理收尾已经做了，排除法）。
- 启动就挂：`mcu_reset mode:"halt"` 停住，`mcu_regs` 看 PC。
  停在 `0xFFFFFFxx` = HardFault；停在 flash 开头反复 = 时钟/向量表有问题。
- 看 `0xE000ED28`（CFSR）/ `0xE000ED2C`（HFSR）/ `0xE000ED38`（BFAR）
  用 `mcu_mem address:"0xE000ED28" length:16` 一把读出来。
- 串口上什么都看不到时，先确认目标**没被留在 halt 状态**（halt 时串口当然没输出）。

---

## 多探针：怎么区分

`mcu_probes` 的表里有 `vidpid` 与 `serial`：

- **mbed DAPLink** → `0d28:0204`，serial 形如 `68D7…`（32 位 hex）。
  它是复合设备，调试接口走 HID 或 bulk；串口是另一个子接口，要装 mbedserial 驱动才有。
- **WCH-Link** → `1a86:8010`。**只在 ARM/DAP 模式下**才说 CMSIS-DAP；
  RISC-V 模式下它就是个健康的普通 USB 设备，但 openocd 用不了。
- **FTDI** → `0403:601x`。FT2232H/FT4232H **本身能当调试器**，但要按实际接法选
  `interface/ftdi/*.cfg`（不是 cmsis-dap），插件不自动挑；FT232R 就只是串口。
  它的实例 ID 里那串 `9&3342557&0&3` 是**总线位置串**，不是真序列号，不能喂给 `adapter serial`。

传给工具的 `probe:` 参数接受三种写法：序列号、`vid:pid`、名字片段。
**多个同类探针同时插着时必须给序列号** —— 给 vid:pid 也会因为不唯一而报错，这是故意的
（宁可不选，也不猜错）。

### 「设备管理器里正常」≠「能用」

判据必须是三级，缺一不可：**驱动没错误码** + **有对应 interface cfg** + **模式对得上**。

第三级最容易被忽略，也最难自己发现：模式信息只写在**复合设备的子接口名字**里
（`WCH-LinkRV` = RISC-V 模式），顶层设备只叫「WCH-Link」，看不出来。
所以本插件专门把子接口挂回父设备，就为了读这一行字。

如果 `mcu_probe` 报 `unable to find a matching CMSIS-DAP device`，而探针表说某个探针
「不可用」并给了根因 —— **那就是根因，换探针参数重试没有用**。

---

## 两个容易踩的坑

**串口默认不拉 DTR/RTS。** 大量 USB 转串口板子把 DTR 接到目标 RESET。默认拉高会把目标
一直按在复位里 —— 表现是「口打开了、写进去了、但一个字节都收不到」，而且没有任何报错。
真要复位请用 `mcu_reset`。

**`mcu_mem action:"write"` 写的是内存不是 flash。** 复位/断电就没了，要持久化得写进 flash。

---

## 纪律（这些不是建议）

1. **`mcu_session_open` 之后一定要 `mcu_session_close`。** 会话占着探针和三个 TCP 端口，
   别的工具会连不上。
2. **`mcu_session_close` 默认拒绝强杀。** 强杀会跳过清断点那一步 —— 这正是要避免的事。
   只有明确 `force:true` 才强杀，而且**强杀之后请重烧一次固件**（烧录流程自带清断点）。
3. **不要在目标工程目录里跑 openocd。** 插件的进程 CWD 永远是私有会话目录，
   这不是配置项，`assertPrivateWorkdir()` 会抛异常挡住越界路径。
4. **烧录前默认会备份**目标现有内容到 `<插件>/backups/`。不想等就 `backup:false`，
   但那样目标上原有的东西就不可恢复。
5. **`mcu_flash` / `mcu_erase` 需要 `confirm:true`。** 这不是仪式 —— 它们会覆盖目标上的东西。
