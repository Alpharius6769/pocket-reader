// Native HMOFA Anthronomicon masterlist.
//
// Replaces the cross-origin iframe embed. The embed could never work during a
// narration session: ?tts_fast=1 is served with COEP require-corp, and a
// require-corp document refuses to nest a document that does not assert the
// same policy. GitHub Pages sends no COEP header, so the frame was always going
// to be blocked. Fetching the published catalog as JSON sidesteps that entirely
// -- COEP constrains framed documents and no-cors subresources, not a
// same-origin or CORS fetch -- so this view keeps working while narrating.
//
// Filtering, sorting and faceting are delegated wholesale to the vendored
// upstream data layer so results match the live index exactly.

import {
  DEFAULT_SORT,
  MIN_RATINGS,
  PLATFORMS,
  POV_VALUES,
  RATINGS,
  ROMANCE_TYPES,
  SETTINGS,
  SORT_VALUES,
  STATUSES,
  WORLDS,
  fanfictionSettingsForRecord,
  fictionalFacetValues,
  filterCatalog,
  formatDate,
  formatPartnerSpecies,
  formatSetting,
  formatWords,
  getFeaturedPeriod,
  getFeaturedStories,
  isFandomSetting,
  popularSubspecies,
  povsForRecord,
  requiresAccountGate,
  safeJsonParse,
  sortCatalog,
  speciesFacetValues,
  validateHttpUrl,
} from './hmofa_catalog_core.js?v=hmofa-core-v1';
import {
  fetchCommunitySnapshot,
  loadLocalRatings,
  submitRating,
  trackStoryOpen,
} from './hmofa_community.js?v=hmofa-community-v1';
import {
  openHmofaListsDialog,
  openHmofaPreferencesDialog,
  readPreferences,
  reconcileWithProfile,
} from './hmofa_preferences.js?v=hmofa-prefs-v2';

const CATALOG_BASE = 'https://alpharius6769.github.io/hmofa-story-index';
const CATALOG_URL = `${CATALOG_BASE}/assets/catalog.json`;
const CONFIG_URL = `${CATALOG_BASE}/assets/config.json`;
const CATALOG_CACHE = 'hmofa-catalog-v1';

// The same key the Anthronomicon itself writes. On the GitHub Pages build both
// apps share an origin, so sort order and page size carry over between them.
// Content preferences and saved lists live in hmofa_preferences.js.
const STORAGE_KEYS = Object.freeze({
  ui: 'hmofa_ui_prefs_v2',
});

const PAGE_SIZES = [20, 50];
const SPECIES_VISIBLE = 10;
const SORT_LABELS = Object.freeze({
  'title-asc': 'Title A-Z',
  'author-asc': 'Author A-Z',
  'updated-desc': 'Recently updated',
  'words-desc': 'Longest first',
  'rating-desc': 'Community rating',
});

const FACET_GROUPS = Object.freeze([
  ['world', 'World', WORLDS, (record) => record.worlds],
  ['setting', 'Setting', SETTINGS, (record) => [record.setting]],
  ['rating', 'Age rating', RATINGS, (record) => [record.rating]],
  ['status', 'Status', STATUSES, (record) => [record.status]],
  ['romance', 'Romance type', ROMANCE_TYPES, (record) => [record.romanceType]],
  ['platform', 'Platform', PLATFORMS, (record) => record.sources.map((s) => s.platform)],
  ['pov', 'POV', POV_VALUES, povsForRecord],
]);

const WORD_BUCKETS = Object.freeze([
  ['all', 'Any length'],
  ['under-10k', 'Under 10,000'],
  ['10k-50k', '10,000-49,999'],
  ['50k-100k', '50,000-99,999'],
  ['100k-250k', '100,000-249,999'],
  ['250k-plus', '250,000+'],
]);

const state = {
  records: [],
  generatedAt: '',
  loaded: false,
  loading: null,
  search: '',
  wordCount: 'all',
  minRating: 'any',
  sort: DEFAULT_SORT,
  page: 1,
  pageSize: 20,
  world: new Set(),
  setting: new Set(),
  rating: new Set(),
  status: new Set(),
  romance: new Set(),
  species: new Set(),
  subspecies: new Set(),
  platform: new Set(),
  pov: new Set(),
  customIds: null,
  preferences: null,
  selected: new Set(),
  speciesExpanded: false,
  view: 'all',
  communityRatings: {},
  communityTrending: [],
  communityState: 'loading',
  localRatings: {},
};

