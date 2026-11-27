<script lang="ts">
  import type { StorySummary } from '../core/bridge';

  interface Props {
    story: Pick<StorySummary, 'title' | 'author' | 'coverUrl' | 'key'>;
    /** Width in px (height is 3:2 portrait), or 'fluid' to fill the parent's width. */
    size?: number | 'fluid';
    /** Hide text for very small covers. */
    plain?: boolean;
  }

  let { story, size = 120, plain = false }: Props = $props();

  // Typographic covers: a cloth colour and an ink colour chosen from the title.
  const CLOTHS = [
    ['#7a2e1d', '#f4e3cf'],
    ['#2f4a63', '#e9eef3'],
    ['#3d5a40', '#eef0e2'],
    ['#5b3a5e', '#f1e6ef'],
    ['#8a6a1f', '#fbf1d8'],
    ['#24424a', '#e2efef'],
    ['#6e3b2a', '#f6e7dc'],
    ['#2d2a3e', '#ece9f4'],
    ['#a0532d', '#fff1e4'],
    ['#45545c', '#eef2f3'],
  ];

  const pair = $derived.by(() => {
    let h = 0;
    for (const ch of story.key + story.title) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
    return CLOTHS[h % CLOTHS.length];
  });
  const fluid = $derived(size === 'fluid');
  const px = $derived(size === 'fluid' ? 0 : size);
  const height = $derived(Math.round(px * 1.5));
  // Type scales with the cover via container units; long titles step down.
  // A single long word must fit the cover's text column (~77% of the width):
  // at 6.4 "lighthouse" was clipped to "lighthous".
  const longestWord = $derived(Math.max(...story.title.split(/\s+/).map((w) => w.length), 1));
  const divisor = $derived(
    Math.max(story.title.length > 28 ? 9 : story.title.length > 16 ? 8 : 7.4, longestWord * 0.9),
  );
  // The floor is low because shelf covers are ~76 px and the title is also
  // printed under them; a 9 px floor broke 13-letter words mid-word.
  const titleSize = $derived(`max(6.5px, ${100 / divisor}cqi)`);
  const authorSize = $derived(`max(7px, ${54 / divisor}cqi)`);
</script>

<span
  class="cover"
  class:plain
  class:fluid
  style:width={fluid ? '100%' : `${px}px`}
  style:height={fluid ? 'auto' : `${height}px`}
  style:--cloth={pair[0]}
  style:--ink={pair[1]}
  aria-hidden="true"
>
  {#if story.coverUrl}
    <img src={story.coverUrl} alt="" loading="lazy" />
  {:else if !plain}
    <span class="inner">
      <span class="rule"></span>
      <span class="title" style:font-size={titleSize}>{story.title}</span>
      <span class="author" style:font-size={authorSize}>{story.author}</span>
    </span>
  {/if}
</span>

<style>
  .cover {
    position: relative;
    display: block;
    flex: none;
    container-type: inline-size;
    border-radius: 6px 10px 10px 6px;
    background:
      linear-gradient(90deg, rgb(0 0 0 / 0.22) 0 3%, rgb(255 255 255 / 0.08) 3% 4.5%, transparent 6%),
      radial-gradient(120% 80% at 30% 10%, rgb(255 255 255 / 0.14), transparent 60%),
      var(--cloth);
    color: var(--ink);
    box-shadow:
      0 1px 2px rgb(0 0 0 / 0.18),
      0 8px 18px -8px rgb(0 0 0 / 0.35);
    overflow: hidden;
  }
  .fluid {
    aspect-ratio: 2 / 3;
  }
  .inner {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    padding: 13cqi 10cqi 10cqi 13cqi;
  }
  .cover img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .rule {
    width: 26%;
    height: max(1px, 1.6cqi);
    background: currentColor;
    opacity: 0.6;
    margin-bottom: 9cqi;
    flex: none;
  }
  .title {
    font-family: var(--font-read);
    font-weight: 600;
    line-height: 1.12;
    letter-spacing: -0.01em;
    display: -webkit-box;
    -webkit-line-clamp: 5;
    line-clamp: 5;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
    text-wrap: balance;
  }
  .author {
    margin-top: auto;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    opacity: 0.75;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
