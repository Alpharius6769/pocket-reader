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

2. ~~How much of the peak is ORT itself vs this model?~~ **ANSWERED 2026-08-29.**
   Measured directly with a 69-byte hand-built Identity model against the real
   one, in the same worker, twice. App-only:

   | stage | app-only | delta |
   |---|---|---|
   | worker constructed | 16 MB | |
   | ORT runtime loaded, no session | 17 MB | **+1** |
   | + session from the 69-byte model | 77 MB | **+60** |
   | + session from the 82 MB Kokoro model | 352 MB | **+275** |

   **The model is 82% of the cost.** ORT's fixed per-session allocation is ~60 MB
   and its runtime instantiation is ~1 MB. This **contradicts** onnxruntime#18165
   (a 2 KB model triggering ~300 MB) — that does not reproduce on ORT 1.27 here,
   and the scoping written before this measurement leaned on it.

   82 MB on disk becoming 275 MB resident is a 3.35x expansion, and that is the
   number any future work has to attack.

## What this closes off

**A custom ORT build (option B) is dead.** Its entire addressable surface is the
60 MB fixed cost, and realistically a fraction of that. It was the day-long
option; it is now the least valuable one. Do not start it.

**Swapping to another published Kokoro variant (option A) is dead too.** The
expansion is float weight volume, not packaging, and no available export changes
that:

| | q8f16 (shipping) | quantized (tried) | uint8 |
|---|---|---|---|
| size | 82 MB | 88 MB | 169 MB |
| MatMulInteger | 148 | 148 | **0** |
| ConvInteger | 87 | 87 | **0** |
| integer ops total | 235 | 235 | **0** |

The two int8 exports quantise **identically** — 235 operators out of thousands —
which is why they measured the same. `model_uint8.onnx` quantises none of them
and is twice the size. There is no variant on the shelf that quantises more of
this network, so on-disk size will keep failing to predict resident size.

## What is actually left

1. **Staged loading (option C).** Load and release encoder / duration predictor /
   decoder around each inference so resident memory tracks the largest stage
   rather than the sum. Still the highest ceiling, still model surgery plus a
   worker protocol change, and it will cost per-paragraph latency on devices that
   are already slow.
2. **A different or smaller architecture.** Kokoro-82M's float remainder is what
   it is; a genuinely smaller TTS model is a bigger decision than an optimisation.
3. **Accept ~460 MB and mitigate.** The app already detects 4 GB devices and
   recommends Away Mode. On an iPhone 13 (~400-450 MB threshold) that is the
   honest position until 1 or 2 happens.

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
