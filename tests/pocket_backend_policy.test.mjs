import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePocketBackend,
  percentile,
  selectCalibratedBackend,
  probePocketWebGpuEligibility,
  recommendedWasmThreadCount,
  recommendedPocketCacheWorkerCount,
  selectCalibratedThreadCount,
  selectWebGpuVariant,
  shouldDemoteWebGpuSustained,
  isMobileWebGpuOptimisticCandidate,
  shouldPreferOptimisticWebGpu,
  buildOptimisticWebGpuCalibration,
  estimateWasmRealTimeFactor,
  resolveWasmReferenceRtf,
  evaluateIphoneWebGpuEligibility,
  writeWebGpuDemotion,
  readWebGpuDemotion,
  clearWebGpuDemotion,
  wasmThreadCandidates,
  writePocketCalibration,
  readPocketCalibration,
  evaluateCpuThermalRest,
  POCKET_THERMAL_REST_MS,
  POCKET_THERMAL_HEAVY_REST_MS,
  classifyPocketDeviceCapability,
  resolvePocketExpressiveProsody,
  readPocketExpressiveChoice,
  writePocketExpressiveChoice,
  collectPocketDeviceCapability,
  POCKET_DEVICE_CAPABILITY_KEY,
  classifyPocketDeviceSupport,
  selectPocketDeviceSetup,
  readPocketDeviceSetup,
  writePocketDeviceSetup,
  readPocketDeviceBackendPreference,
  writePocketDeviceBackendPreference,
} from '../pocket_backend_policy.js';

function memoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

test('normalizes backend preferences', () => {
  assert.equal(normalizePocketBackend('webgpu'), 'webgpu');
  assert.equal(normalizePocketBackend('wasm'), 'wasm');
  assert.equal(normalizePocketBackend('invalid'), 'auto');
});

test('constrained mobile devices default expressive narration off', () => {
  const android4 = classifyPocketDeviceCapability({
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 7)',
    deviceMemory: 4,
  });
  assert.equal(android4.constrained, true);
  assert.equal(android4.defaultExpressiveProsody, false);

  const dataSaver = classifyPocketDeviceCapability({
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)',
    deviceMemory: 8,
    saveData: true,
  });
  assert.equal(dataSaver.constrained, true);

  const iphone13 = classifyPocketDeviceCapability({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    iosModel: 'iPhone14,5',
  });
  assert.equal(iphone13.constrained, true);

  const unknownIphone = classifyPocketDeviceCapability({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
  });
  assert.equal(unknownIphone.constrained, true);
  assert.equal(unknownIphone.positiveHighMemoryEvidence, false);
});

test('positive 6GB+ mobile evidence keeps expressive narration enabled', () => {
  const android8 = classifyPocketDeviceCapability({
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)',
    deviceMemory: 8,
  });
  assert.equal(android8.constrained, false);
  assert.equal(android8.defaultExpressiveProsody, true);

  const iphone14 = classifyPocketDeviceCapability({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    iosModel: 'iPhone15,2',
  });
  assert.equal(iphone14.constrained, false);
  assert.equal(iphone14.positiveHighMemoryEvidence, true);

  const iphone13Pro = classifyPocketDeviceCapability({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    iosModel: 'iPhone14,2',
  });
  assert.equal(iphone13Pro.constrained, false);
  assert.equal(iphone13Pro.defaultExpressiveProsody, true);
  assert.equal(iphone13Pro.memorySafeInference, true);
  assert.equal(iphone13Pro.fullStoryVoicePrefetch, false);
});

test('device setup and backend preference remain device-local', () => {
  const storage = memoryStorage();
  assert.equal(readPocketDeviceSetup(storage), null);
  const saved = writePocketDeviceSetup(storage, { recommendedBackend: 'wasm', wasmThreads: 2 });
  assert.equal(saved.version, 2);
  assert.equal(readPocketDeviceSetup(storage).wasmThreads, 2);
  assert.equal(readPocketDeviceBackendPreference(storage), 'auto');
  assert.equal(writePocketDeviceBackendPreference(storage, 'webgpu'), 'webgpu');
  assert.equal(readPocketDeviceBackendPreference(storage), 'webgpu');
});

