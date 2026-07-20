"""Ablate Mimi Conv quantization one node at a time.

This identifies which convolution(s) caused the rejected all-Conv candidate's
quality loss. Comparisons are made both to fp32 and to the deployed MatMul-only
INT8 graph so existing quantization error is not charged to each Conv node.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnxruntime.quantization import (
    CalibrationMethod,
    QuantFormat,
    QuantType,
    quantize_dynamic,
    quantize_static,
)

from calibrate_mimi_conv import (
    StreamingCalibrationReader,
    operator_counts,
    run_stream,
    signal_metrics,
)


def build_candidate(
    source: Path,
    manifest: list[dict[str, object]],
    latent_dim: int,
    nodes: list[str],
    output: Path,
    calibration_samples: int,
) -> None:
    conv_only = output.with_suffix(".conv-only.onnx")
    reader = StreamingCalibrationReader(
        source, manifest, latent_dim, calibration_samples,
    )
    quantize_static(
        model_input=str(source),
        model_output=str(conv_only),
        calibration_data_reader=reader,
        quant_format=QuantFormat.QDQ,
        activation_type=QuantType.QInt8,
        weight_type=QuantType.QInt8,
        op_types_to_quantize=["Conv"],
        nodes_to_quantize=nodes,
        per_channel=True,
        calibrate_method=CalibrationMethod.Percentile,
        extra_options={
            "ActivationSymmetric": True,
            "WeightSymmetric": True,
            "DedicatedQDQPair": True,
        },
    )
    quantize_dynamic(
        model_input=str(conv_only),
        model_output=str(output),
        op_types_to_quantize=["MatMul"],
        weight_type=QuantType.QInt8,
        extra_options={"ForceQuantizeNoType": True, "DefaultTensorType": 1},
    )
    conv_only.unlink(missing_ok=True)


def evaluate(
    path: Path,
    manifest: list[dict[str, object]],
    latents: np.ndarray,
) -> tuple[np.ndarray, float]:
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    run_stream(session, manifest, latents)
    audio, timings = run_stream(session, manifest, latents)
    return audio, float(sum(timings))


def slug(index: int, name: str) -> str:
    tail = name.strip("/").replace("/", "-").replace(".", "-").lower()
    return f"{index:02d}-{tail}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--deployed-int8", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--calibration-samples", type=int, default=16)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    bundle = json.loads(args.bundle.read_text(encoding="utf-8"))
    manifest = bundle["mimi_state_manifest"]
    latent_dim = int(bundle["latent_dim"])
    model = onnx.load(str(args.source), load_external_data=False)
    conv_nodes = [node.name for node in model.graph.node if node.op_type == "Conv"]
    rng = np.random.default_rng(424242)
    latents = rng.standard_normal((1, 48, latent_dim)).astype(np.float32)

    fp32_audio, fp32_ms = evaluate(args.source, manifest, latents)
    deployed_audio, deployed_ms = evaluate(args.deployed_int8, manifest, latents)
    deployed_vs_fp32 = signal_metrics(fp32_audio, deployed_audio)

    rows: list[dict[str, object]] = []
    safe_nodes: list[str] = []
    for index, node_name in enumerate(conv_nodes):
        candidate = args.output_dir / f"mimi-{slug(index, node_name)}.onnx"
        build_candidate(
            args.source, manifest, latent_dim, [node_name], candidate,
            args.calibration_samples,
        )
        audio, timing_ms = evaluate(candidate, manifest, latents)
        vs_fp32 = signal_metrics(fp32_audio, audio)
        delta_vs_deployed = signal_metrics(deployed_audio, audio)
        safe = bool(
            delta_vs_deployed["correlation"] >= 0.999
            and delta_vs_deployed["snrDb"] >= 30.0
            and vs_fp32["snrDb"] >= deployed_vs_fp32["snrDb"] - 1.0
        )
        if safe:
            safe_nodes.append(node_name)
        rows.append({
            "node": node_name,
            "candidate": str(candidate.resolve()),
            "bytes": candidate.stat().st_size,
            "timingMs48Frames": timing_ms,
            "safe": safe,
            "qualityVsFp32": vs_fp32,
            "deltaVsDeployed": delta_vs_deployed,
        })

    combined: dict[str, object] | None = None
    if safe_nodes:
        combined_path = args.output_dir / "mimi_decoder_selective_conv_qdq_matmul_int8.onnx"
        build_candidate(
            args.source, manifest, latent_dim, safe_nodes, combined_path,
            args.calibration_samples,
        )
        combined_audio, combined_ms = evaluate(combined_path, manifest, latents)
        combined = {
            "nodes": safe_nodes,
            "path": str(combined_path.resolve()),
            "bytes": combined_path.stat().st_size,
            "operators": operator_counts(combined_path),
            "timingMs48Frames": combined_ms,
            "qualityVsFp32": signal_metrics(fp32_audio, combined_audio),
            "deltaVsDeployed": signal_metrics(deployed_audio, combined_audio),
        }

    report = {
        "schemaVersion": 1,
        "calibrationSamples": args.calibration_samples,
        "fp32TimingMs48Frames": fp32_ms,
        "deployedTimingMs48Frames": deployed_ms,
        "deployedQualityVsFp32": deployed_vs_fp32,
        "rows": rows,
        "safeNodes": safe_nodes,
        "combined": combined,
    }
    rendered = json.dumps(report, indent=2) + "\n"
    (args.output_dir / "mimi_conv_node_sweep.json").write_text(rendered, encoding="utf-8")
    print(rendered, end="")


if __name__ == "__main__":
    main()
