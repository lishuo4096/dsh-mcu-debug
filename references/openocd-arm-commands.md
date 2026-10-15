# OpenOCD 0.12.0 命令速查（STM32 / PY32 / ARM Cortex-M）

这份是 `mcu_ocd` 的「逃生舱手册」：当封装工具（`mcu_probe` / `mcu_flash` / …）不够用时，
你可以直接往 `mcu_ocd` 的 `cmds` 里塞这一页的命令。

**所有命令进 `mcu_ocd` 前都要遵守两条硬规矩**（插件的 `buildArgs` 会强制校验）：

1. **不能有双引号 `"`** —— 会被 `-c` 的外层引号吃掉。
2. **不能有反斜杠 `\`** —— TCL 会把它当转义引导符。路径一律正斜杠 `C:/...`。

还有一条不是规矩，但会咬人：**`shutdown` 不要自己写**。插件在收尾统一处理，
你自己写的会被静默跳过（就是为了防止你把收尾搞乱）。

---

## 一、连接与识别

| 命令 | 作用 |
|---|---|
| `init` | 初始化适配器 + 目标。**任何操作的第一条** |
| `halt` | 停住 CPU（读内存/清断点前必须） |
| `reset halt` | 复位并停在入口 |
| `reset run` | 复位并放跑 |
| `targets` | 列出所有 target 及其状态 |
| `adapter speed 1000` | 设 SWD 时钟（kHz）。**只在下一次 `init` 前生效** |
| `transport select swd` | 选 SWD（必须在 target cfg 之前） |
| `adapter serial <序列号>` | **锁定具体探针**（多探针时必须） |
| `scan_chain` | JTAG 扫描链（SWD 下无意义） |

PY32 的 cfg 已经在 `reset-init` 事件里把时钟切到 HSI 24 MHz 并把 `adapter speed`
提到 4000；如果你手改速度，注意会被这个事件覆盖。

---

## 二、flash 操作

| 命令 | 作用 |
|---|---|
| `flash probe 0` | 探测 bank 0，打印基址/容量/驱动名 |
| `flash banks` | 列出所有 bank 及其配置 |
| `flash info 0` | 详细扇区表（**最有用的一条**，看清页大小与保护区） |
| `program {路径} [地址] [verify]` | **内建烧录**：自动擦写校验。裸 bin 必须给地址 |
| `verify_image {路径} [地址]` | 只校验，不写 |
| `flash erase_sector 0 0 last` | 擦 bank 0 从 0 号到最后一个扇区（`last` 由驱动自己算） |
| `flash erase_address 0x08000000 0x1000` | 按地址区间擦 |
| `flash protect_check 0` | **读保护位**。`flash probe` 不报这个 |
| `flash protect 0 0 last off` | 解除整片读保护（会擦掉内容） |
| `flash read_bank 0 {文件} [地址] [长度]` | 把 flash 读进文件 |

**为什么擦除用 `last` 而不是自己算页数**：PY32F030 与 STM32F103 的页大小差一个数量级
（前者 128 B 级、后者 1 KB/2 KB），而且同族不同容量型号也不一样。让 flash 驱动
自己算扇区表，比人手算可靠。

---

## 三、内存与寄存器

| 命令 | 作用 |
|---|---|
| `mdw 0x20000000 16` | 按 32 位读 16 个字 |
| `mdb` / `mdh` | 按字节 / 半字读 |
| `mww 0x40021000 0x1` | 写 32 位（**慎用**，写错时钟寄存器直接挂） |
| `reg pc` / `reg` | 读单个 / 全部寄存器 |
| `dump_image {文件} {地址} {长度}` | 内存 dump 到文件 |
| `load_image {文件} {地址} bin` | 文件加载到内存 |

读回来的原始数据建议用 `mcu_mem` 而不是手搓 `mdw`：`mcu_mem` 会把结果 dump 成文件
再在本地做 hexdump，输出更整齐，也不会漏掉大块内容。

---

## 四、断点（**这是断点残留问题的核心**）

| 命令 | 作用 |
|---|---|
| `bp` | **不带参数 = 列出所有断点号** |
| `bp 0x08000100` | 在该地址下断点 |
| `bp 0x08000100 2 hw` | 下 2 字节宽的**硬件**断点 |
| `rbp <号>` | 删掉指定断点 |
| `rbp all` | 删掉全部 —— **流传很广，但 0.12 手册没确认这个写法** |
| `wp 0x20000000 4 r` | 读观察点 |

### 为什么本插件用 `catch {foreach a [bp] { rbp $a }}` 而不是 `rbp all`

因为 `rbp all` 没在手册里确认过。上面那句是**先列举再逐个删**，语义等价而且一定成立。
`catch` 是必须的：在非 halt 状态下清断点会返回错误，不加 `catch` 整个脚本就断在那里。

### 断点为什么会「残留」进 flash

- Cortex-M 的 `bp` 用 **FPB 硬件比较器**（改调试寄存器），**不动 flash**。FPB 只有 2–6 个
  比较器，所以「断点加到第 5 个就不灵了」是硬件上限，不是 bug。
- 但有些驱动/工具会 fallback 到**软件断点** —— 那是往 flash 里写 `BKPT` 指令。
  如果这时 flash 又被 `program` 写了一遍（或者在调试态下被读出去固化），
  断点就变成固件的一部分了：**之后每次运行都停在那个地址，而且新烧的固件也被打上**。
- 本插件的对策：**每次 openocd 调用收尾都固定执行「清断点 → `reset run`」**，
  顺序不能反（清断点必须在 halt 态，`reset run` 之后就不是 halt 了）。
  这也是为什么插件坚持用**独立 openocd 副本** —— 避免别的工具留下的配置影响它。

---

## 五、PY32 / STM32 型号相关

| 事项 | 说明 |
|---|---|
| PY32 内核 | Cortex-M0+，**SWD only**（没有 JTAG） |
| PY32 flash 基址 | `0x08000000` |
| PY32 RAM 基址 | `0x20000000` |
| PY32 cfg 变量 | `FLASH_SIZE` 默认 `0` = **自动探测**（32K/64K 两种型号都存在） |
| STM32 族级 cfg | `stm32f0x` / `stm32f1x` / `stm32f4x` / `stm32g0x` / `stm32l4x` … |
| 注意 | `stm32l0.cfg` 与 `stm32l1.cfg` **文件名不带 x** |

**为什么插件只用族级 cfg**：openocd 连上后会读 `DBGMCU_IDCODE` / flash 容量寄存器
自动认型号，所以 `stm32f1x.cfg` 能同时覆盖 F103C8（64K）和 F103RC（256K）。
用族级 cfg 少一张型号表，也少一类「型号写错→烧到错误地址」的事故。

PY32 的 cfg 还会在 `examine-end` 里写 `DBGMCU_CR |= DBG_STOP` 与
`DBGMCU_APB_FZ1 |= DBG_IWDG_STOP|DBG_WWDG_STOP` —— 意思是**调试时暂停看门狗**。
如果你发现「跑起来就复位、单步却正常」，先看这里是不是被别的工具改掉了。

---

## 六、多探针：为什么必须 `adapter serial`

openocd 不带 `adapter serial` 时，会在所有能打开的 CMSIS-DAP 设备里**自己挑一个**。
它不报错，只是把命令发给了另一个探针 —— 你会在**连错的目标**上做完全部操作，
而且换一次 USB 口，挑中的可能就是另一个。

本机的坑（实测）：

- `1a86:8010` WCH-Link 在 **RISC-V 模式**下 PnP 完全正常，但它走厂商私有 SDI，
  openocd 的 `cmsis-dap` 驱动打不开它（`Operation not supported or unimplemented
  on this platform`）。**设备管理器里的「正常」不代表能说 CMSIS-DAP。**
- `0403:6014` FTDI 的实例 ID 尾部 `9&3342557&0&3` 是**总线位置串**不是真序列号，
  喂给 `adapter serial` 一定匹配不上。
- `0d28:0204` DAPLink 若驱动没加载（错误码 39），HID 与 bulk 两条后端都无设备可开，
  报错是一句笼统的 `unable to find a matching CMSIS-DAP device`。

所以插件默认**不猜**：多个可用探针时报错并列出 serial，只有一个时才自动选定并记住。
