import type { CoreBridge } from './bridge';

export * from './bridge';

let active: CoreBridge | null = null;

/**
 * Register the bridge the UI should use. Call once, before `mount()`.
 * The real-core bridge registers itself here; dev and tests use MockBridge.
 */
export function setBridge(bridge: CoreBridge) {
  active = bridge;
}

export function bridge(): CoreBridge {
  if (!active) throw new Error('CoreBridge not registered. Call setBridge() before mounting the app.');
  return active;
}
