/**
 * MockBridge: a CoreBridge with fake data and simulated playback, so the UI can
 * be designed and tested without the narration cores. Timings are compressed
 * (a paragraph lasts ~3 s at 1x) so state changes are easy to see.
 */
import {
  BridgeError,
  VOICES,
  type Ao3Query,
  type Ao3Result,
  type BridgeEventName,
  type BridgeEvents,
  type CatalogEntry,
  type CatalogQuery,
  type CoreBridge,
  type EngineId,
  type EngineState,
  type LibraryEntry,
  type Page,
  type PlaybackSnapshot,
  type PlayState,
  type Position,
  type RunwayState,
  type Settings,
  type SleepTimer,
  type Story,
  type StoryKey,
  type StoryRef,
  type StorySummary,
  type VoiceId,
} from './bridge';
import { ACHIEVEMENTS, ao3Results, buildLibrary, buildStories, catalogEntries, catalogFacets } from './mockData';

export interface MockOptions {
  /** Pretend the reader has already been through onboarding. Default true. */
  onboarded?: boolean;
  /** Open this story at startup (as if resumed). Default: most recent. Null for none. */
  resumeKey?: StoryKey | null;
  /** Engine starts already warm. Default true. */
  engineReady?: boolean;
  /** Milliseconds per paragraph at 1x. */
  paragraphMs?: number;
  /** Scale all artificial latency (tests use 0). */
  latency?: number;
  /** Start with an empty library (first-run look). */
  empty?: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  engine: 'pocket',
  voice: { pocket: 'paul', kokoro: 'af_heart' },
  speed: 1,
  expressive: true,
  pronunciations: [
    { id: 'p1', term: 'Marrow', soundsLike: 'MAIR-oh', enabled: true },
    { id: 'p2', term: 'HMOFA', soundsLike: 'aitch moffa', enabled: true },
  ],
  theme: 'system',
  readerFont: 'serif',
  readerSize: 19,
  readerLineHeight: 1.6,
  defaultMode: 'listen',
  updateNotifications: true,
  companion: 'virtue',
  companionChatter: 'normal',
  layout: 'auto',
  onboarded: true,
};

type Handler = (payload: never) => void;

export class MockBridge implements CoreBridge {
  private handlers = new Map<BridgeEventName, Set<Handler>>();
  private stories = buildStories();
  private entries: LibraryEntry[] = buildLibrary();
  private catalogData = catalogEntries();
  private settings: Settings;
  private current: Story | null = null;
  private state: PlayState = 'idle';
  private position: Position = { chapter: 0, paragraph: 0 };
  private sleep: SleepTimer = { kind: 'off' };
  private engine: EngineState;
  private tick: ReturnType<typeof setTimeout> | null = null;
  private sleepTick: ReturnType<typeof setTimeout> | null = null;
  private cacheJobs = new Map<StoryKey, ReturnType<typeof setInterval>>();
  private opts: Required<MockOptions>;

  constructor(options: MockOptions = {}) {
    this.opts = {
      onboarded: options.onboarded ?? true,
      resumeKey: options.resumeKey === undefined ? 'mock-ferry-house' : options.resumeKey,
      engineReady: options.engineReady ?? true,
      paragraphMs: options.paragraphMs ?? 3200,
      latency: options.latency ?? 1,
      empty: options.empty ?? false,
    };
    if (this.opts.empty) {
      this.entries = [];
      this.opts.resumeKey = null;
    }
    this.settings = { ...DEFAULT_SETTINGS, onboarded: this.opts.onboarded };
    this.engine = {
      engine: this.settings.engine,
      status: this.opts.engineReady ? 'ready' : 'idle',
      backend: 'webgpu',
    };
    if (this.opts.resumeKey) {
      const story = this.stories.get(this.opts.resumeKey);
      const entry = this.entry(this.opts.resumeKey);
      if (story && entry) {
        this.current = story;
        this.position = { ...entry.position };
        this.state = 'paused';
      }
    }
  }

  /* ------------------------------------------------------------ events */

