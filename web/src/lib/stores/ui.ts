import { writable, get } from 'svelte/store';
import type { Ao3Query, Ao3Result, Notice, StoryKey, VirtueMood, StorySummary } from '../core/bridge';

/** 'listen' is the Home screen; 'player' is the dedicated listen/read page. */
export type Tab = 'listen' | 'library' | 'player' | 'discover' | 'settings';
export type PlayerMode = 'listen' | 'read';

/** Settings sub-pages, pushed onto a stack like iOS navigation. */
export type SettingsPage = 'root' | 'voice' | 'pronunciation' | 'display' | 'storage' | 'backup' | 'about' | 'diagnostics';

/** Bottom sheets. Only one is open at a time; they stack above Now Playing. */
export type SheetState =
  | { kind: 'story'; key: StoryKey }
  | { kind: 'preview'; story: StorySummary }
  | { kind: 'chapters'; tab: 'chapters' | 'bookmarks' }
  | { kind: 'voice' }
  | { kind: 'sleep' }
  | { kind: 'ao3-filters' }
  | { kind: 'install' }
  | null;

export interface UiState {
  tab: Tab;
  playerMode: PlayerMode;
  sheet: SheetState;
  settingsStack: SettingsPage[];
  discoverMode: 'search' | 'catalog' | 'import';
  libraryView: 'grid' | 'list';
  toasts: Notice[];
  virtue: { mood: VirtueMood; line: string | null; at: number };
  /** AO3 search form + results, kept across tab switches. */
  ao3: {
    query: Ao3Query;
    results: Ao3Result[];
    page: number;
    hasMore: boolean;
    total?: number;
    loading: boolean;
    searched: boolean;
  };
}

// The tab survives the one-time fast-narration reload (?tts_fast=1), which
// would otherwise land a reader who pressed Play back on Home.
const TAB_KEY = 'pr_v2_tab';
function savedTab(): { tab: Tab; playerMode: PlayerMode } {
  try {
    const saved = JSON.parse(sessionStorage.getItem(TAB_KEY) || 'null');
    if (saved && ['listen', 'library', 'player', 'discover', 'settings'].includes(saved.tab)) {
      return { tab: saved.tab, playerMode: saved.playerMode === 'read' ? 'read' : 'listen' };
    }
  } catch {
    /* private mode or no storage */
  }
  return { tab: 'listen', playerMode: 'listen' };
}

export const ui = writable<UiState>({
  ...savedTab(),
  sheet: null,
  settingsStack: ['root'],
  discoverMode: 'search',
  libraryView: 'grid',
  toasts: [],
  virtue: { mood: 'waving', line: null, at: 0 },
  ao3: {
    query: { query: '', rating: 'Any', completeOnly: false, sort: 'revised_at' },
    results: [],
    page: 0,
    hasMore: false,
    loading: false,
    searched: false,
  },
});

export function activeFilterCount(q: Ao3Query) {
  return [q.fandom, q.rating && q.rating !== 'Any', q.completeOnly, q.wordsMin, q.wordsMax, q.language, q.sort && q.sort !== 'revised_at'].filter(Boolean).length;
}

ui.subscribe((u) => {
  try {
    sessionStorage.setItem(TAB_KEY, JSON.stringify({ tab: u.tab, playerMode: u.playerMode }));
  } catch {
    /* ignore */
  }
});

export function setTab(tab: Tab) {
  ui.update((u) => (u.tab === tab && tab === 'settings' ? { ...u, settingsStack: ['root'] } : { ...u, tab }));
}

/** The Player tab in a given mode. */
export function openPlayer(mode?: PlayerMode) {
  ui.update((u) => ({ ...u, tab: 'player', playerMode: mode ?? u.playerMode, sheet: null }));
}

export function setPlayerMode(mode: PlayerMode) {
  ui.update((u) => ({ ...u, playerMode: mode }));
}

// Now Playing and the Reader used to be full-screen overlays; they are the
// Player tab's two modes now. Kept so every caller reads the same.
export function openNowPlaying(open = true) {
  if (open) openPlayer('listen');
}

export function openReader(open = true) {
  if (open) openPlayer('read');
}

export function openSheet(sheet: SheetState) {
  ui.update((u) => ({ ...u, sheet }));
}

export function closeSheet() {
  ui.update((u) => ({ ...u, sheet: null }));
}

export function pushSettings(page: SettingsPage) {
  ui.update((u) => ({ ...u, settingsStack: [...u.settingsStack, page] }));
}

export function popSettings() {
  ui.update((u) => ({ ...u, settingsStack: u.settingsStack.length > 1 ? u.settingsStack.slice(0, -1) : u.settingsStack }));
}

const TOAST_MS = 3200;

export function toast(notice: Omit<Notice, 'id'> & { id?: string }) {
  const n: Notice = { id: notice.id ?? `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ...notice };
  ui.update((u) => ({ ...u, toasts: [...u.toasts.filter((t) => t.message !== n.message), n].slice(-3) }));
  // A toast with an action is waiting on the reader (the post-reload "Start
  // narration" tap); it stays until used or replaced, not 3 s.
  // Long enough to read: some of these are whole sentences from the cores.
  const reading = Math.min(9000, Math.max(0, n.message.length - 60) * 45);
  if (!n.actionLabel) setTimeout(() => dismissToast(n.id), (n.level === 'error' ? TOAST_MS * 1.6 : TOAST_MS) + reading);
  if (n.mood) say(n.mood, null);
}

export function dismissToast(id: string) {
  ui.update((u) => ({ ...u, toasts: u.toasts.filter((t) => t.id !== id) }));
}

/** Playback started some other way: an action toast asking for it is stale. */
export function dismissActionToasts() {
  ui.update((u) => (u.toasts.some((t) => t.actionLabel) ? { ...u, toasts: u.toasts.filter((t) => !t.actionLabel) } : u));
}

/** Ask Virtue to change mood and (optionally) say something. */
export function say(mood: VirtueMood, line: string | null) {
  ui.update((u) => ({ ...u, virtue: { mood, line, at: Date.now() } }));
}

export function currentTab() {
  return get(ui).tab;
}
