/**
 * RealBridge: CoreBridge on the real narration/library cores in public/assets/js.
 *
 * The cores keep their state on `window` (userProfile, currentStory,
 * currentChapterIndex, isPlaying) and announce changes on the core event bus
 * (core_events.js). This class translates both into the CoreBridge contract:
 * plain-object snapshots in, typed events out. It never touches the DOM.
 *
 * Boot with `createRealBridge()`, which loads the cores first (coreLoader.ts).
 */
import {
  BridgeError,
  VOICES,
  type Achievement,
  type Ao3Query,
  type Ao3Result,
  type BackupResult,
  type Bookmark,
  type BridgeEventName,
  type BridgeEvents,
  type CacheState,
  type CatalogApi,
  type CatalogEntry,
  type CatalogFacet,
  type CatalogQuery,
  type CoreBridge,
  type Diagnostics,
  type EngineId,
  type EngineState,
  type LibraryApi,
  type LibraryEntry,
  type ListeningStats,
  type LoadOptions,
  type Notice,
  type Page,
  type PlaybackSnapshot,
  type PlayState,
  type Position,
  type RestoreResult,
  type RunwayState,
  type PendingStory,
  type Settings,
  type SleepTimer,
  type StorageUsage,
  type Story,
  type StoryKey,
  type StoryRef,
  type StorySummary,
  type VirtueMood,
  type VoiceId,
} from './bridge';
import { bootCores, importCore } from './coreLoader';
import { disablePush, enablePush, PushError, syncPushProfile } from './push';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;
const w = window as unknown as Record<string, any>;

const ENGINE_OVERRIDE_KEY = 'pr_narration_engine_override_v1';
const SETUP_COMPLETE_KEY = 'pr_setup_complete';
const SLEEP_KEY = 'pr_v2_sleep_timer';
const PAGE_SIZE = 20;

/* ----------------------------------------------------------- mapping */

function keyOf(story: any): StoryKey {
  return String(story?.storyKey || w.getStoryStableKey?.(story) || story?.title || '');
}

