/**
 * 冒烟测试：只验证模块能加载 + 只读路径能跑通（不碰探针、不写 flash）。
 * 用法：node .probe/smoke.mjs
 */
const base = 'C:/Users/lishuo/Documents/DSH_Project/插件开发/dsh-mcu-debug/lib/';
const toUrl = (p) => new URL(`file:///${p}`).href;

const mods = [
  'define-tool.js', 'result.js', 'frontmatter.js', 'skills.js',
  'env.js', 'mirror.js', 'hygiene.js', 'probes.js', 'devices.js', 'ocd.js', 'run.js',
  'tools-env.js',
];

let fail = 0;
const loaded = {};
for (const m of mods) {
  try {
    loaded[m] = await import(toUrl(base + m));
    const n = Object.keys(loaded[m]).length;
    console.log(`[ ok ] ${m.padEnd(18)} ${n} exports`);
  } catch (e) {
    fail++;
    console.log(`[FAIL] ${m.padEnd(18)} ${e.message}`);
    if (e.stack) console.log(String(e.stack).split('\n').slice(1, 4).join('\n'));
  }
}
console.log('');

// ---- 设备表
try {
  const d = loaded['devices.js'];
  const r = d.resolveTarget('PY32F030K18');
  console.log('[ ok ] resolveTarget(PY32F030K18) →', r.ok ? `${r.target.id} (${r.reason})` : `FAIL ${r.reason}`);
  const r2 = d.resolveTarget('stm32f103c8t6');
  console.log('[ ok ] resolveTarget(stm32f103c8t6) →', r2.ok ? `${r2.target.id} (${r2.reason})` : `FAIL ${r2.reason}`);
  const r3 = d.resolveTarget('stm32g030c8t6');
  console.log('[ ok ] resolveTarget(stm32g030c8t6) →', r3.ok ? `${r3.target.id} (${r3.reason})` : `FAIL ${r3.reason}`);
  const r4 = d.resolveTarget('py32f002a');
  console.log('[ ok ] resolveTarget(py32f002a) →', r4.ok ? `${r4.target.id}` : `FAIL ${r4.reason}`);
  const bad = d.resolveTarget('atmega328');
  console.log('[ ok ] resolveTarget(atmega328) →', bad.ok ? 'BUG: 不该认出' : `正确拒绝，候选 ${bad.candidates.map((c) => c.id).join('/') || '(无)'}`);
} catch (e) {
  fail++;
  console.log('[FAIL] devices', e.message);
}

// ---- openocd 定位 / cfg 解析
try {
  const o = loaded['ocd.js'];
  const loc = o.locateOpenocd();
  console.log('[ ok ] locateOpenocd →', loc.present ? `${loc.exe}` : 'MISSING', `| kind=${loc.kind}`);
  console.log('       scripts   →', loc.scriptsDir ?? '(无)');
  const c1 = o.resolveCfgPath('target/py32f030.cfg');
  const c2 = o.resolveCfgPath('interface/cmsis-dap.cfg');
  const c3 = o.resolveCfgPath('target/stm32f1x.cfg');
  console.log('[ ok ] py32f030.cfg ', c1.present ? 'present' : 'MISSING', o.toSlash ? '' : '');
  console.log('[ ok ] cmsis-dap.cfg', c2.present ? 'present' : 'MISSING');
  console.log('[ ok ] stm32f1x.cfg ', c3.present ? 'present' : 'MISSING');
  const seq = o.buildSessionSequence({
    interfaceCfg: c2.path,
    targetCfg: c1.path,
    probeCmds: ['adapter serial ABCDEF', 'transport select swd'],
    targetCmds: ['adapter speed 1000'],
    cmds: ['init', 'halt'],
  });
  const argv = o.buildArgs({ sequence: seq, searchDirs: loc.searchDirs, footer: 'run' });
  console.log('[ ok ] argv =\n       openocd', argv.join(' '));
} catch (e) {
  fail++;
  console.log('[FAIL] ocd', e.message);
}

// ---- 探针
try {
  const p = loaded['probes.js'];
  const t0 = Date.now();
  const list = p.listProbes();
  console.log(`[ ok ] listProbes → ok=${list.ok} 用时 ${Date.now() - t0}ms 设备数=${list.deviceCount ?? '?'}`);
  if (list.ok) {
    for (const pr of list.probes) {
      console.log(
        `       ${pr.usable ? '可用  ' : '不可用'} ${pr.label} [${pr.vidpid}] serial=${pr.serial ?? '(无)'}` +
          ` usableSerial=${pr.serialUsable}` + (pr.errorCode ? ` ERR=${pr.errorCode}` : '') +
          (pr.children?.length ? ` 子接口=${pr.children.length}` : ''),
      );
    }
    const sel = p.selectProbe(list.probes, {});
    console.log('[ ok ] selectProbe(自动) →', sel.ok ? `选中 ${sel.probe.label}` : `拒绝（正确）：${sel.reason.slice(0, 120)}`);
  }
} catch (e) {
  fail++;
  console.log('[FAIL] probes', e.message);
}

// ---- run.plan（只做计划，不执行）
try {
  const rn = loaded['run.js'];
  const plan = rn.planRun({ target: 'py32f030', cmds: ['init', 'halt', 'flash probe 0'] });
  if (plan.ok) {
    console.log('[ ok ] planRun →', plan.target.id, '| 探针', plan.probe.label, '|', plan.probe.serial ?? '(无)');
    console.log('       速度', plan.speed, 'kHz | 步骤', plan.sequence.length);
  } else {
    console.log('[ ok ] planRun 正确拒绝：', String(plan.error).split('\n')[0].slice(0, 200));
  }
} catch (e) {
  fail++;
  console.log('[FAIL] run', e.message);
}

console.log('');
console.log(fail === 0 ? '=== 冒烟测试全部通过 ===' : `=== ${fail} 项失败 ===`);
process.exit(fail ? 1 : 0);
