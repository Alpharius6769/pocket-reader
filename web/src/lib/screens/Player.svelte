<script lang="ts">
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import LibraryBig from '@lucide/svelte/icons/library-big';
  import Headphones from '@lucide/svelte/icons/headphones';
  import { bridge } from '../core';
  import { attempt, tick, openStory } from '../actions';
  import { inProgress } from '../stores/library';
  import { player, currentChapter } from '../stores/player';
  import { ui, openSheet, setPlayerMode, setTab } from '../stores/ui';
  import Cover from '../components/Cover.svelte';
  import Segmented from '../components/Segmented.svelte';
  import Virtue from '../components/Virtue.svelte';
  import ListenView from '../player/ListenView.svelte';
  import ReadView from '../player/ReadView.svelte';

  // The page prepares narration as soon as it is showing a story: the voice
  // loads and the next ten paragraphs render, with the status on screen the
  // whole time, and Play unlocks when they are ready. The first narration of a
  // session cannot start on its own (it reloads into the fast session, which
  // needs a tap), so then the status card offers that tap.
  // A bare "Chapter 3" title would only repeat the counter beside it.
  const chapterName = $derived.by(() => {
    const t = $currentChapter?.title?.trim() ?? '';
    return /^chapter\s+\d+\.?$/i.test(t) ? '' : t;
  });

  let needsTap = $state(false);
  let autoKey = '';
  $effect(() => {
    const p = $player;
    if ($ui.tab !== 'player' || !p.story) return;
    if (p.state === 'playing' || p.state === 'buffering') return;
    const r = p.runway;
    if (r.ok || r.preparing || r.error) return;
    const key = `${p.story.key}:${p.position.chapter}:${p.position.paragraph}:${p.engine}:${p.voice}`;
    if (key === autoKey) return;
    autoKey = key;
    void bridge()
      .prepareRunway()
      .then((started) => (needsTap = !started))
      .catch(() => (needsTap = true));
  });

  function start() {
    tick();
    needsTap = false;
    autoKey = '';
    // A real Play press: it may reload into the fast session first, and the
    // runway gate turns it into preparation when the paragraphs are not ready.
    void attempt(() => bridge().play());
  }
</script>

<main class="player-page" aria-labelledby="player-title">
  {#if !$player.story}
    <div class="empty">
      <Virtue mood="waving" height={150} />
      <h1 class="large-title" id="player-title">Nothing playing</h1>
      {#if $inProgress[0]}
        {@const last = $inProgress[0]}
        <p class="muted">Pick up where you left off, or choose another story.</p>
        <!-- Opens the story here without starting it; preparation then begins on its own. -->
        <button class="btn btn-primary" type="button" onclick={() => openStory({ kind: 'key', key: last.story.key }, { mode: $ui.playerMode, autoplay: false })}>
          <Headphones size={18} /> Continue “{last.story.title}”
        </button>
        <button class="btn btn-plain" type="button" onclick={() => setTab('library')}><LibraryBig size={18} /> Library</button>
      {:else}
        <p class="muted">Pick a story and it will be read to you here, or open it to read along.</p>
        <button class="btn btn-primary" type="button" onclick={() => setTab('library')}><LibraryBig size={18} /> Open your library</button>
      {/if}
    </div>
  {:else}
    <header class="head">
      <Cover story={$player.story} size={44} plain />
      <div class="ident">
        <h1 id="player-title">{$player.story.title}</h1>
        <p class="muted">
          Chapter {$player.position.chapter + 1} of {$player.chapterCount}{#if chapterName}&nbsp;· {chapterName}{/if}
        </p>
      </div>
      <button class="icon-btn" type="button" aria-label="Story options" onclick={() => openSheet({ kind: 'story', key: $player.story!.key })}>
        <Ellipsis size={24} />
      </button>
    </header>
    <div class="modes">
      <Segmented
        label="Listen or read"
        value={$ui.playerMode}
        options={[
          { value: 'listen', label: 'Listen' },
          { value: 'read', label: 'Read' },
        ]}
        onchange={setPlayerMode}
      />
    </div>
    {#if $ui.playerMode === 'listen'}
      <ListenView {needsTap} onstart={start} />
    {:else}
      <ReadView {needsTap} onstart={start} />
    {/if}
  {/if}
</main>

<style>
  .player-page {
    display: flex;
    flex-direction: column;
    height: calc(100dvh - var(--tabbar-h) - var(--safe-bottom));
    padding: calc(var(--safe-top) + 6px) var(--safe-right) 0 var(--safe-left);
    overflow: hidden;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 8px 8px var(--gutter);
  }
  .ident {
    flex: 1;
    min-width: 0;
  }
  .ident h1 {
    font-family: var(--font-display);
    font-size: var(--t-head);
    font-weight: 700;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ident p {
    font-size: var(--t-foot);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .modes {
    padding: 0 var(--gutter) 4px;
  }
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    text-align: center;
    padding: 0 calc(var(--gutter) + 12px);
  }
  .empty p {
    max-width: 30ch;
  }
</style>
