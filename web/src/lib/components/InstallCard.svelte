<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import { installWay, INSTALL_WHY } from '../install';
  import InstallGuide from './InstallGuide.svelte';

  const DISMISS_KEY = 'pr_v2_install_card_dismissed';
  let dismissed = $state(localStorage.getItem(DISMISS_KEY) === '1');
  // Offered on Home wherever installing is a tap or a short set of steps. A
  // browser whose install entry is buried in a desktop menu is left to the
  // Settings row: a card for it on every visit would be nagging.
  const offered = $derived(
    $installWay === 'prompt' || $installWay === 'ios' || $installWay === 'ios-other'
      || ($installWay === 'menu' && /Android/i.test(navigator.userAgent || '')),
  );
  const show = $derived(!dismissed && offered);

  function dismiss() {
    dismissed = true;
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* storage blocked */ }
  }
</script>

{#if show}
  <section class="install card" aria-labelledby="install-title">
    <header>
      <h2 id="install-title">Install Pocket Reader</h2>
      <button class="close" type="button" onclick={dismiss} aria-label="Hide install instructions"><X size={18} /></button>
    </header>
    <p class="why">{INSTALL_WHY}</p>
    <InstallGuide oninstalled={dismiss} />
  </section>
{/if}

<style>
  .install {
    margin: 14px 0 6px;
    padding: 16px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  h2 {
    font-size: 1.05rem;
    margin: 0;
  }
  .close {
    min-width: 44px;
    min-height: 44px;
    display: grid;
    place-items: center;
    border: 0;
    background: transparent;
    color: inherit;
    margin: -10px -10px -10px 0;
  }
  .why {
    margin: 4px 0 12px;
    opacity: 0.8;
    font-size: 0.92rem;
  }
</style>
