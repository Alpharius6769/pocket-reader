<script lang="ts">
  import Star from '@lucide/svelte/icons/star';

  interface Props {
    value: number;
    onchange?: (stars: 0 | 1 | 2 | 3 | 4 | 5) => void;
    size?: number;
  }
  let { value, onchange, size = 28 }: Props = $props();
</script>

{#if onchange}
  <div class="stars" role="radiogroup" aria-label="Your rating">
    {#each [1, 2, 3, 4, 5] as n (n)}
      <button
        type="button"
        role="radio"
        aria-checked={value === n}
        aria-label="{n} star{n > 1 ? 's' : ''}"
        class:on={n <= value}
        onclick={() => onchange((value === n ? 0 : n) as 0 | 1 | 2 | 3 | 4 | 5)}
      >
        <Star {size} fill={n <= value ? 'currentColor' : 'none'} strokeWidth={1.8} />
      </button>
    {/each}
  </div>
{:else}
  <span class="stars static" role="img" aria-label="{value} of 5 stars">
    {#each [1, 2, 3, 4, 5] as n (n)}
      <span class:on={n <= Math.round(value)}><Star {size} fill={n <= Math.round(value) ? 'currentColor' : 'none'} strokeWidth={1.8} /></span>
    {/each}
  </span>
{/if}

<style>
  .stars {
    display: inline-flex;
    gap: 2px;
    color: var(--line-strong);
  }
  button {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    transition: transform var(--dur-1) var(--ease-out);
  }
  button:active {
    transform: scale(0.88);
  }
  .on {
    color: var(--accent);
  }
  .static {
    gap: 0;
  }
</style>
