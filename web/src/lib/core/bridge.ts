/**
 * CoreBridge: the ONLY seam between the v2 UI and the narration/library cores.
 *
 * The UI never touches `window.*` globals, the DOM ids the old UI used, or the
 * cores' storage. Everything it needs goes through one object that implements
 * this interface. `bridge.mock.ts` implements it with fake data; the real
 * implementation (built on the cores' event bus in `public/assets/js/`) is
 * registered with `setBridge()` from `./index.ts` before the app mounts.
 *
 * Contract rules for implementers
 * 1. Methods are async unless typed otherwise and reject with `BridgeError`
 *    (`code` is machine-readable; `message` is shown to the reader as-is).
 * 2. State the UI renders continuously (playback position, play state, engine
 *    readiness, caching) is PUSHED through `on()` events. The UI does not poll.
 *    `getPlayback()` is only read once at startup to seed the stores.
 * 3. Every event payload is a fresh plain object (structured-cloneable, no DOM,
 *    no class instances). The UI may keep references to them.
 * 4. Indices are zero-based. `Position.chapter` indexes `Story.chapters`.
 * 5. The bridge owns persistence. The UI calls `setSettings(patch)` and re-renders
 *    from the returned/emitted value; it never writes storage itself.
 * 6. Removed in v2, so not in this interface: Away mode, accounts / sign-in /
 *    cloud sync, the Kitten engine, Web Speech fallback.
 *
 * Mapping notes to today's cores (see public/assets/js/):
 *   loadStory        -> api_core.js loadStory(url) / processUploadedFile(file)
 *   togglePlay       -> audio_core.js togglePlayState()
 *   seekToParagraph  -> audio_core.js seekToParagraph(c, p)
 *   skip*            -> audio_core.js skipParagraph(offset) / skipChapter(offset)
 *   setEngine        -> audio_core.js switchReaderVoiceEngine('pocket'|'kokoro')
 *   setVoice         -> audio_core.js onVoiceSelectionChange(voiceId)
 *   library.*        -> library_manager.js addToLibrary/removeStory/toggleFavorite/rateStory
 *   saveBookmark     -> audio_core.js saveBookmark() (entry.bookmarks[] {c,p,t,ts})
 *   search           -> api_core.js handleSearchSubmit -> POST /api/search
 *   catalog.*        -> hmofa_catalog_core.js filterCatalog/sortCatalog over the masterlist
 *   exportBackup     -> data_transfer.js exportPocketReaderData()
 *   importBackup     -> data_transfer.js importPocketReaderData(file)
 *   startCaching     -> buffer_manager.js startCaching('Permanent', storyRef)
 *   setSleepTimer    -> settings_manager.js applySleepTimer()
 */

/* ------------------------------------------------------------------ ids */

export type EngineId = 'pocket' | 'kokoro';
/** `noah` was retired in the english_2026-10 migration and aliases to `paul` in engine_utils.js. */
export type PocketVoiceId = 'alba' | 'mary' | 'eve' | 'charles' | 'george' | 'paul';
export type KokoroVoiceId = 'af_heart' | 'af_bella' | 'bf_emma' | 'am_michael' | 'am_fenrir' | 'am_puck';
export type VoiceId = PocketVoiceId | KokoroVoiceId;
/** Stable library key (library_manager getStoryStableKey). */
export type StoryKey = string;

/* ---------------------------------------------------------------- story */

export type StorySourceKind = 'ao3' | 'hmofa' | 'upload' | 'url';
export type ContentRating = 'General' | 'Teen' | 'Mature' | 'Explicit' | 'Not Rated';

export interface StorySummary {
  key: StoryKey;
  title: string;
  author: string;
  source: StorySourceKind;
  /** Canonical web URL when the story came from the web. */
  url?: string;
  /** `synopsis` in the cores. Plain text, paragraphs split by blank lines. */
  synopsis?: string;
  fandoms?: string[];
  tags?: string[];
  rating?: ContentRating;
  /** Numeric (the cores store a localised string; the bridge parses it). */
  words?: number;
  chapterCount: number;
  complete?: boolean;
  /** Optional remote cover. The UI draws a typographic cover when absent. */
  coverUrl?: string;
}

export interface Chapter {
  title: string;
  paragraphs: string[];
}

export interface Story extends StorySummary {
  chapters: Chapter[];
}

export interface Position {
  chapter: number;
  paragraph: number;
}

/** What `loadStory` accepts. */
export type StoryRef =
  | { kind: 'key'; key: StoryKey }
  | { kind: 'url'; url: string }
  | { kind: 'file'; file: File };

export interface LoadOptions {
  /** Start at this position instead of the saved one. */
  position?: Position;
  /** Start narration as soon as the first paragraph is ready. */
  autoplay?: boolean;
  /** Load without making it the current story (prefetch / add). */
  background?: boolean;
}

