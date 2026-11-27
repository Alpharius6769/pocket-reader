<script lang="ts">
  import { deviceNoun } from '../layout';
  import Headphones from '@lucide/svelte/icons/headphones';
  import BookOpenText from '@lucide/svelte/icons/book-open-text';
  import { updateSettings } from '../actions';
  import { fade } from '../motion';
  import Virtue from '../components/Virtue.svelte';

  async function choose(mode: 'listen' | 'read') {
    await updateSettings({ defaultMode: mode, onboarded: true });
  }
</script>

<div class="onb" role="dialog" aria-modal="true" aria-labelledby="onb-title" out:fade>
  <div class="art">
    <Virtue mood="waving" line="Hello, reader!" height={300} />
  </div>
  <div class="copy">
    <h1 id="onb-title">Stories, read aloud.</h1>
    <p class="muted">
      Pocket Reader narrates stories with a voice that runs right on your {$deviceNoun}. No account, nothing to sign in to — your library stays
      with you.
    </p>
  </div>
  <div class="choices">
    <p class="eyebrow q">How would you like to start?</p>
    <button class="choice primary" type="button" onclick={() => choose('listen')}>
      <span class="ic"><Headphones size={26} /></span>
      <span class="txt"><span class="t">Listen</span><span class="s">Narration with the text following along</span></span>
    </button>
    <button class="choice" type="button" onclick={() => choose('read')}>
      <span class="ic"><BookOpenText size={26} /></span>
      <span class="txt"><span class="t">Read</span><span class="s">Just the text. Narration is a tap away</span></span>
    </button>
    <p class="faint foot">You can change this any time in Settings.</p>
  </div>
</div>

<style>
  .onb {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: flex;
    flex-direction: column;
    background:
      radial-gradient(120% 60% at 50% 0%, var(--accent-soft), transparent 70%),
      var(--bg);
    padding: calc(var(--safe-top) + 4px) calc(var(--gutter) + var(--safe-right)) calc(var(--safe-bottom) + 16px)
      calc(var(--gutter) + var(--safe-left));
    overflow-y: auto;
  }
  .art {
    flex: 1;
    min-height: 220px;
    display: grid;
    place-items: end center;
  }
  .art :global(.frame) {
    max-height: 38dvh;
  }
  .copy {
    text-align: center;
    padding: 14px 4px 0;
  }
  h1 {
    font-family: var(--font-read);
    font-size: var(--t-title1);
    font-weight: 700;
    letter-spacing: -0.01em;
    margin-bottom: 8px;
  }
  .copy p {
    font-size: var(--t-sub);
    max-width: 34ch;
    margin: 0 auto;
    text-wrap: pretty;
  }
  .choices {
    display: grid;
    gap: 10px;
    padding-top: 22px;
  }
  .q {
    text-align: center;
  }
  .choice {
    display: flex;
    align-items: center;
    gap: 14px;
    min-height: 72px;
    padding: 12px 16px;
    border-radius: 18px;
    background: var(--bg-elev);
    box-shadow: var(--shadow-1);
    text-align: left;
    transition: transform var(--dur-1) var(--ease-out);
  }
  .choice:active {
    transform: scale(0.98);
  }
  .choice.primary {
    background: var(--accent);
    color: var(--accent-on);
  }
  .ic {
    display: grid;
    place-items: center;
    width: 46px;
    height: 46px;
    border-radius: 14px;
    background: var(--bg-elev-2);
    color: var(--accent-ink);
    flex: none;
  }
  .primary .ic {
    background: rgb(255 255 255 / 0.18);
    color: inherit;
  }
  .txt {
    display: grid;
  }
  .t {
    font-size: var(--t-head);
    font-weight: 700;
  }
  .s {
    font-size: var(--t-foot);
    opacity: 0.8;
  }
  .foot {
    text-align: center;
    font-size: var(--t-foot);
    margin-top: 2px;
  }
</style>
