// Layman caching-time expectations for Pocket TTS on phones.
// Anchored to Pixel 6 Pro field data (~4s/sentence chunk on 4-thread WASM)
// and scaled by the same performance model as pocket_device_simulation.mjs.
//
// Assumptions (stated in the user-facing guide):
// - Average paragraph ~ 2.5 sentence chunks ~ ~20s of spoken audio
// - Sustained caching uses the steady backend (WASM after WebGPU demotion,
//   or WASM-only on gated phones). Cool WebGPU may be faster for the first
//   few paragraphs only.
// - "Begin Playback" unlocks after 30 cached paragraphs
// - First-ever session may add model/voice download time (not included below)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MS_PER_FRAME_AUDIO = 80;
const ANCHOR_MS_PER_FRAME_1T = 165; // Pixel 6 Pro 1-thread field
const CHUNKS_PER_PARAGRAPH = 2.5;
const AUDIO_SEC_PER_CHUNK = 10.3;
const PLAYBACK_UNLOCK_PARAS = 30;

const speedup = (n) => n * 0.85 + 0.15;
const OVERSUB = 0.8;
function effectiveSpeedup(threads, perfCores) {
  if (threads <= perfCores) return speedup(threads);
  return speedup(perfCores) * OVERSUB;
}

function paraSec(relSingleCore, threads, perfCores) {
  const msPerFrame = (ANCHOR_MS_PER_FRAME_1T / relSingleCore) / effectiveSpeedup(threads, perfCores);
  const rtf = msPerFrame / MS_PER_FRAME_AUDIO;
  const chunkSec = rtf * AUDIO_SEC_PER_CHUNK;
  return chunkSec * CHUNKS_PER_PARAGRAPH;
}

function fmtMin(sec) {
  if (sec < 90) return `${Math.round(sec)} sec`;
  const m = sec / 60;
  if (m < 60) return `${m < 10 ? m.toFixed(1) : Math.round(m)} min`;
  const h = Math.floor(m / 60);
  const rm = Math.round(m % 60);
  return `${h}h ${rm}m`;
}

