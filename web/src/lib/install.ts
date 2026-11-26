/**
 * "Add to Home Screen" guidance for iPhone and iPad.
 *
 * Installing is not cosmetic here: only the installed web app keeps narrating
 * with the screen locked, shows lock-screen controls, and is spared Safari's
 * tab reloads. Ported from the old shell (ui_controller.js) with its rules:
 *
 * - iOS 26 moved Share behind the "⋯" button beside the address bar, and added
 *   an "Open as Web App" toggle to the Add dialog. Switched off, the reader gets
 *   a bookmark that opens in a Safari tab and loses everything above while
 *   still looking installed, so every iOS 26 path ends on that warning.
 * - Earlier versions have a Share button in the toolbar, described by its icon
 *   (bottom on iPhone, top right on iPad: naming a position is wrong for one).
 * - An unknown version covers both layouts rather than guessing.
 */

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