test('soft support floor covers iPhone 13 Pro and comparable Android flagships', () => {
  assert.equal(classifyPocketDeviceSupport({ platform: 'ios', model: 'iPhone14,2' }).officiallySupported, true);
  assert.equal(classifyPocketDeviceSupport({ platform: 'ios', model: 'iPhone14,5' }).status, 'below-floor');
  assert.equal(classifyPocketDeviceSupport({ platform: 'ios' }).status, 'unverified');
  assert.equal(classifyPocketDeviceSupport({ platform: 'android', model: 'Pixel 6', deviceMemory: 8 }).officiallySupported, true);
  assert.equal(classifyPocketDeviceSupport({ platform: 'android', model: 'SM-G991U', deviceMemory: 8 }).officiallySupported, true);
  assert.equal(classifyPocketDeviceSupport({ platform: 'android', model: 'Snapdragon 8 Gen 2', deviceMemory: 8 }).officiallySupported, true);
  assert.equal(classifyPocketDeviceSupport({ platform: 'android', model: 'Exynos 2100', deviceMemory: 8 }).officiallySupported, true);
  assert.equal(classifyPocketDeviceSupport({ platform: 'android', model: 'Dimensity 9000', deviceMemory: 8 }).officiallySupported, true);
  assert.equal(classifyPocketDeviceSupport({ platform: 'android', model: 'Unknown', deviceMemory: 8, benchmarkPassed: true }).status, 'benchmark-qualified');
  assert.equal(classifyPocketDeviceSupport({ platform: 'android', model: 'Unknown', deviceMemory: 4 }).awayModeRecommended, true);
});

test('first-run selection chooses measured WASM width; WebGPU only on desktop', () => {
  const capability = {
    platform: 'android', deviceMemoryGb: 8, hardwareConcurrency: 8,
    constrained: false, lowMemoryMode: false, saveData: false,
  };
  const support = { officiallySupported: true, benchmarkQualified: false };
  const cpuResults = [
    { threads: 1, medianMs: 100, p95Ms: 105, failures: 0 },
    { threads: 2, medianMs: 63, p95Ms: 66, failures: 0 },
    { threads: 4, medianMs: 42, p95Ms: 45, failures: 0 },
  ];
  // Pixel / Android: fast FP16 probe must NOT override WASM x4 default.
  const android = selectPocketDeviceSetup({
    capability, support, cpuResults, crossOriginIsolated: true,
    webgpu: { supported: true, medianMs: 45 },
  });
  assert.equal(android.recommendedBackend, 'wasm');
  assert.equal(android.wasmThreads, 4);
  assert.match(android.reason, /Mobile auto defaults to threaded WASM/);

  const desktop = selectPocketDeviceSetup({
    capability: { ...capability, platform: 'desktop' },
    support, cpuResults, crossOriginIsolated: true,
    webgpu: { supported: true, medianMs: 45 },
  });
  assert.equal(desktop.recommendedBackend, 'webgpu');

  const slowGpu = selectPocketDeviceSetup({
    capability: { ...capability, platform: 'desktop' },
    support, cpuResults, crossOriginIsolated: true,
    webgpu: { supported: true, medianMs: 180 },
  });
  assert.equal(slowGpu.recommendedBackend, 'wasm');

  const ios = selectPocketDeviceSetup({
    capability: { ...capability, platform: 'ios', hardwareConcurrency: 4 },
    support, cpuResults, crossOriginIsolated: true,
    webgpu: { supported: true, medianMs: 10 },
  });
  assert.equal(ios.recommendedBackend, 'wasm');
  assert.ok(ios.wasmThreads <= 2);
});

test('explicit expressive choice is device-local and always wins', () => {
  const storage = memoryStorage();
  const constrained = classifyPocketDeviceCapability({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
  });
  assert.equal(resolvePocketExpressiveProsody({ capability: constrained, storage }), false);
  assert.equal(writePocketExpressiveChoice(storage, 'enabled'), true);
  assert.equal(readPocketExpressiveChoice(storage), 'enabled');
  assert.equal(resolvePocketExpressiveProsody({ capability: constrained, storage }), true);
  assert.equal(writePocketExpressiveChoice(storage, 'disabled'), true);
  assert.equal(resolvePocketExpressiveProsody({ capability: constrained, storage }), false);
});

test('capability refresh preserves the one-time TTS calibration record', async () => {
  const storage = memoryStorage();
  storage.setItem(POCKET_DEVICE_CAPABILITY_KEY, JSON.stringify({
    ttsCalibration: { initializationSucceeded: true, initializationMs: 1234, realTimeFactor: 0.8 },
  }));
  const record = await collectPocketDeviceCapability({
    storage,
    navigator: {
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)',
      deviceMemory: 8,
      hardwareConcurrency: 8,
      connection: { saveData: false },
    },
  });
  assert.equal(record.constrained, false);
  assert.equal(record.ttsCalibration.realTimeFactor, 0.8);
});

