// Shared device-local policy for Pocket TTS backend selection.

export const POCKET_ORT_VERSION = '1.27.0';
export const POCKET_CALIBRATION_VERSION = 'cal-v12';
export const POCKET_ACCELERATION_VERSION = 'accel-v5';
// Mobile auto defaults to threaded WASM (Pixel 6 Pro field path: WASM x4).
// The tiny FP16 compute probe and optimistic auto-start were selecting WebGPU
// on Tensor flagships where full TTS WebGPU lost to 4-thread WASM; demotion
// only helped after a slow session. WebGPU remains Settings opt-in after a
// full device-local optimization run. Keep the candidate helpers and demotion
// rails so a measured win can still stick when the user opts in.
export const POCKET_MOBILE_OPTIMISTIC_WEBGPU = false;
// Bump to retire sticky demotions recorded under an older runtime/policy.
export const POCKET_DEMOTION_EPOCH = 'e3';
export const POCKET_WASM_MODEL_REVISION = 'english-2026-04-int8-r1';
export const POCKET_WEBGPU_MODEL_REVISION = 'english-2026-04-fp16-r3';
export const POCKET_WEBGPU_BUNDLE = 'english_2026-04-webgpu-fp16-r3';
export const POCKET_GPU_RESIDENT_STATE_BYTES = 65_645_212;
export const POCKET_BACKEND_VALUES = Object.freeze(['auto', 'wasm', 'webgpu']);
export const POCKET_IOS_WEBGPU_MIN_GENERATION = 14;
export const POCKET_IOS_WEBGPU_MIN_RAM_GB = 6;

const STORAGE_PREFIX = 'pr_pocket_backend_calibration:';
const DEMOTION_PREFIX = 'pr_pocket_webgpu_demotion:';
export const POCKET_DEVICE_CAPABILITY_KEY = 'pr_pocket_device_capability_v1';
export const POCKET_EXPRESSIVE_CHOICE_KEY = 'pr_expressive_prosody_choice_v1';
export const POCKET_DEVICE_SETUP_KEY = 'pr_device_setup_v2';
export const POCKET_DEVICE_BACKEND_PREFERENCE_KEY = 'pr_device_backend_preference_v1';
const GPU_ALLOCATION_PROBE_BYTES = 16 * 1024 * 1024;
const IOS_GPU_ALLOCATION_PROBE_BYTES = 64 * 1024 * 1024;

// Positively identified iPhones at the 6 GB support floor. The 13 Pro pair
// qualifies; the base 13, 13 mini, and SE 3 remain below the floor.
const IPHONE_WEBGPU_ALLOW_IDS = new Set([
  'iphone14,2', 'iphone14,3', // iPhone 13 Pro / iPhone 13 Pro Max
  'iphone14,7', 'iphone14,8', // iPhone 14 / 14 Plus
  'iphone15,2', 'iphone15,3', // iPhone 14 Pro / 14 Pro Max
  'iphone15,4', 'iphone15,5', // iPhone 15 / 15 Plus
  'iphone16,1', 'iphone16,2', // iPhone 15 Pro / 15 Pro Max
  'iphone17,1', 'iphone17,2', 'iphone17,3', 'iphone17,4', // iPhone 16 family
  'iphone18,1', 'iphone18,2', 'iphone18,3', 'iphone18,4', // iPhone 17 family
]);
const IPHONE_WEBGPU_BLOCK_IDS = new Set([
  'iphone14,4', 'iphone14,5', // iPhone 13 mini / iPhone 13
  'iphone14,6', // iPhone SE (3rd gen)
]);

export function normalizePocketBackend(value) {
  return POCKET_BACKEND_VALUES.includes(value) ? value : 'auto';
}

// Classify the device family from the user agent. Thread scaling depends on the
// performance-core count, which the browser never exposes directly, so we lean
// on platform heuristics: iOS clamps hardwareConcurrency to 4 regardless of the
// real core count, and Apple A-series chips always ship exactly 2 performance
// cores.
// iPadOS 13+ Safari sends a desktop "Macintosh; Intel Mac OS X" user agent by
// default, so a bare UA regex classifies a stock iPad as 'desktop'. That is not
// cosmetic: 'desktop' unlocks WebGPU, the +84MB fifth decode-block model, full
// story voice prefetch, and skips both the 2-thread WASM clamp and memory-safe
// inference — the exact configuration that OOM-killed an iPhone 13 (see the
// field-crash note in pocket_worker.js). An iPad runs the same WebKit per-tab
// memory budget, so it must resolve to 'ios'.
//
// navigator.platform + maxTouchPoints is the only reliable way to separate an
// iPad from a real Mac: desktop Safari reports maxTouchPoints 0, iPadOS reports
// 5. Signals may be passed explicitly because WorkerNavigator exposes no
// maxTouchPoints — the main thread resolves the platform once and hands it to
// the worker rather than letting the worker re-sniff and get it wrong.
export function isIpadOsDesktopUa(signals = {}) {
  const nav = globalThis.navigator;
  const platformId = String(signals.platform ?? nav?.platform ?? '');
  const touchPoints = Number(signals.maxTouchPoints ?? nav?.maxTouchPoints ?? 0);
  return /^Mac/i.test(platformId) && touchPoints > 1;
}

export function detectMobilePlatform(userAgent = globalThis.navigator?.userAgent || '', signals = {}) {
  const ua = String(userAgent);
  if (signals.platformOverride) return signals.platformOverride;
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  // Only consider the touch heuristic for a Mac-family UA; every other UA is
  // already classified correctly by the string itself.
  if (/Macintosh|Mac OS X/i.test(ua) && isIpadOsDesktopUa(signals)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Mobi|Mobile|Fennec|Windows Phone/i.test(ua)) return 'mobile';
  return 'desktop';
}

// Shared predicates so callers stop hand-rolling UA regexes that miss iPad.
export function isIosLikePlatform(userAgent = globalThis.navigator?.userAgent || '', signals = {}) {
  return detectMobilePlatform(userAgent, signals) === 'ios';
}

export function isMobileLikePlatform(userAgent = globalThis.navigator?.userAgent || '', signals = {}) {
  return detectMobilePlatform(userAgent, signals) !== 'desktop';
}

