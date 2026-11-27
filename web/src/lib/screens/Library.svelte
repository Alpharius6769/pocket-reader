<script lang="ts">
  import Search from '@lucide/svelte/icons/search';
  import LayoutGrid from '@lucide/svelte/icons/layout-grid';
  import List from '@lucide/svelte/icons/list';
  import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
  import Heart from '@lucide/svelte/icons/heart';
  import CloudDownload from '@lucide/svelte/icons/cloud-download';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import X from '@lucide/svelte/icons/x';
  import { library, matchesFilter, sortEntries, type LibraryFilter, type LibrarySort } from '../stores/library';
  import { ui, openSheet } from '../stores/ui';
  import { percent } from '../format';
  import Cover from '../components/Cover.svelte';

  let query = $state('');
  let filter = $state<LibraryFilter>('all');
  let sort = $state<LibrarySort>('recent');

  const FILTERS: { id: LibraryFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'listening', label: 'Listening' },
    { id: 'unread', label: 'Not started' },
    { id: 'finished', label: 'Finished' },
    { id: 'favourites', label: 'Favourites' },
    { id: 'offline', label: 'Offline' },
    { id: 'updates', label: 'New chapters' },
  ];
  const SORTS: { id: LibrarySort; label: string }[] = [
    { id: 'recent', label: 'Recently played' },
    { id: 'added', label: 'Recently added' },
    { id: 'title', label: 'Title' },
    { id: 'author', label: 'Author' },
    { id: 'progress', label: 'Progress' },
  ];

  const counts = $derived(Object.fromEntries(FILTERS.map((f) => [f.id, $library.entries.filter((e) => matchesFilter(e, f.id)).length])));
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const list = $library.entries.filter(
      (e) => matchesFilter(e, filter) && (!q || e.story.title.toLowerCase().includes(q) || e.story.author.toLowerCase().includes(q)),
    );
    return sortEntries(list, sort);
  });
  const view = $derived($ui.libraryView);

  function setView(v: 'grid' | 'list') {
    ui.update((u) => ({ ...u, libraryView: v }));
  }

  function status(e: (typeof shown)[number]) {
    if (e.finished) return 'Finished';
    if (e.progress === 0) return 'Not started';
    return `${percent(e.progress)} · Ch. ${e.position.chapter + 1} of ${e.story.chapterCount}`;
  }
</script>