test('computes stable median and p95', () => {
  assert.equal(percentile([8, 1, 4, 2, 6], 0.5), 4);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8], 0.95), 8);
});

test('selects WebGPU for a stable sustained win without demanding a relative first-audio win', () => {
  const accepted = selectCalibratedBackend(
    { medianMs: 100, p95Ms: 120, medianFirstSegmentMs: 50, p95FirstSegmentMs: 60, medianRealTimeFactor: 0.5, failures: 0 },
    { medianMs: 80, p95Ms: 115, medianFirstSegmentMs: 40, p95FirstSegmentMs: 55, medianRealTimeFactor: 0.4, failures: 0, breakEvenParagraphs: 10 },
  );
  assert.equal(accepted.selectedBackend, 'webgpu');

  const tooSlow = selectCalibratedBackend(
    { medianMs: 100, p95Ms: 120, medianFirstSegmentMs: 50, p95FirstSegmentMs: 60, medianRealTimeFactor: 0.5, failures: 0 },
    { medianMs: 90, p95Ms: 110, medianFirstSegmentMs: 40, p95FirstSegmentMs: 55, medianRealTimeFactor: 0.4, failures: 0, breakEvenParagraphs: 10 },
  );
  assert.equal(tooSlow.selectedBackend, 'wasm');

  const slower = selectCalibratedBackend(
    { medianMs: 100, p95Ms: 120, medianFirstSegmentMs: 50, p95FirstSegmentMs: 60, medianRealTimeFactor: 0.5, failures: 0 },
    { medianMs: 430, p95Ms: 480, medianFirstSegmentMs: 200, p95FirstSegmentMs: 220, medianRealTimeFactor: 2, failures: 0, breakEvenParagraphs: 1000 },
  );
  assert.equal(slower.reason, 'WebGPU was 330.0% slower than WASM.');

  const unstable = selectCalibratedBackend(
    { medianMs: 100, p95Ms: 120, medianFirstSegmentMs: 50, p95FirstSegmentMs: 60, medianRealTimeFactor: 0.5, failures: 0 },
    { medianMs: 75, p95Ms: 130, medianFirstSegmentMs: 35, p95FirstSegmentMs: 65, medianRealTimeFactor: 0.35, failures: 0, breakEvenParagraphs: 10 },
  );
  assert.equal(unstable.selectedBackend, 'wasm');

  const slowFirstAudio = selectCalibratedBackend(
    { medianMs: 100, p95Ms: 120, medianFirstSegmentMs: 50, p95FirstSegmentMs: 60, medianRealTimeFactor: 0.5, failures: 0 },
    { medianMs: 70, p95Ms: 100, medianFirstSegmentMs: 46, p95FirstSegmentMs: 55, medianRealTimeFactor: 0.3, failures: 0, breakEvenParagraphs: 10 },
  );
  assert.equal(slowFirstAudio.selectedBackend, 'webgpu');

  const unacceptableFirstAudio = selectCalibratedBackend(
    { medianMs: 1000, p95Ms: 1200, medianFirstSegmentMs: 220, p95FirstSegmentMs: 260, medianRealTimeFactor: 0.5, failures: 0 },
    { medianMs: 650, p95Ms: 900, medianFirstSegmentMs: 620, p95FirstSegmentMs: 680, medianRealTimeFactor: 0.3, failures: 0, breakEvenParagraphs: 10 },
  );
  assert.equal(unacceptableFirstAudio.selectedBackend, 'wasm');
  assert.match(unacceptableFirstAudio.reason, /first audio/i);
});

