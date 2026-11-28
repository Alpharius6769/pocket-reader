import './app.css';
import './desktop.css';
import { mount } from 'svelte';
import { derived } from 'svelte/store';
import { initLayout, type Layout } from './lib/layout';
import { settings } from './lib/stores/settings';
import App from './App.svelte';
import { setBridge, type CoreBridge } from './lib/core';
import { MockBridge } from './lib/core/bridge.mock';
import { createRealBridge } from './lib/core/bridge.real';
import { connectStores } from './lib/stores/wire';
import { applyDeepLink } from './lib/devlinks';
import { keepStorage, watchInstall } from './lib/install';

declare global {
  interface Window {
    /** The real-core bridge registers itself here before this module runs. */
    __pocketCoreBridge?: CoreBridge;
  }
}

// Before anything is awaited: the browser offers "install" once, early, and
// an offer nobody is listening for is gone.
watchInstall();

const params = new URLSearchParams(location.search);
const sim = params.get('sim') === 'iphone';
if (sim) document.documentElement.classList.add('sim-iphone');

// The real cores by default. Sample data only for design captures and demos:
// ?mock=1, or ?sim=iphone (the screenshot tool, web/tools/capture-screens.mjs).
const useMock = params.get('mock') === '1' || sim;
// Starting can fail: on a first visit every core comes over the network, and
// one that does not arrive used to leave an empty page with no way to tell
// why. index.html paints a start screen; a failure replaces it with words and
// a way to try again.
function startFailed(error: unknown): never {
  console.error('[PocketReader] The app could not start', error);
  const host = document.getElementById('app');
  if (host) {
    host.innerHTML =
      '<div class="boot" role="alert"><p class="boot-title">Pocket Reader could not start</p>' +
      '<p class="boot-sub">Part of the app did not load. Check your connection and try again.</p>' +
      '<button class="boot-retry" type="button">Try again</button></div>';
    host.querySelector('button')?.addEventListener('click', () => location.reload());
  }
  throw error;
}

const bridge =
  window.__pocketCoreBridge ??
  (useMock
    ? new MockBridge({
        onboarded: params.get('onboarded') !== '0',
        empty: params.get('empty') === '1',
        engineReady: params.get('cold') !== '1',
      })
    : await createRealBridge().catch(startFailed));
setBridge(bridge);
// Published so browser smoke tests and diagnostics can drive the same bridge.
window.__pocketCoreBridge = bridge;

await connectStores(bridge).catch(startFailed);

// Phone or desktop layout, settled before the first paint so the app never
// draws one and then jumps to the other. The iPhone simulator is always phone;
// ?layout=desktop|phone skips detection for design review.
const layoutParam = params.get('layout');
initLayout({
  forcePhone: sim,
  override: layoutParam === 'desktop' || layoutParam === 'phone' ? (layoutParam as Layout) : null,
  preference: derived(settings, ($s) => $s?.layout ?? 'auto'),
});

await applyDeepLink(location.hash, params);

// The downloaded voices are hundreds of megabytes. Ask the browser not to
// clear them when the device runs short of space (granted without a prompt to
// installed apps and sites that are used; a no-op elsewhere).
if (!useMock) void keepStorage();

// The start screen from index.html is plain markup inside #app; mount() appends.
document.getElementById('app')!.replaceChildren();
mount(App, { target: document.getElementById('app')!, props: { sim } });
