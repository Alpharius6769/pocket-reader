// Drives the app in the emulator over CDP and logs app-only footprint.
//
//   adb forward tcp:9222 localabstract:chrome_devtools_remote
//   node tests/android-oom/run_scenario.mjs
//
// BASE must match BASELINE_MB in jetsam.sh (Chrome's own renderer cost).
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
const ADB = 'C:/Users/Chris/AppData/Local/Android/Sdk/platform-tools/adb.exe';
const BASE = 52;
const sh = c => { try { return execFileSync(ADB,['shell',c],{encoding:'utf8'}).trim(); } catch { return ''; } };
const anon = () => Number(sh('/data/local/tmp/mem.sh').split(/\s+/)[0]) || -1;
const jet = () => sh('grep JETSAM /data/local/tmp/jetsam.log | tail -2');
const log = (...a) => console.log(new Date().toISOString().slice(11,19), ...a);
async function grab(){ const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ps=b.contexts()[0].pages(); return {b,page:ps.find(p=>p.url().includes('pocket-reader'))||ps[0]}; }
let {b,page}=await grab();
const errs=[];
const wire=p=>{ p.on('console',m=>{if(m.type()==='error'){errs.push(m.text().slice(0,140));}});
  p.on('pageerror',e=>errs.push('PE '+String(e).slice(0,140)));
  p.on('crash',()=>log('  *** RENDERER CRASH ***')); };
wire(page);
await page.evaluate(()=>{ ['home-view','library-view','reading-view'].forEach(v=>{try{localStorage.setItem('pr_tips_'+v,'done');}catch(e){}});
  document.getElementById('pr-tip-layer')?.remove();
  document.querySelectorAll('.modal-overlay.active').forEach(m=>m.classList.remove('active'));
  window.showView('library-view'); });
await new Promise(r=>setTimeout(r,3000));
const key = await page.evaluate(()=>document.querySelector('#library-grid .story-card')?.dataset.storyKey);
log(`APP BUDGET 350MB (chrome baseline ${BASE}MB excluded) — loadStory ${key}, app=${anon()-BASE}MB`);
await page.evaluate(k=>window.loadStory(k), key);
let peak=0, kills=0, last=-1, stall=0, played=false;
for (let i=0;i<600;i++){
  await new Promise(r=>setTimeout(r,5000));
  const a=anon(), app=a-BASE; if(app>peak)peak=app;
  let st;
  try {
    st = await page.evaluate(()=>({
      cached: window.BufferManager?.cachedCount ?? null,
      active: window.BufferManager?.isActive,
      ch: window.currentChapterIndex, p: window.currentParagraphIndex,
      playing: !!window.isPlaying,
      modal: [...document.querySelectorAll('.modal-overlay.active')].map(x=>x.innerText.replace(/\s+/g,' ').slice(0,42))[0]||null,
    }));
  } catch(e){
    const j=jet(); if(j) kills++;
    log(` t=${i*5}s <<TAB KILLED>> peak_app=${peak}MB ${j?('*** '+j+' ***'):''}`);
    try{await b.close();}catch(_){}
    await new Promise(r=>setTimeout(r,5000));
    try{ ({b,page}=await grab()); wire(page); log('   [reconnected]'); }catch(_){}
    continue;
  }
  if(st.cached!==last){last=st.cached; stall=0;} else stall++;
  log(` t=${i*5}s app=${app}MB(pk${peak}) cached=${st.cached} play=${st.playing} pos=${st.ch}:${st.p} ${st.modal?'| '+st.modal:''}`);
  // Once enough audio exists, start playback so we exercise listening too.
  if (!played && st.cached >= 3) {
    played = true;
    const r = await page.evaluate(()=>{ const btn = document.getElementById('caching-progress-dismiss-btn');
      if (btn) { btn.click(); return 'clicked Begin Playback'; }
      if (typeof window.togglePlayPause==='function'){ window.togglePlayPause(); return 'togglePlayPause'; }
      return 'no control found'; });
    log('   PLAYBACK: ' + r);
  }
  if (st.cached >= 42 && st.p >= 40) { log('*** 40+ PARAGRAPHS CACHED AND PLAYED ***'); break; }
  if (stall > 60) { log('*** stalled 300s ***'); break; }
}
log(`RESULT peak_app=${peak}MB budget=350MB kills=${kills}`);
log('jetsam:', jet() || '(no kill)');
log('errors:', JSON.stringify([...new Set(errs)].slice(0,6)));
try{await b.close();}catch(_){}
process.exit(0);