test('uses measured WebGPU capability instead of privacy-limited hardware hints', async () => {
  const adapter = {
    features: new Set(['shader-f16']),
    info: { vendor: 'test', architecture: 'gpu' },
  };
  const navigator = {
    gpu: { requestAdapter: async () => adapter },
    hardwareConcurrency: 8,
    deviceMemory: 8,
  };
  const eligible = await probePocketWebGpuEligibility({ navigator, crossOriginIsolated: true, isSecureContext: true });
  assert.equal(eligible.eligible, true);

  const privacyLimited = await probePocketWebGpuEligibility({
    navigator: { ...navigator, hardwareConcurrency: 2, deviceMemory: undefined },
    crossOriginIsolated: true,
    isSecureContext: true,
  });
  assert.equal(privacyLimited.eligible, true);

  const notIsolated = await probePocketWebGpuEligibility({ navigator, crossOriginIsolated: false, isSecureContext: true });
  assert.equal(notIsolated.eligible, false);

  // Mobile without the auto-preference flag still defaults to threaded WASM.
  const mobileDefault = await probePocketWebGpuEligibility({ navigator, crossOriginIsolated: true, isSecureContext: true, mobile: true });
  assert.equal(mobileDefault.eligible, false);
  assert.match(mobileDefault.reason, /mobile/i);
  // Capable mobiles stay on WASM even when optimisticAuto is requested —
  // POCKET_MOBILE_OPTIMISTIC_WEBGPU is off (Pixel 6 Pro defaults to WASM x4).
  const mobileOptimistic = await probePocketWebGpuEligibility({
    navigator, crossOriginIsolated: true, isSecureContext: true, mobile: true, optimisticAuto: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 6 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
    hardwareConcurrency: 8, memoryGb: 8,
  });
  assert.equal(mobileOptimistic.eligible, false);
  assert.match(mobileOptimistic.reason, /threaded WASM/i);
  // Budget hardware never auto-starts WebGPU even on the auto preference.
  const mobileBudget = await probePocketWebGpuEligibility({
    navigator, crossOriginIsolated: true, isSecureContext: true, mobile: true, optimisticAuto: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; moto g power 5G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
    hardwareConcurrency: 8, memoryGb: 8,
  });
  assert.equal(mobileBudget.eligible, false);
  // Explicit opt-in still allows mobile WebGPU.
  const mobileOptIn = await probePocketWebGpuEligibility({ navigator, crossOriginIsolated: true, isSecureContext: true, mobile: true, allowMobileWebGpu: true });
  assert.equal(mobileOptIn.eligible, true);

  const noF16 = await probePocketWebGpuEligibility({
    navigator: { ...navigator, gpu: { requestAdapter: async () => ({ ...adapter, features: new Set() }) } },
    crossOriginIsolated: true,
    isSecureContext: true,
  });
  assert.equal(noF16.eligible, false);
});

test('selects isolated WASM thread candidates with a mobile performance-core cap', () => {
  assert.deepEqual(wasmThreadCandidates({ crossOriginIsolated: false, hardwareConcurrency: 8 }), [1]);
  // Mobile is capped at 4 threads (maps onto big.LITTLE performance cores).
  assert.deepEqual(wasmThreadCandidates({ crossOriginIsolated: true, hardwareConcurrency: 8, mobile: true }), [1, 2, 4]);
  assert.deepEqual(wasmThreadCandidates({ crossOriginIsolated: true, hardwareConcurrency: 8 }), [1, 2, 4, 6]);
  // Field data (Pixel 6 Pro, 8 cores, isolated): 4 threads generate a sentence
  // chunk in ~4s vs ~21s single-threaded, so mobile takes the largest candidate.
  assert.equal(recommendedWasmThreadCount({ crossOriginIsolated: true, hardwareConcurrency: 8, mobile: true }), 4);
  // Low-core phones fall back to whatever the isolated session exposes.
  assert.equal(recommendedWasmThreadCount({ crossOriginIsolated: true, hardwareConcurrency: 2, mobile: true }), 2);
  // Non-isolated mobile can only run one thread.
  assert.equal(recommendedWasmThreadCount({ crossOriginIsolated: false, hardwareConcurrency: 8, mobile: true }), 1);
  assert.equal(recommendedWasmThreadCount({ crossOriginIsolated: true, hardwareConcurrency: 8 }), 2);
});