<main class="screen" aria-labelledby="lib-title">
  <header class="head">
    <h1 class="large-title" id="lib-title">Library</h1>
    <div class="tools">
      <label class="icon-btn sort" aria-label="Sort by">
        <ArrowUpDown size={22} />
        <select bind:value={sort} aria-label="Sort by">
          {#each SORTS as s (s.id)}<option value={s.id}>{s.label}</option>{/each}
        </select>
      </label>
      <button
        class="icon-btn"
        type="button"
        aria-label={view === 'grid' ? 'Show as list' : 'Show as grid'}
        onclick={() => setView(view === 'grid' ? 'list' : 'grid')}
      >
        {#if view === 'grid'}<List size={22} />{:else}<LayoutGrid size={22} />{/if}
      </button>
    </div>
  </header>

  <label class="field search">
    <Search size={18} />
    <input type="search" placeholder="Title or author" bind:value={query} enterkeyhint="search" aria-label="Search your library" />
    {#if query}
      <button class="clear" type="button" aria-label="Clear search" onclick={() => (query = '')}><X size={16} /></button>
    {/if}
  </label>

  <div class="h-scroll chips" role="toolbar" aria-label="Filter">
    {#each FILTERS as f (f.id)}
      {#if f.id === 'all' || counts[f.id]}
        <button type="button" class="chip" aria-pressed={filter === f.id} onclick={() => (filter = f.id)}>
          {f.label}{#if f.id !== 'all'}<span class="n">{counts[f.id]}</span>{/if}
        </button>
      {/if}
    {/each}
  </div>

  <p class="sr-only" aria-live="polite">{shown.length} stories</p>

  {#if !shown.length}
    <div class="none">
      <p>{query ? `Nothing matches “${query}”.` : 'No stories here yet.'}</p>
    </div>
  {:else if view === 'grid'}
    <ul class="grid">
      {#each shown as e (e.story.key)}
        <li>
          <button type="button" class="tile" onclick={() => openSheet({ kind: 'story', key: e.story.key })} aria-label="{e.story.title} by {e.story.author}, {status(e)}">
            <span class="cv">
              <Cover story={e.story} size="fluid" />
              {#if e.hasUpdate}<span class="new">New</span>{/if}
              <span class="marks">
                {#if e.favourite}<span class="mark"><Heart size={12} fill="currentColor" /></span>{/if}
                {#if e.cache.state === 'complete'}<span class="mark"><CloudDownload size={12} /></span>{/if}
              </span>
            </span>
            {#if e.progress > 0 && !e.finished}
              <span class="progress-track"><span style:width={percent(e.progress)}></span></span>
            {/if}
            <span class="tt">{e.story.title}</span>
            <span class="ta">{e.finished ? 'Finished' : e.story.author}</span>
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <ul class="list card">
      {#each shown as e (e.story.key)}
        <li>
          <button type="button" class="lrow" onclick={() => openSheet({ kind: 'story', key: e.story.key })}>
            <Cover story={e.story} size={46} plain />
            <span class="lt">
              <span class="t">{e.story.title}{#if e.hasUpdate}&nbsp;<span class="dot" aria-label="New chapters"></span>{/if}</span>
              <span class="a">{e.story.author}</span>
              <span class="s">
                {status(e)}
                {#if e.favourite}<Heart size={12} fill="currentColor" />{/if}
                {#if e.cache.state === 'complete'}<CloudDownload size={12} />{/if}
              </span>
            </span>
            <span class="more" aria-hidden="true"><Ellipsis size={20} /></span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</main>

<style>
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .tools {
    display: flex;
    gap: 2px;
    margin-right: -10px;
  }
  .sort {
    position: relative;
    overflow: hidden;
  }
  .sort select {
    position: absolute;
    inset: 0;
    opacity: 0;
    font-size: 16px;
  }
  .search {
    margin-bottom: 10px;
  }
  .search input::-webkit-search-cancel-button {
    display: none;
  }
  .clear {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    margin-right: -6px;
    color: var(--ink-3);
  }
  .chips {
    gap: 8px;
    padding-bottom: 8px;
  }
  .n {
    font-variant-numeric: tabular-nums;
    opacity: 0.6;
    font-size: var(--t-foot);
  }
  .none {
    padding: 48px 0;
    text-align: center;
    color: var(--ink-2);
  }
  .grid {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: grid;
    /* Four across on a phone (~76 px covers on a 393 pt iPhone); three was
       too large a card for a shelf people scroll. */
    grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
    gap: 16px 10px;
  }
  .tile {
    display: grid;
    gap: 6px;
    width: 100%;
    text-align: left;
    align-content: start;
  }
  .cv {
    position: relative;
    display: block;
  }
  .new {
    position: absolute;
    top: 6px;
    right: 6px;
    padding: 2px 7px;
    border-radius: 99px;
    background: var(--accent);
    color: var(--accent-on);
    font-size: 0.6875rem;
    font-weight: 700;
  }
  .marks {
    position: absolute;
    left: 8px;
    top: 6px;
    display: flex;
    gap: 4px;
  }
  .mark {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: rgb(0 0 0 / 0.45);
    color: #fff;
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
  }
  .tile .progress-track {
    height: 3px;
  }
  .tt {
    font-size: var(--t-foot);
    font-weight: 600;
    line-height: 1.25;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .ta {
    font-size: var(--t-caption);
    color: var(--ink-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: -4px;
  }
  .list {
    list-style: none;
    margin: 8px 0 0;
    padding: 0 0 0 14px;
  }
  .list li + li .lrow {
    border-top: 0.5px solid var(--line);
  }
  .lrow {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 76px;
    padding: 8px 8px 8px 0;
    text-align: left;
  }
  .lt {
    flex: 1;
    min-width: 0;
    display: grid;
  }
  .lt .t {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .lt .a {
    font-size: var(--t-foot);
    color: var(--ink-2);
  }
  .lt .s {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--t-caption);
    color: var(--ink-3);
    margin-top: 2px;
  }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    vertical-align: middle;
  }
  .more {
    color: var(--ink-3);
  }
</style>
