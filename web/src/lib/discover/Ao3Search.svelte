<script lang="ts">
  import Search from '@lucide/svelte/icons/search';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import X from '@lucide/svelte/icons/x';
  import { bridge } from '../core';
  import { attempt } from '../actions';
  import { ui, openSheet, say, activeFilterCount } from '../stores/ui';
  import ResultRow from './ResultRow.svelte';
  import Virtue from '../components/Virtue.svelte';

  const SUGGESTIONS = ['Slow burn', 'Found family', 'Cozy', 'Adventure', 'Hurt/Comfort', 'Mystery'];

  async function run(page = 1) {
    patch({ loading: true });
    if (page === 1) say('point', null);
    const res = await attempt(() => bridge().search({ ...$ui.ao3.query, page }));
    const s = $ui.ao3;
    patch({
      loading: false,
      searched: true,
      results: res ? (page === 1 ? res.items : [...s.results, ...res.items]) : s.results,
      page: res?.page ?? s.page,
      hasMore: res?.hasMore ?? false,
      total: res?.total,
    });
  }

  function patch(p: Partial<typeof $ui.ao3>) {
    ui.update((u) => ({ ...u, ao3: { ...u.ao3, ...p } }));
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur();
    void run(1);
  }

  function suggest(q: string) {
    patch({ query: { ...$ui.ao3.query, query: q } });
    void run(1);
  }

  const filters = $derived(activeFilterCount($ui.ao3.query));
</script>

<form class="bar" role="search" onsubmit={submit}>
  <label class="field grow">
    <Search size={18} />
    <input
      type="search"
      placeholder="Search Archive of Our Own"
      enterkeyhint="search"
      aria-label="Search Archive of Our Own"
      bind:value={$ui.ao3.query.query}
    />
    {#if $ui.ao3.query.query}
      <button class="clear" type="button" aria-label="Clear" onclick={() => ($ui.ao3.query.query = '')}><X size={16} /></button>
    {/if}
  </label>
  <button type="button" class="icon-btn filt" class:on={filters > 0} aria-label="Filters{filters ? `, ${filters} active` : ''}" onclick={() => openSheet({ kind: 'ao3-filters' })}>
    <SlidersHorizontal size={20} />
    {#if filters}<span class="fc">{filters}</span>{/if}
  </button>
</form>

{#if !$ui.ao3.searched && !$ui.ao3.loading}
  <section class="intro">
    <div class="intro-text">
      <p class="lead">Find something new to listen to.</p>
      <p class="muted">Search by title, author, fandom or tag. Tap a result to preview it, then listen right away or save it.</p>
    </div>
    <Virtue mood="point" height={190} crop={0.53} />
  </section>
  <h2 class="eyebrow try">Try</h2>
  <div class="sugg">
    {#each SUGGESTIONS as s (s)}<button type="button" class="chip" onclick={() => suggest(s)}>{s}</button>{/each}
  </div>
{:else}
  {#if $ui.ao3.total != null && !$ui.ao3.loading}
    <p class="count faint" aria-live="polite">{$ui.ao3.total.toLocaleString()} works found</p>
  {/if}
  <ul class="results">
    {#each $ui.ao3.results as r (r.key)}
      <li><ResultRow story={r} onclick={() => openSheet({ kind: 'preview', story: r })} /></li>
    {/each}
    {#if $ui.ao3.loading}
      {#each [0, 1, 2] as i (i)}
        <li class="ghost" aria-hidden="true"><span class="gc"></span><span class="gl"><span></span><span></span><span></span></span></li>
      {/each}
    {/if}
  </ul>
  {#if $ui.ao3.hasMore && !$ui.ao3.loading}
    <button class="btn btn-plain btn-block more" type="button" onclick={() => run($ui.ao3.page + 1)}>Load more</button>
  {/if}
  {#if $ui.ao3.searched && !$ui.ao3.loading && !$ui.ao3.results.length}
    <p class="none muted">No works match. Try fewer filters.</p>
  {/if}
{/if}

<style>
  .bar {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .grow {
    flex: 1;
  }
  .grow input::-webkit-search-cancel-button {
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
  .filt {
    position: relative;
    background: var(--bg-sunk);
    border-radius: 12px;
  }
  .filt.on {
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .fc {
    position: absolute;
    top: 4px;
    right: 4px;
    min-width: 16px;
    height: 16px;
    border-radius: 8px;
    background: var(--accent);
    color: var(--accent-on);
    font-size: 0.625rem;
    font-weight: 800;
    line-height: 16px;
    text-align: center;
  }
  .intro {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    margin-top: 18px;
    padding: 16px 0 0 16px;
    border-radius: var(--r-lg);
    background: var(--hoodie-soft);
    overflow: hidden;
  }
  .intro-text {
    flex: 1;
    align-self: center;
    padding-bottom: 16px;
  }
  .lead {
    font-family: var(--font-read);
    font-size: var(--t-title3);
    font-weight: 600;
    line-height: 1.25;
    margin-bottom: 6px;
  }
  .intro .muted {
    font-size: var(--t-foot);
  }
  .try {
    margin: 22px 0 10px;
  }
  .sugg {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .count {
    font-size: var(--t-foot);
    margin: 12px 0 0;
  }
  .results {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .results li + li {
    border-top: 0.5px solid var(--line);
  }
  .ghost {
    display: flex;
    gap: 14px;
    padding: 14px 0;
  }
  .gc {
    width: 56px;
    height: 84px;
    border-radius: 6px;
    background: var(--bg-sunk);
  }
  .gl {
    flex: 1;
    display: grid;
    gap: 8px;
    align-content: start;
    padding-top: 4px;
  }
  .gl span {
    height: 12px;
    border-radius: 6px;
    background: var(--bg-sunk);
    animation: shimmer 1.2s ease-in-out infinite alternate;
  }
  .gl span:nth-child(1) {
    width: 70%;
    height: 15px;
  }
  .gl span:nth-child(2) {
    width: 45%;
  }
  .gl span:nth-child(3) {
    width: 90%;
  }
  @keyframes shimmer {
    to {
      opacity: 0.45;
    }
  }
  .more {
    margin-top: 8px;
  }
  .none {
    padding: 32px 0;
    text-align: center;
  }
</style>
