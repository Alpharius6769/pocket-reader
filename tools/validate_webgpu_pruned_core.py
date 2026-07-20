"""Compare the pruned graph-capture core with the certified R3 core."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort


DTYPES = {"float32": np.float32, "int64": np.int64, "bool": np.bool_}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--bos", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    bundle = json.loads(args.bundle.read_text(encoding="utf-8"))
    manifest = bundle["flow_lm_state_manifest"]
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
    feeds = {
        "sequence": np.load(args.bos).astype(np.float32),
        "random_latents": np.random.default_rng(20260716).standard_normal((1, 4, 32)).astype(np.float32),
        **state,
    }
    reference = ort.InferenceSession(str(args.reference), providers=["CPUExecutionProvider"])
    candidate = ort.InferenceSession(str(args.candidate), providers=["CPUExecutionProvider"])
    reference_values = dict(zip(
        (item.name for item in reference.get_outputs()),
        reference.run(None, {name: feeds[name] for name in (item.name for item in reference.get_inputs())}),
    ))
    candidate_values = dict(zip(
        (item.name for item in candidate.get_outputs()),
        candidate.run(None, {name: feeds[name] for name in (item.name for item in candidate.get_inputs())}),
    ))
    deltas = {}
    for name, value in candidate_values.items():
        ref = reference_values[name]
        finite = np.isfinite(ref) & np.isfinite(value)
        difference = np.abs(ref[finite] - value[finite])
        deltas[name] = {
            "maxAbs": float(difference.max()) if difference.size else 0.0,
            "meanAbs": float(difference.mean()) if difference.size else 0.0,
        }
    overall = max(item["maxAbs"] for item in deltas.values())
    report = {
        "schemaVersion": 1,
        "reference": str(args.reference.resolve()),
        "candidate": str(args.candidate.resolve()),
        "sharedOutputs": len(deltas),
        "overallMaxAbs": overall,
        "passesNumericalGate": bool(overall <= 1e-6),
        "outputs": deltas,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(report, indent=2) + "\n"
    args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")
    if not report["passesNumericalGate"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
