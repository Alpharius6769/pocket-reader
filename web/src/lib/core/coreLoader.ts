/**
 * Loads the narration/library cores from `public/assets/js/` into this page.
 *
 * The cores are unbundled ES modules that import each other with versioned
 * specifiers (`./audio_core.js?v=audio-v253`). ES modules are keyed by URL, so
 * the bridge MUST import each core by exactly the URL the cores use, or it gets
 * a second, unconnected instance (a second event bus, a second profile). The
 * versions come from the same manifest `tools/check_module_versions.mjs`
 * enforces, baked in at build time, so the bundle and the cores always ship
 * together.
 */
import manifest from '../../../../tools/module_version_manifest.json';

type Manifest = Record<string, { version: string; sha256: string }>;

/** URL of a core module, identical to how the cores import each other. */
export function coreUrl(file: string): string {
  const base = new URL('assets/js/', document.baseURI);
  const version = (manifest as Manifest)[file]?.version;
  // `sw-*` marks a module the shell references WITHOUT a ?v= token
  // (engine_utils.js); importing it with one would duplicate it.
  if (!version || version.startsWith('sw-')) return new URL(file, base).href;
  return new URL(`${file}?v=${version}`, base).href;
}

export async function importCore<T = Record<string, unknown>>(file: string): Promise<T> {
  return import(/* @vite-ignore */ coreUrl(file)) as Promise<T>;
}

/**
 * The cores this UI needs, in the order the old shell loaded them. Left out on
 * purpose: the old UI modules (ui_controller, cinematic_ui, virtue_controller,
 * experience_coordinator), the legacy adapter, and settings_manager, whose
 * applySettings() reads the old form fields back INTO settings on boot and
 * would overwrite the reader's choices with blanks on a page without them.
 */
export const BOOT_ORDER = [
  'native_app_key.js',
  'diagnostics.js',
  'storage_core.js',
  'api_core.js',
  'engine_utils.js',
  'narration_runtime_loader.js',
  'tts_pronunciation_core.js',
  'library_manager.js',
  'device_setup.js',
  'hmofa_masterlist.js',
  'data_transfer.js',
] as const;

/**
 * Register the app's service worker, as the old shell did. It is not optional
 * for narration: it stamps the cross-origin isolation headers that unlock
 * multi-threaded inference (the ?tts_fast=1 session), and it keeps the app and
 * models available offline. Production builds only: in `vite dev` its
 * cache-first rules would shadow hot reload. The registration promise is
 * published where the cores look for it (buffer_manager, settings_manager).
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const w = window as unknown as { __prServiceWorkerRegistration?: Promise<ServiceWorkerRegistration | undefined> };
  if (w.__prServiceWorkerRegistration) return;
  const version = String((manifest as Manifest)['sw.js']?.version || '').replace(/^sw-/, '');
  const url = new URL(version ? `sw.js?v=${version}` : 'sw.js', document.baseURI).href;
  w.__prServiceWorkerRegistration = navigator.serviceWorker
    .register(url)
    .catch(() => navigator.serviceWorker.register(new URL('sw.js', document.baseURI).href))
    .catch((error) => {
      console.warn('[PocketReader] Service worker registration failed', error);
      return undefined;
    });
}

export async function bootCores(onStep?: (file: string) => void): Promise<void> {
  registerServiceWorker();
  for (const file of BOOT_ORDER) {
    onStep?.(file);
    await importCore(file);
  }
  // library_manager hydrates the stored profile on import; nothing may read or
  // save the library before that settles (see _hydrateLocalProfile).
  const hydration = (window as unknown as { __pocketProfileHydration?: Promise<unknown> }).__pocketProfileHydration;
  if (hydration) await hydration;
}
