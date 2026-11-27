import { afterEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { MockBridge } from '../core/bridge.mock';
import { connectStores } from './wire';
import { player } from './player';
import { library } from './library';
import { settings } from './settings';
import { ui } from './ui';

describe('connectStores', () => {
  let b: MockBridge;
  let off: () => void = () => {};
  afterEach(() => {
    off();
    b.dispose();
  });

  it('seeds every store from the bridge', async () => {
    b = new MockBridge({ latency: 0 });
    off = await connectStores(b);
    expect(get(player).story?.key).toBe('mock-ferry-house');
    expect(get(library).loaded).toBe(true);
    expect(get(library).entries.length).toBeGreaterThan(3);
    expect(get(settings)?.engine).toBe('pocket');
  });

  it('follows paragraph, settings, library and notice events', async () => {
    b = new MockBridge({ latency: 0 });
    off = await connectStores(b);
    await b.skipParagraph(1);
    expect(get(player).position).toEqual({ chapter: 6, paragraph: 5 });

    b.setSpeed(1.5);
    expect(get(player).speed).toBe(1.5);
    expect(get(settings)?.speed).toBe(1.5);

    await b.library.setFavourite('mock-orchard', true);
    expect(get(library).entries.find((e) => e.story.key === 'mock-orchard')?.favourite).toBe(true);
    expect(get(ui).toasts.some((t) => t.message === 'Added to favourites')).toBe(true);
  });

  it('shows a story as pending while it opens, then as the current story', async () => {
    b = new MockBridge({ latency: 0 });
    off = await connectStores(b);
    expect(get(player).pending).toBeNull();
    const loading = b.loadStory({ kind: 'key', key: 'mock-orchard' }, { title: 'An Orchard of Small Hours' });
    expect(get(player).pending).toEqual({ title: 'An Orchard of Small Hours' });
    await loading;
    expect(get(player).pending).toBeNull();
    expect(get(player).story?.key).toBe('mock-orchard');
  });
});