/* -------------------------------------------------------------- library */

export type CacheState = 'none' | 'partial' | 'caching' | 'complete';

export interface Bookmark {
  id: string;
  storyKey: StoryKey;
  chapter: number;
  paragraph: number;
  /** First ~100 chars of the paragraph (`t` in the cores). */
  excerpt: string;
  label?: string;
  createdAt: number;
}

export interface LibraryEntry {
  story: StorySummary;
  addedAt: number;
  lastOpenedAt?: number;
  position: Position;
  /** 0..1 across the whole story. */
  progress: number;
  finished: boolean;
  favourite: boolean;
  /** 0 = unrated, 1..5 stars. */
  rating: number;
  cache: { state: CacheState; done: number; total: number };
  /** New chapters were found by the last update check. */
  hasUpdate: boolean;
  /** Reader opted in to update notifications for this story. */
  subscribed: boolean;
  bookmarks: Bookmark[];
}

export interface LibraryApi {
  list(): Promise<LibraryEntry[]>;
  add(ref: StoryRef): Promise<LibraryEntry>;
  remove(key: StoryKey): Promise<void>;
  setFavourite(key: StoryKey, favourite: boolean): Promise<void>;
  rate(key: StoryKey, stars: 0 | 1 | 2 | 3 | 4 | 5): Promise<void>;
  setSubscribed(key: StoryKey, subscribed: boolean): Promise<void>;
  /** Checks subscribed stories (or one) for new chapters; resolves with keys that changed. */
  checkForUpdates(key?: StoryKey): Promise<StoryKey[]>;
  removeBookmark(key: StoryKey, bookmarkId: string): Promise<void>;
}

/* ------------------------------------------------------------- playback */

export type PlayState = 'idle' | 'loading' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

export type SleepTimer =
  | { kind: 'off' }
  | { kind: 'minutes'; minutes: number; endsAt: number }
  | { kind: 'end-of-chapter' };

export interface PlaybackSnapshot {
  storyKey: StoryKey | null;
  state: PlayState;
  position: Position;
  paragraphCount: number;
  chapterCount: number;
  speed: number;
  engine: EngineId;
  voice: VoiceId;
  sleep: SleepTimer;
}

/* -------------------------------------------------------------- engines */

export interface Voice {
  id: VoiceId;
  engine: EngineId;
  name: string;
  gender: 'female' | 'male';
  accent: 'American' | 'English';
  /** One short phrase from the core's voice catalog. */
  character: string;
}

export type EngineStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface EngineState {
  engine: EngineId;
  status: EngineStatus;
  /** Present while `status === 'loading'`. */
  stage?: 'download' | 'compile' | 'warmup' | 'first-paragraph';
  loadedBytes?: number;
  totalBytes?: number;
  backend?: 'webgpu' | 'wasm';
  message?: string;
}

/**
 * The starting runway: paragraphs from the reading position that are already
 * rendered. Play unlocks when `ready >= target` (`ok`). `target` is 10, or what
 * is left of the story. The device voice needs none (`ok` with target 0).
 */
export interface RunwayState {
  storyKey: StoryKey | null;
  ready: number;
  target: number;
  preparing: boolean;
  ok: boolean;
  error?: string;
  /** False until the narration runtime has loaded and answered. */
  known: boolean;
}

/* ------------------------------------------------------------- settings */

export interface PronunciationRule {
  id: string;
  term: string;
  soundsLike: string;
  enabled: boolean;
}

export interface Settings {
  engine: EngineId;
  voice: { pocket: PocketVoiceId; kokoro: KokoroVoiceId };
  speed: number;
  /** `expressiveProsody` + emotion mode in the cores. */
  expressive: boolean;
  pronunciations: PronunciationRule[];
  theme: 'system' | 'light' | 'dark';
  readerFont: 'serif' | 'sans';
  /** Reader text size in px at 100% Dynamic Type. */
  readerSize: number;
  readerLineHeight: number;
  /** What the app opens into for a story: narration or text. */
  defaultMode: 'listen' | 'read';
  updateNotifications: boolean;
  /** Virtue companion: shown or hidden; how often she speaks. */
  companion: 'virtue' | 'none';
  companionChatter: 'quiet' | 'normal';
  onboarded: boolean;
}

/* --------------------------------------------------------------- search */

export interface Ao3Query {
  query: string;
  fandom?: string;
  rating?: ContentRating | 'Any';
  completeOnly?: boolean;
  wordsMin?: number;
  wordsMax?: number;
  language?: string;
  sort?: 'revised_at' | 'kudos_count' | 'hits' | 'word_count' | 'created_at';
  page?: number;
}

