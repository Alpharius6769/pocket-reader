# Pocket Reader v2 UI

Phone-first rebuild in Svelte 5 + Vite + TypeScript. It runs on mock data until
the real cores are wired in through `CoreBridge`.

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

To plug in the real cores, set `window.__pocketCoreBridge` to an object that
implements `CoreBridge` before `src/main.ts` runs, or call `setBridge()` from
`src/lib/core/index.ts`. `main.ts` falls back to `MockBridge` otherwise.

`bridge.mock.ts` is the reference implementation: every event the UI listens
for is emitted there, in the order the UI expects. `bridge.mock.test.ts` pins
that behaviour; a real bridge should pass the same scenarios.

Voice ids follow the cores: Pocket is `alba, mary, eve, charles, george, paul`
(`noah` was retired in the english_2026-10 migration and aliases to `paul`),
Kokoro is `af_heart, af_bella, bf_emma, am_michael, am_fenrir, am_puck`.

## State

Four stores, nothing else: `player`, `library`, `settings`, `ui`
(`src/lib/stores/`). `wire.ts` is the only place bridge events are subscribed.
Components read stores and call `src/lib/actions.ts` or the bridge.

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
fails if any of them reappear in the rendered UI or the UI source.