// Memory classification is intentionally conservative and privacy-preserving.
// Browser values are treated as coarse evidence only; no attempt is made to
// reconstruct exact RAM or a unique device fingerprint from combined signals.
export function classifyPocketDeviceCapability(options = {}) {
  const userAgent = String(options.userAgent || '');
  const platform = options.platform || detectMobilePlatform(userAgent);
  const deviceMemoryGb = Number(options.deviceMemory || options.memoryGb || 0);
  const hardwareConcurrency = Math.max(0, Number(options.hardwareConcurrency || 0));
  const model = String(options.model || options.iosModel || '').trim();
  const saveData = options.saveData === true;
  const lowMemoryMode = options.lowMemoryMode === true;
  const reasons = [];
  let positiveHighMemoryEvidence = false;

  if (saveData) reasons.push('data-saver');
  if (lowMemoryMode) reasons.push('low-memory-mode');

  if (platform === 'ios') {
    // Do not use screen dimensions here. Safari deliberately buckets several
    // hardware signals, and an ambiguous iPhone must remain constrained.
    const iphone = evaluateIphoneWebGpuEligibility({ userAgent, iosModel: model });
    positiveHighMemoryEvidence = iphone.eligible === true && iphone.estimatedRamGb >= 6;
    if (!positiveHighMemoryEvidence) reasons.push(iphone.generation > 0 ? 'iphone-below-6gb-floor' : 'iphone-unidentified');
  } else if (platform === 'android' || platform === 'mobile') {
    positiveHighMemoryEvidence = deviceMemoryGb > 4 && !isBudgetAndroidUA(`${userAgent} ${model}`);
    if (deviceMemoryGb > 0 && deviceMemoryGb <= 4) reasons.push('device-memory-4gb-or-less');
    else if (!positiveHighMemoryEvidence) reasons.push('mobile-high-memory-unconfirmed');
    if (isBudgetAndroidUA(`${userAgent} ${model}`)) reasons.push('budget-android-model');
  } else {
    // Desktop browsers often omit deviceMemory. They retain the existing
    // enabled default unless the user explicitly selects a low-data mode.
    positiveHighMemoryEvidence = deviceMemoryGb > 4 || deviceMemoryGb === 0;
    if (deviceMemoryGb > 0 && deviceMemoryGb <= 4) reasons.push('device-memory-4gb-or-less');
  }

  const constrained = saveData || lowMemoryMode || !positiveHighMemoryEvidence;
  return {
    version: 1,
    platform,
    model,
    platformVersion: String(options.platformVersion || ''),
    deviceMemoryGb,
    hardwareConcurrency,
    saveData,
    lowMemoryMode,
    positiveHighMemoryEvidence,
    constrained,
    // Expressive narration and memory safety are separate decisions. A
    // supported iPhone can keep prosody while still using the bounded iOS
    // lifecycle because WebKit exposes no reliable live-memory headroom.
    memorySafeInference: platform === 'ios' || constrained,
    defaultExpressiveProsody: !constrained,
    fullStoryVoicePrefetch: platform !== 'ios' && !constrained,
    reasons: [...new Set(reasons)],
  };
}

export function readPocketDeviceSetup(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage?.getItem(POCKET_DEVICE_SETUP_KEY) || 'null');
    if (!(value?.version === 2 && value?.completedAt)) return null;
    // Retire first-run records that recommended WebGPU on mobile before the
    // WASM-default policy. Keep the measured wasmThreads (x4 on Pixel 6 Pro).
    const platform = value.capability?.platform || detectMobilePlatform(value.capability?.userAgent || '');
    if (value.recommendedBackend === 'webgpu' && platform && platform !== 'desktop') {
      return {
        ...value,
        recommendedBackend: 'wasm',
        webgpuEligible: false,
        reason: 'Mobile auto defaults to threaded WASM.',
      };
    }
    return value;
  } catch (_) {
    return null;
  }
}

export function writePocketDeviceSetup(storage = globalThis.localStorage, result = {}) {
  try {
    const record = { ...result, version: 2, completedAt: Number(result.completedAt) || Date.now() };
    storage?.setItem(POCKET_DEVICE_SETUP_KEY, JSON.stringify(record));
    return record;
  } catch (_) {
    return null;
  }
}

export function readPocketDeviceBackendPreference(storage = globalThis.localStorage) {
  try {
    return normalizePocketBackend(storage?.getItem(POCKET_DEVICE_BACKEND_PREFERENCE_KEY));
  } catch (_) {
    return 'auto';
  }
}

export function writePocketDeviceBackendPreference(storage = globalThis.localStorage, preference = 'auto') {
  try {
    const normalized = normalizePocketBackend(preference);
    storage?.setItem(POCKET_DEVICE_BACKEND_PREFERENCE_KEY, normalized);
    return normalized;
  } catch (_) {
    return 'auto';
  }
}

function androidPlatformFloor(modelText = '') {
  const text = String(modelText).toLowerCase();
  const pixel = text.match(/\bpixel\s*(\d+)/i);
  if (pixel && Number(pixel[1]) >= 6) return { supported: true, family: 'Google Tensor (Pixel 6+)' };
  if (/\b(?:sm-g99\d|sm-s901|sm-s906|sm-s908|sm-s91\d|sm-s92\d|sm-s93\d|sm-f7\d\d|sm-f9\d\d)[a-z0-9]*\b/i.test(text)) {
    return { supported: true, family: 'Samsung flagship (Galaxy S21 / Fold3 generation+)' };
  }
  if (/\b(?:snapdragon\s*(?:888|8\s*gen\s*[1-9]|8\+\s*gen\s*1)|sm8350|sm8450|sm8475|sm8550|sm8635|sm8650|sm8735|sm8750)\b/i.test(text)) {
    return { supported: true, family: 'Qualcomm Snapdragon 888 / 8-series generation+' };
  }
  if (/\bexynos\s*(?:2100|2200|2300|2400|2500|2[6-9]\d{2}|[3-9]\d{3})\b/i.test(text)) {
    return { supported: true, family: 'Samsung Exynos 2100 generation+' };
  }
  if (/\bdimensity\s*(?:9\d{3}|[1-9]\d{4,})\b/i.test(text)) {
    return { supported: true, family: 'MediaTek Dimensity 9000 generation+' };
  }
  return { supported: false, family: '' };
}

