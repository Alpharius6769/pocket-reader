<script lang="ts">
  import Play from '@lucide/svelte/icons/play';
  import Pause from '@lucide/svelte/icons/pause';
  import type { PlayState } from '../core/bridge';

  interface Props {
    state: PlayState;
    size?: number;
    variant?: 'filled' | 'bare';
    onclick: () => void;
    /** 0..1 progress of an engine download, drawn as a ring. */
    loading?: number | null;
    /** Narration is not ready to start (the starting runway is still being prepared). */
    disabled?: boolean;
    label?: string;
  }
  let { state, size = 44, variant = 'filled', onclick, loading = null, disabled = false, label }: Props = $props();

  const busy = $derived(state === 'loading' || state === 'buffering');
  const showPause = $derived(state === 'playing' || busy);
  const icon = $derived(Math.round(size * 0.42));
</script>

<button
  type="button"
  class="play {variant}"
  class:busy
  style:width="{size}px"
  style:height="{size}px"
  aria-label={label ?? (showPause ? 'Pause' : 'Play')}
  {disabled}
  {onclick}
>
  {#if busy}
    <svg class="ring" viewBox="0 0 36 36" aria-hidden="true">
      <circle cx="18" cy="18" r="16.5" pathLength="100" class="track" />
      <circle
        cx="18"
        cy="18"
        r="16.5"
        pathLength="100"
        class="arc"
        class:spin={loading == null}
        style:stroke-dasharray={loading == null ? '28 100' : `${Math.max(3, loading * 100)} 100`}
      />
    </svg>
  {/if}
  {#if showPause}
    <Pause size={icon} fill="currentColor" strokeWidth={0} />
  {:else}
    <span class="nudge"><Play size={icon} fill="currentColor" strokeWidth={0} /></span>
  {/if}
</button>

<style>
  .play {
    position: relative;
    display: grid;
    place-items: center;
    border-radius: 50%;
    flex: none;
    transition: transform var(--dur-1) var(--ease-out);
  }
  .play:active:not(:disabled) {
    transform: scale(0.92);
  }
  .play:disabled {
    opacity: 0.45;
    box-shadow: none;
  }
  .filled {
    background: var(--accent);
    color: var(--accent-on);
    box-shadow: 0 6px 18px -6px color-mix(in srgb, var(--accent) 70%, transparent);
  }
  .bare {
    color: var(--ink);
  }
  .nudge {
    display: grid;
    transform: translateX(6%);
  }
  .ring {
    position: absolute;
    inset: -5px;
    width: calc(100% + 10px);
    height: calc(100% + 10px);
    transform: rotate(-90deg);
  }
  .ring circle {
    fill: none;
    stroke-width: 2.5;
  }
  .track {
    stroke: var(--line);
  }
  .arc {
    stroke: var(--accent);
    stroke-linecap: round;
    transition: stroke-dasharray var(--dur-2) linear;
  }
  .spin {
    transform-origin: 18px 18px;
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