function parseWords(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const digits = String(value ?? '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : undefined;
}

function sourceOf(story: any): StorySummary['source'] {
  const url = String(story?.url || story?.sourceUrl || '');
  if (/archiveofourown\.org/i.test(url)) return 'ao3';
  if (story?.hmofaId || story?.source === 'hmofa') return 'hmofa';
  if (!url || /^local:|\/local-upload\//.test(url) || String(story?.storyKey || '').startsWith('local')) return 'upload';
  return 'url';
}

const RATINGS = new Set(['General', 'Teen', 'Mature', 'Explicit', 'Not Rated']);

function toSummary(story: any): StorySummary {
  const chapters = Array.isArray(story?.chapters) ? story.chapters.length : 0;
  const rating = RATINGS.has(story?.rating) ? story.rating : undefined;
  return {
    key: keyOf(story),
    title: String(story?.title || 'Untitled'),
    author: String(story?.author || 'Unknown'),
    source: sourceOf(story),
    url: story?.url || story?.sourceUrl || undefined,
    synopsis: story?.synopsis || story?.summary || undefined,
    fandoms: Array.isArray(story?.fandoms) ? story.fandoms : undefined,
    tags: Array.isArray(story?.tags) ? story.tags : undefined,
    rating,
    words: parseWords(story?.words ?? story?.wordCount),
    chapterCount: Number(story?.publishedChapters || story?.totalChapters || chapters || 0),
    complete: story?.workComplete === true ? true : undefined,
    coverUrl: story?.coverImage || story?.cover || undefined,
  };
}

function toStory(story: any): Story {
  const chapters = (Array.isArray(story?.chapters) ? story.chapters : []).map((c: any, i: number) => ({
    // "upload" is the backend's temp-file name, stored as the title of
    // heading-less uploads made before api_core started replacing it.
    title: String(c?.title && !/^upload(\.[a-z0-9]+)?$/i.test(String(c.title).trim()) ? c.title : `Chapter ${i + 1}`),
    paragraphs: Array.isArray(c?.paragraphs) ? c.paragraphs.map(String) : [],
  }));
  return { ...toSummary(story), chapterCount: chapters.length || toSummary(story).chapterCount, chapters };
}

function toBookmarks(story: any): Bookmark[] {
  const key = keyOf(story);
  return (Array.isArray(story?.bookmarks) ? story.bookmarks : [])
    .filter((b: any) => b && !b.deletedAt)
    .map((b: any) => ({
      id: String(b.id || `b_${b.c}_${b.p}_${b.ts}`),
      storyKey: key,
      chapter: Number(b.c) || 0,
      paragraph: Number(b.p) || 0,
      excerpt: String(b.t || ''),
      label: b.label || undefined,
      createdAt: Number(b.ts || b.updatedAt) || 0,
    }))
    .sort((a: Bookmark, b: Bookmark) => b.createdAt - a.createdAt);
}

function position(): Position {
  return { chapter: Number(w.currentChapterIndex) || 0, paragraph: Number(w.currentParagraphIndex) || 0 };
}

function activeEngine(): EngineId {
  return w._resolveActiveEngine?.() === 'kokoro' ? 'kokoro' : 'pocket';
}

/** The phone's own speech voice is what would narrate right now. */
function deviceVoiceActive(): boolean {
  const engine = w._resolveActiveEngine?.();
  return typeof engine === 'string' && engine !== 'pocket' && engine !== 'kokoro';
}

function settingsBag(): Record<string, any> {
  if (!w.userProfile) w.userProfile = {};
  if (!w.userProfile.settings) w.userProfile.settings = {};
  return w.userProfile.settings;
}

/** UI-only preferences the cores never had a field for. */
function uiBag(): Record<string, any> {
  const s = settingsBag();
  if (!s.v2 || typeof s.v2 !== 'object') s.v2 = {};
  return s.v2;
}

function save() {
  w.saveLocalData?.();
}

const MOOD_BY_BEAT: Array<[RegExp, VirtueMood]> = [
  [/annoyed/, 'annoyed'], [/thinking/, 'thinking'], [/loading/, 'loading'], [/favorite/, 'favorite'],
  [/achievement/, 'achievement'], [/explain/, 'talking'], [/point/, 'point'], [/settings/, 'settings'],
  [/happy|holding/, 'happy'], [/deleted/, 'lowscore'], [/wave|welcome/, 'waving'],
];

function moodFor(beat?: string): VirtueMood | undefined {
  if (!beat) return undefined;
  return MOOD_BY_BEAT.find(([re]) => re.test(beat))?.[1];
}

function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

/** Progress the cores announce that this UI already shows on the player. */
const CORE_CHATTER = /^(?:Pocket|Kokoro) TTS loaded!|^Preparing neural voice\b|^Voice engine changed\. Recaching|^Voice changed - re-caching/i;

/**
 * The cores' dialogs carry buttons this UI does not have ("Open Story in New
 * Tab", "How to save & load locally"). Flattened whole, their labels ran into
 * the message as words. Keep the first paragraph, which is the explanation.
 */
function dialogSummary(title: string, bodyHtml: string): string {
  const doc = new DOMParser().parseFromString(String(bodyHtml || ''), 'text/html');
  doc.querySelectorAll('button, a, script, style').forEach((el) => el.remove());
  const first = [...doc.querySelectorAll('p')].map((p) => (p.textContent || '').replace(/\s+/g, ' ').trim()).find(Boolean);
  const body = first || (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  if (/cloudflare shield/i.test(String(title || ''))) {
    return `${body || 'The site is blocking downloads of this story.'} Save the page and import it as a file instead.`;
  }
  return [title, body].filter(Boolean).join(': ');
}

/* ------------------------------------------------------------- class */

type Handler = (payload: never) => void;

/**
 * The cores' handoff record for the fast-narration reload (buffer_manager.js
 * FAST_NARRATION_RESUME_KEY). Present and fresh only while a story is still to
 * be reopened after that reload.
 */
function pendingResume(): { title: string } | null {
  try {
    if (new URLSearchParams(location.search).get('tts_fast') !== '1') return null;
    const record = JSON.parse(sessionStorage.getItem('pr_fast_narration_resume_v1') || 'null');
    if (!record?.title || Date.now() - Number(record.requestedAt || 0) > 120_000) return null;
    return { title: String(record.title) };
  } catch {
    return null;
  }
}

export class RealBridge implements CoreBridge {
  /** Survives minification, unlike the class name: tests and diagnostics read it. */
  readonly kind = 'real' as const;
  private handlers = new Map<BridgeEventName, Set<Handler>>();
  private state: PlayState = 'idle';
  private engine: EngineState = { engine: 'pocket', status: 'idle' };
  private sleep: SleepTimer = { kind: 'off' };
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepChapter: number | null = null;
  private lastCompanionBeat: string | undefined;
  private libraryTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeSeq = 0;
  /** Set when the cores wait for a tap after the isolation reload (iOS). */
  private pendingGesture: (() => void) | null = null;
  private gestureNoticeId: string | null = null;
  private gestureNotice: Notice | null = null;
  private lastEngineEmit = 0;
  private engineTrailing: ReturnType<typeof setTimeout> | null = null;
  private api: Record<string, AnyFn> = {};
  private catalogCore: Record<string, any> = {};
  private pending: PendingStory | null = null;
  private resumeWatch: ReturnType<typeof setInterval> | null = null;
  /** Core messages held back while a story is being opened (see coreNotice). */
  private loadNotices: string[] | null = null;
  /** A voice or engine change is in progress (see prepareRunway). */
  private switching = false;
  /** The voice sample that is playing, if one is. */
  private preview: { audio: HTMLAudioElement; stop: () => void } | null = null;
  private previewTurn = 0;
  private libCore: Record<string, AnyFn> = {};

  /** Called once by createRealBridge after the cores are loaded. */
  async attach() {
    const events = await importCore<{ onCore: AnyFn; CORE_EVENT: Record<string, string> }>('core_events.js');
    this.api = await importCore('api_core.js');
    this.catalogCore = await importCore('hmofa_catalog_core.js');
    this.libCore = await importCore('library_core.js');
    const E = events.CORE_EVENT;
    const on = events.onCore;

    // The old shell's onboarding and device-setup modals do not exist here.
    // deferForDeviceSetup would open a modal that is not there and still
    // return true -- blocking Play forever. Calibrate headlessly instead,
    // reporting progress through the engine state, then resume.
    w.deferForDeviceSetup = (resume: () => void) => {
      if (w._pocketDeviceSetup) return false;
      this.updateEngine({ status: 'loading', stage: 'compile', message: 'Checking what this device can run…' });
      Promise.resolve(w.startPocketDeviceSetup?.())
        .catch(() => {})
        .finally(() => {
          if (!w._pocketDeviceSetup) w._pocketDeviceSetup = { completedAt: Date.now(), headless: true };
          resume();
        });
      return true;
    };
    w.showFirstTimeProfileSetup = () => {};

    // Deferred to a microtask on purpose. The cores raise this synchronously
    // at a paragraph boundary, BEFORE they start the next clip, and on a locked
    // phone that boundary is the only time the page is given to run. Answering
    // it inline put two snapshots and every store update ahead of play().
    on(E.PARAGRAPH, () => queueMicrotask(() => this.onParagraph()));
    on(E.BUFFER, (d: any) => {
      if (d.state !== 'ahead' || !w.currentStory) return;
      const ahead = w.getNarrationAhead?.() || {};
      this.emit('buffer', { storyKey: keyOf(w.currentStory), ready: Number(ahead.paragraphs) || 0, target: Number(ahead.target) || 0 });
    });
    on(E.PLAYSTATE, (d: any) => this.setState(d.playing ? 'playing' : this.state === 'ended' ? 'ended' : 'paused'));
    on(E.PLAY_LOADING, (d: any) => {
      if (d.loading) this.setState(this.engine.status === 'ready' ? 'buffering' : 'loading');
      else if (this.state === 'loading' || this.state === 'buffering') this.setState(w.isPlaying ? 'playing' : 'paused');
    });
    on(E.STORY_OPENED, (d: any) => {
      if (!d.story) return;
      this.endResumeWatch();
      // Opening a story is how its new chapters get seen.
      const opened = this.libraryStory(keyOf(d.story));
      if (opened?.newChaptersAvailable) { opened.newChaptersAvailable = false; opened.newChapterCount = 0; save(); }
      this.rememberParagraphCounts(d.story);
      this.emit('story-loaded', { story: toStory(d.story), position: position() });
      this.onParagraph();
      this.scheduleLibrary();
    });
    on(E.LIBRARY, () => this.scheduleLibrary());
    on(E.NOTICE, (d: any) => this.coreNotice(d.tone === 'error' ? 'error' : 'info', d.message || d.title, undefined, d.actionLabel));
    on(E.COMPANION, (d: any) => {
      if (d.beat) this.lastCompanionBeat = d.beat;
      if (d.speech) this.coreNotice('info', d.speech, moodFor(d.beat || this.lastCompanionBeat));
    });
    on(E.DIALOG, (d: any) => this.coreNotice('info', dialogSummary(d.title, d.bodyHtml)));
    on(E.ENGINE, (d: any) => {
      if (d.what === 'state') {
        const status = d.state === 'ready' ? 'ready' : d.state === 'loading' ? 'loading' : d.state === 'failed' ? 'error' : 'idle';
        this.updateEngine({ status, stage: status === 'loading' ? 'download' : undefined });
      } else {
        this.updateEngine({});
        // A core changed a narration setting itself (a tier step-down, the
        // memory-safe default while saving offline): the toggles must show it.
        this.emit('settings', this.settingsNow());
      }
    });
    on(E.PROGRESS, () => {
      const t = w._pocketLoadTelemetry || {};
      if (this.engine.status !== 'loading') return;
      this.updateEngine({ stage: 'download', loadedBytes: Number(t.loadedBytes) || 0, totalBytes: Number(t.totalBytes) || 0 });
    });
    on(E.STATUS, (d: any) => {
      if (this.engine.status === 'loading' && d.text) this.updateEngine({ message: d.text });
    });
    on(E.GESTURE, (d: any) => this.handleGestureRequest(d));
    on(E.RUNWAY, () => this.emit('runway', this.getRunway()));
    on(E.CACHING, (d: any) => {
      const story = w.currentStory;
      if (!story) return;
      const storyKey = keyOf(story);
      const state: CacheState = d.total > 0 && d.cached >= d.total ? 'complete' : d.active ? 'caching' : d.cached > 0 ? 'partial' : 'none';
      this.emit('caching-progress', { storyKey, state, done: Number(d.cached) || 0, total: Number(d.total) || 0 });
      const target = Number(w.getPocketPlaybackReadyCount?.(d.total)) || 0;
      const ready = Number(w.BufferManager?.getReadyCount?.()) || Number(d.cached) || 0;
      this.emit('buffer', { storyKey, ready, target });
    });

    this.engine = { engine: activeEngine(), status: this.engineStatusNow(), ...(deviceVoiceActive() ? { deviceVoice: true } : {}) };
    if (w.currentStory) this.state = w.isPlaying ? 'playing' : 'paused';

    // Names the cores still call that belonged to the old interface. Routed to
    // the same notices everything else uses, so their messages are shown
    // again instead of going nowhere. (Dialogs with their own buttons have
    // no equivalent here; their callers already handle that.)
    const coreUi = w.prCoreUi;
    if (coreUi) {
      w.virtueSpeak ??= (speech: string, duration?: number) => coreUi.say(speech, duration);
      w.triggerVirtue ??= (beat: string) => coreUi.companion(beat);
      w.pocketNotify ??= (message: string, duration?: number) => coreUi.notify(message, duration);
      w.showSettingsModal ??= (title: string, bodyHtml: string) => coreUi.dialog(title, bodyHtml);
    }
    w.queueAchievementUnlock = (d: any) => {
      void this.listAchievements().then((list) => {
        const unlocked = list.find((a) => a.id === d?.ach_id);
        if (unlocked) this.emit('achievement', unlocked);
      });
    };
    w.syncPushProfileIfEnabled = () => void syncPushProfile();

    this.restoreSleepTimer();
    this.listenForStoryUpdates();

    // Reloaded into the fast-narration session with a story still to reopen:
    // say so until the cores have it back, or give up on it.
    const resume = pendingResume();
    if (resume && !w.currentStory) {
      this.pending = { title: resume.title };
      this.watchResume();
    }

    // A tap request raised before this bridge subscribed (the cores resume
    // narration while still loading after the isolation reload): claim it.
    const early = w.__prPendingNarrationGesture;
    if (early && !early.claimed && typeof early.finish === 'function') {
      early.claimed = true;
      queueMicrotask(() => this.handleGestureRequest({ verb: early.verb, onContinue: early.finish }));
    }
  }

  /* ------------------------------------------------------------ events */

  on<E extends BridgeEventName>(event: E, handler: (payload: BridgeEvents[E]) => void) {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler as Handler);
    // After the isolation reload the tap request is claimed in attach(), before
    // the stores subscribe, so its notice went to nobody. Hand it to a late
    // listener while the tap is still owed.
    const owed = this.gestureNotice;
    if (event === 'notice' && owed) {
      queueMicrotask(() => {
        if (this.gestureNotice === owed && set!.has(handler as Handler)) (handler as (n: Notice) => void)(structuredClone(owed));
      });
    }
    return () => set!.delete(handler as Handler);
  }

  private emit<E extends BridgeEventName>(event: E, payload: BridgeEvents[E]) {
    const set = this.handlers.get(event);
    if (!set?.size) return;
    const copy = structuredClone(payload);
    set.forEach((h) => (h as (p: BridgeEvents[E]) => void)(copy));
  }

  private setState(state: PlayState, reason?: string) {
    if (state === this.state) return;
    this.state = state;
    this.emit('playstate', { state, reason });
  }

  private engineStatusNow(): EngineState['status'] {
    if (w._pocketNeuralEngineUnavailable) return 'error';
    const s = w.getNarrationEngineStatus?.();
    return s === 'ready' ? 'ready' : s === 'loading' ? 'loading' : s === 'failed' ? 'error' : 'idle';
  }

  private updateEngine(patch: Partial<EngineState>) {
    const runtime = w.getPocketTtsRuntimeConfig?.() || {};
    const next: EngineState = {
      ...this.engine,
      ...patch,
      engine: activeEngine(),
      backend: runtime.selectedBackend === 'webgpu' ? 'webgpu' : 'wasm',
    };
    if (deviceVoiceActive()) next.deviceVoice = true;
    else delete next.deviceVoice;
    if (next.status !== 'loading') {
      delete next.stage; delete next.loadedBytes; delete next.totalBytes;
      if (patch.message === undefined) delete next.message;
    }
    // Download progress arrives as both a progress tick and a status line, often
    // several times a millisecond. Emit only real changes, and at most four
    // progress updates a second; state changes always go through at once.
    const same = JSON.stringify(next) === JSON.stringify(this.engine);
    const progressOnly = next.status === 'loading' && this.engine.status === 'loading' && next.stage === this.engine.stage;
    this.engine = next;
    if (same) return;
    const now = performance.now();
    if (progressOnly && now - this.lastEngineEmit < 250) {
      if (!this.engineTrailing) {
        this.engineTrailing = setTimeout(() => {
          this.engineTrailing = null;
          this.lastEngineEmit = performance.now();
          this.emit('engine', { ...this.engine });
        }, 250);
      }
      return;
    }
    this.lastEngineEmit = now;
    this.emit('engine', { ...next });
  }

  /**
   * A message raised by the cores. While a story is being opened they explain
   * a failure in their own words (and once as a dialog with buttons this UI
   * does not have); those are collected so the load can report one clear
   * reason instead of two toasts, or a toast for a load that then succeeded.
   */
  private coreNotice(level: Notice['level'], message: string, mood?: VirtueMood, actionLabel?: string) {
    // The old shell announced each stage of loading a voice. Here the player
    // shows those stages itself, and the announcements arrived as a stack of
    // toasts over it, repeated for every voice tried.
    if (!actionLabel && CORE_CHATTER.test(String(message || ''))) return;
    if (this.loadNotices && !actionLabel) {
      if (message) this.loadNotices.push(String(message));
      return;
    }
    this.notice(level, message, mood, actionLabel);
  }

  private notice(level: Notice['level'], message: string, mood?: VirtueMood, actionLabel?: string): Notice | null {
    if (!message) return null;
    const n: Notice = { id: `n${++this.noticeSeq}`, level, message: String(message), mood, actionLabel };
    this.emit('notice', n);
    return n;
  }

  private onParagraph() {
    const story = w.currentStory;
    if (!story) return;
    this.emit('runway', this.getRunway());
    const pos = position();
    const chapters = Array.isArray(story.chapters) ? story.chapters : [];
    this.emit('paragraph', {
      storyKey: keyOf(story),
      position: pos,
      paragraphCount: chapters[pos.chapter]?.paragraphs?.length ?? 0,
      chapterCount: chapters.length,
    });
    // A locked phone suspends page timers, so the timed sleep is also checked
    // here: this runs at every paragraph, which keeps happening while audio does.
    if (this.sleep.kind === 'minutes' && Date.now() >= this.sleep.endsAt) this.fireSleepTimer();
    if (this.sleep.kind === 'end-of-chapter' && this.sleepChapter !== null && pos.chapter !== this.sleepChapter) {
      this.pause();
      this.sleep = { kind: 'off' };
      this.sleepChapter = null;
      this.storeSleepTimer();
      this.emit('sleep', { ...this.sleep });
      this.notice('info', 'Stopped at the end of the chapter.', 'kneeling');
    }
    this.scheduleLibrary(1500);
  }

  private scheduleLibrary(delay = 0) {
    if (this.libraryTimer) return;
    this.libraryTimer = setTimeout(async () => {
      this.libraryTimer = null;
      this.emit('library', await this.library.list());
    }, delay);
  }

  /* ---------------------------------------------------------- snapshot */

  getPlayback(): PlaybackSnapshot {
    const story = w.currentStory;
    const pos = position();
    const s = this.settingsNow();
    return {
      storyKey: story ? keyOf(story) : null,
      state: this.state,
      position: pos,
      paragraphCount: story?.chapters?.[pos.chapter]?.paragraphs?.length ?? 0,
      chapterCount: story?.chapters?.length ?? 0,
      speed: s.speed,
      engine: s.engine,
      voice: s.voice[s.engine],
      sleep: { ...this.sleep },
    };
  }

  getCurrentStory(): Story | null {
    return w.currentStory ? toStory(w.currentStory) : null;
  }

  getRunway(): RunwayState {
    const story = w.currentStory;
    const storyKey = story ? keyOf(story) : null;
    const none = { storyKey, ready: 0, target: 0, preparing: false, ok: false, known: true };
    if (!story) return none;
    // The device voice renders nothing ahead.
    if (!['pocket', 'kokoro'].includes(w._resolveActiveEngine?.() ?? 'pocket')) return { ...none, ok: true };
    if (typeof w.isNarrationRunwayReady !== 'function') return { ...none, target: 10, known: false };
    const snap = w.getNarrationRunway?.();
    if (!snap || !snap.current) return { ...none, target: 10, ok: !!w.isNarrationRunwayReady() };
    return {
      storyKey,
      ready: Number(snap.ready) || 0,
      target: Number(snap.target) || 0,
      preparing: !!snap.preparing,
      ok: !!w.isNarrationRunwayReady(),
      error: snap.error || undefined,
      known: true,
    };
  }

  async prepareRunway(): Promise<boolean> {
    if (!w.currentStory) return false;
    // A voice or engine change pauses for a moment and then plays on. Preparing
    // here in that moment rendered the current paragraph a second time, at
    // playback priority, against the one about to be played.
    if (this.switching) return true;
    // The first narration of a session reloads into the fast (isolated)
    // session, and only a tap may do that: Play. Rendering before it would run
    // single-threaded and then be cut off by the reload.
    const reloadPending = !globalThis.crossOriginIsolated
      && !!(navigator.serviceWorker?.controller || w.__prServiceWorkerRegistration);
    if (reloadPending) return false;
    await w.ensureNarrationRuntime?.();
    void w.prepareNarrationRunway?.();
    this.emit('runway', this.getRunway());
    return true;
  }

  getEngineState(): EngineState {
    const state: EngineState = { ...this.engine, engine: activeEngine(), status: this.engineStatusNow() };
    if (deviceVoiceActive()) state.deviceVoice = true;
    else delete state.deviceVoice;
    return state;
  }

  /* ----------------------------------------------------------- stories */

  getPendingStory(): PendingStory | null {
    return this.pending ? { ...this.pending } : null;
  }

  private setPending(next: PendingStory | null) {
    if (!next && !this.pending) return;
    this.pending = next;
    this.emit('pending-story', next);
  }

  /** After the reload: hold the pending story until the cores reopen it or stop trying. */
  private watchResume() {
    const startedAt = Date.now();
    this.resumeWatch = setInterval(() => {
      const reopened = Array.isArray(w.currentStory?.chapters) && w.currentStory.chapters.length > 0;
      // The record is removed when the restore finishes, and when it fails.
      const abandoned = !pendingResume() && Date.now() - startedAt > 1500;
      if (reopened || abandoned || Date.now() - startedAt > 45_000) this.endResumeWatch();
    }, 400);
  }

  private endResumeWatch() {
    if (this.resumeWatch === null) return;
    clearInterval(this.resumeWatch);
    this.resumeWatch = null;
    this.setPending(null);
  }

  async loadStory(ref: StoryRef, options: LoadOptions = {}): Promise<Story> {
    if (ref.kind === 'file') {
      const summary = await this.importFile(ref.file);
      return this.loadStory({ kind: 'key', key: summary.key }, options);
    }
    const known = ref.kind === 'key' ? this.libraryStory(ref.key) : null;
    const target = ref.kind === 'key' ? known?.url || ref.key : ref.url;
    if (!target) throw new BridgeError('not-found', 'That story could not be found.');
    // Fetching a story can take several seconds: say which one is coming so
    // the Player has something to show from the tap onwards.
    const foreground = options.background !== true;
    if (foreground) this.setPending({ title: options.title || known?.title || '' });
    const before = w.currentStory;
    const wasPlaying = !!w.isPlaying;
    if (foreground) this.loadNotices = [];
    try {
      if (w.isPlaying) w.pausePlayback?.();
      try {
        await w.loadStory(target, { preventNavigate: options.background === true });
      } catch (error: any) {
        throw new BridgeError('network', error?.message || 'The story could not be opened.');
      }
      const said = this.loadNotices || [];
      this.loadNotices = null;
      const story = w.currentStory;
      // The cores report a failed fetch by returning with the story that was
      // open before still open. Reading that as success opened (and started
      // narrating) the previous story under the new one's name.
      const opened = !!story && Array.isArray(story.chapters) && story.chapters.length > 0
        && (story !== before || this.storyMatches(story, target));
      if (!opened) {
        if (wasPlaying && before && w.currentStory === before) void this.play();
        throw new BridgeError('not-found', said[said.length - 1] || 'That story could not be opened. Check the link, or try again in a moment.');
      }
      // Anything the cores said on the way to a story that did open.
      for (const message of said) this.notice('info', message);
      if (options.position) await this.seekToParagraph(options.position.paragraph, options.position.chapter);
      this.setState('paused');
      if (options.autoplay) void this.play();
      return toStory(story);
    } finally {
      this.loadNotices = null;
      if (foreground && this.resumeWatch === null) this.setPending(null);
    }
  }

  /** The open story is the one a load asked for (by key, address or title). */
  private storyMatches(story: any, target: string): boolean {
    const norm = (u: unknown) => String(u || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '').toLowerCase();
    const wanted = norm(target);
    if (!wanted) return false;
    return [keyOf(story), story?.url, story?.sourceUrl, story?.title].some((ref) => ref && norm(ref) === wanted);
  }

  async importFile(file: File): Promise<StorySummary> {
    if (!/\.(epub|pdf|txt|html?|docx|md|rtf)$/i.test(file.name)) {
      throw new BridgeError('unsupported-file', 'That file type is not supported. Try EPUB, PDF, TXT, HTML or DOCX.');
    }
    const before = new Set((w.userProfile?.library || []).map(keyOf));
    // The cores make an imported document the open story. Left like that, the
    // player went on showing the story it had while the cores held another: a
    // narration in progress carried on into the imported text at the next
    // paragraph, and removing the import closed the story still on screen.
    const open = { story: w.currentStory, chapter: w.currentChapterIndex, paragraph: w.currentParagraphIndex };
    try {
      await w.processUploadedFile(file, null, { silent: true });
    } catch (error: any) {
      throw new BridgeError('unsupported-file', error?.message || 'That file could not be read.');
    } finally {
      // Also when nothing was open: the player shows nothing, so the cores
      // must hold nothing, or Play acts on a story that is not on screen.
      if (w.currentStory !== open.story) {
        w.currentStory = open.story ?? null;
        w.currentChapterIndex = open.story ? open.chapter : 0;
        w.currentParagraphIndex = open.story ? open.paragraph : 0;
      }
    }
    const library = w.userProfile?.library || [];
    const added = library.find((s: any) => !before.has(keyOf(s))) || w.currentStory;
    if (!added) throw new BridgeError('unsupported-file', 'Nothing readable was found in that file.');
    this.scheduleLibrary();
    this.notice('success', `Imported “${added.title}”`, 'holding');
    return toSummary(added);
  }

  private libraryStoryByUrl(url: string): any {
    const norm = (value: unknown) => String(value || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
    const wanted = norm(url);
    if (!wanted || !/^https?:/.test(wanted)) return undefined;
    return (w.userProfile?.library || []).find((s: any) => norm(s.url) === wanted || norm(s.sourceUrl) === wanted);
  }

  /**
   * Followed stories are checked when the app opens, and a tapped alert leads
   * to its story. Without the first, "new chapters" only ever appeared after
   * pressing Check on one story at a time.
   */
  private listenForStoryUpdates() {
    const announce = async (keys: StoryKey[]) => {
      const titles = keys.map((k) => this.libraryStory(k)?.title).filter(Boolean);
      if (titles.length === 1) this.notice('success', `New chapters in “${titles[0]}”`, 'point');
      else if (titles.length > 1) this.notice('success', `New chapters in ${titles.length} stories you follow`, 'point');
    };
    const fromAlert = async (url: string) => {
      const story = this.libraryStoryByUrl(url);
      if (!story) return;
      await announce(await this.library.checkForUpdates(keyOf(story)));
    };
    try {
      navigator.serviceWorker?.addEventListener('message', (event) => {
        if (event.data?.type === 'story-update' && event.data.storyUrl) void fromAlert(String(event.data.storyUrl));
      });
      const fromLaunch = new URLSearchParams(location.search).get('story_update');
      if (fromLaunch) void fromAlert(fromLaunch);
    } catch { /* no service worker here */ }
    setTimeout(() => {
      if (document.hidden || w.isPlaying || w.BufferManager?.isActive) return;
      const followed = (w.userProfile?.library || []).some((s: any) => s.updateSubscribed);
      if (followed) void this.library.checkForUpdates().then(announce).catch(() => {});
    }, 12_000);
  }

  private libraryStory(key: StoryKey): any {
    return w.findLibraryStoryByRef?.(key) || (w.userProfile?.library || []).find((s: any) => keyOf(s) === key);
  }

  /* --------------------------------------------------------- transport */

  private handleGestureRequest(d: any) {
    if (typeof d.onContinue !== 'function') return;
    this.pendingGesture = d.onContinue;
    d.result = true;
    this.setState('paused', 'tap-to-start');
    this.gestureNotice = this.notice('info', 'Narration is ready. Tap play to start.', 'smile', d.verb || 'Start narration');
    this.gestureNoticeId = this.gestureNotice?.id ?? null;
  }

  /** Runs the cores' pending post-reload continuation inside this tap. */
  private continueGesture(): boolean {
    const go = this.pendingGesture;
    if (!go) return false;
    this.pendingGesture = null;
    this.gestureNoticeId = null;
    this.gestureNotice = null;
    this.setState('loading');
    go();
    return true;
  }

  async play() {
    // After the isolation reload the cores are already mid-play and only need
    // the tap; starting a second play here would toggle them off again.
    if (this.continueGesture()) return;
    if (!w.currentStory) throw new BridgeError('not-found', 'Choose a story first.');
    if (w.isPlaying) return;
    this.stopPreview(); // a voice sample must not talk over the story
    this.setState(this.engineStatusNow() === 'ready' ? 'buffering' : 'loading');
    // Called synchronously inside the tap so iOS keeps the user gesture that
    // unlocks audio; the deferred stub returns a promise for the rest.
    await w.togglePlayState();
    // Held back by the starting runway (it is now being prepared), or by the
    // isolation reload: not playing, so not loading either.
    if (!w.isPlaying) this.setState('paused');
    this.emit('runway', this.getRunway());
  }

  pause() {
    if (w.isPlaying) w.pausePlayback?.();
    if (this.state !== 'ended') this.setState(w.currentStory ? 'paused' : 'idle');
  }

  async togglePlay() {
    if (w.isPlaying) this.pause();
    else await this.play();
  }

  async seekToParagraph(paragraph: number, chapter = position().chapter) {
    if (!w.currentStory) return;
    await w.seekToParagraph(chapter, paragraph);
  }

  async seekToChapter(chapter: number) {
    if (!w.currentStory) return;
    await w.seekToChapter(String(chapter));
  }

  async skipParagraph(delta: number) {
    await w.skipParagraph?.(delta);
  }

  async skipChapter(delta: number) {
    await w.skipChapter?.(delta);
  }

  setSleepTimer(timer: { kind: 'off' } | { kind: 'minutes'; minutes: number } | { kind: 'end-of-chapter' }) {
    if (timer.kind === 'minutes') this.armSleepTimer(timer.minutes, Date.now() + timer.minutes * 60_000);
    else {
      if (this.sleepTimer) clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
      this.sleepChapter = timer.kind === 'end-of-chapter' ? position().chapter : null;
      this.sleep = timer.kind === 'end-of-chapter' ? { kind: 'end-of-chapter' } : { kind: 'off' };
    }
    this.storeSleepTimer();
    this.emit('sleep', { ...this.sleep });
  }

  private armSleepTimer(minutes: number, endsAt: number) {
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepChapter = null;
    this.sleep = { kind: 'minutes', minutes, endsAt };
    // The page timer is exact while the phone is awake; onParagraph is what
    // still fires when it is not.
    this.sleepTimer = setTimeout(() => this.fireSleepTimer(), Math.max(0, endsAt - Date.now()));
  }

  private fireSleepTimer() {
    if (this.sleep.kind !== 'minutes') return;
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    this.pause();
    this.sleep = { kind: 'off' };
    this.storeSleepTimer();
    this.emit('sleep', { ...this.sleep });
    this.notice('info', 'Sleep timer ended. Sweet dreams.', 'kneeling');
  }

  // The first narration of a session reloads the page. A timer set before
  // that used to vanish with it.
  private storeSleepTimer() {
    try {
      if (this.sleep.kind === 'off') sessionStorage.removeItem(SLEEP_KEY);
      else sessionStorage.setItem(SLEEP_KEY, JSON.stringify({ ...this.sleep, chapter: this.sleepChapter }));
    } catch { /* private mode */ }
  }

  private restoreSleepTimer() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SLEEP_KEY) || 'null');
      if (saved?.kind === 'minutes' && Number(saved.endsAt) > Date.now()) this.armSleepTimer(Number(saved.minutes) || 0, Number(saved.endsAt));
      else if (saved?.kind === 'end-of-chapter') {
        this.sleep = { kind: 'end-of-chapter' };
        this.sleepChapter = Number.isInteger(saved.chapter) ? saved.chapter : position().chapter;
      } else sessionStorage.removeItem(SLEEP_KEY);
    } catch { /* nothing saved */ }
  }

  /* --------------------------------------------------------- bookmarks */

  async saveBookmark(label?: string): Promise<Bookmark> {
    const story = w.currentStory;
    if (!story) throw new BridgeError('not-found', 'Nothing is open.');
    await w.saveBookmark();
    const entry = this.libraryStory(keyOf(story)) || story;
    const pos = position();
    const raw = (entry.bookmarks || []).filter((b: any) => !b.deletedAt && b.c === pos.chapter && b.p === pos.paragraph).pop();
    if (raw && label) { raw.label = label; save(); }
    this.scheduleLibrary();
    const mark = toBookmarks({ ...entry, bookmarks: raw ? [raw] : [] })[0];
    if (!mark) throw new BridgeError('unknown', 'The bookmark could not be saved.');
    return mark;
  }

  /* --------------------------------------------------------- narration */

  listVoices(engine?: EngineId) {
    return VOICES.filter((v) => !engine || v.engine === engine);
  }

  async setEngine(engine: EngineId) {
    if (engine === activeEngine() && localStorage.getItem(ENGINE_OVERRIDE_KEY) === engine) return;
    const wasPlaying = !!w.isPlaying;
    this.switching = true;
    try {
      this.pause();
      this.stopPreview();
      this.stopStaleCacheJob();
      await w.ensureNarrationRuntime?.();
      await w.switchReaderVoiceEngine(engine, true);
      w._releaseCurrentNarrationAudio?.();
      w.cancelNarrationRunway?.();
      this.updateEngine({ status: this.engineStatusNow() });
      this.emit('settings', this.settingsNow());
    } finally {
      this.switching = false;
    }
    this.emit('runway', this.getRunway());
    // Mid-listen the new engine takes over at this paragraph, as a voice
    // change does; it used to stop and wait behind a ten-paragraph gate with
    // nothing on screen saying why the story had gone quiet.
    if (wasPlaying) {
      w.__narrationRunwayBypassOnce = true;
      await this.play();
    }
  }

  /**
   * A whole-story render that was running in the voice or engine being left.
   * Carried across the change it was "re-pointed" at the new engine with a
   * substituted voice, and rendered the story in a voice nobody chose while
   * the paragraph being listened to waited behind it.
   */
  private stopStaleCacheJob() {
    const job = w.BufferManager;
    if (!job?.isActive && !job?.paused) return;
    const explicit = job.mode === 'Permanent';
    w._stopCaching?.();
    if (explicit) this.notice('info', 'Saving for offline stopped because the voice changed. Save the story again to keep it in the new voice.');
    this.scheduleLibrary();
  }

  async setVoice(voice: VoiceId) {
    const v = VOICES.find((x) => x.id === voice);
    if (!v) throw new BridgeError('not-found', 'Unknown voice.');
    if (v.engine !== activeEngine()) await this.setEngine(v.engine);
    const wasPlaying = !!w.isPlaying;
    this.switching = true;
    try {
      if (wasPlaying) this.pause();
      this.stopPreview();
      this.stopStaleCacheJob();
      await w.ensureNarrationRuntime?.();
      // recache: false -- the player renders ahead in the new voice itself. The
      // cores' own answer to a voice change is to render the whole story again,
      // once per voice tried.
      await w.onVoiceSelectionChange(voice, { confirm: false, recache: false });
      if (v.engine === 'pocket') {
        settingsBag().pocketVoice = voice;
        settingsBag().pocketVoiceChosen = true; // a later default change leaves it alone
      } else settingsBag().kokoroVoice = voice;
      save();
      // Switch over now, not a paragraph later: drop the old-voice clip (Play
      // used to resume it) and render the current paragraph again in the new
      // voice.
      w._releaseCurrentNarrationAudio?.();
      w.cancelNarrationRunway?.();
      this.emit('settings', this.settingsNow());
    } finally {
      this.switching = false;
    }
    this.emit('runway', this.getRunway());
    this.notice('info', `Now reading as ${v.name}`, 'wink');
    // Mid-listen, the new voice takes over at the current paragraph without
    // waiting for a fresh ten-paragraph runway; the lookahead builds it.
    if (wasPlaying) {
      w.__narrationRunwayBypassOnce = true;
      await this.play();
    }
  }

  setSpeed(speed: number) {
    const s = Math.round(Math.min(2.5, Math.max(0.5, Number(speed) || 1)) * 100) / 100;
    settingsBag().speed = s;
    save();
    const rate = Number(w.getEffectivePlaybackRate?.()) || s;
    if (w.currentAudio && 'playbackRate' in w.currentAudio) {
      try { w.currentAudio.playbackRate = rate; } catch { /* element gone */ }
    }
    this.emit('speed', { speed: s });
  }

  async previewVoice(voice: VoiceId) {
    const v = VOICES.find((x) => x.id === voice);
    if (!v) throw new BridgeError('not-found', 'Unknown voice.');
    if (w.isPlaying) throw new BridgeError('busy', 'Pause the story to hear a voice sample.');
    if (v.engine !== activeEngine()) throw new BridgeError('busy', `Switch to ${v.engine === 'pocket' ? 'Pocket' : 'Kokoro'} to preview this voice.`);
    await w.ensureNarrationRuntime?.();
    const sample = `Hello. I'm ${v.name}, and I'd be glad to read to you.`;
    const voiceId = v.engine === 'pocket' ? w.resolveVoiceWithSentiment?.('pocket', voice, sample) || voice : voice;
    this.stopPreview();
    const turn = this.previewTurn;
    const blob: Blob | null = await w.generateChunk(sample, voiceId);
    if (!blob) throw new BridgeError('engine-failed', 'The voice sample could not be rendered.');
    // Another sample was asked for, or the story started, while this rendered.
    if (turn !== this.previewTurn || w.isPlaying) return;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.playbackRate = Number(w.getEffectivePlaybackRate?.()) || 1;
    const finished = new Promise<void>((resolve) => {
      const done = () => {
        URL.revokeObjectURL(url);
        if (this.preview?.audio === audio) this.preview = null;
        resolve();
      };
      audio.onended = done;
      audio.onerror = done;
      this.preview = { audio, stop: () => { audio.onended = audio.onerror = null; audio.pause(); done(); } };
    });
    try {
      await audio.play();
    } catch {
      this.stopPreview();
      throw new BridgeError('engine-failed', 'The voice sample could not be played.');
    }
    // Resolves when the sample has finished, so the button can show it playing.
    await finished;
  }

  /** One sample at a time, and never over the story. */
  private stopPreview() {
    this.previewTurn += 1;
    this.preview?.stop();
    this.preview = null;
  }

  /* ----------------------------------------------------------- offline */

  async startCaching(key: StoryKey) {
    if (!w.currentStory || keyOf(w.currentStory) !== key) {
      // The cores save the story that is open, so saving another one means
      // opening it. Doing that behind a story that is playing swapped the
      // text under the narrator; doing it silently left the screen showing
      // one story while the cores held another.
      if (w.isPlaying) throw new BridgeError('busy', 'Pause the story that is playing before saving another one for offline listening.');
      await this.loadStory({ kind: 'key', key }, { autoplay: false });
    }
    await w.ensureNarrationRuntime?.();
    await w.startCaching('Permanent', key);
  }

  cancelCaching(_key: StoryKey) {
    w._stopCaching?.();
  }

  /* ----------------------------------------------------------- library */

  library: LibraryApi = {
    list: async () => (w.userProfile?.library || []).map((s: any) => this.toEntry(s)),
    add: async (ref, summary) => {
      if (ref.kind === 'file') {
        const imported = await this.importFile(ref.file);
        return this.toEntry(this.libraryStory(imported.key));
      }
      const target = ref.kind === 'key' ? ref.key : ref.url;
      const existing = this.libraryStory(target) || this.libraryStoryByUrl(target);
      if (existing) return this.toEntry(existing);
      const url = ref.kind === 'url' ? ref.url : summary?.url;
      if (summary && url) {
        // What the row already shows is enough for a library entry. Nothing is
        // fetched and nothing is opened; the text is fetched on first open.
        w.addToLibrary({
          title: summary.title, author: summary.author, url, synopsis: summary.synopsis || '',
          words: summary.words ? summary.words.toLocaleString() : '-', totalChapters: summary.chapterCount || 0,
          fandoms: summary.fandoms || [], tags: summary.tags || [],
        });
        const added = this.libraryStoryByUrl(url);
        if (!added) throw new BridgeError('not-found', 'That story could not be added.');
        // The row said the work was finished; the entry was created "ongoing".
        if (summary.complete === true && summary.chapterCount) {
          added.workComplete = true;
          added.declaredChapters = summary.chapterCount;
          save();
        }
        this.scheduleLibrary();
        this.notice('success', `Added “${added.title}” to your library`, 'holding');
        return this.toEntry(added);
      }
      // No details to go on: the story has to be fetched. The cores make a
      // fetched story the open one, so put back what was open before.
      if (w.isPlaying) throw new BridgeError('busy', 'Pause the story that is playing, then add this one.');
      const before = { story: w.currentStory, chapter: w.currentChapterIndex, paragraph: w.currentParagraphIndex };
      try {
        await w.loadStory(target, { preventNavigate: true });
      } finally {
        var fetched = w.currentStory !== before.story ? w.currentStory : null;
        w.currentStory = before.story;
        w.currentChapterIndex = before.chapter;
        w.currentParagraphIndex = before.paragraph;
      }
      const added = fetched ? this.libraryStory(keyOf(fetched)) || fetched : null;
      if (!added) throw new BridgeError('not-found', 'That story could not be added.');
      this.scheduleLibrary();
      return this.toEntry(added);
    },
    remove: async (key) => {
      const open = w.currentStory && keyOf(w.currentStory) === key;
      if (open) {
        // It used to keep narrating, and stay on screen, after it had left
        // the library.
        if (w.BufferManager?.isActive) w._stopCaching?.();
        w.cancelNarrationRunway?.();
        w.releaseAudioSession?.();
        w.isPlaying = false;
        w.currentStory = null;
        w.currentChapterIndex = 0;
        w.currentParagraphIndex = 0;
      }
      w.removeStory(key, { confirm: false });
      if (open) {
        this.state = 'idle';
        this.emit('playstate', { state: 'idle' });
        this.emit('story-closed', { storyKey: key });
        this.emit('runway', this.getRunway());
      }
      void syncPushProfile();
      this.scheduleLibrary();
    },
    setFavourite: async (key, favourite) => {
      const s = this.libraryStory(key);
      if (s && !!(s.favorite || s.isFavorite) !== favourite) w.toggleFavorite(key);
      this.scheduleLibrary();
    },
    rate: async (key, stars) => {
      w.rateStory(key, stars);
      this.scheduleLibrary();
    },
    setSubscribed: async (key, subscribed) => {
      const s = this.libraryStory(key);
      if (s && !!s.updateSubscribed !== subscribed) await w.toggleStorySubscription(key);
      void syncPushProfile();
      this.scheduleLibrary();
    },
    checkForUpdates: async (key) => {
      const targets = (w.userProfile?.library || []).filter((s: any) => (key ? keyOf(s) === key : s.updateSubscribed));
      const changed: StoryKey[] = [];
      for (const s of targets) {
        const before = Number(s.publishedChapters || s.totalChapters || 0);
        try { await w.checkStoryUpdate(keyOf(s), s.url, null, { silent: true }); } catch { /* one failure must not stop the rest */ }
        const after = this.libraryStory(keyOf(s));
        const now = Number(after?.publishedChapters || after?.totalChapters || 0);
        if (after && now > before) {
          changed.push(keyOf(s));
          // The check adds the chapters straight away, so nothing else
          // recorded that there was news: the badge, the "New" pill and
          // Home's list read a flag that nothing ever set.
          const open = w.currentStory && keyOf(w.currentStory) === keyOf(s);
          if (!open) {
            after.newChaptersAvailable = true;
            after.newChapterCount = (Number(after.newChapterCount) || 0) + (now - before);
          }
        }
      }
      if (changed.length) { save(); void syncPushProfile(); }
      this.scheduleLibrary();
      return changed;
    },
    removeBookmark: async (key, bookmarkId) => {
      const s = this.libraryStory(key);
      const bm = (s?.bookmarks || []).find((b: any) => String(b.id || `b_${b.c}_${b.p}_${b.ts}`) === bookmarkId);
      if (bm) w.deleteBookmark(key, bm.c, bm.p);
      this.scheduleLibrary();
    },
  };

  // Paragraph-level progress needs each chapter's paragraph count, which only
  // the story text has (in IndexedDB, not the library entry). Recorded on the
  // entry whenever a story is opened: a small array, saved with the profile.
  private rememberParagraphCounts(story: any) {
    const counts = (Array.isArray(story?.chapters) ? story.chapters : []).map((c: any) => (Array.isArray(c?.paragraphs) ? c.paragraphs.length : 0));
    if (!counts.length) return;
    const entry = this.libraryStory(keyOf(story));
    if (!entry || JSON.stringify(entry.paragraphCounts) === JSON.stringify(counts)) return;
    entry.paragraphCounts = counts;
    save();
  }

  private progressOf(s: any, chapter: number, paragraph: number, chapterCount: number): number {
    if (s.isFinished) return 1;
    const counts: number[] = Array.isArray(s.paragraphCounts) ? s.paragraphCounts : [];
    if (counts.length) {
      const total = counts.reduce((n, c) => n + c, 0);
      const before = counts.slice(0, chapter).reduce((n, c) => n + c, 0) + paragraph;
      return total ? Math.min(1, before / total) : 0;
    }
    // Never opened in v2: chapters only, nudged above zero once started.
    const started = chapter > 0 || paragraph > 0;
    return Math.min(1, chapter / Math.max(1, chapterCount) + (started ? 0.01 : 0));
  }

  private toEntry(s: any): LibraryEntry {
    const summary = toSummary(s);
    const chapter = Number(s.progressChapter) || 0;
    const paragraph = Number(s.progressParagraph) || 0;
    const job = w.BufferManager;
    const jobActive = job?.isActive && w.currentStory && keyOf(w.currentStory) === summary.key;
    const cache: LibraryEntry['cache'] = jobActive
      ? { state: 'caching', done: Number(job.cachedCount) || 0, total: Number(job.totalToCache) || 0 }
      : (s.audioCached || s.isCached)
        ? { state: 'complete', done: 1, total: 1 }
        : { state: 'none', done: 0, total: 0 };
    return {
      story: summary,
      addedAt: Number(s.addedAt) || 0,
      lastOpenedAt: Number(s.lastRead) || undefined,
      position: { chapter, paragraph },
      progress: this.progressOf(s, chapter, paragraph, summary.chapterCount),
      finished: s.isFinished === true,
      favourite: !!(s.favorite || s.isFavorite),
      rating: Math.max(0, Math.min(5, Number(s.userRating) || 0)),
      cache,
      hasUpdate: s.hasUpdate === true || s.newChaptersAvailable === true,
      subscribed: s.updateSubscribed === true,
      bookmarks: toBookmarks(s),
    };
  }

  /* ---------------------------------------------------------- settings */

  private settingsNow(): Settings {
    const s = settingsBag();
    const v2 = uiBag();
    const override = localStorage.getItem(ENGINE_OVERRIDE_KEY);
    const engine: EngineId = override === 'kokoro' || override === 'pocket' ? override : activeEngine();
    return {
      engine,
      voice: {
        pocket: (VOICES.find((v) => v.engine === 'pocket' && v.id === w.canonicalPocketVoice?.(s.pocketVoice))?.id || 'paul') as Settings['voice']['pocket'],
        kokoro: (VOICES.find((v) => v.engine === 'kokoro' && v.id === s.kokoroVoice)?.id || 'af_heart') as Settings['voice']['kokoro'],
      },
      speed: Number(s.speed) || 1,
      expressive: s.expressiveProsody !== false,
      pronunciations: (Array.isArray(s.pronunciationOverrides) ? s.pronunciationOverrides : []).map((p: any, i: number) => ({
        id: String(p.id || `p${i}`), term: String(p.term || ''), soundsLike: String(p.soundsLike || p.replacement || ''), enabled: p.enabled !== false,
      })),
      theme: s.theme === 'light' || s.theme === 'dark' ? s.theme : 'system',
      readerFont: v2.readerFont === 'sans' ? 'sans' : 'serif',
      readerSize: Number(v2.readerSize || s.readerFontSize) || 19,
      readerLineHeight: Number(s.readerLineHeight) || 1.6,
      defaultMode: v2.defaultMode === 'read' ? 'read' : 'listen',
      // Whether this device is really subscribed, in the field the old app
      // used, so an existing subscriber sees it on and can turn it off.
      updateNotifications: s.pushUpdates === true,
      companion: s.companionFrequency === 'quiet' && v2.companionHidden ? 'none' : (v2.companion === 'none' ? 'none' : 'virtue'),
      companionChatter: s.companionFrequency === 'quiet' ? 'quiet' : 'normal',
      layout: v2.layout === 'phone' ? 'phone' : 'auto',
      onboarded: localStorage.getItem(SETUP_COMPLETE_KEY) === 'true',
    };
  }

  async getSettings(): Promise<Settings> {
    return this.settingsNow();
  }

  async setSettings(patch: Partial<Settings>): Promise<Settings> {
    const s = settingsBag();
    const v2 = uiBag();
    // First, and before any await: turning alerts on shows the browser's
    // permission prompt, which is only allowed straight from the tap.
    if (patch.updateNotifications !== undefined && patch.updateNotifications !== (s.pushUpdates === true)) {
      const change = patch.updateNotifications ? enablePush() : disablePush();
      try {
        await change;
        s.pushUpdates = patch.updateNotifications;
        this.notice('success', patch.updateNotifications ? 'Alerts are on. You will hear about new chapters in stories you follow.' : 'Alerts are off.', 'wink');
      } catch (error) {
        s.pushUpdates = false;
        save();
        this.emit('settings', this.settingsNow());
        throw new BridgeError('blocked', error instanceof PushError ? error.message : 'Alerts could not be turned on. Check your connection and try again.');
      }
    }
    if (patch.engine && patch.engine !== this.settingsNow().engine) await this.setEngine(patch.engine);
    if (patch.voice) {
      const current = this.settingsNow();
      for (const engine of ['pocket', 'kokoro'] as const) {
        const next = patch.voice[engine];
        if (next && next !== current.voice[engine]) {
          if (engine === activeEngine()) await this.setVoice(next);
          else if (engine === 'pocket') s.pocketVoice = next; else s.kokoroVoice = next;
        }
      }
    }
    if (patch.speed !== undefined) this.setSpeed(patch.speed);
    if (patch.expressive !== undefined) {
      s.expressiveProsody = patch.expressive;
      w.setPocketExpressiveProsodyChoice?.(patch.expressive);
    }
    if (patch.pronunciations) {
      s.pronunciationOverrides = patch.pronunciations.map((p) => ({ id: p.id, term: p.term, soundsLike: p.soundsLike, enabled: p.enabled }));
    }
    if (patch.theme) s.theme = patch.theme;
    if (patch.readerFont) v2.readerFont = patch.readerFont;
    if (patch.readerSize !== undefined) { v2.readerSize = patch.readerSize; s.readerFontSize = patch.readerSize; }
    if (patch.readerLineHeight !== undefined) s.readerLineHeight = patch.readerLineHeight;
    if (patch.defaultMode) v2.defaultMode = patch.defaultMode;
    if (patch.companion) v2.companion = patch.companion;
    if (patch.layout) v2.layout = patch.layout;
    if (patch.companionChatter) s.companionFrequency = patch.companionChatter === 'quiet' ? 'quiet' : 'contextual';
    if (patch.onboarded !== undefined) {
      try { localStorage.setItem(SETUP_COMPLETE_KEY, patch.onboarded ? 'true' : 'false'); } catch { /* storage blocked */ }
    }
    save();
    const next = this.settingsNow();
    this.emit('settings', next);
    return next;
  }

  /* --------------------------------------------------------- discovery */

  async search(query: Ao3Query): Promise<Page<Ao3Result>> {
    const filters = {
      fandom: query.fandom,
      rating: query.rating && query.rating !== 'Any' ? query.rating : 'Any',
      complete: query.completeOnly === true,
      wordsMin: query.wordsMin,
      wordsMax: query.wordsMax,
      language: query.language,
      sort: query.sort,
    };
    const payload = this.api.buildAo3SearchPayload(query.query || '', filters, { page: query.page || 1 });
    if (this.api.isEmptyAo3Search(payload)) return { items: [], page: 1, hasMore: false };
    const outcome = await this.api.searchAo3(payload);
    if (!outcome.ok) throw new BridgeError(outcome.timedOut ? 'network' : 'blocked', outcome.reason);
    const results = Array.isArray(outcome.data.results) ? outcome.data.results : [];
    return {
      items: results.map((r: any) => ({
        key: String(r.url || r.title),
        title: String(r.title || 'Untitled'),
        author: String(r.author || 'Unknown'),
        source: 'ao3' as const,
        url: String(r.url || ''),
        synopsis: r.summary || undefined,
        fandoms: Array.isArray(r.fandoms) ? r.fandoms : undefined,
        tags: Array.isArray(r.tags) ? r.tags : undefined,
        rating: RATINGS.has(r.rating) ? r.rating : undefined,
        words: parseWords(r.words),
        chapterCount: parseWords(String(r.chapters || '').split('/')[0]) || 0,
        complete: /^(\d+)\/\1$/.test(String(r.chapters || '')) || undefined,
        updated: r.updated || undefined,
        kudos: parseWords(r.kudos),
      })),
      page: Number(outcome.data.page) || query.page || 1,
      hasMore: !!outcome.data.has_more,
      total: Number(outcome.data.total) || undefined,
    };
  }

  catalog: CatalogApi = {
    facets: async () => this.catalogFacets(await this.catalogRecords()),
    query: async (q: CatalogQuery) => {
      const records = await this.catalogRecords();
      const text = String(q.search || '').toLowerCase().trim();
      const lengthOk = (words: number) => {
        switch (q.length) {
          case 'under-10k': return words < 10_000;
          case '10k-50k': return words >= 10_000 && words < 50_000;
          case '50k-100k': return words >= 50_000 && words < 100_000;
          case '100k-250k': return words >= 100_000 && words < 250_000;
          case '250k-plus': return words >= 250_000;
          default: return true;
        }
      };
      let rows = records.map((r) => this.toCatalogEntry(r)).filter((e) => {
        if (text && !`${e.title} ${e.author} ${(e.tags || []).join(' ')}`.toLowerCase().includes(text)) return false;
        if (q.world?.length && !q.world.some((x) => e.world.includes(x))) return false;
        if (q.species?.length && !q.species.some((x) => e.species.includes(x))) return false;
        if (q.rating?.length && (!e.rating || !q.rating.includes(e.rating))) return false;
        if (q.status?.length && !q.status.includes(e.status)) return false;
        return lengthOk(e.words || 0);
      });
      const by = q.sort || 'updated-desc';
      rows = rows.sort((a, b) => {
        if (by === 'title-asc') return a.title.localeCompare(b.title);
        if (by === 'author-asc') return a.author.localeCompare(b.author);
        if (by === 'words-desc') return (b.words || 0) - (a.words || 0);
        if (by === 'rating-desc') return (b.communityRating || 0) - (a.communityRating || 0);
        return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
      });
      const page = Math.max(1, q.page || 1);
      const items = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
      return { items, page, hasMore: page * PAGE_SIZE < rows.length, total: rows.length };
    },
  };

  private async catalogRecords(): Promise<any[]> {
    await w.ensureHmofaMasterlistLoaded?.();
    return Array.isArray(w._hmofaState?.records) ? w._hmofaState.records : [];
  }

  private toCatalogEntry(r: any): CatalogEntry {
    const source = (r.sources || []).find((s: any) => s?.url) || {};
    const words = parseWords(r.words ?? r.wordCount);
    const status = ['Ongoing', 'Complete', 'Hiatus', 'Abandoned'].includes(r.status) ? r.status : 'Unknown';
    const romance = ['Gen', 'M/F', 'Poly'].includes(r.romance || r.romanceType) ? (r.romance || r.romanceType) : 'Other';
    const ratings = w._hmofaState?.communityRatings || {};
    return {
      key: String(source.url || `hmofa:${r.id}`),
      id: String(r.id),
      title: String(r.title),
      author: (r.authors || []).join(', ') || 'Unknown',
      source: 'hmofa',
      url: source.url || undefined,
      synopsis: r.summary || r.synopsis || undefined,
      tags: Array.isArray(r.tags) ? r.tags : undefined,
      rating: RATINGS.has(r.rating) ? r.rating : r.rating === 'Unrated' ? 'Not Rated' : undefined,
      words,
      chapterCount: Number(r.chapters || r.chapterCount) || 0,
      complete: status === 'Complete' || undefined,
      world: (r.worlds || []).filter((x: string) => ['HMOFA', 'ADHG', 'Anthrostate'].includes(x)),
      species: this.catalogCore.speciesFacetValues ? [...this.catalogCore.speciesFacetValues(r)] : (r.partnerSpecies || []),
      status,
      romance,
      platforms: (r.sources || []).map((s: any) => s?.platform).filter(Boolean),
      updatedAt: r.updated || r.lastUpdated || undefined,
      communityRating: Number(ratings[r.id]?.average) || undefined,
    };
  }

  private catalogFacets(records: any[]): CatalogFacet[] {
    const entries = records.map((r) => this.toCatalogEntry(r));
    const count = (values: string[]) => {
      const m = new Map<string, number>();
      values.forEach((v) => m.set(v, (m.get(v) || 0) + 1));
      return [...m].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, count: n }));
    };
    return [
      { key: 'world', label: 'World', values: count(entries.flatMap((e) => e.world)) },
      { key: 'species', label: 'Species', values: count(entries.flatMap((e) => e.species)).slice(0, 40) },
      { key: 'rating', label: 'Rating', values: count(entries.map((e) => e.rating || 'Not Rated')) },
      { key: 'status', label: 'Status', values: count(entries.map((e) => e.status)) },
    ];
  }

  /* -------------------------------------------------------------- data */

  async exportBackup(): Promise<BackupResult> {
    const transfer = await importCore<{ exportPocketReaderData: AnyFn }>('data_transfer.js');
    const { blob } = await transfer.exportPocketReaderData({ includeAudio: false });
    const library = w.userProfile?.library || [];
    const date = new Date().toISOString().slice(0, 10);
    return {
      blob,
      filename: `pocket-reader-${date}.prbackup`,
      stories: library.length,
      bookmarks: library.reduce((n: number, s: any) => n + toBookmarks(s).length, 0),
    };
  }

  async importBackup(file: File): Promise<RestoreResult> {
    const transfer = await importCore<{ importPocketReaderData: AnyFn }>('data_transfer.js');
    try {
      await transfer.importPocketReaderData(file);
    } catch (error: any) {
      throw new BridgeError('unsupported-file', error?.message || 'That backup could not be restored.');
    }
    await w.loadLocalData?.();
    const library = w.userProfile?.library || [];
    this.scheduleLibrary();
    this.emit('settings', this.settingsNow());
    return {
      stories: library.length,
      bookmarks: library.reduce((n: number, s: any) => n + toBookmarks(s).length, 0),
      settingsRestored: true,
    };
  }

  async getStorageUsage(): Promise<StorageUsage> {
    const estimate = await navigator.storage?.estimate?.().catch(() => null);
    let voiceModelsBytes = 0;
    try {
      for (const name of await caches.keys()) {
        if (!/onnx|pocket-voices|kokoro|model/i.test(name)) continue;
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          const length = Number(response?.headers.get('content-length')) || 0;
          voiceModelsBytes += length;
        }
      }
    } catch { /* Cache Storage unavailable */ }
    const total = Number(estimate?.usage) || 0;
    // Counted, not inferred. "Everything that is not a model" put the app's
    // own files and the browser's bookkeeping under saved narration, so it
    // read 38 MB with nothing saved.
    let audioCacheBytes = -1;
    try {
      const perStory: any[] = await w.getOfflineStoryUsage?.();
      if (Array.isArray(perStory)) audioCacheBytes = perStory.reduce((n, s) => n + (Number(s?.bytes) || 0), 0);
    } catch { /* fall back to the estimate */ }
    return {
      voiceModelsBytes,
      audioCacheBytes: audioCacheBytes >= 0 ? audioCacheBytes : Math.max(0, total - voiceModelsBytes),
      storiesBytes: new Blob([localStorage.getItem('pocketReaderData') || '']).size,
      quotaBytes: Number(estimate?.quota) || undefined,
    };
  }

  async clearAudioCache() {
    // Everything, including stories saved for offline: that is what the button
    // says. Passing false kept those, and left their "saved" marks standing
    // over narration that had been deleted.
    if (w.BufferManager?.isActive || w.BufferManager?.paused) w._stopCaching?.();
    await w.clearAudioCache?.(true, true);
    w._discardParagraphPreload?.();
    w.cancelNarrationRunway?.();
    this.emit('runway', this.getRunway());
    this.scheduleLibrary();
  }

  async clearVoiceModels() {
    if (w.isPlaying) this.pause();
    for (const name of await caches.keys()) {
      if (/onnx|pocket-voices|kokoro|model/i.test(name)) await caches.delete(name);
    }
    this.updateEngine({ status: 'idle' });
  }

  /* ------------------------------------------------------------ extras */

  async listAchievements(): Promise<Achievement[]> {
    const db: any[] = Array.isArray(w.ACHIEVEMENTS_DB) ? w.ACHIEVEMENTS_DB : [];
    const profile = w.userProfile || {};
    const unlocked = new Map((profile.achievements || []).map((a: any) => [typeof a === 'string' ? a : a.id, a]));
    const stats = profile.stats || this.libCore.aggregateStats?.(this.libCore.normalizeProfileV3?.(profile) || profile) || {};
    return db.map((a) => {
      const tiers: any[] = Array.isArray(a.tiers) ? a.tiers : [];
      // A tiered achievement is stored once per tier, as `<id>_t<index>`; the
      // bare id never exists for one, so it always looked locked.
      const got: any = unlocked.get(a.id)
        ?? tiers.map((_t, index) => unlocked.get(`${a.id}_t${index}`)).filter(Boolean).pop();
      const value = Number(stats[a.metric]) || 0;
      const reached = tiers.filter((t) => value >= t.v).pop();
      const next = tiers.find((t) => value < t.v);
      return {
        id: a.id,
        title: a.title,
        description: a.desc,
        icon: `ach_${a.id}`,
        unlockedAt: got ? Number(got.unlockedAt) || 1 : undefined,
        tier: reached?.t,
        progress: next
          ? { value, target: next.v, ...(a.metric === 'hoursListened' ? { unit: 'hours' as const } : {}) }
          : a.target ? { value: Math.min(value, a.target), target: a.target } : undefined,
      };
    });
  }

  async getStats(): Promise<ListeningStats> {
    const profile = w.userProfile || {};
    const stats = this.libCore.aggregateStats?.(this.libCore.normalizeProfileV3?.(profile) || profile) || profile.stats || {};
    const daily = profile.dailyStatsByDevice || {};
    const weekAgo = Date.now() - 7 * 86_400_000;
    let words = 0;
    for (const days of Object.values<any>(daily)) {
      for (const [day, counters] of Object.entries<any>(days || {})) {
        if (new Date(`${day}T12:00:00`).getTime() >= weekAgo) words += Number(counters?.totalWords) || 0;
      }
    }
    return {
      streakDays: Number(stats.streak) || 0,
      minutesThisWeek: Math.round(words / 150),
      storiesFinished: Number(stats.finishedStories) || 0,
    };
  }

  async getDiagnostics(): Promise<Diagnostics> {
    const runtime = w.getPocketTtsRuntimeConfig?.() || {};
    // The cores keep their log in `buffer`, stamped `timestamp`. This read two
    // names that do not exist, so the log shown (and copied) was always empty.
    const logs: any[] = (Array.isArray(w.Diagnostics?.buffer) ? w.Diagnostics.buffer : []).slice(-60);
    const controller = navigator.serviceWorker?.controller;
    return {
      appVersion: 'v2',
      coreVersion: String(runtime.modelRevision || ''),
      serviceWorker: controller ? new URL(controller.scriptURL).search || 'active' : 'none',
      device: navigator.userAgent,
      memoryHeadroomMb: Number(w._pocketDeviceSetup?.memoryHeadroomMb || w._pocketDeviceSetup?.memory?.headroomMb) || undefined,
      engine: this.getEngineState(),
      threads: Number(runtime.wasmThreadCount) || 1,
      crossOriginIsolated: window.crossOriginIsolated === true,
      lockSessions: Array.isArray(w.getLockScreenReport?.()) ? w.getLockScreenReport() : [],
      recentLog: logs.map((l: any) => ({
        at: Date.parse(l.timestamp) || Number(l.at || l.ts || l.time) || Date.now(),
        level: /err/i.test(l.level) ? 'error' : /warn/i.test(l.level) ? 'warn' : 'info',
        message: String(l.message || l.msg || ''),
      })),
    };
  }

  runNoticeAction(noticeId: string) {
    // Only the post-reload "Start narration" notice carries an action.
    if (noticeId === this.gestureNoticeId) this.continueGesture();
  }
}

/** Load the cores, then build and attach the bridge. */
export async function createRealBridge(onStep?: (file: string) => void): Promise<RealBridge> {
  await bootCores(onStep);
  const bridge = new RealBridge();
  await bridge.attach();
  return bridge;
}
