<script lang="ts">
  import type { Snippet } from 'svelte';
  import X from '@lucide/svelte/icons/x';
  import { dragDismiss, fade, slideUp } from '../motion';

  interface Props {
    title?: string;
    onclose: () => void;
    /** 'auto' hugs content; 'large' fills most of the screen. */
    size?: 'auto' | 'large';
    children: Snippet;
    footer?: Snippet;
  }

  let { title, onclose, size = 'auto', children, footer }: Props = $props();

  let panel: HTMLElement | undefined = $state();

  $effect(() => {
    const prev = document.activeElement as HTMLElement | null;
    panel?.focus();
    return () => prev?.focus?.();
  });

  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose();
  }
</script>

<svelte:window onkeydown={key} />

<div class="layer">
  <button class="scrim" type="button" aria-label="Close" tabindex="-1" onclick={onclose} transition:fade></button>
  <div
    class="panel {size}"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    bind:this={panel}
    transition:slideUp
    use:dragDismiss={{ onDismiss: onclose, handle: '.grab, .head', scroller: '.body' }}
  >
    <div class="grab" aria-hidden="true"><span></span></div>
    {#if title}
      <header class="head">
        <h2>{title}</h2>
        <button class="icon-btn close" type="button" aria-label="Close" onclick={onclose}><X size={20} /></button>
      </header>
    {/if}
    <div class="body">
      {@render children()}
    </div>
    {#if footer}
      <div class="foot">{@render footer()}</div>
    {/if}
  </div>
</div>

<style>
  .layer {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
  }
  .scrim {
    position: absolute;
    inset: 0;
    background: var(--scrim);
  }
  .panel {
    position: relative;
    display: flex;
    flex-direction: column;
    max-height: calc(100dvh - var(--safe-top) - 12px);
    background: var(--bg-elev);
    border-radius: var(--r-xl) var(--r-xl) 0 0;
    box-shadow: var(--shadow-2);
    outline: none;
    will-change: transform;
  }
  .panel.large {
    height: calc(100dvh - var(--safe-top) - 12px);
  }
  .grab {
    display: grid;
    place-items: center;
    height: 22px;
    flex: none;
    touch-action: none;
  }
  .grab span {
    width: 38px;
    height: 5px;
    border-radius: 3px;
    background: var(--line-strong);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px 6px var(--gutter);
    touch-action: none;
  }
  .head h2 {
    flex: 1;
    font-size: var(--t-title3);
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .close {
    background: var(--bg-elev-2);
    width: 32px;
    height: 32px;
    position: relative;
    color: var(--ink-2);
  }
  .close::after {
    content: '';
    position: absolute;
    inset: -6px;
  }
  .body {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 4px var(--gutter) calc(var(--safe-bottom) + 20px);
  }
  .foot {
    flex: none;
    padding: 10px var(--gutter) calc(var(--safe-bottom) + 12px);
    border-top: 1px solid var(--line);
  }
  .body:has(+ .foot) {
    padding-bottom: 16px;
  }
</style>
