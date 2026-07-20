"""Numerically validate and benchmark the unified Pocket prefill/block4 graph."""

from __future__ import annotations

import argparse
import gc
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort


DTYPES = {"float32": np.float32, "int64": np.int64, "bool": np.bool_}


def make_state(manifest: list[dict[str, object]]) -> dict[str, np.ndarray]:
    state: dict[str, np.ndarray] = {}
    for spec in manifest:
        shape = tuple(int(value) for value in spec["shape"])
        dtype = DTYPES[str(spec["dtype"])]
        fill = spec.get("fill")
        if fill == "nan":
            value = np.full(shape, np.nan, dtype=dtype)
        elif fill == "ones":
            value = np.ones(shape, dtype=dtype)
        else:
            value = np.zeros(shape, dtype=dtype)
        state[str(spec["input_name"])] = value
    return state


def output_map(session: ort.InferenceSession, values: list[np.ndarray]) -> dict[str, np.ndarray]:
    return dict(zip((item.name for item in session.get_outputs()), values))


def delta(reference: np.ndarray, candidate: np.ndarray) -> dict[str, float]:
    finite = np.isfinite(reference) & np.isfinite(candidate)
    if not finite.any():
        return {"maxAbs": 0.0, "meanAbs": 0.0}
    values = np.abs(reference[finite].astype(np.float64) - candidate[finite].astype(np.float64))
    return {"maxAbs": float(values.max()), "meanAbs": float(values.mean())}


def create_session(path: Path) -> tuple[ort.InferenceSession, float]:
    started = time.perf_counter()
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    return session, (time.perf_counter() - started) * 1000


def median_run_ms(session: ort.InferenceSession, feeds: dict[str, np.ndarray], runs: int) -> tuple[float, list[float]]:
    session.run(None, feeds)
    samples: list[float] = []
    for _ in range(runs):
        started = time.perf_counter()
        session.run(None, feeds)
        samples.append((time.perf_counter() - started) * 1000)
    return float(np.median(samples)), samples


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--main", type=Path, required=True)
    parser.add_argument("--block", type=Path, required=True)
    parser.add_argument("--unified", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--bos", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=7)
    args = parser.parse_args()

    bundle = json.loads(args.bundle.read_text(encoding="utf-8"))
    manifest = bundle["flow_lm_state_manifest"]
    rng = np.random.default_rng(20260716)
    text_embeddings = rng.standard_normal((1, 8, int(bundle["conditioning_dim"]))).astype(np.float32)
    random_latents = rng.standard_normal((1, 4, int(bundle["latent_dim"]))).astype(np.float32)
    bos = np.load(args.bos).astype(np.float32)
    empty_sequence = np.zeros((1, 0, int(bundle["latent_dim"])), dtype=np.float32)
    empty_text = np.zeros((1, 0, int(bundle["conditioning_dim"])), dtype=np.float32)

    main_session, main_init_ms = create_session(args.main)
    state = make_state(manifest)
    main_outputs = output_map(main_session, main_session.run(None, {
        "sequence": empty_sequence,
        "text_embeddings": text_embeddings,
        **state,
    }))
    del main_session
    gc.collect()

    block_session, block_init_ms = create_session(args.block)
    state = make_state(manifest)
    block_feeds = {"sequence": bos, "random_latents": random_latents, **state}
    block_outputs = output_map(block_session, block_session.run(None, block_feeds))
    block_median, block_samples = median_run_ms(block_session, block_feeds, args.runs)
    del block_session
    gc.collect()

    unified_session, unified_init_ms = create_session(args.unified)
    state = make_state(manifest)
    unified_prefill_outputs = output_map(unified_session, unified_session.run(None, {
        "decode_mode": np.array(False, dtype=np.bool_),
        "sequence": bos,
        "random_latents": np.zeros_like(random_latents),
        "text_embeddings": text_embeddings,
        **state,
    }))
    state = make_state(manifest)
    unified_decode_feeds = {
        "decode_mode": np.array(True, dtype=np.bool_),
        "sequence": bos,
        "random_latents": random_latents,
        "text_embeddings": empty_text,
        **state,
    }
    unified_decode_outputs = output_map(
        unified_session, unified_session.run(None, unified_decode_feeds),
    )
    unified_median, unified_samples = median_run_ms(
        unified_session, unified_decode_feeds, args.runs,
    )

    prefill_deltas = [
        delta(main_outputs[str(spec["output_name"])], unified_prefill_outputs[str(spec["output_name"])])
        for spec in manifest
    ]
    decode_names = ["latents", "next_sequence", "eos_logits"]
    decode_deltas = {
        name: delta(block_outputs[name], unified_decode_outputs[name])
        for name in decode_names
    }
    state_deltas = [
        delta(block_outputs[str(spec["output_name"])], unified_decode_outputs[str(spec["output_name"])])
        for spec in manifest
    ]
    max_prefill = max(item["maxAbs"] for item in prefill_deltas)
    max_decode = max(
        [item["maxAbs"] for item in decode_deltas.values()]
        + [item["maxAbs"] for item in state_deltas],
    )
    report = {
        "schemaVersion": 1,
        "files": {
            "main": {"path": str(args.main.resolve()), "bytes": args.main.stat().st_size},
            "block": {"path": str(args.block.resolve()), "bytes": args.block.stat().st_size},
            "unified": {"path": str(args.unified.resolve()), "bytes": args.unified.stat().st_size},
        },
        "sessionCreationMs": {
            "main": main_init_ms,
            "block": block_init_ms,
            "unified": unified_init_ms,
        },
        "quality": {
            "prefillStateMaxAbs": max_prefill,
            "decode": decode_deltas,
            "decodeStateMaxAbs": max(item["maxAbs"] for item in state_deltas),
            "overallMaxAbs": max(max_prefill, max_decode),
        },
        "nativeDecodeTimingMs": {
            "block": {"median": block_median, "samples": block_samples},
            "unified": {"median": unified_median, "samples": unified_samples},
            "ratio": unified_median / block_median,
        },
    }
    report["passesNumericalGate"] = report["quality"]["overallMaxAbs"] <= 1e-6
    args.output.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(report, indent=2) + "\n"
    args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    if not report["passesNumericalGate"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
