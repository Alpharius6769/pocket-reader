import {
  collectPocketDeviceCapability,
  classifyPocketDeviceSupport,
  selectPocketDeviceSetup,
  writePocketDeviceSetup,
  readPocketDeviceSetup,
  wasmThreadCandidates,
  POCKET_DEVICE_SETUP_KEY,
  isIosLikePlatform,
} from './pocket_backend_policy.js?v=backend-v23';

const SETTINGS_RISK_ACK_KEY = 'pr_settings_risk_ack_v1';
const SUPPORT_NOTICE_KEY = 'pr_device_support_notice_v2';
const PROFILE_HANDOFF_KEY = 'pr_device_profile_handoff_v1';
const CPU_TOTAL_ITERATIONS = 8_000_000;
const CPU_SAMPLES = 2;
let diagnosticsInFlight = null;
let activePocketModal = null;
let modalRestoreFocus = null;

function modalFocusableElements(modal) {
  return [...modal.querySelectorAll(
    'button:not([disabled]):not([hidden]), input:not([disabled]):not([type="hidden"]), '
    + 'select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hidden && element.getClientRects().length > 0);
}

function isolateModalSiblings(modal, active) {
  const parent = modal?.parentElement;
  if (!parent) return;
  [...parent.children].forEach((sibling) => {
    if (sibling === modal || !(sibling instanceof HTMLElement)) return;
    if (active) {
      if (!sibling.hasAttribute('data-pocket-modal-muted')) {
        sibling.dataset.pocketPrevInert = sibling.hasAttribute('inert') ? 'true' : 'false';
        sibling.dataset.pocketPrevAriaHidden = sibling.getAttribute('aria-hidden') ?? '__none__';
        sibling.setAttribute('data-pocket-modal-muted', 'true');
      }
      sibling.setAttribute('inert', '');
      sibling.setAttribute('aria-hidden', 'true');
    } else if (sibling.hasAttribute('data-pocket-modal-muted')) {
      if (sibling.dataset.pocketPrevInert !== 'true') sibling.removeAttribute('inert');
      const previousAria = sibling.dataset.pocketPrevAriaHidden;
      if (previousAria === '__none__') sibling.removeAttribute('aria-hidden');
      else if (previousAria != null) sibling.setAttribute('aria-hidden', previousAria);
      delete sibling.dataset.pocketPrevInert;
      delete sibling.dataset.pocketPrevAriaHidden;
      sibling.removeAttribute('data-pocket-modal-muted');
    }
  });
}

function trapPocketModalFocus(event) {
  if (!activePocketModal || event.key !== 'Tab') return;
  const focusable = modalFocusableElements(activePocketModal);
  if (!focusable.length) {
    event.preventDefault();
    activePocketModal.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function activatePocketModal(modal, initialFocusSelector = '') {
  if (!modal) return false;
  if (activePocketModal && activePocketModal !== modal) deactivatePocketModal(activePocketModal);
  activePocketModal = modal;
  modalRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.hidden = false;
  modal.removeAttribute('inert');
  modal.setAttribute('aria-hidden', 'false');
  modal.style.display = 'flex';
  isolateModalSiblings(modal, true);
  document.removeEventListener('keydown', trapPocketModalFocus, true);
  document.addEventListener('keydown', trapPocketModalFocus, true);
  requestAnimationFrame(() => {
    const initial = initialFocusSelector ? modal.querySelector(initialFocusSelector) : null;
    const target = initial || modalFocusableElements(modal)[0] || modal;
    if (!target.hasAttribute('tabindex') && target === modal) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  });
  return true;
}
window.activatePocketModal = activatePocketModal;

export function deactivatePocketModal(modal = activePocketModal) {
  if (!modal) return;
  isolateModalSiblings(modal, false);
  modal.setAttribute('aria-hidden', 'true');
  document.removeEventListener('keydown', trapPocketModalFocus, true);
  if (activePocketModal === modal) activePocketModal = null;
  const restore = modalRestoreFocus;
  modalRestoreFocus = null;
  if (restore?.isConnected) requestAnimationFrame(() => restore.focus({ preventScroll: true }));
}
window.deactivatePocketModal = deactivatePocketModal;

function setSetupText(id, text) {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setSetupProgress(percent, label) {
  const fill = document.getElementById('device-setup-progress-fill');
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  setSetupText('device-setup-status', label);
}

function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function workerRound(workers, iterations, round) {
  const startedAt = performance.now();
  return Promise.all(workers.map((worker, index) => new Promise((resolve, reject) => {
    const id = `${round}-${index}-${Math.random().toString(36).slice(2)}`;
    const timeout = setTimeout(() => reject(new Error('CPU probe timed out.')), 8000);
    const onMessage = (event) => {
      if (event.data?.id !== id) return;
      clearTimeout(timeout);
      worker.removeEventListener('message', onMessage);
      resolve(event.data);
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ id, iterations, seed: index + round * 17 + 1 });
  }))).then(() => performance.now() - startedAt);
}

async function benchmarkCpuWidth(threads) {
  const workers = Array.from({ length: threads }, () => (
    new Worker('assets/js/device_benchmark_worker.js?v=device-bench-v1')
  ));
  try {
    await workerRound(workers, 120_000, 0);
    const iterations = Math.max(250_000, Math.ceil(CPU_TOTAL_ITERATIONS / threads));
    const samples = [];
    for (let sample = 0; sample < CPU_SAMPLES; sample++) {
      samples.push(await workerRound(workers, iterations, sample + 1));
    }
    return {
      threads,
      medianMs: percentile(samples, 0.5),
      p95Ms: percentile(samples, 0.95),
      failures: 0,
      samples: samples.map((value) => Number(value.toFixed(2))),
    };
  } catch (error) {
    return { threads, medianMs: null, p95Ms: null, failures: 1, reason: error?.message || String(error) };
  } finally {
    workers.forEach((worker) => worker.terminate());
  }
}

async function benchmarkCpu(capability, onStep) {
  const candidates = wasmThreadCandidates({
    // The production cache session establishes isolation before loading ORT.
    // Multiple disposable workers let first launch simulate that x1/x2/x4
    // scaling without forcing the profile/OAuth page itself into COOP mode.
    crossOriginIsolated: true,
    hardwareConcurrency: capability.hardwareConcurrency,
    platform: capability.platform,
    userAgent: navigator.userAgent || '',
    lowMemoryMode: capability.lowMemoryMode,
  }).filter((threads) => threads <= 4 && (capability.platform !== 'ios' || threads <= 2));
  const results = [];
  for (let index = 0; index < candidates.length; index++) {
    onStep?.(candidates[index], index, candidates.length);
    results.push(await benchmarkCpuWidth(candidates[index]));
  }
  return results;
}

async function submitGpuProbe(device, pipeline, bindGroup, workgroups) {
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  for (let i = 0; i < 4; i++) pass.dispatchWorkgroups(workgroups);
  pass.end();
  const startedAt = performance.now();
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  return performance.now() - startedAt;
}

async function benchmarkWebGpu(capability) {
  if (capability.platform === 'ios') {
    return { supported: false, medianMs: null, reason: 'ONNX Runtime WebGPU is unavailable in iOS browsers.' };
  }
  if (!navigator.gpu?.requestAdapter) {
    return { supported: false, medianMs: null, reason: 'WebGPU is unavailable in this browser.' };
  }
  let device = null;
  let output = null;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { supported: false, medianMs: null, reason: 'No WebGPU adapter was returned.' };
    if (!adapter.features?.has('shader-f16')) {
      return { supported: false, medianMs: null, reason: 'The GPU does not expose safe FP16 shader support.' };
    }
    device = await adapter.requestDevice({ requiredFeatures: ['shader-f16'] });
    const elementCount = 131_072;
    output = device.createBuffer({
      size: elementCount * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const module = device.createShaderModule({ code: `
      enable f16;
      @group(0) @binding(0) var<storage, read_write> output: array<f32>;
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        if (id.x >= ${elementCount}u) { return; }
        var x = f16(f32((id.x % 251u) + 1u) * 0.00390625);
        for (var i = 0u; i < 64u; i = i + 1u) {
          x = x * f16(0.9990234375) + f16(0.0009765625);
        }
        output[id.x] = f32(x);
      }
    ` });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: output } }],
    });
    const workgroups = Math.ceil(elementCount / 64);
    await submitGpuProbe(device, pipeline, bindGroup, workgroups);
    const samples = [];
    for (let sample = 0; sample < 3; sample++) {
      samples.push(await submitGpuProbe(device, pipeline, bindGroup, workgroups));
    }
    return {
      supported: true,
      medianMs: Number(percentile(samples, 0.5).toFixed(2)),
      p95Ms: Number(percentile(samples, 0.95).toFixed(2)),
      samples: samples.map((value) => Number(value.toFixed(2))),
      interrupted: false,
    };
  } catch (error) {
    return { supported: false, medianMs: null, interrupted: true, reason: error?.message || String(error) };
  } finally {
    try { output?.destroy(); } catch (_) {}
    try { device?.destroy(); } catch (_) {}
  }
}

