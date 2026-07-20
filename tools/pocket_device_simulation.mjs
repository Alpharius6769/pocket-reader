// Pocket TTS device optimization simulation.
//
// This harness runs a spectrum of target phones through the REAL backend policy
// (`pocket_backend_policy.js`) to verify the selected backend and WASM thread
// count, then attaches a MODELED performance estimate for INT8 WASM (the mobile
// default) and FP16 WebGPU (capability- and calibration-gated).
//
// The policy decisions are exact. The RTF numbers are a transparent model, not
// on-device measurements: they are anchored to the single real data point we
// have -- a Pixel 6 Pro generating INT8 WASM narration -- and scaled by
// performance-core count and relative single-core throughput. Treat them as
// planning estimates and confirm on hardware with the in-app synth telemetry.
//
// Run: node tools/pocket_device_simulation.mjs

import {
  detectMobilePlatform,
  recommendedWasmThreadCount,
  wasmThreadCandidates,
  isMobileWebGpuOptimisticCandidate,
  evaluateIphoneWebGpuEligibility,
  resolveWasmReferenceRtf,
} from '../pocket_backend_policy.js';

// --- Model anchors -----------------------------------------------------------
// Mimi codec frame rate -> audio seconds per generated frame.
const MS_PER_FRAME_AUDIO = 80; // ~12.5 fps
// Pixel 6 Pro INT8 WASM, single thread, from field logs: 21367ms / 129 frames.
const ANCHOR_MS_PER_FRAME_1T = 165;
// Near-linear WASM SIMD matmul scaling across performance cores (0.85 marginal
// efficiency, 0.15 fixed serial fraction): speedup(1)=1.0, (2)=1.85, (4)=3.55.
const speedup = (n) => n * 0.85 + 0.15;

// Effective speedup for `threads` on a chip with `perfCores` big cores. When
// threads exceed the big cores, the surplus run on ~2.5x-slower E-cores and
// every ORT barrier waits for them, so oversubscription costs ~20% instead of
// helping. This is why iOS (2 perf cores, hardwareConcurrency clamped to 4) and
// budget Androids must not be handed 4 threads.
const OVERSUBSCRIPTION_PENALTY = 0.8;
function effectiveSpeedup(threads, perfCores) {
  if (threads <= perfCores) return speedup(threads);
  return speedup(perfCores) * OVERSUBSCRIPTION_PENALTY;
}

// Relative single-core throughput normalized to the Pixel 6 Pro Cortex-X1 (1.00)
// and relative GPU f16 compute vs the CPU path (lower = the GPU finishes sooner).
const DEVICES = [
  {
    name: 'iPhone 17', tier: 'Flagship', chip: 'A19', gpu: 'Apple GPU',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
    iosModel: 'iPhone18,1', reportedCores: 4, perfCores: 2, relSingleCore: 1.90, memoryGbJS: 0,
    webgpu: { available: false, f16: false }, gpuFactor: null,
  },
  {
    name: 'iPhone 16 Pro', tier: 'Flagship', chip: 'A18 Pro', gpu: 'Apple GPU',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
    iosModel: 'iPhone17,1', reportedCores: 4, perfCores: 2, relSingleCore: 1.75, memoryGbJS: 0,
    webgpu: { available: false, f16: false }, gpuFactor: null,
  },
  {
    name: 'iPhone 14', tier: 'Upper-mid', chip: 'A15', gpu: 'Apple GPU',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
    iosModel: 'iPhone14,7', reportedCores: 4, perfCores: 2, relSingleCore: 1.35, memoryGbJS: 0,
    webgpu: { available: false, f16: false }, gpuFactor: null,
  },
  {
    name: 'iPhone 13 Pro', tier: 'Upper-mid', chip: 'A15', gpu: 'Apple GPU',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
    iosModel: 'iPhone14,2', reportedCores: 4, perfCores: 2, relSingleCore: 1.32, memoryGbJS: 0,
    webgpu: { available: false, f16: false }, gpuFactor: null,
  },
  {
    name: 'iPhone 13', tier: 'Upper-mid', chip: 'A15', gpu: 'Apple GPU',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
    iosModel: 'iPhone14,5', reportedCores: 4, perfCores: 2, relSingleCore: 1.30, memoryGbJS: 0,
    webgpu: { available: false, f16: false }, gpuFactor: null,
  },
  {
    name: 'Galaxy S21+', tier: 'Flagship', chip: 'Snapdragon 888', gpu: 'Adreno 660',
    ua: 'Mozilla/5.0 (Linux; Android 14; SM-G996U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
    reportedCores: 8, perfCores: 4, relSingleCore: 1.05, memoryGbJS: 8,
    webgpu: { available: true, f16: true }, gpuFactor: 0.55,
  },
  {
    name: 'Galaxy S21', tier: 'Flagship', chip: 'Snapdragon 888', gpu: 'Adreno 660',
    ua: 'Mozilla/5.0 (Linux; Android 14; SM-G991U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
    reportedCores: 8, perfCores: 4, relSingleCore: 1.05, memoryGbJS: 8,
    webgpu: { available: true, f16: true }, gpuFactor: 0.55,
  },
  {
    name: 'Pixel 6 Pro', tier: 'Flagship (anchor)', chip: 'Tensor G1', gpu: 'Mali-G78',
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 6 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
    reportedCores: 8, perfCores: 4, relSingleCore: 1.00, memoryGbJS: 8,
    webgpu: { available: true, f16: true }, gpuFactor: 0.75,
  },
  {
    name: 'Moto G Power 5G (2024)', tier: 'Budget', chip: 'Dimensity 7020', gpu: 'IMG BXM-8-256',
    ua: 'Mozilla/5.0 (Linux; Android 14; moto g power 5G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
    reportedCores: 8, perfCores: 2, relSingleCore: 0.55, memoryGbJS: 8,
    webgpu: { available: false, f16: false }, gpuFactor: null,
  },
];

