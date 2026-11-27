import { derived, writable, type Readable } from 'svelte/store';

/**
 * Phone or desktop layout.
 *
 * The phone layout is the default and the fallback: the desktop layout is only
 * applied when every one of these holds, and anything uncertain stays phone.
 *
 *   1. The operating system is Windows, macOS, Linux or ChromeOS.
 *   2. The primary input is a mouse or trackpad (hover + fine pointer).
 *   3. The window is wide and tall enough for a sidebar.
 *   4. The reader has not chosen "Compact" in Settings.
 *
 * (1) alone is not enough. An iPad in "desktop website" mode reports itself as
 * a Mac, and Android Chrome in "desktop site" mode reports Linux; both still
 * have a coarse primary pointer, which (2) catches. (2) and (3) are live media
 * queries, so plugging in a mouse or resizing the window switches at once.
 *
 * The result is one class on <html>, `layout-desktop`, which desktop.css keys
 * every rule on. Nothing in the phone styles depends on it.
 */

export type Layout = 'phone' | 'desktop';
export type LayoutPreference = 'auto' | 'phone';

export interface PlatformSignals {
  /** navigator.userAgentData.platform (Chromium only). */
  uaPlatform?: string;
  /** navigator.userAgentData.mobile (Chromium only). */
  uaMobile?: boolean;
  /** navigator.platform */
  platform?: string;
  userAgent?: string;
  maxTouchPoints?: number;
  /** Packaged Capacitor build. */
  native?: boolean;
}

/** Wide enough for the sidebar plus a comfortable column, with a real pointer. */
export const DESKTOP_QUERY = '(min-width: 960px) and (min-height: 560px) and (hover: hover) and (pointer: fine)';

const DESKTOP_UA_PLATFORMS = new Set(['windows', 'macos', 'linux', 'chrome os', 'chromium os']);

/** True only for an operating system this app treats as a desktop. */
export function isDesktopOs(s: PlatformSignals): boolean {
  if (s.native) return false;
  const ua = s.userAgent ?? '';
  const touch = s.maxTouchPoints ?? 0;
  // A phone or tablet says so somewhere, whatever else it claims.
  if (s.uaMobile === true) return false;
  if (/Android|iPhone|iPad|iPod|Mobile|Mobi|Windows Phone|webOS|BlackBerry|Opera Mini|Silk|Kindle/i.test(ua)) return false;

  const platform = s.platform ?? '';
  // iPadOS asking for the desktop site: "MacIntel" with a touchscreen. No Mac has one.
  const macLike = /^Mac/i.test(platform) || /Macintosh|Mac OS X/i.test(ua);
  if (macLike && touch > 1) return false;

  if (s.uaPlatform) return DESKTOP_UA_PLATFORMS.has(s.uaPlatform.toLowerCase());

  // No client hints (Firefox, Safari): navigator.platform, then the UA string.
  if (/^Win/i.test(platform) || /Windows NT/i.test(ua)) return true;
  if (macLike) return true;
  if (/CrOS/i.test(ua)) return true;
  if (/Linux|X11|FreeBSD|OpenBSD/i.test(platform) || /X11|Linux/i.test(ua)) return true;
  return false;
}

export function resolveLayout(input: { desktopOs: boolean; roomy: boolean; preference: LayoutPreference; forcePhone?: boolean }): Layout {
  if (input.forcePhone || input.preference === 'phone') return 'phone';
  return input.desktopOs && input.roomy ? 'desktop' : 'phone';
}

export function readSignals(): PlatformSignals {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } };
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return {
    uaPlatform: nav.userAgentData?.platform || undefined,
    uaMobile: nav.userAgentData?.mobile,
    platform: nav.platform,
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints,
    native: !!cap?.isNativePlatform?.(),
  };
}

const layoutStore = writable<Layout>('phone');
const desktopOsStore = writable(false);

/** The layout in force right now. */
export const layout: Readable<Layout> = { subscribe: layoutStore.subscribe };
/** Whether this device could use the desktop layout at all (shows the Settings choice). */
export const desktopCapable: Readable<boolean> = { subscribe: desktopOsStore.subscribe };
/** What to call the device in copy: "this phone" / "this computer". */
export const deviceNoun = derived(layoutStore, ($l) => ($l === 'desktop' ? 'computer' : 'phone'));

export interface LayoutOptions {
  /** Design simulator and tests: never leave the phone layout. */
  forcePhone?: boolean;
  /** `?layout=desktop|phone`: skip detection (design review only). */
  override?: Layout | null;
  /** Emits the reader's preference; called again whenever it changes. */
  preference?: Readable<LayoutPreference>;
}

/** Start following the device. Call once, before the app mounts. Returns a stop function. */
export function initLayout(opts: LayoutOptions = {}): () => void {
  const desktopOs = isDesktopOs(readSignals());
  desktopOsStore.set(desktopOs && !opts.forcePhone);
  const mql = typeof matchMedia === 'function' ? matchMedia(DESKTOP_QUERY) : null;
  let preference: LayoutPreference = 'auto';

  const apply = () => {
    const next =
      opts.override && !opts.forcePhone
        ? opts.override
        : resolveLayout({ desktopOs, roomy: !!mql?.matches, preference, forcePhone: opts.forcePhone });
    document.documentElement.classList.toggle('layout-desktop', next === 'desktop');
    layoutStore.set(next);
  };

  // The media query's own change event is the trigger. Resize and a return to
  // the foreground re-read it as well, so a missed event (a backgrounded tab, a
  // window dragged between monitors) cannot leave the wrong layout showing.
  const onChange = () => apply();
  const onVisible = () => {
    if (document.visibilityState === 'visible') apply();
  };
  mql?.addEventListener?.('change', onChange);
  window.addEventListener('resize', onChange);
  document.addEventListener('visibilitychange', onVisible);
  const unsubscribe = opts.preference?.subscribe((p) => {
    preference = p;
    apply();
  });
  apply();

  return () => {
    mql?.removeEventListener?.('change', onChange);
    window.removeEventListener('resize', onChange);
    document.removeEventListener('visibilitychange', onVisible);
    unsubscribe?.();
  };
}
