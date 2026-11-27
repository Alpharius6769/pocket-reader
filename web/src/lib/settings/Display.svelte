<script lang="ts">
  import { deviceNoun } from '../layout';
  import Minus from '@lucide/svelte/icons/minus';
  import Plus from '@lucide/svelte/icons/plus';
  import { updateSettings } from '../actions';
  import { settings } from '../stores/settings';
  import Segmented from '../components/Segmented.svelte';
  import Group from './Group.svelte';

  const size = $derived($settings?.readerSize ?? 19);
  const lh = $derived($settings?.readerLineHeight ?? 1.6);
  const font = $derived($settings?.readerFont ?? 'serif');
</script>

<div class="preview card" class:sans={font === 'sans'} style:font-size="{size / 16}rem" style:line-height={lh} aria-label="Preview">
  <p>The lamp in the window of the ferry house had been burning for three nights when Wren finally knocked.</p>
</div>

<Group title="Font">
  <li class="pad">
    <Segmented
      label="Font"
      value={font}
      options={[
        { value: 'serif', label: 'Literata' },
        { value: 'sans', label: 'System' },
      ]}
      onchange={(v) => updateSettings({ readerFont: v })}
    />
  </li>
</Group>

<Group title="Size" footer={$deviceNoun === 'phone' ? 'Text also follows the iPhone’s Text Size setting.' : undefined}>
  <li class="pad stepper">
    <button class="icon-btn" type="button" aria-label="Smaller" disabled={size <= 14} onclick={() => updateSettings({ readerSize: size - 1 })}><Minus size={20} /></button>
    <input
      type="range"
      min="14"
      max="30"
      step="1"
      value={size}
      aria-label="Text size"
      oninput={(e) => updateSettings({ readerSize: Number(e.currentTarget.value) })}
    />
    <button class="icon-btn" type="button" aria-label="Larger" disabled={size >= 30} onclick={() => updateSettings({ readerSize: size + 1 })}><Plus size={20} /></button>
  </li>
</Group>

<Group title="Line spacing">
  <li class="pad">
    <Segmented
      label="Line spacing"
      value={String(lh)}
      options={[
        { value: '1.4', label: 'Compact' },
        { value: '1.6', label: 'Normal' },
        { value: '1.85', label: 'Airy' },
      ]}
      onchange={(v) => updateSettings({ readerLineHeight: Number(v) })}
    />
  </li>
</Group>

<style>
  .preview {
    padding: 18px;
    margin-bottom: 24px;
    font-family: var(--font-read);
  }
  .preview.sans {
    font-family: var(--font-ui);
  }
  .pad {
    padding: 10px 14px;
    list-style: none;
  }
  .stepper {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .stepper input {
    flex: 1;
    accent-color: var(--accent);
  }
</style>
