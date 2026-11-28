<script lang="ts">
  import { deviceNoun } from '../layout';
  import Link from '@lucide/svelte/icons/link';
  import FileUp from '@lucide/svelte/icons/file-up';
  import ClipboardPaste from '@lucide/svelte/icons/clipboard-paste';
  import { bridge } from '../core';
  import { attempt, openStory } from '../actions';
  import { say, openSheet, toast } from '../stores/ui';
  import Virtue from '../components/Virtue.svelte';

  let url = $state('');
  let busy = $state<'url' | 'file' | null>(null);
  let input: HTMLInputElement | undefined = $state();

  const valid = $derived(/^https?:\/\/\S+\.\S+/i.test(url.trim()));

  async function openUrl(e: SubmitEvent) {
    e.preventDefault();
    if (!valid) return;
    busy = 'url';
    await openStory({ kind: 'url', url: url.trim() });
    busy = null;
  }

  async function paste() {
    try {
      url = (await navigator.clipboard.readText()).trim();
    } catch {
      /* permission denied: the reader can paste into the field */
    }
  }

  async function pick(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    (e.currentTarget as HTMLInputElement).value = '';
    if (!file) return;
    busy = 'file';
    say('thinking', null);
    const added = await attempt(() => bridge().importFile(file));
    busy = null;
    // It used to finish without a word and leave the reader on this page,
    // wondering whether anything had happened.
    if (added) {
      toast({ level: 'success', message: `Added “${added.title}” to your library`, mood: 'holding' });
      openSheet({ kind: 'story', key: added.key });
    }
  }
</script>

<section class="card block">
  <h2 class="h"><Link size={20} /> From a web page</h2>
  <p class="muted sub">Paste a link to a story page, such as an AO3 work.</p>
  <form class="row" onsubmit={openUrl}>
    <label class="field grow">
      <input type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://…" aria-label="Story link" bind:value={url} />
      <button class="paste" type="button" aria-label="Paste link" onclick={paste}><ClipboardPaste size={18} /></button>
    </label>
    <button class="btn btn-primary" type="submit" disabled={!valid || busy !== null}>{busy === 'url' ? 'Opening…' : 'Open'}</button>
  </form>
</section>

<section class="card block">
  <h2 class="h"><FileUp size={20} /> From a file</h2>
  <!-- It said "The file stays on this device". It does not: the file is sent
       to the Pocket Reader server to be split into chapters. -->
  <p class="muted sub">EPUB, PDF, TXT, HTML or DOCX. The file is sent to the Pocket Reader server to be turned into chapters and is deleted there straight away; the story is then kept only on this {$deviceNoun}.</p>
  <button class="btn btn-tonal btn-block" type="button" disabled={busy !== null} onclick={() => input?.click()}>
    {busy === 'file' ? 'Importing…' : 'Choose a file'}
  </button>
  <input
    bind:this={input}
    class="sr-only"
    type="file"
    accept=".epub,.pdf,.txt,.html,.htm,.docx,application/epub+zip,application/pdf,text/plain,text/html"
    onchange={pick}
    tabindex="-1"
    aria-hidden="true"
  />
</section>

<aside class="note">
  <Virtue mood="thinking" height={150} crop={0.4} />
  <p class="muted">Some sites block downloads. If a link will not open, save the page as a file and import that instead.</p>
</aside>

<style>
  .block {
    padding: 16px;
    margin-bottom: 14px;
  }
  .h {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--t-head);
    font-weight: 700;
  }
  .sub {
    font-size: var(--t-foot);
    margin: 4px 0 12px;
  }
  .row {
    display: flex;
    gap: 8px;
  }
  .grow {
    flex: 1;
    min-width: 0;
    padding-right: 4px;
  }
  .paste {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    color: var(--ink-2);
  }
  .btn:disabled {
    opacity: 0.45;
  }
  .note {
    display: flex;
    align-items: flex-end;
    gap: 10px;
    margin-top: 6px;
    font-size: var(--t-foot);
  }
  .note p {
    align-self: center;
  }
</style>