const VIEW_TABS = Object.freeze([
  ['all', 'All stories'],
  ['featured', 'Top 15 Featured'],
  ['trending', 'Weekly Trending'],
]);

const FILTER_SET_KEYS = ['world', 'setting', 'rating', 'status', 'romance', 'species', 'subspecies', 'platform', 'pov'];

let searchTimer = null;
let cachedFiltered = null;

const $ = (id) => document.getElementById(id);

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

function restoreUiPreferences() {
  const ui = safeJsonParse(readStorage(STORAGE_KEYS.ui, '{}'), {});
  state.pageSize = Number(ui.pageSize) === 50 ? 50 : 20;
  state.sort = SORT_VALUES.includes(ui.sort) ? ui.sort : DEFAULT_SORT;
  state.view = ['trending', 'featured'].includes(ui.activeTab) ? ui.activeTab : 'all';
}

// Same key and shape the index writes, so sort order and tab follow the reader
// between the two apps.
function saveUiPreferences() {
  writeStorage(STORAGE_KEYS.ui, JSON.stringify({
    activeTab: state.view,
    pageSize: state.pageSize,
    sort: state.sort,
  }));
}

// ── Catalog loading ─────────────────────────────────────────────────────────
// Cache-then-revalidate. A cached catalog paints immediately; the 343-byte
// config.json carries the build's catalogSha256, so staleness is settled with a
// tiny request instead of re-downloading 2.7 MB to find out nothing changed.
//
// The Cache API is used rather than IndexedDB deliberately: PocketReaderDB is
// at version 3 and adding a store would force a schema upgrade on every
// existing reader for what is a disposable, re-downloadable blob.

async function openCatalogCache() {
  try {
    return 'caches' in self ? await caches.open(CATALOG_CACHE) : null;
  } catch {
    return null;
  }
}

