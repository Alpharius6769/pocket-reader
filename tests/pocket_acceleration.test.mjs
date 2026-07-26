import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('Pocket generation does not yield through throttled frame-loop timers', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  assert.doesNotMatch(worker, /step\s*%\s*4[\s\S]{0,120}setTimeout/);
});

test('WASM uses the CPU-only runtime and relaxed SIMD with immutable fallback', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  assert.match(worker, /1\.27\.0-wasm/);
  assert.match(worker, /1\.27\.0-relaxed/);
  assert.match(worker, /supportsRelaxedSimd/);
  assert.match(worker, /WebAssembly\.validate/);
  assert.match(worker, /ort-wasm-relaxedsimd-threaded\.mjs/);
  assert.match(worker, /ort-wasm-relaxedsimd-threaded\.wasm/);
  assert.match(worker, /return\s*\{\s*mjs:/);
  assert.match(worker, /ort\.env\.wasm\.wasmPaths\s*=\s*wasmPaths/);
  assert.match(worker, /simd:\s*'relaxed'/);
  assert.match(worker, /ort\.env\.wasm\.simd\s*=\s*simd/);
  assert.match(worker, /ortWasmRuntimeFlavor/);
  assert.match(worker, /stock-wasm-only/);
  assert.match(worker, /legacy-jsep/);
});

test('English WASM uses the reduced ORT-format runtime with capability fallback', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  assert.match(worker, /1\.27\.0-relaxed-minimal/);
  assert.match(worker, /english_2026-04-ort-r1/);
  assert.match(worker, /relaxed-simd-minimal-ort/);
  assert.match(worker, /supportsRelaxedSimd\(\)/);
  assert.match(worker, /ORT_FORMAT_MODEL_STEMS/);
  assert.match(worker, /flow_lm_unified_block4_int8\.ort/);
  assert.match(worker, /desiredWasmFormat/);
  assert.match(worker, /stock-wasm-only/);
});

test('high-memory desktop cache parallelism is bounded and releases its second worker', async () => {
  const policy = await read('public/assets/js/pocket_backend_policy.js');
  const audio = await read('public/assets/js/audio_core.js');
  const buffer = await read('public/assets/js/buffer_manager.js');
  assert.match(policy, /function recommendedPocketCacheWorkerCount/);
  assert.match(policy, /memoryGb < 8/);
  assert.match(policy, /return 2/);
  assert.match(audio, /preparePocketCacheWorkerPool/);
  assert.match(audio, /trimPocketCacheWorkerPool/);
  assert.match(audio, /const dispatchWorker = workerObj \|\| _selectReadyPocketWorker/);
  assert.match(buffer, /preparePocketCacheWorkerPool/);
  assert.match(buffer, /activeWorkers > 0/);
});

test('WASM block sessions are released during backend reloads', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  assert.match(worker, /releaseSession\(flowLmWasmBlockSession\)/);
});

test('generation reuses fixed-shape input tensors instead of churning them per frame', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  assert.match(worker, /const getMimiInputTensor\s*=/);
  assert.doesNotMatch(worker, /latent:\s*createTensor\(/);
  assert.match(worker, /const webGpuRandomTensor\s*=/);
  assert.match(worker, /const wasmRandomTensor\s*=/);
  assert.match(worker, /const flowLatentInput\s*=/);
});

test('the per-frame flow graph is lazy when the WASM block core is available', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  assert.match(worker, /async function ensureFlowLmFlowSession\(/);
  assert.match(worker, /if \(currentBackend === 'wasm' && !flowLmWasmBlockSession && !flowLmUnifiedSession\)/);
  assert.match(worker, /chunkMeta\.some\(\(meta\) => Number\(meta\?\.lsdSteps/);
  const wasmDescriptors = worker.slice(
    worker.indexOf(': [\n        { asset: \'text_conditioner\''),
    worker.indexOf('if (modelDescriptors.some'),
  );
  assert.doesNotMatch(wasmDescriptors, /asset: 'flow_lm_flow'/);
});

test('iOS and constrained devices use the weight-shared unified WASM core', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  assert.match(worker, /flow_lm_unified_block4_int8\.onnx/);
  assert.match(worker, /preferUnifiedWasmCore/);
  assert.match(worker, /iosWebKit \|\| constrainedMemoryMode/);
  assert.match(worker, /flowLmUnifiedSession\.run/);
  assert.match(worker, /decode_mode/);
  assert.match(worker, /wasm-unified-block4/);
  assert.match(worker, /Unified WASM core unavailable; using split sessions/);
});

test('WebGPU core sessions do not permit mixed WASM fallback', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  const coreOptions = worker.slice(
    worker.indexOf("if (asset !== WEBGPU_BLOCK_ROLE)"),
    worker.indexOf('async function loadBundle'),
  );
  assert.match(coreOptions, /executionProviders:\s*\['webgpu'\]/);
  assert.doesNotMatch(coreOptions, /executionProviders:\s*\['webgpu',\s*'wasm'\]/);
  assert.match(worker, /WEBGPU_MIMI_ROLE[\s\S]{0,700}executionProviders:\s*\['webgpu',\s*'wasm'\]/);
  assert.match(worker, /flow_lm_decode_block4/);
  assert.match(worker, /prefill_provider !== 'wasm-threaded'/);
  assert.match(worker, /mimi_fallback_provider !== 'wasm-threaded'/);
  assert.doesNotMatch(worker, /text_conditioner_fp16\.onnx/);
});