// This is a soft support floor, never a feature lock. Optional Android model
// hints can be absent, so an unidentified 8 GB device may qualify through its
// local benchmark while remaining labelled benchmark-qualified.
export function classifyPocketDeviceSupport(options = {}) {
  const userAgent = String(options.userAgent || '');
  const platform = options.platform || detectMobilePlatform(userAgent);
  const model = String(options.model || options.iosModel || '');
  const memoryGb = Number(options.deviceMemory ?? options.memoryGb ?? 0);
  const benchmarkPassed = options.benchmarkPassed === true;

  if (platform === 'desktop') {
    return { status: 'supported', officiallySupported: true, benchmarkQualified: false, family: 'Desktop', awayModeRecommended: false, reason: '' };
  }
  if (platform === 'ios') {
    const iphone = evaluateIphoneWebGpuEligibility({ userAgent, iosModel: model });
    const supported = iphone.eligible === true && iphone.estimatedRamGb >= 6;
    return {
      status: supported ? 'supported' : (iphone.generation > 0 ? 'below-floor' : 'unverified'),
      officiallySupported: supported,
      benchmarkQualified: false,
      family: supported ? 'iPhone 13 Pro generation or newer (6 GB+)' : '',
      awayModeRecommended: !supported,
      reason: supported ? '' : (iphone.reason || 'This iPhone could not be positively identified at the 6 GB support floor.'),
    };
  }

  const android = androidPlatformFloor(`${userAgent} ${model}`);
  if (android.supported) {
    return { status: 'supported', officiallySupported: true, benchmarkQualified: false, family: android.family, awayModeRecommended: false, reason: '' };
  }
  if (memoryGb >= 8 && benchmarkPassed) {
    return {
      status: 'benchmark-qualified', officiallySupported: false, benchmarkQualified: true,
      family: 'Unidentified high-memory Android', awayModeRecommended: false,
      reason: 'The model was hidden by the browser; local diagnostics passed the performance floor.',
    };
  }
  return {
    status: memoryGb > 0 && memoryGb <= 4 ? 'below-floor' : 'unverified',
    officiallySupported: false,
    benchmarkQualified: false,
    family: '',
    awayModeRecommended: true,
    reason: memoryGb > 0 && memoryGb <= 4
      ? 'This Android device reports 4 GB of memory or less.'
      : 'The browser did not expose a supported flagship model or enough benchmark evidence.',
  };
}

export function selectPocketDeviceSetup(options = {}) {
  const capability = options.capability || {};
  const support = options.support || {};
  const cpuResults = Array.isArray(options.cpuResults) ? options.cpuResults : [];
  const threadedWasmAvailable = options.simulateThreadedWasm === true
    || options.crossOriginIsolated === true;
  const allowedThreads = wasmThreadCandidates({
    crossOriginIsolated: threadedWasmAvailable,
    hardwareConcurrency: capability.hardwareConcurrency,
    platform: capability.platform,
    userAgent: options.userAgent,
    lowMemoryMode: capability.lowMemoryMode,
  });
  const validCpu = cpuResults.filter((result) => allowedThreads.includes(Number(result?.threads)));
  const selectedCpu = selectCalibratedThreadCount(validCpu);
  let wasmThreads = allowedThreads.includes(selectedCpu.threads)
    ? selectedCpu.threads
    : recommendedWasmThreadCount({
        crossOriginIsolated: threadedWasmAvailable,
        hardwareConcurrency: capability.hardwareConcurrency,
        platform: capability.platform,
        userAgent: options.userAgent,
        memoryGb: capability.deviceMemoryGb,
        lowMemoryMode: capability.lowMemoryMode,
        saveData: capability.saveData,
      });
  if (capability.platform === 'ios') wasmThreads = Math.min(2, wasmThreads);

  const gpu = options.webgpu || {};
  const gpuFastEnough = gpu.supported === true
    && Number.isFinite(Number(gpu.medianMs))
    && Number(gpu.medianMs) <= 120
    && gpu.interrupted !== true;
  // Desktop may still recommend WebGPU from the tiny FP16 probe. Mobile
  // (including Pixel 6 Pro / Tensor flagships) always defaults to threaded
  // WASM — the probe does not predict full TTS WebGPU vs WASM x4.
  const useWebGpu = capability.platform === 'desktop'
    && capability.constrained !== true
    && gpuFastEnough;

  return {
    recommendedBackend: useWebGpu ? 'webgpu' : 'wasm',
    wasmThreads: Math.max(1, wasmThreads || 1),
    webgpuEligible: useWebGpu,
    reason: useWebGpu
      ? 'The local FP16 compute probe passed the stability and latency floor.'
      : (capability.platform && capability.platform !== 'desktop'
        ? 'Mobile auto defaults to threaded WASM.'
        : (gpu.reason || 'Threaded WASM is the safer result for this device.')),
  };
}

export function readPocketExpressiveChoice(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem(POCKET_EXPRESSIVE_CHOICE_KEY);
    return value === 'enabled' || value === 'disabled' ? value : null;
  } catch (_) {
    return null;
  }
}

export function writePocketExpressiveChoice(storage = globalThis.localStorage, choice) {
  if (choice !== 'enabled' && choice !== 'disabled') return false;
  try {
    storage?.setItem(POCKET_EXPRESSIVE_CHOICE_KEY, choice);
    return true;
  } catch (_) {
    return false;
  }
}

export function resolvePocketExpressiveProsody(options = {}) {
  const choice = options.choice || readPocketExpressiveChoice(options.storage);
  if (choice === 'enabled') return true;
  if (choice === 'disabled') return false;
  return options.capability?.defaultExpressiveProsody !== false;
}

const POCKET_WEBGPU_LIMIT_NAMES = [
  'maxBufferSize', 'maxStorageBufferBindingSize', 'maxUniformBufferBindingSize',
  'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup',
  'maxComputeWorkgroupsPerDimension', 'maxBindGroups', 'maxBindingsPerBindGroup',
];

function safeAdapterInfo(adapter) {
  const info = adapter?.info || {};
  const limits = {};
  for (const name of POCKET_WEBGPU_LIMIT_NAMES) {
    const value = adapter?.limits?.[name];
    if (typeof value === 'number' || typeof value === 'bigint') limits[name] = Number(value);
  }
  return {
    vendor: String(info.vendor || ''),
    architecture: String(info.architecture || ''),
    description: String(info.description || ''),
    isFallbackAdapter: adapter?.isFallbackAdapter === true,
    features: [...(adapter?.features || [])].map(String).sort(),
    limits,
  };
}

export async function collectPocketDeviceCapability(options = {}) {
  const nav = options.navigator || globalThis.navigator || {};
  let highEntropy = {};
  try {
    highEntropy = await nav.userAgentData?.getHighEntropyValues?.(['model', 'platformVersion']) || {};
  } catch (_) {}

  let webgpu = null;
  try {
    const adapter = await nav.gpu?.requestAdapter?.({ powerPreference: 'low-power' });
    if (adapter) webgpu = safeAdapterInfo(adapter);
  } catch (_) {}

  const capability = classifyPocketDeviceCapability({
    userAgent: options.userAgent || nav.userAgent || '',
    platform: options.platform,
    model: options.model || highEntropy.model || '',
    platformVersion: options.platformVersion || highEntropy.platformVersion || '',
    deviceMemory: options.deviceMemory ?? nav.deviceMemory,
    hardwareConcurrency: options.hardwareConcurrency ?? nav.hardwareConcurrency,
    saveData: options.saveData ?? nav.connection?.saveData,
    lowMemoryMode: options.lowMemoryMode,
  });
  let previous = {};
  try { previous = JSON.parse((options.storage || globalThis.localStorage)?.getItem(POCKET_DEVICE_CAPABILITY_KEY) || 'null') || {}; } catch (_) {}
  const record = { ...previous, ...capability, webgpu, probedAt: Date.now() };
  try { (options.storage || globalThis.localStorage)?.setItem(POCKET_DEVICE_CAPABILITY_KEY, JSON.stringify(record)); } catch (_) {}
  return record;
}

