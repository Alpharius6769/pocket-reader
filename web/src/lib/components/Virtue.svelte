<script lang="ts">
  import type { VirtueMood } from '../core/bridge';
  import { SPRITES, spriteUrl } from '../virtue/sprites';

  interface Props {
    mood: VirtueMood;
    /** Text to letter into her sign. Ignored for sprites without one. */
    line?: string | null;
    /** Rendered height in px. Width follows the sprite's aspect ratio. */
    height?: number;
    /** Crop from the bottom, 0..1 (e.g. 0.45 keeps the top 55%). */
    crop?: number;
    onclick?: () => void;
    label?: string;
  }

  let { mood, line = null, height = 240, crop = 0, onclick, label = 'Virtue, your reading companion' }: Props = $props();

  const sprite = $derived(SPRITES[mood]);
  const width = $derived(Math.round((height * sprite.w) / sprite.h));

  /** Largest font size (10..20px) at which the line fits inside the sign. */
  const fontSize = $derived.by(() => {
    const b = sprite.bubble;
    if (!b || !line) return 0;
    const bw = (width * b.width) / 100 * 0.84;
    const bh = (height * b.height) / 100 * 0.82;
    const longest = Math.max(...line.split(/\s+/).map((w) => w.length));
    for (let fs = 20; fs >= 10; fs -= 0.5) {
      const cw = fs * 0.6; // Literata semibold average advance
      if (longest * cw > bw) continue;
      // Greedy wrap by words.
      let lines = 1;
      let used = 0;
      for (const w of line.split(/\s+/)) {
        const need = (used ? used + 1 : 0) + w.length;
        if (need * cw > bw) {
          lines += 1;
          used = w.length;
        } else used = need;
      }
      if (lines * fs * 1.18 <= bh) return fs;
    }
    return 0;
  });
</script>

{#snippet art()}
  <span class="frame" style:height="{height * (1 - crop)}px" style:width="{width}px">
    {#key mood}
      <span class="sprite" style:height="{height}px" style:width="{width}px">
        <img src={spriteUrl(mood)} alt="" width={width} height={height} decoding="async" draggable="false" />
        {#if sprite.bubble && line && fontSize}
          <span
            class="sign"
            style:top="{sprite.bubble.top}%"
            style:left="{sprite.bubble.left}%"
            style:width="{sprite.bubble.width}%"
            style:height="{sprite.bubble.height}%"
            style:font-size="{fontSize}px">{line}</span
          >
        {/if}
      </span>
    {/key}
  </span>
{/snippet}

{#if onclick}
  <button class="virtue" type="button" aria-label={line ? `${label}: ${line}` : label} {onclick}>
    {@render art()}
  </button>
{:else}
  <span class="virtue" role="img" aria-label={line ? `${label}: ${line}` : label}>
    {@render art()}
  </span>
{/if}

<style>
  .virtue {
    display: inline-block;
    line-height: 0;
    flex: none;
  }
  .frame {
    display: block;
    position: relative;
    overflow: hidden;
  }
  .sprite {
    position: absolute;
    left: 0;
    top: 0;
    animation: arrive var(--dur-3) var(--ease-out) both;
  }
  .sprite img {
    width: 100%;
    height: 100%;
    user-select: none;
    -webkit-user-drag: none;
  }
  .sign {
    position: absolute;
    display: grid;
    place-items: center;
    text-align: center;
    padding: 4% 6%;
    color: #2a2119;
    font-family: var(--font-read);
    font-weight: 600;
    line-height: 1.18;
    text-wrap: balance;
    overflow: hidden;
  }
  @keyframes arrive {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.98);
    }
  }
</style>
