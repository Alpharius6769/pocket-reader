// What device is this, and how much memory does it really have?
//
// The narration ladder turns on one quantity -- how much working memory the tab
// can hold -- and the web platform has spent a decade making that harder to
// learn. Chrome's User-Agent Reduction freezes the Android UA to "Android 10; K"
// with no model token at all; navigator.deviceMemory is quantised to a power of
// two AND capped at 8, so a 12 GB phone and an 8 GB phone are the same number;
// and Safari implements neither, reporting nothing about the hardware beyond a
// screen size that several models share.
//
// So this file is the lookup the platform will not do: a model, however it was
// arrived at, resolved to a RAM figure, resolved to a tier ceiling. It is
// deliberately pure data plus pure functions -- no storage, no navigator, no
// imports from the policy that consumes it -- so it can be tested directly and
// cannot introduce a cycle.
//
// SOURCED FROM published specifications, not measured here. That is the point:
// the measurement already exists (the headroom probe) and is authoritative. This
// only decides how HIGH the measurement is allowed to reach, which is why an
// entry being slightly wrong costs quality rather than a crashed tab.

export const CATALOG_VERSION = 'catalog-v1';

// RAM -> tier. The boundaries come from ENGINE_HEADROOM_MB in the policy
// (kitten 96, kokoro 448, pocket 704) and from what those figures cost in
// practice: Kokoro's ONNX session build peaks at 396-421 MB, and a 4 GB iPhone
// is documented as having roughly 400 MB of usable heap. A 4 GB device is
// therefore not a Kokoro device, however new it is.
export const RAM_TIER_BOUNDARIES = Object.freeze({
  kokoroMinGb: 6,
  pocketMinGb: 8,
});

export function tierForRamGb(ramGb) {
  const gb = Number(ramGb) || 0;
  if (gb >= RAM_TIER_BOUNDARIES.pocketMinGb) return 'pocket';
  if (gb >= RAM_TIER_BOUNDARIES.kokoroMinGb) return 'kokoro';
  return 'kitten';
}

