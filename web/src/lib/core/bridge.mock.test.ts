import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockBridge } from './bridge.mock';
import { VOICES, type BridgeEventName, type CoreBridge } from './bridge';

const METHODS: (keyof CoreBridge)[] = [
  'getPlayback',
  'getCurrentStory',
  'loadStory',
  'importFile',
  'play',
  'pause',
  'togglePlay',
  'seekToParagraph',
  'seekToChapter',
  'skipParagraph',
  'skipChapter',
  'setSleepTimer',
  'saveBookmark',
  'listVoices',
  'setEngine',
  'setVoice',
  'setSpeed',
  'previewVoice',
  'getEngineState',
  'startCaching',
  'cancelCaching',
  'getSettings',
  'setSettings',
  'search',
  'exportBackup',
  'importBackup',
  'getStorageUsage',
  'clearAudioCache',
  'clearVoiceModels',
  'listAchievements',
  'getStats',
  'getDiagnostics',
  'runNoticeAction',
  'on',
];

function record(b: MockBridge, ...events: BridgeEventName[]) {
  const log: { event: BridgeEventName; payload: unknown }[] = [];
  events.forEach((event) => b.on(event, (payload) => log.push({ event, payload })));
  return log;
}

describe('MockBridge', () => {
  let b: MockBridge;
  beforeEach(() => {
    vi.useFakeTimers();
    b = new MockBridge({ latency: 0, paragraphMs: 1000 });
  });
  afterEach(() => {
    b.dispose();
    vi.useRealTimers();
  });

  it('implements every CoreBridge method plus the library and catalog APIs', () => {
    for (const m of METHODS) expect(typeof b[m], m).toBe('function');
    for (const m of ['list', 'add', 'remove', 'setFavourite', 'rate', 'setSubscribed', 'checkForUpdates', 'removeBookmark'] as const)
      expect(typeof b.library[m], `library.${m}`).toBe('function');
    expect(typeof b.catalog.facets).toBe('function');
    expect(typeof b.catalog.query).toBe('function');
  });

  it('offers exactly three female and three male voices per engine, and no Kitten', () => {
    for (const engine of ['pocket', 'kokoro'] as const) {
      const voices = b.listVoices(engine);
      expect(voices.filter((v) => v.gender === 'female')).toHaveLength(3);
      expect(voices.filter((v) => v.gender === 'male')).toHaveLength(3);
    }
    expect(VOICES.map((v) => v.engine).every((e) => e === 'pocket' || e === 'kokoro')).toBe(true);
  });

  it('resumes the most recent story at its saved position', () => {
    const snap = b.getPlayback();
    expect(snap.storyKey).toBe('mock-ferry-house');
    expect(snap.position).toEqual({ chapter: 6, paragraph: 4 });
    expect(snap.state).toBe('paused');
  });

  it('loadStory emits story-loaded then paragraph and updates the snapshot', async () => {
    const log = record(b, 'story-loaded', 'paragraph');
    const story = await b.loadStory({ kind: 'key', key: 'mock-orchard' }, { position: { chapter: 2, paragraph: 3 } });
    expect(story.title).toBe('An Orchard of Small Hours');
    expect(log.map((l) => l.event)).toEqual(['story-loaded', 'paragraph']);
    expect(b.getPlayback().position).toEqual({ chapter: 2, paragraph: 3 });
  });

  it('plays, advances paragraphs on a timer, and pauses', async () => {
    const states: string[] = [];
    b.on('playstate', (e) => states.push(e.state));
    await b.play();
    expect(states).toEqual(['buffering', 'playing']);
    vi.advanceTimersByTime(1000);
    expect(b.getPlayback().position.paragraph).toBe(5);
    b.pause();
    expect(b.getPlayback().state).toBe('paused');
    vi.advanceTimersByTime(5000);
    expect(b.getPlayback().position.paragraph).toBe(5);
  });

  it('warms a cold engine through loading stages before playing', async () => {
    const cold = new MockBridge({ latency: 0, engineReady: false });
    const stages: string[] = [];
    cold.on('engine', (e) => stages.push(e.status === 'loading' ? `loading:${e.stage}` : e.status));
    await cold.play();
    expect(stages[0]).toBe('loading:download');
    expect(stages).toContain('loading:first-paragraph');
    expect(stages.at(-1)).toBe('ready');
    expect(cold.getPlayback().state).toBe('playing');
    cold.dispose();
  });

  it('skipParagraph crosses chapter boundaries in both directions', async () => {
    const story = b.getCurrentStory()!;
    const last = story.chapters[6].paragraphs.length - 1;
    await b.seekToParagraph(last, 6);
    await b.skipParagraph(1);
    expect(b.getPlayback().position).toEqual({ chapter: 7, paragraph: 0 });
    await b.skipParagraph(-1);
    expect(b.getPlayback().position).toEqual({ chapter: 6, paragraph: last });
  });

  it('setVoice on the other engine switches engine first', async () => {
    const engines: string[] = [];
    b.on('engine', (e) => engines.push(`${e.engine}:${e.status}`));
    await b.setVoice('am_fenrir');
    const s = await b.getSettings();
    expect(s.engine).toBe('kokoro');
    expect(s.voice.kokoro).toBe('am_fenrir');
    expect(b.getPlayback().voice).toBe('am_fenrir');
    expect(engines.at(-1)).toBe('kokoro:ready');
  });

  it('end-of-chapter sleep timer pauses at the chapter end', async () => {
    const story = b.getCurrentStory()!;
    await b.seekToParagraph(story.chapters[6].paragraphs.length - 1, 6);
    b.setSleepTimer({ kind: 'end-of-chapter' });
    await b.play();
    vi.advanceTimersByTime(1000);
    expect(b.getPlayback().state).toBe('paused');
    expect(b.getPlayback().sleep.kind).toBe('off');
    expect(b.getPlayback().position.chapter).toBe(6);
  });

  it('saveBookmark stores the current paragraph on the library entry', async () => {
    const bm = await b.saveBookmark();
    expect(bm).toMatchObject({ chapter: 6, paragraph: 4, storyKey: 'mock-ferry-house' });
    const entry = (await b.library.list()).find((e) => e.story.key === 'mock-ferry-house')!;
    expect(entry.bookmarks[0].id).toBe(bm.id);
  });

  it('library changes emit the full list', async () => {
    const lists: number[] = [];
    b.on('library', (l) => lists.push(l.length));
    const before = (await b.library.list()).length;
    await b.library.setFavourite('mock-winter-garden', true);
    await b.library.remove('mock-winter-garden');
    expect(lists).toEqual([before, before - 1]);
  });

  it('caching reports progress through to complete', async () => {
    const states: string[] = [];
    b.on('caching-progress', (c) => states.push(c.state));
    await b.startCaching('mock-orchard');
    vi.advanceTimersByTime(30_000);
    expect(states[0]).toBe('caching');
    expect(states.at(-1)).toBe('complete');
  });

  it('search applies filters and pages', async () => {
    const page = await b.search({ query: 'x', completeOnly: true, rating: 'Teen' });
    expect(page.items.every((i) => i.complete && i.rating === 'Teen')).toBe(true);
    expect(page.hasMore).toBe(true);
  });

  it('catalog facets and queries agree', async () => {
    const facets = await b.catalog.facets();
    expect(facets.map((f) => f.key)).toEqual(['world', 'species', 'rating', 'status', 'length']);
    const all = await b.catalog.query({});
    const foxes = await b.catalog.query({ species: ['Fox'] });
    expect(foxes.items.length).toBe(facets[1].values.find((v) => v.value === 'Fox')!.count);
    expect(foxes.items.length).toBeLessThan(all.items.length);
  });

  it('rejects unsupported imports with a readable BridgeError', async () => {
    await expect(b.importFile(new File(['x'], 'photo.png'))).rejects.toMatchObject({ code: 'unsupported-file' });
  });
});
