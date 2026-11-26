// Keeps the pre-v2 shell working while the cores speak only through
// core_events.js. Every core event names the global the core used to call
// directly; this replays that call with the original arguments, guarded the
// same way the call sites were (a missing global is a no-op), and hands the
// return value back to the core.
//
// Deleted together with the old shell (public/index.html, ui_controller.js and
// friends). The new UI listens on the same events through bridge.ts and has no
// use for this file.
import { coreEvents, CORE_EVENT } from './core_events.js?v=core-events-v4';

function replay(event) {
  const detail = event.detail || {};
  const fn = detail.legacy && window[detail.legacy];
  if (typeof fn !== 'function') return;
  detail.result = fn(...(Array.isArray(detail.args) ? detail.args : []));
}

for (const type of Object.values(CORE_EVENT)) {
  coreEvents.addEventListener(type, replay);
}

// Tells the cores the old shell is mounted. A few legacy-only behaviours key on
// it -- e.g. switchReaderVoiceEngine waits for #voice-selector to exist -- and
// must not run under the new UI, where those elements never appear.
window.__prLegacyShell = true;

// Events with no legacy global: paint the old shell's elements directly, as
// the cores used to.
coreEvents.addEventListener(CORE_EVENT.STATUS, (event) => {
  const text = event.detail?.text ?? '';
  const bufferText = document.getElementById('reader-buffer-text');
  if (bufferText) bufferText.innerText = text;
  const modalText = document.getElementById('caching-progress-text');
  if (modalText) modalText.innerText = text;
});
coreEvents.addEventListener(CORE_EVENT.PROGRESS, (event) => {
  const fill = document.getElementById('caching-progress-fill');
  if (fill) fill.style.width = `${event.detail?.pct ?? 0}%`;
});
