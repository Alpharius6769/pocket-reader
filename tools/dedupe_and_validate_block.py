"""Dedupe the quantized decode-block initializers, then validate + benchmark.

quantize_dynamic gives each MatMulInteger consumer its own int8 copy of what
was a single shared fp32 weight in the unrolled block, quadrupling the file.
Identical tensors (same dtype/dims/bytes) are merged back to one initializer.

Validation:
  A. fp32 block vs fp32 sequential (flow_lm_main + flow_lm_flow): structural
     equivalence of the unroll (expect ~1e-5).
  B. int8-block-vs-fp32 error compared against int8-sequential-vs-fp32 error:
     the block's quantization noise must be in the same family as what ships.
Benchmark: int8 block vs int8 sequential for 40 frames (kernel-level; the
browser adds the 4x JS/WASM state-copy savings on top of whatever shows here).
"""
import hashlib
import json
import time
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[1]
BLOCK_DIR = ROOT / "pocket-wasm-block-b2-upload" / "onnx" / "english_2026-04"
DEPLOYED = ROOT / "pocket-tts-onnx-b2-upload" / "onnx" / "english_2026-04"
FP32_SRC = ROOT / "pocket-webgpu-r2-build" / "source-export" / "english_2026-04"

# Dedupe/cleanup now happens inside the export script itself.
deduped_path = BLOCK_DIR / "flow_lm_decode_block4_int8.onnx"
print(f"validating {deduped_path.name}: {deduped_path.stat().st_size/1048576:.1f} MB")

# ---------- shared helpers ----------
bundle = json.loads((DEPLOYED / "bundle.json").read_text())
LATENT = int(bundle["latent_dim"])
DTYPES = {"float32": np.float32, "int64": np.int64, "float16": np.float16, "bool": np.bool_}


def init_flow_state():
    state = {}
    for spec in bundle["flow_lm_state_manifest"]:
        shape = [int(d) for d in spec["shape"]]
        dt = DTYPES[spec["dtype"]]
        if spec["fill"] == "zeros":
            arr = np.zeros(shape, dtype=dt)
        elif spec["fill"] == "nan":
            arr = np.full(shape, np.nan, dtype=dt)
        else:
            arr = np.zeros(shape, dtype=dt)
        state[spec["input_name"]] = arr
    return state


STATE_OUT_MAP = {s["output_name"]: s["input_name"] for s in bundle["flow_lm_state_manifest"]}
opts = ort.SessionOptions()
opts.log_severity_level = 3


def carry(state, named):
    for out_name, in_name in STATE_OUT_MAP.items():
        if out_name in named:
            state[in_name] = named[out_name]


def run_sequential(main_path, flow_path, noise, bos, frames):
    main = ort.InferenceSession(str(main_path), opts, providers=["CPUExecutionProvider"])
    flow = ort.InferenceSession(str(flow_path), opts, providers=["CPUExecutionProvider"])
    main_outs = [o.name for o in main.get_outputs()]
    state = init_flow_state()
    current = bos.copy()  # explicit BOS to match block semantics
    latents, eos = [], []
    t0 = time.perf_counter()
    for f in range(frames):
        outs = dict(zip(main_outs, main.run(None, {
            "sequence": current,
            "text_embeddings": np.zeros((1, 0, int(bundle["conditioning_dim"])), np.float32),
            **state,
        })))
        cond = outs["conditioning"]
        eos.append(float(outs["eos_logit"].reshape(-1)[0]))
        carry(state, outs)
        x = noise[0, f].copy()
        fl = flow.run(None, {
            "c": cond.reshape(1, -1).astype(np.float32),
            "s": np.zeros((1, 1), np.float32),
            "t": np.ones((1, 1), np.float32),
            "x": x.reshape(1, -1),
        })[0]
        lat = x + fl.reshape(-1)
        latents.append(lat)
        current = lat.reshape(1, 1, LATENT).astype(np.float32)
    return np.stack(latents), np.array(eos), (time.perf_counter() - t0) * 1000


def run_block(block_path, noise, bos, frames):
    sess = ort.InferenceSession(str(block_path), opts, providers=["CPUExecutionProvider"])
    out_names = [o.name for o in sess.get_outputs()]
    state = init_flow_state()
    current = bos.copy()
    latents, eos = [], []
    t0 = time.perf_counter()
    for start in range(0, frames, 4):
        outs = dict(zip(out_names, sess.run(None, {
            "sequence": current,
            "random_latents": noise[:, start:start + 4, :],
            **state,
        })))
        latents.append(outs["latents"][0])
        eos.append(outs["eos_logits"].reshape(-1))
        current = outs["next_sequence"]
        carry(state, outs)
    return np.concatenate(latents), np.concatenate(eos), (time.perf_counter() - t0) * 1000


rng = np.random.default_rng(7)
FRAMES = 40
noise = (rng.standard_normal((1, FRAMES, LATENT)) * np.sqrt(0.7)).astype(np.float32)
bos = np.load(BLOCK_DIR / "flow_lm_bos.npy").astype(np.float32)

print("\n-- A. structural equivalence (fp32 block vs fp32 sequential) --")
lat_seq32, eos_seq32, _ = run_sequential(FP32_SRC / "flow_lm_main.onnx", FP32_SRC / "flow_lm_flow.onnx", noise, bos, FRAMES)
lat_blk32, eos_blk32, _ = run_block(BLOCK_DIR / "flow_lm_decode_block4.onnx", noise, bos, FRAMES)
d = np.abs(lat_seq32 - lat_blk32)
print(f"latents rms {np.sqrt(np.mean(lat_seq32**2)):.4f}  max|diff| {d.max():.6f}  eos max|diff| {np.abs(eos_seq32-eos_blk32).max():.6f}")

print("\n-- B. quantization noise comparison (vs fp32 sequential reference) --")
lat_seq8, eos_seq8, t_seq8 = run_sequential(DEPLOYED / "flow_lm_main_int8.onnx", DEPLOYED / "flow_lm_flow_int8.onnx", noise, bos, FRAMES)
lat_blk8, eos_blk8, t_blk8 = run_block(deduped_path, noise, bos, FRAMES)
err_seq = np.abs(lat_seq8 - lat_seq32)
err_blk = np.abs(lat_blk8 - lat_seq32)
print(f"deployed int8 sequential error: mean {err_seq.mean():.5f} max {err_seq.max():.5f}")
print(f"new int8 block error:           mean {err_blk.mean():.5f} max {err_blk.max():.5f}")

print("\n-- benchmark (40 frames, warm second pass) --")
_, _, t_seq8 = run_sequential(DEPLOYED / "flow_lm_main_int8.onnx", DEPLOYED / "flow_lm_flow_int8.onnx", noise, bos, FRAMES)
_, _, t_blk8 = run_block(deduped_path, noise, bos, FRAMES)
print(f"int8 sequential: {t_seq8:.0f} ms ({t_seq8/FRAMES:.1f} ms/frame)")
print(f"int8 block4:     {t_blk8:.0f} ms ({t_blk8/FRAMES:.1f} ms/frame)  "
      f"{(1 - t_blk8/t_seq8)*100:.1f}% faster")
