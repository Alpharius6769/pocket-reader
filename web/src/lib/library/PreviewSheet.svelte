<script lang="ts">
  import Headphones from '@lucide/svelte/icons/headphones';
  import Plus from '@lucide/svelte/icons/plus';
  import Check from '@lucide/svelte/icons/check';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import { bridge, type StorySummary } from '../core';
  import { attempt, openStory } from '../actions';
  import { library } from '../stores/library';
  import { closeSheet } from '../stores/ui';
  import { listenTime, words } from '../format';
  import Sheet from '../components/Sheet.svelte';
  import Cover from '../components/Cover.svelte';

  interface Props {
    story: StorySummary & { kudos?: number; updated?: string; updatedAt?: string; status?: string };
  }
  let { story }: Props = $props();

  const inLibrary = $derived($library.entries.some((e) => e.story.key === story.key));
  let adding = $state(false);

  function ref() {
    return story.url ? ({ kind: 'url', url: story.url } as const) : ({ kind: 'key', key: story.key } as const);
  }

  async function add() {
    adding = true;
    await attempt(() => bridge().library.add(ref()));
    adding = false;
  }

  async function listen() {
    // ref() reads the story prop, which closeSheet() nulls: capture it first.
    const target = ref();
    closeSheet();
    await openStory(target, { mode: 'listen' });
  }
</script>

<Sheet onclose={closeSheet} title={story.title}>
  <div class="hero">
    <Cover {story} size={96} />
    <div class="meta">
      <p class="author">{story.author}</p>
      <p class="facts">{[story.rating, words(story.words), `${story.chapterCount} ch`].filter(Boolean).join(' · ')}</p>
      <p class="facts faint">
        {story.complete ? 'Complete' : (story.status ?? 'Ongoing')}{#if story.words}&nbsp;· about {listenTime(story.words)}{/if}
      </p>
      {#if story.fandoms?.length}<p class="facts faint">{story.fandoms.join(', ')}</p>{/if}
    </div>
  </div>

  <div class="cta">
    <button class="btn btn-primary btn-block" type="button" onclick={listen}><Headphones size={20} /> Listen now</button>
    {#if inLibrary}
      <button class="btn btn-plain btn-block" type="button" disabled><Check size={20} /> In library</button>
    {:else}
      <button class="btn btn-tonal btn-block" type="button" disabled={adding} onclick={add}><Plus size={20} /> {adding ? 'Adding…' : 'Add'}</button>
    {/if}
  </div>

  {#if story.synopsis}<p class="syn">{story.synopsis}</p>{/if}

  {#if story.tags?.length}
    <div class="tags">
      {#each story.tags as t (t)}<span class="tag">{t}</span>{/each}
    </div>
  {/if}

  {#if story.url}
    <a class="src" href={story.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} /> Open original page</a>
  {/if}
</Sheet>

<style>
  .hero {
    display: flex;
    gap: 16px;
    padding-bottom: 14px;
  }
  .meta {
    min-width: 0;
    display: grid;
    gap: 3px;
    align-content: start;
  }
  .author {
    font-weight: 600;
  }
  .facts {
    font-size: var(--t-foot);
    color: var(--ink-2);
  }
  .cta {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    gap: 10px;
  }
  .syn {
    margin-top: 16px;
    font-family: var(--font-read);
    font-size: var(--t-sub);
    line-height: 1.55;
    color: var(--ink-2);
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
  }
  .tag {
    font-size: var(--t-caption);
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 99px;
    background: var(--bg-elev-2);
    color: var(--ink-2);
  }
  .src {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 44px;
    margin-top: 10px;
    color: var(--accent-ink);
    font-weight: 600;
    font-size: var(--t-sub);
    text-decoration: none;
  }
</style>
