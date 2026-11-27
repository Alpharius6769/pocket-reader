<script lang="ts">
  import { deviceNoun } from '../layout';
  import Download from '@lucide/svelte/icons/download';
  import Upload from '@lucide/svelte/icons/upload';
  import { bridge } from '../core';
  import { attempt, downloadBlob } from '../actions';
  import { toast } from '../stores/ui';
  import Virtue from '../components/Virtue.svelte';

  let busy = $state<'export' | 'import' | null>(null);
  let input: HTMLInputElement | undefined = $state();

  async function exportNow() {
    busy = 'export';
    const res = await attempt(() => bridge().exportBackup());
    busy = null;
    if (!res) return;
    downloadBlob(res.blob, res.filename);
    toast({ level: 'success', message: `Backup saved: ${res.stories} stories, ${res.bookmarks} bookmarks`, mood: 'happy' });
  }

  async function restore(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    (e.currentTarget as HTMLInputElement).value = '';
    if (!file) return;
    busy = 'import';
    await attempt(() => bridge().importBackup(file));
    busy = null;
  }
</script>

<div class="intro">
  <Virtue mood="holding" line="Keep it safe." height={170} crop={0.35} />
  <p class="muted">
    Pocket Reader keeps everything on this {$deviceNoun} — there is no account. A backup file holds your library, progress, bookmarks and
    settings so you can move to a new device or recover after deleting the app.
  </p>
</div>

<div class="card actions">
  <button class="act" type="button" disabled={busy !== null} onclick={exportNow}>
    <span class="ic"><Download size={22} /></span>
    <span class="txt">
      <span class="t">{busy === 'export' ? 'Preparing backup…' : 'Export backup'}</span>
      <span class="s">Saves a .prbackup file to Files or iCloud Drive</span>
    </span>
  </button>
  <button class="act" type="button" disabled={busy !== null} onclick={() => input?.click()}>
    <span class="ic"><Upload size={22} /></span>
    <span class="txt">
      <span class="t">{busy === 'import' ? 'Restoring…' : 'Restore from backup'}</span>
      <span class="s">Brings back a library from a backup file</span>
    </span>
  </button>
</div>
<input bind:this={input} class="sr-only" type="file" accept=".prbackup,.json,application/octet-stream" onchange={restore} tabindex="-1" aria-hidden="true" />

<style>
  .intro {
    display: flex;
    align-items: flex-end;
    gap: 10px;
    margin-bottom: 18px;
  }
  .intro p {
    align-self: center;
    font-size: var(--t-foot);
  }
  .actions {
    overflow: hidden;
  }
  .act {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 14px;
    min-height: 68px;
    padding: 10px 14px;
    text-align: left;
  }
  .act + .act {
    border-top: 0.5px solid var(--line);
  }
  .act:disabled {
    opacity: 0.55;
  }
  .ic {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 12px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    flex: none;
  }
  .txt {
    display: grid;
  }
  .t {
    font-weight: 600;
  }
  .s {
    font-size: var(--t-foot);
    color: var(--ink-2);
  }
</style>
