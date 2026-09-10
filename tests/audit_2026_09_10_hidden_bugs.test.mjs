import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// ── A cancel for a queued job stopped the running one ───────────────────────
//
// The StyleTTS2 cancel handler set cancelRequested unconditionally. Harmless
// while those workers could only hold one job; wrong from the moment they got
// a queue (2026-09-04). The only thing that posts cancel_generation is the main
// thread's per-job timeout, so a cache job timing out WHILE QUEUED behind a
// playback render cancelled the playback render instead. Pocket always gated
// this on the active job id.

for (const file of ['kokoro_worker.js', 'kitten_worker.js', 'pocket_worker.js']) {
  test(`${file}: cancel stops only the job it names`, async () => {
    const worker = await read(`public/assets/js/${file}`);
    const from = worker.indexOf("type === 'cancel_generation'");
    const block = worker.slice(from, worker.indexOf('return;', from));
    assert.match(block, /if \(targetId == null \|\| targetId === activeGenerationJobId\) cancelRequested = true;/);
    assert.ok(!/^\s*cancelRequested = true;\s*$/m.test(block), `${file} still cancels unconditionally`);
  });
}

// ── The timeout counted time spent waiting in the queue ─────────────────────

test('every worker announces when a job actually starts, with its id', async () => {
  for (const file of ['kokoro_worker.js', 'kitten_worker.js']) {
    const worker = await read(`public/assets/js/${file}`);
    assert.match(worker, /self\.postMessage\(\{ type: 'generation_started', id: task\.jobId \}\);/, file);
  }
  const pocket = await read('public/assets/js/pocket_worker.js');
  // It was posted before, without an id, and nothing listened.
  assert.match(pocket, /postMessage\(\{ type: "generation_started", id: jobId \}\);/);
});

test('the main thread restarts a job\'s timeout when the job starts', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  // [^\n]* rather than .*: the file is CRLF, and `.` will not cross the \r.
  assert.match(audio, /\} else if \(data\.type === 'generation_started'\) \{\s*\n(?:\s*\/\/[^\n]*\n)*\s*ttsQueue\[data\.id\]\?\.onStarted\?\.\(\);/);
  assert.match(audio, /if \(ttsQueue\[id\]\) ttsQueue\[id\]\.onStarted = \(\) => \{ started = true; start = Date\.now\(\); \};/);
});

test('a job that has not started can only time out as a dead worker', async () => {
  const audio = await read('public/assets/js/audio_core.js');
  // The render budget is sized to THIS job's text; what it waits behind is
  // sized to something else. A short cache job queued behind a long playback
  // render used to time out without running -- and the timeout's retry path
  // resets the engine, tearing down the render it was waiting on.
  assert.match(audio, /const budgetMs = \(\) => \(started\s*\n\s*\? currentTimeoutMs\(\)\s*\n\s*: Math\.max\(currentTimeoutMs\(\), BACKGROUND_TIMEOUT_MS\)\);/);
  assert.match(audio, /const timeoutMs = budgetMs\(\);/);
  assert.match(audio, /timerObj = setTimeout\(check, Math\.min\(POLL_MS, budgetMs\(\)\)\);/);
  assert.ok(!/const timeoutMs = currentTimeoutMs\(\);/.test(audio), 'the check must use the start-aware budget');
});

// ── A calibration failure the waiter could not recognise ────────────────────
//
// calibrate_backend failed with a bare 'error', which the main thread only
// claimed if the text matched /calibrat|backend|webgpu/. A model download or
// session build dying mid-calibration matched nothing, so backend optimisation
// waited out its 20-minute timeout before falling back.

test('a calibration failure is reported as a calibration failure', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  assert.match(worker, /data\?\.type === "calibrate_backend" \? "calibration_error" : "error"/);
  const audio = await read('public/assets/js/audio_core.js');
  assert.match(audio, /\} else if \(data\.type === 'calibration_error'\s*\n\s*\|\| \(data\.type === 'error' && \/calibrat\|backend\|webgpu\/i\.test\(data\.error \|\| ''\)\)\) \{/);
});

// ── A fallback warning posted to a channel nobody listens on ────────────────

test('the vocoder fallback warning reaches the diagnostic log', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  // The main thread handles 'diagnostic' and has never handled 'log', so the
  // FP16 -> INT8 vocoder drop was reported to nobody.
  assert.ok(!/type: ['"]log['"]/.test(worker), 'no worker message may use the unhandled "log" type');
  assert.match(worker, /postMessage\(\{ type: 'diagnostic', level: 'WARN',\s*\n\s*message: `\$\{asset\}: \$\{filename\} unavailable/);
});

test('pocket_worker posts no reply that nothing handles', async () => {
  const worker = await read('public/assets/js/pocket_worker.js');
  for (const dead of ['voices_loaded', 'model_status', 'generation_cancelled']) {
    assert.ok(!new RegExp(`type: ['"]${dead}['"]`).test(worker), `${dead} is still posted`);
  }
});

// ── Guidance pointing at controls that do not exist ─────────────────────────

test('no caching hint sends the reader to a setting that does not exist', async () => {
  const buf = await read('public/assets/js/buffer_manager.js');
  // enableAMDWorkarounds had no control and no writer anywhere, yet the hint
  // told readers to "Turn it OFF in Settings > Advanced GPU / Worker settings".
  assert.ok(!buf.includes('_maybeAmdHint'));
  assert.ok(!buf.includes('enableAMDWorkarounds'));
  const html = await read('public/index.html');
  assert.ok(!html.includes('Advanced GPU / Worker'), 'that Settings section does not exist');
});

test('motion gating reads the real Data Saver signal, not an unsettable setting', async () => {
  const motion = await read('public/assets/js/cinematic_ui.js');
  assert.ok(!motion.includes('settings.dataSaver'));
  assert.match(motion, /!connection\?\.saveData;/);
});
