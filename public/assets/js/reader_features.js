import { isMobileLikePlatform, KOKORO_VOICES, voicesForEngine } from './pocket_backend_policy.js?v=backend-v48';

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function inlineArg(value) {
  return esc(JSON.stringify(String(value ?? '')));
}

function profile() {
  const value = typeof window.normalizeProfileV3 === 'function' ? window.normalizeProfileV3(window.userProfile || {}) : (window.userProfile || {});
  window.userProfile = value;
  return value;
}

function stableKey(story) {
  return story?.storyKey || window.getStoryStableKey?.(story) || '';
}

function save(reason = 'feature') {
  window.saveLocalData?.();
  renderWorkflowSurfaces();
}

export function ensureReaderFeatures() {
  const data = profile();
  data.library ||= [];
  data.collections ||= [];
  data.readingQueue ||= [];
  data.history ||= [];
  data.goals ||= { weeklyMinutes: 120, weeklyChapters: 0, streakEnabled: true, updatedAt: Date.now() };
  data.settings ||= {};
  data.settings.motionPreset ||= window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'reduced' : (isMobileLikePlatform(navigator.userAgent || '') ? 'standard' : 'cinematic');
  data.settings.companionFrequency ||= 'contextual';
  data.settings.libraryDensity ||= 'comfortable';
  // The old migration forced every profile to neutral, which made the separate
  // "Emotion-aware delivery" toggle look enabled while all emotion routing was
  // actually suppressed. Upgrade that forced default once; explicit choices
  // made after this migration remain untouched.
  if (!data.settings._migratedEmotionBalanced) {
    if (!data.settings.voiceEmotionMode || data.settings._migratedEmotionNeutral) {
      data.settings.voiceEmotionMode = 'balanced';
    }
    data.settings._migratedEmotionBalanced = true;
  }
  return data;
}
window.ensureReaderFeatures = ensureReaderFeatures;

export function recordStoryHistory(story = window.currentStory, options = {}) {
  if (!story) return;
  const data = ensureReaderFeatures();
  const key = stableKey(story);
  const stamp = Date.now();
  const item = data.history.find((entry) => entry.storyKey === key);
  const update = {
    id: `history_${key}`,
    storyKey: key,
    title: story.title || 'Untitled story',
    author: story.author || '',
    progressChapter: Number(story.progressChapter) || 0,
    progressParagraph: Number(story.progressParagraph) || 0,
    lastAt: stamp,
    updatedAt: stamp,
  };
  if (item) Object.assign(item, update);
  else data.history.push(update);
  data.history = data.history.sort((a, b) => Number(a.lastAt) - Number(b.lastAt)).slice(-250);
  if (!options.silent) save('history');
}
window.recordStoryHistory = recordStoryHistory;

export function toggleReadingQueue(story) {
  const data = ensureReaderFeatures();
  const key = typeof story === 'string' ? story : stableKey(story);
  const index = data.readingQueue.indexOf(key);
  if (index >= 0) data.readingQueue.splice(index, 1);
  else data.readingQueue.push(key);
  data.readingQueueUpdatedAt = Date.now();
  const libStory = data.library.find((item) => stableKey(item) === key);
  if (libStory) window.stampStorySyncField?.(libStory, 'collections');
  save('reading-queue');
  return index < 0;
}
window.toggleReadingQueue = toggleReadingQueue;

export function moveReadingQueue(key, direction) {
  const queue = ensureReaderFeatures().readingQueue;
  const index = queue.indexOf(key);
  const target = index + Number(direction || 0);
  if (index < 0 || target < 0 || target >= queue.length) return;
  [queue[index], queue[target]] = [queue[target], queue[index]];
  ensureReaderFeatures().readingQueueUpdatedAt = Date.now();
  save('reading-queue-order');
}
window.moveReadingQueue = moveReadingQueue;

