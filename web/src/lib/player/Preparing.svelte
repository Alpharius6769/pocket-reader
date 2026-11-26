<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import type { EngineState } from '../core/bridge';
  import { ENGINES } from '../core/bridge';
  import { bytes } from '../format';
  import Virtue from '../components/Virtue.svelte';

  interface Props {
    state: EngineState;
    compact?: boolean;
  }
  let { state, compact = false }: Props = $props();

  const STEPS = [
    { id: 'download', label: 'Downloading the voice' },
    { id: 'compile', label: 'Starting the engine' },
    { id: 'warmup', label: 'Warming up' },
    { id: 'first-paragraph', label: 'Reading the first lines' },
  ] as const;

  const current = $derived(Math.max(0, STEPS.findIndex((s) => s.id === state.stage)));
  const fraction = $derived.by(() => {
    const dl = state.totalBytes ? (state.loadedBytes ?? 0) / state.totalBytes : 0;
    if (state.stage === 'download') return dl * 0.7;
    return 0.7 + (current / (STEPS.length - 1)) * 0.3;
  });
</script>

<section class="prep" class:compact aria-live="polite" aria-label="Preparing narration">
  {#if !compact}
    <Virtue mood="loading" height={170} />
  {/if}
  <h3>Preparing narration</h3>
  <p class="muted lede">
    {ENGINES[state.engine].name} runs entirely on your phone. This happens once; after that, stories start in seconds.
  </p>

  <div class="progress-track big" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(fraction * 100)}>
    <span style:width="{fraction * 100}%"></span>
  </div>

  <ol class="steps">
    {#each STEPS as step, i (step.id)}
      <li class:done={i < current} class:now={i === current}>
        <span class="dot">{#if i < current}<Check size={14} strokeWidth={3} />{/if}</span>
        <span class="lbl">{step.label}</span>
        {#if step.id === 'download' && i === current && state.totalBytes}
          <span class="num">{bytes(state.loadedBytes ?? 0)} of {bytes(state.totalBytes)}</span>
        {/if}
      </li>
    {/each}
  </ol>
</section>

<style>
  .prep {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 8px calc(var(--gutter) + 8px);
    gap: 10px;
  }
  h3 {
    font-family: var(--font-display);
    font-size: var(--t-title2);
    font-weight: 700;
    letter-spacing: -0.01em;
    margin-top: 6px;
  }
  .lede {
    font-size: var(--t-sub);
    max-width: 30ch;
    text-wrap: pretty;
  }
  .big {
    width: 100%;
    max-width: 300px;
    height: 6px;
    margin: 8px 0 4px;
  }
  .big span {
    transition: width var(--dur-3) var(--ease-out);
  }
  .steps {
    list-style: none;
    padding: 0;
    margin: 4px 0 0;
    display: grid;
    gap: 8px;
    text-align: left;
    width: 100%;
    max-width: 300px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--t-sub);
    color: var(--ink-3);
  }
  li.now {
    color: var(--ink);
    font-weight: 600;
  }
  li.done {
    color: var(--ink-2);
  }
  .dot {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 1.5px solid var(--line-strong);
    flex: none;
  }
  .done .dot {
    background: var(--ok);
    border-color: var(--ok);
    color: #fff;
  }
  .now .dot {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 4px var(--accent);
  }
  .num {
    margin-left: auto;
    font-size: var(--t-foot);
    font-weight: 500;
    color: var(--ink-2);
    font-variant-numeric: tabular-nums;
  }
</style>