const DEVICES = [
  // iPhone 12–17
  { family: 'iPhone', name: 'iPhone 12 / 12 mini', gen: 12, variant: 'base', backend: 'WASM x2', threads: 2, perf: 2, rel: 1.15, note: 'WASM only (pre-14)' },
  { family: 'iPhone', name: 'iPhone 12 Pro / Pro Max', gen: 12, variant: 'pro', backend: 'WASM x2', threads: 2, perf: 2, rel: 1.18, note: 'WASM only (pre-14)' },
  { family: 'iPhone', name: 'iPhone 13 / 13 mini', gen: 13, variant: 'base', backend: 'WASM x2', threads: 2, perf: 2, rel: 1.30, note: 'WASM only (pre-14)' },
  { family: 'iPhone', name: 'iPhone 13 Pro / Pro Max', gen: 13, variant: 'pro', backend: 'WASM x2', threads: 2, perf: 2, rel: 1.32, note: 'WASM only (pre-14)' },
  { family: 'iPhone', name: 'iPhone 14 / 14 Plus', gen: 14, variant: 'base', backend: 'WebGPU then WASM x2', threads: 2, perf: 2, rel: 1.35, note: 'WebGPU auto-start, then WASM if it throttles' },
  { family: 'iPhone', name: 'iPhone 14 Pro / Pro Max', gen: 14, variant: 'pro', backend: 'WebGPU then WASM x2', threads: 2, perf: 2, rel: 1.40, note: 'WebGPU auto-start, then WASM if it throttles' },
  { family: 'iPhone', name: 'iPhone 15 / 15 Plus', gen: 15, variant: 'base', backend: 'WebGPU then WASM x2', threads: 2, perf: 2, rel: 1.50, note: 'WebGPU auto-start, then WASM if it throttles' },
  { family: 'iPhone', name: 'iPhone 15 Pro / Pro Max', gen: 15, variant: 'pro', backend: 'WebGPU then WASM x2', threads: 2, perf: 2, rel: 1.60, note: 'WebGPU auto-start, then WASM if it throttles' },
  { family: 'iPhone', name: 'iPhone 16 / 16 Plus', gen: 16, variant: 'base', backend: 'WebGPU then WASM x2', threads: 2, perf: 2, rel: 1.70, note: 'WebGPU auto-start, then WASM if it throttles' },
  { family: 'iPhone', name: 'iPhone 16 Pro / Pro Max', gen: 16, variant: 'pro', backend: 'WebGPU then WASM x2', threads: 2, perf: 2, rel: 1.75, note: 'WebGPU auto-start, then WASM if it throttles' },
  { family: 'iPhone', name: 'iPhone 17 / 17 Air (est.)', gen: 17, variant: 'base', backend: 'WebGPU then WASM x2', threads: 2, perf: 2, rel: 1.85, note: 'Estimated from A19 class' },
  { family: 'iPhone', name: 'iPhone 17 Pro / Pro Max (est.)', gen: 17, variant: 'pro', backend: 'WebGPU then WASM x2', threads: 2, perf: 2, rel: 1.90, note: 'Estimated from A19 Pro class' },

  // Samsung flagship ~2020-2026
  { family: 'Samsung flagship', name: 'Galaxy S20 / S20+', gen: 2020, variant: 'flagship', backend: 'WASM x4', threads: 4, perf: 4, rel: 0.85, note: 'Older flagship; WASM path' },
  { family: 'Samsung flagship', name: 'Galaxy S21 / S21+', gen: 2021, variant: 'flagship', backend: 'WebGPU then WASM x4', threads: 4, perf: 4, rel: 1.05, note: 'WebGPU auto-start when available' },
  { family: 'Samsung flagship', name: 'Galaxy S22 / S22+', gen: 2022, variant: 'flagship', backend: 'WebGPU then WASM x4', threads: 4, perf: 4, rel: 1.15, note: 'WebGPU auto-start when available' },
  { family: 'Samsung flagship', name: 'Galaxy S23 / S23+', gen: 2023, variant: 'flagship', backend: 'WebGPU then WASM x4', threads: 4, perf: 4, rel: 1.35, note: 'WebGPU auto-start when available' },
  { family: 'Samsung flagship', name: 'Galaxy S24 / S24+', gen: 2024, variant: 'flagship', backend: 'WebGPU then WASM x4', threads: 4, perf: 4, rel: 1.50, note: 'WebGPU auto-start when available' },
  { family: 'Samsung flagship', name: 'Galaxy S25 / S25+ (est.)', gen: 2025, variant: 'flagship', backend: 'WebGPU then WASM x4', threads: 4, perf: 4, rel: 1.65, note: 'Estimated' },

  // Samsung midrange ~2020-2026
  { family: 'Samsung midrange', name: 'Galaxy A51 / A71 (2020)', gen: 2020, variant: 'mid', backend: 'WASM x2', threads: 2, perf: 2, rel: 0.40, note: 'Budget path; no WebGPU auto-start' },
  { family: 'Samsung midrange', name: 'Galaxy A52 / A72 (2021)', gen: 2021, variant: 'mid', backend: 'WASM x2', threads: 2, perf: 2, rel: 0.48, note: 'Budget path; no WebGPU auto-start' },
  { family: 'Samsung midrange', name: 'Galaxy A53 / A73 (2022)', gen: 2022, variant: 'mid', backend: 'WASM x2', threads: 2, perf: 2, rel: 0.52, note: 'Budget path; no WebGPU auto-start' },
  { family: 'Samsung midrange', name: 'Galaxy A54 / A34 (2023)', gen: 2023, variant: 'mid', backend: 'WASM x2', threads: 2, perf: 2, rel: 0.58, note: 'Budget path; no WebGPU auto-start' },
  { family: 'Samsung midrange', name: 'Galaxy A55 / A35 (2024)', gen: 2024, variant: 'mid', backend: 'WASM x2', threads: 2, perf: 2, rel: 0.65, note: 'Budget path; no WebGPU auto-start' },
  { family: 'Samsung midrange', name: 'Galaxy A56 (2025 est.)', gen: 2025, variant: 'mid', backend: 'WASM x2', threads: 2, perf: 2, rel: 0.72, note: 'Budget path; no WebGPU auto-start' },

  // Pixel 6 Pro and above
  { family: 'Pixel', name: 'Pixel 6 / 6 Pro', gen: 2021, variant: 'flagship', backend: 'WebGPU then WASM x4', threads: 4, perf: 4, rel: 1.00, note: 'Field anchor phone' },
  { family: 'Pixel', name: 'Pixel 7 / 7 Pro', gen: 2022, variant: 'flagship', backend: 'WebGPU then WASM x4', threads: 4, perf: 4, rel: 1.15, note: 'WebGPU auto-start when available' },
  { family: 'Pixel', name: 'Pixel 8 / 8 Pro', gen: 2023, variant: 'flagship', backend: 'WebGPU then WASM x4', threads: 4, perf: 4, rel: 1.35, note: 'WebGPU auto-start when available' },
  { family: 'Pixel', name: 'Pixel 9 / 9 Pro', gen: 2024, variant: 'flagship', backend: 'WebGPU then WASM x4', threads: 4, perf: 4, rel: 1.50, note: 'WebGPU auto-start when available' },
  { family: 'Pixel', name: 'Pixel 10 / 10 Pro (est.)', gen: 2025, variant: 'flagship', backend: 'WebGPU then WASM x4', threads: 4, perf: 4, rel: 1.65, note: 'Estimated' },

  // Other comparable Android
  { family: 'Other Android', name: 'OnePlus 9 / 9 Pro (2021)', gen: 2021, variant: 'flagship', backend: 'WebGPU then WASM x4', threads: 4, perf: 4, rel: 1.05, note: 'Snapdragon 888 class' },
  { family: 'Other Android', name: 'OnePlus 11 / 12 (2023-24)', gen: 2024, variant: 'flagship', backend: 'WebGPU then WASM x4', threads: 4, perf: 4, rel: 1.45, note: 'Recent flagship Android' },
  { family: 'Other Android', name: 'Xiaomi 13 / 14 (2023-24)', gen: 2024, variant: 'flagship', backend: 'WebGPU then WASM x4', threads: 4, perf: 4, rel: 1.45, note: 'Recent flagship Android' },
  { family: 'Other Android', name: 'Moto G Power 5G (2024)', gen: 2024, variant: 'budget', backend: 'WASM x2-4', threads: 4, perf: 2, rel: 0.55, note: 'Budget; slower sustained caching' },
  { family: 'Other Android', name: 'Nothing Phone (2a) / midrange', gen: 2024, variant: 'mid', backend: 'WASM x2', threads: 2, perf: 2, rel: 0.60, note: 'Midrange; WASM path' },
];

