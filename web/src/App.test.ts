import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import App from './App.svelte';
import { setBridge } from './lib/core';
import { MockBridge } from './lib/core/bridge.mock';
import { connectStores } from './lib/stores/wire';
import { ui } from './lib/stores/ui';

let b: MockBridge;
let off: () => void;

async function boot(opts: ConstructorParameters<typeof MockBridge>[0] = {}) {
  b = new MockBridge({ latency: 0, ...opts });
  setBridge(b);
  off = await connectStores(b);
  ui.update((u) => ({ ...u, tab: 'listen', playerMode: 'listen', sheet: null, settingsStack: ['root'], toasts: [] }));
  return render(App);
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
});
afterEach(() => {
  cleanup();
  off?.();
  b?.dispose();
});

describe('App shell', () => {
  it('shows five tabs, with a dedicated Player, and the mini-player', async () => {
    await boot();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const tabs = Array.from(nav.querySelectorAll('.lbl')).map((t) => t.textContent?.trim());
    expect(tabs).toEqual(['Home', 'Library', 'Player', 'Discover', 'Settings']);
    expect(screen.getByRole('region', { name: 'Now playing' })).toBeTruthy();
  });

  it('switches tabs', async () => {
    await boot();
    const nav = within(screen.getByRole('navigation', { name: 'Main' }));
    await fireEvent.click(nav.getByRole('button', { name: /Library/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Library' })).toBeTruthy();
    await fireEvent.click(nav.getByRole('button', { name: 'Discover' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Discover' })).toBeTruthy();
    await fireEvent.click(nav.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
  });

  it('the mini-player opens the Player tab with the current paragraph marked', async () => {
    await boot();
    await fireEvent.click(screen.getByRole('button', { name: /Open player for/ }));
    const pane = await screen.findByRole('region', { name: 'Story text' });
    expect(pane.querySelector('[aria-current="true"]')?.textContent).toBe(b.getCurrentStory()!.chapters[6].paragraphs[4]);
    // The mini-player is redundant on the Player itself.
    expect(screen.queryByRole('button', { name: /Open player for/ })).toBeNull();
    const nav = within(screen.getByRole('navigation', { name: 'Main' }));
    expect(nav.getByRole('button', { name: 'Player' }).getAttribute('aria-current')).toBe('page');
  });

  it('the Player switches between listening and reading', async () => {
    await boot();
    await fireEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Player' }));
    await fireEvent.click(await screen.findByRole('radio', { name: 'Read' }));
    expect(await screen.findByRole('button', { name: 'Text size and font' })).toBeTruthy();
    expect(document.querySelector('.narrating')?.textContent).toBe(b.getCurrentStory()!.chapters[6].paragraphs[4]);
    await fireEvent.click(screen.getByRole('radio', { name: 'Listen' }));
    expect(await screen.findByRole('region', { name: 'Story text' })).toBeTruthy();
  });

  it('shows one-screen onboarding with no sign-in, and choosing a mode finishes it', async () => {
    await boot({ onboarded: false });
    const dialog = await screen.findByRole('dialog', { name: 'Stories, read aloud.' });
    expect(dialog.textContent).not.toMatch(/sign in with|log in|create account|password|email/i);
    await fireEvent.click(screen.getByRole('button', { name: /Read/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Stories, read aloud.' })).toBeNull());
    expect((await b.getSettings()).defaultMode).toBe('read');
  });

  it('applies an explicit dark theme to the document', async () => {
    await boot();
    await b.setSettings({ theme: 'dark' });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
  });
});

describe('removed features stay removed', () => {
  const FORBIDDEN = /away mode|kitten|sign in|log in|log out|sign out|cloud sync|sync now|profile/i;

  it('no tab or settings page renders Away mode, accounts, sync or Kitten', async () => {
    await boot();
    for (const tab of ['listen', 'library', 'discover', 'settings'] as const) {
      ui.update((u) => ({ ...u, tab }));
      await new Promise((r) => setTimeout(r, 0));
      expect(document.body.textContent ?? '', tab).not.toMatch(FORBIDDEN);
    }
    for (const page of ['voice', 'pronunciation', 'display', 'storage', 'backup', 'about', 'diagnostics'] as const) {
      ui.update((u) => ({ ...u, tab: 'settings', settingsStack: ['root', page] }));
      await new Promise((r) => setTimeout(r, 0));
      expect(document.body.textContent ?? '', page).not.toMatch(FORBIDDEN);
    }
  });

  it('no UI source mentions Kitten or Away mode outside the bridge contract comment', () => {
    const root = join(__dirname);
    const files: string[] = [];
    const walk = (d: string) =>
      readdirSync(d).forEach((f) => {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(svelte|ts)$/.test(f) && !f.endsWith('.test.ts')) files.push(p);
      });
    walk(root);
    const hits = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      const code = f.endsWith('bridge.ts') ? src.replace(/\/\*[\s\S]*?\*\//g, '') : src;
      return /kitten|away ?mode|supabase|sync_core/i.test(code);
    });
    expect(hits).toEqual([]);
  });
});
