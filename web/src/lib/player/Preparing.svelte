<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import type { EngineState, RunwayState } from '../core/bridge';
  import { ENGINES } from '../core/bridge';
  import { bytes, etaLabel } from '../format';
  import { runwayEta } from '../stores/eta';
  import { deviceNoun } from '../layout';
  import Virtue from '../components/Virtue.svelte';

  interface Props {
    state: EngineState;
    runway: RunwayState;
    /** The first narration of a session needs a tap (it reloads into the fast session). */
    needsTap?: boolean;
    onstart?: () => void;
    compact?: boolean;
  }
  let { state, runway, needsTap = false, onstart, compact = false }: Props = $props();

  // Three steps, all visible until Play unlocks: the model, then the starting
  // runway of ten rendered paragraphs, then ready.
  const engineReady = $derived(state.status === 'ready' || (runway.ready > 0 && state.status !== 'loading'));
  const step = $derived(runway.ok ? 2 : engineReady ? 1 : 0);
  const fraction = $derived.by(() => {
    if (runway.ok) return 1;
    if (!engineReady) {
      const dl = state.totalBytes ? (state.loadedBytes ?? 0) / state.totalBytes : 0;
      return state.stage === 'download' ? dl * 0.4 : 0.4;
    }
    return 0.4 + (runway.target ? runway.ready / runway.target : 0) * 0.6;
  });
  const engineLine = $derived.by(() => {
    if (state.status === 'error') return 'The voice could not load';
    if (state.stage === 'download' && state.totalBytes) return `${bytes(state.loadedBytes ?? 0)} of ${bytes(state.totalBytes)}`;
    return state.message || '';
  });
</script>

<section class="prep" class:compact aria-live="polite" aria-label="Preparing narration">
  {#if !compact}
    <Virtue mood={runway.ok ? 'holding' : 'loading'} height={140} />
  {/if}
  <h3>{runway.ok ? 'Ready to listen' : 'Preparing narration'}</h3>
  {#if !compact}
    <p class="muted lede">
      {#if runway.ok}
        The first {runway.target} paragraphs are ready. Tap Play.
      {:else}
        {ENGINES[state.engine].name} runs entirely on your {$deviceNoun}. Play unlocks once the next {runway.target || 10} paragraphs are ready, so narration never stops to catch up.
      {/if}
    </p>
  {/if}

  <div class="progress-track big" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(fraction * 100)}>
    <span style:width="{fraction * 100}%"></span>
  </div>
  {#if step === 1 && runway.preparing && !runway.error}
    <p class="eta">{etaLabel($runwayEta)}</p>
  {/if}

  <ol class="steps">
    <li class:done={step > 0} class:now={step === 0}>
      <span class="dot">{#if step > 0}<Check size={14} strokeWidth={3} />{/if}</span>
      <span class="lbl">Loading the voice</span>
      {#if step === 0 && engineLine}<span class="num">{engineLine}</span>{/if}
    </li>
    <li class:done={step > 1} class:now={step === 1}>
      <span class="dot">{#if step > 1}<Check size={14} strokeWidth={3} />{/if}</span>
      <span class="lbl">Preparing paragraphs</span>
      <span class="num">{runway.ready} of {runway.target || 10}</span>
    </li>
    <li class:done={runway.ok} class:now={runway.ok}>
      <span class="dot">{#if runway.ok}<Check size={14} strokeWidth={3} />{/if}</span>
      <span class="lbl">Ready to play</span>
    </li>
  </ol>

  {#if runway.error}
    <p class="err">{runway.error}</p>
  {/if}
  {#if (needsTap || runway.error) && onstart && !runway.preparing && !runway.ok}
    <button class="btn btn-primary" type="button" onclick={onstart}>{runway.error ? 'Try again' : 'Load the voice'}</button>
  {/if}
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
  .prep.compact {
    flex: none;
    padding: 12px var(--gutter);
    gap: 8px;
    border-radius: 16px;
    background: var(--bg-elev);
    margin: 8px var(--gutter) 0;
  }
  h3 {
    font-family: var(--font-display);
    font-size: var(--t-title2);
    font-weight: 700;
    letter-spacing: -0.01em;
    margin-top: 6px;
  }
  .compact h3 {
    font-size: var(--t-head);
    margin: 0;
  }
  .lede {
    font-size: var(--t-sub);
    max-width: 32ch;
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
  .eta {
    font-size: var(--t-foot);
    font-weight: 600;
    color: var(--accent-ink);
    font-variant-numeric: tabular-nums;
    min-height: 1.4em;
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
  .err {
    color: var(--danger);
    font-size: var(--t-foot);
  }
</style>
