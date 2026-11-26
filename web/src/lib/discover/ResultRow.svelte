<script lang="ts">
  import Heart from '@lucide/svelte/icons/heart';
  import Star from '@lucide/svelte/icons/star';
  import type { StorySummary } from '../core/bridge';
  import { words } from '../format';
  import Cover from '../components/Cover.svelte';

  interface Props {
    story: StorySummary & { kudos?: number; status?: string; communityRating?: number; updated?: string; species?: string[] };
    onclick: () => void;
  }
  let { story, onclick }: Props = $props();

  const RATING_SHORT: Record<string, string> = { General: 'G', Teen: 'T', Mature: 'M', Explicit: 'E', 'Not Rated': 'NR' };
</script>

<button type="button" class="row" {onclick}>
  <Cover {story} size={56} />
  <span class="body">
    <span class="t">{story.title}</span>
    <span class="a">{story.author}{#if story.fandoms?.length}&nbsp;· {story.fandoms[0]}{/if}{#if story.species?.length}&nbsp;· {story.species.join(', ')}{/if}</span>
    {#if story.synopsis}<span class="syn">{story.synopsis}</span>{/if}
    <span class="facts">
      {#if story.rating}<span class="rt r-{RATING_SHORT[story.rating]}" title={story.rating}>{RATING_SHORT[story.rating]}</span>{/if}
      <span>{words(story.words)}</span>
      <span>{story.chapterCount} ch</span>
      <span>{story.complete ? 'Complete' : (story.status ?? 'Ongoing')}</span>
      {#if story.kudos}<span class="k"><Heart size={11} fill="currentColor" /> {story.kudos.toLocaleString()}</span>{/if}
      {#if story.communityRating}<span class="k"><Star size={11} fill="currentColor" /> {story.communityRating.toFixed(1)}</span>{/if}
    </span>
  </span>
</button>

<style>
  .row {
    width: 100%;
    display: flex;
    gap: 14px;
    padding: 14px 0;
    text-align: left;
    align-items: flex-start;
  }
  .body {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 2px;
  }
  .t {
    font-weight: 600;
    line-height: 1.25;
  }
  .a {
    font-size: var(--t-foot);
    color: var(--ink-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .syn {
    font-size: var(--t-foot);
    color: var(--ink-3);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin-top: 2px;
  }
  .facts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    margin-top: 6px;
    font-size: var(--t-caption);
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }
  .rt {
    display: inline-grid;
    place-items: center;
    min-width: 20px;
    height: 18px;
    padding: 0 4px;
    border-radius: 4px;
    font-weight: 800;
    font-size: 0.625rem;
    color: #fff;
    background: var(--ink-3);
  }
  .r-G {
    background: #4f8a5b;
  }
  .r-T {
    background: #c4952b;
  }
  .r-M {
    background: #c26a2c;
  }
  .r-E {
    background: #a8322a;
  }
  .k {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
</style>
