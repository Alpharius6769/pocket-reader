// Findings from using the live site end to end on 2026-11-27 (every tab, a
// text import, an AO3 story, a catalog story, all twelve voices, both engines).
// Each test pins the fix for something that was seen to go wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = async (path) => (await readFile(new URL(`../${path}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const readBytes = (path) => readFile(new URL(`../${path}`, import.meta.url));

function slice(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `could not find: ${from}`);
  const end = source.indexOf(to, start + from.length);
  assert.ok(end > start, `could not find the end marker: ${to}`);
  return source.slice(start, end);
}

test('a streamed paragraph that is rejected is rendered whole, not left in silence', async () => {
  // Desktop: the quality guard rejected a short line after its first second
  // had already been streamed. The stream was stopped, `streamedPlayback` was
  // still true, and the function returned: nothing playing, nothing to end,
  // "playing" on screen until Play was toggled twice.
  const audio = await read('public/assets/js/audio_core.js');
  const play = slice(audio, 'async function _playGeneratedAudio(', 'async function _playWebSpeech(');
  const rejected = slice(play, '} else {\n          // The streamed render was rejected', 'finally {');
  assert.match(rejected, /stream\.stop\(\);/);
  assert.match(rejected, /if \(_activePocketStream === stream\) _activePocketStream = null;/);
  assert.match(rejected, /streamedPlayback = false;/);
  assert.match(rejected, /audioBlob = await window\.generateChunk\(text, cleanVoice, \{ storyTitle: title, chapIdx, paraIdx \}\);/);
  // The old shape must not come back.
  assert.doesNotMatch(play, /\} else stream\.stop\(\);/);
});

test('the audio clock watches for narration that has stopped by itself', async () => {
  // Recovery ran only when the page became visible or Play was pressed on the
  // lock screen: with the phone in a pocket a failed hand-over stayed failed.
  const audio = await read('public/assets/js/audio_core.js');
  const pump = slice(audio, 'export function _onAudioClockPump() {', '\n}\n');
  assert.match(pump, /_watchForStalledNarration\(now\);/);
  const watch = slice(audio, 'function _watchForStalledNarration(', '\n}\n');
  assert.match(watch, /_narrationIsMoving\(\)/);
  assert.match(watch, /NARRATION_STALL_MS/);
  assert.match(watch, /_recoverStalledPlayback\('audio-clock'\);/);
  // The keep-alive loop plays between clips, when the narration element's own
  // clock has stopped: it has to drive the pump too.
  const keepAlive = slice(audio, 'function _ensureBgKeepAlive() {', 'return _bgKeepAlive;\n}');
  assert.match(keepAlive, /_bgKeepAlive\.addEventListener\('timeupdate', \(\) => \{\s*if \(typeof _onAudioClockPump === 'function'\) _onAudioClockPump\(\);/);
  // Rendering, streaming and a hand-over in flight are not stalls.
  const moving = slice(audio, 'function _narrationIsMoving() {', '\n}\n');
  assert.match(moving, /_pocketLiveSynthActive === true/);
  assert.match(moving, /_activePocketStream && !_activePocketStream\.stopped/);
  assert.match(moving, /_playInFlight > 0/);
});

test('recovering from a clip that ended unheard moves on instead of repeating it', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const recover = slice(audio, 'function _recoverStalledPlayback(reason) {', 'window._recoverStalledPlayback');
  assert.match(recover, /if \(_activePocketStream && !_activePocketStream\.stopped\) return false;/);
  assert.match(recover, /audio\.ended\s+&& Number\(audio\.dataset\.pocketChapter\) === Number\(window\.currentChapterIndex\)\s+&& Number\(audio\.dataset\.pocketParagraph\) === Number\(window\.currentParagraphIndex\)\) \{\s*_handleParagraphEnd\(\);/);
});

test('skipping while playing leaves the lock screen and the keep-alive loop on "playing"', async () => {
  // pausePlayback() reported "paused" and stopped the loop; only a cache miss
  // put either back. After a skip from the lock screen the card showed Play
  // over audible narration, and pressing it did nothing.
  const audio = await read('public/assets/js/audio_core.js');
  for (const name of ['skipParagraph', 'skipChapter']) {
    const fn = slice(audio, `export function ${name}(offset) {`, `window.${name} = ${name};`);
    assert.match(fn, /if \(wasPlaying\) \{[\s\S]*window\.isPlaying = true;\s*_updatePlayButton\(true\);\s*startBgKeepAlive\(\);\s*playCurrentParagraph\(\);/, name);
  }
});

test('a voice change can be made without queueing a render of the whole story', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const change = slice(audio, 'window.onVoiceSelectionChange = function(newVoice, options = {}) {', 'window.switchReaderVoiceEngine = switchReaderVoiceEngine;');
  const guard = change.indexOf('if (window.currentStory && options.recache === false) return;');
  const start = change.lastIndexOf("window.startCaching('Normal')");
  assert.ok(guard > 0, 'the recache opt-out is missing');
  assert.ok(guard < start, 'the opt-out must come before the whole-story job is started');
  const bridge = await read('web/src/lib/core/bridge.real.ts');
  assert.match(bridge, /onVoiceSelectionChange\(voice, \{ confirm: false, recache: false \}\)/);
});

test('the page declares itself a playback app where the browser allows it', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const prepare = slice(audio, 'export function preparePocketMobileMediaSession() {', 'window.preparePocketMobileMediaSession');
  assert.match(prepare, /try \{ if \(navigator\.audioSession\) navigator\.audioSession\.type = 'playback'; \} catch \(_\) \{\}/);
});