function benchmarkPassed(cpuResults) {
  const valid = cpuResults.filter((result) => !result.failures && Number.isFinite(result.medianMs));
  if (!valid.length) return false;
  return Math.min(...valid.map((result) => result.medianMs)) <= 250;
}

function resultLabel(record) {
  if (!record) return 'Diagnostics have not run on this device.';
  const platform = record.capability?.platform === 'ios'
    ? 'iPhone / iPad'
    : record.capability?.platform === 'android' ? 'Android' : 'Desktop';
  const backend = record.recommendedBackend === 'webgpu'
    ? 'WebGPU FP16'
    : `WASM x${record.wasmThreads || 1}`;
  const support = record.support?.status === 'supported'
    ? 'officially supported'
    : record.support?.status === 'benchmark-qualified'
      ? 'qualified by local benchmark'
      : 'conservative support profile';
  return `${platform} · ${backend} · ${support}`;
}

export async function runPocketDeviceDiagnostics({ onboarding = false } = {}) {
  if (diagnosticsInFlight) return diagnosticsInFlight;
  diagnosticsInFlight = (async () => {
    if (onboarding) localStorage.setItem(PROFILE_HANDOFF_KEY, 'pending');
    setSetupProgress(10, 'Reading privacy-safe browser hardware signals...');
    const capability = await collectPocketDeviceCapability({
      storage: localStorage,
      model: window.POCKET_READER_DEVICE_MODEL || '',
      lowMemoryMode: window.userProfile?.settings?.lowMemoryMode === true,
    });

    const cpuResults = await benchmarkCpu(capability, (threads, index, total) => {
      const percent = 25 + Math.round((index / Math.max(1, total)) * 35);
      setSetupProgress(percent, `Testing WASM x${threads} scaling...`);
    });
    const passed = benchmarkPassed(cpuResults);
    let support = classifyPocketDeviceSupport({
      ...capability,
      userAgent: navigator.userAgent || '',
      model: capability.model,
      deviceMemory: capability.deviceMemoryGb,
      benchmarkPassed: passed,
    });

    setSetupProgress(70, 'Testing WebGPU FP16 safely...');
    const webgpu = await benchmarkWebGpu(capability);
    support = classifyPocketDeviceSupport({
      ...capability,
      userAgent: navigator.userAgent || '',
      model: capability.model,
      deviceMemory: capability.deviceMemoryGb,
      benchmarkPassed: passed,
    });
    const selection = selectPocketDeviceSetup({
      capability,
      support,
      cpuResults,
      webgpu,
      crossOriginIsolated: window.crossOriginIsolated === true,
      simulateThreadedWasm: true,
      userAgent: navigator.userAgent || '',
    });
    const record = writePocketDeviceSetup(localStorage, {
      capability,
      support,
      cpuResults,
      webgpu,
      ...selection,
      benchmarkPassed: passed,
      crossOriginIsolated: window.crossOriginIsolated === true,
      ranAt: Date.now(),
      localOnly: true,
    });
    window._pocketDeviceSetup = record;
    setSetupProgress(100, 'Device setup complete.');
    setSetupText('device-setup-result', resultLabel(record));
    const continueButton = document.getElementById('device-setup-continue-btn');
    if (continueButton) continueButton.hidden = false;
    const startButton = document.getElementById('device-setup-start-btn');
    if (startButton) startButton.hidden = true;
    renderPocketDeviceSetupSummary();
    window.refreshPocketDeviceCapability?.().catch(() => {});
    if (!onboarding && typeof window.showSettingsModal === 'function') {
      window.showSettingsModal('Device diagnostics complete', `<p>${resultLabel(record)}</p><p>The recommendation is stored only on this device.</p>`);
    }
    return record;
  })().finally(() => { diagnosticsInFlight = null; });
  return diagnosticsInFlight;
}

