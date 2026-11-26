<script lang="ts">
  import type { Snippet, Component } from 'svelte';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';

  interface Props {
    label: string;
    sub?: string;
    value?: string;
    icon?: Component<{ size?: number }>;
    tint?: string;
    onclick?: () => void;
    trailing?: Snippet;
    danger?: boolean;
  }
  let { label, sub, value, icon: Icon, tint = 'var(--ink-2)', onclick, trailing, danger = false }: Props = $props();
</script>

{#snippet inner()}
  {#if Icon}<span class="ic" style:background={tint}><Icon size={17} /></span>{/if}
  <span class="txt">
    <span class="lbl" class:danger>{label}</span>
    {#if sub}<span class="sub">{sub}</span>{/if}
  </span>
  {#if value}<span class="val">{value}</span>{/if}
  {#if trailing}{@render trailing()}{/if}
  {#if onclick && !trailing}<span class="chev"><ChevronRight size={18} /></span>{/if}
{/snippet}

<li class="row-li">
  {#if onclick}
    <button type="button" class="row" {onclick}>{@render inner()}</button>
  {:else}
    <div class="row">{@render inner()}</div>
  {/if}
</li>

<style>
  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 50px;
    padding: 8px 14px 8px 14px;
    text-align: left;
  }
  button.row:active {
    background: var(--bg-elev-2);
  }
  .ic {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    color: #fff;
    flex: none;
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: grid;
  }
  .lbl.danger {
    color: var(--danger);
  }
  .sub {
    font-size: var(--t-foot);
    color: var(--ink-2);
    text-wrap: pretty;
  }
  .val {
    color: var(--ink-3);
    font-size: var(--t-sub);
    white-space: nowrap;
  }
  .chev {
    color: var(--ink-3);
    display: grid;
    margin-right: -4px;
  }
  :global(.row-li + .row-li) .row {
    border-top: 0.5px solid var(--line);
  }
</style>