export function recordPocketTtsCalibration(storage = globalThis.localStorage, sample = {}) {
  try {
    const previous = JSON.parse(storage?.getItem(POCKET_DEVICE_CAPABILITY_KEY) || 'null') || {};
    const next = {
      ...previous,
      ttsCalibration: {
        initializationSucceeded: sample.initializationSucceeded === true,
        initializationMs: Math.max(0, Number(sample.initializationMs || 0)),
        realTimeFactor: Number.isFinite(Number(sample.realTimeFactor)) ? Number(sample.realTimeFactor) : null,
        interrupted: sample.interrupted === true,
        sampledAt: Date.now(),
      },
    };
    storage?.setItem(POCKET_DEVICE_CAPABILITY_KEY, JSON.stringify(next));
    return next;
  } catch (_) {
    return null;
  }
}

function isMobilePlatform(options) {
  if (options.mobile === true) return true;
  const platform = options.platform || detectMobilePlatform(options.userAgent);
  return platform === 'ios' || platform === 'android' || platform === 'mobile';
}

export function wasmThreadCandidates(options = {}) {
  if (options.crossOriginIsolated !== true || options.lowMemoryMode) return [1];
  const cores = Math.max(0, Number(options.hardwareConcurrency || 0));
  const mobile = isMobilePlatform(options);
  // Cap mobile at 4 threads: on big.LITTLE SoCs that maps onto the performance
  // cores (e.g. Pixel 6 Pro's 2xX1 + 2xA76) without spilling onto the little
  // cores, which regresses the autoregressive loop.
  const maximum = cores > 0 ? Math.min(mobile ? 4 : 6, cores) : (mobile ? 2 : 4);
  const candidates = [1];
  if (maximum >= 2) candidates.push(2);
  if (maximum >= 4) candidates.push(4);
  if (maximum >= 6 && !mobile) candidates.push(6);
  return candidates;
}

export function recommendedWasmThreadCount(options = {}) {
  const candidates = wasmThreadCandidates(options);
  const largest = candidates[candidates.length - 1];
  const platform = options.platform || detectMobilePlatform(options.userAgent);

  if (platform === 'ios') {
    // iOS reports a constant hardwareConcurrency of 4 for anti-fingerprinting,
    // but every modern iPhone has exactly 2 performance cores. Extra WASM
    // threads land on the E-cores and stall ORT's per-layer barrier, so cap at 2.
    return Math.min(2, largest);
  }

  if (options.mobile === true || platform === 'android' || platform === 'mobile') {
    const memoryGb = Number(options.memoryGb || options.deviceMemory || 0);
    // Budget Androids (e.g. Dimensity 7020: 2xA78 + 6xA55) report 8 logical
    // cores but only have 2 performance cores and throttle hard. Data Saver and
    // low reported memory are the only signals we get, so cap those at 2.
    if (options.saveData === true || (memoryGb > 0 && memoryGb <= 4)) return Math.min(2, largest);
    // Field data (Pixel 6 Pro, 8 cores, isolated): 4 WASM threads generate a
    // sentence chunk in ~4s vs ~21s single-threaded. Flagships with 4 big cores
    // (Pixel 6 Pro, Galaxy S21) take the largest candidate.
    return largest;
  }

  return candidates.includes(2) ? 2 : largest;
}

// Two complete Pocket inference workers cost roughly 1.4-1.9 GiB of browser
// private memory in our production benchmark, so parallel story caching is a
// desktop-only opt-in selected from positive coarse evidence. Browsers cap and
// round deviceMemory; 8 GiB is therefore the strongest portable signal we can
// require without attempting to fingerprint exact RAM.
export function recommendedPocketCacheWorkerCount(options = {}) {
  const platform = options.platform || detectMobilePlatform(options.userAgent || '');
  const memoryGb = Number(options.deviceMemory ?? options.memoryGb ?? 0);
  const hardwareConcurrency = Math.max(0, Number(options.hardwareConcurrency || 0));
  const wasmThreads = Math.max(1, Number(options.wasmThreads || options.threadCount || 1));
  const batteryLevel = Number(options.batteryLevel);
  const batteryKnown = Number.isFinite(batteryLevel) && batteryLevel >= 0;
  const batteryTooLow = options.lowBattery === true || (
    batteryKnown && options.batteryCharging === false && batteryLevel < 0.5
  );

  if (options.throughputMode !== true) return 1;
  if (String(options.backend || 'wasm') !== 'wasm') return 1;
  if (platform !== 'desktop') return 1;
  if (options.constrained !== false) return 1;
  if (options.crossOriginIsolated !== true) return 1;
  if (options.saveData === true || options.lowMemoryMode === true || batteryTooLow) return 1;
  if (memoryGb < 8) return 1;
  if (hardwareConcurrency < Math.max(8, wasmThreads * 2)) return 1;
  return 2;
}

function isBudgetAndroidUA(userAgent = '') {
  const ua = String(userAgent).toLowerCase();
  return /moto\s*g|galaxy\s*a\d|galaxy\s*m\d|galaxy\s*f\d|galaxy\s*xcover|sm-a\d|sm-m\d|sm-f\d|pixel\s*\d+a\b|redmi|xiaomi\s*1[0-3]|poco\s*[a-z]?\d|nokia|tracfone|blu\s|umidigi|tcl\s|cricket|spark\s|cph2\d{3}|oneplus\s*nord|realme\s*[cn]|oppo\s*a\d|vivo\s*y\d|infinix|tecno|itel\s|mediatek|dimensity\s*[67]|helio/i.test(ua);
}

function demotionStorageKey(context = {}) {
  // Sticky and adapter-independent so demotion can be read before any WebGPU probe.
  // The epoch segment intentionally orphans demotions recorded under older
  // policies/runtimes, granting each device one fresh attempt per epoch.
  const browserMajor = Number(context.browserMajor || 0);
  const isolated = context.isolated === true ? 'isolated' : 'not-isolated';
  const platform = context.platform || detectMobilePlatform(context.userAgent);
  return `${DEMOTION_PREFIX}sticky-${POCKET_DEMOTION_EPOCH}:${POCKET_CALIBRATION_VERSION}:${browserMajor}:${isolated}:${platform}`;
}

