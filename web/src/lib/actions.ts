/**
 * UI actions: thin wrappers over the bridge that turn failures into toasts
 * and coordinate UI state (open Now Playing after a load, etc.).
 */
import { get } from 'svelte/store';
import { bridge, BridgeError, type StoryRef, type Settings, type LoadOptions } from './core';
import { settings } from './stores/settings';
import { openNowPlaying, openReader, toast, say } from './stores/ui';

export async function attempt<T>(fn: () => Promise<T>, fallback = 'Something went wrong. Please try again.'): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof BridgeError ? err.message : fallback;
    toast({ level: 'error', message, mood: 'annoyed' });
    return undefined;
  }
}

/** Open a story the way the reader prefers (listen or read). */
export async function openStory(ref: StoryRef, opts: LoadOptions & { mode?: 'listen' | 'read' } = {}) {
  const mode = opts.mode ?? get(settings)?.defaultMode ?? 'listen';
  say('loading', null);
  const story = await attempt(() => bridge().loadStory(ref, { position: opts.position, autoplay: mode === 'listen' && opts.autoplay !== false }));
  if (!story) return;
  if (mode === 'read') openReader(true);
  else openNowPlaying(true);
  say('holding', null);
}

export async function resumeOrPlay(key: string) {
  const current = bridge().getCurrentStory();
  if (current?.key === key) {
    await attempt(() => bridge().togglePlay());
    return;
  }
  await attempt(() => bridge().loadStory({ kind: 'key', key }, { autoplay: true }));
}

export async function updateSettings(patch: Partial<Settings>) {
  const next = await attempt(() => bridge().setSettings(patch));
  if (next) settings.set(next);
  return next;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Light haptic tick where supported (Android Chrome; iOS ignores vibrate). */
export function tick() {
  try {
    navigator.vibrate?.(8);
  } catch {
    /* unsupported */
  }
}
