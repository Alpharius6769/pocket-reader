<script lang="ts">
  import RotateCw from '@lucide/svelte/icons/redo-2';
  import { bridge } from '../core';
  import { attempt } from '../actions';
  import { player, preparing, storyProgress, currentChapter, playLocked } from '../stores/player';
  import { ui, openPlayer } from '../stores/ui';
  import Cover from './Cover.svelte';
  import PlayButton from './PlayButton.svelte';

  const loadFraction = $derived(
    $player.engineState.totalBytes ? ($player.engineState.loadedBytes ?? 0) / $player.engineState.totalBytes : null,
  );

  const subtitle = $derived(
    $preparing || $player.runway.preparing
      ? `Preparing narration… ${$player.runway.ready} of ${$player.runway.target || 10}`
      : $player.state === 'buffering'
        ? 'Getting the next lines ready…'
        : ($currentChapter?.title ?? ''),
  );
</script>

{#if $player.story && $ui.tab !== 'player'}
  <div class="mini" role="region" aria-label="Now playing">
    <button class="open" type="button" onclick={() => openPlayer('listen')} aria-label="Open player for {$player.story.title}">
      <Cover story={$player.story} size={32} plain />
      <span class="text">
        <span class="title">{$player.story.title}</span>
        <span class="sub" class:live={$preparing}>{subtitle}</span>
      </span>
    </button>
    <PlayButton
      state={$preparing ? 'loading' : $player.state}
      loading={$preparing ? loadFraction : null}
      variant="bare"
      size={44}
      onclick={() => {
        // Not ready to start: show the preparation rather than a Play that does nothing.
        if ($playLocked) openPlayer('listen');
        else attempt(() => bridge().togglePlay());
      }}
    />
    <button class="icon-btn" type="button" aria-label="Next paragraph" onclick={() => attempt(() => bridge().skipParagraph(1))}>
      <RotateCw size={22} />
    </button>
    <span class="bar" style:width="{$storyProgress * 100}%" aria-hidden="true"></span>
  </div>
{/if}

<style>
  .mini {
    position: fixed;
    z-index: 31;
    left: calc(8px + var(--safe-left));
    right: calc(8px + var(--safe-right));
    bottom: calc(var(--tabbar-h) + var(--safe-bottom) + 6px);
    height: var(--mini-h);
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 6px 0 10px;
    border-radius: 16px;
    background: var(--bg-glass);
    -webkit-backdrop-filter: saturate(1.6) blur(22px);
    backdrop-filter: saturate(1.6) blur(22px);
    box-shadow: var(--shadow-2);
    border: 0.5px solid var(--line);
    overflow: hidden;
  }
  .open {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    height: 100%;
    text-align: left;
  }
  .open :global(.cover) {
    border-radius: 4px;
  }
  .text {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .title {
    font-weight: 600;
    font-size: var(--t-sub);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub {
    font-size: var(--t-foot);
    color: var(--ink-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub.live {
    color: var(--accent-ink);
  }
  .bar {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 2px;
    background: var(--accent);
    transition: width var(--dur-3) linear;
  }
</style>
