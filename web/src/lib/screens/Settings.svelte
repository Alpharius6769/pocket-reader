<script lang="ts">
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import AudioLines from '@lucide/svelte/icons/audio-lines';
  import Moon from '@lucide/svelte/icons/moon';
  import MicVocal from '@lucide/svelte/icons/mic-vocal';
  import Type from '@lucide/svelte/icons/type';
  import Bell from '@lucide/svelte/icons/bell';
  import HardDrive from '@lucide/svelte/icons/hard-drive';
  import Archive from '@lucide/svelte/icons/archive';
  import Info from '@lucide/svelte/icons/info';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import { VOICES, ENGINES } from '../core';
  import { updateSettings } from '../actions';
  import { player } from '../stores/player';
  import { settings } from '../stores/settings';
  import { ui, pushSettings, popSettings, openSheet, type SettingsPage } from '../stores/ui';
  import { speedLabel } from '../format';
  import { pushIn } from '../motion';
  import Group from '../settings/Group.svelte';
  import Row from '../settings/Row.svelte';
  import Toggle from '../components/Toggle.svelte';
  import Segmented from '../components/Segmented.svelte';
  import VoiceSheet from '../player/VoiceSheet.svelte';
  import Pronunciation from '../settings/Pronunciation.svelte';
  import Display from '../settings/Display.svelte';
  import Storage from '../settings/Storage.svelte';
  import Backup from '../settings/Backup.svelte';
  import About from '../settings/About.svelte';
  import Diagnostics from '../settings/Diagnostics.svelte';

  const TITLES: Record<SettingsPage, string> = {
    root: 'Settings',
    voice: 'Voice & speed',
    pronunciation: 'Pronunciation',
    display: 'Reading text',
    storage: 'Storage',
    backup: 'Backup & restore',
    about: 'About',
    diagnostics: 'Diagnostics',
  };

  const page = $derived($ui.settingsStack[$ui.settingsStack.length - 1]);
  const parent = $derived($ui.settingsStack[$ui.settingsStack.length - 2]);
  const voice = $derived(VOICES.find((v) => v.id === $player.voice));
  const sleepLabel = $derived(
    $player.sleep.kind === 'off' ? 'Off' : $player.sleep.kind === 'end-of-chapter' ? 'End of chapter' : `${$player.sleep.minutes} min`,
  );
</script>

<main class="screen" aria-labelledby="set-title">
  {#if page !== 'root'}
    <button class="back" type="button" onclick={popSettings}><ChevronLeft size={24} /> {TITLES[parent]}</button>
  {/if}
  <h1 class="large-title" id="set-title">{TITLES[page]}</h1>

  {#key page}
    <div class="page" in:pushIn>
      {#if page === 'root' && $settings}
        <Group title="Narration">
          <Row icon={AudioLines} tint="var(--accent)" label="Voice & speed" value="{voice?.name} · {speedLabel($player.speed)}" sub="{ENGINES[$player.engine].name} engine" onclick={() => pushSettings('voice')} />
          <Row icon={Sparkles} tint="#8a5cc2" label="Expressive narration" sub="Voice reacts to the scene">
            {#snippet trailing()}<Toggle label="Expressive narration" checked={$settings!.expressive} onchange={(v) => updateSettings({ expressive: v })} />{/snippet}
          </Row>
          <Row icon={Moon} tint="#3f4d8a" label="Sleep timer" value={sleepLabel} onclick={() => openSheet({ kind: 'sleep' })} />
          <Row icon={MicVocal} tint="#2f7a6a" label="Pronunciation" value="{$settings.pronunciations.length} words" onclick={() => pushSettings('pronunciation')} />
        </Group>

        <Group title="Appearance">
          <li class="inline">
            <Segmented
              label="Theme"
              value={$settings.theme}
              options={[
                { value: 'system', label: 'Automatic' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
              onchange={(v) => updateSettings({ theme: v })}
            />
          </li>
          <Row icon={Type} tint="#7a5a3a" label="Reading text" value="{$settings.readerSize} pt · {$settings.readerFont === 'serif' ? 'Literata' : 'System'}" onclick={() => pushSettings('display')} />
          <li class="inline split">
            <span>Open stories in</span>
            <span class="seg-s">
              <Segmented
                label="Open stories in"
                value={$settings.defaultMode}
                options={[
                  { value: 'listen', label: 'Listen' },
                  { value: 'read', label: 'Read' },
                ]}
                onchange={(v) => updateSettings({ defaultMode: v })}
              />
            </span>
          </li>
        </Group>

        <Group title="Virtue" footer="Your reading companion comments on what happens in the app. Quiet keeps her to the important moments.">
          <Row label="Show Virtue">
            {#snippet trailing()}<Toggle label="Show Virtue" checked={$settings!.companion === 'virtue'} onchange={(v) => updateSettings({ companion: v ? 'virtue' : 'none' })} />{/snippet}
          </Row>
          {#if $settings.companion === 'virtue'}
            <li class="inline split">
              <span>Chattiness</span>
              <span class="seg-s">
                <Segmented
                  label="Chattiness"
                  value={$settings.companionChatter}
                  options={[
                    { value: 'quiet', label: 'Quiet' },
                    { value: 'normal', label: 'Normal' },
                  ]}
                  onchange={(v) => updateSettings({ companionChatter: v })}
                />
              </span>
            </li>
          {/if}
        </Group>

        <Group title="Notifications" footer="Get a notification when a story you follow posts a new chapter. Choose which stories in each story’s options.">
          <Row icon={Bell} tint="#c0392b" label="New chapter alerts">
            {#snippet trailing()}<Toggle label="New chapter alerts" checked={$settings!.updateNotifications} onchange={(v) => updateSettings({ updateNotifications: v })} />{/snippet}
          </Row>
        </Group>

        <Group title="Data">
          <Row icon={HardDrive} tint="#5d6b75" label="Storage" onclick={() => pushSettings('storage')} />
          <Row icon={Archive} tint="#5d6b75" label="Backup & restore" onclick={() => pushSettings('backup')} />
        </Group>

        <Group>
          <Row icon={Info} tint="#5d6b75" label="About Pocket Reader" onclick={() => pushSettings('about')} />
        </Group>
      {:else if page === 'voice'}
        <div class="card pad"><VoiceSheet inline /></div>
      {:else if page === 'pronunciation'}
        <Pronunciation />
      {:else if page === 'display'}
        <Display />
      {:else if page === 'storage'}
        <Storage />
      {:else if page === 'backup'}
        <Backup />
      {:else if page === 'about'}
        <About />
      {:else if page === 'diagnostics'}
        <Diagnostics />
      {/if}
    </div>
  {/key}
</main>

<style>
  .back {
    display: inline-flex;
    align-items: center;
    gap: 0;
    min-height: 44px;
    margin-left: -8px;
    color: var(--accent-ink);
    font-size: var(--t-head);
  }
  .back + .large-title {
    padding-top: 0;
  }
  .inline {
    padding: 10px 14px;
    list-style: none;
  }
  :global(.row-li) + .inline,
  .inline + :global(.row-li) :global(.row),
  .inline + .inline {
    border-top: 0.5px solid var(--line);
  }
  .split {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 56px;
  }
  .seg-s {
    width: 170px;
  }
  .pad {
    padding: 4px 16px;
  }
</style>
