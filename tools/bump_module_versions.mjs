// Settles the ?v= cascade. Written after a hand-rolled shell loop with an
// unvalidated variable expanded to `sed s/\b\b/.../g` and inserted text at every
// word boundary in 202 files. Everything here refuses to act on an empty or
// malformed token, and every replacement is an exact literal, never a pattern.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXT = new Set(['.js', '.mjs', '.html', '.json']);
const SKIP = new Set(['node_modules', '.git', '.venv', 'vendor', '.wrangler', 'dist', 'build']);

async function files(dir = ROOT, acc = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await files(full, acc);
    else if (EXT.has(path.extname(e.name))) acc.push(full);
  }
  return acc;
}

function pending() {
  let out = '';
  try { out = execFileSync('node', ['tools/check_module_versions.mjs'], { cwd: ROOT, encoding: 'utf8' }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  if (/consistent/.test(out)) return null;
  return [...out.matchAll(/^\s+(\S+\.js)\s+still at\s+\?v=(\S+)$/gm)].map((m) => ({ mod: m[1], ver: m[2] }));
}

const all = await files();

// Bump against the ORIGINAL manifest until the reported set stops growing, then
// re-baseline ONCE.
//
// Re-baselining inside the loop looks tidier and is wrong twice over: it hides
// the importers whose content changed only because a version they reference was
// bumped (measured: 11 of 12 modules silently absorbed), and because the check
// reports every content difference, the loop then re-bumps everything each pass
// and inflates every version by the round count.
let previous = '';
for (let round = 1; round <= 12; round++) {
  const todo = pending();
  if (!todo || !todo.length) break;
  const signature = todo.map((t) => t.mod).sort().join(',');
  if (signature === previous) break;      // fixed point: only content diffs remain
  previous = signature;

  for (const { mod, ver } of todo) {
    const m = /^(.*?)-v(\d+)$/.exec(ver);
    let from, to;
    if (ver.startsWith('sw-')) { const n = Number(ver.slice(3)); from = ver; to = `sw-${n + 1}`; }
    else if (m) { from = ver; to = `${m[1]}-v${Number(m[2]) + 1}`; }
    else { console.log(`  ?? unparseable version "${ver}" for ${mod} - skipped`); continue; }

    // Guards. An empty or identical token is the failure mode that corrupted the
    // tree; refuse rather than proceeding.
    if (!from || !to || from === to || from.length < 3) throw new Error(`unsafe token ${from} -> ${to}`);

    let touched = 0;
    for (const f of all) {
      const src = await readFile(f, 'utf8');
      if (!src.includes(from)) continue;
      await writeFile(f, src.split(from).join(to));
      touched++;
    }
    console.log(`  ${mod}: ${from} -> ${to} (${touched} files)`);

    if (ver.startsWith('sw-')) {
      const n = Number(ver.slice(3));
      for (const rel of ['public/sw.js', 'public/assets/js/settings_manager.js',
                         'public/index.html', 'public/assets/js/ui_controller.js',
                         'tools/smoke_pocket_worker_runtime.mjs']) {
        const f = path.join(ROOT, rel);
        let src = await readFile(f, 'utf8');
        src = src.split(`sw.js?v=${n}`).join(`sw.js?v=${n + 1}`);
        src = src.split(`pocket-reader-core-v${n}`).join(`pocket-reader-core-v${n + 1}`);
        src = src.split(`NARRATION_SERVICE_WORKER_VERSION = '${n}'`).join(`NARRATION_SERVICE_WORKER_VERSION = '${n + 1}'`);
        await writeFile(f, src);
      }
    }
  }
}
execFileSync('node', ['tools/check_module_versions.mjs', '--update'], { cwd: ROOT, stdio: 'inherit' });
console.log(execFileSync('node', ['tools/check_module_versions.mjs'], { cwd: ROOT, encoding: 'utf8' }).trim());
