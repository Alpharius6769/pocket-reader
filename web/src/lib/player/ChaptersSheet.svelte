<script lang="ts">
  import Trash from '@lucide/svelte/icons/trash';
  import Bookmark from '@lucide/svelte/icons/bookmark';
  import AudioLines from '@lucide/svelte/icons/audio-lines';
  import { bridge } from '../core';
  import { attempt } from '../actions';
  import { player } from '../stores/player';
  import { library } from '../stores/library';
  import { closeSheet } from '../stores/ui';
  import { ago } from '../format';
  import Sheet from '../components/Sheet.svelte';
  import Segmented from '../components/Segmented.svelte';

  interface Props {
    tab: 'chapters' | 'bookmarks';
  }
  let { tab: initial }: Props = $props();
  // svelte-ignore state_referenced_locally
  let tab = $state(initial);

  const entry = $derived($library.entries.find((e) => e.story.key === $player.story?.key));
  const bookmarks = $derived([...(entry?.bookmarks ?? [])].sort((a, b) => a.chapter - b.chapter || a.paragraph - b.paragraph));

  async function go(chapter: number, paragraph = 0) {
    await attempt(() => bridge().seekToParagraph(paragraph, chapter));
    closeSheet();
  }
</script>

<Sheet title={$player.story?.title} onclose={closeSheet} size="large">
  <div class="switch">
    <Segmented
      label="Show"
      value={tab}
      options={[
        { value: 'chapters', label: 'Chapters' },
        { value: 'bookmarks', label: `Bookmarks${bookmarks.length ? ` (${bookmarks.length})` : ''}` },
      ]}
      onchange={(v) => (tab = v)}
    />
  </div>

  {#if tab === 'chapters'}
    <ol class="list">
      {#each $player.story?.chapters ?? [] as ch, i (i)}
        <li>
          <button type="button" class="row" aria-current={i === $player.position.chapter ? 'true' : undefined} onclick={() => go(i)}>
            <span class="num">{i + 1}</span>
            <span class="title">{ch.title}</span>
            {#if i === $player.position.chapter}
              <span class="now"><AudioLines size={18} /></span>
            {:else if i < $player.position.chapter}
              <span class="done faint">Done</span>
            {/if}
          </button>
        </li>
      {/each}
    </ol>
  {:else if bookmarks.length}
    <ul class="list">
      {#each bookmarks as b (b.id)}
        <li class="bm">
          <button type="button" class="row" onclick={() => go(b.chapter, b.paragraph)}>
            <span class="num"><Bookmark size={18} /></span>
            <span class="bm-text">
              <span class="title">{b.label || `Chapter ${b.chapter + 1}, ¶ ${b.paragraph + 1}`}</span>
              <span class="excerpt">{b.excerpt}</span>
              <span class="meta faint">Chapter {b.chapter + 1} · {ago(b.createdAt)}</span>
            </span>
          </button>
          <button class="icon-btn" type="button" aria-label="Delete bookmark" onclick={() => attempt(() => bridge().library.removeBookmark(b.storyKey, b.id))}>
            <Trash size={18} />
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <div class="empty">
      <Bookmark size={28} />
      <p>No bookmarks yet.</p>
      <p class="faint">Tap the bookmark button in the player to save the paragraph you are hearing.</p>
    </div>
  {/if}
</Sheet>

<style>
  .switch {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--bg-elev);
    padding: 2px 0 10px;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .list > li + li {
    border-top: 0.5px solid var(--line);
  }
  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 14px;
    min-height: 54px;
    text-align: left;
    padding: 8px 0;
  }
  .num {
    width: 26px;
    flex: none;
    text-align: right;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
    font-size: var(--t-sub);
    display: grid;
    justify-items: end;
  }
  .title {
    flex: 1;
    min-width: 0;
    font-weight: 500;
  }
  .row[aria-current='true'] .title,
  .row[aria-current='true'] .num {
    color: var(--accent-ink);
    font-weight: 700;
  }
  .now {
    color: var(--accent-ink);
  }
  .done {
    font-size: var(--t-foot);
  }
  .bm {
    display: flex;
    align-items: center;
  }
  .bm .row {
    flex: 1;
    min-width: 0;
    align-items: flex-start;
  }
  .bm .num {
    color: var(--accent-ink);
    padding-top: 2px;
  }
  .bm-text {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 2px;
  }
  .excerpt {
    font-family: var(--font-read);
    font-size: var(--t-sub);
    color: var(--ink-2);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .meta {
    font-size: var(--t-caption);
  }
  .empty {
    display: grid;
    justify-items: center;
    text-align: center;
    gap: 6px;
    padding: 40px 24px;
    color: var(--ink-2);
  }
</style>
