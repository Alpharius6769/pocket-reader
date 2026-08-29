// Attributes the load-time footprint to engine phases, so scoping work targets
// the runtime or the model on evidence rather than on which is easier to blame.
// Needs: adb forward tcp:9222, jetsam.sh running, a cold Chrome on the app.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
const ADB = 'C:/Users/Chris/AppData/Local/Android/Sdk/platform-tools/adb.exe';
const BASE = 52;
const anon = () => { try { return Number(execFileSync(ADB,['shell','/data/local/tmp/mem.sh'],{encoding:'utf8'}).trim().split(/\s+/)[0]) - BASE; } catch { return -1; } };
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = b.contexts()[0].pages().find(p => p.url().includes('pocket-reader'));
const marks = [];
let lastPhase = null;
for (let i = 0; i < 260; i++) {
  const a = anon();
  const phase = await page.evaluate(() => {
    const m = [...document.querySelectorAll('.modal-overlay.active')][0];
    const ov = document.getElementById('global-loading-overlay');
    const t = (m?.innerText || ov?.innerText || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 70) || null;
  }).catch(() => 'PAGE GONE');
  if (phase !== lastPhase) { marks.push({ t: i, a, phase }); lastPhase = phase;
    console.log(`t=${i}s  ${String(a).padStart(4)}MB  ${phase}`); }
  if (phase === 'PAGE GONE') break;
  await new Promise(r => setTimeout(r, 1000));
}
console.log('\n--- phase deltas (app-only MB) ---');
for (let i = 1; i < marks.length; i++) {
  const d = marks[i].a - marks[i-1].a;
  console.log(`  ${String(marks[i-1].t).padStart(3)}s -> ${String(marks[i].t).padStart(3)}s  ${d >= 0 ? '+' : ''}${d} MB   ${String(marks[i-1].phase).slice(0,54)}`);
}
await b.close(); process.exit(0);
