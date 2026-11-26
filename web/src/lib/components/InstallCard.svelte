<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import { boldRuns, iosInstallSteps, isAppleTouchDevice, isInstalled } from '../install';

  const DISMISS_KEY = 'pr_v2_install_card_dismissed';
  const ua = navigator.userAgent || '';
  let dismissed = $state(localStorage.getItem(DISMISS_KEY) === '1');
  const show = $derived(!dismissed && isAppleTouchDevice(ua, navigator.maxTouchPoints || 0) && !isInstalled());
  const steps = iosInstallSteps(ua);

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
    <p class="why">Installed, it keeps reading with your screen locked and shows lock-screen controls.</p>
    <ol>
      {#each steps as step (step.marker + step.text)}
        <li>
          <span class="num" aria-hidden="true">{step.marker}</span>
          <span class="text">{#each boldRuns(step.text) as run}{#if run.bold}<strong>{run.text}</strong>{:else}{run.text}{/if}{/each}</span>
        </li>
      {/each}
    </ol>
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
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 10px;
  }
  li {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }
  .num {
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 0.8rem;
    font-weight: 700;
    background: var(--accent);
    color: var(--accent-on);
  }
  /* One flex item per step, so the bold runs stay inside their sentence. */
  .text {
    flex: 1 1 auto;
    line-height: 1.4;
  }
</style>
