<script lang="ts">
  import { deviceNoun } from '../layout';
  import Flame from '@lucide/svelte/icons/flame';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Compass from '@lucide/svelte/icons/compass';
  import FileUp from '@lucide/svelte/icons/file-up';
  import { onMount } from 'svelte';
  import { bridge, type Achievement, type ListeningStats } from '../core';
  import { attempt, resumeOrPlay } from '../actions';
  import { player, storyProgress, preparing } from '../stores/player';
  import { inProgress, library } from '../stores/library';
  import { settings } from '../stores/settings';
  import { ui, openNowPlaying, openSheet, setTab, say } from '../stores/ui';
  import { greeting, listenTime, percent, progressLabel } from '../format';
  import { LINES } from '../virtue/sprites';
  import Cover from '../components/Cover.svelte';
  import PlayButton from '../components/PlayButton.svelte';
  import Virtue from '../components/Virtue.svelte';
  import InstallCard from '../components/InstallCard.svelte';

  let achievements = $state<Achievement[]>([]);
  let stats = $state<ListeningStats | null>(null);
  let lineIndex = $state(0);

  onMount(async () => {
    [achievements, stats] = await Promise.all([bridge().listAchievements(), bridge().getStats()]);
  });

  const hero = $derived($player.story ? $library.entries.find((e) => e.story.key === $player.story!.key) : $inProgress[0]);
  const others = $derived($inProgress.filter((e) => e.story.key !== hero?.story.key).slice(0, 8));
  const updates = $derived($library.entries.filter((e) => e.hasUpdate));
  const heroIsCurrent = $derived(!!$player.story && hero?.story.key === $player.story.key);
  const heroProgress = $derived(heroIsCurrent ? $storyProgress : (hero?.progress ?? 0));
  const remainingWords = $derived(hero?.story.words ? Math.round(hero.story.words * (1 - heroProgress)) : 0);
  const unlocked = $derived(achievements.filter((a) => a.unlockedAt).length);

  // Companion: use the latest line the app asked her to say, else cycle greetings.
  const idle = [...(LINES.waving ?? []), ...(LINES.holding ?? []), ...(LINES.wink ?? [])];
  const fresh = $derived($ui.virtue.line && Date.now() - $ui.virtue.at < 15_000);
  const line = $derived(fresh ? $ui.virtue.line! : idle[lineIndex % idle.length]);

  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  function nextLine() {
    lineIndex += 1;
    say('talking', null);
  }

  function iconUrl(name: string) {
    return new URL(`./assets/icons/${name}.svg`, document.baseURI).href;
  }

  function chapterTitle() {
    if (!hero) return '';
    if (heroIsCurrent) return $player.story!.chapters[$player.position.chapter]?.title ?? '';
    return `Chapter ${hero.position.chapter + 1}`;
  }
</script>