test('parallel caching requires positive high-memory desktop evidence', () => {
  const eligible = {
    throughputMode: true,
    backend: 'wasm',
    platform: 'desktop',
    constrained: false,
    crossOriginIsolated: true,
    deviceMemory: 8,
    hardwareConcurrency: 12,
    wasmThreads: 4,
    saveData: false,
    lowMemoryMode: false,
    lowBattery: false,
    batteryLevel: 0.8,
    batteryCharging: false,
  };
  assert.equal(recommendedPocketCacheWorkerCount(eligible), 2);
  assert.equal(recommendedPocketCacheWorkerCount({ ...eligible, platform: 'ios' }), 1);
  assert.equal(recommendedPocketCacheWorkerCount({ ...eligible, platform: 'android' }), 1);
  assert.equal(recommendedPocketCacheWorkerCount({ ...eligible, deviceMemory: 4 }), 1);
  assert.equal(recommendedPocketCacheWorkerCount({ ...eligible, hardwareConcurrency: 6 }), 1);
  assert.equal(recommendedPocketCacheWorkerCount({ ...eligible, backend: 'webgpu' }), 1);
  assert.equal(recommendedPocketCacheWorkerCount({ ...eligible, batteryLevel: 0.25 }), 1);
  assert.equal(recommendedPocketCacheWorkerCount({ ...eligible, throughputMode: false }), 1);
});

test('demotes WebGPU after consecutive slower-than-real-time paragraphs', () => {
  const slow = { realTimeFactor: 2.4, audioDurationSec: 12 };
  const fast = { realTimeFactor: 0.6, audioDurationSec: 12 };
  const tiny = { realTimeFactor: 3.0, audioDurationSec: 0.4 };
  assert.equal(shouldDemoteWebGpuSustained([slow, slow]), true);
  assert.equal(shouldDemoteWebGpuSustained([slow]), false);
  assert.equal(shouldDemoteWebGpuSustained([slow, fast]), false);
  assert.equal(shouldDemoteWebGpuSustained([fast, slow, slow]), true);
  // Sub-2-second clips are too noisy to count as strikes.
  assert.equal(shouldDemoteWebGpuSustained([tiny, tiny]), false);
  assert.equal(shouldDemoteWebGpuSustained([]), false);
});

test('demotes WebGPU when sustained RTF meets or exceeds modeled WASM parity', () => {
  const wasmRef = 0.58;
  const barelyWorse = { realTimeFactor: 0.61, audioDurationSec: 10 };
  const stillWinning = { realTimeFactor: 0.50, audioDurationSec: 10 };
  assert.equal(shouldDemoteWebGpuSustained([barelyWorse, barelyWorse], { wasmReferenceRtf: wasmRef }), true);
  assert.equal(shouldDemoteWebGpuSustained([stillWinning, barelyWorse], { wasmReferenceRtf: wasmRef }), false);
});

test('optimistic WebGPU auto-start is disabled; Pixel 6 Pro stays on WASM x4', () => {
  const iosUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
  const pixelUa = 'Mozilla/5.0 (Linux; Android 14; Pixel 6 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36';
  const motoUa = 'Mozilla/5.0 (Linux; Android 14; moto g power 5G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36';
  const pixelAUa = 'Mozilla/5.0 (Linux; Android 14; Pixel 6a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36';
  // Candidate helpers remain for diagnostics / Settings opt-in, but preference is off.
  assert.equal(isMobileWebGpuOptimisticCandidate({ userAgent: iosUa, crossOriginIsolated: true, hardwareConcurrency: 4 }), false);
  assert.equal(isMobileWebGpuOptimisticCandidate({
    userAgent: iosUa, iosModel: 'iPhone14,7', crossOriginIsolated: true, hardwareConcurrency: 4,
  }), false);
  assert.equal(isMobileWebGpuOptimisticCandidate({
    userAgent: iosUa, iosModel: 'iPhone14,2', crossOriginIsolated: true, hardwareConcurrency: 4,
  }), false);
  assert.equal(isMobileWebGpuOptimisticCandidate({
    userAgent: iosUa, screenWidth: 393, screenHeight: 852, crossOriginIsolated: true, hardwareConcurrency: 4,
  }), false);
  assert.equal(isMobileWebGpuOptimisticCandidate({ userAgent: pixelUa, crossOriginIsolated: true, hardwareConcurrency: 8, memoryGb: 8 }), true);
  assert.equal(isMobileWebGpuOptimisticCandidate({ userAgent: motoUa, crossOriginIsolated: true, hardwareConcurrency: 8, memoryGb: 8 }), false);
  assert.equal(isMobileWebGpuOptimisticCandidate({ userAgent: pixelAUa, crossOriginIsolated: true, hardwareConcurrency: 8, memoryGb: 8 }), false);
  // Flagship Pixel on auto: do NOT start on WebGPU (policy flag off).
  assert.equal(shouldPreferOptimisticWebGpu({
    preference: 'auto', eligible: true, userAgent: pixelUa, crossOriginIsolated: true, hardwareConcurrency: 8, memoryGb: 8,
  }), false);
  assert.equal(shouldPreferOptimisticWebGpu({
    preference: 'auto', eligible: true, userAgent: pixelUa, crossOriginIsolated: true, hardwareConcurrency: 8, memoryGb: 8,
    calibration: { selectedBackend: 'wasm' },
  }), false);
  assert.equal(shouldPreferOptimisticWebGpu({
    preference: 'auto', eligible: true, userAgent: pixelUa, crossOriginIsolated: true, hardwareConcurrency: 8, memoryGb: 8,
    demotedFromWebGpu: true,
  }), false);
  assert.equal(shouldPreferOptimisticWebGpu({
    preference: 'auto', eligible: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    crossOriginIsolated: true, hardwareConcurrency: 16, memoryGb: 16,
  }), false);
  assert.equal(shouldPreferOptimisticWebGpu({
    preference: 'wasm', eligible: true, userAgent: pixelUa, crossOriginIsolated: true, hardwareConcurrency: 8, memoryGb: 8,
  }), false);
  const optimistic = buildOptimisticWebGpuCalibration({ threadCount: 4 });
  assert.equal(optimistic.selectedBackend, 'webgpu');
  assert.equal(optimistic.optimistic, true);
  assert.ok(estimateWasmRealTimeFactor({ userAgent: pixelUa, crossOriginIsolated: true, hardwareConcurrency: 8, threads: 4 }) < 1);
  assert.equal(resolveWasmReferenceRtf({
    userAgent: pixelUa, threads: 4, measuredWasmRtf: 0.91,
  }), 0.91);
  assert.equal(recommendedWasmThreadCount({
    crossOriginIsolated: true, hardwareConcurrency: 8, mobile: true, userAgent: pixelUa,
  }), 4);
});