export interface Ao3Result extends StorySummary {
  source: 'ao3';
  url: string;
  updated?: string;
  kudos?: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  hasMore: boolean;
  total?: number;
}

/* -------------------------------------------------------- HMOFA catalog */

export type CatalogWorld = 'HMOFA' | 'ADHG' | 'Anthrostate';
export type CatalogStatus = 'Ongoing' | 'Complete' | 'Hiatus' | 'Abandoned' | 'Unknown';
export type CatalogLength = 'all' | 'under-10k' | '10k-50k' | '50k-100k' | '100k-250k' | '250k-plus';

export interface CatalogEntry extends StorySummary {
  source: 'hmofa';
  id: string;
  world: CatalogWorld[];
  species: string[];
  status: CatalogStatus;
  romance: 'Gen' | 'M/F' | 'Poly' | 'Other';
  platforms: string[];
  updatedAt?: string;
  /** Community rating 0..5, if any. */
  communityRating?: number;
}

export interface CatalogQuery {
  search?: string;
  world?: CatalogWorld[];
  species?: string[];
  rating?: ContentRating[];
  status?: CatalogStatus[];
  length?: CatalogLength;
  sort?: 'updated-desc' | 'title-asc' | 'author-asc' | 'words-desc' | 'rating-desc';
  page?: number;
}

export interface CatalogFacet {
  key: 'world' | 'species' | 'rating' | 'status' | 'length';
  label: string;
  values: { value: string; count: number }[];
}

export interface CatalogApi {
  facets(): Promise<CatalogFacet[]>;
  query(q: CatalogQuery): Promise<Page<CatalogEntry>>;
}

/* -------------------------------------------------- storage / backup / misc */

export interface StorageUsage {
  voiceModelsBytes: number;
  audioCacheBytes: number;
  storiesBytes: number;
  quotaBytes?: number;
}

export interface BackupResult {
  blob: Blob;
  filename: string;
  stories: number;
  bookmarks: number;
}

export interface RestoreResult {
  stories: number;
  bookmarks: number;
  settingsRestored: boolean;
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  /** Matches public/assets/icons/ach_<id>.svg */
  icon: string;
  unlockedAt?: number;
  /** Tiered achievements: current tier name and progress to the next. */
  tier?: 'Bronze' | 'Silver' | 'Gold' | 'Platinum';
  progress?: { value: number; target: number };
}

export interface ListeningStats {
  streakDays: number;
  minutesThisWeek: number;
  storiesFinished: number;
}

export interface Diagnostics {
  appVersion: string;
  coreVersion: string;
  serviceWorker: string;
  device: string;
  memoryHeadroomMb?: number;
  engine: EngineState;
  threads: number;
  crossOriginIsolated: boolean;
  recentLog: { at: number; level: 'info' | 'warn' | 'error'; message: string }[];
}

export interface Notice {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  /** Optional single action; the UI calls `bridge.runNoticeAction(id)` when tapped. */
  actionLabel?: string;
  /** Hint for the companion: which Virtue mood fits this notice. */
  mood?: VirtueMood;
}

/** Virtue sprite moods the UI knows how to draw (see lib/virtue/sprites.ts). */
export type VirtueMood =
  | 'waving'
  | 'smile'
  | 'wink'
  | 'point'
  | 'thinking'
  | 'talking'
  | 'loading'
  | 'holding'
  | 'happy'
  | 'kneeling'
  | 'achievement'
  | 'highscore'
  | 'lowscore'
  | 'favorite'
  | 'annoyed'
  | 'settings';

/* ---------------------------------------------------------------- events */

export interface BridgeEvents {
  /** Current paragraph changed (playback advanced, seek, or story load). */
  paragraph: { storyKey: StoryKey; position: Position; paragraphCount: number; chapterCount: number };
  playstate: { state: PlayState; reason?: string };
  /** Narration rendered ahead of the playhead. `ready`/`target` are paragraphs. */
  buffer: { storyKey: StoryKey; ready: number; target: number };
  engine: EngineState;
  runway: RunwayState;
  notice: Notice;
  'story-loaded': { story: Story; position: Position };
  'caching-progress': { storyKey: StoryKey; state: CacheState; done: number; total: number };
  /** Library contents changed (add/remove/favourite/rate/progress). Payload is the full list. */
  library: LibraryEntry[];
  settings: Settings;
  sleep: SleepTimer;
  speed: { speed: number };
  achievement: Achievement;
}

export type BridgeEventName = keyof BridgeEvents;
export type Unsubscribe = () => void;

