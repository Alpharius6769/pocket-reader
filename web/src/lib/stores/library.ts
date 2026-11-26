import { derived, writable } from 'svelte/store';
import type { LibraryEntry } from '../core/bridge';

export const library = writable<{ entries: LibraryEntry[]; loaded: boolean }>({ entries: [], loaded: false });

/** Most recently opened first; never-opened stories are excluded. */
export const recent = derived(library, ($l) =>
  $l.entries
    .filter((e) => e.lastOpenedAt)
    .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)),
);

export const inProgress = derived(recent, ($r) => $r.filter((e) => !e.finished && e.progress > 0));

export type LibraryFilter = 'all' | 'listening' | 'unread' | 'finished' | 'favourites' | 'offline' | 'updates';

export function matchesFilter(e: LibraryEntry, f: LibraryFilter) {
  switch (f) {
    case 'listening':
      return !e.finished && e.progress > 0;
    case 'unread':
      return e.progress === 0 && !e.finished;
    case 'finished':
      return e.finished;
    case 'favourites':
      return e.favourite;
    case 'offline':
      return e.cache.state === 'complete';
    case 'updates':
      return e.hasUpdate;
    default:
      return true;
  }
}

export type LibrarySort = 'recent' | 'title' | 'author' | 'added' | 'progress';

export function sortEntries(entries: LibraryEntry[], sort: LibrarySort) {
  const list = [...entries];
  switch (sort) {
    case 'title':
      return list.sort((a, b) => a.story.title.localeCompare(b.story.title));
    case 'author':
      return list.sort((a, b) => a.story.author.localeCompare(b.story.author));
    case 'added':
      return list.sort((a, b) => b.addedAt - a.addedAt);
    case 'progress':
      return list.sort((a, b) => b.progress - a.progress);
    default:
      return list.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) || b.addedAt - a.addedAt);
  }
}
