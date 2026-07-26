import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectMobilePlatform,
  recommendedWasmThreadCount,
  wasmThreadCandidates,
  evaluateIphoneWebGpuEligibility,
  isMobileWebGpuOptimisticCandidate,
  resolveWasmReferenceRtf,
} from '../public/assets/js/pocket_backend_policy.js';

// User agents representative of the target device spectrum. iOS clamps
// hardwareConcurrency to 4; Android reports the real logical core count.
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 6 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

test('classifies device families from the user agent', () => {
  assert.equal(detectMobilePlatform(IOS_UA), 'ios');
  assert.equal(detectMobilePlatform(ANDROID_UA), 'android');
  assert.equal(detectMobilePlatform(DESKTOP_UA), 'desktop');
  assert.equal(detectMobilePlatform('Mozilla/5.0 (Mobile; rv:120.0)'), 'mobile');
});

test('iPhones are capped at 2 threads despite the clamped hardwareConcurrency of 4', () => {
  // Every iPhone in the target list (13, 13 Pro, 14, 16 Pro, 17) reports 4 cores
  // to Safari but has exactly 2 performance cores.
  for (const cores of [4, 6, 8]) {
    assert.equal(recommendedWasmThreadCount({
      crossOriginIsolated: true, hardwareConcurrency: cores, userAgent: IOS_UA,
    }), 2, `iOS with ${cores} reported cores should use 2 threads`);
  }
  // The candidate ladder still tops out at 4 (isolated), but the recommendation
  // never spills past the 2 performance cores.
  assert.deepEqual(wasmThreadCandidates({ crossOriginIsolated: true, hardwareConcurrency: 4, userAgent: IOS_UA }), [1, 2, 4]);
});

test('flagship Androids (Pixel 6 Pro, Galaxy S21/S21+) use 4 threads', () => {
  assert.equal(recommendedWasmThreadCount({
    crossOriginIsolated: true, hardwareConcurrency: 8, userAgent: ANDROID_UA, memoryGb: 8,
  }), 4);
  const s21 = 'Mozilla/5.0 (Linux; Android 14; SM-G996U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36';
  assert.equal(recommendedWasmThreadCount({
    crossOriginIsolated: true, hardwareConcurrency: 8, userAgent: s21, memoryGb: 8,
  }), 4);
});

test('low-memory and data-saver Androids are capped at 2 threads', () => {
  assert.equal(recommendedWasmThreadCount({
    crossOriginIsolated: true, hardwareConcurrency: 8, userAgent: ANDROID_UA, memoryGb: 4,
  }), 2);
  assert.equal(recommendedWasmThreadCount({
    crossOriginIsolated: true, hardwareConcurrency: 8, userAgent: ANDROID_UA, saveData: true,
  }), 2);
});

test('non-isolated sessions fall back to a single thread on every device', () => {
  for (const userAgent of [IOS_UA, ANDROID_UA, DESKTOP_UA]) {
    assert.equal(recommendedWasmThreadCount({
      crossOriginIsolated: false, hardwareConcurrency: 8, userAgent,
    }), 1);
  }
});

test('desktop keeps the conservative 2-thread default', () => {
  assert.equal(recommendedWasmThreadCount({
    crossOriginIsolated: true, hardwareConcurrency: 8, userAgent: DESKTOP_UA,
  }), 2);
});

test('device spectrum WebGPU policy: iOS unsupported, Android flagship candidates only', () => {
  assert.equal(evaluateIphoneWebGpuEligibility({ iosModel: 'iPhone14,7' }).eligible, true);
  assert.equal(evaluateIphoneWebGpuEligibility({ iosModel: 'iPhone14,2' }).eligible, true);
  assert.equal(isMobileWebGpuOptimisticCandidate({
    userAgent: IOS_UA, iosModel: 'iPhone16,1', crossOriginIsolated: true, hardwareConcurrency: 4,
  }), false);
  assert.equal(isMobileWebGpuOptimisticCandidate({
    userAgent: IOS_UA, iosModel: 'iPhone14,5', crossOriginIsolated: true, hardwareConcurrency: 4,
  }), false);
  assert.equal(isMobileWebGpuOptimisticCandidate({
    userAgent: ANDROID_UA, crossOriginIsolated: true, hardwareConcurrency: 8, memoryGb: 8,
  }), true);
  assert.ok(resolveWasmReferenceRtf({
    userAgent: ANDROID_UA, threads: 4, measuredWasmRtf: 0.77,
  }) === 0.77);
});

test('device simulation helper stays aligned with policy RTF estimates', async () => {
  const { estimateWasmRealTimeFactor } = await import('../public/assets/js/pocket_backend_policy.js');
  const pixel = estimateWasmRealTimeFactor({
    userAgent: ANDROID_UA, crossOriginIsolated: true, hardwareConcurrency: 8, threads: 4,
  });
  const ios = estimateWasmRealTimeFactor({
    userAgent: IOS_UA, crossOriginIsolated: true, hardwareConcurrency: 4, threads: 2,
  });
  assert.ok(pixel > 0 && pixel < 1.2);
  assert.ok(ios > 0 && ios < 1.5);
});
