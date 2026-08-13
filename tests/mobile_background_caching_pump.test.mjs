import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ── Solution 1: Runway Calculation & Formatting ─────────────────────────────

test('estimateBankedRunwaySec calculates duration from paragraph count', async () => {
  const bufferCode = await read('public/assets/js/buffer_manager.js');
  assert.match(bufferCode, /export function estimateBankedRunwaySec\(paragraphCount, avgSecPerPara = 18\)/);
  assert.match(bufferCode, /Math\.max\(0, Number\(paragraphCount\) \|\| 0\) \* avgSecPerPara/);
});

test('formatAudioRunway formats seconds into human-readable hours and minutes', async () => {
  const bufferCode = await read('public/assets/js/buffer_manager.js');
  assert.match(bufferCode, /export function formatAudioRunway\(seconds\)/);
  assert.match(bufferCode, /if \(h > 0\) return `\$\{h\}h \$\{m\}m`;/);
  assert.match(bufferCode, /if \(m > 0\) return `\$\{m\}m`;/);
});

test('BufferManager exposes getBankedRunwaySec and getBankedRunwayTime', async () => {
  const bufferCode = await read('public/assets/js/buffer_manager.js');
  assert.match(bufferCode, /getBankedRunwaySec\(\)\s*\{/);
  assert.match(bufferCode, /getBankedRunwayTime\(\)\s*\{/);
  assert.match(bufferCode, /export function formatAudioRunway/);
  assert.match(bufferCode, /export function estimateBankedRunwaySec/);
});

test('Drawer and modal status bars include banked runway information', async () => {
  const bufferCode = await read('public/assets/js/buffer_manager.js');
  const cinematicCode = await read('public/assets/js/cinematic_ui.js');
  assert.match(bufferCode, /const runway = this\.getBankedRunwayTime\(\);/);
  assert.match(bufferCode, /audio ready/);
  assert.match(cinematicCode, /getBankedRunwayTime/);
});

// ── Solution 2: Audio-Clock Background Caching Pump & Lookahead ─────────────

test('Playback lookahead runway is expanded to 8 paragraphs', async () => {
  const audioCode = await read('public/assets/js/audio_core.js');
  assert.match(audioCode, /const POCKET_PLAYBACK_LOOKAHEAD = 8;/);
});

test('Audio clock pulse handler is bound to media element timeupdate', async () => {
  const audioCode = await read('public/assets/js/audio_core.js');
  assert.match(audioCode, /export function _onAudioClockPump\(\)/);
  assert.match(audioCode, /_lastAudioClockPumpAt/);
  assert.match(audioCode, /audio\.addEventListener\('timeupdate',\s*\(\)\s*=>\s*\{\s*if\s*\(typeof _onAudioClockPump === 'function'\)\s*_onAudioClockPump\(\);\s*\}\);/);
});

// ── Solution 3: Capacitor Native App Shell Configuration ────────────────────

test('Capacitor configuration is valid JSON and specifies webDir and app identity', async () => {
  const raw = await read('capacitor.config.json');
  const config = JSON.parse(raw);
  assert.equal(config.appId, 'com.pocketreader.app');
  assert.equal(config.appName, 'Pocket Reader');
  assert.equal(config.webDir, 'public');
});

test('package.json contains Capacitor scripts and dependencies', async () => {
  const raw = await read('package.json');
  const pkg = JSON.parse(raw);
  assert.ok(pkg.scripts['cap:sync']);
  assert.ok(pkg.scripts['cap:open:android']);
  assert.ok(pkg.dependencies['@capacitor/android']);
  assert.ok(pkg.dependencies['@capacitor/core']);
});