export function readWebGpuDemotion(storage, context) {
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(demotionStorageKey(context)) || 'null');
    if (!parsed?.demotedFromWebGpu) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

export function writeWebGpuDemotion(storage, context, reason = '') {
  if (!storage) return false;
  try {
    storage.setItem(demotionStorageKey(context), JSON.stringify({
      demotedFromWebGpu: true,
      reason: String(reason || ''),
      savedAt: Date.now(),
      calibrationVersion: POCKET_CALIBRATION_VERSION,
    }));
    return true;
  } catch (_) {
    return false;
  }
}

export function clearWebGpuDemotion(storage, context) {
  if (!storage) return false;
  try {
    storage.removeItem(demotionStorageKey(context));
    return true;
  } catch (_) {
    return false;
  }
}

function parseIphoneHardwareId(text = '') {
  const match = String(text).match(/iphone(\d+),(\d+)/i);
  if (!match) return null;
  return `iphone${match[1]},${match[2]}`.toLowerCase();
}

function parseIphoneMarketingGeneration(text = '') {
  const match = String(text).match(/iphone\s*(1[4-9]|[2-9]\d)\b/i);
  return match ? Number(match[1]) : 0;
}

// Safari rarely exposes the marketing model. Prefer an injected/native hardware
// ID or an explicit marketing hint and fail closed when the browser withholds
// both; screen dimensions are deliberately not used as a fingerprint.
export function evaluateIphoneWebGpuEligibility(options = {}) {
  const ua = String(options.userAgent || '');
  const modelHint = String(options.iosModel || options.model || '');
  const combined = `${ua} ${modelHint}`;
  const hardwareId = parseIphoneHardwareId(combined);
  if (hardwareId && IPHONE_WEBGPU_BLOCK_IDS.has(hardwareId)) {
    return { eligible: false, reason: 'This iPhone is below the 6 GB support floor.', generation: 13, estimatedRamGb: 4, hardwareId };
  }
  if (hardwareId && IPHONE_WEBGPU_ALLOW_IDS.has(hardwareId)) {
    const generation = hardwareId === 'iphone14,2' || hardwareId === 'iphone14,3'
      ? 13
      : POCKET_IOS_WEBGPU_MIN_GENERATION;
    return { eligible: true, reason: '', generation, estimatedRamGb: POCKET_IOS_WEBGPU_MIN_RAM_GB, hardwareId };
  }
  if (hardwareId) {
    const major = Number(hardwareId.match(/^iphone(\d+)/i)?.[1] || 0);
    // Future identifiers: iPhone19,* and above are newer than 17.
    if (major >= 19) {
      return { eligible: true, reason: '', generation: major, estimatedRamGb: POCKET_IOS_WEBGPU_MIN_RAM_GB, hardwareId };
    }
    if (major > 0 && major <= 14 && !IPHONE_WEBGPU_ALLOW_IDS.has(hardwareId)) {
      return { eligible: false, reason: 'This iPhone is below the 6 GB support floor.', generation: 13, estimatedRamGb: 4, hardwareId };
    }
  }

  if (/iphone\s*13\s*pro(?:\s*max)?\b/i.test(combined)) {
    return { eligible: true, reason: '', generation: 13, estimatedRamGb: 6, hardwareId };
  }
  const marketing = parseIphoneMarketingGeneration(combined);
  if (marketing > 0 && marketing < POCKET_IOS_WEBGPU_MIN_GENERATION) {
    return { eligible: false, reason: 'This iPhone is below the 6 GB support floor.', generation: marketing, estimatedRamGb: 4, hardwareId };
  }
  if (marketing >= POCKET_IOS_WEBGPU_MIN_GENERATION) {
    return { eligible: true, reason: '', generation: marketing, estimatedRamGb: POCKET_IOS_WEBGPU_MIN_RAM_GB, hardwareId };
  }

  return {
    eligible: false,
    reason: 'This iPhone could not be confirmed as iPhone 13 Pro or newer with 6 GB+ RAM; using the conservative profile.',
    generation: 0,
    estimatedRamGb: 0,
    hardwareId,
  };
}

export function isMobileWebGpuOptimisticCandidate(options = {}) {
  if (!isMobilePlatform(options)) return false;
  if (options.lowMemoryMode || options.saveData) return false;
  if (options.demotedFromWebGpu === true) return false;
  const memoryGb = Number(options.memoryGb || options.deviceMemory || 0);
  if (memoryGb > 0 && memoryGb <= 4) return false;
  const platform = options.platform || detectMobilePlatform(options.userAgent);
  if (platform === 'ios') {
    // ONNX Runtime Web's WebGPU execution provider is not supported by iOS
    // browsers. iPhone generation remains useful for memory classification,
    // but never makes an iOS browser a WebGPU candidate.
    return false;
  }
  if (platform === 'android' || platform === 'mobile') {
    if (isBudgetAndroidUA(options.userAgent)) return false;
    const threads = recommendedWasmThreadCount({
      crossOriginIsolated: options.crossOriginIsolated,
      hardwareConcurrency: options.hardwareConcurrency,
      userAgent: options.userAgent,
      saveData: options.saveData,
      memoryGb,
      lowMemoryMode: options.lowMemoryMode,
    });
    // Flagship Android (4 perf cores) only. Budget SoCs stay on threaded WASM.
    return threads >= 4;
  }
  return false;
}

export function buildOptimisticWebGpuCalibration(options = {}) {
  return {
    calibrationVersion: POCKET_CALIBRATION_VERSION,
    selectedBackend: 'webgpu',
    optimistic: true,
    threadCount: Number(options.threadCount) || 1,
    graphCapture: false,
    mimiProvider: 'wasm-threaded',
    gpuSyncGroupBlocks: 4,
    rejectionReason: '',
    savedAt: Date.now(),
  };
}

