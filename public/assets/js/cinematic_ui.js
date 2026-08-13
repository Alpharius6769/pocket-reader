const ICON_URL = 'assets/icons/lucide-sprite.svg';
const ICON_SPRITE_ID = 'pocket-reader-icon-sprite';

async function installInlineIconSprite() {
  if (document.getElementById(ICON_SPRITE_ID)) return;
  try {
    const response = await fetch(ICON_URL, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Icon sprite returned ${response.status}`);
    const markup = await response.text();
    const holder = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    holder.id = ICON_SPRITE_ID;
    holder.setAttribute('aria-hidden', 'true');
    holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    holder.innerHTML = markup.replace(/^\s*<svg[^>]*>|<\/svg>\s*$/g, '');
    document.body.prepend(holder);
  } catch (error) {
    console.warn('[Icons] Could not inline the Lucide sprite:', error);
  }
}

export function icon(name, className = '') {
  const safe = String(name || '').replace(/[^a-z0-9-]/gi, '');
  const classes = `pr-icon ${className}`.trim();
  return `<svg class="${classes}" aria-hidden="true" focusable="false"><use href="#icon-${safe}"></use></svg>`;
}
window.prIcon = icon;

const MOTION_QUERY = window.matchMedia?.('(prefers-reduced-motion: reduce)');
let synthesisSuppressed = false;

function profile() {
  return window.ensureReaderFeatures?.() || window.userProfile || { settings: {} };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function motionAllowed() {
  const settings = profile().settings || {};
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return !synthesisSuppressed && !document.hidden && settings.motionPreset !== 'off' &&
    settings.motionPreset !== 'reduced' && !MOTION_QUERY?.matches && !settings.lowMemoryMode &&
    !settings.dataSaver && !connection?.saveData;
}

function applyMotionState() {
  const settings = profile().settings || {};
  document.documentElement.dataset.motion = motionAllowed() ? (settings.motionPreset || 'standard') : 'reduced';
  document.documentElement.dataset.companionFrequency = settings.companionFrequency || 'contextual';
}

window.setCinematicSynthesisSuppressed = (suppressed) => {
  synthesisSuppressed = !!suppressed;
  applyMotionState();
};

function setControlValue(id, value) {
  const control = document.getElementById(id);
  if (control && value != null) control.value = String(value);
}

function saveSetting(field, value) {
  const data = profile();
  data.settings[field] = value;
  window.stampSyncedSetting?.(field);
  window.saveLocalData?.();
  applyPersonalization();
}

function applyPersonalization() {
  const settings = profile().settings || {};
  const root = document.documentElement;
  root.style.setProperty('--reader-content-width', `${Math.max(45, Math.min(100, Number(settings.readerWidth) || 78))}ch`);
  root.style.setProperty('--reader-line-height', String(Math.max(1.35, Math.min(2.2, Number(settings.readerLineHeight) || 1.7))));
  root.style.setProperty('--reader-paragraph-gap', `${Math.max(0.5, Math.min(2.4, Number(settings.paragraphSpacing) || 1.15))}em`);
  root.dataset.readerAlignment = settings.readerAlignment || 'left';

  applyMotionState();
}

function installAccountGateway() {
  const cloudButton = document.getElementById('setup-cloud-btn');
  if (cloudButton && !document.getElementById('setup-account-gateway')) {
    cloudButton.hidden = true;
    const gateway = document.createElement('div');
    gateway.id = 'setup-account-gateway';
    gateway.className = 'account-gateway';
    gateway.innerHTML = `
      <button class="account-option primary" type="button" onclick="window._setupCloudLogin()">${icon('log-in')}<span><strong>Continue with Google</strong><small>Choose Google in the secure account window.</small></span></button>
      <button class="account-option" type="button" onclick="window._setupCloudLogin()">${icon('mail')}<span><strong>Use email</strong><small>Create an account or sign in with email and password.</small></span></button>
      <label class="account-remember-login"><input id="setup-remember-login" type="checkbox" checked>Remember this device and resume this account when you return.</label>
      <button class="account-option quiet" type="button" onclick="window.continueSetupAsGuest()">${icon('user')}<span><strong>Continue as guest</strong><small>Everything stays on this device until you sign in.</small></span></button>`;
    cloudButton.after(gateway);
    window.restoreSetupDraft?.();
  }
}

window.continueSetupAsGuest = () => {
  const profile = window.userProfile = window.userProfile || {};
  profile.isLoggedIn = false;
  delete profile.cloudEmail;
  window.saveLocalData?.();
  const status = document.getElementById('setup-cloud-status');
  if (status) {
    status.style.display = 'block';
    status.textContent = 'Guest mode selected. You can create an account later from Profile.';
  }
  document.getElementById('setup-complete-btn')?.scrollIntoView({ behavior: motionAllowed() ? 'smooth' : 'auto', block: 'center' });
};

function syncStatusMarkup() {
  const data = profile();
  const state = window.cloudSyncState || {};
  const loggedIn = !!data.isLoggedIn;
  const last = Number(state.lastSyncedAt || localStorage.getItem('pr_last_synced_at'));
  const status = !loggedIn ? 'Guest mode' : state.status === 'error' ? 'Sync needs attention' : state.pending ? 'Changes pending' : 'Up to date';
  const detail = !loggedIn ? 'Personal data stays on this device.' : last ? `Last successful sync ${new Date(last).toLocaleString()}` : 'Waiting for the first successful sync.';
  const stateClass = ['idle', 'syncing', 'error', 'success'].includes(state.status) ? state.status : 'idle';
  return `<div class="account-health ${stateClass}"><span class="status-dot"></span><div><strong>${escapeHtml(status)}</strong><small>${escapeHtml(detail)}</small></div></div>`;
}

function renderAccountCenter() {
  const center = document.getElementById('account-center');
  if (!center) return;
  const data = profile();
  const owner = localStorage.getItem('pr_profile_owner');
  if (owner && owner !== 'Guest Reader' && (!data.isLoggedIn || !data.cloudEmail)) {
    data.isLoggedIn = true;
    data.cloudEmail = owner;
    window._cloudPushAllowed = true;
  }
  const loggedIn = !!data.isLoggedIn;
  center.innerHTML = `
    <header class="section-heading"><div><span class="eyebrow">Private by design</span><h2>Account Center</h2></div>${icon(loggedIn ? 'cloud' : 'cloud-off', 'heading-icon')}</header>
    ${syncStatusMarkup()}
    <dl class="account-facts"><div><dt>Identity</dt><dd>${escapeHtml(loggedIn ? (data.cloudEmail || 'Signed in') : 'Guest reader')}</dd></div><div><dt>Cloud revision</dt><dd>${Number(data.revision) || 0}</dd></div><div><dt>Device</dt><dd>${escapeHtml(String(data.deviceId || window.getPocketReaderDeviceId?.() || '').slice(-10) || 'Local')}</dd></div></dl>
    <div class="button-row">
      ${loggedIn ? `<button class="pr-btn-primary" onclick="window.triggerCloudSync()">${icon('refresh-cw')}<span>Sync now</span></button><button class="pr-btn-sub" onclick="window.triggerCloudLogout()">${icon('log-out')}<span>Log out</span></button>` : `<button class="pr-btn-primary" onclick="window.triggerCloudLogin()">${icon('log-in')}<span>Google or email</span></button>`}
      <button class="pr-btn-sub" onclick="window.exportPocketProfile()">${icon('download')}<span>Export profile</span></button>
      ${loggedIn ? `<button class="pr-btn-danger" onclick="window.openDeleteAccountDialog()">${icon('trash-2')}<span>Delete account data</span></button>` : ''}
    </div>
    <p class="settings-help">Sync includes profile, settings, library metadata, progress, favorites, ratings, bookmarks, collections, achievements, statistics, and goals. Story text, generated audio, model files, cookies, and device tuning remain local.</p>`;
}

window.exportPocketProfile = () => {
  const payload = window.buildSyncPayloadV3?.() || profile();
  if (profile().avatar) payload.avatar = profile().avatar;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `pocket-reader-profile-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};

window.openDeleteAccountDialog = () => {
  const email = profile().cloudEmail || '';
  window.showFeatureDialog?.('Delete account data', `
    <div class="danger-callout">${icon('alert-circle')}<p>This permanently removes your synced profile and account. Device-local stories and audio can be cleared separately.</p></div>
    <label class="field-row"><span>Enter your account email to confirm</span><input id="delete-account-confirm" class="settings-control" autocomplete="off" placeholder="${escapeHtml(email)}"></label>`,
  `<button class="pr-btn-sub" onclick="closeFeatureDialog()">Cancel</button><button class="pr-btn-danger" onclick="window.confirmDeleteAccountData()">Delete permanently</button>`);
};

window.confirmDeleteAccountData = async () => {
  const confirmation = document.getElementById('delete-account-confirm')?.value.trim();
  if (!confirmation || typeof window.pocketCloud?.deleteAccountData !== 'function') return;
  const button = document.querySelector('#feature-dialog-actions .pr-btn-danger');
  if (button) button.disabled = true;
  try {
    await window.pocketCloud.deleteAccountData(confirmation);
    localStorage.removeItem('pr_profile_owner');
    localStorage.removeItem('pr_setup_complete');
    await window._wipeLocalUserData?.();
    localStorage.removeItem('pocketReaderProfile');
    location.reload();
  } catch (error) {
    if (button) button.disabled = false;
    window.queueNotice?.({ id: 'account-delete-error', tone: 'error', title: 'Account not deleted', message: error?.message || String(error) });
  }
};

function installAccountCenter() {
  const syncCard = document.getElementById('cloud-sync-card');
  if (!syncCard || document.getElementById('account-center')) return;
  syncCard.hidden = true;
  const center = document.createElement('section');
  center.id = 'account-center';
  center.className = 'account-center page-band';
  syncCard.after(center);
  renderAccountCenter();
}

function installSettingsSystem() {
  const view = document.getElementById('settings-view');
  const grid = view?.querySelector('.settings-grid');
  if (!view || !grid || document.getElementById('settings-section-nav')) return;
  view.querySelector('h1')?.classList.add('page-title');
  const nav = document.createElement('nav');
  nav.id = 'settings-section-nav';
  nav.className = 'settings-section-nav';
  nav.setAttribute('aria-label', 'Settings sections');
  // "Offline Storage" was removed: the only main-grid card it targeted is the
  // Away Mode Cache Queue status panel; the actual storage tools (clear caches,
  // backup/restore, permanent caches) live in the Advanced Settings & Info
  // section, so a top-level Offline Storage pill was redundant and misleading.
  const groups = [
    ['reading', 'Reading', 'book-open'], ['narration', 'Narration', 'volume-2'],
    ['appearance', 'Appearance', 'sparkles'], ['companion', 'Companion', 'user'],
    ['accessibility', 'Accessibility', 'shield-check'], ['advanced', 'Advanced Diagnostics', 'sliders-horizontal'],
  ];
  // Phones open the settings sections collapsed so the long list is scannable at
  // a glance; desktop, laptop, and tablet (wider than the phone breakpoint) open
  // every section expanded. The collapse toggle itself is only shown at this
  // same breakpoint (see theme.css), so wider viewports always read expanded.
  const collapseByDefault = window.matchMedia?.('(max-width: 700px)')?.matches === true;
  nav.innerHTML = groups.map(([id, label, glyph], index) => `<button class="${index ? '' : 'active'}" data-settings-target="${id}">${icon(glyph)}<span>${label}</span></button>`).join('');
  grid.before(nav);
  const cards = [...grid.querySelectorAll('.settings-card')];
  const classify = (title) => /narration|playback|voice|expressive|pronunciation/i.test(title) ? 'narration' : /font|reading|reader|text/i.test(title) ? 'reading' : /theme|appearance|color/i.test(title) ? 'appearance' : /companion|app/i.test(title) ? 'companion' : /storage|cache|offline/i.test(title) ? 'storage' : /access|motion|haptic|hint/i.test(title) ? 'accessibility' : 'advanced';
  const decorateCard = (card, index) => {
    const section = classify(card.querySelector('h3')?.textContent || '');
    card.dataset.settingsSection = section;
    card.id ||= `settings-card-${section}-${index}`;
    const title = card.querySelector('h3');
    if (title && !title.querySelector('.settings-card-toggle')) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'settings-card-toggle';
      toggle.setAttribute('aria-label', `Toggle ${title.textContent.trim()}`);
      toggle.innerHTML = icon('chevron-down');
      toggle.addEventListener('click', () => {
        const collapsed = card.classList.toggle('collapsed');
        toggle.setAttribute('aria-expanded', String(!collapsed));
      });
      title.appendChild(toggle);
      if (collapseByDefault) card.classList.add('collapsed');
      toggle.setAttribute('aria-expanded', String(!card.classList.contains('collapsed')));
    }
  };
  cards.forEach(decorateCard);
  nav.addEventListener('click', (event) => {
    const button = event.target.closest('[data-settings-target]');
    if (!button) return;
    nav.querySelectorAll('button').forEach((item) => item.classList.toggle('active', item === button));
    const target = grid.querySelector(`[data-settings-section="${button.dataset.settingsTarget}"]`);
    target?.scrollIntoView({ behavior: motionAllowed() ? 'smooth' : 'auto', block: 'start' });
  });



  const personalization = document.createElement('section');
  personalization.className = 'settings-card';
  personalization.dataset.settingsSection = 'reading';
  personalization.innerHTML = `<h3>Reader Personalization</h3>
    <label class="field-row"><span>Content width <output id="reader-width-output"></output></span><input id="reader-width-control" type="range" min="45" max="100" step="1"></label>
    <label class="field-row"><span>Line height <output id="reader-line-output"></output></span><input id="reader-line-control" type="range" min="1.35" max="2.2" step="0.05"></label>
    <label class="field-row"><span>Paragraph spacing <output id="reader-spacing-output"></output></span><input id="reader-spacing-control" type="range" min="0.5" max="2.4" step="0.05"></label>
    <label class="field-row"><span>Alignment</span><select id="reader-alignment-control" class="settings-control"><option value="left">Left</option><option value="justify">Justified</option></select></label>`;
  grid.appendChild(personalization);

  const experience = document.createElement('section');
  experience.className = 'settings-card';
  experience.dataset.settingsSection = 'accessibility';
  experience.innerHTML = `<h3>Motion & Companion Frequency</h3>
    <label class="field-row"><span>Motion</span><select id="motion-preset-control" class="settings-control"><option value="off">Off</option><option value="reduced">Reduced</option><option value="standard">Standard</option><option value="cinematic">Cinematic</option></select></label>
    <label class="field-row"><span>Companion frequency</span><select id="companion-frequency-control" class="settings-control"><option value="quiet">Quiet</option><option value="contextual">Contextual</option><option value="expressive">Expressive</option></select></label>
    <p class="settings-help">Decorative motion pauses automatically during narration synthesis, low-memory mode, data saver, reduced-motion preference, and hidden-page operation.</p>`;
  grid.appendChild(experience);

  [personalization, experience].forEach((card, index) => decorateCard(card, cards.length + index));
  setTimeout(() => grid.querySelectorAll('.settings-card').forEach(decorateCard), 0);

  const settings = profile().settings || {};
  setControlValue('reader-width-control', settings.readerWidth || 78);
  setControlValue('reader-line-control', settings.readerLineHeight || 1.7);
  setControlValue('reader-spacing-control', settings.paragraphSpacing || 1.15);
  setControlValue('reader-alignment-control', settings.readerAlignment || 'left');  setControlValue('motion-preset-control', settings.motionPreset || 'standard');
  setControlValue('companion-frequency-control', settings.companionFrequency || 'contextual');
  const bindRange = (id, field, output, suffix = '') => document.getElementById(id)?.addEventListener('input', (event) => {
    const value = Number(event.target.value);
    const out = document.getElementById(output);
    if (out) out.value = `${value}${suffix}`;
    saveSetting(field, value);
  });
  bindRange('reader-width-control', 'readerWidth', 'reader-width-output', 'ch');
  bindRange('reader-line-control', 'readerLineHeight', 'reader-line-output');
  bindRange('reader-spacing-control', 'paragraphSpacing', 'reader-spacing-output', 'em');
  [['reader-alignment-control', 'readerAlignment'], ['motion-preset-control', 'motionPreset'], ['companion-frequency-control', 'companionFrequency']].forEach(([id, field]) => document.getElementById(id)?.addEventListener('change', (event) => saveSetting(field, event.target.value)));
  document.getElementById('reader-width-output').value = `${settings.readerWidth || 78}ch`;
  document.getElementById('reader-line-output').value = String(settings.readerLineHeight || 1.7);
  document.getElementById('reader-spacing-output').value = `${settings.paragraphSpacing || 1.15}em`;
}

function installReaderDrawers() {
  const main = document.querySelector('#reading-view .reader-main');
  const buffer = document.getElementById('reader-buffer-container');
  const playback = document.querySelector('#reading-view .playback-bar');
  if (!main || !buffer || !playback || document.getElementById('reader-drawer-controls')) return;
  buffer.classList.add('reader-drawer', 'collapsed');
  playback.classList.add('reader-drawer');
  buffer.dataset.drawer = 'cache';
  playback.dataset.drawer = 'playback';
  const controls = document.createElement('div');
  controls.id = 'reader-drawer-controls';
  controls.className = 'reader-drawer-controls';
  controls.innerHTML = `<button class="drawer-toggle" data-drawer-toggle="cache" aria-expanded="false">${icon('download')}<span>Cache</span><small id="drawer-cache-status">Idle</small>${icon('chevron-up')}</button><button class="drawer-toggle active" data-drawer-toggle="playback" aria-expanded="true">${icon('volume-2')}<span>Narration</span><small id="drawer-playback-status">Ready</small>${icon('chevron-down')}</button><button class="icon-btn" title="Story narration preset" aria-label="Story narration preset" onclick="openStoryNarrationPreset()">${icon('sliders-horizontal')}</button>`;
  buffer.before(controls);
  controls.addEventListener('click', (event) => {
    const button = event.target.closest('[data-drawer-toggle]');
    if (!button) return;
    const drawer = main.querySelector(`[data-drawer="${button.dataset.drawerToggle}"]`);
    const collapsed = drawer.classList.toggle('collapsed');
    button.classList.toggle('active', !collapsed);
    button.setAttribute('aria-expanded', String(!collapsed));
  });
  const actions = document.createElement('div');
  actions.className = 'reader-story-actions';
  actions.innerHTML = `<button class="pr-btn-sub" onclick="toggleReadingQueue(window.currentStory)">${icon('list')}<span>Queue</span></button><button class="pr-btn-sub" onclick="openStoryNarrationPreset()">${icon('sliders-horizontal')}<span>Story voice</span></button>`;
  document.getElementById('tab-content-info')?.appendChild(actions);
  window.updateReaderDrawerStatus?.();
}

window.updateReaderDrawerStatus = function updateReaderDrawerStatus(bufferState = window.BufferManager) {
  const cacheStatus = document.getElementById('drawer-cache-status');
  if (cacheStatus) {
    const total = Number(bufferState?.totalToCache) || 0;
    const cached = Number(bufferState?.cachedCount) || 0;
    const pct = total > 0 ? Math.floor((cached / total) * 100) : 0;
    cacheStatus.textContent = bufferState?.isActive && !bufferState?.paused ? `${pct}%`
      : bufferState?.paused ? 'Paused'
        : total > 0 && cached >= total ? 'Complete'
          : total > 0 && cached > 0 ? `${pct}% cached`
            : 'Idle';
  }
  const narrationStatus = document.getElementById('drawer-playback-status');
  if (narrationStatus) narrationStatus.textContent = window.isPlaying ? 'Playing' : 'Ready';
};

function relabelThemes() {
  const labels = { slate: 'Anthrostate', dark: 'Midnight', light: 'Paper', 'high-contrast': 'High Contrast', colorblind: 'Colorblind Safe' };
  ['setup-theme', 'app-theme-select'].forEach((id) => {
    const select = document.getElementById(id);
    [...(select?.options || [])].forEach((option) => { if (labels[option.value]) option.textContent = labels[option.value]; });
  });
}

function replaceControlGlyphs() {
  const controls = [
    ['.reader-sidebar-toggle', 'chevron-right', 'Toggle story details'], ['#cache-stop-btn', 'x', 'Stop caching'],
    ['button[title="Jump to Start"]', 'chevron-left', 'Jump to start'], ['button[title="Previous Paragraph"]', 'chevron-left', 'Previous paragraph'],
    ['button[title="Next Paragraph"]', 'chevron-right', 'Next paragraph'], ['button[title="Jump to End"]', 'chevron-right', 'Jump to end'],
  ];
  controls.forEach(([selector, glyph, label]) => {
    const element = document.querySelector(selector);
    if (!element) return;
    element.innerHTML = icon(glyph);
    element.setAttribute('aria-label', label);
    element.title = label;
  });
  const avatarEdit = document.querySelector('.profile-avatar-edit');
  if (avatarEdit) avatarEdit.innerHTML = icon('edit-3');
  const gridButton = document.getElementById('library-mode-grid');
  if (gridButton) gridButton.innerHTML = icon('layout-grid');
  const listButton = document.getElementById('library-mode-list');
  if (listButton) listButton.innerHTML = icon('list');
}

function installPageHeadings() {
  document.querySelectorAll('.view > h1, .library-header h1').forEach((heading) => heading.classList.add('page-title'));
  document.querySelectorAll('.pr-btn-primary, .pr-btn-sub, .pr-btn-outline, .pr-btn-danger').forEach((button) => button.classList.add('elevated-control'));
}

function installHomeStage() {
  const home = document.getElementById('home-view');
  const intro = home?.querySelector(':scope > .panel');
  if (!home || !intro || document.getElementById('home-virtue-stage')) return;
  intro.classList.add('home-command-header');
  intro.querySelector('h1').textContent = 'Tonight\'s reading';
  intro.querySelector('p').textContent = 'Continue a story, choose what comes next, or settle in for narration.';
  const stage = document.createElement('aside');
  stage.id = 'home-virtue-stage';
  stage.className = 'home-virtue-stage';
  stage.innerHTML = `
    <div class="home-virtue-wrapper">
      <img src="assets/img/virtue_happy_holding_bubble.webp" alt="Virtue">
      <span class="home-virtue-bubble-text">Welcome!</span>
    </div>
  `;
  intro.appendChild(stage);
}

function install() {
  installInlineIconSprite();
  installAccountGateway();
  installAccountCenter();
  installSettingsSystem();
  installReaderDrawers();
  relabelThemes();
  replaceControlGlyphs();
  installPageHeadings();
  installHomeStage();
  applyPersonalization();
  renderAccountCenter();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
else install();
document.addEventListener('pr:sync-state', renderAccountCenter);
document.addEventListener('pr:profile-synced', () => { renderAccountCenter(); applyPersonalization(); });
document.addEventListener('visibilitychange', applyMotionState);
MOTION_QUERY?.addEventListener?.('change', applyMotionState);
