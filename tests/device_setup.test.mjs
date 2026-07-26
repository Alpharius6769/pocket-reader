import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('device calibration blocks profile setup until its local benchmark completes', async () => {
  const html = await read('public/index.html');
  const deviceSetup = await read('public/assets/js/device_setup.js');
  const frontEndCode = await read('FrontEnd_code.py');
  const theme = await read('public/assets/css/theme.css');
  assert.ok(html.indexOf('id=&quot;device-setup-modal&quot;') < html.indexOf('id=&quot;first-time-setup-modal&quot;'));
  assert.match(html, /html:not\(\.pr-device-setup-complete\) #first-time-setup-modal/);
  assert.match(html, /device_setup\.js\?v=device-setup-v6/);
  assert.match(deviceSetup, /pr_device_setup_v2|POCKET_DEVICE_SETUP_KEY/);
  assert.match(deviceSetup, /localOnly:\s*true/);
  assert.match(deviceSetup, /simulateThreadedWasm:\s*true/);
  assert.match(deviceSetup, /benchmarkWebGpu/);
  assert.match(deviceSetup, /shader-f16/);
  assert.match(deviceSetup, /pr_device_profile_handoff_v1/);
  assert.match(deviceSetup, /showFirstTimeProfileSetup/);
  assert.match(html, /id=&quot;device-setup-start-btn&quot;[^>]+disabled/);
  assert.match(deviceSetup, /setupStartButton\.disabled = false/);
  assert.match(theme, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.ok(frontEndCode.indexOf("getItem('pr_device_setup_v2')") < frontEndCode.indexOf("getItem('pr_setup_complete')"));
});

test('settings risk gate appears only when Advanced Settings is opened', async () => {
  const html = await read('public/index.html');
  const deviceSetup = await read('public/assets/js/device_setup.js');
  const theme = await read('public/assets/css/theme.css');
  const ui = await read('public/assets/js/ui_controller.js');
  assert.match(deviceSetup, /pr_settings_risk_ack_v1/);
  assert.match(deviceSetup, /I understand and accept this risk/);
  assert.match(deviceSetup, /#advanced-settings-section > summary/);
  assert.match(deviceSetup, /handleSettingsRiskChange/);
  assert.match(deviceSetup, /handleSettingsRiskAccept/);
  assert.doesNotMatch(deviceSetup, /guardedSettingsControl|beforeinput|pointerdown/);
  assert.match(html, /data-settings-safe-action=&quot;true&quot;[^>]+window\.Diagnostics\.runDiagnostic/);
  assert.match(html, /data-settings-safe-action=&quot;true&quot;[^>]+clearTextCache/);
  assert.match(html, /data-settings-safe-action=&quot;true&quot;[^>]+location\.reload/);
  assert.doesNotMatch(html, /data-settings-safe-action=&quot;true&quot;[^>]+id=&quot;low-mem-toggle&quot;/);
  assert.match(html, /id=&quot;global-search&quot;[^>]+aria-label=/);
  assert.match(html, /id=&quot;pronunciation-sounds-input&quot;[^>]+aria-label=/);
  assert.match(theme, /\.settings-section-nav button\s*\{\s*min-height:\s*44px/);
  assert.match(theme, /\.top-bar > \.pr-btn-primary:first-of-type,[\s\S]*?min-height:\s*44px\s*!important/);
  assert.match(ui, /_syncPWABannerInset/);
  assert.match(theme, /pwa-install-banner-visible \.view-container/);
  assert.match(theme, /\.pwa-banner\s*\{[\s\S]*?z-index:\s*9000/);
});

test('iOS memory-safe lifecycle bounds startup blobs, voices, workers, and story prefetch', async () => {
  const policy = await read('public/assets/js/pocket_backend_policy.js');
  const audio = await read('public/assets/js/audio_core.js');
  const worker = await read('public/assets/js/pocket_worker.js');
  const buffer = await read('public/assets/js/buffer_manager.js');
  assert.match(policy, /memorySafeInference:\s*platform === 'ios' \|\| constrained/);
  assert.match(policy, /fullStoryVoicePrefetch:\s*platform !== 'ios' && !constrained/);
  assert.match(audio, /ttsWorkers\.splice\(0\)/);
  assert.match(audio, /Pocket memory-safe cache session released/);
  assert.match(worker, /MAX_CONSTRAINED_CUSTOM_VOICES\s*=\s*2/);
  assert.match(worker, /modelBuffer = null/);
  assert.match(worker, /setTimeout\(resolve, 24\)/);
  assert.match(buffer, /shouldPocketPrefetchFullStoryVoices/);
  assert.match(buffer, /_prefetchNextVoice/);
});