// Modeled WASM real-time factor for parity demotion. Anchored to the Pixel 6 Pro
// field measurement and scaled by platform thread count / single-core throughput.
export function estimateWasmRealTimeFactor(options = {}) {
  const MS_PER_FRAME_AUDIO = 80;
  const ANCHOR_MS_PER_FRAME_1T = 165;
  const platform = options.platform || detectMobilePlatform(options.userAgent);
  const threadOptions = {
    crossOriginIsolated: options.crossOriginIsolated !== false,
    hardwareConcurrency: Number(options.hardwareConcurrency || 0),
    userAgent: options.userAgent,
    saveData: options.saveData,
    memoryGb: Number(options.memoryGb || options.deviceMemory || 0),
    lowMemoryMode: options.lowMemoryMode,
    mobile: isMobilePlatform(options),
  };
  const threads = Number(options.threads) || recommendedWasmThreadCount(threadOptions);
  const perfCores = platform === 'ios' ? 2 : (threads >= 4 ? 4 : 2);
  let relSingleCore = 1.0;
  if (platform === 'ios') relSingleCore = 1.35;
  else if (threads < 4) relSingleCore = 0.55;
  const effectiveSpeedup = (count) => {
    if (count <= perfCores) return count * 0.85 + 0.15;
    return (perfCores * 0.85 + 0.15) * 0.8;
  };
  const msPerFrame = (ANCHOR_MS_PER_FRAME_1T / relSingleCore) / effectiveSpeedup(threads);
  return msPerFrame / MS_PER_FRAME_AUDIO;
}

export function shouldPreferOptimisticWebGpu(options = {}) {
  // Optimistic mobile WebGPU auto-start is off (POCKET_MOBILE_OPTIMISTIC_WEBGPU).
  // Candidate helpers remain for diagnostics and Settings opt-in flows.
  if (POCKET_MOBILE_OPTIMISTIC_WEBGPU !== true) return false;
  if (options.preference !== 'auto') return false;
  if (options.eligible !== true) return false;
  if (options.calibration) return false;
  if (options.demotedFromWebGpu === true) return false;
  return isMobileWebGpuOptimisticCandidate(options);
}

export function resolveWasmReferenceRtf(options = {}) {
  const measured = Number(options.measuredWasmRtf ?? options.calibration?.measuredWasmRtf);
  if (Number.isFinite(measured) && measured > 0) return measured;
  return estimateWasmRealTimeFactor(options);
}

export function selectCalibratedThreadCount(results = []) {
  const valid = results.filter((result) => (
    Number.isInteger(result?.threads)
    && result.threads > 0
    && Number.isFinite(result.medianMs)
    && Number.isFinite(result.p95Ms)
    && !result.failures
  ));
  if (!valid.length) return { threads: 1, reason: 'No valid WASM thread calibration result.' };
  valid.sort((left, right) => left.medianMs - right.medianMs || left.p95Ms - right.p95Ms);
  const fastest = valid[0];
  const nearFastest = valid.filter((result) => result.medianMs <= fastest.medianMs * 1.10);
  const selected = nearFastest.sort((left, right) => left.p95Ms - right.p95Ms || left.threads - right.threads)[0] || fastest;
  return { threads: selected.threads, reason: '', medianMs: selected.medianMs, p95Ms: selected.p95Ms };
}

export function browserMajorVersion(userAgent = globalThis.navigator?.userAgent || '') {
  const match = String(userAgent).match(/(?:Chrome|CriOS|Edg|Firefox|FxiOS|Version)\/(\d+)/i);
  return match ? Number(match[1]) : 0;
}

export function adapterIdentity(info = {}) {
  return [info.vendor, info.architecture, info.device, info.description]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join('|') || 'unknown-adapter';
}

export function calibrationStorageKey(context = {}) {
  const identity = context.adapterIdentity || 'unknown-adapter';
  const browserMajor = Number(context.browserMajor || 0);
  const isolated = context.isolated === true ? 'isolated' : 'not-isolated';
  return `${STORAGE_PREFIX}${POCKET_CALIBRATION_VERSION}:${POCKET_ORT_VERSION}:${POCKET_WEBGPU_MODEL_REVISION}:${browserMajor}:${isolated}:${identity}`;
}

export function readPocketCalibration(storage, context) {
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(calibrationStorageKey(context)) || 'null');
    if (!parsed || parsed.calibrationVersion !== POCKET_CALIBRATION_VERSION) return null;
    if (!['wasm', 'webgpu'].includes(parsed.selectedBackend)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

export function writePocketCalibration(storage, context, result) {
  if (!storage || !result) return false;
  const record = {
    ...result,
    calibrationVersion: POCKET_CALIBRATION_VERSION,
    ortVersion: POCKET_ORT_VERSION,
    webgpuModelRevision: POCKET_WEBGPU_MODEL_REVISION,
    savedAt: Date.now(),
  };
  try {
    storage.setItem(calibrationStorageKey(context), JSON.stringify(record));
    return true;
  } catch (_) {
    return false;
  }
}

export function clearPocketCalibrations(storage) {
  if (!storage) return 0;
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
  }
  keys.forEach((key) => storage.removeItem(key));
  return keys.length;
}

