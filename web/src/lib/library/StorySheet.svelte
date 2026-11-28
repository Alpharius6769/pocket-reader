<script lang="ts">
  import { deviceNoun } from '../layout';
  import Headphones from '@lucide/svelte/icons/headphones';
  import BookOpenText from '@lucide/svelte/icons/book-open-text';
  import Heart from '@lucide/svelte/icons/heart';
  import Bell from '@lucide/svelte/icons/bell';
  import CloudDownload from '@lucide/svelte/icons/cloud-download';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Trash from '@lucide/svelte/icons/trash';
  import Check from '@lucide/svelte/icons/check';
  import { bridge, type StoryKey } from '../core';
  import { attempt, openStory } from '../actions';
  import { library } from '../stores/library';
  import { closeSheet, say, toast } from '../stores/ui';
  import { listenTime, percent, plural, statusLabel, words } from '../format';
  import { pickLine } from '../virtue/sprites';
  import Sheet from '../components/Sheet.svelte';
  import Cover from '../components/Cover.svelte';
  import Stars from '../components/Stars.svelte';
  import Toggle from '../components/Toggle.svelte';

  interface Props {
    storyKey: StoryKey;
  }
  let { storyKey }: Props = $props();

  const entry = $derived($library.entries.find((e) => e.story.key === storyKey));
  let confirmRemove = $state(false);
  let checking = $state(false);
  let showAll = $state(false);

  async function open(mode: 'listen' | 'read') {
    // Read the key BEFORE closing: the prop is a live getter on $ui.sheet,
    // which closeSheet() nulls, and reading it afterwards threw (Listen and
    // Read silently did nothing).
    const key = storyKey;
    closeSheet();
    await openStory({ kind: 'key', key }, { mode });
  }

  async function rate(stars: 0 | 1 | 2 | 3 | 4 | 5) {
    await attempt(() => bridge().library.rate(storyKey, stars));
    if (stars >= 4) say('highscore', pickLine('highscore'));
    else if (stars >= 1 && stars <= 2) say('lowscore', null);
  }

  async function check() {
    checking = true;
    const changed = await attempt(() => bridge().library.checkForUpdates(storyKey));
    checking = false;
    // It used to finish without a word either way.
    if (changed) toast({ level: changed.length ? 'success' : 'info', message: changed.length ? 'New chapters were added.' : 'No new chapters yet.', mood: changed.length ? 'point' : undefined });
  }

  async function remove() {
    await attempt(() => bridge().library.remove(storyKey));
    closeSheet();
  }
</script>

