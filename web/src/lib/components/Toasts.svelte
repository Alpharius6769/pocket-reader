<script lang="ts">
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleAlert from '@lucide/svelte/icons/circle-exclamation-point';
  import Info from '@lucide/svelte/icons/info';
  import TriangleAlert from '@lucide/svelte/icons/triangle-exclamation-point';
  import { fly } from 'svelte/transition';
  import { flip } from 'svelte/animate';
  import { bridge } from '../core';
  import { ui, dismissToast } from '../stores/ui';
  import { reducedMotion } from '../motion';

  const icons = { success: CircleCheck, error: CircleAlert, warning: TriangleAlert, info: Info };
</script>

<div class="toasts" aria-live="polite" aria-atomic="false">
  {#each $ui.toasts as t (t.id)}
    {@const Icon = icons[t.level]}
    <div
      class="toast {t.level}"
      role={t.level === 'error' ? 'alert' : 'status'}
      in:fly={{ y: reducedMotion() ? 0 : -24, duration: 260 }}
      out:fly={{ y: reducedMotion() ? 0 : -16, duration: 180 }}
      animate:flip={{ duration: 200 }}
    >
      <Icon size={20} />
      <span class="msg">{t.message}</span>
      {#if t.actionLabel}
        <button type="button" class="act" onclick={() => { bridge().runNoticeAction(t.id); dismissToast(t.id); }}>{t.actionLabel}</button>
      {/if}
      <button type="button" class="dismiss" aria-label="Dismiss" onclick={() => dismissToast(t.id)}></button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    z-index: 90;
    top: calc(var(--safe-top) + 6px);
    left: 12px;
    right: 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    pointer-events: none;
  }
  .toast {
    position: relative;
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 420px;
    width: fit-content;
    min-height: 48px;
    padding: 10px 16px 10px 14px;
    border-radius: 24px;
    background: var(--ink);
    color: var(--bg);
    box-shadow: var(--shadow-2);
    font-size: var(--t-sub);
    font-weight: 500;
  }
  .success :global(svg) {
    color: color-mix(in srgb, var(--ok) 70%, var(--bg));
  }
  .error :global(svg),
  .warning :global(svg) {
    color: color-mix(in srgb, var(--accent) 80%, var(--bg));
  }
  .msg {
    line-height: 1.3;
  }
  .act {
    position: relative;
    z-index: 1;
    margin-left: 4px;
    font-weight: 700;
    color: var(--accent-soft);
    min-height: 32px;
  }
  .dismiss {
    position: absolute;
    inset: 0;
    border-radius: inherit;
  }
</style>
