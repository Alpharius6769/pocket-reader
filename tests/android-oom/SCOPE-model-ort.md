# Scope: reducing Kokoro's resident footprint

Written 2026-08-29 after the emulator rig runs. Everything under "Measured" was
observed on this rig; everything under "Unknown" is explicitly not.

## Measured

App-only footprint (Chrome's 52 MB renderer cost excluded), 4 GB device profile:

| | app-only |
|---|---|
| idle, story open | 27 MB |
| at "Preparing narration session..." | 133 MB |
| peak during/after session build | 396 - 424 MB |
| sustained while caching paragraphs | **298 - 424 MB (see Unknown 1)** |
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

1. **Is the high number sustained or transient?** Runs have settled at 298 MB
   and at 424 MB. The 298 MB runs followed an engine teardown/rebuild, so that
   may be a degraded state rather than the real working set. This single fact
   decides everything below: a transient spike and a permanently resident
   ~290 MB engine call for different fixes. **Cost: ~30 min. Do this first.**
   Take 3 clean runs on one story, no teardown, 10+ paragraphs each.

2. **How much of the peak is ORT itself vs this model?** Build a session from a
   trivial ONNX model in the same worker and measure. That splits "the runtime
   costs X" from "the model costs Y" and decides between options A and B below.
   **Cost: ~1 hour.**

## Options

### A. Try a different prebuilt quantisation — cheapest, do first
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