function wasmRtf(device, threads) {
  const msPerFrame = (ANCHOR_MS_PER_FRAME_1T / device.relSingleCore) / effectiveSpeedup(threads, device.perfCores);
  return msPerFrame / MS_PER_FRAME_AUDIO;
}

function webgpuCoolRtf(device, wasmRtfAtThreads) {
  if (!device.webgpu.available || !device.webgpu.f16 || device.gpuFactor == null) return null;
  // Cool-start estimate. Sustained caching thermally throttles mobile GPUs, and
  // the runtime demotes to WASM after two slower-than-real-time paragraphs, so
  // steady-state effectively regresses toward the WASM number.
  return wasmRtfAtThreads * device.gpuFactor;
}

const rows = DEVICES.map((device) => {
  const platform = detectMobilePlatform(device.ua);
  const options = {
    crossOriginIsolated: true,
    hardwareConcurrency: device.reportedCores,
    userAgent: device.ua,
    iosModel: device.iosModel,
    saveData: false,
    memoryGb: device.memoryGbJS,
  };
  const candidates = wasmThreadCandidates(options);
  const threads = recommendedWasmThreadCount(options);
  // ORT WebGPU requires a Chromium WebGPU implementation. All iOS browsers
  // use WebKit and are therefore unsupported even when the SoC itself has
  // ample RAM and fast FP16 compute.
  const browserEligible = device.webgpu.available && device.webgpu.f16 && platform !== 'ios';
  const optimistic = browserEligible && isMobileWebGpuOptimisticCandidate(options);
  const iphoneGate = platform === 'ios' ? evaluateIphoneWebGpuEligibility(options) : null;
  // What a naive min(4, cores) policy (pre-fix) would have picked, to show the
  // performance-core correction.
  const naiveThreads = Math.min(4, device.reportedCores);
  const rtfWasm = wasmRtf(device, threads);
  const rtfPolicy = resolveWasmReferenceRtf({ ...options, threads });
  const rtfNaive = wasmRtf(device, naiveThreads);
  const rtfWebgpu = optimistic ? webgpuCoolRtf(device, rtfWasm) : null;
  return {
    device: device.name, tier: device.tier, chip: device.chip,
    platform, perfCores: device.perfCores, reportedCores: device.reportedCores,
    candidates: candidates.join('/'), threads, naiveThreads, optimistic,
    iphoneEligible: iphoneGate?.eligible ?? null,
    rtfWasm, rtfPolicy, rtfNaive, rtfWebgpu,
    webgpu: optimistic ? 'auto-start (f16)' : (device.webgpu.available ? 'blocked' : 'unsupported'),
  };
});

const f = (n) => (n == null ? '  -  ' : n.toFixed(2).padStart(5));
const chunkSecs = (rtf) => (rtf * 10.3).toFixed(1); // ~10.3s audio per sentence chunk

console.log('\nPocket TTS device optimization matrix (INT8 WASM default, FP16 WebGPU capability-gated)');
console.log('RTF < 1.0 = faster than real time (caches faster than it plays). Modeled, anchored to Pixel 6 Pro.\n');
const header = [
  'Device'.padEnd(24), 'Plat'.padEnd(8), 'Perf'.padEnd(5), 'Thr'.padEnd(4),
  'WASM'.padEnd(6), '~s/chunk'.padEnd(9), 'WebGPU(cool)'.padEnd(13), 'WebGPU', 'naive->fixed',
].join(' ');
console.log(header);
console.log('-'.repeat(header.length + 6));
for (const r of rows) {
  console.log([
    r.device.padEnd(24),
    r.platform.padEnd(8),
    String(r.perfCores).padEnd(5),
    String(r.threads).padEnd(4),
    f(r.rtfWasm).padEnd(6),
    chunkSecs(r.rtfWasm).padEnd(9),
    f(r.rtfWebgpu).padEnd(13),
    r.webgpu.padEnd(14),
    `${r.naiveThreads}t->${r.threads}t (${f(r.rtfNaive)}->${f(r.rtfWasm)})`,
  ].join(' '));
}
console.log('\nJSON:');
console.log(JSON.stringify(rows, null, 2));