test('Kokoro gets four threads on a desktop with cores to spare, and only there', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const helper = slice(audio, 'function _styleTts2ThreadCount(recommended, settings = {}) {', '\n}\n');
  // Evaluate the helper itself against stand-in globals.
  const make = (env) => {
    const fn = new Function('window', 'navigator', 'isMobileLikePlatform', `${helper}\n}\nreturn _styleTts2ThreadCount;`);
    return fn({ crossOriginIsolated: env.isolated }, { userAgent: env.ua, maxTouchPoints: env.touch ?? 0, hardwareConcurrency: env.cores },
      (ua) => /Android|iPhone|iPad|Mobile/i.test(ua));
  };
  const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/156 Safari/537.36';
  assert.equal(make({ isolated: true, ua: desktop, cores: 16 })(2), 4);
  assert.equal(make({ isolated: true, ua: desktop, cores: 8 })(2), 4);
  assert.equal(make({ isolated: true, ua: desktop, cores: 4 })(2), 2, 'a small desktop keeps the policy value');
  assert.equal(make({ isolated: false, ua: desktop, cores: 16 })(1), 1, 'no threads without isolation');
  assert.equal(make({ isolated: true, ua: desktop, cores: 16 })(2, { lowMemoryMode: true }), 2);
  assert.equal(make({ isolated: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) Mobile Safari', cores: 8 })(2), 2);
  assert.equal(make({ isolated: true, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari', cores: 8 })(4), 4, 'a phone keeps what the policy gave it');
  // An iPad asking for the desktop site: a Mac user agent with a touchscreen.
  assert.equal(make({ isolated: true, ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', touch: 5, cores: 8 })(2), 2);
});

test('a story that cannot be fetched is explained in words', async () => {
  // The toast said "SCRAPE_FAILED", after two attempts at a request the server
  // had already answered with the reason.
  const api = await read('public/assets/js/api_core.js');
  const load = slice(api, 'export async function loadStory(url, options = {}) {', 'window.loadStory = loadStory;');
  assert.doesNotMatch(load, /SCRAPE_FAILED'/, 'the literal must not reach the reader');
  assert.equal((load.match(/lastErr = await _scrapeFailure\(response\);/g) || []).length, 2);
  assert.equal((load.match(/if \(lastErr\.definite\) break;/g) || []).length, 2);
  const helper = slice(api, 'async function _scrapeFailure(response) {', '\n}\n');
  assert.match(helper, /body\?\.detail/);
  assert.match(helper, /status >= 400 && status < 500 && status !== 408 && status !== 429/);
  const message = api.match(/const SCRAPE_FAILED_MESSAGE = '([^']+)';/)?.[1] || '';
  assert.match(message, /could not be fetched/);
  assert.doesNotMatch(message, /[A-Z]{4,}_/);
});

test('removing a story removes its text under every key, and its narration', async () => {
  const library = await read('public/assets/js/library_manager.js');
  const remove = slice(library, 'export function removeStory(storyRef, options = {}) {', 'window.removeStory = removeStory;');
  assert.match(remove, /\[removedKey, removedStory\.title, removedStory\.url, removedStory\.sourceUrl\]/);
  assert.match(remove, /window\.deleteStoryAudio\(ref\)/);
  // Another story with the same title keeps its own older renders.
  assert.match(remove, /titleShared \? null : removedStory\.title/);
});

test('the bookmark message has a space between its sentences', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(audio, /Bookmark saved! I'll remember where we left off\./);
});

test('the web app manifest has real, square icons at the sizes Android needs', async () => {
  // The only icons were a 512x521 WebP and a 503x512 JPEG declared as 512x512,
  // and nothing at 192: Chrome will not offer to install without both sizes.
  const manifest = JSON.parse(await read('public/manifest.webmanifest'));
  const pngSize = async (path) => {
    const bytes = await readBytes(`public/${decodeURIComponent(path)}`);
    assert.equal(bytes.toString('latin1', 1, 4), 'PNG', `${path} is not a PNG`);
    return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
  };
  const any = manifest.icons.filter((i) => i.purpose === 'any');
  for (const wanted of ['192x192', '512x512']) {
    const icon = any.find((i) => i.sizes === wanted && i.type === 'image/png');
    assert.ok(icon, `no ${wanted} PNG icon with purpose "any"`);
  }
  for (const icon of manifest.icons.filter((i) => i.type === 'image/png')) {
    assert.equal(await pngSize(icon.src), icon.sizes, `${icon.src} is not the size it declares`);
  }
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'));
  assert.equal(manifest.display, 'standalone');
  // iOS takes its home-screen icon from the page, and wants it square.
  const page = await read('web/index.html');
  const touch = page.match(/<link rel="apple-touch-icon"[^>]*href="\.\/([^"]+)"/)?.[1];
  assert.ok(touch, 'no apple-touch-icon');
  assert.equal(await pngSize(touch), '180x180');
});

test('the install offer is captured before anything is awaited', async () => {
  // beforeinstallprompt fires once, early. Listening after the cores have
  // loaded would miss it on a fast connection.
  const main = await read('web/src/main.ts');
  const watch = main.indexOf('watchInstall();');
  const firstAwait = main.indexOf('await ');
  assert.ok(watch > 0 && watch < firstAwait, 'watchInstall() must run before the first await');
  const install = await read('web/src/lib/install.ts');
  assert.match(install, /window\.addEventListener\('beforeinstallprompt', \(event\) => \{\s*(?:\/\/[^\n]*\n\s*)*event\.preventDefault\(\);/);
  assert.match(install, /window\.addEventListener\('appinstalled'/);
});