// ── iPhone ──────────────────────────────────────────────────────────────────
//
// `geometry` is the CSS logical size as min-x-max, matching what the policy
// builds from screen.width/height. `promotion` is ProMotion (120 Hz), which is
// the one thing a browser can still measure that separates two models sharing a
// size -- see refreshRateNarrows() below.
//
// RAM figures are the published specifications. The 4 GB / 6 GB / 8 GB steps are
// what actually matter; the exact SoC does not.
const IPHONES = [
  // 4 GB. Every one of these is a Kitten device.
  { id: 'iphone-x', label: 'iPhone X', ramGb: 3, geometry: '375x812', promotion: false, year: 2017 },
  { id: 'iphone-xs', label: 'iPhone XS', ramGb: 4, geometry: '375x812', promotion: false, year: 2018 },
  { id: 'iphone-xr', label: 'iPhone XR', ramGb: 3, geometry: '414x896', promotion: false, year: 2018 },
  { id: 'iphone-xs-max', label: 'iPhone XS Max', ramGb: 4, geometry: '414x896', promotion: false, year: 2018 },
  { id: 'iphone-11', label: 'iPhone 11', ramGb: 4, geometry: '414x896', promotion: false, year: 2019 },
  { id: 'iphone-11-pro', label: 'iPhone 11 Pro', ramGb: 4, geometry: '375x812', promotion: false, year: 2019 },
  { id: 'iphone-11-pro-max', label: 'iPhone 11 Pro Max', ramGb: 4, geometry: '414x896', promotion: false, year: 2019 },
  { id: 'iphone-se-2', label: 'iPhone SE (2nd generation)', ramGb: 3, geometry: '375x667', promotion: false, year: 2020 },
  { id: 'iphone-se-3', label: 'iPhone SE (3rd generation)', ramGb: 4, geometry: '375x667', promotion: false, year: 2022 },
  { id: 'iphone-12-mini', label: 'iPhone 12 mini', ramGb: 4, geometry: '375x812', promotion: false, year: 2020 },
  { id: 'iphone-12', label: 'iPhone 12', ramGb: 4, geometry: '390x844', promotion: false, year: 2020 },
  { id: 'iphone-12-pro', label: 'iPhone 12 Pro', ramGb: 6, geometry: '390x844', promotion: false, year: 2020 },
  { id: 'iphone-12-pro-max', label: 'iPhone 12 Pro Max', ramGb: 6, geometry: '428x926', promotion: false, year: 2020 },

  // The 13 family. 13 mini and 13 are 4 GB -- Kitten, not Kokoro. Their
  // published heap budget (~400 MB) sits inside Kokoro's session-build peak
  // (396-421 MB), so the middle engine is a coin flip on exactly these two.
  { id: 'iphone-13-mini', label: 'iPhone 13 mini', ramGb: 4, geometry: '375x812', promotion: false, year: 2021 },
  { id: 'iphone-13', label: 'iPhone 13', ramGb: 4, geometry: '390x844', promotion: false, year: 2021 },
  { id: 'iphone-13-pro', label: 'iPhone 13 Pro', ramGb: 6, geometry: '390x844', promotion: true, year: 2021 },
  { id: 'iphone-13-pro-max', label: 'iPhone 13 Pro Max', ramGb: 6, geometry: '428x926', promotion: true, year: 2021 },

  { id: 'iphone-14', label: 'iPhone 14', ramGb: 6, geometry: '390x844', promotion: false, year: 2022 },
  { id: 'iphone-14-plus', label: 'iPhone 14 Plus', ramGb: 6, geometry: '428x926', promotion: false, year: 2022 },
  { id: 'iphone-14-pro', label: 'iPhone 14 Pro', ramGb: 6, geometry: '393x852', promotion: true, year: 2022 },
  { id: 'iphone-14-pro-max', label: 'iPhone 14 Pro Max', ramGb: 6, geometry: '430x932', promotion: true, year: 2022 },

  // 15 Pro is the first 8 GB iPhone, which is exactly why "15 Pro and above"
  // was the right instinct for the Pocket boundary.
  { id: 'iphone-15', label: 'iPhone 15', ramGb: 6, geometry: '393x852', promotion: false, year: 2023 },
  { id: 'iphone-15-plus', label: 'iPhone 15 Plus', ramGb: 6, geometry: '430x932', promotion: false, year: 2023 },
  { id: 'iphone-15-pro', label: 'iPhone 15 Pro', ramGb: 8, geometry: '393x852', promotion: true, year: 2023 },
  { id: 'iphone-15-pro-max', label: 'iPhone 15 Pro Max', ramGb: 8, geometry: '430x932', promotion: true, year: 2023 },

  { id: 'iphone-16e', label: 'iPhone 16e', ramGb: 8, geometry: '390x844', promotion: false, year: 2025 },
  { id: 'iphone-16', label: 'iPhone 16', ramGb: 8, geometry: '393x852', promotion: false, year: 2024 },
  { id: 'iphone-16-plus', label: 'iPhone 16 Plus', ramGb: 8, geometry: '430x932', promotion: false, year: 2024 },
  { id: 'iphone-16-pro', label: 'iPhone 16 Pro', ramGb: 8, geometry: '402x874', promotion: true, year: 2024 },
  { id: 'iphone-16-pro-max', label: 'iPhone 16 Pro Max', ramGb: 8, geometry: '440x956', promotion: true, year: 2024 },

  { id: 'iphone-17e', label: 'iPhone 17e', ramGb: 8, geometry: '390x844', promotion: false, year: 2026 },
  { id: 'iphone-17', label: 'iPhone 17', ramGb: 8, geometry: '402x874', promotion: true, year: 2025 },
  { id: 'iphone-air', label: 'iPhone Air', ramGb: 12, geometry: '420x912', promotion: true, year: 2025 },
  { id: 'iphone-17-pro', label: 'iPhone 17 Pro', ramGb: 12, geometry: '402x874', promotion: true, year: 2025 },
  { id: 'iphone-17-pro-max', label: 'iPhone 17 Pro Max', ramGb: 12, geometry: '440x956', promotion: true, year: 2025 },
].map((entry) => ({ ...entry, platform: 'ios', kind: 'iphone' }));

// ── iPad ────────────────────────────────────────────────────────────────────
//
// Coarse classes, not exact models, and deliberately so. iPad Safari defaults to
// a desktop user agent, its logical sizes overlap heavily across generations,
// and per-model RAM varies by STORAGE tier on the Pro (8 GB vs 16 GB on the same
// model name). Asserting an exact figure here would be inventing precision.
//
// These exist for the picker; nothing infers an iPad automatically. The class
// sets a ceiling and the measurement still decides inside it.
const IPADS = [
  { id: 'ipad-pro-m', label: 'iPad Pro (M1 or newer)', ramGb: 8, year: 2021 },
  { id: 'ipad-air-m', label: 'iPad Air (M1 or newer)', ramGb: 8, year: 2022 },
  { id: 'ipad-mini-a17', label: 'iPad mini (A17 Pro, 2024 or newer)', ramGb: 8, year: 2024 },
  { id: 'ipad-standard-10', label: 'iPad (10th generation or newer)', ramGb: 4, year: 2022 },
  { id: 'ipad-air-a14', label: 'iPad Air (2020-2021, A14)', ramGb: 4, year: 2020 },
  { id: 'ipad-mini-6', label: 'iPad mini (6th generation, 2021)', ramGb: 4, year: 2021 },
  { id: 'ipad-older', label: 'Older iPad', ramGb: 3, year: 2019 },
].map((entry) => ({ ...entry, platform: 'ios', kind: 'ipad', geometry: '', promotion: false }));