export class BridgeError extends Error {
  constructor(
    public code:
      | 'network'
      | 'blocked'
      | 'not-found'
      | 'unsupported-file'
      | 'engine-failed'
      | 'quota'
      | 'busy'
      | 'cancelled'
      | 'unknown',
    message: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

/* ------------------------------------------------------------- interface */

export interface CoreBridge {
  /** Seed state once at startup. */
  getPlayback(): PlaybackSnapshot;
  getCurrentStory(): Story | null;

  // stories
  loadStory(ref: StoryRef, options?: LoadOptions): Promise<Story>;
  importFile(file: File): Promise<StorySummary>;

  // transport
  play(): Promise<void>;
  pause(): void;
  togglePlay(): Promise<void>;
  seekToParagraph(paragraph: number, chapter?: number): Promise<void>;
  seekToChapter(chapter: number): Promise<void>;
  skipParagraph(delta: number): Promise<void>;
  skipChapter(delta: number): Promise<void>;
  setSleepTimer(timer: { kind: 'off' } | { kind: 'minutes'; minutes: number } | { kind: 'end-of-chapter' }): void;

  // bookmarks (at the current position)
  saveBookmark(label?: string): Promise<Bookmark>;

  // narration
  listVoices(engine?: EngineId): Voice[];
  setEngine(engine: EngineId): Promise<void>;
  setVoice(voice: VoiceId): Promise<void>;
  setSpeed(speed: number): void;
  /** Speak a short sample with this voice without touching the story. */
  previewVoice(voice: VoiceId): Promise<void>;
  getEngineState(): EngineState;
  /** The starting runway at the current position. */
  getRunway(): RunwayState;
  /**
   * Render the paragraphs Play needs, without playing. Returns false when it
   * could not start here (the first Play has to reload into the fast session).
   */
  prepareRunway(): Promise<boolean>;

  // offline
  startCaching(key: StoryKey): Promise<void>;
  cancelCaching(key: StoryKey): void;

  // library + settings
  library: LibraryApi;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;

  // discovery
  search(query: Ao3Query): Promise<Page<Ao3Result>>;
  catalog: CatalogApi;

  // data
  exportBackup(): Promise<BackupResult>;
  importBackup(file: File): Promise<RestoreResult>;
  getStorageUsage(): Promise<StorageUsage>;
  clearAudioCache(): Promise<void>;
  clearVoiceModels(): Promise<void>;

  // extras
  listAchievements(): Promise<Achievement[]>;
  getStats(): Promise<ListeningStats>;
  getDiagnostics(): Promise<Diagnostics>;
  runNoticeAction(noticeId: string): void;

  // events
  on<E extends BridgeEventName>(event: E, handler: (payload: BridgeEvents[E]) => void): Unsubscribe;
}

/* ------------------------------------------------------------- catalogs */

export const VOICES: readonly Voice[] = [
  // Pocket: accents and descriptions from engine_utils.js POCKET voices.
  { id: 'alba', engine: 'pocket', name: 'Alba', gender: 'female', accent: 'English', character: 'Acted, steady over long chapters' },
  { id: 'mary', engine: 'pocket', name: 'Mary', gender: 'female', accent: 'American', character: 'Clean midwestern read' },
  { id: 'eve', engine: 'pocket', name: 'Eve', gender: 'female', accent: 'American', character: 'Brighter east-coast read' },
  { id: 'charles', engine: 'pocket', name: 'Charles', gender: 'male', accent: 'English', character: 'Measured English read' },
  { id: 'george', engine: 'pocket', name: 'George', gender: 'male', accent: 'American', character: 'Warmer New England read' },
  { id: 'paul', engine: 'pocket', name: 'Paul', gender: 'male', accent: 'American', character: 'Ready-made studio reference' },
  // Kokoro: labels from pocket_backend_policy.js KOKORO_VOICES.
  { id: 'af_heart', engine: 'kokoro', name: 'Heart', gender: 'female', accent: 'American', character: 'Warm' },
  { id: 'af_bella', engine: 'kokoro', name: 'Bella', gender: 'female', accent: 'American', character: 'Expressive' },
  { id: 'bf_emma', engine: 'kokoro', name: 'Emma', gender: 'female', accent: 'English', character: 'Measured' },
  { id: 'am_michael', engine: 'kokoro', name: 'Michael', gender: 'male', accent: 'American', character: 'Steady' },
  { id: 'am_fenrir', engine: 'kokoro', name: 'Fenrir', gender: 'male', accent: 'American', character: 'Deep' },
  { id: 'am_puck', engine: 'kokoro', name: 'Puck', gender: 'male', accent: 'American', character: 'Bright' },
];

export const ENGINES: Record<EngineId, { name: string; blurb: string }> = {
  pocket: { name: 'Pocket', blurb: 'Most natural, with emotion. Best on recent iPhone Pro models.' },
  kokoro: { name: 'Kokoro', blurb: 'Lighter and quicker to start. Good on any recent phone.' },
};

export const SPEEDS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