test('iPhone memory evidence distinguishes 6GB+ hardware without enabling WebGPU', () => {
  assert.equal(evaluateIphoneWebGpuEligibility({ iosModel: 'iPhone14,7' }).eligible, true);
  assert.equal(evaluateIphoneWebGpuEligibility({ iosModel: 'iPhone15,2' }).eligible, true);
  assert.equal(evaluateIphoneWebGpuEligibility({ iosModel: 'iPhone14,2' }).eligible, true);
  assert.equal(evaluateIphoneWebGpuEligibility({ iosModel: 'iPhone13,2' }).eligible, false);
  assert.equal(evaluateIphoneWebGpuEligibility({ userAgent: 'iPhone 13 Pro' }).eligible, true);
  assert.equal(evaluateIphoneWebGpuEligibility({ userAgent: 'iPhone 16 Pro' }).eligible, true);
  assert.equal(evaluateIphoneWebGpuEligibility({ screenWidth: 390, screenHeight: 844 }).eligible, false);
});

test('iOS browsers always fail the ORT WebGPU capability gate', async () => {
  const result = await probePocketWebGpuEligibility({
    platform: 'ios',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)',
    iosModel: 'iPhone16,1',
    mobile: true,
    allowMobileWebGpu: true,
    crossOriginIsolated: true,
    isSecureContext: true,
    navigator: { hardwareConcurrency: 4, gpu: {} },
  });
  assert.equal(result.eligible, false);
  assert.match(result.reason, /unavailable in iOS browsers/);
});

test('sticky WebGPU demotion survives calibration clears', () => {
  const storage = memoryStorage();
  const context = { browserMajor: 150, isolated: true, platform: 'android', userAgent: 'Pixel' };
  assert.equal(writeWebGpuDemotion(storage, context, 'parity miss'), true);
  assert.equal(readWebGpuDemotion(storage, context)?.demotedFromWebGpu, true);
  assert.equal(clearWebGpuDemotion(storage, context), true);
  assert.equal(readWebGpuDemotion(storage, context), null);
});

test('selects the fastest stable WASM thread result', () => {
  const result = selectCalibratedThreadCount([
    { threads: 1, medianMs: 100, p95Ms: 110, failures: 0 },
    { threads: 2, medianMs: 58, p95Ms: 66, failures: 0 },
    { threads: 4, medianMs: 55, p95Ms: 90, failures: 0 },
  ]);
  assert.equal(result.threads, 2);
});

