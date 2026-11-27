# Audit findings, 2026-11-26

Code audit of `main` at `ce97801` (v2 live on GitHub Pages), and the fixes made
for it. The findings below are kept as written at audit time; the Status section
says where each one stands now.

## Status

Fixed in the working tree on `rebuild/v2`. **Not yet live**: the backend needs
a deploy (a push to `main` does it), the Worker needs `wrangler deploy`, and the
app needs the Pages build.

| # | Status | How it was checked |
|---|---|---|
| 1 | Fixed | `tests/backend_text_extraction_regressions.py`; real `parse_epub` |
| 2 | Fixed | Same suite; the live AO3 page now parses as 1 chapter, 106 paragraphs |
| 3 | Fixed | Same suite, against AO3's real banner markup |
| 4 | Fixed | `tests/audit_2026_11_26_fixes.test.mjs`; in the browser the real engine started at paragraph 4 of a story whose first three lines were a link, a title echo and a separator |
| 5 | Fixed | Bridge tests. Add now needs no fetch. Saving another story offline while one plays is refused with a message |
| 6 | Fixed in code, **untested end to end** | Push was ported back (`web/src/lib/core/push.ts`). The toggle now reflects the real subscription and can cancel an old one. Needs a real device: permission prompt, a subscription, a delivered alert |
| 7 | Fixed | Bridge tests. Followed stories are also checked when the app opens |
| 8 | Fixed | Bridge tests: the deadline is checked at every paragraph, and the timer survives the reload |
| 9 | Fixed | Bridge test; in the browser on the real cores |
| 10 | Fixed | Start screen and an error with "Try again"; smoke tests in Chromium and WebKit |
| 11 | Fixed | The setting still changes (it is the memory-safe default) but the reader is told and the toggle updates |
| 12 | Fixed | The four names are routed to notices; long messages stay on screen longer |
| 13 | Fixed | Bridge tests |
| 14 | Fixed | Bridge test; Settings and the voice sheet say when the device voice is reading |
| 15 | Fixed in code, **needs a phone** | Source test. Cannot be exercised without a lock screen |
| 16 | Fixed | In the browser with the page marked hidden: 8 of 8 paragraphs were handed over already staged |
| 17 | Fixed | Bridge test |
| 18 | Fixed | In the browser: a clip paused behind the app's back was restarted |
| 19 | **Mitigated, not proven** | Phones now render up to about 15 minutes ahead instead of 8 paragraphs, and the player shows how many paragraphs are ready. Whether a locked iPhone keeps rendering is still unknown |
| 20 | Fixed | In the browser: the record was written through and closed on return. Shown under Settings, About, long-press the version |
| 21 | Fixed | Source test |
| 22 | Fixed | Type check; not exercised against a failing search |
| 23 | Fixed | Source test. Needs `wrangler deploy` |
| 24 | **Guard only** | A test now fails when a core calls a global nothing defines. The dead old-shell code itself was not removed: it is entangled with code that tests pin, and removing it risks the live narration path for no user-visible gain |

Found while fixing, and fixed:

- **25.** A story added from search or the catalog still showed "Add": the row is
  keyed by address, the library by its own key. Now matched by address too.
- **26.** Home said "Your shelf is empty" when the library had stories but none
  had been started. It now offers the newest one as "Up next".
- **27.** The AO3 scraper dropped any paragraph of five characters or fewer
  ("No." "Okay."). Kept now; only lines with no letter or digit are dropped.

Still to do by hand:

- Deploy the backend and the Worker, then re-fetch stories saved with damaged
  text (remove and add again, or use "Check for new chapters").
- Run the phone test at the end of this file on an iPhone and an Android phone.
- Try alerts once on a real device.
- `ANTHRONOMICON_BRIDGE.md` still describes the old shell's masterlist view.

**How to read the Evidence column**

- **Ran**: reproduced by running the real code, or observed on the live site.
- **Code**: established by reading the code; not exercised.
- **Inferred**: follows from the code and the project's own notes, but depends
  on device behaviour that was not tested.

## Goal added by the owner

**Locked-screen playback must work on phones.** Items 15 to 20 are the work for
that goal; item 8 belongs with them. See "Locked-screen playback" below for what
is known, what is not, and how to test it.

## Serious

