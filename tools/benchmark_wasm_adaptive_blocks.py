"""Validate and benchmark a fixed-frame decode block against block4."""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort


DTYPES = {"float32": np.float32, "int64": np.int64, "bool": np.bool_}


def make_state(manifest):
    state = {}
    for spec in manifest:
        shape = [int(value) for value in spec["shape"]]
        dtype = DTYPES[str(spec["dtype"])]
        fill = spec["fill"]
        state[str(spec["input_name"])] = (
            np.full(shape, np.nan, dtype=dtype) if fill == "nan"
            else np.ones(shape, dtype=dtype) if fill == "ones"
            else np.zeros(shape, dtype=dtype)
        )
    return state


def execute(session, manifest, bos, noise, frames):
    state = make_state(manifest)
    sequence = bos
    latents = []
    eos = []
    started = time.perf_counter()
    for offset in range(0, noise.shape[1], frames):
        values = session.run(None, {
            "sequence": sequence,
            "random_latents": noise[:, offset:offset + frames],
            **state,
        })
        outputs = dict(zip((item.name for item in session.get_outputs()), values))
        latents.append(outputs["latents"])
        eos.append(outputs["eos_logits"])
        sequence = outputs["next_sequence"]
        for spec in manifest:
            state[str(spec["input_name"])] = outputs[str(spec["output_name"])]
    elapsed = (time.perf_counter() - started) * 1000
    return {
        "latents": np.concatenate(latents, axis=1),
        "eos": np.concatenate(eos, axis=1),
        "sequence": sequence,
        "state": state,
    }, elapsed


def delta(reference, candidate):
    finite = np.isfinite(reference) & np.isfinite(candidate)
    values = np.abs(reference[finite] - candidate[finite])
    return {"maxAbs": float(values.max()) if values.size else 0.0,
            "meanAbs": float(values.mean()) if values.size else 0.0}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--block4", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--candidate-frames", type=int, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--bos", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=9)
    args = parser.parse_args()

    bundle = json.loads(args.bundle.read_text(encoding="utf-8"))
    manifest = bundle["flow_lm_state_manifest"]
    total_frames = math.lcm(4, args.candidate_frames)
    noise = np.random.default_rng(20260716).standard_normal(
        (1, total_frames, int(bundle["latent_dim"]))).astype(np.float32)
    bos = np.load(args.bos).astype(np.float32)

    tick = time.perf_counter()
    reference_session = ort.InferenceSession(str(args.block4), providers=["CPUExecutionProvider"])
    reference_init = (time.perf_counter() - tick) * 1000
    tick = time.perf_counter()
    candidate_session = ort.InferenceSession(str(args.candidate), providers=["CPUExecutionProvider"])
    candidate_init = (time.perf_counter() - tick) * 1000
    reference, _ = execute(reference_session, manifest, bos, noise, 4)
    candidate, _ = execute(candidate_session, manifest, bos, noise, args.candidate_frames)

    reference_times = []
    candidate_times = []
    for _ in range(args.runs):
        _, elapsed = execute(reference_session, manifest, bos, noise, 4)
        reference_times.append(elapsed)
        _, elapsed = execute(candidate_session, manifest, bos, noise, args.candidate_frames)
        candidate_times.append(elapsed)

    state_deltas = [delta(reference["state"][str(spec["input_name"])],
                          candidate["state"][str(spec["input_name"])]) for spec in manifest]
    quality = {
        "latents": delta(reference["latents"], candidate["latents"]),
        "eosLogits": delta(reference["eos"], candidate["eos"]),
        "nextSequence": delta(reference["sequence"], candidate["sequence"]),
        "stateMaxAbs": max(item["maxAbs"] for item in state_deltas),
    }
    reference_median = float(np.median(reference_times))
    candidate_median = float(np.median(candidate_times))
    report = {
        "schemaVersion": 1,
        "candidateFrames": args.candidate_frames,
        "comparisonFrames": total_frames,
        "files": {
            "block4": {"path": str(args.block4.resolve()), "bytes": args.block4.stat().st_size},
            "candidate": {"path": str(args.candidate.resolve()), "bytes": args.candidate.stat().st_size},
        },
        "sessionCreationMs": {"block4": reference_init, "candidate": candidate_init},
        "quality": quality,
        "nativeTimingMs": {
            "block4": {"median": reference_median, "samples": reference_times},
            "candidate": {"median": candidate_median, "samples": candidate_times},
            "candidateSpeedup": reference_median / candidate_median,
        },
        "passesNumericalGate": bool(max(
            quality["latents"]["maxAbs"], quality["eosLogits"]["maxAbs"],
            quality["nextSequence"]["maxAbs"], quality["stateMaxAbs"],
        ) <= 1e-6),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(report, indent=2) + "\n"
    args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    if not report["passesNumericalGate"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
