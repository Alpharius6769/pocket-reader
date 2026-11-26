import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { setBridge, type CoreBridge } from './lib/core';
import { MockBridge } from './lib/core/bridge.mock';
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

const bridge =
  window.__pocketCoreBridge ??
  new MockBridge({
    onboarded: params.get('onboarded') !== '0',
    empty: params.get('empty') === '1',
    engineReady: params.get('cold') !== '1',
  });
setBridge(bridge);

await connectStores(bridge);
await applyDeepLink(location.hash, params);

mount(App, { target: document.getElementById('app')!, props: { sim } });
