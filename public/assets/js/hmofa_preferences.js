// Reader-owned masterlist settings: content preferences, the tag and POV
// blacklists, and saved filter lists.
//
// Storage uses the Anthronomicon's own keys on purpose. Production is
// alpharius6769.github.io, where Pocket Reader and the index share an origin and
// therefore localStorage, so a blacklist edited in either app is immediately in
// force in the other with no import step.
//
// Those keys are per-origin though, so on their own they never follow a reader
// to a second device. Pocket Reader already syncs a profile through Supabase, so
// the same values are mirrored into userProfile.settings and stamped for the
// clocked per-field merge in profile_merge.js.
//
// Reconciliation is three-way against a shadow copy of the last synced value.
// A plain two-way compare cannot work here: the index writes these keys without
// ever touching Pocket Reader's clock, so "local differs from synced" alone
// cannot distinguish an edit made on the index from an edit that arrived from
// another device. The shadow says which side actually moved.

import {
  BLACKLIST_THEMES,
  POV_VALUES,
  SORT_VALUES,
  WORLDS,
  normalizeString,
  safeJsonParse,
  validateSavedList,
} from './hmofa_catalog_core.js?v=hmofa-core-v1';

const KEYS = Object.freeze({
  preferences: 'hmofa_user_prefs_v2',
  lists: 'hmofa_saved_lists_v1',
  // Pocket Reader's own bookkeeping; the index neither reads nor writes it.
  shadow: 'pr_hmofa_sync_shadow_v1',
});

const PROFILE_FIELDS = Object.freeze({
  preferences: 'hmofaPreferences',
  lists: 'hmofaSavedLists',
});

const RATING_MODES = Object.freeze([
  ['both', 'SFW and NSFW'],
  ['sfw', 'SFW only'],
  ['nsfw', 'Mature and Explicit only'],
]);

function readStorage(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode or a full quota must not break browsing */
  }
}

function removeStorage(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to do */
  }
}

export function defaultPreferences() {
  return {
    rating: 'both',
    fandoms: [...WORLDS],
    blacklist: [],
    blacklistedPOVs: [],
    blockTagSpam: false,
    blockAnon: false,
  };
}

export function normalizePreferences(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultPreferences();
  return {
    ...raw,
    rating: ['both', 'sfw', 'nsfw'].includes(raw.rating) ? raw.rating : 'both',
    fandoms: Array.isArray(raw.fandoms) ? raw.fandoms.filter((world) => WORLDS.includes(world)) : [...WORLDS],
    blacklist: Array.isArray(raw.blacklist)
      ? [...new Set(raw.blacklist.map((item) => normalizeString(item, 160)).filter(Boolean))].slice(0, 100)
      : [],
    blacklistedPOVs: Array.isArray(raw.blacklistedPOVs)
      ? [...new Set(raw.blacklistedPOVs.map((item) => normalizeString(item, 80)).filter(Boolean))].slice(0, 10)
      : [],
    blockTagSpam: Boolean(raw.blockTagSpam),
    blockAnon: Boolean(raw.blockAnon),
  };
}

export function readPreferences() {
  return normalizePreferences(safeJsonParse(readStorage(KEYS.preferences, 'null'), null));
}

export function readSavedLists() {
  return normalizeSavedLists(safeJsonParse(readStorage(KEYS.lists, '[]'), []));
}

// The vendored validateSavedList strips unknown filter keys, including sort.
// Pocket Reader stores sort on the preset so a named list restores the same
// order; re-attach it after validation so a round-trip does not drop it.
function attachPresetSort(raw, list) {
  if (!list || list.type !== 'preset') return list;
  const sort = raw?.filters?.sort ?? raw?.sort;
  if (SORT_VALUES.includes(sort)) list.filters = { ...list.filters, sort };
  return list;
}

function normalizeSavedLists(values) {
  const lists = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const list = attachPresetSort(raw, validateSavedList(raw));
    if (!list) continue;
    const fingerprint = JSON.stringify(list);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    lists.push(list);
  }
  return lists.slice(0, 100);
}

// ── Profile sync ────────────────────────────────────────────────────────────