| # | Finding | Evidence | Where |
|---|---|---|---|
| 1 | Story text is split into fragments at every italic, bold or link. `get_text("\n\n")` puts a paragraph break between every text node, so "She looked at the *very* big dog" becomes three paragraphs. Affects EPUB (the normal AO3 path and EPUB uploads), HTML uploads, RoyalRoad, SoFurry, FurAffinity and Wattpad. | Ran: `parse_epub` returned 5 paragraphs for one sentence | `backend/parsers_epub.py:174`, `parsers_document.py:81`, `scrapers_royalroad.py:40,84`, `scrapers_sofurry.py:45`, `scrapers_furaffinity.py:43`, `scrapers_wattpad.py:22,72` |
| 2 | The AO3 scraper glues words together. `p.get_text(strip=True)` strips each text node and joins with nothing, so "the *very* big dog" becomes "theverybig dog", and lines separated by `<br>` fuse into one paragraph. | Ran: reproduced; live "Downward Dog" (2,100 words) arrived as one paragraph | `backend/scrapers_ao3.py:110-116` |
| 3 | AO3's site notice is saved as Chapter 1. For single-chapter works the `role='article'` selector matches nothing, and the fallback collects every `div.userstuff` on the page, including the admin banner. The story becomes Chapter 2. AO3 has also disabled EPUB downloads, so every AO3 story currently takes this path. | Ran: live `/api/scrape` and `/api/ao3` both return the banner as Chapter 1 | `backend/scrapers_ao3.py:183-187`, `164-169` |
| 4 | Narration no longer skips non-story lines. `window.isMetaParagraph` was defined in `ui_controller.js`, which the rebuild deleted. Playback, the lookahead, the start runway and offline saving now skip only empty paragraphs, so links, title and author echoes, "Words:" lines, separators and author's notes are read aloud. | Ran: `typeof window.isMetaParagraph` is `undefined` live | `public/assets/js/audio_core.js:5528-5541`, `buffer_manager.js:1876-1883` |
| 5 | Add (and Save offline on a story that is not open) replaces the story under the player. `loadStory(..., { preventNavigate: true })` still assigns `window.currentStory`, and no event tells the UI. The screen shows one story while Play narrates another. | Ran: live, `library.add` changed the core's story while the mini player kept the old title | `web/src/lib/core/bridge.real.ts:761-774`, `745-751`; `public/assets/js/api_core.js:1063,1349` |

Items 1 to 3 need a backend deploy. Stories already saved with damaged text
need re-fetching; the backend's 30-minute scrape cache clears on deploy.

## Medium

| # | Finding | Evidence | Where |
|---|---|---|---|
| 6 | New-chapter alerts cannot notify. The code that requested notification permission, created the push subscription and synced it lived in `settings_manager.js`, now deleted. The Settings toggle and the per-story switch only store a flag. Readers who subscribed in the old app still receive pushes and have no way to turn them off, because nothing calls `/api/unsubscribe`. Tapping a notification opens the app, which ignores the `story-update` message. | Code; live: no subscription exists and none can be created | `web/src/lib/core/bridge.real.ts:788-792,888,927`; `public/sw.js:244-320`; `public/assets/js/library_manager.js:2122` |
| 7 | New-chapter markers never appear. The Library badge, the "New" pill, the "New chapters" filter and Home's "New chapters" section read `hasUpdate` / `newChaptersAvailable`, which no core writes. Nothing checks followed stories automatically, and "Check for new chapters" discards its result. | Code | `bridge.real.ts:859`; `web/src/lib/library/StorySheet.svelte:47-51`; `library_manager.js:1082-1090` |
| 8 | The timed sleep timer is a page `setTimeout`. A locked phone suspends page timers, so the timer is likely to fire late or not at all exactly when it is used. A timer set before the first Play is also lost in the fast-narration reload. | Inferred | `bridge.real.ts:632-652` |
| 9 | Removing the story that is open leaves it in the player. `removeStory` does not stop playback or clear `currentStory`, and the UI keeps showing it. | Code | `library_manager.js:1266-1287`; `StorySheet.svelte:53-56` |
| 10 | A failed start shows a blank page. `main.ts` awaits about twenty core imports with nothing on screen and no error handling, so a failed import leaves an empty page with no message. | Code | `web/src/main.ts:36`; `web/index.html` |
| 21 | The backend scrape cache ignores cookies. The key is the URL alone, so a signed-in fetch of gated content is served to anyone for 30 minutes, and a login-wall result is served to a signed-in reader. | Code | `backend/app.py:1928-1931` |

## Minor

| # | Finding | Evidence | Where |
|---|---|---|---|
| 11 | Saving a story offline on a memory-constrained phone silently turns off Expressive narration when no dialog is available to ask. | Code | `public/assets/js/buffer_manager.js:1998-2006` |
| 12 | About 60 calls still go to deleted interface functions (`virtueSpeak`, `triggerVirtue`, `showSettingsModal`, `showFeatureDialog`) instead of the event layer, so their messages never show. Example: following a completed story silently does nothing. | Ran: all four are `undefined` live | `library_manager.js` (41), `hmofa_preferences.js` (7), `buffer_manager.js` (6), `device_setup.js` (5), `hmofa_masterlist.js` (3) |
| 13 | Tiered achievements always look locked. Tiers are stored as `id_t0`, `id_t1`, and the bridge looks up the bare id. The "achievement unlocked" notice never fires: `queueAchievementUnlock` is gone and the bridge never emits `achievement`. | Code | `bridge.real.ts:1142`; `library_manager.js:1877-1894` |
| 14 | When the app steps down to the device voice, the interface still reports the engine as Pocket. | Code | `bridge.real.ts:134-136` |
| 22 | AO3 search: a failed "load more" removes the button, and a slow response can overwrite a newer search. | Code | `web/src/lib/discover/Ao3Search.svelte:13-25` |
| 23 | The Worker's `?url=` proxy decodes its target twice, so a legitimate URL containing a literal `%` is rejected or altered. Host validation runs after decoding, so this is not a bypass. | Code | `worker/cloudflare_worker.js:608` |
| 24 | Dead code from the old shell remains in the cores: 58 element ids that no longer exist are looked up 94 times, `library_manager.js` still builds old-shell HTML, and the `ended` play state is never set. No user impact; it hides real problems like items 4 and 12. | Ran: cross-reference script | `public/assets/js/library_manager.js`, `buffer_manager.js`, `device_setup.js`, `api_core.js`, `audio_core.js` |

