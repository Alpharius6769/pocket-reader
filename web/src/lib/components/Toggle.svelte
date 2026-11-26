<script lang="ts">
  interface Props {
    checked: boolean;
    label: string;
    onchange: (value: boolean) => void;
    disabled?: boolean;
  }
  let { checked, label, onchange, disabled = false }: Props = $props();
</script>

<button
  type="button"
  role="switch"
  class="toggle"
  aria-checked={checked}
  aria-label={label}
  {disabled}
  onclick={() => onchange(!checked)}
>
  <span class="knob"></span>
</button>

<style>
  .toggle {
    position: relative;
    width: 51px;
    height: 31px;
    border-radius: 99px;
    background: var(--line-strong);
    transition: background var(--dur-2) var(--ease-out);
    flex: none;
  }
  .toggle::after {
    content: '';
    position: absolute;
    inset: -7px -2px;
  }
  .toggle[aria-checked='true'] {
    background: var(--ok);
  }
  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 27px;
    height: 27px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 2px 6px rgb(0 0 0 / 0.2);
    transition: transform var(--dur-2) var(--ease-out);
  }
  .toggle[aria-checked='true'] .knob {
    transform: translateX(20px);
  }
  .toggle:disabled {
    opacity: 0.4;
  }
</style>
