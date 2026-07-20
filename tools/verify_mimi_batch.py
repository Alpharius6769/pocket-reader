"""Tier 1a verification: decoding 48 latent frames in one Mimi call must be
equivalent to four state-carried 12-frame calls (the current runtime pattern).
The decoder is a streaming conv stack, so with faithful state carry the outputs
should match to fp32 noise. Also times both patterns for a local speed signal.
"""
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort

import sys as _sys
ROOT = Path(__file__).resolve().parents[1]
BUNDLE_DIR = ROOT / "pocket-tts-onnx-b2-upload" / "onnx" / "english_2026-04"
MODEL_FILE = "mimi_decoder_int8.onnx"
if len(_sys.argv) > 1 and _sys.argv[1] == "fp32":
    BUNDLE_DIR = ROOT / "pocket-webgpu-r2-build" / "source-export" / "english_2026-04"
    MODEL_FILE = "mimi_decoder.onnx"
bundle = json.loads((BUNDLE_DIR / "bundle.json").read_text())

LATENT_DIM = int(bundle["latent_dim"])
manifest = bundle["mimi_state_manifest"]

DTYPES = {"float32": np.float32, "int64": np.int64, "float16": np.float16, "bool": np.bool_}


def init_state():
    state = {}
    for spec in manifest:
        shape = [int(d) for d in spec["shape"]]
        dtype = DTYPES[spec["dtype"]]
        if spec["fill"] == "zeros":
            arr = np.zeros(shape, dtype=dtype)
        elif spec["fill"] == "nan":
            arr = np.full(shape, np.nan, dtype=dtype)
        else:  # "empty"
            arr = np.zeros(shape, dtype=dtype)
        state[spec["input_name"]] = arr
    return state


sess = ort.InferenceSession(str(BUNDLE_DIR / MODEL_FILE),
                            providers=["CPUExecutionProvider"])
out_names = [o.name for o in sess.get_outputs()]
audio_out = out_names[0]
state_out_map = {spec["output_name"]: spec["input_name"] for spec in manifest}

rng = np.random.default_rng(1234)
latents = rng.standard_normal((1, 48, LATENT_DIM)).astype(np.float32)


def run_chunked(chunk):
    state = init_state()
    audio = []
    t0 = time.perf_counter()
    for start in range(0, 48, chunk):
        feeds = {"latent": latents[:, start:start + chunk, :], **state}
        outs = sess.run(None, feeds)
        named = dict(zip(out_names, outs))
        audio.append(named[audio_out].reshape(-1))
        for out_name, in_name in state_out_map.items():
            if out_name in named:
                state[in_name] = named[out_name]
    elapsed = (time.perf_counter() - t0) * 1000
    return np.concatenate(audio), elapsed


a12, t12_first = run_chunked(12)
a48, t48_first = run_chunked(48)
# warm timings (second run)
_, t12 = run_chunked(12)
_, t48 = run_chunked(48)

print(f"samples: 12-frame path {a12.shape[0]}, 48-frame path {a48.shape[0]}")
n = min(a12.shape[0], a48.shape[0])
diff = np.abs(a12[:n] - a48[:n])
rms = float(np.sqrt(np.mean(a12[:n] ** 2)))
print(f"audio rms: {rms:.4f}")
print(f"max abs diff: {diff.max():.8f}")
print(f"mean abs diff: {diff.mean():.10f}")
print(f"time 4x12 frames: {t12:.1f} ms | 1x48 frames: {t48:.1f} ms "
      f"({(1 - t48 / t12) * 100:.1f}% faster)")
print(f"VERDICT: {'EQUIVALENT' if diff.max() < 1e-4 else 'DIVERGENT - do not ship'}")
