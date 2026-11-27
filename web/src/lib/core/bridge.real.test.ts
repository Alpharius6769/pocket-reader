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
  GESTURE: 'pr:gesture-needed',
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
    w.togglePlayState = vi.fn(() => { w.isPlaying = true; return Promise.resolve(); });
    const states: string[] = [];
    b.on('playstate', (p) => states.push(p.state));
    const done = b.play();
    expect(w.togglePlayState).toHaveBeenCalledTimes(1);
    await done;
    expect(states).toEqual(['loading']);
  });

  it('a Play held back by the starting runway ends paused, not loading', async () => {
    const b = await makeBridge();
    w.currentStory = { storyKey: 's_1', title: 'T', chapters: [{ title: 'One', paragraphs: ['a'] }] };
    w.togglePlayState = vi.fn(() => Promise.resolve()); // the core's gate: preparing, not playing
    w.isNarrationRunwayReady = () => false;
    w.getNarrationRunway = () => ({ ready: 3, target: 10, preparing: true, current: true });
    const runways: any[] = [];
    b.on('runway', (r) => runways.push(r));
    const states: string[] = [];
    b.on('playstate', (p) => states.push(p.state));
    await b.play();
    expect(states.at(-1)).toBe('paused');
    expect(runways.at(-1)).toMatchObject({ storyKey: 's_1', ready: 3, target: 10, preparing: true, ok: false, known: true });
    delete w.isNarrationRunwayReady;
    delete w.getNarrationRunway;
  });

  it('reports the runway for the current position only', async () => {
    const b = await makeBridge();
    w.currentStory = { storyKey: 's_1', title: 'T', chapters: [{ title: 'One', paragraphs: ['a'] }] };
    expect(b.getRunway()).toMatchObject({ known: false, ok: false });
    w.isNarrationRunwayReady = () => false;
    w.getNarrationRunway = () => ({ ready: 10, target: 10, preparing: false, current: false });
    expect(b.getRunway()).toMatchObject({ ready: 0, ok: false, known: true }); // prepared somewhere else
    w.isNarrationRunwayReady = () => true;
    w.getNarrationRunway = () => ({ ready: 10, target: 10, preparing: false, current: true });
    expect(b.getRunway()).toMatchObject({ ready: 10, target: 10, ok: true });
    w._resolveActiveEngine = () => 'webspeech';
    expect(b.getRunway()).toMatchObject({ ok: true, target: 0 });
    delete w.isNarrationRunwayReady;
    delete w.getNarrationRunway;
  });

  it('a voice change mid-listen drops the old clip and plays on in the new voice', async () => {
    const b = await makeBridge();
    w.currentStory = { storyKey: 's_1', title: 'T', chapters: [{ title: 'One', paragraphs: ['a'] }] };
    w.isPlaying = true;
    w.pausePlayback = vi.fn(() => { w.isPlaying = false; });
    w.onVoiceSelectionChange = vi.fn(() => Promise.resolve());
    w._releaseCurrentNarrationAudio = vi.fn();
    w.cancelNarrationRunway = vi.fn();
    let bypassSeen = false;
    w.togglePlayState = vi.fn(() => { bypassSeen = w.__narrationRunwayBypassOnce === true; w.isPlaying = true; return Promise.resolve(); });
    await b.setVoice('paul');
    expect(w._releaseCurrentNarrationAudio).toHaveBeenCalledTimes(1);
    expect(w.togglePlayState).toHaveBeenCalledTimes(1);
    expect(bypassSeen).toBe(true);
    // Paused at the time: the old clip still goes, but nothing starts.
    w.isPlaying = false;
    w.togglePlayState = vi.fn();
    await b.setVoice('alba');
    expect(w._releaseCurrentNarrationAudio).toHaveBeenCalledTimes(2);
    expect(w.togglePlayState).not.toHaveBeenCalled();
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

  it('turns the post-reload tap request into Play, run inside the tap', async () => {
    const b = await makeBridge();
    const notices: any[] = [];
    const states: string[] = [];
    b.on('notice', (n) => notices.push(n));
    b.on('playstate', (p) => states.push(p.state));
    w.togglePlayState = vi.fn();
    const onContinue = vi.fn();
    const detail: any = { verb: 'Start narration', onContinue };
    listeners.get(CORE_EVENT.GESTURE)!.forEach((fn) => fn(detail));
    expect(detail.result).toBe(true);
    expect(notices.at(-1)).toMatchObject({ actionLabel: 'Start narration' });
    expect(states.at(-1)).toBe('paused');
    const done = b.play();
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(w.togglePlayState).not.toHaveBeenCalled();
    await done;
    // Consumed: the next Play is an ordinary one.
    w.currentStory = { storyKey: 's_1', title: 'T', chapters: [{ title: 'One', paragraphs: ['a'] }] };
    await b.play();
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(w.togglePlayState).toHaveBeenCalledTimes(1);
  });

  it('claims a tap request the cores raised before the bridge attached', async () => {
    // After the isolation reload, buffer_manager resumes while the cores are
    // still loading, before this bridge subscribes.
    const finish = vi.fn();
    w.__prPendingNarrationGesture = { verb: 'Start narration', finish, claimed: false };
    const b = await makeBridge();
    expect(w.__prPendingNarrationGesture.claimed).toBe(true);
    await Promise.resolve();
    // The stores subscribe only after attach(); the notice must still reach them.
    const notices: any[] = [];
    b.on('notice', (n) => notices.push(n));
    await Promise.resolve();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ message: 'Narration is ready. Tap play to start.', actionLabel: 'Start narration' });
    w.togglePlayState = vi.fn();
    await b.play();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(w.togglePlayState).not.toHaveBeenCalled();
    // Once the tap is spent, a new subscriber is not told to tap again.
    const later: any[] = [];
    b.on('notice', (n) => later.push(n));
    await Promise.resolve();
    expect(later).toHaveLength(0);
    delete w.__prPendingNarrationGesture;
  });

  it('removes a library story without the native confirm dialog', async () => {
    const b = await makeBridge();
    w.removeStory = vi.fn();
    await b.library.remove('s_1');
    expect(w.removeStory).toHaveBeenCalledWith('s_1', { confirm: false });
  });

  it('reports a story as on its way from the tap until it has opened', async () => {
    const b = await makeBridge();
    const seen: any[] = [];
    b.on('pending-story', (p) => seen.push(p));
    let finish: () => void = () => {};
    w.loadStory = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            w.currentStory = { ...story(), chapters: [{ title: 'One', paragraphs: ['a'] }] };
            resolve();
          };
        }),
    );
    const loading = b.loadStory({ kind: 'url', url: 'https://archiveofourown.org/works/9' }, { title: 'The Lighthouse' });
    // Still fetching: the Player has a title to show instead of "Nothing playing".
    expect(b.getPendingStory()).toEqual({ title: 'The Lighthouse' });
    finish();
    await loading;
    expect(b.getPendingStory()).toBeNull();
    expect(seen).toEqual([{ title: 'The Lighthouse' }, null]);
  });

  it('clears the pending story when the load fails', async () => {
    const b = await makeBridge();
    w.loadStory = vi.fn(async () => {
      throw new Error('AO3 is not answering');
    });
    await expect(b.loadStory({ kind: 'key', key: 's_1' })).rejects.toThrow('AO3 is not answering');
    expect(b.getPendingStory()).toBeNull();
  });

  it('keeps the story pending across the fast-narration reload until the cores reopen it', async () => {
    vi.useFakeTimers();
    const realUrl = location.href;
    history.replaceState(null, '', '?tts_fast=1');
    sessionStorage.setItem('pr_fast_narration_resume_v1', JSON.stringify({ title: 'Pocket Raptor Surprise', requestedAt: Date.now() }));
    try {
      const b = await makeBridge();
      expect(b.getPendingStory()).toEqual({ title: 'Pocket Raptor Surprise' });
      const seen: any[] = [];
      b.on('pending-story', (p) => seen.push(p));
      vi.advanceTimersByTime(2000);
      expect(b.getPendingStory()).not.toBeNull();
      // The cores reopen it and say so.
      w.currentStory = { ...story(), chapters: [{ title: 'One', paragraphs: ['a'] }] };
      fire(CORE_EVENT.STORY_OPENED, { story: w.currentStory });
      expect(b.getPendingStory()).toBeNull();
      expect(seen).toEqual([null]);
    } finally {
      sessionStorage.removeItem('pr_fast_narration_resume_v1');
      history.replaceState(null, '', realUrl);
      vi.useRealTimers();
    }
  });

  it('stops waiting when the cores give up on the reload handoff', async () => {
    vi.useFakeTimers();
    const realUrl = location.href;
    history.replaceState(null, '', '?tts_fast=1');
    sessionStorage.setItem('pr_fast_narration_resume_v1', JSON.stringify({ title: 'Gone', requestedAt: Date.now() }));
    try {
      const b = await makeBridge();
      expect(b.getPendingStory()).toEqual({ title: 'Gone' });
      sessionStorage.removeItem('pr_fast_narration_resume_v1');
      vi.advanceTimersByTime(2500);
      expect(b.getPendingStory()).toBeNull();
    } finally {
      history.replaceState(null, '', realUrl);
      vi.useRealTimers();
    }
  });

  it('has nothing pending on an ordinary start', async () => {
    const b = await makeBridge();
    expect(b.getPendingStory()).toBeNull();
  });

  it('adds a story from a search or catalog row without fetching it or touching the open story', async () => {
    const b = await makeBridge();
    const open = { ...story({ storyKey: 's_open', title: 'Open Story' }), chapters: [{ title: 'One', paragraphs: ['a'] }] };
    w.currentStory = open;
    w.loadStory = vi.fn();
    w.addToLibrary = vi.fn((data: any) => w.userProfile.library.push({ storyKey: 's_new', ...data }));
    const entry = await b.library.add(
      { kind: 'url', url: 'https://archiveofourown.org/works/77' },
      { key: 'https://archiveofourown.org/works/77', title: 'New One', author: 'B', source: 'ao3', url: 'https://archiveofourown.org/works/77', chapterCount: 3, words: 4200 },
    );
    expect(w.loadStory).not.toHaveBeenCalled();
    expect(w.currentStory).toBe(open);
    expect(entry.story).toMatchObject({ key: 's_new', title: 'New One' });
  });

  it('refuses to save another story offline while one is playing, instead of swapping it', async () => {
    const b = await makeBridge();
    w.currentStory = { ...story({ storyKey: 's_playing' }), chapters: [{ title: 'One', paragraphs: ['a'] }] };
    w.isPlaying = true;
    w.loadStory = vi.fn();
    await expect(b.startCaching('s_1')).rejects.toThrow(/Pause the story/);
    expect(w.loadStory).not.toHaveBeenCalled();
  });

  it('closes the open story when it is removed from the library', async () => {
    const b = await makeBridge();
    w.currentStory = { ...story(), chapters: [{ title: 'One', paragraphs: ['a'] }] };
    w.isPlaying = true;
    w.removeStory = vi.fn();
    w.releaseAudioSession = vi.fn();
    const closed: any[] = [];
    b.on('story-closed', (e) => closed.push(e));
    await b.library.remove('s_1');
    expect(w.currentStory).toBeNull();
    expect(w.isPlaying).toBe(false);
    expect(w.releaseAudioSession).toHaveBeenCalled();
    expect(closed).toEqual([{ storyKey: 's_1' }]);
    expect(b.getCurrentStory()).toBeNull();
  });

  it('marks a story as having new chapters when a check finds some, and clears it on open', async () => {
    const b = await makeBridge();
    w.checkStoryUpdate = vi.fn(async () => {
      w.userProfile.library[0].publishedChapters = 5;
    });
    const changed = await b.library.checkForUpdates('s_1');
    expect(changed).toEqual(['s_1']);
    expect((await b.library.list())[0].hasUpdate).toBe(true);
    fire(CORE_EVENT.STORY_OPENED, { story: { ...w.userProfile.library[0], chapters: [{ title: 'One', paragraphs: ['a'] }] } });
    expect((await b.library.list())[0].hasUpdate).toBe(false);
  });

  it('reports no change when a check finds nothing new', async () => {
    const b = await makeBridge();
    w.checkStoryUpdate = vi.fn(async () => {});
    expect(await b.library.checkForUpdates('s_1')).toEqual([]);
    expect((await b.library.list())[0].hasUpdate).toBe(false);
  });

  it('shows a tiered achievement as unlocked once any tier is', async () => {
    w.ACHIEVEMENTS_DB = [{ id: 'avid_listener', title: 'Avid Listener', desc: 'd', metric: 'hoursListened', tiers: [{ t: 'Bronze', v: 1 }, { t: 'Silver', v: 10 }] }];
    w.userProfile.achievements = [{ id: 'avid_listener_t0', unlockedAt: 1234 }];
    w.userProfile.stats = { hoursListened: 2 };
    const b = await makeBridge();
    const [a] = await b.listAchievements();
    expect(a.unlockedAt).toBe(1234);
    expect(a.tier).toBe('Bronze');
    expect(a.progress).toMatchObject({ target: 10, unit: 'hours' });
  });

  it('announces an achievement the cores unlock', async () => {
    w.ACHIEVEMENTS_DB = [{ id: 'first_book', title: 'First Edition', desc: 'd', metric: 'firstStory', target: 1 }];
    const b = await makeBridge();
    const seen: any[] = [];
    b.on('achievement', (a) => seen.push(a));
    w.queueAchievementUnlock({ ach_id: 'first_book', ach_title: 'First Edition', tier: '' });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.map((a) => a.id)).toEqual(['first_book']);
  });

  it('answers a paragraph change after the cores have started the next clip, not before', async () => {
    const b = await makeBridge();
    w.currentStory = { ...story(), chapters: [{ title: 'One', paragraphs: ['a', 'b'] }] };
    const seen: any[] = [];
    b.on('paragraph', (e) => seen.push(e));
    fire(CORE_EVENT.PARAGRAPH, {});
    // Still inside the cores' synchronous boundary: nothing has run yet.
    expect(seen).toHaveLength(0);
    await Promise.resolve();
    expect(seen).toHaveLength(1);
  });

  it('ends a timed sleep at the next paragraph when the page timer never fired', async () => {
    vi.useFakeTimers();
    try {
      const b = await makeBridge();
      w.currentStory = { ...story(), chapters: [{ title: 'One', paragraphs: ['a', 'b'] }] };
      w.isPlaying = true;
      w.pausePlayback = vi.fn(() => {
        w.isPlaying = false;
      });
      b.setSleepTimer({ kind: 'minutes', minutes: 15 });
      // A locked phone: the clock moves on, the timer does not run.
      vi.setSystemTime(Date.now() + 16 * 60_000);
      fire(CORE_EVENT.PARAGRAPH, {});
      await Promise.resolve();
      expect(w.pausePlayback).toHaveBeenCalled();
      expect(b.getPlayback().sleep).toEqual({ kind: 'off' });
    } finally {
      sessionStorage.removeItem('pr_v2_sleep_timer');
      vi.useRealTimers();
    }
  });

  it('keeps a sleep timer across the fast-narration reload', async () => {
    const endsAt = Date.now() + 10 * 60_000;
    sessionStorage.setItem('pr_v2_sleep_timer', JSON.stringify({ kind: 'minutes', minutes: 15, endsAt }));
    try {
      const b = await makeBridge();
      expect(b.getPlayback().sleep).toEqual({ kind: 'minutes', minutes: 15, endsAt });
      b.setSleepTimer({ kind: 'off' });
      expect(sessionStorage.getItem('pr_v2_sleep_timer')).toBeNull();
    } finally {
      sessionStorage.removeItem('pr_v2_sleep_timer');
    }
  });

  it('shows alerts as on only when this device is really subscribed', async () => {
    const b = await makeBridge();
    expect((await b.getSettings()).updateNotifications).toBe(false);
    w.userProfile.settings.pushUpdates = true;
    expect((await b.getSettings()).updateNotifications).toBe(true);
  });

  it('says when the device voice is narrating instead of the chosen engine', async () => {
    w._resolveActiveEngine = () => 'webspeech';
    const b = await makeBridge();
    expect(b.getEngineState().deviceVoice).toBe(true);
    w._resolveActiveEngine = () => 'kokoro';
    expect(b.getEngineState().deviceVoice).toBeUndefined();
  });

  it('routes the old interface names the cores still call to notices', async () => {
    const say = vi.fn();
    w.prCoreUi = { say, companion: vi.fn(), notify: vi.fn(), dialog: vi.fn() };
    delete w.virtueSpeak;
    try {
      await makeBridge();
      w.virtueSpeak('This story is complete.', 4000);
      expect(say).toHaveBeenCalledWith('This story is complete.', 4000);
    } finally {
      delete w.prCoreUi;
      delete w.virtueSpeak;
      delete w.triggerVirtue;
      delete w.pocketNotify;
      delete w.showSettingsModal;
    }
  });
});
