<script lang="ts" generics="T extends string">
  interface Props {
    options: { value: T; label: string }[];
    value: T;
    label: string;
    onchange: (value: T) => void;
  }
  let { options, value, label, onchange }: Props = $props();
  const index = $derived(Math.max(0, options.findIndex((o) => o.value === value)));
</script>

<div class="seg" role="radiogroup" aria-label={label} style:--n={options.length} style:--i={index}>
  <span class="thumb" aria-hidden="true"></span>
  {#each options as o (o.value)}
    <button type="button" role="radio" aria-checked={o.value === value} onclick={() => onchange(o.value)}>{o.label}</button>
  {/each}
</div>

<style>
  .seg {
    position: relative;
    display: grid;
    grid-template-columns: repeat(var(--n), 1fr);
    padding: 3px;
    border-radius: 11px;
    background: var(--bg-sunk);
    min-height: 40px;
  }
  .thumb {
    position: absolute;
    top: 3px;
    bottom: 3px;
    left: 3px;
    width: calc((100% - 6px) / var(--n));
    transform: translateX(calc(100% * var(--i)));
    border-radius: 8px;
    background: var(--bg-elev);
    box-shadow: var(--shadow-1);
    transition: transform var(--dur-2) var(--ease-sheet);
  }
  button {
    position: relative;
    min-height: 34px;
    font-size: var(--t-foot);
    font-weight: 600;
    color: var(--ink-2);
    border-radius: 8px;
  }
  button::after {
    content: '';
    position: absolute;
    inset: -5px 0;
  }
  button[aria-checked='true'] {
    color: var(--ink);
  }
</style>