window.startPocketDeviceSetup = () => runPocketDeviceDiagnostics({ onboarding: true }).catch((error) => {
  setSetupProgress(100, 'The benchmark could not finish; safe WASM settings will be used.');
  const capability = { platform: isIosLikePlatform(navigator.userAgent || '') ? 'ios' : 'mobile', constrained: true, memorySafeInference: true };
  const support = { status: 'unverified', awayModeRecommended: true, reason: error?.message || String(error) };
  const record = writePocketDeviceSetup(localStorage, {
    capability, support, recommendedBackend: 'wasm', wasmThreads: 1,
    benchmarkPassed: false, crossOriginIsolated: window.crossOriginIsolated === true,
    localOnly: true, error: error?.message || String(error),
  });
  window._pocketDeviceSetup = record;
  setSetupText('device-setup-result', resultLabel(record));
  const continueButton = document.getElementById('device-setup-continue-btn');
  if (continueButton) continueButton.hidden = false;
});

function showFirstTimeProfileSetup() {
  const profileSetup = document.getElementById('first-time-setup-modal');
  if (!profileSetup) return false;
  document.documentElement.classList.remove('pr-setup-complete');
  activatePocketModal(profileSetup, '#setup-username');
  window.restoreSetupDraft?.();
  return true;
}
window.showFirstTimeProfileSetup = showFirstTimeProfileSetup;

