# Anthronomicon ↔ Pocket Reader bridge

How the embedded story index (`alpharius6769.github.io/hmofa-story-index/`) hands
stories directly to Pocket Reader, so a reader never has to copy a URL out of the
frame and paste it back into the app.

Pocket Reader embeds the index in an iframe and talks to it over `postMessage`.
Both directions are origin-scoped: Pocket Reader posts only to
`https://alpharius6769.github.io`, and accepts story commands only from that
origin. Messages from any other origin are ignored.

## Handshake

Pocket Reader announces itself as soon as the frame loads:

```js
// Pocket Reader -> index
{ type: 'pocket_reader_init', capabilities: ['load_story', 'load_story_batch'], version: 1 }
```

The index should reply once it is ready to intercept clicks:

```js
// index -> Pocket Reader
parent.postMessage({ type: 'pocket_reader_ready' }, '*');
```

Until that reply arrives, Pocket Reader's banner tells the reader to paste a link
instead of promising tap-to-fetch. **Do not skip the reply** — an index that
intercepts clicks without acknowledging leaves the app advertising the wrong
thing, and one that acknowledges without intercepting is worse.

If the index initializes *after* Pocket Reader's announcement, it can ask for a
fresh one at any time:

```js
// index -> Pocket Reader
parent.postMessage({ type: 'pocket_reader_ping' }, '*');
```

## Loading one story

When the reader taps a story, prevent the frame's own navigation and send:

```js
// index -> Pocket Reader
parent.postMessage({
  type: 'hmofa_story_click',   // 'open_story' and 'select_story' also accepted
  url: 'https://archiveofourown.org/works/12345678',
  title: 'Story Title',        // optional, used for the loading message
}, '*');
```

`url` may also be supplied as `storyUrl`, `link`, or `href`. Pocket Reader
normalizes it (bare AO3 work IDs are accepted) and loads it into the library.

## Loading a shelf at once

```js
// index -> Pocket Reader
parent.postMessage({
  type: 'hmofa_story_click',
  stories: [
    { url: '...', title: 'First' },
    { url: '...', title: 'Second' },
  ],
}, '*');
```

Entries may be bare URL strings instead of objects. Notes on behaviour:

- **Capped at 25** per batch. Beyond that Pocket Reader takes the first 25 and
  says so, rather than silently dropping the rest.
- **Imported sequentially, not in parallel.** Each import hits the scrape
  backend, and Pocket Reader's `loadStory` aborts any load still in flight — so
  concurrent calls would cancel each other and only the last would survive.
- **Only the final story opens.** The rest land in the library. Importing twelve
  stories should not drag the reader through twelve story loads.
- Failures are counted and reported, not thrown; one unreachable work does not
  abandon the batch.

## Testing without the real index

The receiving side can be driven directly from the Pocket Reader console:

```js
window._handleHmofaStoryIntercept('https://archiveofourown.org/works/12345678', 'Test');
window._handleHmofaStoryBatch([{ url: '...', title: 'A' }, { url: '...', title: 'B' }]);
window.isHmofaBridgeConnected();   // has the index acknowledged?
```

Note these bypass the origin check by design — they are the internal handlers,
not the message path. To exercise the real path, post from a frame served on the
index's origin.
