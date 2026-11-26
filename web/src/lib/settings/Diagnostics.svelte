<script lang="ts">
  import Copy from '@lucide/svelte/icons/copy';
  import { onMount } from 'svelte';
  import { bridge, type Diagnostics } from '../core';
  import { attempt } from '../actions';
  import { toast } from '../stores/ui';
  import Group from './Group.svelte';
  import Row from './Row.svelte';

  let d = $state<Diagnostics | null>(null);
  onMount(async () => {
    d = (await attempt(() => bridge().getDiagnostics())) ?? null;
  });

  async function copy() {
    if (!d) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(d, null, 2));
      toast({ level: 'success', message: 'Diagnostics copied' });
    } catch {
      toast({ level: 'error', message: 'Could not copy. Long-press the log to select it.' });
    }
  }
</script>

{#if d}
  <Group title="App">
    <Row label="App" value={d.appVersion} />
    <Row label="Cores" value={d.coreVersion} />
    <Row label="Service worker" value={d.serviceWorker} />
  </Group>
  <Group title="Device">
    <Row label="Device" value={d.device} />
    <Row label="Memory headroom" value={d.memoryHeadroomMb ? `${d.memoryHeadroomMb} MB` : 'Unknown'} />
    <Row label="Threads" value={String(d.threads)} />
    <Row label="Cross-origin isolated" value={d.crossOriginIsolated ? 'Yes' : 'No'} />
  </Group>
  <Group title="Engine">
    <Row label="Engine" value={d.engine.engine} />
    <Row label="Status" value={d.engine.status} />
    <Row label="Backend" value={d.engine.backend ?? '—'} />
  </Group>
  <section class="log-wrap">
    <h2 class="eyebrow">Recent log</h2>
    <pre class="log card">{#each d.recentLog as l (l.at)}<span class="lv-{l.level}">{new Date(l.at).toLocaleTimeString()} {l.level.toUpperCase().padEnd(5)} {l.message}
</span>{/each}</pre>
  </section>
  <button class="btn btn-plain btn-block" type="button" onclick={copy}><Copy size={18} /> Copy diagnostics</button>
{/if}

<style>
  .log-wrap {
    margin-bottom: 16px;
  }
  .log-wrap .eyebrow {
    padding: 0 14px 8px;
  }
  .log {
    margin: 0;
    padding: 12px 14px;
    font: 0.75rem/1.5 ui-monospace, 'SF Mono', Menlo, monospace;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--ink-2);
    -webkit-user-select: text;
    user-select: text;
  }
  .lv-warn {
    color: var(--warn);
  }
  .lv-error {
    color: var(--danger);
  }
</style>
