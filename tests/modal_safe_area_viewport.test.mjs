import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ── The first-run modals could not be dismissed in an installed iOS PWA ──────
//
// .pr-layout-001 (the overlay behind BOTH first-run modals) had no box-sizing,
// so height:100% sized its CONTENT box to the viewport and the safe-area
// padding was added on top. Measured in-browser at 402x874 with the real
// iPhone insets (59px Dynamic Island, 34px home indicator): the overlay came
// out 967px tall on an 874px screen -- 93px of overflow, exactly the two
// insets. position:fixed makes that surplus unscrollable, so Save/Skip sat
// under the home indicator where the system swipe gesture eats the tap, and a
// drag only rubber-banded and sprang back.
//
// In a Safari TAB the insets report 0, the padding falls back to 20px, and the
// 40px of overflow left the buttons inside the card's own bottom padding --
// which is why it looked PWA-specific.
//
// After the fix, same measurement: overlay exactly 874px, 0 overflow, buttons
// at 740-817 (25px clear of the home indicator) and hit-testable with the form
// scrolled to the TOP.

test('the modal overlay includes its safe-area padding inside the viewport box', async () => {
  const css = await read('public/assets/css/theme.css');
  const rule = css.slice(css.indexOf('.pr-layout-001 { display:flex'));
  const overlay = rule.slice(0, rule.indexOf('}') + 1);
  assert.match(overlay, /box-sizing:border-box/,
    'without border-box the safe-area padding grows the overlay past the screen');
  assert.match(overlay, /height:100dvh/,
    'the overlay should track the dynamic viewport, not just the initial one');
  // The padding that caused the overflow must still be there -- the point is
  // that it now sits INSIDE the box, not that it was removed.
  assert.match(overlay, /padding-top:max\(20px,env\(safe-area-inset-top,20px\)\)/);
  assert.match(overlay, /padding-bottom:max\(20px,env\(safe-area-inset-bottom,20px\)\)/);
});

test('a modal card is bounded by the space it actually has, not by 90dvh', async () => {
  const css = await read('public/assets/css/theme.css');
  const rule = css.slice(css.indexOf('.pr-layout-002 { width:100%'));
  const card = rule.slice(0, rule.indexOf('}') + 1);
  // 90dvh measured against the viewport while the room available is the
  // overlay's content box -- viewport minus padding minus the safe areas.
  assert.ok(!/max-height:90dvh/.test(card), 'the card must not be sized against the raw viewport');
  assert.ok(!/max-height:90vh/.test(card), 'the card must not be sized against the raw viewport');
  assert.match(card, /max-height:100%/);
  assert.match(card, /box-sizing:border-box/);
});

test('the first-run modals pin their buttons to the bottom of the card', async () => {
  const css = await read('public/assets/css/theme.css');
  const start = css.indexOf('#device-setup-modal .modal-buttons,');
  assert.ok(start !== -1, 'sticky footer rule for the first-run modals is missing');
  const block = css.slice(start, css.indexOf('}', start) + 1);
  assert.match(block, /#first-time-setup-modal \.modal-buttons/);
  assert.match(block, /position: sticky;/);
  // Opaque, or the scrolling form shows through the bar.
  assert.match(block, /background: #151617;/);
});

// The overlay is what the safe areas act on, so both first-run modals have to
// keep using the shared class rather than growing a private overlay that
// silently misses the fix.
test('both first-run modals still use the shared overlay class', async () => {
  const html = await read('public/index.html');
  assert.match(html, /class="pr-layout-001 device-setup-modal" id="device-setup-modal"/);
  assert.match(html, /class="pr-layout-001" id="first-time-setup-modal"/);
});