function showFeatureDialog(title, body, actions = '', onReveal = null) {
  let dialog = document.getElementById('feature-dialog');
  if (!dialog) {
    dialog = document.createElement('div');
    dialog.id = 'feature-dialog';
    dialog.className = 'cinematic-dialog-shell';
    dialog.innerHTML = '<section class="cinematic-dialog" role="dialog" aria-modal="true"><header><h2 id="feature-dialog-title"></h2><button class="icon-btn" data-close aria-label="Close dialog" title="Close">' + window.prIcon('x') + '</button></header><div id="feature-dialog-body"></div><footer id="feature-dialog-actions"></footer></section>';
    dialog.querySelector('[data-close]').addEventListener('click', closeFeatureDialog);
    dialog.addEventListener('click', (event) => { if (event.target === dialog) closeFeatureDialog(); });
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeFeatureDialog();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.hidden && element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    document.body.appendChild(dialog);
  }
  let hash = 2166136261;
  for (const character of `${title}|${body}|${actions}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const reveal = () => {
    dialog._returnFocus = document.activeElement;
    dialog.querySelector('#feature-dialog-title').textContent = title;
    dialog.querySelector('#feature-dialog-body').innerHTML = body;
    dialog.querySelector('#feature-dialog-actions').innerHTML = actions;
    dialog.classList.add('active');
    if (typeof onReveal === 'function') onReveal(dialog);
    else dialog.querySelector('[data-close]')?.focus();
  };
  if (window.queueModalReveal) window.queueModalReveal('feature-dialog', reveal, { priority: 78, eventKey: `feature-${hash >>> 0}`, allowDuringModal: true });
  else reveal();
}
window.showFeatureDialog = showFeatureDialog;

export function closeFeatureDialog() {
  const dialog = document.getElementById('feature-dialog');
  dialog?.classList.remove('active');
  window.releaseQueuedModal?.('feature-dialog');
  if (dialog?._returnFocus?.isConnected) dialog._returnFocus.focus();
}
window.closeFeatureDialog = closeFeatureDialog;

export function openCollectionDialog() {
  showFeatureDialog('Create collection', `
    <label class="field-row"><span>Name</span><input id="new-collection-name" class="settings-control" maxlength="60" placeholder="Weekend listening"></label>
    <label class="field-row"><span>Accent</span><select id="new-collection-color" class="settings-control"><option value="scarlet">Scarlet</option><option value="blue">Sky</option><option value="green">Evergreen</option><option value="gold">Gold</option></select></label>`,
  '<button class="pr-btn-sub" onclick="closeFeatureDialog()">Cancel</button><button class="pr-btn-primary" onclick="createCollectionFromDialog()">Create</button>',
  () => document.getElementById('new-collection-name')?.focus());
}
window.openCollectionDialog = openCollectionDialog;

export function createCollectionFromDialog() {
  const name = document.getElementById('new-collection-name')?.value.trim();
  if (!name) return;
  const stamp = Date.now();
  ensureReaderFeatures().collections.push({ id: `collection_${stamp}`, name, color: document.getElementById('new-collection-color')?.value || 'scarlet', updatedAt: stamp });
  closeFeatureDialog();
  save('collection-create');
}
window.createCollectionFromDialog = createCollectionFromDialog;

export function assignStoryCollection(storyKey, collectionId) {
  const story = ensureReaderFeatures().library.find((item) => stableKey(item) === storyKey);
  if (!story) return;
  story.collectionIds = Array.isArray(story.collectionIds) ? story.collectionIds : [];
  if (collectionId && !story.collectionIds.includes(collectionId)) story.collectionIds.push(collectionId);
  window.stampStorySyncField?.(story, 'collections');
  save('collection-assign');
}
window.assignStoryCollection = assignStoryCollection;

export function openStoryCollectionDialog(storyKey) {
  const data = ensureReaderFeatures();
  const story = data.library.find((item) => stableKey(item) === storyKey);
  if (!story) return;
  const selected = new Set(story.collectionIds || []);
  const choices = data.collections.length
    ? data.collections.map((collection) => `<label class="switch-row"><span>${esc(collection.name)}</span><input type="checkbox" data-story-collection="${esc(collection.id)}" ${selected.has(collection.id) ? 'checked' : ''}></label>`).join('')
    : '<div class="empty-state"><strong>No collections yet.</strong><span>Create one from the Library toolbar first.</span></div>';
  showFeatureDialog('Story collections', choices,
    `<button class="pr-btn-sub" onclick="closeFeatureDialog()">Cancel</button><button class="pr-btn-primary" onclick="saveStoryCollections(${inlineArg(storyKey)})">Save</button>`);
}
window.openStoryCollectionDialog = openStoryCollectionDialog;

export function saveStoryCollections(storyKey) {
  const story = ensureReaderFeatures().library.find((item) => stableKey(item) === storyKey);
  if (!story) return;
  story.collectionIds = [...document.querySelectorAll('[data-story-collection]:checked')].map((input) => input.dataset.storyCollection);
  window.stampStorySyncField?.(story, 'collections');
  closeFeatureDialog();
  save('story-collections');
}
window.saveStoryCollections = saveStoryCollections;

export function openStoryNarrationByKey(storyKey) {
  const story = ensureReaderFeatures().library.find((item) => stableKey(item) === storyKey);
  if (story) openStoryNarrationPreset(story);
}
window.openStoryNarrationByKey = openStoryNarrationByKey;

export function editBookmarkDetails(storyKey, bookmarkId) {
  const story = ensureReaderFeatures().library.find((item) => stableKey(item) === storyKey);
  const bookmark = story?.bookmarks?.find((item) => item.id === bookmarkId);
  if (!bookmark) return;
  showFeatureDialog('Bookmark details', `
    <label class="field-row"><span>Label</span><input id="bookmark-label" class="settings-control" maxlength="80" value="${esc(bookmark.label || '')}" placeholder="Favorite scene"></label>
    <label class="field-row"><span>Private note</span><textarea id="bookmark-note" class="settings-control" maxlength="1000" rows="5" placeholder="What stood out here?">${esc(bookmark.note || '')}</textarea></label>`,
  `<button class="pr-btn-sub" onclick="closeFeatureDialog()">Cancel</button><button class="pr-btn-primary" onclick="saveBookmarkDetails(${inlineArg(storyKey)},${inlineArg(bookmarkId)})">Save note</button>`);
}
window.editBookmarkDetails = editBookmarkDetails;

export function saveBookmarkDetails(storyKey, bookmarkId) {
  const story = ensureReaderFeatures().library.find((item) => stableKey(item) === storyKey);
  const bookmark = story?.bookmarks?.find((item) => item.id === bookmarkId);
  if (!bookmark) return;
  bookmark.label = document.getElementById('bookmark-label')?.value.trim() || '';
  bookmark.note = document.getElementById('bookmark-note')?.value.trim() || '';
  bookmark.updatedAt = Date.now();
  window.stampStorySyncField?.(story, 'bookmarks');
  closeFeatureDialog();
  save('bookmark-note');
  window.renderBookmarksTab?.();
}
window.saveBookmarkDetails = saveBookmarkDetails;

// Voice list and emotion values both have to follow the engine that will
// actually speak, and the emotion values have to be ones _emotionMode() accepts.
//
// The emotion select offered neutral / balanced / FULL. _emotionMode() accepts
// neutral / balanced / EXPRESSIVE and falls back to balanced for anything else,
// so picking Full per story silently gave balanced. 'full' is the tier
// vocabulary from POCKET_PROSODY_TIERS; 'expressive' is the mode vocabulary the
// Settings select uses, and requestedProsodyTier() is the only thing allowed to
// map between them.
function _presetVoiceOptions(preset) {
  const engine = typeof window._resolveActiveEngine === 'function' ? window._resolveActiveEngine() : 'pocket';
  // A Pocket id means nothing to Kokoro. Offering seven voices it cannot speak
  // wrote one into narrationPreset.voice, which populateReaderUI then pushed
  // straight into #voice-selector.
  // KOKORO_VOICES is imported from the shared policy rather than read off
  // window: the global of that name is published by audio_core, which is
  // lazy-loaded, so opening this dialog before narration had ever started gave
  // an empty voice list. POCKET_VOICES is a shell global (engine_utils), so it
  // is always present.
  // Any engine with a shell-side list uses it; only Pocket falls through to
  // POCKET_VOICES. Naming Kokoro here offered Pocket's voices to a Kitten
  // reader, none of which its worker can load.
  // Imported, not read off window: voicesForEngine is published there by
  // audio_core, which is lazy-loaded, so the global is absent exactly when
  // this dialog is opened before narration has ever started.
  const engineVoices = voicesForEngine(engine) || [];
  const options = engineVoices.length
    ? engineVoices.map((voice) => ({
        id: voice.id,
        label: voice.grade ? `${voice.label} (${voice.grade})` : voice.label,
      }))
    : (window.POCKET_VOICES || []).map((voice) => ({ id: voice, label: String(voice).replaceAll('_', ' ') }));
  return options
    .map(({ id, label }) => `<option value="${esc(id)}" ${preset.voice === id ? 'selected' : ''}>${esc(label)}</option>`)
    .join('');
}

export function openStoryNarrationPreset(story = window.currentStory) {
  if (!story) return;
  window._narrationPresetTarget = story;
  const preset = story.narrationPreset || {};
  showFeatureDialog('Story narration', `
    <label class="field-row"><span>Voice</span><select id="story-preset-voice" class="settings-control"><option value="">Use global voice</option>${_presetVoiceOptions(preset)}</select></label>
    <label class="field-row"><span>Emotion</span><select id="story-preset-emotion" class="settings-control"><option value="">Use global setting</option><option value="neutral">Neutral</option><option value="balanced">Balanced</option><option value="expressive">Expressive</option></select></label>
    <label class="field-row"><span>Speed</span><input id="story-preset-speed" type="range" min="0.5" max="2" step="0.05" value="${Number(preset.speed) || 1.0}"><output>${Number(preset.speed) || 1.0}x</output></label>
    <label class="field-row"><span>Story pronunciations</span><textarea id="story-preset-pronunciation" class="settings-control" rows="4" maxlength="2000" placeholder="Alopex = al-oh-pex">${esc((preset.pronunciationOverrides || []).map((entry) => `${entry.term} = ${entry.soundsLike}`).join('\n'))}</textarea><small>One term per line. These rules override global pronunciations for this story.</small></label>`,
  '<button class="pr-btn-sub" onclick="closeFeatureDialog()">Cancel</button><button class="pr-btn-primary" onclick="saveStoryNarrationPreset()">Save preset</button>');
  const emotion = document.getElementById('story-preset-emotion');
  // A preset saved before this fix holds the dead 'full'; show it as the
  // Expressive it was always meant to be rather than silently blanking it.
  if (emotion) emotion.value = preset.emotion === 'full' ? 'expressive' : (preset.emotion || '');
  const speed = document.getElementById('story-preset-speed');
  speed?.addEventListener('input', () => { speed.nextElementSibling.textContent = `${speed.value}x`; });
}
window.openStoryNarrationPreset = openStoryNarrationPreset;

export function saveStoryNarrationPreset() {
  const story = window._narrationPresetTarget || window.currentStory;
  if (!story) return;
  const pronunciationOverrides = (document.getElementById('story-preset-pronunciation')?.value || '')
    .split(/\r?\n/)
    .map((line) => line.split(/\s*=\s*/, 2).map((part) => part.trim()))
    .filter(([term, soundsLike]) => term && soundsLike)
    .slice(0, 40)
    .map(([term, soundsLike]) => ({ term: term.slice(0, 80), soundsLike: soundsLike.slice(0, 120), enabled: true }));
  story.narrationPreset = {
    voice: document.getElementById('story-preset-voice')?.value || '',
    emotion: document.getElementById('story-preset-emotion')?.value || '',
    speed: Number(document.getElementById('story-preset-speed')?.value) || 1.0,
    pronunciationOverrides,
  };
  const libraryStory = ensureReaderFeatures().library.find((item) => stableKey(item) === stableKey(story));
  if (libraryStory) libraryStory.narrationPreset = { ...story.narrationPreset };
  window.stampStorySyncField?.(libraryStory || story, 'narration');
  closeFeatureDialog();
  window._narrationPresetTarget = null;
  save('story-narration');
}
window.saveStoryNarrationPreset = saveStoryNarrationPreset;

export function saveWeeklyGoals() {
  const data = ensureReaderFeatures();
  data.goals.weeklyMinutes = Math.max(0, Number((document.getElementById('profile-edit-goal-minutes') || document.getElementById('setup-goal-weekly-minutes'))?.value) || 0);
  data.goals.weeklyChapters = Math.max(0, Number((document.getElementById('profile-edit-goal-chapters') || document.getElementById('setup-goal-weekly-chapters'))?.value) || 0);
  data.goals.streakEnabled = !!(document.getElementById('profile-edit-goal-streak') || document.getElementById('setup-goal-streak-enabled'))?.checked;
  data.goals.updatedAt = Date.now();
  save('goals');
}
window.saveWeeklyGoals = saveWeeklyGoals;

function queueMarkup(data) {
  // Index once instead of scanning the library per queued story. The old form
  // was library.find() inside a map, so it cost queue x library, and every
  // inner step called stableKey() -- which falls through to
  // getStoryStableKey(), a hash over title and author when a story has no
  // stored key. On a 500-story library that is ~2,500 hashes to lay out at
  // most five rows, repeated on every workflow re-render.
  const byKey = new Map();
  for (const story of data.library) {
    const key = stableKey(story);
    if (key && !byKey.has(key)) byKey.set(key, story);
  }
  const stories = data.readingQueue.map((key) => byKey.get(key)).filter(Boolean);
  if (!stories.length) return '<div class="empty-state"><strong>Your queue is clear.</strong><span>Add stories from the library when you want a deliberate next read.</span></div>';
  return stories.map((story, index) => `<article class="workflow-row"><button class="row-main" onclick="window.loadStory(${inlineArg(stableKey(story) || story.title || story.url || '')})"><strong>${esc(story.title)}</strong><span>${esc(story.author || 'Unknown author')}</span></button><div class="row-actions"><button class="icon-btn" title="Move up" aria-label="Move up" onclick="moveReadingQueue(${inlineArg(stableKey(story))},-1)" ${index === 0 ? 'disabled' : ''}>${window.prIcon('chevron-up')}</button><button class="icon-btn" title="Move down" aria-label="Move down" onclick="moveReadingQueue(${inlineArg(stableKey(story))},1)" ${index === stories.length - 1 ? 'disabled' : ''}>${window.prIcon('chevron-down')}</button></div></article>`).join('');
}

function historyMarkup(data) {
  const recent = [...data.history].sort((a, b) => Number(b.lastAt) - Number(a.lastAt)).slice(0, 5);
  if (!recent.length) return '<div class="empty-state"><strong>No history yet.</strong><span>Stories appear here after you open them.</span></div>';
  return recent.map((item) => `<button class="history-item" onclick="window.loadStory(${inlineArg(item.storyKey || item.title)})"><strong>${esc(item.title)}</strong><span>Chapter ${Number(item.progressChapter) + 1} | ${new Date(item.lastAt).toLocaleDateString()}</span></button>`).join('');
}

function goalProgress(data) {
  const target = Math.max(1, Number(data.goals.weeklyMinutes) || 120);
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 6);
  let words = 0;
  let chapters = 0;
  Object.values(data.dailyStatsByDevice || {}).forEach((days) => Object.entries(days || {}).forEach(([day, counters]) => {
    if (new Date(`${day}T00:00:00`) < cutoff) return;
    words += Number(counters?.totalWords) || 0;
    chapters += Number(counters?.chaptersCompleted) || 0;
  }));
  const minutes = Math.round(words / 150);
  const minutePct = Math.min(100, Math.round((minutes / target) * 100));
  const chapterTarget = Math.max(0, Number(data.goals.weeklyChapters) || 0);
  const chapterPct = chapterTarget ? Math.min(100, Math.round((chapters / chapterTarget) * 100)) : 0;
  return { target, minutes, chapters, chapterTarget, pct: Math.max(minutePct, chapterPct) };
}

function recapMetrics(data) {
  const now = new Date();
  // dailyStatsByDevice is keyed on LOCAL calendar dates (see incrementDeviceStat
  // / localDayKey), so the month/year prefixes must be local too — toISOString()
  // would use the UTC month/year and mis-bucket days near a month/year boundary
  // for users at non-zero UTC offsets.
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const yearPrefix = String(now.getFullYear());
  const totals = { monthWords: 0, monthChapters: 0, yearWords: 0, yearChapters: 0 };
  Object.values(data.dailyStatsByDevice || {}).forEach((days) => Object.entries(days || {}).forEach(([day, counters]) => {
    const words = Number(counters?.totalWords) || 0;
    const chapters = Number(counters?.chaptersCompleted) || 0;
    if (day.startsWith(yearPrefix)) { totals.yearWords += words; totals.yearChapters += chapters; }
    if (day.startsWith(monthPrefix)) { totals.monthWords += words; totals.monthChapters += chapters; }
  }));
  return totals;
}

export function renderWorkflowSurfaces() {
  const data = ensureReaderFeatures();
  const home = document.getElementById('home-workflow-band');
  if (home) {
    const goal = goalProgress(data);
    home.innerHTML = `<section class="workflow-panel"><header><div><span class="eyebrow">Up next</span><h2>Reading queue</h2></div><button class="pr-btn-sub" onclick="showView('library-view')">Browse library</button></header><div class="workflow-list">${queueMarkup(data)}</div></section><section class="workflow-panel"><header><div><span class="eyebrow">Return to</span><h2>Recent history</h2></div></header><div class="history-grid">${historyMarkup(data)}</div></section><section class="goal-panel"><span class="eyebrow">Weekly rhythm</span><strong>${goal.minutes} / ${goal.target} min</strong><div class="progress-track"><span style="width:${goal.pct}%"></span></div><small>${goal.pct}% of your goal</small></section>`;
  }
  const profileTarget = document.getElementById('profile-insights');
  if (profileTarget) {
    const goal = goalProgress(data);
    const recap = recapMetrics(data);
    profileTarget.innerHTML = `<section class="insight-card"><span class="eyebrow">Weekly goal</span><strong>${goal.pct}%</strong><span>${goal.minutes} of ${goal.target} minutes</span></section><section class="insight-card"><span class="eyebrow">This month</span><strong>${Math.round(recap.monthWords / 150)} min</strong><span>${recap.monthChapters} chapters completed</span></section><section class="insight-card"><span class="eyebrow">This year</span><strong>${Math.round(recap.yearWords / 1000).toLocaleString()}k words</strong><span>${recap.yearChapters} chapters completed</span></section><section class="insight-card"><span class="eyebrow">Collections</span><strong>${data.collections.length}</strong><span>${data.readingQueue.length} queued stories</span></section>`;
  }
  const collectionSelect = document.getElementById('library-collection-select');
  if (collectionSelect) {
    const current = collectionSelect.value;
    collectionSelect.innerHTML = '<option value="">All collections</option>' + data.collections.map((collection) => `<option value="${esc(collection.id)}">${esc(collection.name)}</option>`).join('');
    collectionSelect.value = current;
  }
}
window.renderWorkflowSurfaces = renderWorkflowSurfaces;

function installFeatureSurfaces() {
  const homeBookmarks = document.getElementById('home-bookmarks-folder');
  if (homeBookmarks && !document.getElementById('home-workflow-band')) {
    const band = document.createElement('div');
    band.id = 'home-workflow-band';
    band.className = 'home-workflow-band';
    homeBookmarks.before(band);
  }
  const achievements = document.getElementById('achievements-grid-container');
  if (achievements && !document.getElementById('profile-insights')) {
    const insights = document.createElement('div');
    insights.id = 'profile-insights';
    insights.className = 'profile-insights';
    achievements.parentElement.insertBefore(insights, achievements.previousElementSibling);
  }
  const libraryHeader = document.querySelector('#library-view .library-header');
  if (libraryHeader && !document.getElementById('library-workflow-toolbar')) {
    const toolbar = document.createElement('div');
    toolbar.id = 'library-workflow-toolbar';
    toolbar.className = 'workflow-toolbar';
    toolbar.innerHTML = '<select id="library-collection-select" class="settings-control" aria-label="Filter by collection"></select><button class="pr-btn-sub" onclick="openCollectionDialog()">' + window.prIcon('plus') + '<span>New collection</span></button>';
    toolbar.querySelector('#library-collection-select').addEventListener('change', () => window.renderLibrary?.(true));
    libraryHeader.after(toolbar);
  }
  renderWorkflowSurfaces();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installFeatureSurfaces, { once: true });
else installFeatureSurfaces();
document.addEventListener('pr:profile-synced', renderWorkflowSurfaces);
