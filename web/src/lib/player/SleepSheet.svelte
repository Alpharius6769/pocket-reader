<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import { bridge } from '../core';
  import { player } from '../stores/player';
  import { closeSheet } from '../stores/ui';
  import { clockLeft } from '../format';
  import Sheet from '../components/Sheet.svelte';

  const OPTIONS: { label: string; timer: Parameters<ReturnType<typeof bridge>['setSleepTimer']>[0] }[] = [
    { label: 'Off', timer: { kind: 'off' } },
    { label: '15 minutes', timer: { kind: 'minutes', minutes: 15 } },
    { label: '30 minutes', timer: { kind: 'minutes', minutes: 30 } },
    { label: '45 minutes', timer: { kind: 'minutes', minutes: 45 } },
    { label: '1 hour', timer: { kind: 'minutes', minutes: 60 } },
    { label: 'End of this chapter', timer: { kind: 'end-of-chapter' } },
  ];

  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });

  function isOn(t: (typeof OPTIONS)[number]['timer']) {
    const s = $player.sleep;
    if (t.kind !== s.kind) return false;
    return t.kind !== 'minutes' || (s.kind === 'minutes' && s.minutes === t.minutes);
  }

  function choose(t: (typeof OPTIONS)[number]['timer']) {
    bridge().setSleepTimer(t);
    closeSheet();
  }
</script>

<Sheet title="Sleep timer" onclose={closeSheet}>
  {#if $player.sleep.kind === 'minutes'}
    <p class="left">Narration stops in <strong>{clockLeft($player.sleep.endsAt, now)}</strong></p>
  {:else if $player.sleep.kind === 'end-of-chapter'}
    <p class="left">Narration stops at the end of this chapter</p>
  {/if}
  <ul class="list" role="radiogroup" aria-label="Sleep timer">
    {#each OPTIONS as o (o.label)}
      <li>
        <button type="button" role="radio" aria-checked={isOn(o.timer)} onclick={() => choose(o.timer)}>
          <span>{o.label}</span>
          {#if isOn(o.timer)}<Check size={20} strokeWidth={2.6} />{/if}
        </button>
      </li>
    {/each}
  </ul>
</Sheet>

<style>
  .left {
    padding: 4px 0 12px;
    color: var(--ink-2);
  }
  .left strong {
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .list li + li {
    border-top: 0.5px solid var(--line);
  }
  .list button {
    width: 100%;
    min-height: 52px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: var(--t-head);
    color: var(--ink);
  }
  .list button[aria-checked='true'] {
    color: var(--accent-ink);
    font-weight: 600;
  }
</style>
