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

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyFn = (...args: any[]) => any;
const w = window as unknown as Record<string, any>;

const ENGINE_OVERRIDE_KEY = 'pr_narration_engine_override_v1';
const SETUP_COMPLETE_KEY = 'pr_setup_complete';
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
    title: String(c?.title || `Chapter ${i + 1}`),
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

/* ------------------------------------------------------------- class */

type Handler = (payload: never) => void;

export class RealBridge implements CoreBridge {
  private handlers = new Map<BridgeEventName, Set<Handler>>();
  private state: PlayState = 'idle';
  private engine: EngineState = { engine: 'pocket', status: 'idle' };
  private sleep: SleepTimer = { kind: 'off' };
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepChapter: number | null = null;
  private lastCompanionBeat: string | undefined;
  private libraryTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeSeq = 0;
  private lastEngineEmit = 0;
  private engineTrailing: ReturnType<typeof setTimeout> | null = null;
  private api: Record<string, AnyFn> = {};
  private catalogCore: Record<string, any> = {};
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

    on(E.PARAGRAPH, () => this.onParagraph());
    on(E.PLAYSTATE, (d: any) => this.setState(d.playing ? 'playing' : this.state === 'ended' ? 'ended' : 'paused'));
    on(E.PLAY_LOADING, (d: any) => {
      if (d.loading) this.setState(this.engine.status === 'ready' ? 'buffering' : 'loading');
      else if (this.state === 'loading' || this.state === 'buffering') this.setState(w.isPlaying ? 'playing' : 'paused');
    });
    on(E.STORY_OPENED, (d: any) => {
      if (!d.story) return;
      this.rememberParagraphCounts(d.story);
      this.emit('story-loaded', { story: toStory(d.story), position: position() });
      this.onParagraph();
      this.scheduleLibrary();
    });
    on(E.LIBRARY, () => this.scheduleLibrary());
    on(E.NOTICE, (d: any) => this.notice(d.tone === 'error' ? 'error' : 'info', d.message || d.title, undefined, d.actionLabel));
    on(E.COMPANION, (d: any) => {
      if (d.beat) this.lastCompanionBeat = d.beat;
      if (d.speech) this.notice('info', d.speech, moodFor(d.beat || this.lastCompanionBeat));
    });
    on(E.DIALOG, (d: any) => this.notice('info', [d.title, stripHtml(d.bodyHtml)].filter(Boolean).join(': ')));
    on(E.ENGINE, (d: any) => {
      if (d.what === 'state') {
        const status = d.state === 'ready' ? 'ready' : d.state === 'loading' ? 'loading' : d.state === 'failed' ? 'error' : 'idle';
        this.updateEngine({ status, stage: status === 'loading' ? 'download' : undefined });
      } else {
        this.updateEngine({});
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

    this.engine = { engine: activeEngine(), status: this.engineStatusNow() };
    if (w.currentStory) this.state = w.isPlaying ? 'playing' : 'paused';
  }

  /* ------------------------------------------------------------ events */

  on<E extends BridgeEventName>(event: E, handler: (payload: BridgeEvents[E]) => void) {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler as Handler);
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

  private notice(level: Notice['level'], message: string, mood?: VirtueMood, actionLabel?: string) {
    if (!message) return;
    this.emit('notice', { id: `n${++this.noticeSeq}`, level, message: String(message), mood, actionLabel });
  }

  private onParagraph() {
    const story = w.currentStory;
    if (!story) return;
    const pos = position();
    const chapters = Array.isArray(story.chapters) ? story.chapters : [];
    this.emit('paragraph', {
      storyKey: keyOf(story),
      position: pos,
      paragraphCount: chapters[pos.chapter]?.paragraphs?.length ?? 0,
      chapterCount: chapters.length,
    });
    if (this.sleep.kind === 'end-of-chapter' && this.sleepChapter !== null && pos.chapter !== this.sleepChapter) {
      this.pause();
      this.sleep = { kind: 'off' };
      this.sleepChapter = null;
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

  getEngineState(): EngineState {
    return { ...this.engine, engine: activeEngine(), status: this.engineStatusNow() };
  }

  /* ----------------------------------------------------------- stories */

  async loadStory(ref: StoryRef, options: LoadOptions = {}): Promise<Story> {
    if (ref.kind === 'file') {
      const summary = await this.importFile(ref.file);
      return this.loadStory({ kind: 'key', key: summary.key }, options);
    }
    const target = ref.kind === 'key' ? this.libraryStory(ref.key)?.url || ref.key : ref.url;
    if (!target) throw new BridgeError('not-found', 'That story could not be found.');
    if (w.isPlaying) w.pausePlayback?.();
    try {
      await w.loadStory(target, { preventNavigate: options.background === true });
    } catch (error: any) {
      throw new BridgeError('network', error?.message || 'The story could not be opened.');
    }
    const story = w.currentStory;
    if (!story || !Array.isArray(story.chapters) || !story.chapters.length) {
      throw new BridgeError('not-found', 'The story text could not be loaded.');
    }
    if (options.position) await this.seekToParagraph(options.position.paragraph, options.position.chapter);
    this.setState('paused');
    if (options.autoplay) void this.play();
    return toStory(story);
  }

  async importFile(file: File): Promise<StorySummary> {
    if (!/\.(epub|pdf|txt|html?|docx|md|rtf)$/i.test(file.name)) {
      throw new BridgeError('unsupported-file', 'That file type is not supported. Try EPUB, PDF, TXT, HTML or DOCX.');
    }
    const before = new Set((w.userProfile?.library || []).map(keyOf));
    try {
      await w.processUploadedFile(file, null, { silent: true });
    } catch (error: any) {
      throw new BridgeError('unsupported-file', error?.message || 'That file could not be read.');
    }
    const library = w.userProfile?.library || [];
    const added = library.find((s: any) => !before.has(keyOf(s))) || w.currentStory;
    if (!added) throw new BridgeError('unsupported-file', 'Nothing readable was found in that file.');
    this.scheduleLibrary();
    this.notice('success', `Imported “${added.title}”`, 'holding');
    return toSummary(added);
  }

  private libraryStory(key: StoryKey): any {
    return w.findLibraryStoryByRef?.(key) || (w.userProfile?.library || []).find((s: any) => keyOf(s) === key);
  }

  /* --------------------------------------------------------- transport */

  async play() {
    if (!w.currentStory) throw new BridgeError('not-found', 'Choose a story first.');
    if (w.isPlaying) return;
    this.setState(this.engineStatusNow() === 'ready' ? 'buffering' : 'loading');
    // Called synchronously inside the tap so iOS keeps the user gesture that
    // unlocks audio; the deferred stub returns a promise for the rest.
    await w.togglePlayState();
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
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    this.sleepChapter = null;
    if (timer.kind === 'minutes') {
      const endsAt = Date.now() + timer.minutes * 60_000;
      this.sleep = { kind: 'minutes', minutes: timer.minutes, endsAt };
      this.sleepTimer = setTimeout(() => {
        this.pause();
        this.sleep = { kind: 'off' };
        this.emit('sleep', { ...this.sleep });
        this.notice('info', 'Sleep timer ended. Sweet dreams.', 'kneeling');
      }, timer.minutes * 60_000);
    } else if (timer.kind === 'end-of-chapter') {
      this.sleep = { kind: 'end-of-chapter' };
      this.sleepChapter = position().chapter;
    } else {
      this.sleep = { kind: 'off' };
    }
    this.emit('sleep', { ...this.sleep });
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
    this.pause();
    await w.ensureNarrationRuntime?.();
    await w.switchReaderVoiceEngine(engine, true);
    this.updateEngine({ status: this.engineStatusNow() });
    this.emit('settings', this.settingsNow());
    if (wasPlaying) await this.play();
  }

  async setVoice(voice: VoiceId) {
    const v = VOICES.find((x) => x.id === voice);
    if (!v) throw new BridgeError('not-found', 'Unknown voice.');
    if (v.engine !== activeEngine()) await this.setEngine(v.engine);
    const wasPlaying = !!w.isPlaying;
    if (wasPlaying) this.pause();
    await w.ensureNarrationRuntime?.();
    await w.onVoiceSelectionChange(voice, { confirm: false });
    if (v.engine === 'pocket') settingsBag().pocketVoice = voice;
    else settingsBag().kokoroVoice = voice;
    save();
    this.emit('settings', this.settingsNow());
    this.notice('info', `Now reading as ${v.name}`, 'wink');
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
    const blob: Blob | null = await w.generateChunk(sample, voiceId);
    if (!blob) throw new BridgeError('engine-failed', 'The voice sample could not be rendered.');
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
  }

  /* ----------------------------------------------------------- offline */

  async startCaching(key: StoryKey) {
    if (!w.currentStory || keyOf(w.currentStory) !== key) {
      await this.loadStory({ kind: 'key', key }, { background: true });
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
    add: async (ref) => {
      if (ref.kind === 'file') {
        const summary = await this.importFile(ref.file);
        return this.toEntry(this.libraryStory(summary.key));
      }
      const target = ref.kind === 'key' ? ref.key : ref.url;
      const existing = this.libraryStory(ref.kind === 'key' ? ref.key : target);
      if (existing) return this.toEntry(existing);
      await w.loadStory(target, { preventNavigate: true });
      const added = this.libraryStory(keyOf(w.currentStory)) || w.currentStory;
      if (!added) throw new BridgeError('not-found', 'That story could not be added.');
      this.scheduleLibrary();
      return this.toEntry(added);
    },
    remove: async (key) => {
      w.removeStory(key, { confirm: false });
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
      this.scheduleLibrary();
    },
    checkForUpdates: async (key) => {
      const targets = (w.userProfile?.library || []).filter((s: any) => (key ? keyOf(s) === key : s.updateSubscribed));
      const changed: StoryKey[] = [];
      for (const s of targets) {
        const before = Number(s.publishedChapters || s.totalChapters || 0);
        try { await w.checkStoryUpdate(keyOf(s), s.url, null, { silent: true }); } catch { /* one failure must not stop the rest */ }
        const after = this.libraryStory(keyOf(s));
        if (Number(after?.publishedChapters || after?.totalChapters || 0) > before) changed.push(keyOf(s));
      }
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
        pocket: (VOICES.find((v) => v.engine === 'pocket' && v.id === w.canonicalPocketVoice?.(s.pocketVoice))?.id || 'alba') as Settings['voice']['pocket'],
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
      updateNotifications: v2.updateNotifications !== false,
      companion: s.companionFrequency === 'quiet' && v2.companionHidden ? 'none' : (v2.companion === 'none' ? 'none' : 'virtue'),
      companionChatter: s.companionFrequency === 'quiet' ? 'quiet' : 'normal',
      onboarded: localStorage.getItem(SETUP_COMPLETE_KEY) === 'true',
    };
  }

  async getSettings(): Promise<Settings> {
    return this.settingsNow();
  }

  async setSettings(patch: Partial<Settings>): Promise<Settings> {
    const s = settingsBag();
    const v2 = uiBag();
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
    if (patch.updateNotifications !== undefined) v2.updateNotifications = patch.updateNotifications;
    if (patch.companion) v2.companion = patch.companion;
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
    return {
      voiceModelsBytes,
      audioCacheBytes: Math.max(0, total - voiceModelsBytes),
      storiesBytes: new Blob([localStorage.getItem('pocketReaderData') || '']).size,
      quotaBytes: Number(estimate?.quota) || undefined,
    };
  }

  async clearAudioCache() {
    await w.clearAudioCache?.(false, true);
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
      const got: any = unlocked.get(a.id);
      const value = Number(stats[a.metric]) || 0;
      const tiers: any[] = Array.isArray(a.tiers) ? a.tiers : [];
      const reached = tiers.filter((t) => value >= t.v).pop();
      const next = tiers.find((t) => value < t.v);
      return {
        id: a.id,
        title: a.title,
        description: a.desc,
        icon: a.id,
        unlockedAt: got ? Number(got.unlockedAt) || undefined : undefined,
        tier: reached?.t,
        progress: next ? { value, target: next.v } : a.target ? { value: Math.min(value, a.target), target: a.target } : undefined,
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
    const logs: any[] = w.Diagnostics?.getRecent?.(40) || w.Diagnostics?.logs?.slice?.(-40) || [];
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
      recentLog: logs.map((l: any) => ({
        at: Number(l.at || l.ts || l.time) || Date.now(),
        level: /err/i.test(l.level) ? 'error' : /warn/i.test(l.level) ? 'warn' : 'info',
        message: String(l.message || l.msg || ''),
      })),
    };
  }

  runNoticeAction(_noticeId: string) {
    /* The cores' notices carry no action callbacks the UI can replay. */
  }
}

/** Load the cores, then build and attach the bridge. */
export async function createRealBridge(onStep?: (file: string) => void): Promise<RealBridge> {
  await bootCores(onStep);
  const bridge = new RealBridge();
  await bridge.attach();
  return bridge;
}
