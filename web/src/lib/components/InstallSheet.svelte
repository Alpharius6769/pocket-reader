<script lang="ts">
  import { closeSheet } from '../stores/ui';
  import { installWay, isAppleTouchDevice, INSTALL_BENEFITS } from '../install';
  import Sheet from './Sheet.svelte';
  import InstallGuide from './InstallGuide.svelte';

  // The line about iPhone alerts is only said to an iPhone.
  const apple = isAppleTouchDevice(navigator.userAgent || '', navigator.maxTouchPoints || 0);
  const benefits = INSTALL_BENEFITS.filter((line) => apple || !line.startsWith('On iPhone'));
</script>

<Sheet title="Install Pocket Reader" onclose={closeSheet}>
  {#if $installWay !== 'installed'}
    <ul class="why">
      {#each benefits as line (line)}<li>{line}</li>{/each}
    </ul>
  {/if}
  <div class="guide">
    <InstallGuide oninstalled={closeSheet} />
  </div>
</Sheet>

<style>
  .why {
    margin: 4px 0 16px;
    padding-left: 20px;
    display: grid;
    gap: 6px;
    font-size: var(--t-sub);
    color: var(--ink-2);
  }
  .guide {
    padding-bottom: 8px;
  }
</style>