<Sheet onclose={closeSheet} title={entry?.story.title ?? 'Story'}>
  {#if entry}
    {@const s = entry.story}
    <div class="hero">
      <Cover story={s} size={96} />
      <div class="meta">
        <p class="author">{s.author}</p>
        <p class="facts">
          {[words(s.words), s.chapterCount ? plural(s.chapterCount, 'chapter') : '', statusLabel(s)].filter(Boolean).join(' · ')}
        </p>
        <p class="facts faint">About {listenTime(s.words)} to listen</p>
        {#if entry.progress > 0}
          <div class="prog">
            <div class="progress-track"><span style:width={percent(entry.progress)}></span></div>
            <span class="faint">{entry.finished ? 'Finished' : `${percent(entry.progress)} · Chapter ${entry.position.chapter + 1}`}</span>
          </div>
        {/if}
      </div>
    </div>

    <div class="cta">
      <button class="btn btn-primary btn-block" type="button" onclick={() => open('listen')}>
        <Headphones size={20} />
        {entry.progress > 0 && !entry.finished ? 'Resume' : 'Listen'}
      </button>
      <button class="btn btn-plain btn-block" type="button" onclick={() => open('read')}>
        <BookOpenText size={20} /> Read
      </button>
    </div>

    {#if s.synopsis}
      <p class="syn" class:clamp={!showAll}>{s.synopsis}</p>
      {#if s.synopsis.length > 160}
        <button class="more" type="button" onclick={() => (showAll = !showAll)}>{showAll ? 'Less' : 'More'}</button>
      {/if}
    {/if}

    {#if s.tags?.length}
      <div class="tags">
        {#each s.tags as t (t)}<span class="tag">{t}</span>{/each}
      </div>
    {/if}

    <div class="rate">
      <span class="eyebrow">Your rating</span>
      <Stars value={entry.rating} onchange={rate} />
    </div>

    <ul class="group">
      <li>
        <span class="ic"><Heart size={20} /></span>
        <span class="lbl">Favourite</span>
        <Toggle label="Favourite" checked={entry.favourite} onchange={(v) => attempt(() => bridge().library.setFavourite(storyKey, v))} />
      </li>
      {#if s.source === 'ao3'}
        <!-- Only AO3 works can be followed; on anything else this switch did nothing. -->
        <li>
          <span class="ic"><Bell size={20} /></span>
          <span class="lbl">New chapter alerts</span>
          <Toggle label="New chapter alerts" checked={entry.subscribed} onchange={(v) => attempt(() => bridge().library.setSubscribed(storyKey, v))} />
        </li>
      {/if}
      <li>
        <span class="ic"><CloudDownload size={20} /></span>
        <span class="lbl">
          Offline narration
          <span class="sub">
            {#if entry.cache.state === 'complete'}Saved on this {$deviceNoun}
            {:else if entry.cache.state === 'caching'}Saving… {entry.cache.total ? percent(entry.cache.done / entry.cache.total) : ''}
            {:else if entry.cache.state === 'partial'}Partly saved{:else}Narrate the whole story ahead of time{/if}
          </span>
        </span>
        {#if entry.cache.state === 'complete'}
          <span class="ok"><Check size={20} strokeWidth={2.6} /></span>
        {:else if entry.cache.state === 'caching'}
          <button class="btn btn-plain small" type="button" onclick={() => bridge().cancelCaching(storyKey)}>Stop</button>
        {:else}
          <button class="btn btn-tonal small" type="button" onclick={() => attempt(() => bridge().startCaching(storyKey))}>Save</button>
        {/if}
      </li>
      {#if s.source !== 'upload'}
        <li>
          <span class="ic"><RefreshCw size={20} /></span>
          <span class="lbl">
            Check for new chapters
            {#if entry.hasUpdate}<span class="sub accent">New chapters available</span>{/if}
          </span>
          <button class="btn btn-plain small" type="button" disabled={checking} onclick={check}>{checking ? 'Checking…' : 'Check'}</button>
        </li>
      {/if}
    </ul>

    {#if confirmRemove}
      <div class="confirm">
        <p>Remove “{s.title}” and its saved narration from this {$deviceNoun}?</p>
        <div class="row2">
          <button class="btn btn-plain" type="button" onclick={() => (confirmRemove = false)}>Cancel</button>
          <button class="btn danger-solid" type="button" onclick={remove}>Remove</button>
        </div>
      </div>
    {:else}
      <button class="btn btn-danger remove" type="button" onclick={() => (confirmRemove = true)}><Trash size={18} /> Remove from library</button>
    {/if}
  {/if}
</Sheet>

<style>
  .hero {
    display: flex;
    gap: 16px;
    align-items: flex-start;
    padding-bottom: 14px;
  }
  .meta {
    min-width: 0;
    flex: 1;
    display: grid;
    gap: 4px;
  }
  .author {
    font-weight: 600;
  }
  .facts {
    font-size: var(--t-foot);
    color: var(--ink-2);
  }
  .prog {
    display: grid;
    gap: 4px;
    margin-top: 6px;
    font-size: var(--t-caption);
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
  .syn.clamp {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .more {
    color: var(--accent-ink);
    font-weight: 600;
    font-size: var(--t-foot);
    min-height: 32px;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }
  .tag {
    font-size: var(--t-caption);
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 99px;
    background: var(--bg-elev-2);
    color: var(--ink-2);
  }
  .rate {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 16px 0 6px;
  }
  .group {
    list-style: none;
    margin: 0;
    padding: 0 14px;
    border-radius: 16px;
    background: var(--bg-elev-2);
  }
  .group li {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 56px;
    padding: 8px 0;
  }
  .group li + li {
    border-top: 0.5px solid var(--line);
  }
  .ic {
    color: var(--ink-2);
    display: grid;
  }
  .lbl {
    flex: 1;
    min-width: 0;
    display: grid;
    font-weight: 500;
  }
  .sub {
    font-size: var(--t-foot);
    font-weight: 400;
    color: var(--ink-2);
  }
  .sub.accent {
    color: var(--accent-ink);
    font-weight: 600;
  }
  .ok {
    color: var(--ok);
  }
  .small {
    min-height: 36px;
    padding: 0 14px;
    font-size: var(--t-foot);
    position: relative;
  }
  .small::after {
    content: '';
    position: absolute;
    inset: -4px;
  }
  .remove {
    width: 100%;
    margin-top: 14px;
  }
  .confirm {
    margin-top: 14px;
    padding: 14px;
    border-radius: 16px;
    background: color-mix(in srgb, var(--danger) 10%, var(--bg-elev));
    display: grid;
    gap: 12px;
  }
  .row2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .danger-solid {
    background: var(--danger);
    color: #fff;
  }
</style>
