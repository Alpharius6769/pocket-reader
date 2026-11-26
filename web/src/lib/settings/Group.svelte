<script lang="ts">
  import type { Snippet } from 'svelte';
  interface Props {
    title?: string;
    footer?: string;
    children: Snippet;
  }
  let { title, footer, children }: Props = $props();
</script>

<section class="group">
  {#if title}<h2 class="eyebrow gt">{title}</h2>{/if}
  <ul class="card gl">{@render children()}</ul>
  {#if footer}<p class="gf">{footer}</p>{/if}
</section>

<style>
  .group {
    margin-bottom: 26px;
  }
  .gt {
    padding: 0 14px 8px;
  }
  .gl {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow: hidden;
    border-radius: 14px;
  }
  .gf {
    padding: 8px 14px 0;
    font-size: var(--t-foot);
    color: var(--ink-3);
    text-wrap: pretty;
  }
</style>
