/**
 * 串口端到端：走完整的 工具 → serial.js → 常驻 powershell 宿主 → SerialPort 链路。
 * 用法：node .probe\run-serial.mjs [COM口]   （默认 COM21 = WCH-Link 自带的串口）
 */
import { apply } from '../index.js';

const PORT = process.argv[2] ?? 'COM21';

const registered = new Map();
apply({
  tools: { register: (t) => registered.set(t.name, t) },
  skills: { registerProvider: () => {} },
});

async function call(tool, args) {
  const t = registered.get(tool);
  if (!t) { console.log(`!! 没有 ${tool}`); return null; }
  console.log(`\n${'='.repeat(78)}\n>>> ${tool} ${JSON.stringify(args)}\n${'='.repeat(78)}`);
  const t0 = Date.now();
  try {
    const v = await t.execute(args, { cwd: process.cwd() });
    console.log(t.output.render(args, v)[0].text);
    console.log(`\n[${Date.now() - t0} ms] ok=${v?.ok}`);
    return v;
  } catch (e) {
    console.log(`!! 抛异常：${e?.name}: ${e?.message}`);
    if (e?.violations) console.log('   violations:', e.violations);
    return null;
  }
}

// 1) 打开
const opened = await call('mcu_serial_open', { port: PORT, baud: 115200, note: '冒烟测试' });
if (!opened?.ok) {
  console.log(`\n打不开 ${PORT} —— 到这里就算完成了（链路已通，是口本身的问题）。`);
  process.exit(0);
}

// 2) 写一行（大概率没有回显，除非把 TX/RX 短接，或对端有程序在跑）
await call('mcu_serial_tx', { port: PORT, text: 'AT\r\n' });
// 2b) 十六进制模式：走同一套链路但字节是手工拼的
await call('mcu_serial_tx', { port: PORT, hex: true, text: '01 03 00 00 00 02 c4 0b' });

// 3) 读（超时无数据是正常结果，不是失败）
const rx = await call('mcu_serial_rx', { port: PORT, timeoutMs: 1500 });

// 4) 再读一次：验证「保持打开」不会重置统计、不会丢状态
const rx2 = await call('mcu_serial_rx', { port: PORT, timeoutMs: 800 });

// 5) 关掉（只关口，不关宿主）
await call('mcu_serial_close', { port: PORT });

// 6) 再列一次：应显示「宿主在跑、没有打开的口」
await call('mcu_serial_list', {});