test('WebGPU batches recurrent blocks before CPU synchronization', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  assert.match(worker, /WEBGPU_STEADY_SYNC_BLOCKS\s*=\s*4/);
  assert.match(worker, /preferredOutputLocation\.latents\s*=\s*'gpu-buffer'/);
  assert.match(worker, /preferredOutputLocation\.eos_logits\s*=\s*'gpu-buffer'/);
  assert.match(worker, /getData\(\)/);
  assert.match(worker, /gpuSyncGroupBlocks/);
});

test('graph capture and GPU Mimi are benchmark-gated with strict WebGPU sessions', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  const policy = await read('public/assets/js/pocket_backend_policy.js');
  assert.match(worker, /enableGraphCapture/);
  assert.match(worker, /mimi_decoder_fp16/);
  assert.match(worker, /mimiProvider/);
  assert.match(worker, /executionProviders:\s*\['webgpu'\]/);
  assert.match(policy, /selectWebGpuVariant/);
});

test('mobile auto defaults to threaded WASM; WebGPU remains Settings opt-in', async () => {
  const policy = await read('public/assets/js/pocket_backend_policy.js');
  const audio = await read('public/assets/js/audio_core.js');
  const worker = await read('public/assets/js/pocket_worker.js');
  const buffer = await read('public/assets/js/buffer_manager.js');
  assert.match(policy, /POCKET_MOBILE_OPTIMISTIC_WEBGPU = false/);
  assert.match(policy, /POCKET_DEMOTION_EPOCH = 'e3'/);
  assert.match(policy, /sticky-\$\{POCKET_DEMOTION_EPOCH\}/);
  assert.match(policy, /shouldPreferOptimisticWebGpu/);
  assert.match(policy, /evaluateIphoneWebGpuEligibility/);
  assert.match(policy, /writeWebGpuDemotion/);
  assert.match(policy, /POCKET_IOS_WEBGPU_MIN_GENERATION = 14/);
  assert.match(policy, /Mobile auto defaults to threaded WASM/);
  assert.match(audio, /optimisticAuto: preference === 'auto'/);
  // Retirement filter for records the old never-WebGPU-on-mobile policy wrote.
  assert.match(audio, /Mobile auto defaults to threaded WASM/);
  // Parity demotion compares against the device's MEASURED WASM speed or falls
  // back to the absolute real-time limit — never the modeled estimate.
  assert.match(audio, /measuredWasmRtf\s*=\s*Number\(_pocketCalibration\?\.measuredWasmRtf\)/);
  assert.match(audio, /writeWebGpuDemotion/);
  assert.match(audio, /wasm_rtf_sample/);
  assert.match(audio, /shouldProbeBundle/);
  assert.match(audio, /wasmReferenceRtf: _pocketBackendRuntime\.wasmReferenceRtf/);
  assert.match(audio, /pocket-worker-v43/);
  assert.match(worker, /wasmReferenceRtf/);
  assert.match(worker, /releaseAllSessions/);
  assert.match(worker, /wasm_rtf_sample/);
  assert.match(worker, /POCKET_WEBGPU_WASM_PARITY_RATIO/);
  assert.match(worker, /Never honor a stale requested=1/);
  assert.match(buffer, /_isolationReady/);
  assert.match(buffer, /Slow 1-thread mode/);
  assert.match(buffer, /Threaded WASM/);
  assert.match(buffer, /_pocketThroughputCache = true/);
  assert.match(audio, /throughputMode/);
  assert.match(audio, /tokenSoftCap/);
  assert.match(worker, /POCKET_THROUGHPUT_TOKEN_SOFT_CAP/);
  assert.match(worker, /POCKET_TOKEN_SOFT_CAP = 120/);
});

