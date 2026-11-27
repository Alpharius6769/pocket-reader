<script lang="ts">
  import { tick } from 'svelte';
  import { settings } from './lib/stores/settings';
  import { ui, type Tab } from './lib/stores/ui';
  import TabBar from './lib/components/TabBar.svelte';
  import MiniPlayer from './lib/components/MiniPlayer.svelte';
  import Toasts from './lib/components/Toasts.svelte';
  import SimChrome from './lib/components/SimChrome.svelte';
  import Listen from './lib/screens/Listen.svelte';
  import Library from './lib/screens/Library.svelte';
  import Discover from './lib/screens/Discover.svelte';
  import Settings from './lib/screens/Settings.svelte';
  import Onboarding from './lib/screens/Onboarding.svelte';
  import NowPlaying from './lib/player/NowPlaying.svelte';
  import Reader from './lib/player/Reader.svelte';
  import VoiceSheet from './lib/player/VoiceSheet.svelte';
  import SleepSheet from './lib/player/SleepSheet.svelte';
  import ChaptersSheet from './lib/player/ChaptersSheet.svelte';
  import StorySheet from './lib/library/StorySheet.svelte';
  import PreviewSheet from './lib/library/PreviewSheet.svelte';
  import Ao3FiltersSheet from './lib/discover/Ao3FiltersSheet.svelte';

  interface Props {
    sim?: boolean;
  }
  let { sim = false }: Props = $props();

  // Theme: 'system' follows prefers-color-scheme through CSS; explicit choices pin it.
  $effect(() => {
    const t = $settings?.theme ?? 'system';
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
      if (t !== 'system') m.setAttribute('content', dark ? '#1b2027' : '#e7ebef');
    });
  });

  // Each tab keeps its own scroll position.
  const scrolls: Partial<Record<Tab, number>> = {};
  let lastTab: Tab = $ui.tab;
  $effect(() => {
    const tab = $ui.tab;
    if (tab === lastTab) return;
    scrolls[lastTab] = window.scrollY;
    lastTab = tab;
    tick().then(() => window.scrollTo(0, scrolls[tab] ?? 0));
  });

  // A frosted strip behind the status bar / Dynamic Island once content scrolls under it.
  let scrolled = $state(false);
  $effect(() => {
    const on = () => (scrolled = window.scrollY > 8);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  });

  // Freeze the page underneath full-screen layers so iOS does not scroll it.
  const covered = $derived($ui.nowPlaying || $ui.reader || !!$ui.sheet || ($settings ? !$settings.onboarded : false));
  $effect(() => {
    document.documentElement.classList.toggle('covered', covered);
  });
</script>

{#if sim}<SimChrome />{/if}

<div class="status-scrim" class:on={scrolled} aria-hidden="true"></div>

<div class="app" inert={$ui.nowPlaying || $ui.reader || undefined}>
  {#if $ui.tab === 'listen'}
    <Listen />
  {:else if $ui.tab === 'library'}
    <Library />
  {:else if $ui.tab === 'discover'}
    <Discover />
  {:else}
    <Settings />
  {/if}
  <MiniPlayer />
  <TabBar />
</div>

{#if $ui.nowPlaying}<NowPlaying />{/if}
{#if $ui.reader}<Reader />{/if}

{#if $ui.sheet?.kind === 'story'}
  <StorySheet storyKey={$ui.sheet.key} />
{:else if $ui.sheet?.kind === 'preview'}
  <PreviewSheet story={$ui.sheet.story} />
{:else if $ui.sheet?.kind === 'voice'}
  <VoiceSheet />
{:else if $ui.sheet?.kind === 'sleep'}
  <SleepSheet />
{:else if $ui.sheet?.kind === 'chapters'}
  <ChaptersSheet tab={$ui.sheet.tab} />
{:else if $ui.sheet?.kind === 'ao3-filters'}
  <Ao3FiltersSheet />
{/if}

{#if $settings && !$settings.onboarded}<Onboarding />{/if}

<Toasts />

<style>
  .status-scrim {
    position: fixed;
    z-index: 29;
    top: 0;
    left: 0;
    right: 0;
    height: max(var(--safe-top), 20px);
    background: var(--bg-glass);
    -webkit-backdrop-filter: saturate(1.6) blur(20px);
    backdrop-filter: saturate(1.6) blur(20px);
    border-bottom: 0.5px solid var(--line);
    opacity: 0;
    transition: opacity var(--dur-1);
    pointer-events: none;
  }
  .status-scrim.on {
    opacity: 1;
  }
  :global(html.covered),
  :global(html.covered body) {
    overflow: hidden;
  }
</style>
