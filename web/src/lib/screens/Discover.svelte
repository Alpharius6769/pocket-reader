<script lang="ts">
  import Segmented from '../components/Segmented.svelte';
  import { ui } from '../stores/ui';
  import Ao3Search from '../discover/Ao3Search.svelte';
  import Catalog from '../discover/Catalog.svelte';
  import Import from '../discover/Import.svelte';

  type Mode = 'search' | 'catalog' | 'import';
  function setMode(m: Mode) {
    ui.update((u) => ({ ...u, discoverMode: m }));
  }
</script>

<main class="screen" aria-labelledby="disc-title">
  <h1 class="large-title" id="disc-title">Discover</h1>
  <div class="modes">
    <Segmented
      label="Discover"
      value={$ui.discoverMode}
      options={[
        { value: 'search', label: 'AO3' },
        { value: 'catalog', label: 'Anthronomicon' },
        { value: 'import', label: 'Import' },
      ]}
      onchange={setMode}
    />
  </div>

  {#if $ui.discoverMode === 'search'}
    <Ao3Search />
  {:else if $ui.discoverMode === 'catalog'}
    <Catalog />
  {:else}
    <Import />
  {/if}
</main>

<style>
  .modes {
    margin-bottom: 14px;
  }
</style>