test('sustained slower-than-real-time WebGPU paragraphs demote to WASM for the session only', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(worker, /shouldDemoteWebGpuSustained/);
  assert.match(worker, /webGpuSustainedHistory/);
  assert.match(worker, /fallbackToWasm\(`WebGPU fell behind/);
  // A sustained/parity miss is only evidence WebGPU lost to WASM on this run's
  // paragraphs (thermal state, a background tab, one long paragraph) — not
  // proof the backend is broken — so it must NOT be written to localStorage.
  // Only a genuine hard failure (crash/OOM/gpu_lost/invalid audio) persists.
  assert.match(audio, /const sustainedOnly = data\.sustained === true;/);
  assert.match(audio, /if \(!sustainedOnly\) \{\s*writeWebGpuDemotion/);
  assert.match(audio, /if \(!sustainedOnly\) writePocketCalibration\(localStorage, _pocketBackendContext, _pocketCalibration\);/);
  assert.match(audio, /if \(!sustainedOnly && _pocketGpuFailureCount >= 3\)/);
});

test('Pocket telemetry exposes punctuation and stage overhead', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  assert.match(worker, /punctuationSplitCount/);
  assert.match(worker, /textConditioningRuns/);
  assert.match(worker, /prefillRuns/);
  assert.match(worker, /gpuReadbacks/);
});

test('narration isolation and streamed PCM assets are versioned together', async () => {
  const serviceWorker = await read('serviceworker.py');
  assert.match(serviceWorker, /pocket-reader-core-v129/);
  assert.match(serviceWorker, /ui_controller\.js\?v=ui-v82/);
  assert.match(serviceWorker, /Cross-Origin-Embedder-Policy', 'require-corp'/);
  assert.match(serviceWorker, /pocket_pcm_worklet\.js\?v=pcm-v1/);
  assert.match(serviceWorker, /pocket_worker\.js\?v=pocket-worker-v43/);
  assert.match(serviceWorker, /pocket_backend_policy\.js\?v=backend-v20/);
  assert.match(serviceWorker, /device_setup\.js\?v=device-setup-v6/);
  assert.match(serviceWorker, /device_benchmark_worker\.js\?v=device-bench-v1/);
  const standardPage = await read('public/standard-page.html');
  assert.match(standardPage, /serviceworker\.js\?v=129/);
});

test('Settings recognizes the active narration service worker revision', async () => {
  const settings = await read('public/assets/js/settings_manager.js');
  assert.match(settings, /NARRATION_SERVICE_WORKER_VERSION\s*=\s*'129'/);
  assert.match(settings, /searchParams\.get\('v'\)\s*===\s*NARRATION_SERVICE_WORKER_VERSION/);
  // ui_controller performs the PRIMARY service-worker registration. Its ?v= MUST
  // match NARRATION_SERVICE_WORKER_VERSION, or narrationServiceWorkerControlsPage()
  // never matches and the SW registration thrashes between versions on every
  // narration start. (This pin closes the gap that let ui_controller drift to
  // ?v=110 while everything else moved to 114.)
  const uiController = await read('public/assets/js/ui_controller.js');
  assert.match(uiController, /serviceworker\.js\?v=129/);
  assert.doesNotMatch(uiController, /serviceworker\.js\?v=(?!129)\d+/);
});

test('mobile playback uses one media-session transport map with seek support', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(audio, /function _bindMediaSessionActions\(\)/);
  assert.match(audio, /bind\('seekto'/);
  assert.match(audio, /setPositionState/);
  assert.match(audio, /_bindMediaElementSession\(_premiumAudio\)/);
  assert.match(audio, /function _preferDirectMobileMediaPlayback\(\)/);
  assert.match(audio, /if \(!_preferDirectMobileMediaPlayback\(\)\) _setupAudioRouting\(_premiumAudio\)/);
  assert.doesNotMatch(audio, /function _setupMediaSession\(/);
});

test('interrupted cache jobs checkpoint locally and only restore on foreground', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  assert.match(buffer, /const CACHE_JOB_RESUME_KEY = 'pr_cache_job_resume_v1'/);
  assert.match(buffer, /function _persistCacheJob/);
  assert.match(buffer, /async restorePersistedJob\(\)/);
  assert.match(buffer, /storyTitles: \[\.\.\.new Set/);
  assert.match(buffer, /await this\.startPrecacheQueue\(\)/);
  assert.match(buffer, /window\.addEventListener\('pagehide'/);
  assert.match(buffer, /document\.visibilityState === 'visible'/);
  assert.match(buffer, /navigator\.wakeLock\.request\('screen'\)/);
});

test('Away Mode guidance explains the queue, start, and resume workflow', async () => {
  const form = await read('public/index.html');
  const buffer = await read('public/assets/js/buffer_manager.js');
  const settings = await read('public/assets/js/settings_manager.js');
  assert.match(form, /Add stories with Queue Away/);
  assert.match(form, /start Away Mode in Library/);
  assert.match(form, /cache job resumes when you return/);
  assert.match(buffer, /Hide Cache Panel/);
  assert.match(settings, /Away Mode:<\/b> Add stories with Queue Away/);
});

test('story subscriptions use explicit AO3 state and push handoff', async () => {
  const library = await read('public/assets/js/library_manager.js');
  const settings = await read('public/assets/js/settings_manager.js');
  const serviceWorker = await read('serviceworker.py');
  const backend = await read('backend/app.py');
  assert.match(library, /window\.toggleStorySubscription/);
  assert.match(library, /window\.checkSubscribedStoryUpdates/);
  assert.match(library, /publishedChapters/);
  assert.match(library, /workComplete/);
  assert.doesNotMatch(library, /entry\.isFinished\s*=\s*entry\.declaredChapters/);
  assert.match(settings, /story\?\.updateSubscribed/);
  assert.match(serviceWorker, /self\.addEventListener\('push'/);
  assert.match(serviceWorker, /story-update/);
  assert.match(backend, /update_subscribed/);
  assert.match(backend, /published_chapters/);
});

test('story menu close handler is initialized before subscription markup', async () => {
  const library = await read('public/assets/js/library_manager.js');
  assert.ok(library.indexOf('const closeMenusJs') < library.indexOf('const subscriptionButton'));
});

test('onboarding drafts survive an authentication reload and sync on completion', async () => {
  const ui = await read('public/assets/js/ui_controller.js');
  assert.match(ui, /SETUP_AUTH_STORAGE_KEY/);
  assert.match(ui, /_restoreFirstTimeSetupState/);
  assert.match(ui, /localStorage\.setItem\(SETUP_AUTH_STORAGE_KEY/);
  assert.match(ui, /queueCloudSync\('onboarding-complete'/);
});

test('calibration quality compares medians across all timed trials', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  const policy = await read('public/assets/js/pocket_backend_policy.js');
  assert.match(worker, /durationSeconds\.push/);
  assert.match(worker, /durationSec:\s*percentile\(durationSeconds,\s*0\.5\)/);
  assert.match(worker, /rms:\s*percentile\(rmsValues,\s*0\.5\)/);
  assert.doesNotMatch(worker, /let quality = null/);
  assert.match(policy, /POCKET_CALIBRATION_VERSION = 'cal-v12'/);
});

test('WebGPU auto-selection targets the certified R3 bundle', async () => {
  const policy = await read('public/assets/js/pocket_backend_policy.js');
  assert.match(policy, /english_2026-04-webgpu-fp16-r3/);
  assert.doesNotMatch(policy, /POCKET_WEBGPU_BUNDLE\s*=\s*'english_2026-04-webgpu-fp16';/);
});

test('Cloudflare publishes immutable R3 assets with revision metadata', async () => {
  const worker = await read('worker/cloudflare_worker.js');
  assert.match(worker, /english_2026-04-webgpu-fp16-r3/);
  assert.match(worker, /X-Asset-Revision", "english-2026-04-fp16-r3/);
  assert.match(worker, /max-age=31536000, immutable/);
});

test('constrained caching prompts once and never performs full-story voice prefetch', async () => {
  const buffer = await read('public/assets/js/buffer_manager.js');
  assert.match(buffer, /Continue safely/);
  assert.match(buffer, /Enable expressive anyway/);
  assert.match(buffer, /writePocketExpressiveChoice/);
  assert.match(buffer, /isPocketDeviceConstrained/);
  assert.match(buffer, /_prefetchNextVoice/);
  assert.match(buffer, /shouldPocketPrefetchFullStoryVoices/);
  assert.match(buffer, /isPocketDeviceMemorySafeMode/);
});

test('constrained workers retain only current and next expressive voices', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  const worker = await read('public/assets/js/pocket_worker.js');
  assert.match(audio, /constrainedMemoryMode/);
  assert.match(audio, /voice_evicted/);
  assert.match(worker, /MAX_CONSTRAINED_CUSTOM_VOICES\s*=\s*2/);
  assert.match(worker, /evictConstrainedCustomVoices/);
  assert.match(worker, /voice_evicted/);
  assert.match(worker, /disposeGpuState/);
});

test('device capability probe records privacy-bucketed browser and TTS evidence', async () => {
  const policy = await read('public/assets/js/pocket_backend_policy.js');
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(policy, /getHighEntropyValues/);
  assert.match(policy, /requestAdapter/);
  assert.match(policy, /hardwareConcurrency/);
  assert.match(policy, /deviceMemory/);
  assert.match(policy, /platformVersion/);
  assert.match(audio, /recordPocketTtsCalibration/);
  assert.match(audio, /initializationMs/);
  assert.match(audio, /realTimeFactor/);
});