function pushToProfile(field, value) {
  const profile = window.userProfile;
  if (!profile) return;
  profile.settings = profile.settings && typeof profile.settings === 'object' ? profile.settings : {};
  if (value) profile.settings[field] = value;
  else delete profile.settings[field];
  window.stampSyncedSetting?.(field);
  window.saveLocalData?.();
  window.queueCloudSync?.('hmofa-settings');
}

function updateShadow(name, value) {
  const shadow = safeJsonParse(readStorage(KEYS.shadow, '{}'), {});
  shadow[name] = value;
  writeStorage(KEYS.shadow, JSON.stringify(shadow));
}

function persist(name, value) {
  const storageKey = KEYS[name];
  if (value) writeStorage(storageKey, value);
  else removeStorage(storageKey);
  pushToProfile(PROFILE_FIELDS[name], value);
  updateShadow(name, value);
}

export function writePreferences(preferences) {
  persist('preferences', JSON.stringify(normalizePreferences(preferences)));
}

export function writeSavedLists(lists) {
  persist('lists', JSON.stringify(normalizeSavedLists(lists)));
}

/**
 * Settle localStorage against the synced copy. Call before reading either.
 *
 * Whichever side moved since the last sync wins; if both moved, the local copy
 * does, because it is the one the reader can see in front of them right now.
 */
export function reconcileWithProfile() {
  const shadow = safeJsonParse(readStorage(KEYS.shadow, '{}'), {});
  const settings = window.userProfile?.settings;

  for (const name of ['preferences', 'lists']) {
    const storageKey = KEYS[name];
    const local = readStorage(storageKey, '') || '';
    const remoteRaw = settings?.[PROFILE_FIELDS[name]];
    const remote = typeof remoteRaw === 'string' ? remoteRaw : '';
    const base = typeof shadow[name] === 'string' ? shadow[name] : '';

    if (local === remote) {
      shadow[name] = local;
      continue;
    }
    if (local !== base) {
      pushToProfile(PROFILE_FIELDS[name], local);
      shadow[name] = local;
      continue;
    }
    if (remote) writeStorage(storageKey, remote);
    else removeStorage(storageKey);
    shadow[name] = remote;
  }

  writeStorage(KEYS.shadow, JSON.stringify(shadow));
}

// ── Dialog building blocks ──────────────────────────────────────────────────

function section(title, ...nodes) {
  const wrap = document.createElement('section');
  wrap.className = 'hmofa-prefs-section';
  const heading = document.createElement('h4');
  heading.textContent = title;
  wrap.append(heading, ...nodes);
  return wrap;
}

function hint(text) {
  const element = document.createElement('p');
  element.className = 'hmofa-prefs-hint';
  element.textContent = text;
  return element;
}

function toggle(type, name, label, checked, onChange) {
  const wrapper = document.createElement('label');
  wrapper.className = 'hmofa-prefs-option';
  const input = document.createElement('input');
  input.type = type;
  if (name) input.name = name;
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const text = document.createElement('span');
  text.textContent = label;
  wrapper.append(input, text);
  return wrapper;
}

function optionRow(...nodes) {
  const row = document.createElement('div');
  row.className = 'hmofa-prefs-options';
  row.append(...nodes);
  return row;
}

function removableChip(label, onRemove) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'hmofa-chip';
  chip.textContent = label;
  chip.title = `Stop blocking ${label}`;
  chip.addEventListener('click', onRemove);
  return chip;
}

