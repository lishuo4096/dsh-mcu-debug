const mods = ['define-tool','result','frontmatter','skills','hygiene','env','mirror','probes','devices','ocd','run','serial','tools-env','tools-serial','tools-debug'];
for (const m of mods) {
  try { const x = await import(`../lib/${m}.js`); console.log(`OK   ${m}  (${Object.keys(x).length} exports)`); }
  catch (e) { console.log(`FAIL ${m}  ${e.message}`); }
}
