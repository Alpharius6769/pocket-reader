<script lang="ts">
  import Search from '@lucide/svelte/icons/search';
  import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
  import { onMount } from 'svelte';
  import { bridge, type CatalogEntry, type CatalogFacet, type CatalogQuery } from '../core';
  import { attempt } from '../actions';
  import { openSheet } from '../stores/ui';
  import ResultRow from './ResultRow.svelte';

  let facets = $state<CatalogFacet[]>([]);
  let items = $state<CatalogEntry[]>([]);
  let loading = $state(true);
  let q = $state<CatalogQuery>({ search: '', sort: 'updated-desc', length: 'all' });

  const LENGTH_LABEL: Record<string, string> = {
    'under-10k': 'Under 10k',
    '10k-50k': '10k–50k',
    '50k-100k': '50k–100k',
    '100k-250k': '100k–250k',
    '250k-plus': '250k+',
  };
  const SORTS: { value: NonNullable<CatalogQuery['sort']>; label: string }[] = [
    { value: 'updated-desc', label: 'Recently updated' },
    { value: 'rating-desc', label: 'Community rating' },
    { value: 'words-desc', label: 'Longest' },
    { value: 'title-asc', label: 'Title' },
    { value: 'author-asc', label: 'Author' },
  ];

  onMount(async () => {
    facets = (await attempt(() => bridge().catalog.facets())) ?? [];
  });

  $effect(() => {
    const query = $state.snapshot(q);
    loading = true;
    let live = true;
    attempt(() => bridge().catalog.query(query)).then((page) => {
      if (!live) return;
      items = page?.items ?? [];
      loading = false;
    });
    return () => (live = false);
  });

  type MultiKey = 'world' | 'species' | 'rating' | 'status';

  function isOn(key: CatalogFacet['key'], value: string) {
    if (key === 'length') return q.length === value;
    return ((q[key as MultiKey] as string[] | undefined) ?? []).includes(value);
  }

  function toggle(key: CatalogFacet['key'], value: string) {
    if (key === 'length') {
      q.length = q.length === value ? 'all' : (value as CatalogQuery['length']);
      return;
    }
    const k = key as MultiKey;
    const cur = (q[k] as string[] | undefined) ?? [];
    (q as Record<string, unknown>)[k] = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
  }

  const active = $derived(
    (q.world?.length ?? 0) + (q.species?.length ?? 0) + (q.rating?.length ?? 0) + (q.status?.length ?? 0) + (q.length !== 'all' ? 1 : 0),
  );

  function clearAll() {
    q = { search: q.search, sort: q.sort, length: 'all' };
  }
</script>

<p class="intro muted">The Anthronomicon is the HMOFA community’s catalog of stories. Browse by world, species or length.</p>

<label class="field">
  <Search size={18} />
  <input type="search" placeholder="Search titles and authors" aria-label="Search the catalog" bind:value={q.search} enterkeyhint="search" />
</label>

<div class="facets">
  {#each facets as f (f.key)}
    <div class="facet">
      <span class="fl eyebrow">{f.label}</span>
      <div class="h-scroll chips" role="group" aria-label={f.label}>
        {#each f.values as v (v.value)}
          <button type="button" class="chip" aria-pressed={isOn(f.key, v.value)} onclick={() => toggle(f.key, v.value)}>
            {f.key === 'length' ? LENGTH_LABEL[v.value] : v.value}
            {#if v.count && f.key !== 'length'}<span class="n">{v.count}</span>{/if}
          </button>
        {/each}
      </div>
    </div>
  {/each}
</div>

<div class="bar">
  <span class="faint" aria-live="polite">{loading ? 'Loading…' : `${items.length} stories`}</span>
  <span class="right">
    {#if active}<button type="button" class="link" onclick={clearAll}>Clear {active}</button>{/if}
    <label class="sort">
      <ArrowUpDown size={16} />
      <span>{SORTS.find((s) => s.value === q.sort)?.label}</span>
      <select bind:value={q.sort} aria-label="Sort catalog">
        {#each SORTS as s (s.value)}<option value={s.value}>{s.label}</option>{/each}
      </select>
    </label>
  </span>
</div>

<ul class="results" class:dim={loading}>
  {#each items as e (e.key)}
    <li><ResultRow story={e} onclick={() => openSheet({ kind: 'preview', story: e })} /></li>
  {/each}
</ul>
{#if !loading && !items.length}
  <p class="none muted">No stories match these filters.</p>
{/if}

<style>
  .intro {
    font-size: var(--t-foot);
    margin: 0 0 12px;
  }
  .facets {
    margin-top: 10px;
    display: grid;
    gap: 6px;
  }
  .facet {
    display: grid;
    gap: 2px;
  }
  .fl {
    font-size: 0.6875rem;
  }
  .chips {
    gap: 8px;
  }
  .n {
    opacity: 0.55;
    font-size: var(--t-caption);
    font-variant-numeric: tabular-nums;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 10px;
    font-size: var(--t-foot);
    border-bottom: 0.5px solid var(--line);
  }
  .right {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .link {
    color: var(--accent-ink);
    font-weight: 600;
    min-height: 44px;
  }
  .sort {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 44px;
    font-weight: 600;
    color: var(--ink);
  }
  .sort select {
    position: absolute;
    inset: 0;
    opacity: 0;
    font-size: 16px;
  }
  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    transition: opacity var(--dur-1);
  }
  .results.dim {
    opacity: 0.5;
  }
  .results li + li {
    border-top: 0.5px solid var(--line);
  }
  .none {
    padding: 32px 0;
    text-align: center;
  }
</style>
