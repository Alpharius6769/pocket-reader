<script lang="ts">
  import { pushSettings, toast } from '../stores/ui';
  import { longPress } from '../motion';
  import Group from './Group.svelte';
  import Row from './Row.svelte';

  const version = import.meta.env.VITE_APP_VERSION ?? '2.0.0';

  function openDiagnostics() {
    navigator.vibrate?.(15);
    toast({ level: 'info', message: 'Developer diagnostics' });
    pushSettings('diagnostics');
  }

  function open(path: string) {
    window.open(new URL(path, document.baseURI).href, '_blank', 'noopener');
  }
</script>

<div class="brand">
  <img src="./assets/img/pocket_reader_icon.webp" alt="" width="84" height="84" />
  <h2>Pocket Reader</h2>
  <button class="ver" type="button" use:longPress={openDiagnostics} aria-label="Version {version}. Long-press for diagnostics.">Version {version}</button>
  <p class="muted">Stories, read aloud on your phone. Narration runs on-device; nothing you read leaves this phone.</p>
</div>

<Group title="Credits">
  <Row label="Attributions" sub="Voices, models and fonts" onclick={() => open('./ATTRIBUTIONS.txt')} />
  <Row label="Character license" sub="Virtue" onclick={() => open('./CHARACTER_LICENSE.txt')} />
  <Row label="License" onclick={() => open('./LICENSE.txt')} />
</Group>

<style>
  .brand {
    display: grid;
    justify-items: center;
    text-align: center;
    gap: 4px;
    padding: 4px 12px 24px;
  }
  .brand img {
    border-radius: 20px;
    box-shadow: var(--shadow-2);
    margin-bottom: 8px;
  }
  h2 {
    font-size: var(--t-title2);
    font-weight: 700;
  }
  .ver {
    min-height: 44px;
    padding: 0 12px;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .brand p {
    font-size: var(--t-foot);
    max-width: 32ch;
  }
</style>
