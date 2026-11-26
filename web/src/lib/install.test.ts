// Ported from tests/ios_install_instructions.test.mjs (the old shell's banner).
import { describe, expect, it } from 'vitest';
import { boldRuns, iosInstallSteps, iosMajorVersion, isAppleTouchDevice } from './install';

const UA = {
  ios26: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1',
  ios26ipad: 'Mozilla/5.0 (iPad; CPU OS 26_1 like Mac OS X) AppleWebKit/605.1.15 Version/26.1 Mobile/15E148 Safari/604.1',
  // An iPad asking for the desktop site reports a Macintosh UA with NO OS token.
  ios26desktopUA: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  ios18: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1',
  ios15: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 Version/15.6 Mobile/15E148 Safari/604.1',
  unknown: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15',
};
const text = (ua: string) => iosInstallSteps(ua).map((s) => s.text).join(' | ');

describe('iOS install instructions', () => {
  it('reads the iOS major version, including the iPad desktop UA', () => {
    const cases: [string, number][] = [
      [UA.ios26, 26], [UA.ios26ipad, 26], [UA.ios26desktopUA, 26], [UA.ios18, 18], [UA.ios15, 15], [UA.unknown, 0],
      ['Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) Chrome/126 Mobile Safari/537.36', 0],
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36', 0],
      ['', 0],
    ];
    for (const [ua, want] of cases) expect(iosMajorVersion(ua), ua.slice(0, 60)).toBe(want);
  });

  it('tells iOS 26 about the ⋯ menu, not a Share button that is not there', () => {
    for (const ua of [UA.ios26, UA.ios26ipad, UA.ios26desktopUA]) {
      const t = text(ua);
      expect(t).toMatch(/⋯/);
      expect(t).toMatch(/to the right of the address bar/);
      expect(t).not.toMatch(/at the bottom of the screen/);
    }
  });

  it('warns iOS 26 to leave "Open as Web App" on', () => {
    // Off, the reader gets a Safari-tab bookmark and loses background audio,
    // lock-screen controls and reload protection, while it still LOOKS installed.
    const t = text(UA.ios26);
    expect(t).toMatch(/Open as Web App/);
    expect(t).toMatch(/switched \*\*on\*\*/);
  });

  it('describes the older Share button by its icon, not its position', () => {
    for (const ua of [UA.ios18, UA.ios15]) {
      const t = text(ua);
      expect(t).toMatch(/the square with an arrow pointing up/);
      expect(t).not.toMatch(/at the bottom of the screen/);
      expect(t).not.toMatch(/⋯/);
      expect(t).not.toMatch(/Open as Web App/);
    }
  });

  it('covers both layouts for an unknown version rather than guessing', () => {
    const t = text(UA.unknown);
    expect(t).toMatch(/square with an arrow pointing up/);
    expect(t).toMatch(/⋯/);
    expect(t).toMatch(/Open as Web App/);
    expect(t).toMatch(/If you do not see that switch/);
  });

  it('renders bold runs without HTML', () => {
    expect(boldRuns('Tap **Share** now')).toEqual([
      { text: 'Tap ', bold: false }, { text: 'Share', bold: true }, { text: ' now', bold: false },
    ]);
  });

  it('only targets Apple touch devices, including an iPad in desktop mode', () => {
    expect(isAppleTouchDevice(UA.ios26)).toBe(true);
    expect(isAppleTouchDevice(UA.ios26desktopUA, 5)).toBe(true);
    expect(isAppleTouchDevice(UA.ios26desktopUA, 0)).toBe(false);
    expect(isAppleTouchDevice('Mozilla/5.0 (Linux; Android 14) Chrome/126')).toBe(false);
  });
});