## Locked-screen playback

### What the code already does

- Phones play each paragraph through a plain audio element, not a Web Audio
  graph, because iOS suspends an audio context on lock.
- A silent looping clip is started inside the Play tap to keep the audio session
  alive between paragraphs.
- The next paragraph is read from storage while the current one plays and handed
  over at the boundary, so the boundary needs no storage read.
- The lookahead renders up to 8 paragraphs ahead and does not stop when the page
  is hidden. Lock-screen and headset controls are bound.

### What is wrong or unproven

| # | Finding | Evidence | Where |
|---|---|---|---|
| 15 | Play from the lock screen or a headset can be swallowed. The start gate compares the prepared runway's position with the current position. After playback has moved on they differ, so a Play that cannot resume a paused clip starts preparing and returns without playing. There is nothing on a locked screen to show that, and nothing starts playback when preparation finishes. | Code | `public/assets/js/audio_core.js:4100-4106`, `4462-4467`, `2282` |
| 16 | The next paragraph is staged once, when the current one starts. If the lookahead renders it a moment later, it is never staged, and the boundary falls back to a storage read inside the short window a locked phone allows. | Code; impact inferred | `audio_core.js:4722`, `4902-4943`, `4321-4327` |
| 17 | Interface work now runs before `play()` at every paragraph boundary. `ui.paragraph()` is dispatched synchronously, and the v2 bridge answers it with two snapshots and store updates before the next clip is started. The boundary's ordering is documented as load-bearing. | Code | `audio_core.js:4154`; `bridge.real.ts:389-409` |
| 18 | No recovery from a stall while hidden. On return to the app only a paused, unfinished clip is restarted. If the clip ended and the next never started, the app shows "playing" in silence until Play is toggled. | Code | `audio_core.js:2465-2472` |
| 19 | How far locked listening can go is unknown. The project's own comments say iOS suspends the synthesis worker when the screen sleeps. If so, a locked iPhone plays only what was rendered beforehand: the 10-paragraph start runway plus up to 8 from the lookahead. Android keeps running while audio is audible. | Inferred; needs a real device | `audio_core.js:4306-4317`; `buffer_manager.js:725-730` |
| 20 | A failed lock-screen test cannot be diagnosed. Nothing records when the page was hidden, how many paragraphs were rendered or played while hidden, or why playback stopped. | Code | `public/assets/js/diagnostics.js` |

### Plan

1. Fix 15, 16, 17 and 18. These are certain from the code and safe on every
   device.
2. Add the diagnostics in 20, then run the test below once on a real iPhone and
   once on an Android phone.
3. Decide 19 from that result. If synthesis stops while locked, render further
   ahead while the screen is on (by minutes of audio, not 8 paragraphs), show
   how much audio is ready, and offer to save the chapter before locking.
4. Fix 8 by checking the sleep deadline at each paragraph and on audio time
   updates, which run when page timers do not.

### Test to run on a real phone

1. Open a story of at least 30 paragraphs and wait for Play to unlock.
2. Press Play, wait for the first paragraph to start, then lock the phone.
3. Listen for ten minutes. Note the paragraph where narration stops, if it does.
4. On the lock screen, press Pause, wait ten seconds, press Play.
5. Unlock and open Settings, About, long-press the version for diagnostics.
   The "Locked-screen listening" rows say how many paragraphs played, where
   each came from, how many were rendered meanwhile, and whether narration was
   still running when you came back.

## Coverage

Read in full: `web/src` (bridge, stores, actions, screens), `public/sw.js`,
`worker/cloudflare_worker.js`, `backend/scrapers_ao3.py`, the playback half of
`audio_core.js` (media session, keep-alive, play, runway, lookahead, paragraph
boundary, skip and seek), the queue and message handler of `pocket_worker.js`,
and the scrape, upload and subscribe endpoints of `backend/app.py`.

Cross-referenced by script, not read line by line: every global the bridge and
cores use against what is still defined; old-shell element lookups; timers and
visibility checks in the cores.

Not read: model loading, sampling and the vocoder in `pocket_worker.js`;
`kokoro_worker.js`; the audio quality guards and voice loading in
`audio_core.js`; the caching loop in `buffer_manager.js`; the remaining backend
endpoints (search, sync sweep, FicHub relay) and the non-AO3 scrapers beyond
their paragraph extraction.

The automated style pass reported 767 findings (console logging, loose equality,
`any`, commit-message format). None are bugs, and this project has no
coding-standards folder for them to apply to. They are not logged here.