// ── Android ─────────────────────────────────────────────────────────────────
//
// Classes, not a device list. Android needs far less of a catalogue than iOS:
// Chromium reports deviceMemory (quantised, but enough to separate 4 from 8) AND
// the real model string through Client Hints, so the ladder is rarely guessing.
// What a catalogue adds here is the RAM the quantised value CANNOT express --
// deviceMemory caps at 8, so 12 GB and 16 GB flagships all report 8 -- which
// matters for thread and worker counts rather than for the tier.
//
// Patterns are matched against the UA-CH model string (e.g. "Pixel 6 Pro",
// "SM-S918B"), never against the frozen User-Agent.
const ANDROID_CLASSES = [
  // `demotes` is the whole design here. An inferred class is a SOFT signal and
  // may only ever lower the ceiling, never raise or cap it -- because a
  // catalogue entry that understates RAM would otherwise pin a capable device
  // to a lighter engine forever (an 8 GB Pixel 8a matching a 6 GB "a-series"
  // row, say). Android already reaches the top tier on its own (deviceMemory
  // >= 8 with >= 6 cores), so inference has nothing to add upward and
  // everything to add downward: catching the budget SoCs that report eight
  // logical cores, have two fast ones, and throttle hard.
  //
  // Flagship classes are listed for the PICKER, so a reader can declare one.
  // They do not demote, so their RAM figure can never cap anybody.
  { id: 'pixel-flagship', label: 'Google Pixel (6 or newer)', ramGb: 8, demotes: false,
    test: (m) => /\bpixel\s*\d+\s*(?:pro|xl)?\b/i.test(m)
      && !/\bpixel\s*\d+a\b/i.test(m)
      && Number(m.match(/\bpixel\s*(\d+)/i)?.[1] || 0) >= 6 },
  { id: 'pixel-a', label: 'Google Pixel a-series', ramGb: 8, demotes: false,
    test: (m) => /\bpixel\s*\d+a\b/i.test(m) },
  { id: 'samsung-flagship', label: 'Samsung Galaxy S or Fold (S21 / Fold3 or newer)', ramGb: 8, demotes: false,
    test: (m) => /\b(?:sm-)?(?:s9\d{2}|s91\d|s92\d|s93\d|s94\d|f7\d\d|f9\d\d)[a-z0-9]*\b/i.test(m) },
  { id: 'oneplus-flagship', label: 'OnePlus, Oppo Find X, Xiaomi or vivo flagship', ramGb: 12, demotes: false,
    test: (m) => /\b(?:oneplus\s*\d{1,2}\b(?!\s*nord)|find\s*x|xiaomi\s*1[4-9]|vivo\s*x\d)/i.test(m) },

  // Demoting classes. These are the ones worth inferring automatically.
  { id: 'samsung-midrange', label: 'Samsung Galaxy A or M series', ramGb: 4, demotes: true,
    test: (m) => /\bsm-[amf]\d{3}/i.test(m) },
  { id: 'budget-android', label: 'Budget or older Android phone', ramGb: 4, demotes: true,
    test: (m) => /moto\s*g|redmi|poco|realme\s*[cn]|infinix|tecno|itel|nokia|blu\s|umidigi|tcl\s|oppo\s*a\d|vivo\s*y\d|oneplus\s*nord/i.test(m) },
];

const ANDROID_GENERIC = [
  { id: 'android-flagship', label: 'Recent flagship (2022 or newer, 8 GB or more)', ramGb: 8 },
  { id: 'android-midrange', label: 'Mid-range phone (6 GB)', ramGb: 6 },
  { id: 'android-budget', label: 'Budget or older phone (4 GB or less)', ramGb: 4 },
].map((entry) => ({ ...entry, platform: 'android', kind: 'android-generic', geometry: '', promotion: false, test: null, demotes: false }));

const ANDROID = ANDROID_CLASSES
  .map((entry) => ({ ...entry, platform: 'android', kind: 'android', geometry: '', promotion: false }))
  .concat(ANDROID_GENERIC);

export const DEVICE_CATALOG = Object.freeze([...IPHONES, ...IPADS, ...ANDROID]);

const BY_ID = new Map(DEVICE_CATALOG.map((entry) => [entry.id, entry]));

export function deviceById(id) {
  return BY_ID.get(String(id || '')) || null;
}

