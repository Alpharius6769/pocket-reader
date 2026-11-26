<script lang="ts">
  import Trash from '@lucide/svelte/icons/trash';
  import Plus from '@lucide/svelte/icons/plus';
  import { updateSettings } from '../actions';
  import { settings } from '../stores/settings';
  import Toggle from '../components/Toggle.svelte';

  let term = $state('');
  let soundsLike = $state('');
  const rules = $derived($settings?.pronunciations ?? []);

  function add(e: SubmitEvent) {
    e.preventDefault();
    if (!term.trim() || !soundsLike.trim()) return;
    void updateSettings({
      pronunciations: [...rules, { id: `p-${Date.now()}`, term: term.trim(), soundsLike: soundsLike.trim(), enabled: true }],
    });
    term = '';
    soundsLike = '';
  }

  function set(id: string, patch: Partial<(typeof rules)[number]>) {
    void updateSettings({ pronunciations: rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  }

  function remove(id: string) {
    void updateSettings({ pronunciations: rules.filter((r) => r.id !== id) });
  }
</script>

<p class="lede muted">Teach the narrator names and words it gets wrong. Spell them the way they sound.</p>

<form class="card add" onsubmit={add}>
  <div class="field"><input placeholder="Word, e.g. Marrow" aria-label="Word as written" bind:value={term} autocapitalize="off" /></div>
  <div class="field"><input placeholder="Say it like, e.g. MAIR-oh" aria-label="Say it like" bind:value={soundsLike} autocapitalize="off" /></div>
  <button class="btn btn-primary" type="submit" disabled={!term.trim() || !soundsLike.trim()}><Plus size={18} /> Add word</button>
</form>

{#if rules.length}
  <ul class="card list">
    {#each rules as r (r.id)}
      <li>
        <div class="words" class:off={!r.enabled}>
          <span class="t">{r.term}</span>
          <span class="arrow" aria-hidden="true">→</span>
          <span class="s">{r.soundsLike}</span>
        </div>
        <Toggle label="Use for {r.term}" checked={r.enabled} onchange={(v) => set(r.id, { enabled: v })} />
        <button class="icon-btn" type="button" aria-label="Delete {r.term}" onclick={() => remove(r.id)}><Trash size={18} /></button>
      </li>
    {/each}
  </ul>
{:else}
  <p class="muted none">No words yet.</p>
{/if}

<style>
  .lede {
    font-size: var(--t-sub);
    margin-bottom: 14px;
  }
  .add {
    padding: 12px;
    display: grid;
    gap: 8px;
    margin-bottom: 20px;
  }
  .add .btn:disabled {
    opacity: 0.45;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0 6px 0 14px;
  }
  .list li {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 56px;
  }
  .list li + li {
    border-top: 0.5px solid var(--line);
  }
  .words {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  .words.off {
    opacity: 0.5;
  }
  .t {
    font-weight: 600;
  }
  .arrow {
    color: var(--ink-3);
  }
  .s {
    font-family: var(--font-read);
    color: var(--accent-ink);
  }
  .none {
    text-align: center;
    padding: 24px 0;
  }
</style>