export function openHmofaPreferencesDialog(onChange) {
  if (typeof window.showFeatureDialog !== 'function') return;
  const preferences = readPreferences();

  const commit = () => {
    writePreferences(preferences);
    onChange?.(readPreferences());
  };

  window.showFeatureDialog(
    'Filters and content',
    '',
    '<button class="pr-btn-outline" data-hmofa-reset>Reset to defaults</button>'
    + '<button class="pr-btn-primary" data-close>Done</button>',
    (dialog) => {
      const body = dialog.querySelector('#feature-dialog-body');
      if (!body) return;

      const ratingRow = optionRow(...RATING_MODES.map(([value, label]) => {
        const option = toggle('radio', 'hmofa-rating-mode', label, preferences.rating === value, (checked) => {
          if (!checked) return;
          preferences.rating = value;
          commit();
        });
        return option;
      }));

      const worldRow = optionRow(...WORLDS.map((world) => toggle(
        'checkbox', '', world, preferences.fandoms.includes(world), (checked) => {
          const next = new Set(preferences.fandoms);
          if (checked) next.add(world); else next.delete(world);
          // An empty world list would hide the entire catalog, which reads as a
          // broken app rather than a filter. Treat "none" as "all".
          preferences.fandoms = next.size ? [...next] : [...WORLDS];
          commit();
          if (!next.size) openHmofaPreferencesDialog(onChange);
        },
      )));

      const chips = document.createElement('div');
      chips.className = 'hmofa-chip-row';
      const renderChips = () => {
        chips.replaceChildren(...preferences.blacklist.map((tag) => removableChip(tag, () => {
          preferences.blacklist = preferences.blacklist.filter((item) => item !== tag);
          commit();
          renderChips();
          renderThemes();
        })));
        if (!preferences.blacklist.length) chips.append(hint('Nothing is blocked on this device.'));
      };

      const addTag = (raw) => {
        const tag = normalizeString(raw, 160);
        if (!tag || preferences.blacklist.includes(tag) || preferences.blacklist.length >= 100) return;
        preferences.blacklist = [...preferences.blacklist, tag];
        commit();
        renderChips();
        renderThemes();
      };

      const tagInput = document.createElement('input');
      tagInput.type = 'text';
      tagInput.className = 'hmofa-url-input';
      tagInput.placeholder = 'Block a tag or word...';
      tagInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        addTag(tagInput.value);
        tagInput.value = '';
      });
      const addButton = document.createElement('button');
      addButton.type = 'button';
      addButton.className = 'pr-btn-outline';
      addButton.textContent = 'Block';
      addButton.addEventListener('click', () => {
        addTag(tagInput.value);
        tagInput.value = '';
      });
      const tagRow = document.createElement('div');
      tagRow.className = 'hmofa-prefs-row';
      tagRow.append(tagInput, addButton);

      // The named themes match by pattern rather than by literal text, so they
      // catch spellings a typed word misses.
      const themes = document.createElement('div');
      themes.className = 'hmofa-chip-row';
      const renderThemes = () => {
        themes.replaceChildren(...Object.keys(BLACKLIST_THEMES).map((theme) => {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'filter-chip';
          const active = preferences.blacklist.includes(theme);
          chip.classList.toggle('active', active);
          chip.textContent = theme;
          chip.addEventListener('click', () => {
            preferences.blacklist = active
              ? preferences.blacklist.filter((item) => item !== theme)
              : [...preferences.blacklist, theme];
            commit();
            renderChips();
            renderThemes();
          });
          return chip;
        }));
      };

      renderChips();
      renderThemes();

      const povRow = optionRow(...POV_VALUES.map((pov) => toggle(
        'checkbox', '', pov, preferences.blacklistedPOVs.includes(pov), (checked) => {
          const next = new Set(preferences.blacklistedPOVs);
          if (checked) next.add(pov); else next.delete(pov);
          preferences.blacklistedPOVs = [...next].slice(0, 10);
          commit();
        },
      )));

      const storyRow = optionRow(
        toggle('checkbox', '', 'Block stories with excessive tag spam', preferences.blockTagSpam, (checked) => {
          preferences.blockTagSpam = checked;
          commit();
        }),
        toggle('checkbox', '', 'Block stories featuring Anon as a character', preferences.blockAnon, (checked) => {
          preferences.blockAnon = checked;
          commit();
        }),
      );

      body.replaceChildren(
        hint('These settings are shared with the HMOFA Anthronomicon and follow your Pocket Reader account to other devices. They never change the public catalog.'),
        section('Show ratings', ratingRow),
        section('Worlds', worldRow),
        section('Blocked tags', chips, tagRow, hint('Common themes:'), themes),
        section('Blocked POVs', povRow),
        section('Story options', storyRow),
      );

      dialog.querySelector('[data-hmofa-reset]')?.addEventListener('click', () => {
        Object.assign(preferences, defaultPreferences());
        commit();
        openHmofaPreferencesDialog(onChange);
      });
      dialog.querySelectorAll('[data-close]').forEach((button) => {
        button.addEventListener('click', () => window.closeFeatureDialog?.());
      });
    },
  );
}

