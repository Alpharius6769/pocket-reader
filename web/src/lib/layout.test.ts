import { describe, expect, it } from 'vitest';
import { DESKTOP_QUERY, isDesktopOs, resolveLayout, type PlatformSignals } from './layout';

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

const desktops: [string, PlatformSignals][] = [
  ['Windows 10/11, Chrome', { uaPlatform: 'Windows', uaMobile: false, platform: 'Win32', userAgent: CHROME, maxTouchPoints: 0 }],
  ['Windows 11, Edge', { uaPlatform: 'Windows', uaMobile: false, platform: 'Win32', userAgent: `${CHROME} Edg/142.0.0.0`, maxTouchPoints: 0 }],
  ['Windows touchscreen laptop', { uaPlatform: 'Windows', uaMobile: false, platform: 'Win32', userAgent: CHROME, maxTouchPoints: 10 }],
  ['Windows, Firefox (no client hints)', { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0', maxTouchPoints: 0 }],
  ['macOS, Safari', { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15', maxTouchPoints: 0 }],
  ['macOS, Chrome', { uaPlatform: 'macOS', uaMobile: false, platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', maxTouchPoints: 0 }],
  ['macOS, Firefox', { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0', maxTouchPoints: 0 }],
  ['Linux, Chrome', { uaPlatform: 'Linux', uaMobile: false, platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', maxTouchPoints: 0 }],
  ['Linux, Firefox', { platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0', maxTouchPoints: 0 }],
  ['ChromeOS', { uaPlatform: 'Chrome OS', uaMobile: false, platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', maxTouchPoints: 0 }],
];

const mobiles: [string, PlatformSignals][] = [
  ['iPhone, Safari', { platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1', maxTouchPoints: 5 }],
  ['iPad, mobile site', { platform: 'iPad', userAgent: 'Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1', maxTouchPoints: 5 }],
  ['iPad, desktop site (claims to be a Mac)', { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15', maxTouchPoints: 5 }],
  ['Android phone, Chrome', { uaPlatform: 'Android', uaMobile: true, platform: 'Linux armv81', userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36', maxTouchPoints: 5 }],
  ['Android tablet, Chrome', { uaPlatform: 'Android', uaMobile: false, platform: 'Linux armv81', userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', maxTouchPoints: 5 }],
  ['Android, Firefox (no client hints)', { platform: 'Linux armv81', userAgent: 'Mozilla/5.0 (Android 16; Mobile; rv:145.0) Gecko/145.0 Firefox/145.0', maxTouchPoints: 5 }],
  ['Android, Samsung Internet', { uaPlatform: 'Android', uaMobile: true, platform: 'Linux armv81', userAgent: 'Mozilla/5.0 (Linux; Android 16; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/136.0.0.0 Mobile Safari/537.36', maxTouchPoints: 5 }],
  ['packaged native app', { native: true, uaPlatform: 'Windows', platform: 'Win32', userAgent: CHROME, maxTouchPoints: 0 }],
  ['nothing known', {}],
];

describe('isDesktopOs', () => {
  it.each(desktops)('%s is a desktop', (_name, signals) => {
    expect(isDesktopOs(signals)).toBe(true);
  });
  it.each(mobiles)('%s is not a desktop', (_name, signals) => {
    expect(isDesktopOs(signals)).toBe(false);
  });
});

describe('resolveLayout', () => {
  it('needs a desktop OS and a roomy, mouse-driven window', () => {
    expect(resolveLayout({ desktopOs: true, roomy: true, preference: 'auto' })).toBe('desktop');
    expect(resolveLayout({ desktopOs: true, roomy: false, preference: 'auto' })).toBe('phone');
    expect(resolveLayout({ desktopOs: false, roomy: true, preference: 'auto' })).toBe('phone');
  });

  // Android Chrome in "desktop site" mode reports Linux with no mobile flag, and
  // only its coarse pointer (the media query, `roomy`) tells it from a laptop.
  it('keeps a phone that claims a desktop OS on the phone layout', () => {
    expect(resolveLayout({ desktopOs: true, roomy: false, preference: 'auto' })).toBe('phone');
  });

  it('honours the Compact choice and the simulator', () => {
    expect(resolveLayout({ desktopOs: true, roomy: true, preference: 'phone' })).toBe('phone');
    expect(resolveLayout({ desktopOs: true, roomy: true, preference: 'auto', forcePhone: true })).toBe('phone');
  });

  it('asks for a real pointer as well as room', () => {
    expect(DESKTOP_QUERY).toMatch(/min-width: 960px/);
    expect(DESKTOP_QUERY).toMatch(/hover: hover/);
    expect(DESKTOP_QUERY).toMatch(/pointer: fine/);
  });
});
