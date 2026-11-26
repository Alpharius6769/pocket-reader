<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import ALargeSmall from '@lucide/svelte/icons/a-large-small';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Headphones from '@lucide/svelte/icons/headphones';
  import Minus from '@lucide/svelte/icons/minus';
  import Plus from '@lucide/svelte/icons/plus';
  import { bridge } from '../core';
  import { attempt, updateSettings } from '../actions';
  import { player, currentChapter } from '../stores/player';
  import { settings } from '../stores/settings';
  import { openReader, openNowPlaying } from '../stores/ui';
  import { slideUp } from '../motion';
  import Segmented from '../components/Segmented.svelte';

  let selected = $state<number | null>(null);
  let typeOpen = $state(false);
  let scroller: HTMLElement | undefined = $state();

  const size = $derived($settings?.readerSize ?? 19);
  const font = $derived($settings?.readerFont ?? 'serif');
  const lineHeight = $derived($settings?.readerLineHeight ?? 1.6);

  // Open at the paragraph being narrated.
  $effect(() => {
    const el = scroller?.querySelector<HTMLElement>('.narrating');
    if (el && scroller) scroller.scrollTop = Math.max(0, el.offsetTop - scroller.clientHeight * 0.25);
  });

  async function chapter(delta: number) {
    selected = null;
    await attempt(() => bridge().skipChapter(delta));
    scroller?.scrollTo({ top: 0 });
  }

  async function listenFromHere() {
    const p = selected ?? $player.position.paragraph;
    await attempt(() => bridge().seekToParagraph(p));
    openReader(false);
    openNowPlaying(true);
    await attempt(() => bridge().play());
  }
</script>

{#if $player.story}
  <div class="reader" role="dialog" aria-modal="true" aria-label="Reader" transition:slideUp>
    <header class="bar">
      <button class="icon-btn" type="button" aria-label="Close reader" onclick={() => openReader(false)}><X size={24} /></button>
      <div class="where">
        <span class="t">{$player.story.title}</span>
        <span class="c">{$currentChapter?.title}</span>
      </div>
      <button class="icon-btn" type="button" aria-label="Text size and font" aria-expanded={typeOpen} onclick={() => (typeOpen = !typeOpen)}>
        <ALargeSmall size={24} />
      </button>
    </header>

    {#if typeOpen}
      <div class="type card">
        <div class="row">
          <button class="icon-btn" type="button" aria-label="Smaller text" disabled={size <= 14} onclick={() => updateSettings({ readerSize: size - 1 })}><Minus size={20} /></button>
          <span class="size" aria-live="polite">{size} pt</span>
          <button class="icon-btn" type="button" aria-label="Larger text" disabled={size >= 30} onclick={() => updateSettings({ readerSize: size + 1 })}><Plus size={20} /></button>
        </div>
        <Segmented
          label="Font"
          value={font}
          options={[
            { value: 'serif', label: 'Literata' },
            { value: 'sans', label: 'System' },
          ]}
          onchange={(v) => updateSettings({ readerFont: v })}
        />
      </div>
    {/if}

    <article
      class="text"
      class:sans={font === 'sans'}
      bind:this={scroller}
      style:font-size="{size / 16}rem"
      style:line-height={lineHeight}
    >
      <h1>{$currentChapter?.title}</h1>
      {#each $currentChapter?.paragraphs ?? [] as text, i (i)}
        <p
          class:narrating={i === $player.position.paragraph}
          class:selected={selected === i}
        >
          <button type="button" onclick={() => (selected = selected === i ? null : i)} aria-pressed={selected === i}>{text}</button>
        </p>
      {/each}
      <nav class="chapnav" aria-label="Chapters">
        <button class="btn btn-plain" type="button" disabled={$player.position.chapter === 0} onclick={() => chapter(-1)}><ChevronLeft size={18} /> Previous</button>
        <span class="faint">{$player.position.chapter + 1} / {$player.chapterCount}</span>
        <button class="btn btn-plain" type="button" disabled={$player.position.chapter >= $player.chapterCount - 1} onclick={() => chapter(1)}>Next <ChevronRight size={18} /></button>
      </nav>
    </article>

    <div class="listen">
      <button class="btn btn-primary btn-block" type="button" onclick={listenFromHere}>
        <Headphones size={20} />
        {selected == null ? 'Listen' : 'Listen from here'}
      </button>
    </div>
  </div>
{/if}

<style>
  .reader {
    position: fixed;
    inset: 0;
    z-index: 55;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    padding: var(--safe-top) var(--safe-right) 0 var(--safe-left);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border-bottom: 0.5px solid var(--line);
  }
  .where {
    flex: 1;
    min-width: 0;
    text-align: center;
    display: flex;
    flex-direction: column;
  }
  .where .t {
    font-size: var(--t-foot);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .where .c {
    font-size: var(--t-caption);
    color: var(--ink-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .type {
    position: absolute;
    z-index: 2;
    top: calc(var(--safe-top) + 56px);
    right: 12px;
    width: 250px;
    padding: 10px;
    display: grid;
    gap: 10px;
    box-shadow: var(--shadow-2);
  }
  .type .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .size {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .text {
    position: relative;
    flex: 1;
    overflow-y: auto;
    padding: 28px calc(var(--gutter) + 4px) 32px;
    font-family: var(--font-read);
    color: var(--ink);
  }
  .text.sans {
    font-family: var(--font-ui);
  }
  .text h1 {
    font-size: 1.4em;
    font-weight: 600;
    line-height: 1.2;
    margin: 0.4em 0 1.2em;
    text-wrap: balance;
  }
  .text p {
    margin: 0 0 1em;
    position: relative;
  }
  .text p button {
    font: inherit;
    line-height: inherit;
    text-align: left;
    width: 100%;
    color: inherit;
    border-radius: 6px;
    hyphens: auto;
    -webkit-hyphens: auto;
  }
  .narrating::before {
    content: '';
    position: absolute;
    left: -12px;
    top: 0.35em;
    bottom: 0.35em;
    width: 3px;
    border-radius: 2px;
    background: var(--accent);
  }
  .selected button {
    background: var(--highlight);
    box-shadow: 0 0 0 6px var(--highlight);
  }
  .chapnav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 2.2em;
    font-family: var(--font-ui);
    font-size: var(--t-sub);
  }
  .chapnav .btn:disabled {
    opacity: 0.35;
  }
  .listen {
    padding: 10px var(--gutter) calc(var(--safe-bottom) + 10px);
    background: var(--bg);
    border-top: 0.5px solid var(--line);
  }
</style>
