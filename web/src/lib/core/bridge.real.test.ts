/**
 * RealBridge against stubbed cores. The cores themselves are covered by the
 * node:test suite; this pins the translation layer: window state and core
 * events in, CoreBridge snapshots and events out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (detail: any) => void;
const listeners = new Map<string, Set<Listener>>();
const CORE_EVENT = {
  NOTICE: 'pr:notice', COMPANION: 'pr:companion', PARAGRAPH: 'pr:paragraph', PLAYSTATE: 'pr:playstate',
  NAVIGATE: 'pr:navigate', STORY_OPENED: 'pr:story-loaded', LOADING: 'pr:loading', DIALOG: 'pr:dialog',
  LIBRARY: 'pr:library', CACHE_PANEL: 'pr:cache-panel', ENGINE: 'pr:engine', BUFFER: 'pr:buffer',
  STATUS: 'pr:status', PROGRESS: 'pr:progress', PLAY_LOADING: 'pr:play-loading', CACHING: 'pr:caching-progress',
};
function fire(type: string, detail: any = {}) {
  listeners.get(type)?.forEach((fn) => fn(detail));
}

vi.mock('./coreLoader', () => ({
  bootCores: vi.fn(async () => {}),
  importCore: vi.fn(async (file: string) => {
    if (file === 'core_events.js') {
      return {
        CORE_EVENT,
        onCore: (type: string, fn: Listener) => {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type)!.add(fn);
          return () => listeners.get(type)!.delete(fn);
        },
      };
    }
    if (file === 'api_core.js') {
      return {
        buildAo3SearchPayload: (q: string, f: any, o: any) => ({ query: q, ...f, page: o.page, rating: f.rating }),
        isEmptyAo3Search: (p: any) => !p.query,
        searchAo3: vi.fn(async () => ({
          ok: true,
          data: { page: 1, has_more: true, results: [{ title: 'Found', author: 'A', url: 'https://archiveofourown.org/works/1', words: '12,345', chapters: '3/3' }] },
        })),
      };
    }
    return {};
  }),
}));

const w = window as unknown as Record<string, any>;

function story(overrides: Record<string, any> = {}) {
  return {
    storyKey: 's_1', title: 'The Lighthouse', author: 'Ilse', url: 'https://archiveofourown.org/works/9',
    words: '1,204', publishedChapters: 2, progressChapter: 1, progressParagraph: 2,
    paragraphCounts: [4, 4], favorite: true, userRating: 4, updateSubscribed: true,
    bookmarks: [{ id: 'b1', c: 1, p: 2, t: 'By noon the fog', ts: 10 }, { id: 'b2', c: 0, p: 0, t: 'gone', ts: 5, deletedAt: 6 }],
    ...overrides,
  };
}

async function makeBridge() {
  const { RealBridge } = await import('./bridge.real');
  const b = new RealBridge();
  await b.attach();
  return b;
}

beforeEach(() => {
  listeners.clear();
  localStorage.clear();
  w.userProfile = { library: [story()], settings: { pocketVoice: 'mary', kokoroVoice: 'am_puck', speed: 1.1, theme: 'light' } };
  w.currentStory = null;
  w.isPlaying = false;
  w.currentChapterIndex = 0;
  w.currentParagraphIndex = 0;
  w._resolveActiveEngine = () => 'pocket';
  w.canonicalPocketVoice = (v: string) => v;
  w.getNarrationEngineStatus = () => 'idle';
  w.saveLocalData = vi.fn();
  w.findLibraryStoryByRef = (key: string) => w.userProfile.library.find((s: any) => s.storyKey === key);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RealBridge', () => {
  it('names achievement icons as the files are named (ach_<id>)', async () => {
    w.ACHIEVEMENTS_DB = [{ id: 'first_book', title: 'First Edition', desc: 'd', metric: 'firstStory', target: 1 }];
    const b = await makeBridge();
    const [a] = await b.listAchievements();
    expect(a.icon).toBe('ach_first_book');
    expect(b.kind).toBe('real');
  });

  it('maps library entries, including paragraph-level progress and live bookmarks only', async () => {
    const b = await makeBridge();
    const [entry] = await b.library.list();
    expect(entry.story).toMatchObject({ key: 's_1', title: 'The Lighthouse', source: 'ao3', words: 1204, chapterCount: 2 });
    expect(entry.progress).toBeCloseTo(6 / 8);
    expect(entry).toMatchObject({ favourite: true, rating: 4, subscribed: true, position: { chapter: 1, paragraph: 2 } });
    expect(entry.bookmarks).toEqual([
      { id: 'b1', storyKey: 's_1', chapter: 1, paragraph: 2, excerpt: 'By noon the fog', label: undefined, createdAt: 10 },
    ]);
  });

  it('reads settings from the profile and writes patches back to it', async () => {
    const b = await makeBridge();
    const s = await b.getSettings();
    expect(s).toMatchObject({ engine: 'pocket', voice: { pocket: 'mary', kokoro: 'am_puck' }, speed: 1.1, theme: 'light', onboarded: false });
    const seen: any[] = [];
    b.on('settings', (x) => seen.push(x));
    const next = await b.setSettings({ readerSize: 22, expressive: false, onboarded: true, theme: 'dark' });
    expect(next).toMatchObject({ readerSize: 22, expressive: false, onboarded: true, theme: 'dark' });
    expect(w.userProfile.settings).toMatchObject({ readerFontSize: 22, expressiveProsody: false, theme: 'dark' });
    expect(localStorage.getItem('pr_setup_complete')).toBe('true');
    expect(seen).toHaveLength(1);
    expect(w.saveLocalData).toHaveBeenCalled();
  });

  it('replaces the device-setup modal with a headless check that resumes playback', async () => {
    const b = await makeBridge();
    const engine: any[] = [];
    b.on('engine', (e) => engine.push(e));
    let resolveSetup!: () => void;
    w._pocketDeviceSetup = null;
    w.startPocketDeviceSetup = () => new Promise<void>((r) => { resolveSetup = r; });
    const resume = vi.fn();
    expect(w.deferForDeviceSetup(resume)).toBe(true);
    expect(engine.at(-1)).toMatchObject({ status: 'loading', stage: 'compile' });
    resolveSetup();
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    w._pocketDeviceSetup = { done: true };
    expect(w.deferForDeviceSetup(resume)).toBe(false);
  });

  it('starts playback inside the tap: togglePlayState is called before any await', async () => {
    const b = await makeBridge();
    w.currentStory = { storyKey: 's_1', title: 'T', chapters: [{ title: 'One', paragraphs: ['a'] }] };
    w.togglePlayState = vi.fn(() => Promise.resolve());
    const states: string[] = [];
    b.on('playstate', (p) => states.push(p.state));
    const done = b.play();
    expect(w.togglePlayState).toHaveBeenCalledTimes(1);
    await done;
    expect(states).toEqual(['loading']);
  });

  it('turns core events into bridge events', async () => {
    const b = await makeBridge();
    const got: Record<string, any[]> = {};
    for (const name of ['paragraph', 'story-loaded', 'notice', 'playstate', 'caching-progress'] as const) {
      got[name] = [];
      b.on(name, (p: any) => got[name].push(p));
    }
    w.currentStory = { storyKey: 's_1', title: 'T', chapters: [{ title: 'One', paragraphs: ['a', 'b', 'c'] }] };
    w.currentParagraphIndex = 2;
    fire(CORE_EVENT.STORY_OPENED, { story: w.currentStory });
    fire(CORE_EVENT.PARAGRAPH);
    fire(CORE_EVENT.COMPANION, { beat: 'virtue_thinking', speech: 'Let me look.' });
    fire(CORE_EVENT.PLAYSTATE, { playing: true });
    fire(CORE_EVENT.CACHING, { active: true, cached: 3, total: 10 });
    expect(got['story-loaded'][0]).toMatchObject({ story: { key: 's_1', chapters: [{ paragraphs: ['a', 'b', 'c'] }] }, position: { chapter: 0, paragraph: 2 } });
    expect(got.paragraph.at(-1)).toMatchObject({ storyKey: 's_1', position: { chapter: 0, paragraph: 2 }, paragraphCount: 3 });
    expect(got.notice[0]).toMatchObject({ message: 'Let me look.', mood: 'thinking' });
    expect(got.playstate.at(-1)).toMatchObject({ state: 'playing' });
    expect(got['caching-progress'][0]).toMatchObject({ storyKey: 's_1', state: 'caching', done: 3, total: 10 });
    // Opening a story records its paragraph counts for progress.
    expect(w.userProfile.library[0].paragraphCounts).toEqual([3]);
  });

  it('maps AO3 search results', async () => {
    const b = await makeBridge();
    const page = await b.search({ query: 'lighthouse' });
    expect(page).toMatchObject({ page: 1, hasMore: true });
    expect(page.items[0]).toMatchObject({ title: 'Found', source: 'ao3', words: 12345, chapterCount: 3, complete: true });
    await expect(b.search({ query: '' })).resolves.toMatchObject({ items: [] });
  });

  it('removes a library story without the native confirm dialog', async () => {
    const b = await makeBridge();
    w.removeStory = vi.fn();
    await b.library.remove('s_1');
    expect(w.removeStory).toHaveBeenCalledWith('s_1', { confirm: false });
  });
});
