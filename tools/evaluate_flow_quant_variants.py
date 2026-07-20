"""Compare block4 quantization candidates against the deployed INT8 graph."""

from __future__ import annotations

import argparse
import gc
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort


DTYPES = {"float32": np.float32, "int64": np.int64, "bool": np.bool_}


def make_state(manifest: list[dict[str, object]]) -> dict[str, np.ndarray]:
    result = {}
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
        result[str(spec["input_name"])] = value
    return result


def run_two_blocks(
    path: Path,
    manifest: list[dict[str, object]],
    bos: np.ndarray,
    random_latents: np.ndarray,
) -> dict[str, np.ndarray]:
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    state = make_state(manifest)
    collected_latents = []
    collected_eos = []
    sequence = bos
    for index in range(2):
        feeds = {
            "sequence": sequence,
            "random_latents": random_latents[:, index * 4:(index + 1) * 4],
            **state,
        }
        values = session.run(None, feeds)
        outputs = dict(zip((item.name for item in session.get_outputs()), values))
        collected_latents.append(outputs["latents"])
        collected_eos.append(outputs["eos_logits"])
        sequence = outputs["next_sequence"]
        for spec in manifest:
            state[str(spec["input_name"])] = outputs[str(spec["output_name"])]
    result = {
        "latents": np.concatenate(collected_latents, axis=1),
        "eos_logits": np.concatenate(collected_eos, axis=1),
        "next_sequence": sequence,
    }
    result.update({f"state::{name}": value for name, value in state.items()})
    del session
    gc.collect()
    return result


def delta(reference: np.ndarray, candidate: np.ndarray) -> dict[str, float]:
    finite = np.isfinite(reference) & np.isfinite(candidate)
    if not finite.any():
        return {"maxAbs": 0.0, "meanAbs": 0.0, "relativeL2": 0.0}
    left = reference[finite].astype(np.float64)
    right = candidate[finite].astype(np.float64)
    difference = left - right
    return {
        "maxAbs": float(np.abs(difference).max()),
        "meanAbs": float(np.abs(difference).mean()),
        "relativeL2": float(np.linalg.norm(difference) / max(np.linalg.norm(left), 1e-12)),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidates", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--bos", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    bundle = json.loads(args.bundle.read_text(encoding="utf-8"))
    manifest = bundle["flow_lm_state_manifest"]
    bos = np.load(args.bos).astype(np.float32)
    random_latents = np.random.default_rng(20260716).standard_normal((1, 8, int(bundle["latent_dim"]))).astype(np.float32)
    reference = run_two_blocks(args.baseline, manifest, bos, random_latents)
    report = {"schemaVersion": 1, "baseline": str(args.baseline.resolve()), "variants": {}}
    for path in sorted(args.candidates.glob("*.onnx")):
        print(f"evaluating {path.name}", flush=True)
        candidate = run_two_blocks(path, manifest, bos, random_latents)
        state_deltas = [delta(reference[name], candidate[name]) for name in reference if name.startswith("state::")]
        values = {
            "latents": delta(reference["latents"], candidate["latents"]),
            "eosLogits": delta(reference["eos_logits"], candidate["eos_logits"]),
            "nextSequence": delta(reference["next_sequence"], candidate["next_sequence"]),
            "stateMaxAbs": max(item["maxAbs"] for item in state_deltas),
            "stateRelativeL2Max": max(item["relativeL2"] for item in state_deltas),
        }
        values["passesStrictGate"] = bool(
            values["latents"]["relativeL2"] <= 0.02
            and values["eosLogits"]["maxAbs"] <= 0.15
            and values["stateRelativeL2Max"] <= 0.02
        )
        report["variants"][path.stem.replace("flow_lm_decode_block4_", "")] = values
    args.output.parent.mkdir(parents=True, exist_ok=True)
    rendered = json.dumps(report, indent=2) + "\n"
    args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")


if __name__ == "__main__":
    main()
