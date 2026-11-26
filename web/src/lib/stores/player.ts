import { derived, writable } from 'svelte/store';
import type { EngineState, PlayState, Position, SleepTimer, Story, VoiceId, EngineId } from '../core/bridge';

export interface PlayerState {
  story: Story | null;
  state: PlayState;
  position: Position;
  paragraphCount: number;
  chapterCount: number;
  speed: number;
  engine: EngineId;
  voice: VoiceId;
  sleep: SleepTimer;
  buffer: { ready: number; target: number };
  engineState: EngineState;
}

export const initialPlayer: PlayerState = {
  story: null,
  state: 'idle',
  position: { chapter: 0, paragraph: 0 },
  paragraphCount: 0,
  chapterCount: 0,
  speed: 1,
  engine: 'pocket',
  voice: 'alba',
  sleep: { kind: 'off' },
  buffer: { ready: 0, target: 0 },
  engineState: { engine: 'pocket', status: 'idle' },
};

export const player = writable<PlayerState>(initialPlayer);

export const isActive = derived(player, ($p) => $p.state === 'playing' || $p.state === 'buffering' || $p.state === 'loading');

/** True while the engine is downloading/warming before the first sound. */
export const preparing = derived(player, ($p) => $p.engineState.status === 'loading');

export const currentChapter = derived(player, ($p) => $p.story?.chapters[$p.position.chapter] ?? null);

/** Progress through the whole story, 0..1, by paragraph count. */
export const storyProgress = derived(player, ($p) => {
  const s = $p.story;
  if (!s) return 0;
  let total = 0;
  let before = 0;
  s.chapters.forEach((c, i) => {
    total += c.paragraphs.length;
    if (i < $p.position.chapter) before += c.paragraphs.length;
  });
  return total ? (before + $p.position.paragraph) / total : 0;
});
