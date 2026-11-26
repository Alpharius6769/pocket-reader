<script lang="ts">
  import Headphones from '@lucide/svelte/icons/headphones';
  import LibraryBig from '@lucide/svelte/icons/library-big';
  import Compass from '@lucide/svelte/icons/compass';
  import Settings2 from '@lucide/svelte/icons/settings-2';
  import { ui, setTab, type Tab } from '../stores/ui';
  import { library } from '../stores/library';

  const tabs: { id: Tab; label: string; icon: typeof Headphones }[] = [
    { id: 'listen', label: 'Listen', icon: Headphones },
    { id: 'library', label: 'Library', icon: LibraryBig },
    { id: 'discover', label: 'Discover', icon: Compass },
    { id: 'settings', label: 'Settings', icon: Settings2 },
  ];

  const updates = $derived($library.entries.filter((e) => e.hasUpdate).length);
</script>

<nav class="tabbar" aria-label="Main">
  {#each tabs as t (t.id)}
    {@const Icon = t.icon}
    <button
      type="button"
      class="tab"
      aria-current={$ui.tab === t.id ? 'page' : undefined}
      onclick={() => setTab(t.id)}
    >
      <span class="ic">
        <Icon size={25} strokeWidth={$ui.tab === t.id ? 2.2 : 1.7} />
        {#if t.id === 'library' && updates}
          <span class="badge" aria-label="{updates} with new chapters">{updates}</span>
        {/if}
      </span>
      <span class="lbl">{t.label}</span>
    </button>
  {/each}
</nav>

<style>
  .tabbar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 30;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    padding: 0 var(--safe-right) var(--safe-bottom) var(--safe-left);
    background: var(--bg-glass);
    -webkit-backdrop-filter: saturate(1.6) blur(20px);
    backdrop-filter: saturate(1.6) blur(20px);
    border-top: 0.5px solid var(--line);
  }
  .tab {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    height: var(--tabbar-h);
    color: var(--ink-3);
    font-size: 0.625rem;
    font-weight: 600;
    letter-spacing: 0.01em;
  }
  .tab[aria-current='page'] {
    color: var(--accent-ink);
  }
  .ic {
    position: relative;
    display: grid;
    place-items: center;
    height: 28px;
  }
  .badge {
    position: absolute;
    top: -1px;
    left: 17px;
    min-width: 17px;
    height: 17px;
    padding: 0 4px;
    border-radius: 9px;
    background: var(--accent);
    color: var(--accent-on);
    font-size: 0.625rem;
    font-weight: 700;
    line-height: 17px;
    text-align: center;
    box-shadow: 0 0 0 2px var(--bg);
  }
</style>