const rows = DEVICES.map((d) => {
  const sec = paraSec(d.rel, d.threads, d.perf);
  // Round to friendly bands for layman reading
  const low = Math.max(6, Math.round(sec * 0.85));
  const high = Math.round(sec * 1.25);
  const unlockSec = ((low + high) / 2) * PLAYBACK_UNLOCK_PARAS;
  return {
    family: d.family,
    name: d.name,
    backend: d.backend,
    paraLow: low,
    paraHigh: high,
    unlock: fmtMin(unlockSec),
    story100: fmtMin(((low + high) / 2) * 100),
    story250: fmtMin(((low + high) / 2) * 250),
    story500: fmtMin(((low + high) / 2) * 500),
    note: d.note,
  };
});

const out = {
  assumptions: {
    chunksPerParagraph: CHUNKS_PER_PARAGRAPH,
    playbackUnlockParagraphs: PLAYBACK_UNLOCK_PARAS,
    anchor: 'Pixel 6 Pro field logs, INT8 WASM 4-thread ~4s/sentence chunk',
  },
  rows,
};
const dir = dirname(fileURLToPath(import.meta.url));
const outputPath = join(dir, 'pocket_caching_expectations.json');
const serialized = `${JSON.stringify(out, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const existing = readFileSync(outputPath, 'utf8').replace(/\r\n/g, '\n');
  if (existing !== serialized) {
    throw new Error('pocket_caching_expectations.json is stale; run this tool without --check.');
  }
  console.log(`Checked ${rows.length} device rows without writing`);
} else {
  writeFileSync(outputPath, serialized);
  console.log(`Wrote ${rows.length} device rows`);
}
for (const key of ['Pixel 6 / 6 Pro', 'iPhone 13 / 13 mini', 'iPhone 16 Pro / Pro Max', 'Galaxy A54 / A34 (2023)', 'Moto G Power 5G (2024)']) {
  const row = rows.find((r) => r.name === key);
  if (row) console.log(`${row.name}: ${row.paraLow}-${row.paraHigh}s/para, unlock ${row.unlock}, 250 paras ${row.story250}`);
}
