/**
 * "Add to Home Screen" guidance for iPhone and iPad.
 *
 * Installing is not cosmetic here. An installed web app keeps its storage
 * (Safari clears a site's after a week without a visit), is its own window
 * outside Safari's tab limits, and is the only place web push exists on an
 * iPhone. Whether it also narrates better with the screen locked than a
 * Safari tab does has not been measured on a device; the app does not claim
 * it. Ported from the old shell (ui_controller.js) with its rules:
 *
 * - iOS 26 moved Share behind the "⋯" button beside the address bar, and added
 *   an "Open as Web App" toggle to the Add dialog. Switched off, the reader gets
 *   a bookmark that opens in a Safari tab and loses everything above while
 *   still looking installed, so every iOS 26 path ends on that warning.
 * - Earlier versions have a Share button in the toolbar, described by its icon
 *   (bottom on iPhone, top right on iPad: naming a position is wrong for one).
 * - An unknown version covers both layouts rather than guessing.
 */

import { derived, writable, type Readable } from 'svelte/store';

/** One instruction: plain text with **bold** runs. */
export interface InstallStep {
  marker: string;
  text: string;
}

export function iosMajorVersion(userAgent: string): number {
  const ua = userAgent || '';
  const os = ua.match(/(?:iPhone )?OS (\d+)[_.]/);
  if (os) return Number(os[1]) || 0;
  // An iPad asking for the desktop site reports a Macintosh UA with no OS token.
  const safari = ua.match(/Version\/(\d+)[._]/);
  if (safari && /Safari/.test(ua)) return Number(safari[1]) || 0;
  return 0;
}

export function isAppleTouchDevice(userAgent: string, maxTouchPoints = 0): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

