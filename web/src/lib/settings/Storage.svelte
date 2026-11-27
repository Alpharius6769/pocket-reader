<script lang="ts">
  import { deviceNoun } from '../layout';
  import { onMount } from 'svelte';
  import { bridge, type StorageUsage } from '../core';
  import { attempt } from '../actions';
  import { library } from '../stores/library';
  import { bytes } from '../format';
  import Group from './Group.svelte';
  import Row from './Row.svelte';

  let usage = $state<StorageUsage | null>(null);
  let confirm = $state<'audio' | 'models' | null>(null);

  async function refresh() {
    usage = (await attempt(() => bridge().getStorageUsage())) ?? null;
  }
  onMount(refresh);

  const total = $derived(usage ? usage.voiceModelsBytes + usage.audioCacheBytes + usage.storiesBytes : 0);
  const offline = $derived($library.entries.filter((e) => e.cache.state === 'complete').length);

  async function clear(kind: 'audio' | 'models') {
    confirm = null;
    await attempt(() => (kind === 'audio' ? bridge().clearAudioCache() : bridge().clearVoiceModels()));
    await refresh();
  }
</script>

{#if usage}
  <div class="card meter">
    <div class="big">{bytes(total)}</div>
    <div class="muted small">used on this {$deviceNoun}{#if usage.quotaBytes}&nbsp;of {bytes(usage.quotaBytes)} available to the app{/if}</div>
    <div class="bar" aria-hidden="true">
      <span class="m" style:flex={usage.voiceModelsBytes}></span>
      <span class="a" style:flex={usage.audioCacheBytes}></span>
      <span class="s" style:flex={usage.storiesBytes}></span>
      {#if usage.quotaBytes}<span class="free" style:flex={Math.max(0, usage.quotaBytes - total)}></span>{/if}
    </div>
    <ul class="legend">
      <li><span class="sw m"></span>Voice models<span>{bytes(usage.voiceModelsBytes)}</span></li>
      <li><span class="sw a"></span>Saved narration<span>{bytes(usage.audioCacheBytes)}</span></li>
      <li><span class="sw s"></span>Stories<span>{bytes(usage.storiesBytes)}</span></li>
    </ul>
  </div>
{/if}

<Group title="Saved narration" footer="{offline} {offline === 1 ? 'story is' : 'stories are'} fully saved for offline listening. Clearing keeps your stories and progress; narration is made again when you play.">
  {#if confirm === 'audio'}
    <li class="confirm">
      <span>Delete all saved narration?</span>
      <button class="btn btn-plain" type="button" onclick={() => (confirm = null)}>Cancel</button>
      <button class="btn danger" type="button" onclick={() => clear('audio')}>Delete</button>
    </li>
  {:else}
    <Row label="Clear saved narration" danger onclick={() => (confirm = 'audio')} />
  {/if}
</Group>

<Group title="Voice models" footer="Removing models frees space. They download again the next time you press play.">
  {#if confirm === 'models'}
    <li class="confirm">
      <span>Remove voice models?</span>
      <button class="btn btn-plain" type="button" onclick={() => (confirm = null)}>Cancel</button>
      <button class="btn danger" type="button" onclick={() => clear('models')}>Remove</button>
    </li>
  {:else}
    <Row label="Remove voice models" danger onclick={() => (confirm = 'models')} />
  {/if}
</Group>

<style>
  .meter {
    padding: 18px;
    margin-bottom: 26px;
  }
  .big {
    font-family: var(--font-display);
    font-size: var(--t-title1);
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .small {
    font-size: var(--t-foot);
  }
  .bar {
    display: flex;
    gap: 2px;
    height: 12px;
    border-radius: 6px;
    overflow: hidden;
    margin: 14px 0 12px;
    background: var(--bg-sunk);
  }
  .m {
    background: var(--accent);
  }
  .a {
    background: var(--hoodie);
  }
  .s {
    background: var(--ok);
  }
  .free {
    background: transparent;
  }
  .legend {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
    font-size: var(--t-sub);
  }
  .legend li {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .legend li span:last-child {
    margin-left: auto;
    color: var(--ink-2);
    font-variant-numeric: tabular-nums;
  }
  .sw {
    width: 10px;
    height: 10px;
    border-radius: 3px;
  }
  .confirm {
    list-style: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px 8px 14px;
    min-height: 56px;
  }
  .confirm span {
    flex: 1;
    font-weight: 600;
  }
  .danger {
    background: var(--danger);
    color: #fff;
  }
</style>
