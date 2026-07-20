"""Compare one block8 decode with two state-carried block4 decodes."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort


DTYPES = {"float32": np.float32, "int64": np.int64, "bool": np.bool_}


def make_state(manifest: list[dict[str, object]]) -> dict[str, np.ndarray]:
    result: dict[str, np.ndarray] = {}
    for spec in manifest:
        shape = [int(value) for value in spec["shape"]]
        dtype = DTYPES[str(spec["dtype"])]
        if spec["fill"] == "nan":
            value = np.full(shape, np.nan, dtype=dtype)
        elif spec["fill"] == "ones":
            value = np.ones(shape, dtype=dtype)
        else:
            value = np.zeros(shape, dtype=dtype)
        result[str(spec["input_name"])] = value
    return result


def run_block(
    session: ort.InferenceSession,
    manifest: list[dict[str, object]],
    sequence: np.ndarray,
    random_latents: np.ndarray,
    state: dict[str, np.ndarray],
) -> tuple[dict[str, np.ndarray], np.ndarray, dict[str, np.ndarray], float]:
    tick = time.perf_counter()
    values = session.run(None, {"sequence": sequence, "random_latents": random_latents, **state})
    elapsed = (time.perf_counter() - tick) * 1000
    outputs = dict(zip([item.name for item in session.get_outputs()], values))
    next_state = dict(state)
    for spec in manifest:
        output_name = str(spec["output_name"])
        if output_name in outputs:
            next_state[str(spec["input_name"])] = outputs[output_name]
    return outputs, outputs["next_sequence"], next_state, elapsed


def execute_block4_pair(
    session: ort.InferenceSession,
    manifest: list[dict[str, object]],
    bos: np.ndarray,
    random_latents: np.ndarray,
) -> tuple[dict[str, np.ndarray], float]:
    state = make_state(manifest)
    first, sequence, state, first_ms = run_block(
        session, manifest, bos, random_latents[:, :4], state,
    )
    second, sequence, state, second_ms = run_block(
        session, manifest, sequence, random_latents[:, 4:], state,
    )
    return {
        "latents": np.concatenate([first["latents"], second["latents"]], axis=1),
        "eos_logits": np.concatenate([first["eos_logits"], second["eos_logits"]], axis=1),
        "next_sequence": sequence,
        "state": state,
    }, first_ms + second_ms


def execute_block8(
    session: ort.InferenceSession,
    manifest: list[dict[str, object]],
    bos: np.ndarray,
    random_latents: np.ndarray,
) -> tuple[dict[str, np.ndarray], float]:
    outputs, sequence, state, elapsed = run_block(
        session, manifest, bos, random_latents, make_state(manifest),
    )
    return {
        "latents": outputs["latents"],
        "eos_logits": outputs["eos_logits"],
        "next_sequence": sequence,
        "state": state,
    }, elapsed


def delta(reference: np.ndarray, candidate: np.ndarray) -> dict[str, float]:
    finite = np.isfinite(reference) & np.isfinite(candidate)
    if not np.any(finite):
        return {"maxAbs": 0.0, "meanAbs": 0.0}
    values = np.abs(reference[finite] - candidate[finite])
    return {"maxAbs": float(values.max()), "meanAbs": float(values.mean())}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--block4", type=Path, required=True)
    parser.add_argument("--block8", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--bos", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=9)
    args = parser.parse_args()

    bundle = json.loads(args.bundle.read_text(encoding="utf-8"))
    manifest = bundle["flow_lm_state_manifest"]
    latent_dim = int(bundle["latent_dim"])
    bos = np.load(args.bos).astype(np.float32)
    random_latents = np.random.default_rng(20260716).standard_normal((1, 8, latent_dim)).astype(np.float32)

    started = time.perf_counter()
    block4_session = ort.InferenceSession(str(args.block4), providers=["CPUExecutionProvider"])
    block4_init_ms = (time.perf_counter() - started) * 1000
    started = time.perf_counter()
    block8_session = ort.InferenceSession(str(args.block8), providers=["CPUExecutionProvider"])
    block8_init_ms = (time.perf_counter() - started) * 1000

    reference, _ = execute_block4_pair(block4_session, manifest, bos, random_latents)
    candidate, _ = execute_block8(block8_session, manifest, bos, random_latents)
    block4_times: list[float] = []
    block8_times: list[float] = []
    for _ in range(args.runs):
        _, timing = execute_block4_pair(block4_session, manifest, bos, random_latents)
        block4_times.append(timing)
        _, timing = execute_block8(block8_session, manifest, bos, random_latents)
        block8_times.append(timing)

    state_deltas = [
        delta(reference["state"][str(spec["input_name"])], candidate["state"][str(spec["input_name"])])
        for spec in manifest
    ]
    report = {
        "schemaVersion": 1,
        "files": {
            "block4": {"path": str(args.block4.resolve()), "bytes": args.block4.stat().st_size},
            "block8": {"path": str(args.block8.resolve()), "bytes": args.block8.stat().st_size},
        },
        "sessionCreationMs": {"block4": block4_init_ms, "block8": block8_init_ms},
        "quality": {
            "latents": delta(reference["latents"], candidate["latents"]),
            "eosLogits": delta(reference["eos_logits"], candidate["eos_logits"]),
            "nextSequence": delta(reference["next_sequence"], candidate["next_sequence"]),
            "stateMaxAbs": max(item["maxAbs"] for item in state_deltas),
            "stateMeanAbsMax": max(item["meanAbs"] for item in state_deltas),
        },
        "nativeCpuTimingMs8Frames": {
            "block4Pair": {"samples": block4_times, "median": float(np.median(block4_times))},
            "block8": {"samples": block8_times, "median": float(np.median(block8_times))},
        },
    }
    block4_median = report["nativeCpuTimingMs8Frames"]["block4Pair"]["median"]
    block8_median = report["nativeCpuTimingMs8Frames"]["block8"]["median"]
    report["nativeSpeedup"] = block4_median / block8_median
    report["passesNumericalGate"] = bool(
        report["quality"]["latents"]["maxAbs"] <= 0.02
        and report["quality"]["stateMaxAbs"] <= 0.02
    )
    rendered = json.dumps(report, indent=2) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")


if __name__ == "__main__":
    main()