<main class="screen" aria-labelledby="listen-title">
  <header class="head">
    <p class="eyebrow date">{today}</p>
    <h1 class="large-title" id="listen-title">{greeting()}</h1>
    {#if stats}
      <p class="stats">
        <span class="streak"><Flame size={15} /> {stats.streakDays}-day streak</span>
        <span class="faint">{stats.minutesThisWeek} min this week</span>
      </p>
    {/if}
  </header>

  <InstallCard />

  {#if $settings?.companion !== 'none'}
    <section class="companion" aria-label="Virtue">
      <button class="bubble" type="button" onclick={nextLine} aria-label="Virtue says: {line}. Tap for more.">
        <span class="who">Virtue</span>
        <span class="said">{line}</span>
      </button>
      <Virtue mood="talking" height={230} crop={0.5} onclick={nextLine} />
    </section>
  {/if}

  {#if hero}
    <section class="block" aria-labelledby="cont-title">
      <h2 class="section-title" id="cont-title">Continue</h2>
      <div class="hero card">
        <button class="hero-open" type="button" onclick={() => (heroIsCurrent ? openNowPlaying(true) : openSheet({ kind: 'story', key: hero!.story.key }))}>
          <Cover story={hero.story} size={92} />
          <span class="hero-text">
            <span class="t">{hero.story.title}</span>
            <span class="a">{hero.story.author}</span>
            <span class="c">{chapterTitle()}</span>
          </span>
        </button>
        <div class="hero-foot">
          <div class="hero-prog">
            <div class="progress-track"><span style:width={percent(heroProgress)}></span></div>
            <span class="faint">{percent(heroProgress)}{#if remainingWords}&nbsp;· {listenTime(remainingWords, $player.speed)} left{/if}</span>
          </div>
          <PlayButton
            size={56}
            state={heroIsCurrent ? ($preparing ? 'loading' : $player.state) : 'paused'}
            onclick={() => attempt(() => resumeOrPlay(hero!.story.key))}
          />
        </div>
      </div>
    </section>
  {:else if $library.loaded}
    <section class="empty card">
      <Virtue mood="waving" line="Hello!" height={220} />
      <h2>Your shelf is empty</h2>
      <p class="muted">Find something on Discover, or bring your own file. Everything stays on this {$deviceNoun}.</p>
      <div class="empty-cta">
        <button class="btn btn-primary" type="button" onclick={() => setTab('discover')}><Compass size={18} /> Find a story</button>
        <button
          class="btn btn-plain"
          type="button"
          onclick={() => {
            ui.update((u) => ({ ...u, discoverMode: 'import' }));
            setTab('discover');
          }}><FileUp size={18} /> Import</button
        >
      </div>
    </section>
  {/if}

  {#if others.length}
    <section class="block" aria-labelledby="also-title">
      <div class="row-head">
        <h2 class="section-title" id="also-title">Also listening</h2>
        <button class="link" type="button" onclick={() => setTab('library')}>Library <ChevronRight size={16} /></button>
      </div>
      <div class="h-scroll shelf">
        {#each others as e (e.story.key)}
          <button class="shelf-item" type="button" onclick={() => openSheet({ kind: 'story', key: e.story.key })}>
            <Cover story={e.story} size={112} />
            <span class="progress-track"><span style:width={percent(e.progress)}></span></span>
            <span class="st">{e.story.title}</span>
          </button>
        {/each}
      </div>
    </section>
  {/if}

  {#if updates.length}
    <section class="block" aria-labelledby="new-title">
      <h2 class="section-title" id="new-title">New chapters</h2>
      <ul class="rows card">
        {#each updates as e (e.story.key)}
          <li>
            <button type="button" onclick={() => openSheet({ kind: 'story', key: e.story.key })}>
              <Cover story={e.story} size={40} plain />
              <span class="rt"><span class="t">{e.story.title}</span><span class="faint">{e.story.author}</span></span>
              <span class="pill">New</span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if achievements.length}
    <section class="block" aria-labelledby="ach-title">
      <div class="row-head">
        <h2 class="section-title" id="ach-title">Achievements</h2>
        <span class="faint count">{unlocked} of {achievements.length}</span>
      </div>
      <div class="h-scroll badges">
        {#each achievements as a (a.id)}
          <div class="badge" class:locked={!a.unlockedAt}>
            <span class="medal"><span class="glyph" style:--icon="url({iconUrl(a.icon)})"></span></span>
            <span class="bt">{a.title}</span>
            {#if a.tier}<span class="tier {a.tier.toLowerCase()}">{a.tier}</span>{:else if a.progress && !a.unlockedAt}<span class="faint bp">{progressLabel(a.progress)}</span>{/if}
          </div>
        {/each}
      </div>
    </section>
  {/if}
</main>

<style>
  .head {
    padding-top: 10px;
  }
  .date {
    margin-bottom: -6px;
  }
  .head .large-title {
    padding-bottom: 6px;
  }
  .stats {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--t-foot);
    margin-bottom: 16px;
  }
  .streak {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 5px 10px;
    border-radius: 99px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-size: var(--t-foot);
    font-weight: 600;
    white-space: nowrap;
  }
  .companion {
    display: flex;
    align-items: flex-end;
    gap: 4px;
    margin: 0 -4px 6px 0;
  }
  .bubble {
    position: relative;
    flex: 1;
    min-width: 0;
    align-self: center;
    text-align: left;
    padding: 12px 14px;
    border-radius: 18px 18px 6px 18px;
    background: var(--hoodie-soft);
    color: var(--ink);
    display: grid;
    gap: 2px;
    min-height: 44px;
  }
  .bubble::after {
    content: '';
    position: absolute;
    right: -7px;
    bottom: 10px;
    border: 8px solid transparent;
    border-left-color: var(--hoodie-soft);
    border-right: 0;
  }
  .who {
    font-size: var(--t-caption);
    font-weight: 700;
    color: var(--hoodie);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .said {
    font-family: var(--font-read);
    font-size: var(--t-sub);
    line-height: 1.4;
    text-wrap: pretty;
  }
  .block {
    margin-top: 22px;
  }
  .block > .section-title,
  .row-head {
    margin-bottom: 10px;
  }
  .row-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .link {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    min-height: 44px;
    color: var(--accent-ink);
    font-weight: 600;
    font-size: var(--t-sub);
  }
  .count {
    font-size: var(--t-foot);
  }
  .hero {
    padding: 14px;
  }
  .hero-open {
    display: flex;
    gap: 14px;
    width: 100%;
    text-align: left;
    align-items: flex-start;
  }
  .hero-text {
    min-width: 0;
    display: grid;
    gap: 2px;
    padding-top: 2px;
  }
  .hero-text .t {
    font-family: var(--font-read);
    font-size: var(--t-title3);
    font-weight: 600;
    line-height: 1.2;
    text-wrap: balance;
  }
  .hero-text .a {
    color: var(--ink-2);
    font-size: var(--t-sub);
  }
  .hero-text .c {
    margin-top: 6px;
    font-size: var(--t-foot);
    font-weight: 600;
    color: var(--accent-ink);
  }
  .hero-foot {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-top: 14px;
  }
  .hero-prog {
    flex: 1;
    display: grid;
    gap: 6px;
    font-size: var(--t-foot);
  }
  .shelf-item {
    display: grid;
    gap: 6px;
    width: 112px;
    text-align: left;
  }
  .shelf-item .progress-track {
    height: 3px;
  }
  .st {
    font-size: var(--t-foot);
    font-weight: 600;
    line-height: 1.25;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0 14px;
  }
  .rows li + li {
    border-top: 0.5px solid var(--line);
  }
  .rows button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 64px;
    text-align: left;
  }
  .rt {
    flex: 1;
    min-width: 0;
    display: grid;
    font-size: var(--t-foot);
  }
  .rt .t {
    font-size: var(--t-sub);
    font-weight: 600;
  }
  .pill {
    padding: 3px 9px;
    border-radius: 99px;
    background: var(--accent);
    color: var(--accent-on);
    font-size: var(--t-caption);
    font-weight: 700;
  }
  .badges {
    gap: 10px;
  }
  .badge {
    flex: none;
    width: 92px;
    display: grid;
    justify-items: center;
    gap: 6px;
    padding: 12px 6px;
    border-radius: 16px;
    background: var(--bg-elev);
    box-shadow: var(--shadow-1);
    text-align: center;
  }
  .medal {
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    border-radius: 50%;
    background: var(--accent-soft);
  }
  .locked .medal {
    background: var(--bg-sunk);
  }
  .glyph {
    width: 30px;
    height: 30px;
    background: var(--accent-ink);
    -webkit-mask: var(--icon) center / contain no-repeat;
    mask: var(--icon) center / contain no-repeat;
  }
  .locked .glyph {
    background: var(--ink-3);
    opacity: 0.5;
  }
  /* Nothing inside a badge may push past its 92px card. */
  .badge > :global(*) {
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
  }
  .bt {
    font-size: var(--t-caption);
    font-weight: 600;
    line-height: 1.2;
    min-height: 2.4em;
  }
  .locked .bt {
    color: var(--ink-3);
  }
  .tier,
  .bp {
    font-size: 0.6875rem;
    font-weight: 700;
  }
  .tier {
    padding: 1px 7px;
    border-radius: 99px;
  }
  .bronze {
    background: #e9c9a6;
    color: #5a3410;
  }
  .silver {
    background: #d9dde2;
    color: #353b42;
  }
  .gold {
    background: #f1d98a;
    color: #574000;
  }
  .platinum {
    background: #cfe3e6;
    color: #1f4146;
  }
  .empty {
    display: grid;
    justify-items: center;
    text-align: center;
    gap: 8px;
    padding: 20px 18px 22px;
    margin-top: 10px;
  }
  .empty h2 {
    font-size: var(--t-title2);
    font-weight: 700;
  }
  .empty-cta {
    display: flex;
    gap: 10px;
    margin-top: 8px;
  }
</style>