window.continuePocketDeviceSetup = () => {
  document.documentElement.classList.add('pr-device-setup-complete');
  const modal = document.getElementById('device-setup-modal');
  if (modal) {
    deactivatePocketModal(modal);
    modal.style.display = 'none';
  }
  if (localStorage.getItem(PROFILE_HANDOFF_KEY) === 'pending' || localStorage.getItem('pr_setup_complete') !== 'true') {
    if (!showFirstTimeProfileSetup()) {
      setTimeout(showFirstTimeProfileSetup, 100);
    }
  } else {
    setTimeout(() => window.maybeShowDeviceSupportNotice?.(), 200);
  }
};

requestAnimationFrame(() => {
  const modal = document.getElementById('device-setup-modal');
  if (modal && getComputedStyle(modal).display !== 'none') {
    activatePocketModal(modal, '#device-setup-start-btn');
  }
});

window.runPocketDeviceDiagnosticsFromSettings = (button) => {
  if (button) button.disabled = true;
  runPocketDeviceDiagnostics({ onboarding: false })
    .catch((error) => window.showSettingsModal?.('Device diagnostics failed', `<p>${escapeHtml(String(error?.message || error))}</p>`))
    .finally(() => { if (button) button.disabled = false; });
};

export function renderPocketDeviceSetupSummary() {
  const record = readPocketDeviceSetup(localStorage);
  setSetupText('device-setup-settings-summary', resultLabel(record));
}
window.renderPocketDeviceSetupSummary = renderPocketDeviceSetupSummary;

