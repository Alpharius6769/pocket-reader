<script lang="ts">
  import Download from '@lucide/svelte/icons/download';
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import { boldRuns, installWay, iosInstallSteps, menuInstallSteps, promptInstall, type InstallStep } from '../install';
  import { toast } from '../stores/ui';
  import { tick } from '../actions';

  interface Props {
    /** Called when the app has been installed from here. */
    oninstalled?: () => void;
  }
  let { oninstalled }: Props = $props();

  const ua = navigator.userAgent || '';
  let asking = $state(false);

  const steps = $derived.by((): InstallStep[] => {
    if ($installWay === 'ios') return iosInstallSteps(ua);
    if ($installWay === 'menu') return menuInstallSteps(ua);
    return [];
  });

  // The address without the install link's own marker, for pasting into Safari.
  function pageLink() {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    return url.href;
  }

  async function install() {
    tick();
    asking = true;
    const outcome = await promptInstall();
    asking = false;
    if (outcome === 'accepted') {
      toast({ level: 'success', message: 'Pocket Reader is installed. Open it from your home screen or apps list.', mood: 'happy' });
      oninstalled?.();
    } else if (outcome === 'unavailable') {
      toast({ level: 'info', message: 'Your browser did not offer to install. Use its menu and choose “Install” or “Add to Home screen”.' });
    }
  }

  async function copyLink() {
    tick();
    try {
      await navigator.clipboard.writeText(pageLink());
      toast({ level: 'success', message: 'Link copied. Open Safari and paste it into the address bar.' });
    } catch {
      toast({ level: 'info', message: `Open Safari and go to ${pageLink()}` });
    }
  }
</script>

{#if $installWay === 'installed'}
  <p class="state"><Check size={18} strokeWidth={2.6} /> Pocket Reader is installed on this device.</p>
{:else if $installWay === 'prompt'}
  <button class="btn btn-primary btn-block" type="button" disabled={asking} onclick={install}>
    <Download size={20} />
    {asking ? 'Waiting for your answer…' : 'Install Pocket Reader'}
  </button>
  <p class="note">One tap. Your browser asks you to confirm, and that is all.</p>
{:else if $installWay === 'ios-other'}
  <p class="note strong">This page is open inside another app, which cannot add it to your home screen.</p>
  <ol>
    <li><span class="num" aria-hidden="true">1</span><span class="text">Copy the link below</span></li>
    <li><span class="num" aria-hidden="true">2</span><span class="text">Open <strong>Safari</strong>, paste it in the address bar and go</span></li>
    <li><span class="num" aria-hidden="true">3</span><span class="text">Come back to this card there for the last two taps</span></li>
  </ol>
  <button class="btn btn-tonal btn-block copy" type="button" onclick={copyLink}><Copy size={18} /> Copy link</button>
{:else if steps.length}
  <ol>
    {#each steps as step (step.marker + step.text)}
      <li>
        <span class="num" aria-hidden="true">{step.marker}</span>
        <span class="text">{#each boldRuns(step.text) as run}{#if run.bold}<strong>{run.text}</strong>{:else}{run.text}{/if}{/each}</span>
      </li>
    {/each}
  </ol>
{:else}
  <p class="note">This browser cannot install web apps. Open Pocket Reader in Chrome or Edge to install it.</p>
{/if}

<style>
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
  .note {
    margin: 8px 0 0;
    font-size: var(--t-foot);
    color: var(--ink-2);
    text-wrap: pretty;
  }
  .note.strong {
    margin: 0 0 12px;
    color: var(--ink);
    font-weight: 600;
  }
  .copy {
    margin-top: 12px;
  }
  .state {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-weight: 600;
    color: var(--ok);
  }
</style>
