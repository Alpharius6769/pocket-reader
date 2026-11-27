# Pocket Reader v2 UI

Phone-first rebuild in Svelte 5 + Vite + TypeScript. It runs on the real
narration cores in `public/assets/js/` through `CoreBridge`.

```
npm run dev        # http://localhost:5180  (launch config: pocket-reader-v2)
npm run build      # -> dist/  (base './', public/ copied unbundled, bundle in dist/app/)
npm run test:ui    # vitest + jsdom
npm run check:ui   # svelte-check
```

## The one seam: `src/lib/core/bridge.ts`

`CoreBridge` is the only way the UI reaches the cores. The contract rules are at
the top of that file. In short: methods are async and reject with `BridgeError`
(its `message` is shown to the reader), continuous state is pushed through `on()`
events (no polling), payloads are plain objects, indices are zero-based, and
the bridge owns persistence.

`src/main.ts` builds `RealBridge` (`bridge.real.ts`) by default. `?mock=1` or
`?sim=iphone` selects `MockBridge` with sample data, for demos and design
captures. A bridge placed on `window.__pocketCoreBridge` before `main.ts` runs
takes precedence over both.

`bridge.mock.ts` is the reference implementation: every event the UI listens
for is emitted there, in the order the UI expects. `bridge.mock.test.ts` pins
that behaviour and `bridge.real.test.ts` covers the real bridge.

Voice ids follow the cores: Pocket is `alba, mary, eve, charles, george, paul`
(`noah` was retired in the english_2026-10 migration and aliases to `paul`),
Kokoro is `af_heart, af_bella, bf_emma, am_michael, am_fenrir, am_puck`.

## State

Four stores, nothing else: `player`, `library`, `settings`, `ui`
(`src/lib/stores/`). `wire.ts` is the only place bridge events are subscribed.
Components read stores and call `src/lib/actions.ts` or the bridge.

## Phone and desktop layouts

The phone layout is the default and the fallback. `src/lib/layout.ts` adds the
class `layout-desktop` to `<html>` only when the OS is Windows, macOS, Linux or
ChromeOS, the primary input is a mouse or trackpad, the window is at least
960 x 560, and the reader has not picked Compact in Settings. Every desktop rule
lives in `src/desktop.css` behind that class, so the phone styles cannot be
affected by it. `layout.test.ts` pins the detection, including an iPad or an
Android phone asking for the desktop site. `?layout=desktop|phone` skips
detection for design review; `?sim=iphone` is always phone.

## Design review links

`?sim=iphone` draws an iPhone 16 Pro status bar + Dynamic Island and applies its
safe-area insets. Other switches: `onboarded=0`, `empty=1`, `cold=1` (engine not
downloaded), `toast=1`. Deep links (startup only): `#library`, `#library/list`,
`#discover`, `#discover/results`, `#discover/filters`, `#discover/catalog`,
`#discover/import`, `#story/<key>`, `#preview`, `#now-playing`,
`#now-playing/playing|preparing|chapters|bookmarks|voice|sleep`, `#reader`,
`#settings/<page>`.

`node web/tools/capture-screens.mjs <outDir>` captures every screen in light and
dark at 402x874 with WebKit (set `PLAYWRIGHT_DIR` to a folder with Playwright
installed).

## Not in v2

Away mode, accounts / sign-in / cloud sync, the Kitten engine. `App.test.ts`
fails if any of them reappear in the rendered UI or the UI source. The curated
shelf is gone too, and the interface offers no device-voice option; the cores
still step down to the device voice on a phone that cannot hold a neural
session.