export function isInstalled(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches === true
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

const OPEN: InstallStep = { marker: '1', text: 'Open this page in **Safari**' };
const toggleStep = (marker: string): InstallStep => ({
  marker,
  text: 'Leave **“Open as Web App”** switched **on**, then tap **Add**',
});

export function iosInstallSteps(userAgent: string): InstallStep[] {
  const version = iosMajorVersion(userAgent);
  if (version >= 26) {
    return [
      OPEN,
      { marker: '2', text: 'Tap the **⋯** button to the right of the address bar, then tap **Share**' },
      { marker: '3', text: 'Scroll down and tap **“Add to Home Screen”**' },
      toggleStep('4'),
    ];
  }
  if (version > 0) {
    return [
      OPEN,
      { marker: '2', text: 'Tap the **Share** button — the square with an arrow pointing up' },
      { marker: '3', text: 'Scroll down and tap **“Add to Home Screen”**, then tap **Add**' },
    ];
  }
  return [
    OPEN,
    { marker: '2', text: 'Tap **Share** — the square with an arrow pointing up. On newer iPhones it is behind the **⋯** button beside the address bar' },
    { marker: '3', text: 'Scroll down and tap **“Add to Home Screen”**' },
    toggleStep('4'),
    { marker: '!', text: 'If you do not see that switch, just tap **Add** — older versions of iOS install it as an app anyway' },
  ];
}

/** Splits **bold** markup into runs for rendering without innerHTML. */
export function boldRuns(text: string): { text: string; bold: boolean }[] {
  return text.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((part) =>
    part.startsWith('**') ? { text: part.slice(2, -2), bold: true } : { text: part, bold: false });
}

/* ------------------------------------------------------------------------
 * One-tap install (Android, desktop Chrome and Edge) and the state the
 * install card and Settings row share.
 *
 * Chromium hands the page a `beforeinstallprompt` event when the app can be
 * installed, and showing the browser's own dialog later needs that event and a
 * tap. It fires once, early, so it is captured at start-up (watchInstall) and
 * kept until someone presses Install. iOS has no such event and no way to
 * install from a page: there the steps above are all there is.
 * ---------------------------------------------------------------------- */

/** What can be offered on this device, in order of how little it asks. */
export type InstallWay =
  | 'installed'   // already running as an app
  | 'prompt'      // the browser's own install dialog, one tap
  | 'ios'         // Share, then Add to Home Screen
  | 'ios-other'   // an iPhone browser or in-app view that cannot add to the home screen
  | 'menu'        // Android or desktop browser with an install entry in its menu
  | 'none';       // nothing to offer (desktop Safari before Sonoma, Firefox desktop)

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const promptEvent = writable<InstallPromptEvent | null>(null);
const installedNow = writable(false);

export function installWayFor(input: { userAgent: string; maxTouchPoints?: number; installed: boolean; canPrompt: boolean }): InstallWay {
  if (input.installed) return 'installed';
  if (input.canPrompt) return 'prompt';
  const ua = input.userAgent || '';
  if (isAppleTouchDevice(ua, input.maxTouchPoints ?? 0)) {
    // Safari, and since iOS 16.4 the other iPhone browsers, can add to the home
    // screen. A page opened inside another app (a chat or social app's built-in
    // browser) cannot: those carry no "Safari/" token, or name their host app.
    const embedded = !/Safari\//.test(ua) || /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|GSA\/|Snapchat|Twitter|TikTok|musical_ly|Discord/i.test(ua);
    return embedded ? 'ios-other' : 'ios';
  }
  if (/Android/i.test(ua)) return 'menu';
  if (/Edg\/|Chrome\/|Chromium\//.test(ua) && !/Mobile/i.test(ua)) return 'menu';
  return 'none';
}

export const installWay: Readable<InstallWay> = derived([promptEvent, installedNow], ([$event, $installed]) =>
  installWayFor({
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent || '',
    maxTouchPoints: typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints || 0,
    installed: $installed || (typeof window !== 'undefined' && isInstalled()),
    canPrompt: !!$event,
  }));

let watching = false;

/** Call once at start-up, before the app mounts: the event does not wait. */
export function watchInstall() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  installedNow.set(isInstalled());
  window.addEventListener('beforeinstallprompt', (event) => {
    // Keep the browser's small automatic banner from appearing on its own;
    // the app offers Install where it makes sense.
    event.preventDefault();
    promptEvent.set(event as InstallPromptEvent);
  });
  window.addEventListener('appinstalled', () => {
    promptEvent.set(null);
    installedNow.set(true);
  });
  window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', (e) => installedNow.set(e.matches || isInstalled()));
}

/**
 * Show the browser's install dialog. Must be called from a tap. Resolves to
 * what the reader chose, or 'unavailable' when there is no dialog to show.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  let event: InstallPromptEvent | null = null;
  promptEvent.subscribe((e) => (event = e))();
  if (!event) return 'unavailable';
  const held = event as InstallPromptEvent;
  // The event can be used once.
  promptEvent.set(null);
  try {
    await held.prompt();
    const { outcome } = await held.userChoice;
    if (outcome === 'accepted') installedNow.set(true);
    return outcome;
  } catch {
    return 'unavailable';
  }
}

/** Where the install entry is in a browser that has no dialog to offer. */
export function menuInstallSteps(userAgent: string): InstallStep[] {
  const ua = userAgent || '';
  if (/Android/i.test(ua)) {
    if (/SamsungBrowser/i.test(ua)) {
      return [
        { marker: '1', text: 'Tap the **menu** button (three lines) at the bottom of the screen' },
        { marker: '2', text: 'Tap **“Add to”**, then **“Home screen”**' },
      ];
    }
    if (/Firefox/i.test(ua)) {
      return [
        { marker: '1', text: 'Tap the **⋮** menu' },
        { marker: '2', text: 'Tap **“Add app to Home screen”**' },
      ];
    }
    return [
      { marker: '1', text: 'Tap the **⋮** menu at the top right' },
      { marker: '2', text: 'Tap **“Add to Home screen”**, then **“Install”**' },
    ];
  }
  return [
    { marker: '1', text: 'Look for the **install** icon at the right of the address bar (a screen with a down arrow)' },
    { marker: '2', text: 'Or open the browser **menu** and choose **“Install Pocket Reader”** (in Edge: **Apps**, then **Install this site as an app**)' },
  ];
}

/**
 * Ask the browser to keep this site's storage (the downloaded voices, the
 * library, saved narration) instead of clearing it when space runs short.
 * Granted silently for installed apps and well-used sites; harmless when not.
 */
export async function keepStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** One line for the Home card. */
export const INSTALL_WHY = 'Opens like an app from your home screen, and keeps its voices and your library where the browser will not clear them.';

/**
 * Why installing is worth two taps. Each line is something the platform
 * actually does differently for an installed web app, not a hope:
 * Safari deletes a site's storage after seven days without a visit unless it
 * is on the home screen; web push on iPhone exists only for home-screen apps;
 * and an installed app is its own window, outside the browser's tab limits.
 */
export const INSTALL_BENEFITS = [
  'It opens full screen from your home screen, like any other app.',
  'It keeps its downloaded voices, your library and saved narration. A browser tab can lose them after a week without a visit.',
  'It is its own app, so closing the browser or its tabs does not stop your story.',
  'On iPhone, new-chapter alerts only work once it is installed.',
];