export async function probePocketWebGpuEligibility(options = {}) {
  const nav = options.navigator || globalThis.navigator;
  const isolated = options.crossOriginIsolated ?? globalThis.crossOriginIsolated === true;
  const secure = options.isSecureContext ?? globalThis.isSecureContext === true;
  const cores = Number(nav?.hardwareConcurrency || options.hardwareConcurrency || 0);
  const memoryGb = Number(options.memoryGb || nav?.deviceMemory || 0);
  const userAgent = options.userAgent || nav?.userAgent || '';
  const platform = options.platform || detectMobilePlatform(userAgent);
  const screenWidth = Number(options.screenWidth || globalThis.screen?.width || 0);
  const screenHeight = Number(options.screenHeight || globalThis.screen?.height || 0);

  if (options.demotedFromWebGpu === true) {
    return {
      eligible: false,
      reason: options.demotionReason || 'WebGPU was demoted on this device after failing to beat WASM.',
      cores,
      memoryGb,
      isolated,
      demotedFromWebGpu: true,
    };
  }

  // ONNX Runtime Web does not support its WebGPU execution provider in iOS
  // browsers. Keep iPhone generation evidence for expressive-prosody memory
  // policy, but never attempt the WebGPU runtime on iOS.
  if (platform === 'ios') {
    const iphone = evaluateIphoneWebGpuEligibility({
      userAgent, iosModel: options.iosModel, screenWidth, screenHeight,
    });
    return {
      eligible: false,
      reason: 'ONNX Runtime WebGPU is unavailable in iOS browsers; using threaded WASM.',
      cores,
      memoryGb,
      isolated,
      iphone,
    };
  }

  // Mobile default: threaded WASM + SharedArrayBuffer. WebGPU is opt-in only
  // (Settings → WebGPU). Optimistic auto-start is intentionally disabled.
  const optimisticAuto = POCKET_MOBILE_OPTIMISTIC_WEBGPU === true
    && options.optimisticAuto === true
    && isMobileWebGpuOptimisticCandidate({
      mobile: options.mobile,
      userAgent,
      platform,
      crossOriginIsolated: isolated,
      hardwareConcurrency: cores,
      memoryGb,
      lowMemoryMode: options.lowMemoryMode,
      saveData: options.saveData,
      demotedFromWebGpu: options.demotedFromWebGpu,
      iosModel: options.iosModel,
      screenWidth,
      screenHeight,
    });
  if (options.mobile === true && options.allowMobileWebGpu !== true && !optimisticAuto) {
    return {
      eligible: false,
      reason: 'Mobile devices use threaded WASM unless WebGPU is explicitly selected in Settings.',
      cores,
      memoryGb,
      isolated,
    };
  }

  if (!secure) return { eligible: false, reason: 'WebGPU requires a secure context.', cores, memoryGb, isolated };
  if (!isolated) return { eligible: false, reason: 'Narration optimization requires cross-origin isolation.', cores, memoryGb, isolated };
  if (!nav?.gpu) return { eligible: false, reason: 'WebGPU is unavailable in this browser.', cores, memoryGb, isolated };
  if (options.lowMemoryMode) return { eligible: false, reason: 'Low Memory Mode requires the WASM backend.', cores, memoryGb, isolated };
  if (options.saveData) return { eligible: false, reason: 'Data Saver keeps the smaller WASM model bundle.', cores, memoryGb, isolated };

  let adapter;
  try {
    adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch (error) {
    return { eligible: false, reason: `WebGPU adapter request failed: ${error?.message || error}`, cores, memoryGb, isolated };
  }
  if (!adapter) return { eligible: false, reason: 'No WebGPU adapter was returned.', cores, memoryGb, isolated };
  if (!adapter.features?.has('shader-f16')) {
    return { eligible: false, reason: 'The WebGPU adapter does not support shader-f16.', cores, memoryGb, isolated };
  }

  const probeBytes = platform === 'ios' ? IOS_GPU_ALLOCATION_PROBE_BYTES : GPU_ALLOCATION_PROBE_BYTES;
  let allocationProbeBytes = 0;
  if (typeof adapter.requestDevice === 'function') {
    let device;
    let buffer;
    try {
      device = await adapter.requestDevice({ requiredFeatures: ['shader-f16'] });
      const usage = globalThis.GPUBufferUsage
        ? globalThis.GPUBufferUsage.STORAGE | globalThis.GPUBufferUsage.COPY_DST
        : 0x0080 | 0x0008;
      buffer = device.createBuffer({ size: probeBytes, usage });
      allocationProbeBytes = probeBytes;
    } catch (error) {
      return { eligible: false, reason: `WebGPU allocation probe failed: ${error?.message || error}`, cores, memoryGb, isolated };
    } finally {
      buffer?.destroy?.();
      device?.destroy?.();
    }
  }

  let info = {};
  try {
    info = typeof adapter.requestAdapterInfo === 'function'
      ? await adapter.requestAdapterInfo()
      : (adapter.info || {});
  } catch (_) {
    info = adapter.info || {};
  }
  return {
    eligible: true,
    reason: '',
    cores,
    memoryGb,
    isolated,
    adapter,
    adapterInfo: info,
    adapterIdentity: adapterIdentity(info),
    allocationProbeBytes,
  };
}

export function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return Infinity;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

export function selectWebGpuVariant(candidates = [], options = {}) {
  const minVariantSpeedup = Number(options.minVariantSpeedup || 0.05);
  const valid = candidates.filter((candidate) => (
    candidate
    && !candidate.failures
    && Number.isFinite(candidate.medianMs)
    && Number.isFinite(candidate.p95Ms)
    && Number.isFinite(candidate.medianRealTimeFactor)
  ));
  if (!valid.length) return { variant: null, reason: 'No stable WebGPU variant completed calibration.' };
  valid.sort((left, right) => left.medianMs - right.medianMs || left.p95Ms - right.p95Ms);
  const fastest = valid[0];
  const baseline = options.baselineCandidate && valid.includes(options.baselineCandidate)
    ? options.baselineCandidate
    : valid.find((candidate) => candidate.graphCapture === false && candidate.mimiProvider === 'wasm-threaded');
  if (!baseline || fastest === baseline) return { variant: fastest, reason: '' };
  const speedup = 1 - (fastest.medianMs / baseline.medianMs);
  if (speedup < minVariantSpeedup || fastest.p95Ms > baseline.p95Ms) {
    return { variant: baseline, reason: 'Optional WebGPU tuning did not provide a stable five percent win.' };
  }
  return { variant: fastest, reason: '', speedup };
}

// Sustained-latency guard: calibration certifies WebGPU from a few short runs
// on a cool chip, but long caching sessions can thermally throttle mobile GPUs
// far below that certified speed. Demote to WASM once several consecutive
// full paragraphs generate slower than the real-time threshold.
export const POCKET_SUSTAINED_RTF_LIMIT = 1.25;
export const POCKET_SUSTAINED_RTF_STRIKES = 2;
export const POCKET_SUSTAINED_MIN_AUDIO_SEC = 2;
export const POCKET_WEBGPU_WASM_PARITY_RATIO = 1.05;

// CPU thermal pacing guard: browsers expose no temperature sensor, so we treat
// a sustained rise in per-paragraph real-time factor (synthesis ms per audio
// ms) as the symptom of a thermally throttled SoC and rest the CPU between
// paragraphs until it recovers. The baseline is the coolest median window seen
// this session, so a device that starts hot and later cools re-anchors down,
// while a hot streak can never raise the baseline and mask itself.
export const POCKET_THERMAL_BASELINE_SAMPLES = 4;
export const POCKET_THERMAL_RECENT_SAMPLES = 3;
export const POCKET_THERMAL_MIN_AUDIO_SEC = 2;
// Loosened 2026-07-16: mobile SoCs (e.g. Tensor G1) sustain load better than the
// original conservative pacing assumed, so we rest less eagerly and for shorter
// windows to keep usable caching throughput on long jobs. Trigger 1.5->1.7,
// rests 12s->8s / 30s->20s.
export const POCKET_THERMAL_TRIGGER_RATIO = 1.7;
export const POCKET_THERMAL_HEAVY_RATIO = 2.0;
export const POCKET_THERMAL_REST_MS = 8000;
export const POCKET_THERMAL_HEAVY_REST_MS = 20000;
export const POCKET_THERMAL_HISTORY_LIMIT = 32;

function medianOf(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function evaluateCpuThermalRest(history = [], options = {}) {
  const baselineSamples = Math.max(2, Number(options.baselineSamples || POCKET_THERMAL_BASELINE_SAMPLES));
  const recentSamples = Math.max(1, Number(options.recentSamples || POCKET_THERMAL_RECENT_SAMPLES));
  const minAudioSec = Number(options.minAudioSec ?? POCKET_THERMAL_MIN_AUDIO_SEC);
  const triggerRatio = Number(options.triggerRatio || POCKET_THERMAL_TRIGGER_RATIO);
  const heavyRatio = Number(options.heavyRatio || POCKET_THERMAL_HEAVY_RATIO);
  const none = { rest: false, restMs: 0, ratio: 1, baselineRtf: null, recentRtf: null };

  const meaningful = history.filter((entry) => (
    Number.isFinite(entry?.realTimeFactor)
    && entry.realTimeFactor > 0
    && Number(entry?.audioDurationSec || 0) >= minAudioSec
  )).map((entry) => entry.realTimeFactor);
  if (meaningful.length < baselineSamples + recentSamples) return none;

  // Coolest contiguous baseline window drawn from everything before the
  // recent segment being judged.
  const baselinePool = meaningful.slice(0, meaningful.length - recentSamples);
  let baselineRtf = Infinity;
  for (let start = 0; start + baselineSamples <= baselinePool.length; start += 1) {
    baselineRtf = Math.min(baselineRtf, medianOf(baselinePool.slice(start, start + baselineSamples)));
  }
  if (!Number.isFinite(baselineRtf) || baselineRtf <= 0) return none;

  const recentRtf = medianOf(meaningful.slice(-recentSamples));
  const ratio = recentRtf / baselineRtf;
  if (ratio >= heavyRatio) {
    return { rest: true, restMs: Number(options.heavyRestMs || POCKET_THERMAL_HEAVY_REST_MS), ratio, baselineRtf, recentRtf };
  }
  if (ratio >= triggerRatio) {
    return { rest: true, restMs: Number(options.restMs || POCKET_THERMAL_REST_MS), ratio, baselineRtf, recentRtf };
  }
  return { ...none, ratio, baselineRtf, recentRtf };
}

export function shouldDemoteWebGpuSustained(history = [], options = {}) {
  const limit = Number(options.rtfLimit || POCKET_SUSTAINED_RTF_LIMIT);
  const strikes = Math.max(1, Number(options.strikes || POCKET_SUSTAINED_RTF_STRIKES));
  const minAudioSec = Number(options.minAudioSec ?? POCKET_SUSTAINED_MIN_AUDIO_SEC);
  const wasmReferenceRtf = Number(options.wasmReferenceRtf);
  const parityRatio = Number(options.parityRatio || POCKET_WEBGPU_WASM_PARITY_RATIO);
  const meaningful = history.filter((entry) => (
    Number.isFinite(entry?.realTimeFactor)
    && Number(entry?.audioDurationSec || 0) >= minAudioSec
  ));
  if (meaningful.length < strikes) return false;
  const recent = meaningful.slice(-strikes);
  if (Number.isFinite(wasmReferenceRtf) && wasmReferenceRtf > 0) {
    const wasmParityLimit = wasmReferenceRtf * parityRatio;
    return recent.every((entry) => entry.realTimeFactor >= wasmParityLimit);
  }
  return recent.every((entry) => entry.realTimeFactor > limit);
}

export function selectCalibratedBackend(wasm, webgpu, options = {}) {
  const minSpeedup = Number(options.minSpeedup || 0.15);
  const maxBreakEvenParagraphs = Number(options.maxBreakEvenParagraphs || 20);
  const maxFirstSegmentMs = Number(options.maxFirstSegmentMs || 500);
  const maxFirstSegmentRegression = Number(options.maxFirstSegmentRegression || 0.10);
  if (!wasm || !webgpu || wasm.failures || webgpu.failures) {
    return { selectedBackend: 'wasm', reason: 'One or more calibration runs failed.' };
  }
  if (![wasm.medianMs, wasm.p95Ms, webgpu.medianMs, webgpu.p95Ms].every(Number.isFinite)) {
    return { selectedBackend: 'wasm', reason: 'Calibration timing was incomplete.' };
  }
  const speedup = 1 - (webgpu.medianMs / wasm.medianMs);
  const firstSegmentSpeedup = 1 - (webgpu.medianFirstSegmentMs / wasm.medianFirstSegmentMs);
  const realTimeSpeedup = 1 - (webgpu.medianRealTimeFactor / wasm.medianRealTimeFactor);
  const breakEvenParagraphs = Number(webgpu.breakEvenParagraphs ?? Infinity);
  if (speedup < minSpeedup) {
    const reason = speedup < 0
      ? `WebGPU was ${(Math.abs(speedup) * 100).toFixed(1)}% slower than WASM.`
      : `WebGPU was only ${(speedup * 100).toFixed(1)}% faster.`;
    return { selectedBackend: 'wasm', reason, speedup, breakEvenParagraphs };
  }
  if (webgpu.p95Ms > wasm.p95Ms) {
    return { selectedBackend: 'wasm', reason: 'WebGPU p95 latency was worse than WASM.', speedup, breakEvenParagraphs };
  }
  if (![firstSegmentSpeedup, realTimeSpeedup].every(Number.isFinite)) {
    return { selectedBackend: 'wasm', reason: 'WebGPU streaming calibration was incomplete.', speedup, breakEvenParagraphs };
  }
  if (realTimeSpeedup < minSpeedup) {
    return { selectedBackend: 'wasm', reason: `WebGPU sustained narration improved by only ${(realTimeSpeedup * 100).toFixed(1)}%.`, speedup, firstSegmentSpeedup, realTimeSpeedup, breakEvenParagraphs };
  }
  const firstAudioLimit = Math.max(maxFirstSegmentMs, wasm.medianFirstSegmentMs * (1 + maxFirstSegmentRegression));
  const p95FirstAudioLimit = Math.max(maxFirstSegmentMs, wasm.p95FirstSegmentMs * (1 + maxFirstSegmentRegression));
  if (webgpu.medianFirstSegmentMs > firstAudioLimit || webgpu.p95FirstSegmentMs > p95FirstAudioLimit) {
    return { selectedBackend: 'wasm', reason: 'WebGPU first audio exceeded the latency safety limit.', speedup, firstSegmentSpeedup, realTimeSpeedup, breakEvenParagraphs };
  }
  if (breakEvenParagraphs > maxBreakEvenParagraphs) {
    return { selectedBackend: 'wasm', reason: `WebGPU load cost breaks even after ${Math.ceil(breakEvenParagraphs)} paragraphs.`, speedup, breakEvenParagraphs };
  }
  return { selectedBackend: 'webgpu', reason: '', speedup, firstSegmentSpeedup, realTimeSpeedup, breakEvenParagraphs };
}