test('keeps optional WebGPU tuning only for a stable five percent win', () => {
  const baseline = { medianMs: 100, p95Ms: 110, medianRealTimeFactor: 0.4, failures: 0, graphCapture: false, mimiProvider: 'wasm-threaded' };
  const captured = { medianMs: 92, p95Ms: 105, medianRealTimeFactor: 0.36, failures: 0, graphCapture: true, mimiProvider: 'wasm-threaded' };
  assert.equal(selectWebGpuVariant([baseline, captured]).variant, captured);

  const unstable = { ...captured, medianMs: 90, p95Ms: 120 };
  assert.equal(selectWebGpuVariant([baseline, unstable]).variant, baseline);
});

test('calibration records are versioned and device-local', () => {
  const storage = memoryStorage();
  const context = { adapterIdentity: 'test|gpu', browserMajor: 150, isolated: true };
  assert.equal(writePocketCalibration(storage, context, { selectedBackend: 'webgpu' }), true);
  assert.equal(readPocketCalibration(storage, context)?.selectedBackend, 'webgpu');
  assert.equal(readPocketCalibration(storage, { ...context, browserMajor: 151 }), null);
});

test('thermal guard stays quiet without enough meaningful samples', () => {
  const short = Array.from({ length: 5 }, () => ({ realTimeFactor: 0.6, audioDurationSec: 10 }));
  assert.equal(evaluateCpuThermalRest(short).rest, false);
  const tiny = Array.from({ length: 12 }, () => ({ realTimeFactor: 0.6, audioDurationSec: 1 }));
  assert.equal(evaluateCpuThermalRest(tiny).rest, false);
});

test('thermal guard rests when recent paragraphs run 70 percent over baseline', () => {
  const history = [
    ...Array.from({ length: 6 }, () => ({ realTimeFactor: 0.6, audioDurationSec: 12 })),
    ...Array.from({ length: 3 }, () => ({ realTimeFactor: 1.1, audioDurationSec: 12 })),
  ];
  const verdict = evaluateCpuThermalRest(history);
  assert.equal(verdict.rest, true);
  assert.equal(verdict.restMs, POCKET_THERMAL_REST_MS);
  assert.ok(verdict.ratio > 1.7);
});

test('thermal guard rests longer past double baseline', () => {
  const history = [
    ...Array.from({ length: 6 }, () => ({ realTimeFactor: 0.6, audioDurationSec: 12 })),
    ...Array.from({ length: 3 }, () => ({ realTimeFactor: 1.3, audioDurationSec: 12 })),
  ];
  const verdict = evaluateCpuThermalRest(history);
  assert.equal(verdict.rest, true);
  assert.equal(verdict.restMs, POCKET_THERMAL_HEAVY_REST_MS);
});

test('thermal guard clears once the device cools back down', () => {
  const history = [
    ...Array.from({ length: 4 }, () => ({ realTimeFactor: 0.6, audioDurationSec: 12 })),
    ...Array.from({ length: 3 }, () => ({ realTimeFactor: 1.0, audioDurationSec: 12 })),
    ...Array.from({ length: 3 }, () => ({ realTimeFactor: 0.65, audioDurationSec: 12 })),
  ];
  assert.equal(evaluateCpuThermalRest(history).rest, false);
});

test('thermal guard re-anchors to a cooler window after a hot start', () => {
  // Device begins hot (resumed cache job), cools, then heats again: the cool
  // middle window must become the baseline so the second heat-up still rests.
  const history = [
    ...Array.from({ length: 4 }, () => ({ realTimeFactor: 1.2, audioDurationSec: 12 })),
    ...Array.from({ length: 4 }, () => ({ realTimeFactor: 0.6, audioDurationSec: 12 })),
    ...Array.from({ length: 3 }, () => ({ realTimeFactor: 1.1, audioDurationSec: 12 })),
  ];
  const verdict = evaluateCpuThermalRest(history);
  assert.equal(verdict.rest, true);
  assert.ok(Math.abs(verdict.baselineRtf - 0.6) < 0.01);
});

test('thermal guard ignores short filler and non-finite samples', () => {
  const history = [
    ...Array.from({ length: 6 }, () => ({ realTimeFactor: 0.6, audioDurationSec: 12 })),
    { realTimeFactor: 9.0, audioDurationSec: 0.4 },
    { realTimeFactor: NaN, audioDurationSec: 12 },
    ...Array.from({ length: 3 }, () => ({ realTimeFactor: 0.62, audioDurationSec: 12 })),
  ];
  assert.equal(evaluateCpuThermalRest(history).rest, false);
});