// The tier a declared or inferred model is allowed to reach. Never an answer on
// its own -- see the ceiling rule in selectNarrationEngine.
export function tierCeilingForDevice(id) {
  const entry = deviceById(id);
  return entry ? tierForRamGb(entry.ramGb) : '';
}

export function geometryKey(width, height) {
  const w = Math.round(Number(width) || 0);
  const h = Math.round(Number(height) || 0);
  if (!w || !h) return '';
  return `${Math.min(w, h)}x${Math.max(w, h)}`;
}

// Every iPhone that ships this exact logical size. Sizes are matched EXACTLY,
// never as ranges: a ">= 402 wide" rule reads naturally and is wrong, because it
// swallows the 15 Plus at 430x932.
export function iphonesForGeometry(key) {
  const wanted = String(key || '');
  if (!wanted) return [];
  return IPHONES.filter((entry) => entry.geometry === wanted);
}

// The candidate tiers a geometry could belong to, derived from the RAM of every
// model that shares it rather than hand-written per size. An unrecognised size
// opens the full ladder and lets the measurement speak.
export function tiersForGeometry(key, allTiers = ['kitten', 'kokoro', 'pocket']) {
  const models = iphonesForGeometry(key);
  if (!models.length) return { candidates: [...allTiers], models: [], note: '' };
  const tiers = models.map((entry) => tierForRamGb(entry.ramGb));
  const highest = tiers.reduce((best, tier) =>
    (allTiers.indexOf(tier) > allTiers.indexOf(best) ? tier : best), allTiers[0]);
  const lowest = tiers.reduce((worst, tier) =>
    (allTiers.indexOf(tier) < allTiers.indexOf(worst) ? tier : worst), highest);
  return {
    candidates: allTiers.slice(allTiers.indexOf(lowest), allTiers.indexOf(highest) + 1),
    models,
    note: describeModels(models),
  };
}

function describeModels(models) {
  const labels = models.map((entry) => entry.label.replace(/^iPhone /, ''));
  if (labels.length <= 1) return labels[0] ? `iPhone ${labels[0]}` : '';
  return `iPhone ${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}

// ProMotion is the one hardware difference a browser can still measure between
// two iPhones of the same size, so a confirmed 120 Hz panel can rule models out.
//
// ONLY EVER AS POSITIVE EVIDENCE. Every way this measurement can be wrong makes
// it report 60: Low Power Mode caps the display, a backgrounded tab stops
// receiving frames entirely, and a device busy running the setup benchmark drops
// them. So 120 narrows the set and 60 is treated as "we do not know".
export function refreshRateNarrows(models, refreshHz) {
  const hz = Number(refreshHz) || 0;
  if (!Array.isArray(models) || models.length < 2) return models || [];
  if (hz < 110) return models;
  const promotion = models.filter((entry) => entry.promotion === true);
  return promotion.length ? promotion : models;
}

// Resolve a UA-CH model string ("Pixel 6 Pro", "SM-S918B") to a catalogue class.
// Returns null rather than guessing: an unmatched Android device already has
// deviceMemory and hardwareConcurrency, which is more than iOS ever offers.
export function androidClassForModel(modelText) {
  const text = String(modelText || '').trim();
  if (!text) return null;
  for (const entry of ANDROID_CLASSES) {
    try {
      if (entry.test(text)) return { ...entry, platform: 'android', kind: 'android' };
    } catch (_) { /* a malformed pattern must not break detection */ }
  }
  return null;
}

// The only automatic use of the Android catalogue: a class that is known to be
// weak lowers the ceiling. Anything else returns '' and leaves the existing
// deviceMemory / core-count path exactly as it was.
export function androidInferredCeiling(modelText) {
  const hit = androidClassForModel(modelText);
  if (!hit || hit.demotes !== true) return '';
  return tierForRamGb(hit.ramGb);
}

// What the first-run picker offers, narrowed by whatever is already known so a
// reader is never asked to scroll past forty models to find theirs.
export function pickerOptions({ platform = '', geometryKey: key = '', refreshHz = 0, includeIpad = true } = {}) {
  if (platform === 'ios') {
    let iphones = iphonesForGeometry(key);
    if (iphones.length > 1) iphones = refreshRateNarrows(iphones, refreshHz);
    // An unrecognised size means a model this table has never seen, so offer
    // everything rather than an empty list.
    const phones = iphones.length ? iphones : IPHONES;
    return {
      narrowed: iphones.length > 0 && iphones.length < IPHONES.length,
      groups: [
        { label: 'iPhone', options: phones },
        ...(includeIpad ? [{ label: 'iPad', options: IPADS }] : []),
      ],
    };
  }
  if (platform === 'android') {
    return {
      narrowed: false,
      groups: [{ label: 'Android', options: ANDROID }],
    };
  }
  return { narrowed: false, groups: [] };
}
