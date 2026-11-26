<script lang="ts">
  import Play from '@lucide/svelte/icons/play';
  import Check from '@lucide/svelte/icons/check';
  import { bridge, ENGINES, SPEEDS, type EngineId, type Voice } from '../core';
  import { attempt, updateSettings } from '../actions';
  import { player } from '../stores/player';
  import { settings } from '../stores/settings';
  import { closeSheet } from '../stores/ui';
  import { speedLabel } from '../format';
  import Sheet from '../components/Sheet.svelte';
  import Segmented from '../components/Segmented.svelte';
  import Toggle from '../components/Toggle.svelte';

  interface Props {
    /** Render inline (Settings page) instead of in a sheet. */
    inline?: boolean;
  }
  let { inline = false }: Props = $props();

  const engine = $derived($player.engine);
  const voices = $derived(bridge().listVoices(engine));
  const groups = $derived([
    { label: 'Female voices', list: voices.filter((v) => v.gender === 'female') },
    { label: 'Male voices', list: voices.filter((v) => v.gender === 'male') },
  ]);
  let previewing = $state<string | null>(null);

  async function preview(v: Voice) {
    previewing = v.id;
    await attempt(() => bridge().previewVoice(v.id));
    previewing = null;
  }
</script>

{#snippet content()}
  <section class="block">
    <h3 class="eyebrow">Engine</h3>
    <Segmented
      label="Narration engine"
      value={engine}
      options={[
        { value: 'pocket', label: 'Pocket' },
        { value: 'kokoro', label: 'Kokoro' },
      ]}
      onchange={(v: EngineId) => attempt(() => bridge().setEngine(v))}
    />
    <p class="hint">{ENGINES[engine].blurb}</p>
  </section>

  {#each groups as g (g.label)}
    <section class="block">
      <h3 class="eyebrow">{g.label}</h3>
      <ul class="voices" role="radiogroup" aria-label={g.label}>
        {#each g.list as v (v.id)}
          <li>
            <button
              type="button"
              role="radio"
              class="pick"
              aria-checked={$player.voice === v.id}
              onclick={() => attempt(() => bridge().setVoice(v.id))}
            >
              <span class="name">{v.name}</span>
              <span class="desc">{v.accent} · {v.character}</span>
              {#if $player.voice === v.id}<span class="tickmark"><Check size={20} strokeWidth={2.6} /></span>{/if}
            </button>
            <button class="icon-btn prev" class:busy={previewing === v.id} type="button" aria-label="Hear {v.name}" onclick={() => preview(v)}>
              <Play size={16} fill="currentColor" strokeWidth={0} />
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/each}

  <section class="block">
    <h3 class="eyebrow">Speed <span class="val">{speedLabel($player.speed)}</span></h3>
    <div class="speeds" role="radiogroup" aria-label="Playback speed">
      {#each SPEEDS as s (s)}
        <button type="button" role="radio" class="chip" aria-checked={$player.speed === s} class:on={$player.speed === s} onclick={() => bridge().setSpeed(s)}>
          {speedLabel(s)}
        </button>
      {/each}
    </div>
  </section>

  {#if engine === 'pocket'}
    <section class="block row">
      <div>
        <div class="name">Expressive narration</div>
        <p class="hint">Lets the voice react to the scene — softer, brighter, tense.</p>
      </div>
      <Toggle label="Expressive narration" checked={$settings?.expressive ?? true} onchange={(v) => updateSettings({ expressive: v })} />
    </section>
  {/if}
{/snippet}

{#if inline}
  {@render content()}
{:else}
  <Sheet title="Voice & speed" onclose={closeSheet} size="large">
    {@render content()}
  </Sheet>
{/if}

<style>
  .block {
    padding: 12px 0;
  }
  .block + .block {
    border-top: 0.5px solid var(--line);
  }
  .block .eyebrow {
    margin-bottom: 10px;
    display: flex;
    justify-content: space-between;
  }
  .val {
    color: var(--ink);
    text-transform: none;
    letter-spacing: 0;
    font-size: var(--t-sub);
  }
  .hint {
    font-size: var(--t-foot);
    color: var(--ink-2);
    margin-top: 8px;
    text-wrap: pretty;
  }
  .voices {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 8px;
  }
  .voices li {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .pick {
    flex: 1;
    min-width: 0;
    position: relative;
    display: grid;
    text-align: left;
    padding: 10px 44px 10px 14px;
    min-height: 56px;
    border-radius: 14px;
    background: var(--bg-elev-2);
    border: 1.5px solid transparent;
  }
  .pick[aria-checked='true'] {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .name {
    font-weight: 600;
  }
  .desc {
    font-size: var(--t-foot);
    color: var(--ink-2);
  }
  .tickmark {
    position: absolute;
    right: 14px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--accent-ink);
  }
  .prev {
    background: var(--bg-elev-2);
    color: var(--ink);
  }
  .prev.busy {
    color: var(--accent);
    animation: pulse 0.8s ease-in-out infinite alternate;
  }
  @keyframes pulse {
    to {
      opacity: 0.4;
    }
  }
  .speeds {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .speeds .chip {
    min-width: 58px;
    justify-content: center;
    font-variant-numeric: tabular-nums;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
</style>