export function openHmofaListsDialog({ getFilters, getSelectedIds, onApply, onChange } = {}) {
  if (typeof window.showFeatureDialog !== 'function') return;

  window.showFeatureDialog(
    'My lists',
    '',
    '<button class="pr-btn-primary" data-close>Done</button>',
    (dialog) => {
      const body = dialog.querySelector('#feature-dialog-body');
      if (!body) return;

      const listWrap = document.createElement('div');
      listWrap.className = 'hmofa-saved-lists';

      const renderLists = () => {
        const lists = readSavedLists();
        if (!lists.length) {
          listWrap.replaceChildren(hint('No saved lists yet. Set up a search and filters, then save them here.'));
          return;
        }
        listWrap.replaceChildren(...lists.map((list, index) => {
          const row = document.createElement('div');
          row.className = 'hmofa-saved-list';
          const name = document.createElement('span');
          name.textContent = list.name;
          const apply = document.createElement('button');
          apply.type = 'button';
          apply.className = 'pr-btn-outline';
          apply.textContent = 'Apply';
          apply.addEventListener('click', () => {
            onApply?.(list);
            window.closeFeatureDialog?.();
          });
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'pr-btn-outline';
          remove.textContent = 'Delete';
          remove.addEventListener('click', () => {
            const next = readSavedLists();
            next.splice(index, 1);
            writeSavedLists(next);
            renderLists();
            onChange?.();
          });
          row.append(name, apply, remove);
          return row;
        }));
      };

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'hmofa-url-input';
      nameInput.placeholder = 'Name this set of filters...';
      const saveButton = document.createElement('button');
      saveButton.type = 'button';
      saveButton.className = 'pr-btn-primary';
      saveButton.textContent = 'Save current filters';
      saveButton.addEventListener('click', () => {
        const filters = getFilters?.() ?? {};
        const candidate = attachPresetSort(
          { type: 'preset', name: nameInput.value, filters },
          validateSavedList({ type: 'preset', name: nameInput.value, filters }),
        );
        if (!candidate) {
          nameInput.focus();
          return;
        }
        writeSavedLists([...readSavedLists(), candidate]);
        nameInput.value = '';
        renderLists();
        onChange?.();
      });
      const saveRow = document.createElement('div');
      saveRow.className = 'hmofa-prefs-row';
      saveRow.append(nameInput, saveButton);

      const saveSelected = document.createElement('button');
      saveSelected.type = 'button';
      saveSelected.className = 'pr-btn-outline';
      saveSelected.textContent = 'Save selected stories';
      const selectedCount = (getSelectedIds?.() ?? []).length;
      saveSelected.disabled = selectedCount === 0;
      saveSelected.title = selectedCount
        ? `Save ${selectedCount} selected ${selectedCount === 1 ? 'story' : 'stories'} as a list`
        : 'Select stories on the masterlist first';
      saveSelected.addEventListener('click', () => {
        const candidate = validateSavedList({
          type: 'ids',
          name: nameInput.value,
          ids: getSelectedIds?.() ?? [],
        });
        if (!candidate) {
          nameInput.focus();
          return;
        }
        writeSavedLists([...readSavedLists(), candidate]);
        nameInput.value = '';
        renderLists();
        onChange?.();
      });
      saveRow.append(saveSelected);

      renderLists();
      body.replaceChildren(
        hint('Saved lists keep a search, its filters and its sort together. They are shared with the Anthronomicon and follow your account.'),
        section('Save this view', saveRow),
        section('Saved lists', listWrap),
      );

      dialog.querySelectorAll('[data-close]').forEach((button) => {
        button.addEventListener('click', () => window.closeFeatureDialog?.());
      });
    },
  );
}
