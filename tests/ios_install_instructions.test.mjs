// The iPhone install instructions, which iOS 26 invalidated.
//
// Safari 26 removed the directly-visible Share button from the toolbar: it now
// sits behind the "..." button beside the address bar. The old step two said
// "tap the Share button at the bottom of the screen", which sends the reader
// looking for a control that is not there -- and that step is the whole install,
// so getting it wrong costs the install.
//
// iOS 26 also added an "Open as Web App" toggle to the Add to Home Screen
// dialog. Left on it produces a real standalone app; switched off it produces a
// bookmark that opens in a Safari tab, losing background audio, lock-screen
// controls and the tab-reload protection this banner exists to promise. It
// still lands on the Home Screen with the right icon, so it LOOKS installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');

const source = await read('public/assets/js/ui_controller.js');
const block = source.slice(
  source.indexOf('function _iosMajorVersion()'),
  source.indexOf('function _buildBannerAction()'),
);

const load = async () => import('data:text/javascript,' + encodeURIComponent(
  'let navigator;\nexport function setUA(u){ navigator = { userAgent: u }; }\n'
  + block
  + '\nexport { _iosMajorVersion, _iosInstallSteps };'
));

const UA = {
  ios26: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1',
  ios26ipad: 'Mozilla/5.0 (iPad; CPU OS 26_1 like Mac OS X) AppleWebKit/605.1.15 Version/26.1 Mobile/15E148 Safari/604.1',
  // An iPad asking for the desktop site reports a Macintosh UA with NO OS token.
  ios26desktopUA: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  ios18: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1',
  ios15: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 Version/15.6 Mobile/15E148 Safari/604.1',
  unknown: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15',
};

const stepsFor = async (ua) => {
  const mod = await load();
  mod.setUA(ua);
  return mod._iosInstallSteps();
};

test('the iOS major version is read correctly, including the iPad desktop UA', async () => {
  const mod = await load();
  const expected = [
    [UA.ios26, 26], [UA.ios26ipad, 26], [UA.ios26desktopUA, 26],
    [UA.ios18, 18], [UA.ios15, 15], [UA.unknown, 0],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) Chrome/126 Mobile Safari/537.36', 0],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36', 0],
    ['', 0],
  ];
  for (const [ua, want] of expected) {
    mod.setUA(ua);
    assert.equal(mod._iosMajorVersion(), want, ua.slice(0, 60));
  }
});

test('iOS 26 is told about the ... menu, not a Share button that is not there', async () => {
  for (const ua of [UA.ios26, UA.ios26ipad, UA.ios26desktopUA]) {
    const html = await stepsFor(ua);
    assert.match(html, /⋯/, 'the ellipsis button must be named');
    assert.match(html, /to the right of the address bar/);
    assert.doesNotMatch(html, /at the bottom of the screen/,
      'Safari 26 has no Share button at the bottom of the screen');
  }
});

test('iOS 26 is warned to leave "Open as Web App" on', async () => {
  // Off, the reader gets a bookmark in a Safari tab and loses every capability
  // the banner just promised -- while it still looks installed.
  const html = await stepsFor(UA.ios26);
  assert.match(html, /Open as Web App/);
  assert.match(html, /switched <strong>on<\/strong>/);
});

test('older iOS keeps the direct Share button, described by icon not position', async () => {
  for (const ua of [UA.ios18, UA.ios15]) {
    const html = await stepsFor(ua);
    assert.match(html, /the square with an arrow pointing up/,
      'the icon identifies it on both iPhone and iPad');
    // Naming a position is wrong for one of the two form factors: the Share
    // button is at the bottom on an iPhone and the top right on an iPad.
    assert.doesNotMatch(html, /at the bottom of the screen/);
    assert.doesNotMatch(html, /⋯/, 'there is no ... menu on these versions');
    assert.doesNotMatch(html, /Open as Web App/, 'that toggle does not exist yet');
  }
});

test('an unrecognised version covers both layouts rather than guessing', async () => {
  const html = await stepsFor(UA.unknown);
  assert.match(html, /square with an arrow pointing up/);
  assert.match(html, /⋯/);
  assert.match(html, /Open as Web App/);
  assert.match(html, /If you do not see that switch/,
    'the toggle is absent before iOS 26, so its absence must not read as an error');
});

test('every step is a single flex item, or the sentence is torn apart', async () => {
  // .pwa-ios-step is display:flex, so each <strong> and each run of text
  // between them becomes its own flex item and gets spread across the row --
  // the emphasised words end up visually out of order. The body has to be one
  // span. This got worse exactly as the steps gained emphasis, which is why it
  // survived the plainer original text.
  for (const ua of Object.values(UA)) {
    const html = await stepsFor(ua);
    for (const step of html.split('<div class="pwa-ios-step">').slice(1)) {
      assert.match(step, /^<span class="pwa-step-num">[^<]*<\/span><span class="pwa-step-text">/,
        `a step body must be wrapped in .pwa-step-text: ${step.slice(0, 90)}`);
    }
    // Balanced markup: one open div per close, one step-text span per step.
    const steps = html.split('<div class="pwa-ios-step">').length - 1;
    assert.equal(html.split('</div>').length - 1, steps);
    assert.equal(html.split('class="pwa-step-text"').length - 1, steps);
  }
});

test('the stylesheet makes .pwa-step-text the growing item', async () => {
  const css = await read('public/assets/css/theme.css');
  const rule = css.slice(css.indexOf('.pwa-step-text {'), css.indexOf('.pwa-step-num {'));
  assert.match(rule, /flex:\s*1/);
  assert.match(rule, /min-width:\s*0/, 'long steps must be allowed to wrap rather than overflow');
});

test('step one still sends the reader to Safari', async () => {
  // Chrome and Firefox on iOS cannot install a web app; only Safari can.
  for (const ua of Object.values(UA)) {
    assert.match(await stepsFor(ua), /Open this page in <strong>Safari<\/strong>/);
  }
});

test('the steps are numbered in order with no gaps', async () => {
  for (const ua of Object.values(UA)) {
    const html = await stepsFor(ua);
    const badges = [...html.matchAll(/class="pwa-step-num">([^<]*)</g)].map((m) => m[1]);
    const numeric = badges.filter((b) => /^\d+$/.test(b)).map(Number);
    assert.deepEqual(numeric, numeric.map((_, i) => i + 1),
      `numbering must run 1..n without gaps, got ${badges.join(',')}`);
  }
});
