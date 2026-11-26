import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { setBridge, type CoreBridge } from './lib/core';
import { MockBridge } from './lib/core/bridge.mock';
import { createRealBridge } from './lib/core/bridge.real';
import { connectStores } from './lib/stores/wire';
import { applyDeepLink } from './lib/devlinks';

declare global {
  interface Window {
    /** The real-core bridge registers itself here before this module runs. */
    __pocketCoreBridge?: CoreBridge;
  }
}

const params = new URLSearchParams(location.search);
const sim = params.get('sim') === 'iphone';
if (sim) document.documentElement.classList.add('sim-iphone');

// The real cores by default. Sample data only for design captures and demos:
// ?mock=1, or ?sim=iphone (the screenshot tool, web/tools/capture-screens.mjs).
const useMock = params.get('mock') === '1' || sim;
const bridge =
  window.__pocketCoreBridge ??
  (useMock
    ? new MockBridge({
        onboarded: params.get('onboarded') !== '0',
        empty: params.get('empty') === '1',
        engineReady: params.get('cold') !== '1',
      })
    : await createRealBridge());
setBridge(bridge);
// Published so browser smoke tests and diagnostics can drive the same bridge.
window.__pocketCoreBridge = bridge;

await connectStores(bridge);
await applyDeepLink(location.hash, params);

mount(App, { target: document.getElementById('app')!, props: { sim } });
