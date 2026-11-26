// The one channel from the narration/library cores to whatever UI is mounted.
//
// The cores used to call UI functions by name -- window.updateReaderUIText(),
// window.showView('reading-view'), window.triggerVirtue('virtue_thinking') --
// which welded them to one particular shell: a core could not run without that
// shell's globals, and a new UI had to re-create every global name the old one
// happened to use. Now a core says WHAT happened through `ui` below, and every
// method becomes one typed event on `coreEvents`.
//
// Two listeners exist during the v2 rebuild:
//   - legacy_ui_adapter.js turns each event back into the old global call with
//     the original arguments, so the current shell behaves exactly as before;
//   - the new UI subscribes through web/src/lib/core/bridge.ts.
//
// Dispatch is synchronous, and a listener may set `detail.result`, which the
// `ui` method returns. That keeps the few call sites that used a return value
// (or awaited one) working with no change in timing.
//
// Event detail always carries `args` (the original call's arguments) plus named
// fields for the new UI. Adding a method: give it a type here, a semantic
// detail, and a legacy name in legacy_ui_adapter.js.

export const coreEvents = new EventTarget();

export const CORE_EVENT = Object.freeze({
  NOTICE: 'pr:notice',               // { message, duration, title?, tone? }
  COMPANION: 'pr:companion',         // { beat? , speech?, duration?, priority? }
  PARAGRAPH: 'pr:paragraph',         // the reading position changed
  PLAYSTATE: 'pr:playstate',         // { playing }
  NAVIGATE: 'pr:navigate',           // { view }
  STORY_OPENED: 'pr:story-loaded',   // { story, author }
  LOADING: 'pr:loading',             // { active, headline?, sub?, onCancel? }
  DIALOG: 'pr:dialog',               // { title, bodyHtml }
  LIBRARY: 'pr:library',             // { what: 'library' | 'progress' | 'bookmarks', skipAnimation? }
  CACHE_PANEL: 'pr:cache-panel',     // { action: 'close' | 'ask' }
  ENGINE: 'pr:engine',               // { what: 'controls' | 'voices' }
  BUFFER: 'pr:buffer',               // { state }
  STATUS: 'pr:status',               // { text } -- one-line narration/caching status
  PROGRESS: 'pr:progress',           // { pct } -- engine/model load progress, 0-100
  PLAY_LOADING: 'pr:play-loading',   // { loading, message }
  CACHING: 'pr:caching-progress',    // { active, paused, mode, cached, total, skipped, pct, runway, text }
  GESTURE: 'pr:gesture-needed',      // { verb, onContinue } -- call onContinue inside a user tap
});

let _lastStatus = '';
// The most recent status line, whichever core produced it. The lock-screen
// card shows it beside the chapter title.
export function lastStatus() { return _lastStatus; }

export function emit(type, detail = {}) {
  const payload = { ...detail };
  coreEvents.dispatchEvent(new CustomEvent(type, { detail: payload }));
  return payload.result;
}

// Subscribe; returns the unsubscribe function.
export function onCore(type, handler) {
  const listener = (event) => handler(event.detail, event);
  coreEvents.addEventListener(type, listener);
  return () => coreEvents.removeEventListener(type, listener);
}

const call = (type, legacy, args, named = {}) => emit(type, { ...named, legacy, args });

export const ui = Object.freeze({
  notify: (message, duration, ...rest) =>
    call(CORE_EVENT.NOTICE, 'pocketNotify', [message, duration, ...rest], { message, duration }),
  notice: (options = {}) =>
    call(CORE_EVENT.NOTICE, 'queueNotice', [options], { ...options }),
  companion: (beat, variables) =>
    call(CORE_EVENT.COMPANION, 'triggerVirtue', [beat, variables], { beat }),
  say: (speech, duration, priority) =>
    call(CORE_EVENT.COMPANION, 'virtueSpeak', [speech, duration, priority], { speech, duration, priority }),
  paragraph: () => call(CORE_EVENT.PARAGRAPH, 'updateReaderUIText', []),
  playstate: (playing = globalThis.isPlaying) =>
    call(CORE_EVENT.PLAYSTATE, 'updateDeckTransport', [playing], { playing: !!playing }),
  playButtons: () =>
    call(CORE_EVENT.PLAYSTATE, 'updatePlayButtons', [], { playing: !!globalThis.isPlaying }),
  navigate: (view) => call(CORE_EVENT.NAVIGATE, 'showView', [view], { view }),
  storyOpened: (story, author) =>
    call(CORE_EVENT.STORY_OPENED, 'populateReaderUI', [story, author], { story, author }),
  loading: (headline, sub, onCancel) =>
    call(CORE_EVENT.LOADING, 'showLoadingOverlay', [headline, sub, onCancel], { active: true, headline, sub, onCancel }),
  loaded: () => call(CORE_EVENT.LOADING, 'hideLoadingOverlay', [], { active: false }),
  dialog: (title, bodyHtml) => call(CORE_EVENT.DIALOG, 'showSettingsModal', [title, bodyHtml], { title, bodyHtml }),
  libraryChanged: (skipAnimation) =>
    call(CORE_EVENT.LIBRARY, 'renderLibrary', [skipAnimation], { what: 'library', skipAnimation }),
  progressChanged: () => call(CORE_EVENT.LIBRARY, 'updateContinueReading', [], { what: 'progress' }),
  bookmarksChanged: () => call(CORE_EVENT.LIBRARY, 'renderBookmarksTab', [], { what: 'bookmarks' }),
  closeCachePanel: () => call(CORE_EVENT.CACHE_PANEL, 'closeCacheModal', [], { action: 'close' }),
  askCacheDecision: () => call(CORE_EVENT.CACHE_PANEL, 'showCacheDecisionModal', [], { action: 'ask' }),
  engineControlsChanged: () =>
    call(CORE_EVENT.ENGINE, 'renderNarrationEngineControls', [], { what: 'controls' }),
  voiceListChanged: (engine) =>
    call(CORE_EVENT.ENGINE, 'refreshVoiceSelectorForEngine', [engine], { what: 'voices', engine }),
  bufferChanged: (state) => call(CORE_EVENT.BUFFER, 'updateReaderDrawerStatus', [state], { state }),
  // The neural engine's own lifecycle: 'idle' | 'loading' | 'ready' | 'failed'.
  engineState: (state, engine) => emit(CORE_EVENT.ENGINE, { what: 'state', state, engine }),
  // No legacy global: legacy_ui_adapter.js paints the old elements for these.
  status: (text) => { _lastStatus = String(text || ''); return emit(CORE_EVENT.STATUS, { text: _lastStatus }); },
  progress: (pct) => emit(CORE_EVENT.PROGRESS, { pct: Math.max(0, Math.min(100, Number(pct) || 0)) }),
  playLoading: (loading, message) => emit(CORE_EVENT.PLAY_LOADING, { loading: !!loading, message }),
  // iOS only starts audio inside a user gesture, and the isolation reload
  // spends the one that pressed Play. A UI that handles this sets
  // detail.result = true and calls onContinue from inside its next tap.
  requestGesture: (verb, onContinue) => emit(CORE_EVENT.GESTURE, { verb, onContinue }),
  cachingProgress: (snapshot) => {
    if (snapshot?.text) _lastStatus = String(snapshot.text);
    return emit(CORE_EVENT.CACHING, { ...snapshot });
  },
});

if (typeof window !== 'undefined') {
  window.prCoreEvents = coreEvents;
  window.prCoreUi = ui;
}