async function digestHex(buffer) {
  if (!globalThis.crypto?.subtle) return '';
  try {
    const hash = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

function normalizeCatalogRecord(record) {
  if (!record || typeof record !== 'object') return null;
  if (typeof record.id !== 'string' || !record.id) return null;
  if (typeof record.title !== 'string' || !record.title) return null;
  const sources = Array.isArray(record.sources)
    ? record.sources.filter((source) => source && typeof source === 'object')
    : [];
  return {
    ...record,
    authors: Array.isArray(record.authors) ? record.authors : [],
    aliases: Array.isArray(record.aliases) ? record.aliases : [],
    sources,
    tags: Array.isArray(record.tags) ? record.tags : [],
    worlds: Array.isArray(record.worlds) ? record.worlds : [],
  };
}

async function parseCatalogBuffer(buffer) {
  const sha = await digestHex(buffer);
  try {
    return { payload: JSON.parse(new TextDecoder().decode(buffer)), sha };
  } catch {
    return null;
  }
}

async function readCachedCatalog() {
  const cache = await openCatalogCache();
  if (!cache) return null;
  try {
    const response = await cache.match(CATALOG_URL);
    return response ? await parseCatalogBuffer(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

async function fetchRemoteCatalog() {
  const response = await fetch(CATALOG_URL, { credentials: 'omit' });
  if (!response.ok) throw new Error(`Catalog fetch failed: ${response.status}`);
  const buffer = await response.arrayBuffer();
  const parsed = await parseCatalogBuffer(buffer);
  if (!parsed) throw new Error('Catalog payload was not usable');
  const cache = await openCatalogCache();
  if (cache) {
    try {
      await cache.put(CATALOG_URL, new Response(buffer, {
        headers: { 'Content-Type': 'application/json' },
      }));
    } catch {
      /* a full cache must not fail the load; the parsed copy below still works */
    }
  }
  return parsed;
}

async function remoteCatalogSha() {
  try {
    const response = await fetch(CONFIG_URL, { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) return '';
    const config = await response.json();
    return typeof config?.catalogSha256 === 'string' ? config.catalogSha256 : '';
  } catch {
    return '';
  }
}

function adoptCatalog(parsed) {
  const payload = parsed?.payload;
  if (!payload || !Array.isArray(payload.records)) return false;
  const records = payload.records.map(normalizeCatalogRecord).filter(Boolean);
  if (!records.length) return false;
  state.records = records;
  state.generatedAt = typeof payload.generatedAt === 'string' ? payload.generatedAt : '';
  state.contentSha = parsed.sha || '';
  state.loaded = true;
  cachedFiltered = null;
  featuredCache = { key: null, ids: [] };
  return true;
}

async function loadCatalog() {
  const cached = await readCachedCatalog();
  if (adoptCatalog(cached)) {
    renderAll();
    // Revalidate against a hash of the cached bytes vs config.catalogSha256.
    // The catalog also carries a sha256 field; that value is self-reported and
    // is not used here, so a body that kept the old digest cannot skip refresh.
    remoteCatalogSha().then(async (published) => {
      if (!published) return;
      if (cached.sha && published === cached.sha) return;
      try {
        if (adoptCatalog(await fetchRemoteCatalog())) renderAll();
      } catch {
        /* the cached catalog is still perfectly usable */
      }
    });
    return;
  }
  if (!adoptCatalog(await fetchRemoteCatalog())) throw new Error('Catalog payload was not usable');
  renderAll();
}

function applySyncedPreferences() {
  reconcileWithProfile();
  state.preferences = readPreferences();
  cachedFiltered = null;
}

export async function ensureHmofaMasterlistLoaded() {
  if (state.loaded) {
    applySyncedPreferences();
    loadCommunity();
    renderAll();
    return;
  }
  if (state.loading) return state.loading;
  setStatus('Loading the Anthronomicon catalog...');
  state.loading = (async () => {
    try {
      applySyncedPreferences();
      state.localRatings = loadLocalRatings();
      restoreUiPreferences();
      await loadCatalog();
      loadCommunity();
    } catch (error) {
      window.Diagnostics?.log('WARN', 'HMOFA catalog load failed', { error: String(error) });
      setStatus('The catalog could not be reached. Check your connection and use Refresh Catalog.', true);
      throw error;
    } finally {
      state.loading = null;
    }
  })();
  return state.loading;
}
window.ensureHmofaMasterlistLoaded = ensureHmofaMasterlistLoaded;

export async function refreshHmofaCatalog() {
  setStatus('Refreshing the catalog...');
  try {
    const cache = await openCatalogCache();
    if (cache) await cache.delete(CATALOG_URL);
    applySyncedPreferences();
    if (adoptCatalog(await fetchRemoteCatalog())) renderAll();
    loadCommunity();
  } catch (error) {
    window.Diagnostics?.log('WARN', 'HMOFA catalog refresh failed', { error: String(error) });
    setStatus('Could not refresh the catalog just now.', true);
  }
}
window.refreshHmofaCatalog = refreshHmofaCatalog;

function setStatus(message, isError = false) {
  const element = $('hmofa-catalog-status');
  if (!element) return;
  element.textContent = message;
  element.dataset.error = isError ? '1' : '0';
}

// Deliberately not awaited by the loader: 2,149 stories are fully browsable
// without community data, so the grid must never sit behind this request. The
// ratings and trending order fill in when they arrive.
let communityLoading = null;
function loadCommunity() {
  if (communityLoading) return communityLoading;
  state.communityState = 'loading';
  communityLoading = fetchCommunitySnapshot()
    .then(({ ratings, trending }) => {
      state.communityRatings = ratings;
      state.communityTrending = trending;
      state.communityState = Object.keys(ratings).length || trending.length ? 'ready' : 'empty';
    })
    .catch((error) => {
      state.communityState = 'failed';
      window.Diagnostics?.log('WARN', 'HMOFA community snapshot unavailable', { error: String(error) });
    })
    .then(() => {
      cachedFiltered = null;
      featuredCache = { key: null, ids: [] };
      if (state.loaded) renderAll();
    })
    .finally(() => {
      communityLoading = null;
    });
  return communityLoading;
}

document.addEventListener('pr:profile-synced', () => {
  if (!state.loaded) return;
  applySyncedPreferences();
  renderAll();
});

// ── Filtering ───────────────────────────────────────────────────────────────

let featuredCache = { key: null, ids: [] };

// Featured is a monthly rotation seeded by community activity, so it only needs
// recomputing when the month or those numbers move -- not on every keystroke.
function monthlyFeaturedIds() {
  const period = getFeaturedPeriod();
  const key = [
    period,
    state.records.length,
    state.communityTrending.join('\0'),
    JSON.stringify(state.communityRatings),
  ].join(':');
  if (featuredCache.key === key) return featuredCache.ids;
  featuredCache = {
    key,
    ids: getFeaturedStories(state.records, state.communityRatings, new Set(), {
      trending: state.communityTrending,
      period,
    }),
  };
  return featuredCache.ids;
}

function filteredRecords() {
  if (cachedFiltered) return cachedFiltered;
  const matched = filterCatalog(state.records, state, state.preferences, state.communityRatings);
  if (state.view === 'trending' || state.view === 'featured') {
    // Both tabs are ranked orderings rather than filters, so the catalog sort
    // does not apply: narrow to the ranked ids and keep that order.
    const ordered = state.view === 'trending' ? state.communityTrending : monthlyFeaturedIds();
    const ranks = new Map(ordered.map((id, index) => [id, index]));
    cachedFiltered = matched
      .filter((record) => ranks.has(record.id))
      .sort((a, b) => ranks.get(a.id) - ranks.get(b.id));
  } else {
    cachedFiltered = sortCatalog(matched, state.sort, state.communityRatings);
  }
  return cachedFiltered;
}

function invalidate({ resetPage = true } = {}) {
  cachedFiltered = null;
  if (resetPage) state.page = 1;
  renderResults();
  renderActiveFilters();
}

function countFacet(accessor) {
  const counts = new Map();
  for (const record of state.records) {
    for (const value of new Set(accessor(record))) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

// ── Rendering ───────────────────────────────────────────────────────────────

function checkbox(group, value, count) {
  const label = document.createElement('label');
  label.className = 'hmofa-facet-option';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.dataset.filterGroup = group;
  input.value = value;
  input.checked = state[group].has(value);
  input.addEventListener('change', () => {
    if (input.checked) state[group].add(value);
    else state[group].delete(value);
    invalidate();
  });
  const text = document.createElement('span');
  text.textContent = value;
  const number = document.createElement('small');
  number.textContent = count.toLocaleString('en-US');
  label.append(input, text, number);
  return label;
}

function facetSection(title, nodes, { collapsed = false } = {}) {
  if (!nodes.length) return null;
  const details = document.createElement('details');
  details.className = 'hmofa-facet';
  details.open = !collapsed;
  const summary = document.createElement('summary');
  summary.textContent = title;
  const body = document.createElement('div');
  body.className = 'hmofa-facet-body';
  body.append(...nodes);
  details.append(summary, body);
  return details;
}

function renderFacets() {
  const rail = $('hmofa-facets');
  if (!rail) return;
  const sections = [];

  for (const [group, title, values, accessor] of FACET_GROUPS) {
    const counts = countFacet(accessor);
    const nodes = values
      .filter((value) => counts.get(value))
      .map((value) => checkbox(group, value, counts.get(value)));
    const section = facetSection(title, nodes, { collapsed: group !== 'world' && group !== 'rating' });
    if (section) sections.push(section);
  }

  // Species ordering mirrors upstream: commonest first, with the unidentified
  // buckets pushed to the bottom so they never crowd out real answers.
  const promoted = new Set(popularSubspecies(state.records).map(([label]) => label));
  const speciesCounts = countFacet((record) => speciesFacetValues(record, promoted));
  const sortedSpecies = [...speciesCounts].sort((a, b) => {
    const unknownA = a[0].includes('Unidentified') || a[0] === 'Unknown';
    const unknownB = b[0].includes('Unidentified') || b[0] === 'Unknown';
    if (unknownA !== unknownB) return unknownA ? 1 : -1;
    return b[1] - a[1] || a[0].localeCompare(b[0], 'en');
  });
  const visible = state.speciesExpanded ? sortedSpecies : sortedSpecies.slice(0, SPECIES_VISIBLE);
  const speciesNodes = visible.map(([value, count]) => checkbox('species', value, count));
  if (sortedSpecies.length > SPECIES_VISIBLE) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'hmofa-facet-more';
    more.textContent = state.speciesExpanded
      ? 'Show fewer species'
      : `Show ${sortedSpecies.length - SPECIES_VISIBLE} more species`;
    more.addEventListener('click', () => {
      state.speciesExpanded = !state.speciesExpanded;
      renderFacets();
    });
    speciesNodes.push(more);
  }
  const speciesSection = facetSection('Partner species', speciesNodes);
  if (speciesSection) sections.push(speciesSection);

  const fictional = [...countFacet(fictionalFacetValues)]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'))
    .map(([value, count]) => checkbox('species', value, count));
  const fictionalSection = facetSection('Fictional species', fictional, { collapsed: true });
  if (fictionalSection) sections.push(fictionalSection);

  const fandoms = [...countFacet(fanfictionSettingsForRecord)]
    .filter(([value]) => isFandomSetting(value))
    .sort((a, b) => {
      if (a[0] === 'Unknown Setting') return 1;
      if (b[0] === 'Unknown Setting') return -1;
      return b[1] - a[1] || a[0].localeCompare(b[0], 'en');
    })
    .map(([value, count]) => checkbox('setting', value, count));
  const fandomSection = facetSection('Fanfiction settings', fandoms, { collapsed: true });
  if (fandomSection) sections.push(fandomSection);

  rail.replaceChildren(...sections);
}

function renderActiveFilters() {
  const container = $('hmofa-active-filters');
  if (!container) return;
  const chips = [];

  const chip = (label, onClear) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hmofa-chip';
    button.textContent = label;
    button.title = 'Remove this filter';
    button.addEventListener('click', () => {
      onClear();
      renderFacets();
      invalidate();
    });
    chips.push(button);
  };

  if (state.search) chip(`Search: ${state.search}`, () => { state.search = ''; const box = $('hmofa-search'); if (box) box.value = ''; });
  if (state.wordCount !== 'all') {
    const label = WORD_BUCKETS.find(([value]) => value === state.wordCount)?.[1] ?? state.wordCount;
    chip(`Length: ${label}`, () => { state.wordCount = 'all'; const sel = $('hmofa-wordcount'); if (sel) sel.value = 'all'; });
  }
  if (state.minRating !== 'any') {
    chip(`\u2605 ${state.minRating}+`, () => { state.minRating = 'any'; const sel = $('hmofa-minrating'); if (sel) sel.value = 'any'; });
  }
  if (state.customIds) {
    chip(`Saved list (${state.customIds.size})`, () => { state.customIds = null; });
  }
  for (const group of FILTER_SET_KEYS) {
    for (const value of [...state[group]]) chip(value, () => state[group].delete(value));
  }

  const count = chips.length;
  container.replaceChildren(...chips);
  container.hidden = count === 0;
  const clear = $('hmofa-clear-filters');
  if (clear) clear.hidden = count === 0;
}

function metaItem(label, value) {
  const span = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = value;
  span.append(`${label} `, strong);
  return span;
}

// Adult FurAffinity and SoFurry works sit behind a sign-in wall. Upstream can
// only warn that the link will land on a login page; Pocket Reader can actually
// fix it, because the scrape backend forwards per-site cookies the reader
// already pastes into Settings. So the hint points at the fix, not the problem.
function accountGateHint(record, source) {
  if (!requiresAccountGate(record, source)) return null;
  const hint = document.createElement('p');
  hint.className = 'hmofa-card-gate';
  hint.textContent = `${source.platform} hides adult works behind a login. Add your ${source.platform} cookies under Settings to let Pocket Reader fetch this.`;
  return hint;
}

async function rateStory(record, score, row) {
  row.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  const result = await submitRating(record.id, score);
  state.localRatings = loadLocalRatings();
  if (result.aggregate) state.communityRatings[record.id] = result.aggregate;
  if (result.ok) {
    window.virtueSpeak?.(`Rated "${record.title}" ${score} star${score === 1 ? '' : 's'}.`, 3500);
  } else if (result.message) {
    setStatus(result.message, true);
  }
  // A new score can change community sort, the minimum-rating filter, and the
  // Featured ranking, so both the result cache and the featured rotation go.
  cachedFiltered = null;
  featuredCache = { key: null, ids: [] };
  renderResults();
}

function ratingRow(record) {
  const row = document.createElement('div');
  row.className = 'hmofa-card-rating';

  const community = state.communityRatings[record.id];
  const mine = state.localRatings[record.id];
  // Show the community consensus where one exists, and fall back to the
  // reader's own score so a story they just rated does not read as unrated.
  const shown = community?.total ? Number(community.average) : (Number.isFinite(mine) ? mine : 0);
  const lit = Math.min(5, Math.max(0, Math.round(shown)));

  for (let score = 1; score <= 5; score += 1) {
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'hmofa-star';
    star.dataset.lit = String(score <= lit);
    star.dataset.mine = String(mine === score);
    star.textContent = '\u2605';
    star.setAttribute('aria-label', `Rate ${record.title} ${score} star${score === 1 ? '' : 's'}`);
    star.setAttribute('aria-pressed', String(mine === score));
    star.addEventListener('click', () => rateStory(record, score, row));
    row.append(star);
  }

  const summary = document.createElement('span');
  summary.className = 'hmofa-rating-summary';
  if (community?.total) {
    const total = Number(community.total);
    summary.textContent = `${Number(community.average).toFixed(1)} · ${total.toLocaleString('en-US')} vote${total === 1 ? '' : 's'}`;
  } else {
    summary.textContent = state.communityState === 'failed' ? 'Ratings offline' : 'No community votes';
  }
  row.append(summary);
  return row;
}

function createCard(record) {
  const card = document.createElement('article');
  card.className = 'story-card hmofa-card';
  card.dataset.storyId = record.id;

  const topline = document.createElement('div');
  topline.className = 'hmofa-card-topline';
  const worlds = document.createElement('span');
  worlds.className = 'hmofa-card-worlds';
  worlds.textContent = record.worlds.join(' · ');
  const select = document.createElement('label');
  select.className = 'hmofa-card-select';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = state.selected.has(record.id);
  box.addEventListener('change', () => {
    if (box.checked) state.selected.add(record.id);
    else state.selected.delete(record.id);
    renderSelectionBar();
  });
  select.append(box, document.createTextNode('Select'));
  topline.append(worlds, select);

  const title = document.createElement('h4');
  title.className = 'hmofa-card-title';
  title.textContent = record.title;

  const author = document.createElement('p');
  author.className = 'hmofa-card-author';
  author.textContent = `By ${record.authors.length ? record.authors.join(', ') : 'Unknown'}`;

  const summary = document.createElement('p');
  summary.className = 'hmofa-card-summary';
  summary.textContent = record.summaryExcerpt || 'Summary unavailable.';

  const meta = document.createElement('div');
  meta.className = 'hmofa-card-meta';
  meta.append(
    metaItem('Rating', record.ratingBasis ? `${record.rating}*` : record.rating),
    metaItem('Status', record.status),
    metaItem('Setting', formatSetting(record)),
    metaItem('Words', formatWords(record.wordCount)),
    metaItem('Updated', formatDate(record.updatedAt)),
    metaItem('Romance', record.romanceType),
    metaItem('Partner', formatPartnerSpecies(record)),
  );

  const actions = document.createElement('div');
  actions.className = 'hmofa-card-actions';
  const sources = (record.sources || []).map((source) => {
    const url = validateHttpUrl(source.url, source.platform) || validateHttpUrl(source.url);
    return url ? { ...source, url } : null;
  }).filter(Boolean);
  const primary = sources[0];

  sources.forEach((source, index) => {
    const load = document.createElement('button');
    load.type = 'button';
    load.className = index === 0 ? 'pr-btn-primary hmofa-card-load' : 'pr-btn-outline hmofa-card-load';
    load.textContent = index === 0
      ? `Read in Pocket Reader${sources.length > 1 ? ` (${source.platform})` : ''}`
      : `Load from ${source.platform}`;
    load.addEventListener('click', () => {
      // Counts toward Weekly Trending on the shared index, the same way a click
      // through to the source does there. Fire-and-forget.
      trackStoryOpen(record.id);
      window._handleHmofaStoryIntercept?.(source.url, record.title);
    });
    actions.append(load);
  });

  if (primary) {
    const external = document.createElement('a');
    external.className = 'hmofa-card-source';
    external.href = primary.url;
    external.target = '_blank';
    external.rel = 'noopener noreferrer';
    external.textContent = `Open on ${primary.platform} \u2197`;
    actions.append(external);
  }

  card.append(topline, title, author, summary, meta, ratingRow(record), actions);
  if (primary) {
    const gate = accountGateHint(record, primary);
    if (gate) card.append(gate);
  }

  if (record.tags.length) {
    const details = document.createElement('details');
    details.className = 'hmofa-card-tags';
    const summaryEl = document.createElement('summary');
    summaryEl.textContent = `${record.tags.length.toLocaleString('en-US')} source tags`;
    const list = document.createElement('div');
    list.className = 'hmofa-tag-list';
    // Tags are only built when the disclosure is first opened. Rendering every
    // tag for every card up front costs tens of thousands of nodes per page.
    details.addEventListener('toggle', () => {
      if (!details.open || list.childElementCount) return;
      for (const tag of record.tags) {
        const pill = document.createElement('span');
        pill.className = 'tag-pill hmofa-tag';
        pill.textContent = tag;
        list.append(pill);
      }
    }, { once: false });
    details.append(summaryEl, list);
    card.append(details);
  }

  return card;
}

function renderSelectionBar() {
  const bar = $('hmofa-selection-bar');
  const count = $('hmofa-selection-count');
  if (!bar || !count) return;
  bar.hidden = state.selected.size === 0;
  count.textContent = state.selected.size === 1 ? '1 story selected' : `${state.selected.size} stories selected`;
}

function renderResults() {
  const grid = $('hmofa-results');
  const heading = $('hmofa-results-count');
  if (!grid) return;

  const matched = filteredRecords();
  const pages = Math.max(1, Math.ceil(matched.length / state.pageSize));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * state.pageSize;
  const slice = matched.slice(start, start + state.pageSize);

  if (heading) {
    heading.textContent = matched.length === 1
      ? '1 story found'
      : `${matched.length.toLocaleString('en-US')} stories found`;
  }

  if (!matched.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.gridColumn = '1/-1';
    if (!state.records.length) {
      empty.textContent = 'The catalog has not loaded yet.';
    } else if (state.view === 'all') {
      empty.textContent = 'No stories match these filters. Try clearing a few.';
    } else if (state.communityState === 'loading') {
      empty.textContent = 'Loading community activity...';
    } else if (state.communityState === 'failed') {
      // This tab is ranked entirely by server data, so without it there is
      // nothing to show -- but search and filters still work.
      empty.textContent = 'Community activity is unavailable, so this tab has nothing to rank yet. All stories still works.';
    } else {
      empty.textContent = 'Nothing in this tab matches your filters yet.';
    }
    grid.replaceChildren(empty);
  } else {
    grid.replaceChildren(...slice.map(createCard));
  }

  renderPagination(matched.length, pages);
  renderSelectionBar();
  if (state.generatedAt) {
    const stamp = new Date(state.generatedAt);
    const when = Number.isNaN(stamp.valueOf()) ? state.generatedAt : stamp.toLocaleDateString();
    setStatus(`${state.records.length.toLocaleString('en-US')} stories in the catalog · updated ${when}`);
  }
}

function renderPagination(total, pages) {
  const nav = $('hmofa-pagination');
  if (!nav) return;
  if (pages <= 1) {
    nav.replaceChildren();
    nav.hidden = true;
    return;
  }
  nav.hidden = false;

  const button = (label, page, disabled) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'pr-btn-outline hmofa-page-btn';
    element.textContent = label;
    element.disabled = disabled;
    element.addEventListener('click', () => {
      state.page = page;
      renderResults();
      $('hmofa-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return element;
  };

  const position = document.createElement('span');
  position.className = 'hmofa-page-position';
  position.textContent = `Page ${state.page} of ${pages} · ${total.toLocaleString('en-US')} stories`;

  nav.replaceChildren(
    button('Previous', state.page - 1, state.page <= 1),
    position,
    button('Next', state.page + 1, state.page >= pages),
  );
}

function renderViewTabs() {
  const container = $('hmofa-view-tabs');
  if (!container) return;
  container.replaceChildren(...VIEW_TABS.map(([value, label]) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'filter-chip hmofa-view-tab';
    tab.classList.toggle('active', state.view === value);
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(state.view === value));
    tab.textContent = label;
    tab.addEventListener('click', () => {
      state.view = value;
      saveUiPreferences();
      renderViewTabs();
      invalidate();
    });
    return tab;
  }));
  // Featured and Trending are ranked orderings, so a catalog sort would fight
  // the ranking rather than refine it.
  const sort = $('hmofa-sort');
  if (sort) sort.disabled = state.view !== 'all';
}

function renderAll() {
  renderViewTabs();
  renderFacets();
  renderActiveFilters();
  renderResults();
}

// ── Controls ────────────────────────────────────────────────────────────────

function syncControlValues() {
  const search = $('hmofa-search');
  if (search) search.value = state.search;
  const words = $('hmofa-wordcount');
  if (words) words.value = state.wordCount;
  const minRating = $('hmofa-minrating');
  if (minRating) minRating.value = state.minRating;
  const sort = $('hmofa-sort');
  if (sort) sort.value = state.sort;
}

function clearAllFilters() {
  state.search = '';
  state.wordCount = 'all';
  state.minRating = 'any';
  state.customIds = null;
  for (const key of FILTER_SET_KEYS) state[key].clear();
  syncControlValues();
  renderFacets();
  invalidate();
}

// Shaped for validateSavedList, so a saved view round-trips through the same
// normalizer the index uses rather than a parallel one that could drift.
function filterSnapshot() {
  return {
    search: state.search,
    wordCount: state.wordCount,
    minRating: state.minRating,
    sort: state.sort,
    ...Object.fromEntries(FILTER_SET_KEYS.map((key) => [key, [...state[key]]])),
  };
}

function applySavedList(list) {
  if (!list) return;
  // Ranked tabs ignore catalog filters, so a saved list would appear empty
  // if Featured or Trending were still selected.
  state.view = 'all';
  if (list.type === 'ids') {
    state.customIds = new Set(list.ids);
  } else {
    state.customIds = null;
    const filters = list.filters || {};
    state.search = filters.search || '';
    state.wordCount = filters.wordCount || 'all';
    state.minRating = filters.minRating || 'any';
    if (SORT_VALUES.includes(filters.sort)) state.sort = filters.sort;
    for (const key of FILTER_SET_KEYS) {
      state[key] = new Set(Array.isArray(filters[key]) ? filters[key] : []);
    }
  }
  saveUiPreferences();
  syncControlValues();
  renderViewTabs();
  renderFacets();
  invalidate();
}

function bindControls() {
  const search = $('hmofa-search');
  search?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = search.value;
      invalidate();
    }, 180);
  });

  const words = $('hmofa-wordcount');
  if (words) {
    words.replaceChildren(...WORD_BUCKETS.map(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }));
    words.value = state.wordCount;
    words.addEventListener('change', () => {
      state.wordCount = words.value;
      invalidate();
    });
  }

  const minRating = $('hmofa-minrating');
  if (minRating) {
    minRating.replaceChildren(...MIN_RATINGS.map((value) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value === 'any' ? 'Any rating' : `\u2605 ${value}+`;
      return option;
    }));
    minRating.value = state.minRating;
    minRating.addEventListener('change', () => {
      state.minRating = minRating.value;
      invalidate();
    });
  }

  const sort = $('hmofa-sort');
  if (sort) {
    sort.replaceChildren(...SORT_VALUES.map((value) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = SORT_LABELS[value] ?? value;
      return option;
    }));
    sort.value = state.sort;
    sort.addEventListener('change', () => {
      state.sort = sort.value;
      saveUiPreferences();
      invalidate();
    });
  }

  const perPage = $('hmofa-pagesize');
  if (perPage) {
    perPage.replaceChildren(...PAGE_SIZES.map((size) => {
      const option = document.createElement('option');
      option.value = String(size);
      option.textContent = `${size} per page`;
      return option;
    }));
    perPage.value = String(state.pageSize);
    perPage.addEventListener('change', () => {
      state.pageSize = Number(perPage.value) === 50 ? 50 : 20;
      saveUiPreferences();
      invalidate();
    });
  }

  $('hmofa-clear-filters')?.addEventListener('click', clearAllFilters);
  $('hmofa-refresh-catalog')?.addEventListener('click', () => refreshHmofaCatalog());

  $('hmofa-open-preferences')?.addEventListener('click', () => {
    openHmofaPreferencesDialog((preferences) => {
      state.preferences = preferences;
      invalidate();
    });
  });

  $('hmofa-open-lists')?.addEventListener('click', () => {
    openHmofaListsDialog({
      getFilters: filterSnapshot,
      getSelectedIds: () => [...state.selected],
      onApply: applySavedList,
    });
  });

  $('hmofa-selection-add')?.addEventListener('click', async () => {
    const chosen = state.records.filter((record) => state.selected.has(record.id));
    if (!chosen.length) return;
    const stories = chosen
      .map((record) => {
        const source = record.sources[0];
        const url = source
          ? (validateHttpUrl(source.url, source.platform) || validateHttpUrl(source.url))
          : null;
        return url ? { url, title: record.title } : null;
      })
      .filter(Boolean);
    state.selected.clear();
    renderSelectionBar();
    renderResults();
    await window._handleHmofaStoryBatch?.(stories);
  });

  $('hmofa-selection-clear')?.addEventListener('click', () => {
    state.selected.clear();
    renderSelectionBar();
    renderResults();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindControls, { once: true });
} else {
  bindControls();
}

export const _hmofaState = state;
window._hmofaState = state;
