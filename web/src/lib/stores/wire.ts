/**
 * Connects CoreBridge events to the Svelte stores. This is the only place
 * bridge events are subscribed; components read stores and call `actions`.
 */
import type { CoreBridge } from '../core/bridge';
import { player, initialPlayer } from './player';
import { library } from './library';
import { settings } from './settings';
import { toast, dismissActionToasts } from './ui';

export async function connectStores(b: CoreBridge): Promise<() => void> {
  const snap = b.getPlayback();
  player.set({
    ...initialPlayer,
    story: b.getCurrentStory(),
    state: snap.state,
    position: snap.position,
    paragraphCount: snap.paragraphCount,
    chapterCount: snap.chapterCount,
    speed: snap.speed,
    engine: snap.engine,
    voice: snap.voice,
    sleep: snap.sleep,
    engineState: b.getEngineState(),
  });

  const offs = [
    b.on('paragraph', (e) =>
      player.update((p) =>
        p.story && p.story.key !== e.storyKey
          ? p
          : { ...p, position: e.position, paragraphCount: e.paragraphCount, chapterCount: e.chapterCount },
      ),
    ),
    b.on('playstate', (e) => {
      player.update((p) => ({ ...p, state: e.state }));
      if (e.state === 'playing' || e.state === 'loading') dismissActionToasts();
    }),
    b.on('buffer', (e) => player.update((p) => ({ ...p, buffer: { ready: e.ready, target: e.target } }))),
    b.on('engine', (e) => player.update((p) => ({ ...p, engineState: e, engine: e.engine }))),
    b.on('story-loaded', (e) =>
      player.update((p) => ({
        ...p,
        story: e.story,
        position: e.position,
        chapterCount: e.story.chapters.length,
        paragraphCount: e.story.chapters[e.position.chapter]?.paragraphs.length ?? 0,
      })),
    ),
    b.on('sleep', (s) => player.update((p) => ({ ...p, sleep: s }))),
    b.on('speed', (s) => player.update((p) => ({ ...p, speed: s.speed }))),
    b.on('settings', (s) => {
      settings.set(s);
      player.update((p) => ({ ...p, engine: s.engine, voice: s.voice[s.engine], speed: s.speed }));
    }),
    b.on('library', (entries) => library.set({ entries, loaded: true })),
    b.on('caching-progress', (c) =>
      library.update((l) => ({
        ...l,
        entries: l.entries.map((e) =>
          e.story.key === c.storyKey ? { ...e, cache: { state: c.state, done: c.done, total: c.total } } : e,
        ),
      })),
    ),
    b.on('notice', (n) => toast(n)),
    b.on('achievement', (a) => toast({ level: 'success', message: `Achievement unlocked: ${a.title}`, mood: 'achievement' })),
  ];

  const [s, entries] = await Promise.all([b.getSettings(), b.library.list()]);
  settings.set(s);
  library.set({ entries, loaded: true });

  return () => offs.forEach((off) => off());
}
