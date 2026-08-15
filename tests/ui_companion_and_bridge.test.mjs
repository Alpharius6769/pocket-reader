// Guards for the companion layout, in-app notices, and the Anthronomicon bridge.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(p, 'utf8');

test('Virtue speech never shrinks below a legible size', async () => {
  // The old fitter stepped down to 5.5px, which is unreadable on any screen and
  // worst on the phones where the bubble is smallest — "fitted" and invisible.
  const source = await read('public/assets/js/virtue_controller.js');
  const floor = Number(source.match(/MIN_FONT_PX\s*=\s*_isMobileViewport\(\)\s*\?\s*([\d.]+)/)?.[1]);
  assert.ok(Number.isFinite(floor), 'a legibility floor must be defined');
  assert.ok(floor >= 8, `mobile floor ${floor}px is below readable size`);
  assert.doesNotMatch(source, /const minimum = 5\.5/);
  // Overflow past the floor clamps instead of shrinking further.
  assert.match(source, /clamped-text/);
});

test('Virtue text fitting does not thrash layout', async () => {
  // fit() runs multiple times per appearance and again on every resize, and
  // each iteration is a forced synchronous reflow (style write, then a
  // scrollHeight read). The old linear 0.3px walk allowed 35 of them per call.
  const source = await read('public/assets/js/virtue_controller.js');
  assert.doesNotMatch(source, /attempts\+\+ < 35/, 'linear shrink loop must be gone');
  assert.match(source, /Binary search/i);
  const iterations = Number(source.match(/for \(let i = 0; i < (\d+) && hi - lo/)?.[1]);
  assert.ok(iterations && iterations <= 10, `binary search should converge in <=10 steps, got ${iterations}`);
});

test('the Virtue resize observer cannot feed back or leak', async () => {
  // It observes the very element whose font-size the callback rewrites.
  const source = await read('public/assets/js/virtue_controller.js');
  assert.match(source, /fitScheduled/, 'resize handling must be coalesced into a frame');
  assert.match(source, /_virtueFitObserver\?\.disconnect\(\)/,
    'the observer must disconnect when the companion is off screen');
});

test('the mobile companion clears the tab bar including the safe area', async () => {
  // A hardcoded 64px assumed the 58px tab bar sat flush to the screen bottom.
  // With a home indicator the bar occupies 58px + inset (~34px on iPhone), so
  // Virtue rendered inside it and covered the controls it was raised to avoid.
  const css = await read('public/assets/css/theme.css');
  // Collect every .virtue-container.active rule body; the desktop one has no
  // bottom offset, the mobile ones must clear the bar plus the inset.
  const rules = [...css.matchAll(/\.virtue-container\.active\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(rules.length >= 2, 'expected a desktop and at least one mobile companion rule');
  const withBottom = rules.filter((body) => /bottom:/.test(body));
  assert.ok(withBottom.length > 0, 'no mobile rule offsets the companion above the tab bar');
  for (const body of withBottom) {
    assert.match(body, /bottom:\s*calc\(\d+px \+ env\(safe-area-inset-bottom/,
      `companion offset ignores the home-indicator inset: ${body.trim()}`);
  }
  assert.doesNotMatch(css, /\.virtue-container\.active\s*\{[^}]*bottom:\s*64px/);
});

test('short status messages use the in-app notice, not a blocking dialog', async () => {
  // alert() blocks the page, reads as a system failure inside an installed PWA,
  // and interrupts audio focus on iOS standalone.
  const ui = await read('public/assets/js/ui_controller.js');
  assert.match(ui, /export function pocketNotify/);
  assert.match(ui, /window\.virtueSpeak/, 'notices should route through the companion');
  assert.match(ui, /if \(typeof alert === 'function'\) alert\(text\)/,
    'a message must never be lost if the companion is unavailable');

  for (const file of ['public/assets/js/audio_core.js', 'public/assets/js/api_core.js']) {
    const source = await read(file);
    for (const gone of [
      "alert('No story loaded.')",
      "alert('Web Speech API not supported in this browser.')",
      "alert('Unsupported file type.')",
    ]) {
      assert.ok(!source.includes(gone), `${file} still raises a blocking dialog: ${gone}`);
    }
  }
});

test('below-the-fold imagery is deferred', async () => {
  const html = await read('public/index.html');
  const lazy = [...html.matchAll(/loading="lazy"/g)].length;
  assert.ok(lazy >= 5, `expected deferred images in hidden views, found ${lazy}`);
  // Nav icons and the landing header must stay eager — deferring those would
  // trade a real regression for a synthetic win.
  const navBlock = html.slice(html.indexOf('home%20192.png') - 200, html.indexOf('about%20192.png') + 200);
  assert.doesNotMatch(navBlock, /loading="lazy"/, 'visible nav icons must not be lazy');
});

test('the Anthronomicon bridge is origin-scoped in both directions', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  assert.match(ui, /export const HMOFA_ORIGIN = 'https:\/\/alpharius6769\.github\.io'/);
  // Inbound: the handler calls loadStory() with a URL taken from the message.
  assert.match(ui, /event\.origin !== HMOFA_ORIGIN/);
  // Outbound: the handshake must not be broadcast to '*'.
  assert.match(ui, /postMessage\(\{[\s\S]{0,200}?\}, HMOFA_ORIGIN\)/);
});

test('the bridge handshake survives the iframe-load race', async () => {
  // The inline onload="" attribute fired before ui_controller (a deferred
  // module) defined the handler, so the handshake was never sent at all.
  const ui = await read('public/assets/js/ui_controller.js');
  const html = await read('public/index.html');
  assert.doesNotMatch(html, /onload="window\.setupHmofaIframeBridge\(\)"/);
  assert.match(ui, /iframe\.addEventListener\('load'/);
  assert.match(ui, /if \(iframe\.contentWindow\) setupHmofaIframeBridge\(\)/,
    'an already-loaded frame must still get the handshake');
  assert.match(ui, /pocket_reader_ping/, 'the index must be able to request a fresh handshake');
});

test('the bridge banner only claims tap-to-fetch once acknowledged', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  const html = await read('public/index.html');
  assert.match(html, /id="hmofa-bridge-status"/);
  assert.doesNotMatch(html, /App Interceptor Active/,
    'the banner must not assert a capability before the index acknowledges');
  assert.match(ui, /pocket_reader_ready/);
  assert.match(ui, /_setHmofaBridgeConnected\(false\)/, 'a reloaded frame resets to unacknowledged');
});

test('batch import is sequential and bounded', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  const limit = Number(ui.match(/HMOFA_BATCH_LIMIT = (\d+)/)?.[1]);
  assert.ok(limit && limit <= 50, `batch limit ${limit} is too permissive for a phone`);
  // loadStory aborts any in-flight load, so parallel calls would cancel each
  // other and only the last would survive.
  assert.match(ui, /for \(const entry of entries\.slice\(0, -1\)\)[\s\S]{0,200}await window\.loadStory/);
  assert.match(ui, /preventNavigate: true/, 'batch imports must not drag the reader through each story');
});
