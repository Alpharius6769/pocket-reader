<script lang="ts">
  import type { Ao3Query } from '../core/bridge';
  import { ui, closeSheet } from '../stores/ui';
  import Sheet from '../components/Sheet.svelte';
  import Toggle from '../components/Toggle.svelte';

  // Edit a draft; apply on "Show results".
  let draft = $state<Ao3Query>({ ...$ui.ao3.query });

  const RATINGS = ['Any', 'General', 'Teen', 'Mature', 'Explicit', 'Not Rated'] as const;
  const SORTS: { value: NonNullable<Ao3Query['sort']>; label: string }[] = [
    { value: 'revised_at', label: 'Recently updated' },
    { value: 'kudos_count', label: 'Kudos' },
    { value: 'hits', label: 'Hits' },
    { value: 'word_count', label: 'Word count' },
    { value: 'created_at', label: 'Date posted' },
  ];
  const LENGTHS: { label: string; min?: number; max?: number }[] = [
    { label: 'Any length' },
    { label: 'Under 10k', max: 10_000 },
    { label: '10k–50k', min: 10_000, max: 50_000 },
    { label: '50k–100k', min: 50_000, max: 100_000 },
    { label: '100k+', min: 100_000 },
  ];

  function lengthOn(l: (typeof LENGTHS)[number]) {
    return (draft.wordsMin ?? undefined) === l.min && (draft.wordsMax ?? undefined) === l.max;
  }

  function apply() {
    ui.update((u) => ({ ...u, ao3: { ...u.ao3, query: { ...draft } } }));
    closeSheet();
    // Re-run the search if one was already shown.
    if ($ui.ao3.searched) document.querySelector<HTMLFormElement>('form[role="search"]')?.requestSubmit();
  }

  function reset() {
    draft = { query: draft.query, rating: 'Any', completeOnly: false, sort: 'revised_at' };
  }
</script>

<Sheet title="Filters" onclose={closeSheet} size="large">
  <section>
    <label class="lbl" for="f-fandom">Fandom</label>
    <div class="field"><input id="f-fandom" placeholder="Any fandom" bind:value={draft.fandom} /></div>
  </section>

  <section>
    <h3 class="lbl">Rating</h3>
    <div class="chips" role="radiogroup" aria-label="Rating">
      {#each RATINGS as r (r)}
        <button type="button" role="radio" class="chip" aria-checked={(draft.rating ?? 'Any') === r} class:on={(draft.rating ?? 'Any') === r} onclick={() => (draft.rating = r)}>{r}</button>
      {/each}
    </div>
  </section>

  <section>
    <h3 class="lbl">Length</h3>
    <div class="chips" role="radiogroup" aria-label="Length">
      {#each LENGTHS as l (l.label)}
        <button
          type="button"
          role="radio"
          class="chip"
          aria-checked={lengthOn(l)}
          class:on={lengthOn(l)}
          onclick={() => {
            draft.wordsMin = l.min;
            draft.wordsMax = l.max;
          }}>{l.label}</button
        >
      {/each}
    </div>
  </section>

  <section class="row">
    <span>Complete works only</span>
    <Toggle label="Complete works only" checked={!!draft.completeOnly} onchange={(v) => (draft.completeOnly = v)} />
  </section>

  <section>
    <label class="lbl" for="f-sort">Sort by</label>
    <select id="f-sort" class="select" bind:value={draft.sort}>
      {#each SORTS as s (s.value)}<option value={s.value}>{s.label}</option>{/each}
    </select>
  </section>

  <section>
    <label class="lbl" for="f-lang">Language</label>
    <select id="f-lang" class="select" bind:value={draft.language}>
      <option value={undefined}>Any language</option>
      <option value="en">English</option>
      <option value="es">Español</option>
      <option value="fr">Français</option>
      <option value="de">Deutsch</option>
    </select>
  </section>

  {#snippet footer()}
    <div class="actions">
      <button class="btn btn-plain" type="button" onclick={reset}>Reset</button>
      <button class="btn btn-primary" type="button" onclick={apply}>Show results</button>
    </div>
  {/snippet}
</Sheet>

<style>
  section {
    padding: 12px 0;
  }
  section + section {
    border-top: 0.5px solid var(--line);
  }
  .lbl {
    display: block;
    font-size: var(--t-foot);
    font-weight: 600;
    color: var(--ink-2);
    margin-bottom: 8px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .select {
    width: 100%;
    min-height: 44px;
    padding: 0 12px;
    border-radius: 12px;
    border: 0;
    background: var(--bg-sunk);
    font-size: 16px;
  }
  .actions {
    display: grid;
    grid-template-columns: 1fr 2fr;
    gap: 10px;
  }
  .actions .btn {
    min-height: 50px;
    border-radius: 14px;
  }
</style>