window.maybeShowDeviceSupportNotice = () => {
  const record = readPocketDeviceSetup(localStorage);
  if (!record?.support?.awayModeRecommended) return false;
  if (localStorage.getItem(SUPPORT_NOTICE_KEY) === 'shown') return false;
  localStorage.setItem(SUPPORT_NOTICE_KEY, 'shown');
  const reason = record.support.reason || 'This phone could not be verified at the current support floor.';
  window.showSettingsModal?.('Away Mode recommended for this phone', `
    <p><strong>${escapeHtml(reason)}</strong></p>
    <p>Live narration may be slow or may be interrupted under memory pressure. For most stories, queue them and use Away Mode while Pocket Reader remains open; cached playback is much lighter on the phone.</p>
    <p>This is a recommendation, not a lock. You can still use live narration and change device settings.</p>`);
  return true;
};

function settingsRiskAccepted() {
  try { return localStorage.getItem(SETTINGS_RISK_ACK_KEY) === 'accepted'; } catch (_) { return false; }
}

function openAdvancedSettings() {
  const advanced = document.getElementById('advanced-settings-section');
  if (!advanced) return;
  advanced.open = true;
  requestAnimationFrame(() => advanced.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }));
}

function showSettingsRiskWarning() {
  if (document.getElementById('settings-risk-accept')) {
    document.getElementById('settings-modal-overlay')?.classList.add('active');
    return;
  }
  const body = `
    <p><strong>Changing Pocket Reader settings can make narration slower, unstable, silent, or cause the app to crash.</strong></p>
    <p>App behavior cannot be predicted when settings are changed without understanding their effects. The app creator is not responsible for the outcome of manual changes. You can always run diagnostics, clear storage or data, or hard refresh without accepting this warning.</p>
    <label class="settings-risk-check"><input id="settings-risk-checkbox" type="checkbox"> I understand and accept this risk.</label>
    <button id="settings-risk-accept" class="pr-btn-primary" type="button" disabled>Accept and unlock settings</button>`;
  window.showSettingsModal?.('Before changing advanced settings', body);
}

// The production modal coordinator may mount dialog content after an async
// queue delay. Delegation keeps the acknowledgement reliable no matter when
// those controls enter the DOM (and avoids a short listener retry window).
function handleSettingsRiskChange(event) {
  if (event.target?.id !== 'settings-risk-checkbox') return;
  const accept = document.getElementById('settings-risk-accept');
  if (accept) accept.disabled = !event.target.checked;
}

function handleSettingsRiskAccept(event) {
  if (!event.target?.closest?.('#settings-risk-accept')) return;
  const checkbox = document.getElementById('settings-risk-checkbox');
  if (!checkbox?.checked) return;
  localStorage.setItem(SETTINGS_RISK_ACK_KEY, 'accepted');
  document.getElementById('settings-modal-overlay')?.classList.remove('active');
  openAdvancedSettings();
}

function interceptAdvancedSettingsOpen(event) {
  const summary = event.target?.closest?.('#advanced-settings-section > summary');
  if (!summary) return;
  const advanced = summary.parentElement;
  if (!advanced || advanced.open || settingsRiskAccepted()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  showSettingsRiskWarning();
}

document.addEventListener('click', interceptAdvancedSettingsOpen, true);
document.addEventListener('change', handleSettingsRiskChange, true);
document.addEventListener('click', handleSettingsRiskAccept, true);

window._pocketDeviceSetup = readPocketDeviceSetup(localStorage);
if (window._pocketDeviceSetup) document.documentElement.classList.add('pr-device-setup-complete');
if (window._pocketDeviceSetup && localStorage.getItem(PROFILE_HANDOFF_KEY) === 'pending') {
  document.documentElement.classList.remove('pr-setup-complete');
  setTimeout(showFirstTimeProfileSetup, 0);
}
const setupStartButton = document.getElementById('device-setup-start-btn');
if (setupStartButton) {
  setupStartButton.disabled = false;
  setupStartButton.removeAttribute('aria-busy');
  if (!window._pocketDeviceSetup) setSetupText('device-setup-status', 'Ready to test this device.');
}
setTimeout(renderPocketDeviceSetupSummary, 0);

export { SETTINGS_RISK_ACK_KEY, SUPPORT_NOTICE_KEY, PROFILE_HANDOFF_KEY, POCKET_DEVICE_SETUP_KEY };