  on<E extends BridgeEventName>(event: E, handler: (payload: BridgeEvents[E]) => void) {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler as Handler);
    return () => set!.delete(handler as Handler);
  }

  private emit<E extends BridgeEventName>(event: E, payload: BridgeEvents[E]) {
    this.handlers.get(event)?.forEach((h) => (h as (p: BridgeEvents[E]) => void)(structuredClone(payload)));
  }

  private wait(ms: number) {
    const t = ms * this.opts.latency;
    return t > 0 ? new Promise<void>((r) => setTimeout(r, t)) : Promise.resolve();
  }

  /* -------------------------------------------------------- snapshot */

  getPlayback(): PlaybackSnapshot {
    const ch = this.current?.chapters[this.position.chapter];
    return {
      storyKey: this.current?.key ?? null,
      state: this.state,
      position: { ...this.position },
      paragraphCount: ch?.paragraphs.length ?? 0,
      chapterCount: this.current?.chapters.length ?? 0,
      speed: this.settings.speed,
      engine: this.settings.engine,
      voice: this.settings.voice[this.settings.engine],
      sleep: { ...this.sleep },
    };
  }

  private pending: { title: string } | null = null;

  getCurrentStory(): Story | null {
    return this.current ? structuredClone(this.current) : null;
  }

  getEngineState(): EngineState {
    return { ...this.engine };
  }

  // The mock renders nothing, so its runway is always there.
  getRunway(): RunwayState {
    const target = this.current ? 10 : 0;
    return { storyKey: this.current?.key ?? null, ready: target, target, preparing: false, ok: true, known: true };
  }

  async prepareRunway() {
    this.emit('runway', this.getRunway());
    return true;
  }

  /* ---------------------------------------------------------- stories */

  getPendingStory() {
    return this.pending ? { ...this.pending } : null;
  }

  async loadStory(ref: StoryRef, options: { position?: Position; autoplay?: boolean; background?: boolean; title?: string } = {}) {
    const foreground = !options.background;
    if (foreground) {
      this.pending = { title: options.title ?? '' };
      this.emit('pending-story', { ...this.pending });
    }
    try {
      return await this.loadStoryNow(ref, options);
    } finally {
      if (foreground) {
        this.pending = null;
        this.emit('pending-story', null);
      }
    }
  }

  private async loadStoryNow(ref: StoryRef, options: { position?: Position; autoplay?: boolean; background?: boolean }) {
    await this.wait(500);
    let story: Story | undefined;
    if (ref.kind === 'key') story = this.stories.get(ref.key) ?? this.fromSearch(ref.key);
    else if (ref.kind === 'url') story = this.fromUrl(ref.url);
    else story = this.fromFile(ref.file.name);
    if (!story) throw new BridgeError('not-found', 'That story could not be found.');
    this.stories.set(story.key, story);
    if (!this.entry(story.key)) this.addEntry(story);
    if (options.background) return structuredClone(story);

    this.stopTick();
    this.current = story;
    const entry = this.entry(story.key)!;
    this.position = options.position ?? { ...entry.position };
    entry.lastOpenedAt = Date.now();
    this.setState('paused');
    this.emit('story-loaded', { story: structuredClone(story), position: { ...this.position } });
    this.emitParagraph();
    this.emitLibrary();
    if (options.autoplay) void this.play();
    return structuredClone(story);
  }

  async importFile(file: File): Promise<StorySummary> {
    await this.wait(900);
    if (!/\.(epub|pdf|txt|html?|docx)$/i.test(file.name)) {
      throw new BridgeError('unsupported-file', 'That file type is not supported. Try EPUB, PDF, TXT, HTML or DOCX.');
    }
    const story = this.fromFile(file.name);
    this.stories.set(story.key, story);
    this.addEntry(story);
    this.emitLibrary();
    this.notice('success', `Imported “${story.title}”`, 'holding');
    return this.summary(story);
  }

  private fromUrl(url: string): Story {
    if (!/^https?:\/\//i.test(url)) throw new BridgeError('not-found', 'That does not look like a web address.');
    const match = [...this.stories.values()].find((s) => s.url === url);
    if (match) return match;
    const hit = [1, 2, 3].flatMap((p) => ao3Results('', p)).find((r) => r.url === url);
    if (hit) return this.fromSearch(hit.key)!;
    const base = this.stories.get('mock-starlings')!;
    return { ...base, key: `url-${hash(url)}`, title: 'Imported from the web', author: 'Unknown author', source: 'url', url };
  }

  private fromFile(name: string): Story {
    const base = this.stories.get('mock-tea-shop')!;
    const title = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Untitled';
    return { ...base, key: `upload-${hash(name)}`, title, author: 'Unknown author', source: 'upload', url: undefined };
  }

  private fromSearch(key: StoryKey): Story | undefined {
    const hit =
      [1, 2, 3].flatMap((p) => ao3Results('', p)).find((r) => r.key === key) ??
      this.catalogData.find((c) => c.key === key);
    if (!hit) return undefined;
    const base = this.stories.get('mock-orchard')!;
    return { ...base, ...hit, chapterCount: base.chapters.length, chapters: base.chapters };
  }

  /* -------------------------------------------------------- transport */

  async play() {
    if (!this.current) throw new BridgeError('not-found', 'Choose a story first.');
    if (this.state === 'playing') return;
    if (this.engine.status !== 'ready') {
      this.setState('loading');
      await this.warmEngine();
    }
    this.setState('buffering');
    this.emit('buffer', { storyKey: this.current.key, ready: 1, target: 6 });
    await this.wait(600);
    if (this.state !== 'buffering') return;
    this.emit('buffer', { storyKey: this.current.key, ready: 6, target: 6 });
    this.setState('playing');
    this.scheduleTick();
  }

  pause() {
    this.stopTick();
    if (this.state === 'playing' || this.state === 'buffering' || this.state === 'loading') this.setState('paused');
  }

  async togglePlay() {
    if (this.state === 'playing' || this.state === 'buffering') this.pause();
    else await this.play();
  }

  async seekToParagraph(paragraph: number, chapter = this.position.chapter) {
    if (!this.current) return;
    const ch = clamp(chapter, 0, this.current.chapters.length - 1);
    const p = clamp(paragraph, 0, this.current.chapters[ch].paragraphs.length - 1);
    this.position = { chapter: ch, paragraph: p };
    this.persistPosition();
    this.emitParagraph();
    if (this.state === 'playing') this.scheduleTick();
  }

  async seekToChapter(chapter: number) {
    await this.seekToParagraph(0, chapter);
  }

  async skipParagraph(delta: number) {
    if (!this.current) return;
    let { chapter, paragraph } = this.position;
    paragraph += delta;
    if (paragraph < 0 && chapter > 0) {
      chapter -= 1;
      paragraph = this.current.chapters[chapter].paragraphs.length - 1;
    } else if (paragraph >= this.current.chapters[chapter].paragraphs.length && chapter < this.current.chapters.length - 1) {
      chapter += 1;
      paragraph = 0;
    }
    await this.seekToParagraph(paragraph, chapter);
  }

  async skipChapter(delta: number) {
    await this.seekToChapter(this.position.chapter + delta);
  }

  setSleepTimer(timer: { kind: 'off' } | { kind: 'minutes'; minutes: number } | { kind: 'end-of-chapter' }) {
    if (this.sleepTick) clearTimeout(this.sleepTick);
    this.sleepTick = null;
    if (timer.kind === 'minutes') {
      const endsAt = Date.now() + timer.minutes * 60_000;
      this.sleep = { kind: 'minutes', minutes: timer.minutes, endsAt };
      this.sleepTick = setTimeout(() => {
        this.pause();
        this.sleep = { kind: 'off' };
        this.emit('sleep', this.sleep);
        this.notice('info', 'Sleep timer ended. Sweet dreams.', 'kneeling');
      }, timer.minutes * 60_000);
    } else {
      this.sleep = timer.kind === 'end-of-chapter' ? { kind: 'end-of-chapter' } : { kind: 'off' };
    }
    this.emit('sleep', { ...this.sleep });
  }

  private scheduleTick() {
    this.stopTick();
    const ms = this.opts.paragraphMs / this.settings.speed;
    this.tick = setTimeout(() => this.advance(), ms);
  }

  private stopTick() {
    if (this.tick) clearTimeout(this.tick);
    this.tick = null;
  }

  private advance() {
    if (!this.current || this.state !== 'playing') return;
    const chapters = this.current.chapters;
    let { chapter, paragraph } = this.position;
    paragraph += 1;
    if (paragraph >= chapters[chapter].paragraphs.length) {
      if (this.sleep.kind === 'end-of-chapter') {
        this.pause();
        this.sleep = { kind: 'off' };
        this.emit('sleep', this.sleep);
        this.notice('info', 'Stopped at the end of the chapter.', 'kneeling');
        return;
      }
      chapter += 1;
      paragraph = 0;
      if (chapter >= chapters.length) {
        const entry = this.entry(this.current.key);
        if (entry) entry.finished = true;
        this.setState('ended');
        this.emitLibrary();
        return;
      }
    }
    this.position = { chapter, paragraph };
    this.persistPosition();
    this.emitParagraph();
    this.emit('buffer', { storyKey: this.current.key, ready: 6, target: 6 });
    this.scheduleTick();
  }

  private setState(state: PlayState, reason?: string) {
    this.state = state;
    this.emit('playstate', { state, reason });
  }

  private emitParagraph() {
    if (!this.current) return;
    this.emit('paragraph', {
      storyKey: this.current.key,
      position: { ...this.position },
      paragraphCount: this.current.chapters[this.position.chapter].paragraphs.length,
      chapterCount: this.current.chapters.length,
    });
  }

  private persistPosition() {
    if (!this.current) return;
    const entry = this.entry(this.current.key);
    if (!entry) return;
    entry.position = { ...this.position };
    const total = this.current.chapters.reduce((n, c) => n + c.paragraphs.length, 0);
    const before =
      this.current.chapters.slice(0, this.position.chapter).reduce((n, c) => n + c.paragraphs.length, 0) +
      this.position.paragraph;
    entry.progress = total ? before / total : 0;
  }

  /* -------------------------------------------------------- bookmarks */

  async saveBookmark(label?: string) {
    if (!this.current) throw new BridgeError('not-found', 'Nothing is playing.');
    const entry = this.entry(this.current.key)!;
    const text = this.current.chapters[this.position.chapter].paragraphs[this.position.paragraph];
    const bm = {
      id: `bm-${Date.now()}`,
      storyKey: this.current.key,
      chapter: this.position.chapter,
      paragraph: this.position.paragraph,
      excerpt: text.length > 100 ? `${text.slice(0, 100)}…` : text,
      label,
      createdAt: Date.now(),
    };
    entry.bookmarks = [bm, ...entry.bookmarks].slice(0, 50);
    this.emitLibrary();
    this.notice('success', 'Bookmark saved', 'favorite');
    return bm;
  }

  /* ------------------------------------------------------- narration */

  listVoices(engine?: EngineId) {
    return VOICES.filter((v) => !engine || v.engine === engine);
  }

  async setEngine(engine: EngineId) {
    if (engine === this.settings.engine) return;
    const wasPlaying = this.state === 'playing';
    this.pause();
    this.settings = { ...this.settings, engine };
    this.emit('settings', { ...this.settings });
    this.engine = { engine, status: 'idle', backend: 'webgpu' };
    this.emit('engine', { ...this.engine });
    await this.warmEngine();
    if (wasPlaying) await this.play();
  }

  async setVoice(voice: VoiceId) {
    const v = VOICES.find((x) => x.id === voice);
    if (!v) throw new BridgeError('not-found', 'Unknown voice.');
    if (v.engine !== this.settings.engine) await this.setEngine(v.engine);
    this.settings = { ...this.settings, voice: { ...this.settings.voice, [v.engine]: voice } as Settings['voice'] };
    this.emit('settings', { ...this.settings });
    this.notice('info', `Now reading as ${v.name}`, 'wink');
  }

  setSpeed(speed: number) {
    const s = Math.round(clamp(speed, 0.5, 2.5) * 100) / 100;
    this.settings = { ...this.settings, speed: s };
    this.emit('speed', { speed: s });
    this.emit('settings', { ...this.settings });
    if (this.state === 'playing') this.scheduleTick();
  }

  async previewVoice(_voice: VoiceId) {
    await this.wait(400);
  }

  private async warmEngine() {
    const total = this.settings.engine === 'pocket' ? 118_000_000 : 86_000_000;
    const stages: EngineState['stage'][] = ['download', 'download', 'download', 'download', 'compile', 'warmup', 'first-paragraph'];
    for (let i = 0; i < stages.length; i++) {
      this.engine = {
        engine: this.settings.engine,
        status: 'loading',
        stage: stages[i],
        loadedBytes: Math.min(total, Math.round((total * (i + 1)) / 4)),
        totalBytes: total,
        backend: 'webgpu',
      };
      this.emit('engine', { ...this.engine });
      await this.wait(450);
    }
    this.engine = { engine: this.settings.engine, status: 'ready', backend: 'webgpu' };
    this.emit('engine', { ...this.engine });
  }

  /* --------------------------------------------------------- caching */

  async startCaching(key: StoryKey) {
    const entry = this.entry(key);
    if (!entry) throw new BridgeError('not-found', 'Add the story to your library first.');
    if (this.cacheJobs.has(key)) return;
    const story = this.stories.get(key);
    const total = story ? story.chapters.reduce((n, c) => n + c.paragraphs.length, 0) : 100;
    entry.cache = { state: 'caching', done: entry.cache.done, total };
    this.emit('caching-progress', { storyKey: key, ...entry.cache });
    this.notice('info', `Saving “${entry.story.title}” for offline listening`, 'holding');
    const job = setInterval(() => {
      entry.cache.done = Math.min(total, entry.cache.done + Math.ceil(total / 20));
      if (entry.cache.done >= total) {
        entry.cache.state = 'complete';
        clearInterval(job);
        this.cacheJobs.delete(key);
        this.notice('success', `“${entry.story.title}” is ready offline`, 'happy');
        this.emitLibrary();
      }
      this.emit('caching-progress', { storyKey: key, ...entry.cache });
    }, 500 * Math.max(this.opts.latency, 0.01));
    this.cacheJobs.set(key, job);
  }

  cancelCaching(key: StoryKey) {
    const job = this.cacheJobs.get(key);
    if (job) clearInterval(job);
    this.cacheJobs.delete(key);
    const entry = this.entry(key);
    if (!entry) return;
    entry.cache.state = entry.cache.done > 0 ? 'partial' : 'none';
    this.emit('caching-progress', { storyKey: key, ...entry.cache });
  }

  /* --------------------------------------------------------- library */

  library = {
    list: async () => structuredClone(this.entries),
    add: async (ref: StoryRef) => {
      const story = await this.loadStory(ref, { background: true });
      this.notice('success', `Added “${story.title}” to your library`, 'holding');
      return structuredClone(this.entry(story.key)!);
    },
    remove: async (key: StoryKey) => {
      const entry = this.entry(key);
      this.entries = this.entries.filter((e) => e.story.key !== key);
      if (this.current?.key === key) {
        this.stopTick();
        this.current = null;
        this.setState('idle');
        this.emit('story-closed', { storyKey: key });
      }
      this.emitLibrary();
      if (entry) this.notice('info', `Removed “${entry.story.title}”`, 'annoyed');
    },
    setFavourite: async (key: StoryKey, favourite: boolean) => {
      const entry = this.entry(key);
      if (!entry) return;
      entry.favourite = favourite;
      this.emitLibrary();
      if (favourite) this.notice('success', 'Added to favourites', 'favorite');
    },
    rate: async (key: StoryKey, stars: 0 | 1 | 2 | 3 | 4 | 5) => {
      const entry = this.entry(key);
      if (!entry) return;
      entry.rating = stars;
      this.emitLibrary();
    },
    setSubscribed: async (key: StoryKey, subscribed: boolean) => {
      const entry = this.entry(key);
      if (!entry) return;
      entry.subscribed = subscribed;
      this.emitLibrary();
    },
    checkForUpdates: async (key?: StoryKey) => {
      await this.wait(1200);
      const changed = this.entries.filter((e) => (key ? e.story.key === key : e.subscribed) && e.hasUpdate).map((e) => e.story.key);
      this.notice('info', changed.length ? `${changed.length} story has new chapters` : 'Everything is up to date', 'point');
      return changed;
    },
    removeBookmark: async (key: StoryKey, bookmarkId: string) => {
      const entry = this.entry(key);
      if (!entry) return;
      entry.bookmarks = entry.bookmarks.filter((b) => b.id !== bookmarkId);
      this.emitLibrary();
    },
  };

  private entry(key: StoryKey) {
    return this.entries.find((e) => e.story.key === key);
  }

  private addEntry(story: Story) {
    this.entries.unshift({
      story: this.summary(story),
      addedAt: Date.now(),
      position: { chapter: 0, paragraph: 0 },
      progress: 0,
      finished: false,
      favourite: false,
      rating: 0,
      cache: { state: 'none', done: 0, total: 0 },
      hasUpdate: false,
      subscribed: false,
      bookmarks: [],
    });
  }

  private summary(story: Story): StorySummary {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { chapters, ...rest } = story;
    return { ...rest, chapterCount: chapters.length };
  }

  private emitLibrary() {
    this.emit('library', structuredClone(this.entries));
  }

  /* -------------------------------------------------------- settings */

  async getSettings() {
    return structuredClone(this.settings);
  }

  async setSettings(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...structuredClone(patch) };
    this.emit('settings', structuredClone(this.settings));
    return structuredClone(this.settings);
  }

  /* -------------------------------------------------------- discovery */

  async search(q: Ao3Query): Promise<Page<Ao3Result>> {
    await this.wait(700);
    const page = q.page ?? 1;
    let items = ao3Results(q.query, page);
    if (q.completeOnly) items = items.filter((i) => i.complete);
    if (q.rating && q.rating !== 'Any') items = items.filter((i) => i.rating === q.rating);
    if (q.wordsMin) items = items.filter((i) => (i.words ?? 0) >= q.wordsMin!);
    if (q.wordsMax) items = items.filter((i) => (i.words ?? 0) <= q.wordsMax!);
    return { items, page, hasMore: page < 3, total: 214 };
  }

  catalog = {
    facets: async () => catalogFacets(this.catalogData),
    query: async (q: CatalogQuery): Promise<Page<CatalogEntry>> => {
      await this.wait(250);
      const s = q.search?.trim().toLowerCase();
      const has = <T,>(sel: T[] | undefined, vals: T[]) => !sel?.length || vals.some((v) => sel.includes(v));
      let items = this.catalogData.filter(
        (e) =>
          (!s || e.title.toLowerCase().includes(s) || e.author.toLowerCase().includes(s)) &&
          has(q.world, e.world) &&
          has(q.species, e.species) &&
          has(q.rating, e.rating ? [e.rating] : []) &&
          has(q.status, [e.status]) &&
          inLength(e.words ?? 0, q.length ?? 'all'),
      );
      const sort = q.sort ?? 'updated-desc';
      items = [...items].sort((a, b) =>
        sort === 'title-asc'
          ? a.title.localeCompare(b.title)
          : sort === 'author-asc'
            ? a.author.localeCompare(b.author)
            : sort === 'words-desc'
              ? (b.words ?? 0) - (a.words ?? 0)
              : sort === 'rating-desc'
                ? (b.communityRating ?? 0) - (a.communityRating ?? 0)
                : (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
      );
      return { items, page: 1, hasMore: false, total: items.length };
    },
  };

  /* ------------------------------------------------------------ data */

  async exportBackup() {
    await this.wait(800);
    const json = JSON.stringify({ settings: this.settings, library: this.entries });
    const stamp = new Date().toISOString().slice(0, 10);
    return {
      blob: new Blob([json], { type: 'application/octet-stream' }),
      filename: `pocket-reader-${stamp}.prbackup`,
      stories: this.entries.length,
      bookmarks: this.entries.reduce((n, e) => n + e.bookmarks.length, 0),
    };
  }

  async importBackup(file: File) {
    await this.wait(900);
    if (!/\.(prbackup|json)$/i.test(file.name)) {
      throw new BridgeError('unsupported-file', 'Choose a .prbackup file exported from Pocket Reader.');
    }
    this.notice('success', 'Backup restored', 'happy');
    return { stories: this.entries.length, bookmarks: 2, settingsRestored: true };
  }

  async getStorageUsage() {
    const audio = this.entries.reduce((n, e) => n + e.cache.done * 180_000, 0);
    return {
      voiceModelsBytes: this.settings.engine === 'pocket' ? 118_000_000 : 86_000_000,
      audioCacheBytes: audio,
      storiesBytes: 4_200_000,
      quotaBytes: 2_000_000_000,
    };
  }

  async clearAudioCache() {
    await this.wait(400);
    this.entries.forEach((e) => (e.cache = { state: 'none', done: 0, total: 0 }));
    this.emitLibrary();
    this.notice('success', 'Saved narration cleared', 'settings');
  }

  async clearVoiceModels() {
    await this.wait(400);
    this.engine = { engine: this.settings.engine, status: 'idle' };
    this.emit('engine', { ...this.engine });
    this.notice('success', 'Voice models removed. They download again on next play.', 'settings');
  }

  /* ---------------------------------------------------------- extras */

  async listAchievements() {
    return structuredClone(ACHIEVEMENTS);
  }

  async getStats() {
    return { streakDays: 5, minutesThisWeek: 214, storiesFinished: 1 };
  }

  async getDiagnostics() {
    return {
      appVersion: '2.0.0-mock',
      coreVersion: 'mock',
      serviceWorker: 'not registered (mock)',
      device: navigator.userAgent.includes('iPhone') ? 'iPhone' : 'Browser (mock)',
      memoryHeadroomMb: 1536,
      engine: { ...this.engine },
      threads: Math.min(4, navigator.hardwareConcurrency || 2),
      crossOriginIsolated: globalThis.crossOriginIsolated ?? false,
      lockSessions: [],
      recentLog: [
        { at: Date.now() - 60_000, level: 'info' as const, message: 'Mock bridge started' },
        { at: Date.now() - 30_000, level: 'info' as const, message: `Engine ${this.engine.engine}: ${this.engine.status}` },
        { at: Date.now() - 5_000, level: 'warn' as const, message: 'Example warning line for layout review' },
      ],
    };
  }

  runNoticeAction(_noticeId: string) {}

  private notice(level: 'info' | 'success' | 'warning' | 'error', message: string, mood?: BridgeEvents['notice']['mood']) {
    this.emit('notice', { id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, level, message, mood });
  }

  /** Test/dev helper: tear down timers. */
  dispose() {
    this.stopTick();
    if (this.sleepTick) clearTimeout(this.sleepTick);
    this.cacheJobs.forEach((j) => clearInterval(j));
    this.cacheJobs.clear();
    this.handlers.clear();
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function inLength(words: number, len: string) {
  switch (len) {
    case 'under-10k':
      return words < 10_000;
    case '10k-50k':
      return words >= 10_000 && words < 50_000;
    case '50k-100k':
      return words >= 50_000 && words < 100_000;
    case '100k-250k':
      return words >= 100_000 && words < 250_000;
    case '250k-plus':
      return words >= 250_000;
    default:
      return true;
  }
}
