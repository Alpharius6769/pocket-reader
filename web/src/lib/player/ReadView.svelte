<script lang="ts">
  import ALargeSmall from '@lucide/svelte/icons/a-large-small';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Headphones from '@lucide/svelte/icons/headphones';
  import Pause from '@lucide/svelte/icons/pause';
  import Minus from '@lucide/svelte/icons/minus';
  import Plus from '@lucide/svelte/icons/plus';
  import { bridge } from '../core';
  import { attempt, updateSettings, tick } from '../actions';
  import { player, currentChapter, playLocked, narrationWarming } from '../stores/player';
  import { settings } from '../stores/settings';
  import { setPlayerMode } from '../stores/ui';
  import Segmented from '../components/Segmented.svelte';
  import Preparing from './Preparing.svelte';

  interface Props {
    needsTap: boolean;
    onstart: () => void;
  }
  let { needsTap, onstart }: Props = $props();

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

  // Narration carries on while the text is being read, and this view had no
  // way to stop it: the only button said "Listen" over a story that already was.
  const narrating = $derived($player.state === 'playing' || $player.state === 'buffering');

  function pause() {
    tick();
    bridge().pause();
  }

  async function listenFromHere() {
    tick();
    const p = selected ?? $player.position.paragraph;
    selected = null;
    if (p !== $player.position.paragraph) await attempt(() => bridge().seekToParagraph(p));
    setPlayerMode('listen');
    // Not ready yet: the Listen view shows the preparation instead of a dead Play.
    if (!$playLocked) await attempt(() => bridge().play());
  }
</script>

<div class="read">
  {#if $narrationWarming}
    <Preparing state={$player.engineState} runway={$player.runway} {needsTap} {onstart} compact />
  {/if}

  <button class="icon-btn type-btn" type="button" aria-label="Text size and font" aria-expanded={typeOpen} onclick={() => (typeOpen = !typeOpen)}>
    <ALargeSmall size={22} />
  </button>
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

  <article class="text" class:sans={font === 'sans'} bind:this={scroller} style:font-size="{size / 16}rem" style:line-height={lineHeight}>
    <h1>{$currentChapter?.title}</h1>
    {#each $currentChapter?.paragraphs ?? [] as text, i (i)}
      <p class:narrating={i === $player.position.paragraph} class:selected={selected === i}>
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
    {#if narrating && selected == null}
      <button class="btn btn-primary btn-block" type="button" onclick={pause}>
        <Pause size={20} fill="currentColor" />
        Pause narration
      </button>
    {:else}
      <button class="btn btn-primary btn-block" type="button" onclick={listenFromHere}>
        <Headphones size={20} />
        {selected == null ? 'Listen' : 'Listen from here'}
      </button>
    {/if}
  </div>
</div>

<style>
  .read {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .type-btn {
    position: absolute;
    z-index: 2;
    right: 8px;
    top: 4px;
    background: var(--bg-glass);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
    border-radius: 50%;
  }
  .type {
    position: absolute;
    z-index: 3;
    top: 52px;
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
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 16px calc(var(--gutter) + 4px) 32px;
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
    margin: 0.4em 2.2rem 1.2em 0;
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
    flex: none;
    padding: 10px var(--gutter);
    border-top: 0.5px solid var(--line);
  }
</style>
