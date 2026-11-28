/**
 * Deep links for development and design review, e.g. `#library/list`,
 * `#now-playing/chapters`, `#settings/storage`, `#story/mock-ferry-house`.
 * Applied once at startup; the app does not otherwise route by URL.
 */
import { get } from 'svelte/store';
import { bridge } from './core';
import { ui, toast, type SettingsPage, type Tab, type UiState } from './stores/ui';

export async function applyDeepLink(hash: string, params: URLSearchParams) {
  const [head, sub, arg] = hash.replace(/^#\/?/, '').split('/');
  const set = (patch: Partial<UiState>) => ui.update((u) => ({ ...u, ...patch }));

  switch (head) {
    case 'listen':
    case 'library':
    case 'discover':
    case 'settings':
      set({ tab: head as Tab });
      break;
  }

  if (head === 'library' && sub === 'list') set({ libraryView: 'list' });
  if (head === 'discover' && (sub === 'catalog' || sub === 'import')) set({ discoverMode: sub });
  if (head === 'discover' && sub === 'results') {
    const res = await bridge().search({ query: 'lighthouse', page: 1 });
    set({ ao3: { ...get(ui).ao3, query: { ...get(ui).ao3.query, query: 'lighthouse' }, results: res.items, page: 1, hasMore: res.hasMore, total: res.total, searched: true } });
  }
  if (head === 'discover' && sub === 'filters') set({ sheet: { kind: 'ao3-filters' } });
  if (head === 'settings' && sub) set({ settingsStack: sub === 'diagnostics' ? ['root', 'about', 'diagnostics'] : ['root', sub as SettingsPage] });
  if (head === 'settings' && sub === 'sleep') set({ settingsStack: ['root'], sheet: { kind: 'sleep' } });

  if (head === 'now-playing') {
    set({ tab: 'player', playerMode: 'listen' });
    if (sub === 'chapters' || sub === 'bookmarks') set({ sheet: { kind: 'chapters', tab: sub } });
    if (sub === 'voice') set({ sheet: { kind: 'voice' } });
    if (sub === 'sleep') set({ sheet: { kind: 'sleep' } });
    if (sub === 'playing' || sub === 'preparing') void bridge().play();
  }
  if (head === 'reader') set({ tab: 'player', playerMode: 'read' });
  if (head === 'story' && sub) set({ sheet: { kind: 'story', key: decodeURIComponent(sub) } });
  if (head === 'preview') {
    const res = await bridge().search({ query: '', page: 1 });
    set({ sheet: { kind: 'preview', story: res.items[Number(sub ?? 0)] ?? res.items[0] } });
  }
  if (head === 'catalog-preview') {
    const res = await bridge().catalog.query({});
    set({ tab: 'discover', discoverMode: 'catalog', sheet: { kind: 'preview', story: res.items[0] } });
  }
  void arg;

  // A link that goes straight to installing: .../pocket-reader/?install=1
  if (params.get('install') === '1') set({ sheet: { kind: 'install' } });

  if (params.get('toast')) {
    toast({ level: 'success', message: params.get('toast') === '1' ? 'Bookmark saved' : params.get('toast')!, mood: 'favorite' });
  }
}
