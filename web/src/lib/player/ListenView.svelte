<script lang="ts">
  import SkipBack from '@lucide/svelte/icons/skip-back';
  import SkipForward from '@lucide/svelte/icons/skip-forward';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import Redo2 from '@lucide/svelte/icons/redo-2';
  import Moon from '@lucide/svelte/icons/moon';
  import List from '@lucide/svelte/icons/list';
  import BookmarkPlus from '@lucide/svelte/icons/bookmark-plus';
  import AudioLines from '@lucide/svelte/icons/audio-lines';
  import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line';
  import { tick as nextTick } from 'svelte';
  import { bridge, VOICES } from '../core';
  import { attempt, tick } from '../actions';
  import { player, currentChapter, playLocked, narrationWarming } from '../stores/player';
  import { openSheet } from '../stores/ui';
  import { library } from '../stores/library';
  import { reducedMotion } from '../motion';
  import { clockLeft, speedLabel } from '../format';
  import { deviceNoun } from '../layout';
  import PlayButton from '../components/PlayButton.svelte';
  import Preparing from './Preparing.svelte';

  interface Props {
    needsTap: boolean;
    onstart: () => void;
  }
  let { needsTap, onstart }: Props = $props();

  let pane: HTMLElement | undefined = $state();
  let following = $state(true);
  let now = $state(Date.now());

  const voice = $derived(VOICES.find((v) => v.id === $player.voice));
  const para = $derived($player.position.paragraph);
  const count = $derived($currentChapter?.paragraphs.length ?? 0);
  const paragraphsLeft = $derived(Math.max(0, count - para - 1));
  // A phone that is locked may stop preparing new paragraphs; what is already
  // prepared plays on. So say how much that is, and whether the whole story is
  // saved (which needs nothing prepared at all).
  const savedOffline = $derived($library.entries.find((e) => e.story.key === $player.story?.key)?.cache.state === 'complete');
  const aheadEnough = $derived($player.buffer.ready >= Math.min(5, paragraphsLeft));
  const minutesLeft = $derived.by(() => {
    const ch = $currentChapter;
    if (!ch) return 0;
    const w = ch.paragraphs.slice(para).join(' ').split(/\s+/).length;
    return Math.max(1, Math.round(w / 155 / $player.speed));
  });

  $effect(() => {
    if ($player.sleep.kind !== 'minutes') return;
    // `now` was last set when this view was created. Until the first tick a
    // second later, a new 15-minute timer showed 15 minutes plus however long
    // the player had been open ("28:04").
    now = Date.now();
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });

  // Keep the spoken paragraph in view unless the reader has scrolled away.
  let first = true;
  $effect(() => {
    const target = `${$player.position.chapter}:${para}`;
    if (!following || !pane) return;
    void target;
    nextTick().then(() => {
      const el = pane?.querySelector<HTMLElement>('[aria-current="true"]');
      if (!el || !pane) return;
      const delta = el.getBoundingClientRect().top - pane.getBoundingClientRect().top;
      const top = pane.scrollTop + delta - pane.clientHeight * 0.22;
      pane.scrollTo({ top: Math.max(0, top), behavior: first || reducedMotion() ? 'auto' : 'smooth' });
      first = false;
    });
  });

  // Only a reader's own gesture stops auto-follow; programmatic scrolls do not.
  function userScrolled() {
    following = false;
  }

  async function seek(i: number) {
    tick();
    following = true;
    await attempt(() => bridge().seekToParagraph(i));
  }

  function scrub(e: Event) {
    void seek(Number((e.currentTarget as HTMLInputElement).value));
  }

  async function bookmark() {
    tick();
    await attempt(() => bridge().saveBookmark());
  }
</script>

