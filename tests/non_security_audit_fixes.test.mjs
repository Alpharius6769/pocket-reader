import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('startup avoids hidden diagnostics polling and eager library rendering', async () => {
  // The three assertions that guarded FrontEnd_code.py are gone with the file:
  // the Anvil form no longer exists, so it cannot poll or eagerly render. The
  // equivalent guard for the shell that replaced it is below.
  const html = await read('public/index.html');
  const library = await read('public/assets/js/library_manager.js');
  assert.doesNotMatch(html, /setInterval\(\s*window\.refreshPerfPanel/);
  assert.doesNotMatch(library, /generateChunk\('\.'/);
  assert.doesNotMatch(library, /requestIdleCallback\(\(\) => \{\s*renderLibrary/);
});

test('narration stays deferred while runtime and UI modules use canonical URLs', async () => {
  const html = await read('public/index.html');
  const loader = await read('public/assets/js/narration_runtime_loader.js');
  const serviceWorker = await read('public/sw.js');
  const tagVersion = (source, module) =>
    source.match(new RegExp(`${module}\\.js\\?v=([a-z0-9-]+)`))?.[1];
  // Heavy narration modules must not be executable script tags in the form
  // template. The loader and SW may share one canonical URL without parsing the
  // runtime during ordinary startup.
  for (const module of ['audio_core', 'buffer_manager']) {
    assert.doesNotMatch(html, new RegExp(`<script[^>]+${module}\\.js`));
    const loaderVersion = tagVersion(loader, module);
    assert.ok(loaderVersion, `${module} dynamic import missing from narration loader`);
    assert.equal(tagVersion(serviceWorker, module), loaderVersion,
      `${module}: serviceworker precache differs from narration loader`);
  }
  for (const module of ['ui_controller', 'narration_runtime_loader']) {
    const pageTag = tagVersion(html, module);
    assert.ok(pageTag, `${module} script tag missing from FrontEnd_html.html`);
    assert.equal(tagVersion(serviceWorker, module), pageTag,
      `${module}: serviceworker precache differs from form-template tag`);
  }
  assert.match(loader, /ensureNarrationRuntime/);
  const deferredActions = loader.match(/const DEFERRED_NARRATION_ACTIONS = \[[\s\S]*?\];/)?.[0] || '';
  assert.doesNotMatch(deferredActions, /onSpeedSliderInput/);
  // There is no speed slider or label in the app. The handler that used to
  // mirror slider input into a label is gone; playback speed comes from the
  // profile/preset via audio_core's getEffectivePlaybackRate().
  assert.doesNotMatch(loader, /onSpeedSliderInput/);
});

test('service worker uses bounded navigation and lifetime-protected cache writes', async () => {
  const source = await read('public/sw.js');
  assert.match(source, /pocket-reader-core-v\d+/);
  // Navigation must stay bounded, and the bound must stay short enough that a
  // stalled mobile network never shows a long blank screen before the cached
  // shell appears. The exact value may be tuned; the ceiling is the invariant.
  const navTimeout = Number(source.match(/fetchWithTimeout\(event\.request,\s*(\d+)\)/)?.[1]);
  assert.ok(Number.isFinite(navTimeout), 'navigation fetch must carry an explicit timeout');
  assert.ok(navTimeout <= 2500, `navigation timeout ${navTimeout}ms is too long for a stalled mobile network`);
  assert.match(source, /event\.waitUntil\(updatePromise/);
  assert.match(source, /url\.searchParams\.has\('v'\)/);
});

test('onboarding and hidden controls are accessibility-isolated', async () => {
  const html = await read('public/index.html');
  const setup = await read('public/assets/js/device_setup.js');
  const ui = await read('public/assets/js/ui_controller.js');
  const virtue = await read('public/assets/js/virtue_controller.js');
  assert.match(html, /id="first-time-setup-modal"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(setup, /activatePocketModal/);
  assert.match(setup, /deactivatePocketModal/);
  assert.match(ui, /_syncNavMoreAccessibility/);
  assert.match(virtue, /_syncVirtueAccessibility/);
});

test('uploads use a size-aware deadline and always clear timers', async () => {
  const source = await read('public/assets/js/api_core.js');
  const upload = source.match(/export async function processUploadedFile[\s\S]*?\n}\r?\nwindow\.processUploadedFile/)?.[0] || '';
  assert.match(upload, /uploadTimeoutMs/);
  assert.match(upload, /Math\.min\(\s*240000/);
  assert.match(upload, /finally\s*\{\s*clearTimeout\(timeoutId\)/);
  assert.doesNotMatch(upload, /controller\.abort\(\), 15000/);
});

test('backend database durability and health refresh are fail-visible and singleflight', async () => {
  const source = await read('backend/app.py');
  assert.match(source, /ALLOW_EPHEMERAL_DB/);
  assert.match(source, /database_durable/);
  assert.match(source, /SITE_HEALTH_REFRESH_LOCK/);
  assert.match(source, /client\.stream\("GET", url\)/);
});

test('narration defaults to natural speed and an emotion-aware profile', async () => {
  const tuning = await read('public/assets/js/tts_pronunciation_core.js');
  const library = await read('public/assets/js/library_manager.js');
  const features = await read('public/assets/js/reader_features.js');
  const html = await read('public/index.html');

  assert.match(tuning, /DEFAULT_POCKET_PLAYBACK_SPEED = 1(?:\.0)?;/);
  assert.match(library, /voiceEmotionMode:\s*"balanced"/);
  assert.match(features, /_migratedEmotionBalanced/);
  assert.match(html, /<option value="balanced" selected>/);
});

test('stored AO3 export front matter is removed before narration', async () => {
  const storage = await read('public/assets/js/storage_core.js');
  const ui = await read('public/assets/js/ui_controller.js');

  assert.match(storage, /function _isNarrationFrontMatterChapter/);
  assert.match(storage, /preface/);
  assert.match(storage, /posted\\s\+originally\\s\+on\\s\+the\\s\+archive\\s\+of\\s\+our\\s\+own/i);
  assert.match(ui, /storyAuthor/);
  assert.match(ui, /chapter\|part\|book/);
});

// ── Audit 2026-08-28 ────────────────────────────────────────────────────────
// Each of these guards a control or hook that existed, looked wired, and did
// nothing. None of them threw, which is why they survived: a guarded call to a
// global that is not defined, or a select whose value is overwritten a moment
// later, fails silently by construction.

test('renderAccountCenter is reachable from the two hooks that call it', async () => {
  const cinematic = await read('public/assets/js/cinematic_ui.js');
  const bridge = await read('public/assets/js/supabase_bridge.js');
  const ui = await read('public/assets/js/ui_controller.js');

  // It was a module-local function. Both callers reach for it through window
  // behind a typeof guard, so after an OAuth sign-in and after the first-run
  // wizard the Account Center kept saying "Guest reader" until a reload.
  assert.match(cinematic, /^window\.renderAccountCenter = renderAccountCenter;$/m);
  for (const [name, source] of [['supabase_bridge', bridge], ['ui_controller', ui]]) {
    assert.match(source, /typeof window\.renderAccountCenter === 'function'/,
      `${name} still calls it, so the export has to stay`);
  }
});

test('the Settings worker override reaches the pool as a ceiling', async () => {
  const policy = await read('public/assets/js/pocket_backend_policy.js');
  const audio = await read('public/assets/js/audio_core.js');
  const buffer = await read('public/assets/js/buffer_manager.js');

  // userMaxWorkers may only lower the count: the conditions in the policy are
  // memory-safety limits, not preferences.
  assert.match(policy, /Math\.max\(1, Math\.min\(value, Math\.floor\(ceiling\)\)\)/);
  assert.match(audio, /userMaxWorkers: settings\.enableManualWorkers/);

  // Nothing may re-derive a pool size from settings.maxWorkers and then have it
  // overwritten -- that is what made the control decorative.
  assert.doesNotMatch(buffer, /this\.maxWorkers = Number\(settings\.maxWorkers\)/,
    'BufferManager.start must not compute a count the policy replaces');
  assert.doesNotMatch(audio, /function _getMaxWorkers\(\)/);
});

test('the device-setup summary has an element and a way to re-run', async () => {
  const html = await read('public/index.html');
  const setup = await read('public/assets/js/device_setup.js');

  // renderPocketDeviceSetupSummary ran on every Settings entry against an id
  // that appeared in no markup, and its re-run entry point takes a button
  // argument for an onclick that was never added.
  assert.match(setup, /setSetupText\('device-setup-settings-summary'/);
  assert.match(html, /id="device-setup-settings-summary"/);
  assert.match(html, /onclick="window\.runPocketDeviceDiagnosticsFromSettings\(this\)"/);
  // The failure path must restore the summary too, or a failed re-run leaves
  // "Running the device benchmark..." on screen for good.
  assert.match(setup, /\.finally\(\(\) => \{[\s\S]{0,400}renderPocketDeviceSetupSummary\(\);/);
});

test('the prosody drift guard is reset per story and chapter', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  // window.resetPocketProsodyDrift had no callers, so a chapter that tripped the
  // guard carried its demotion into the next book.
  assert.match(audio, /function _syncProsodyDriftToPosition\(\)/);
  assert.match(audio, /_syncProsodyDriftToPosition\(\);/);
  assert.match(audio, /if \(moved\) _prosodyDrift\.reset\(\);/);
});

test('settings controls map to the field names they actually write', async () => {
  const settings = await read('public/assets/js/settings_manager.js');
  const html = await read('public/index.html');

  // The map named three elements that do not exist, so the lookup fell through
  // to the raw element id. touchTargetSize is synced, so it went unstamped and
  // could lose a merge against another device.
  const map = settings.slice(settings.indexOf('_SETTING_FIELD_BY_CONTROL = Object.freeze({'));
  const entries = [...map.slice(0, map.indexOf('});')).matchAll(/'([a-z0-9-]+)':/g)].map((m) => m[1]);
  assert.ok(entries.length > 10, 'the control map should not be empty');
  for (const id of entries) {
    assert.match(html, new RegExp(`id="${id}"`), `_SETTING_FIELD_BY_CONTROL names #${id}, which is in no markup`);
  }
});

test('the story narration preset speaks the vocabulary the runtime accepts', async () => {
  const features = await read('public/assets/js/reader_features.js');
  const audio = await read('public/assets/js/audio_core.js');

  // 'full' is a TIER name; _emotionMode() takes MODE names and silently fell
  // back to balanced for anything else, so the preset's Full option was inert.
  assert.match(features, /<option value="expressive">Expressive<\/option>/);
  assert.doesNotMatch(features, /<option value="full">/);
  // Presets already saved with the dead value still have to work.
  assert.match(audio, /const mode = raw === 'full' \? 'expressive' : raw;/);
  // And the voice list has to follow the engine that will actually speak.
  // Any engine with a shell-side list uses it; only Pocket falls through to
  // POCKET_VOICES. Naming Kokoro offered Pocket's voices to a Kitten reader.
  assert.match(features, /const engineVoices = voicesForEngine\(engine\) \|\| \[\];/);
  assert.match(features, /engineVoices\.length/);
  // From the shared policy, not window.KOKORO_VOICES: that global is published
  // by the lazy-loaded audio_core, so before narration had ever started the
  // Kokoro branch produced an empty list.
  assert.match(features, /import \{ isMobileLikePlatform, KOKORO_VOICES, voicesForEngine \}/);
  assert.doesNotMatch(features, /window\.KOKORO_VOICES/);
  assert.doesNotMatch(features, /window\.voicesForEngine/);
});

test('catalog refresh notifies through a global that exists', async () => {
  const list = await read('public/assets/js/hmofa_masterlist.js');
  assert.doesNotMatch(list, /window\.showNotice\s*\(/);
  assert.match(list, /window\.pocketNotify\?\.\(/);
});

test('the app never walks the reader out to the account root', async () => {
  const standalone = await read('public/standard-page.html');
  const html = await read('public/index.html');
  const ui = await read('public/assets/js/ui_controller.js');

  // Production is served from a subpath, so a literal '/' is a different site.
  assert.doesNotMatch(standalone, /url=\/"|location\.replace\('\/'/);
  assert.match(standalone, /new URL\('\.\/', document\.baseURI\)/);
  assert.doesNotMatch(ui, /window\.location\.replace\('\/'\);/);
  // The service worker gates /debug/ with indexOf; index.html used startsWith,
  // which can never match on a subpath, so the two disagreed.
  assert.match(html, /window\.location\.pathname\.indexOf\('\/debug\/'\) !== -1/);
  assert.doesNotMatch(html, /pathname\.startsWith\('\/debug\/'\)/);
});

// ── Second audit, 2026-08-28 ────────────────────────────────────────────────

test('no shipped path raises an unconditional blocking dialog', async () => {
  // The project's own position, from ui_companion_and_bridge: alert() blocks the
  // page, reads as a system failure inside an installed PWA, and takes audio
  // focus on iOS standalone. It is legitimate ONLY as the last-resort fallback
  // inside pocketNotify, and as the `else` half of a companion-first pair.
  //
  // The previous guard banned three specific historical strings, so seven calls
  // phrased differently survived -- including one immediately followed by
  // triggerVirtue, which proves the companion was available.
  const ui = await read('public/assets/js/ui_controller.js');
  assert.match(ui, /if \(typeof alert === 'function'\) alert\(text\);/,
    'pocketNotify keeps alert as its own last resort');

  for (const name of ['api_core.js', 'library_manager.js', 'audio_core.js', 'buffer_manager.js', 'settings_manager.js']) {
    const source = await read(`public/assets/js/${name}`);
    const offenders = source.split('\n')
      .map((line, i) => [line, i + 1])
      .filter(([line]) => /(^|[^.\w])alert\(/.test(line))
      .filter(([line]) => !line.trimStart().startsWith('//'))
      // companion-first pairs are the sanctioned pattern
      .filter(([line]) => !/else\s+alert\(/.test(line))
      .map(([line, n]) => `${name}:${n} ${line.trim().slice(0, 70)}`);
    assert.deepEqual(offenders, [],
      'route these through pocketNotify (one line) or showSettingsModal (a report)');
  }
});

test('every form control has an accessible name', async () => {
  const html = await read('public/index.html');
  const labelledFor = new Set([...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
  const wrapped = new Set();
  for (const lm of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)) {
    for (const im of lm[1].matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g)) wrapped.add(im[1]);
  }
  const bare = [];
  for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2];
    const type = /\btype="([^"]+)"/.exec(attrs)?.[1];
    if (type && ['hidden', 'submit', 'button'].includes(type)) continue;
    if (/aria-label|aria-labelledby|title=/.test(attrs)) continue;
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    if (id && (labelledFor.has(id) || wrapped.has(id))) continue;
    bare.push(`line ${html.slice(0, m.index).split('\n').length}: <${m[1]} ${id ? '#' + id : 'no id'}>`);
  }
  // A placeholder is not an accessible name. The tell that this was an oversight
  // rather than a policy: #setup-fav-2..5 carried aria-labels while the
  // identical #profile-edit-fav-2..5 did not.
  assert.deepEqual(bare, [], 'these announce only their role to a screen reader');
});

test('the reader seek bar announces a position, not a raw number', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  assert.match(ui, /function _setReaderProgress\(progBar, c, p\)/);
  assert.match(ui, /progBar\.setAttribute\('aria-valuetext'/);
  // One writer, so no site can set the value and forget the spoken form.
  const direct = [...ui.matchAll(/progBar\.value = _readerGlobalIndex/g)];
  assert.equal(direct.length, 1, 'only _setReaderProgress may write the value');
});

test('removed UI leaves no orphaned state behind it', async () => {
  const html = await read('public/index.html');
  const ui = await read('public/assets/js/ui_controller.js');
  const experience = await read('public/assets/js/experience_coordinator.js');
  const library = await read('public/assets/js/library_manager.js');
  const virtue = await read('public/assets/js/virtue_controller.js');
  const masterlist = await read('public/assets/js/hmofa_masterlist.js');
  const audio = await read('public/assets/js/audio_core.js');

  // A modal nothing could open, whose "don't show again" nothing read, whose id
  // two other modules carried in their overlay lists.
  assert.doesNotMatch(html, /wip-modal-overlay|hide-wip-checkbox/);
  assert.doesNotMatch(ui, /function closeWipModal|window\.closeWipModal =/);
  assert.doesNotMatch(ui, /setItem\('hide_wip_warning'/);
  assert.doesNotMatch(experience, /wip-modal-overlay/);
  // A flag written and cleared but never read, with a constant that was its
  // only value.
  assert.doesNotMatch(library, /setItem\('pr_engine_auto_detected'|POCKET_ENGINE_AUTO_VERSION = /);
  // Constants left behind by the sprite detector, and the last unreferenced
  // export from the narration-engine wrapper batch.
  assert.doesNotMatch(virtue, /VIRTUE_BOUNDS_CACHE_KEY = |_DETECT_BLOCKLIST = /);
  assert.doesNotMatch(audio, /window\.getPocketProsodyTier = /);
  // dataset attributes with no reader in JS, CSS or markup.
  assert.doesNotMatch(experience, /dataset\.experienceSuppressed = /);
  assert.doesNotMatch(masterlist, /dataset\.filterGroup = /);
  // The class the stylesheet actually acts on must stay.
  assert.match(experience, /classList\.toggle\('experience-suppressed'/);
});
