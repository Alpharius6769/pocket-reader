# Scope: reducing Kokoro's resident footprint

Written 2026-08-29 after the emulator rig runs. Everything under "Measured" was
observed on this rig; everything under "Unknown" is explicitly not.

## Measured

App-only footprint (Chrome's 52 MB renderer cost excluded), 4 GB device profile:

| | app-only |
|---|---|
| idle, story open | 27 MB |
| at "Preparing narration session..." | 133 MB |
| peak during/after session build | 396 - 519 MB |
| **sustained while caching, 2h+ plateau** | **465 - 477 MB** |
| iPhone-class budget being tested against | 350 MB |

The model (`model_q8f16.onnx`, 82 MB) by raw graph scan:

| | count |
|---|---|
| MatMulInteger / ConvInteger | 148 / 87 |
| DynamicQuantizeLinear | 139 |
| QuantizeLinear / DequantizeLinear | 1390 / 8 |
| **LSTM / GRU** | **366 / 135** |
| Cast | 812 |

Two things follow. Quantisation is **partial** — a few hundred integer ops
against thousands of float MatMul/Conv/Gemm. And there are **501 recurrent ops**
which ONNX Runtime does not quantise at all; those weights and their per-step
working buffers stay float. "q8f16" buys less here than the name suggests.

Only `model_q8f16.onnx` is hosted. Every other variant
(`model.onnx`, `model_fp16.onnx`, `model_q4f16.onnx`, `model_uint8.onnx`, ...)
404s on the proxy and would need uploading to B2 first.

## Already ruled out — do not redo

- Releasing the JS-side download before `InferenceSession.create` — no effect.
- `graphOptimizationLevel` 'all' -> 'basic' — no effect, and forgoes real
  optimisations. Both reverted in a34c348.
- `enableCpuMemArena` / `enableMemPattern` — measured earlier as a no-op for
  Kokoro (592 vs 594 MB, 356.6 vs 354.7 MB).

## Unknown, and worth resolving BEFORE spending effort

1. ~~Is the high number sustained or transient?~~ **ANSWERED 2026-08-29 — it is
   RESIDENT.** A 148-minute continuous run (Kokoro, af_heart, isolated, 634 of
   703 paragraphs cached, ~3h of audio) peaked at **519 MB** during session
   build, then sat on a **flat 465-477 MB plateau for over two hours**.

   Two things follow. The earlier 298 MB readings were a degraded post-teardown
   state, not the working set — the real one is ~470 MB, **120 MB over the
   350 MB budget, sustained**. And the plateau is genuinely flat across 600+
   paragraphs, so there is **no leak**: the engine is stable, just too large.
   That kills any fix aimed at the transient and moves the target to resident
   size (options A and C).

2. **How much of the peak is ORT itself vs this model?** Build a session from a
   trivial ONNX model in the same worker and measure. That splits "the runtime
   costs X" from "the model costs Y" and decides between options A and B below.
   **Cost: ~1 hour.**

## The headline finding (2026-08-29 research)

**ONNX Runtime's WASM CPU backend does not support float16 at all.** Every fp16
tensor gets a Cast to fp32 inserted around it, which doubles the memory those
weights occupy and costs real time — one reported case had the inserted casts
taking 54% of total inference time.

`kokoro_worker.js` hardcodes `executionProviders: ['wasm']`. Kokoro never runs on
WebGPU. So the `f16` half of `model_q8f16.onnx` is not just wasted, it is
actively harmful on the only backend we use: **the f16 variants are built for
WebGPU, and we picked one for a CPU-only path.** The 812 Cast nodes counted in
the graph are those inserted conversions.

### The variant table

| file | size | fp16 | suitable for WASM CPU |
|---|---|---|---|
| model.onnx | 326 MB | no | yes, but 4x the download |
| model_fp16.onnx | 163 MB | **yes** | no |
| model_q4.onnx | 305 MB | no | int4, quality risk |
| model_q4f16.onnx | 155 MB | **yes** | no |
| **model_q8f16.onnx (shipping)** | 86 MB | **yes** | **no — current choice** |
| **model_quantized.onnx** | **92.4 MB** | **no** | **yes — candidate** |
| model_uint8.onnx | 177 MB | no | yes, but 2x the download |
| model_uint8f16.onnx | 114 MB | **yes** | no |

### Why `model_quantized.onnx` is the candidate

Both files were downloaded and their graphs compared directly:

| | q8f16 (shipping) | quantized (candidate) |
|---|---|---|
| file size | 82.0 MB | 88.1 MB |
| MatMulInteger | 148 | **148** |
| ConvInteger | 87 | **87** |
| DynamicQuantizeLinear | 139 | **139** |
| QuantizeLinear | 1390 | **278** |
| Cast | 812 | **452** |

The integer-op counts are **identical**, so it is the same int8 quantisation of
the same operators — there is no additional weight-precision loss versus what
already ships. What differs is ~1100 fewer QuantizeLinear and 360 fewer Cast
nodes: the fp16 conversion machinery is gone. Cost is +6 MB of download.

This is the rare case where the quality-preserving option and the memory option
point the same way: fp32 activations are *more* precise than fp16, not less.

**Not yet measured.** The prediction is lower resident memory and faster
inference; it has to be run on the rig before it is believed. Note also that the
raw graph scan counts byte strings, so the LSTM row (366 vs 150) may be a naming
artefact rather than a structural difference — worth confirming.

## Options

### A. ~~Swap to model_quantized.onnx~~ — TRIED 2026-08-29, MEASURED WORSE, REVERTED

Uploaded to B2, deployed, measured on the rig. App-only:

| | peak | plateau median |
|---|---|---|
| q8f16 (restored) | 519 MB | 459 MB |
| quantized run A | 587 MB | 459 MB |
| quantized run B | 580 MB | 465 MB |

Two clean runs: **+64 MB at peak, +3 MB at the plateau.** Peak is the number that
gets a tab killed, so the swap made an OOM *more* likely, and cost +10 MB of
download for it. Reverted.

The fp16 reasoning was correct as far as it went — ORT's wasm CPU backend really
cannot execute float16, the casts really are inserted, and the graph really does
carry 812 of them against the alternative's 452. Removing them saved graph work
but not memory. That is the useful result: **the resident cost is not the model's
dtype**, so it lives in the arena, the LSTM/GRU working buffers, or ORT's own
fixed session cost. Unknown 2 below is now the only lead worth pulling.

The file remains on B2 at `kokoro/v1.0/model_quantized.onnx`, so re-testing costs
one line. Do not re-derive this from graph counts alone — they were persuasive
and they were wrong.

### A2. Other prebuilt quantisations — now much less promising
Download alternates from `onnx-community/Kokoro-82M-v1.0-ONNX`, upload to B2,
point `KOKORO_BASE` at one, measure on the rig.

- Effort: ~2-3 h, mostly upload + one rig run each. No custom toolchain.
- Upside: `model_uint8.onnx` / `model_q4f16.onnx` are materially smaller on disk.
- Risk: **voice quality**. q4 on an 82M model is aggressive and this is a
  narration app — a memory win that makes the narrator sound worse is not a win.
  Needs an A/B listen, not just a memory number.
- Caveat: smaller on disk does not guarantee smaller resident. With 501 float
  recurrent ops untouched by weight quantisation, the resident saving may be far
  less than the file-size difference suggests. Measure, do not assume.

### B. Custom ORT build — real but expensive
A minimal build (`--minimal_build`, `.ort` format, prune unused ops/EPs) cuts the
runtime's own code and table footprint.

- Effort: **high**. Needs Docker or WSL, and both are currently broken on this
  machine (`tools/build_ort_simd_wsl.sh` exists and has never run). Budget a day
  including toolchain repair, plus ongoing cost: every ORT upgrade needs a rebuild.
- Upside: unknown until Unknown 2 is answered. If ORT is 80 MB of the peak this
  is worth it; if it is 20 MB it is not.
- **Gate this behind Unknown 2.** Do not start it blind.

### C. Staged / split loading — highest ceiling, highest cost
Kokoro is text-encoder -> duration predictor -> decoder. Loading and releasing
stages around each inference would cap resident memory near the largest single
stage rather than the sum.

- Effort: **high**, and it is model surgery plus a worker protocol change.
- Risk: per-paragraph latency gets worse, on devices that are already slow.
- Only sensible if Unknown 1 says the engine is permanently resident AND A fails.

### D. Drop `numThreads` from 2 to 1 on constrained devices — cheap, untested
Each ORT thread carries its own stack and arena. One line, and the existing
comment already argues Kokoro gains little from extra threads.

- Effort: ~30 min including a rig run.
- Risk: slower inference on devices that are already slow. Measure both.

## Recommended sequence

1. Unknown 1 (~30 min) — is it transient or resident?
2. Unknown 2 (~1 h) — runtime vs model split.
3. Option D (~30 min) — cheap, and the answer is useful either way.
4. Option A (~2-3 h) — gated on a quality A/B, not memory alone.
5. Option B or C only if 1-4 leave a real gap, and only with 2 answered.

Steps 1-3 are half a day and would settle whether this needs a model change at
all. Nothing above should start before step 1.

## Note

The isolation-handoff and phonemizer fixes (83f312f) changed throughput: caching
now progresses steadily (~1 paragraph per 20 s on the emulator) where it
previously stalled at 0-1 paragraphs. Any memory figure taken before that commit
was measured on an engine that was barely running, so re-baseline before
comparing against the older traces in this directory.