{#if $narrationWarming}
  <Preparing state={$player.engineState} runway={$player.runway} {needsTap} {onstart} />
{:else}
  <div class="pane-wrap">
    <div class="pane" role="region" bind:this={pane} ontouchmove={userScrolled} onwheel={userScrolled} aria-label="Story text">
      {#each $currentChapter?.paragraphs ?? [] as text, i (i)}
        <p class:past={i < para}>
          <button type="button" class="para" aria-current={i === para ? 'true' : undefined} onclick={() => seek(i)}>{text}</button>
        </p>
      {/each}
      <div class="pane-end"></div>
    </div>
    {#if !following}
      <button class="refollow" type="button" onclick={() => (following = true)}>
        <ArrowDownToLine size={16} /> Back to narration
      </button>
    {/if}
  </div>
{/if}

<div class="deck">
  <div class="scrub">
    <input
      type="range"
      min="0"
      max={Math.max(0, count - 1)}
      value={para}
      aria-label="Paragraph in chapter"
      aria-valuetext="Paragraph {para + 1} of {count}"
      onchange={scrub}
      style:--fill="{count > 1 ? (para / (count - 1)) * 100 : 0}%"
    />
    <div class="scrub-meta">
      <span>¶ {para + 1} of {count}</span>
      <span>{paragraphsLeft === 0 ? 'Last paragraph' : `about ${minutesLeft} min left in chapter`}</span>
    </div>
    {#if $deviceNoun === 'phone' && $player.state === 'playing'}
      <!-- What will keep playing if the screen is locked now. -->
      {#if savedOffline}
        <p class="ahead">Saved for offline. It keeps playing with the screen locked.</p>
      {:else if $player.buffer.ready > 0}
        <p class="ahead">
          {$player.buffer.ready} {$player.buffer.ready === 1 ? 'paragraph' : 'paragraphs'} ready ahead.
          {aheadEnough ? 'They keep playing if you lock the screen.' : 'Keep the screen on while more is prepared.'}
        </p>
      {/if}
    {/if}
  </div>

  <div class="transport">
    <button class="icon-btn lg" type="button" aria-label="Previous chapter" disabled={$player.position.chapter === 0} onclick={() => attempt(() => bridge().skipChapter(-1))}>
      <SkipBack size={26} fill="currentColor" />
    </button>
    <button class="icon-btn lg" type="button" aria-label="Previous paragraph" onclick={() => attempt(() => bridge().skipParagraph(-1))}>
      <Undo2 size={28} />
    </button>
    <PlayButton
      state={$player.state}
      size={76}
      disabled={$playLocked}
      label={$playLocked ? `Play unlocks when ${$player.runway.target || 10} paragraphs are ready` : undefined}
      onclick={() => { tick(); attempt(() => bridge().togglePlay()); }}
    />
    <button class="icon-btn lg" type="button" aria-label="Next paragraph" onclick={() => attempt(() => bridge().skipParagraph(1))}>
      <Redo2 size={28} />
    </button>
    <button
      class="icon-btn lg"
      type="button"
      aria-label="Next chapter"
      disabled={$player.position.chapter >= $player.chapterCount - 1}
      onclick={() => attempt(() => bridge().skipChapter(1))}
    >
      <SkipForward size={26} fill="currentColor" />
    </button>
  </div>

  <div class="tools">
    <button class="tool voice" type="button" onclick={() => openSheet({ kind: 'voice' })} aria-label="Voice and speed: {voice?.name}, {speedLabel($player.speed)}">
      <AudioLines size={18} />
      <span>{voice?.name ?? 'Voice'} · {speedLabel($player.speed)}</span>
    </button>
    <button
      class="tool icon"
      class:on={$player.sleep.kind !== 'off'}
      type="button"
      aria-label={$player.sleep.kind === 'off' ? 'Sleep timer' : 'Sleep timer on'}
      onclick={() => openSheet({ kind: 'sleep' })}
    >
      <Moon size={20} />
      {#if $player.sleep.kind === 'minutes'}<span class="tiny">{clockLeft($player.sleep.endsAt, now)}</span>{/if}
      {#if $player.sleep.kind === 'end-of-chapter'}<span class="tiny">Ch. end</span>{/if}
    </button>
    <button class="tool icon" type="button" aria-label="Add bookmark" onclick={bookmark}><BookmarkPlus size={20} /></button>
    <button class="tool icon" type="button" aria-label="Chapters and bookmarks" onclick={() => openSheet({ kind: 'chapters', tab: 'chapters' })}><List size={20} /></button>
  </div>
</div>

<style>
  .pane-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .pane {
    position: relative;
    height: 100%;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 18px var(--gutter) 0;
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 28px, #000 calc(100% - 48px), transparent 100%);
    mask-image: linear-gradient(to bottom, transparent 0, #000 28px, #000 calc(100% - 48px), transparent 100%);
  }
  .pane p {
    margin: 0 0 0.85em;
  }
  .para {
    display: block;
    text-align: left;
    font-family: var(--font-read);
    font-size: 1.1875rem;
    line-height: 1.6;
    color: var(--ink-3);
    padding: 6px 12px;
    margin: 0 -12px;
    width: calc(100% + 24px);
    border-radius: 12px;
    transition:
      color var(--dur-2),
      background var(--dur-2);
  }
  .past .para {
    color: color-mix(in srgb, var(--ink-3) 75%, transparent);
  }
  .para[aria-current='true'] {
    color: var(--ink);
    background: var(--highlight);
  }
  .pane-end {
    height: 40%;
  }
  .refollow {
    position: absolute;
    left: 50%;
    bottom: 12px;
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 40px;
    padding: 0 16px;
    border-radius: 99px;
    background: var(--ink);
    color: var(--bg);
    font-size: var(--t-foot);
    font-weight: 600;
    box-shadow: var(--shadow-2);
  }
  .deck {
    flex: none;
    padding: 6px var(--gutter) 10px;
  }
  .scrub input {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 28px;
    background: transparent;
    margin: 0;
  }
  .scrub input::-webkit-slider-runnable-track {
    height: 5px;
    border-radius: 3px;
    background: linear-gradient(to right, var(--ink) var(--fill), var(--line) var(--fill));
  }
  .scrub input::-moz-range-track {
    height: 5px;
    border-radius: 3px;
    background: linear-gradient(to right, var(--ink) var(--fill), var(--line) var(--fill));
  }
  .scrub input::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 16px;
    height: 16px;
    margin-top: -5.5px;
    border-radius: 50%;
    background: var(--ink);
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.25);
  }
  .scrub input::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border: 0;
    border-radius: 50%;
    background: var(--ink);
  }
  .ahead {
    font-size: var(--t-caption);
    color: var(--ink-3);
    text-align: center;
    margin-top: 2px;
    font-variant-numeric: tabular-nums;
  }
  .scrub-meta {
    display: flex;
    justify-content: space-between;
    font-size: var(--t-caption);
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
    margin-top: -2px;
  }
  .transport {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 0 12px;
  }
  .icon-btn.lg {
    width: 52px;
    height: 52px;
  }
  .icon-btn:disabled {
    opacity: 0.3;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .tool {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 44px;
    border-radius: 22px;
    background: var(--bg-elev-2);
    color: var(--ink-2);
    font-size: var(--t-foot);
    font-weight: 600;
  }
  .tool.voice {
    flex: 1;
    min-width: 0;
    padding: 0 14px;
    color: var(--ink);
  }
  .tool.voice span {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tool.icon {
    width: 44px;
    flex: none;
    position: relative;
  }
  .tool.on {
    background: var(--accent-soft);
    color: var(--accent-ink);
    width: auto;
    padding: 0 12px;
  }
  .tiny {
    font-size: var(--t-caption);
    font-variant-numeric: tabular-nums;
  }
</style>
