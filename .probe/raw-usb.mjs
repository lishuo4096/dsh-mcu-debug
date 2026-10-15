/** 复用插件自己的 enumerateUsb，看原始父子与错误码。 */
const toUrl = (p) => new URL(`file:///${p}`).href;
const base = 'C:/Users/lishuo/Documents/DSH_Project/插件开发/dsh-mcu-debug/lib/';
const { enumerateUsb, isChildInterface, topInstance, vidPidOf, serialOf } = await import(toUrl(base + 'probes.js'));

const r = enumerateUsb();
console.log('ok=', r.ok, 'devices=', r.devices.length, r.error ?? '');
const interesting = r.devices.filter((d) =>
  /0D28|8010|0403/i.test(d.instanceId) || /dap|wch|ftdi|link|composite|serial/i.test(d.name),
);
for (const d of interesting) {
  const child = isChildInterface(d.instanceId);
  console.log(`err=${String(d.errorCode).padStart(3)}  ${child ? '子  ' : '顶层'}  ${d.name}`);
  console.log(`      id  =${d.instanceId}`);
  console.log(`      top =${topInstance(d.instanceId)}  vidpid=${vidPidOf(d.instanceId)} serial=${serialOf(d.instanceId)}`);
  console.log(`      svc=${d.service}  status=${d.status}`);
}
