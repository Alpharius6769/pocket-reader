import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from '../tests/webkit-smoke/node_modules/playwright/index.mjs';

const root = new URL('../', import.meta.url);
const files = new Map([
  ['/device_setup.js', 'public/assets/js/device_setup.js'],
  ['/pocket_backend_policy.js', 'public/assets/js/pocket_backend_policy.js'],
  ['/assets/js/device_benchmark_worker.js', 'public/assets/js/device_benchmark_worker.js'],
]);

const html = `<!doctype html><html><body>
  <div id="device-setup-modal">
    <div id="device-setup-progress-fill"></div>
    <p id="device-setup-status"></p><p id="device-setup-result"></p>
    <button id="device-setup-start-btn" onclick="window.startPocketDeviceSetup()">Start</button>
    <button id="device-setup-continue-btn" hidden onclick="window.continuePocketDeviceSetup()">Continue</button>
  </div>
  <div id="first-time-setup-modal" style="display:none"></div>
  <div id="settings-view">
    <input id="normal-setting" type="checkbox">
    <button id="safe-diagnostic" data-settings-safe-action="true" onclick="window.safeRuns++">Safe diagnostic</button>
    <details id="advanced-settings-section">
      <summary>Advanced Settings</summary>
      <input id="advanced-setting" type="checkbox">
    </details>
    <p id="device-setup-settings-summary"></p>
  </div>
  <div id="settings-modal-overlay"></div>
  <script>
    window.safeRuns = 0;
    window.userProfile = { settings: {} };
    window.showSettingsModal = function(title, body) {
      const overlay = document.getElementById('settings-modal-overlay');
      overlay.innerHTML = '<h3 id="settings-modal-title"></h3><div id="settings-modal-body"></div>';
      document.getElementById('settings-modal-title').textContent = title;
      document.getElementById('settings-modal-body').innerHTML = body;
      overlay.classList.add('active');
    };
  </script>
  <script type="module" src="/device_setup.js"></script>
</body></html>`;

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    response.end(html);
    return;
  }
  const name = files.get(pathname);
  if (!name) {
    response.writeHead(404);
    response.end('not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
  response.end(await readFile(new URL(name, root)));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const url = `http://127.0.0.1:${address.port}/`;
const engines = [
  { name: 'chromium', engine: chromium, launchOptions: { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } },
  { name: 'webkit', engine: webkit },
  {
    name: 'webkit-iphone13pro',
    engine: webkit,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    injectedModel: 'iPhone14,2',
  },
];
const results = [];

try {
  for (const config of engines) {
    const { name, engine } = config;
    const browser = await engine.launch(config.launchOptions || {});
    const context = await browser.newContext(config.userAgent ? { userAgent: config.userAgent } : {});
    const page = await context.newPage();
    await page.addInitScript(() => { localStorage.setItem('pr_setup_complete', 'true'); });
    if (config.injectedModel) {
      await page.addInitScript((model) => { window.POCKET_READER_DEVICE_MODEL = model; }, config.injectedModel);
    }
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.goto(url, { waitUntil: 'load' });
    await page.click('#device-setup-start-btn');
    await page.waitForSelector('#device-setup-continue-btn:not([hidden])', { timeout: 30000 });
    const setup = await page.evaluate(() => JSON.parse(localStorage.getItem('pr_device_setup_v2')));
    await page.click('#device-setup-continue-btn');
    const profileVisibleAfterDeviceSetup = await page.evaluate(() => (
      getComputedStyle(document.getElementById('first-time-setup-modal')).display === 'flex'
    ));
    await page.evaluate(() => {
      const profile = document.getElementById('first-time-setup-modal');
      window.deactivatePocketModal?.(profile);
      profile.style.display = 'none';
    });

    await page.click('#normal-setting');
    const normalSettingAvailable = await page.isChecked('#normal-setting');
    const warningBeforeAdvanced = await page.locator('#settings-risk-accept').count();
    await page.click('#advanced-settings-section > summary');
    const blockedBeforeAck = await page.evaluate(() => ({
      open: document.getElementById('advanced-settings-section').open,
      warning: document.getElementById('settings-modal-title')?.textContent,
    }));
    await page.click('#safe-diagnostic');
    const safeRuns = await page.evaluate(() => window.safeRuns);
    await page.check('#settings-risk-checkbox');
    await page.click('#settings-risk-accept');
    const advancedOpenedAfterAck = await page.evaluate(() => document.getElementById('advanced-settings-section').open);
    await page.click('#advanced-setting');
    const checkedAfterAck = await page.isChecked('#advanced-setting');

    const verdict = {
      engine: name,
      backend: setup?.recommendedBackend,
      wasmThreads: setup?.wasmThreads,
      cpuWidths: setup?.cpuResults?.map((result) => result.threads),
      localOnly: setup?.localOnly === true,
      profileVisibleAfterDeviceSetup,
      normalSettingAvailable: normalSettingAvailable && warningBeforeAdvanced === 0,
      blockedBeforeAck: blockedBeforeAck.open === false && /Before changing advanced settings/i.test(blockedBeforeAck.warning || ''),
      safeDiagnosticRan: safeRuns === 1,
      settingUnlockedAfterAck: advancedOpenedAfterAck && checkedAfterAck === true,
      pageErrors,
    };
    results.push(verdict);
    await browser.close();
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log(JSON.stringify(results, null, 2));
const passed = results.length === engines.length && results.every((result) => (
  result.localOnly
  && result.profileVisibleAfterDeviceSetup
  && result.normalSettingAvailable
  && result.blockedBeforeAck
  && result.safeDiagnosticRan
  && result.settingUnlockedAfterAck
  && result.pageErrors.length === 0
  && ['wasm', 'webgpu'].includes(result.backend)
  && result.wasmThreads >= 1
  && (!result.engine.includes('iphone') || result.wasmThreads <= 2)
));
process.exit(passed ? 0 : 1);
