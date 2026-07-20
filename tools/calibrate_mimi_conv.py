"""Build and validate an isolated static-INT8 Mimi Conv candidate.

The deployed Mimi graph dynamically quantizes MatMul but leaves the CNN stack
in fp32. ORT recommends static calibration for CNNs, so this tool calibrates
only Conv nodes first, then reapplies the deployed dynamic MatMul recipe. It
never overwrites a production model and emits a quality/performance report.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnxruntime.quantization import (
    CalibrationDataReader,
    CalibrationMethod,
    QuantFormat,
    QuantType,
    quantize_dynamic,
    quantize_static,
)


DTYPES = {
    "float32": np.float32,
    "float16": np.float16,
    "int64": np.int64,
    "bool": np.bool_,
}


def initial_state(manifest: list[dict[str, object]]) -> dict[str, np.ndarray]:
    state: dict[str, np.ndarray] = {}
    for spec in manifest:
        shape = [int(value) for value in spec["shape"]]
        dtype = DTYPES[str(spec["dtype"])]
        fill = str(spec["fill"])
        if fill == "ones":
            value = np.ones(shape, dtype=dtype)
        elif fill == "nan":
            value = np.full(shape, np.nan, dtype=dtype)
        else:
            value = np.zeros(shape, dtype=dtype)
        state[str(spec["input_name"])] = value
    return state


def run_stream(
    session: ort.InferenceSession,
    manifest: list[dict[str, object]],
    latents: np.ndarray,
    chunk_frames: int = 12,
) -> tuple[np.ndarray, list[float]]:
    state = initial_state(manifest)
    names = [output.name for output in session.get_outputs()]
    state_outputs = {str(spec["output_name"]): str(spec["input_name"]) for spec in manifest}
    audio: list[np.ndarray] = []
    timings: list[float] = []
    for start in range(0, latents.shape[1], chunk_frames):
        feeds = {"latent": latents[:, start : start + chunk_frames, :], **state}
        tick = time.perf_counter()
        values = session.run(None, feeds)
        timings.append((time.perf_counter() - tick) * 1000)
        outputs = dict(zip(names, values))
        audio.append(outputs[names[0]].reshape(-1))
        for output_name, input_name in state_outputs.items():
            if output_name in outputs:
                state[input_name] = outputs[output_name]
    return np.concatenate(audio), timings


class StreamingCalibrationReader(CalibrationDataReader):
    def __init__(
        self,
        source_model: Path,
        manifest: list[dict[str, object]],
        latent_dim: int,
        sample_count: int,
    ) -> None:
        session = ort.InferenceSession(str(source_model), providers=["CPUExecutionProvider"])
        names = [output.name for output in session.get_outputs()]
        state_outputs = {str(spec["output_name"]): str(spec["input_name"]) for spec in manifest}
        state = initial_state(manifest)
        rng = np.random.default_rng(20260716)
        samples: list[dict[str, np.ndarray]] = []
        scales = (0.45, 0.7, 1.0, 1.3, 1.7)
        for index in range(sample_count):
            latent = rng.standard_normal((1, 12, latent_dim)).astype(np.float32) * scales[index % len(scales)]
            feeds = {"latent": latent, **state}
            samples.append({name: np.array(value, copy=True) for name, value in feeds.items()})
            outputs = dict(zip(names, session.run(None, feeds)))
            for output_name, input_name in state_outputs.items():
                if output_name in outputs:
                    state[input_name] = outputs[output_name]
        self._iterator = iter(samples)

    def get_next(self) -> dict[str, np.ndarray] | None:
        return next(self._iterator, None)


def operator_counts(path: Path) -> dict[str, int]:
    model = onnx.load(str(path), load_external_data=False)
    counts: dict[str, int] = {}
    for node in model.graph.node:
        counts[node.op_type] = counts.get(node.op_type, 0) + 1
    return dict(sorted(counts.items()))


def signal_metrics(reference: np.ndarray, candidate: np.ndarray) -> dict[str, float]:
    count = min(reference.size, candidate.size)
    reference = reference[:count].astype(np.float64)
    candidate = candidate[:count].astype(np.float64)
    difference = candidate - reference
    ref_rms = float(np.sqrt(np.mean(reference * reference)))
    error_rms = float(np.sqrt(np.mean(difference * difference)))
    correlation = float(np.corrcoef(reference, candidate)[0, 1])
    # Compare log spectra over the whole deterministic clip. This is not a
    # perceptual score, but catches frequency-colored quantization noise.
    ref_fft = np.abs(np.fft.rfft(reference)) + 1e-9
    candidate_fft = np.abs(np.fft.rfft(candidate)) + 1e-9
    log_spectral_rmse_db = float(np.sqrt(np.mean((20 * np.log10(candidate_fft / ref_fft)) ** 2)))
    return {
        "referenceRms": ref_rms,
        "candidateRms": float(np.sqrt(np.mean(candidate * candidate))),
        "maxAbsError": float(np.max(np.abs(difference))),
        "meanAbsError": float(np.mean(np.abs(difference))),
        "errorRms": error_rms,
        "snrDb": float(20 * math.log10(max(ref_rms, 1e-12) / max(error_rms, 1e-12))),
        "correlation": correlation,
        "logSpectralRmseDb": log_spectral_rmse_db,
    }


def median(values: list[float]) -> float:
    return float(np.median(np.asarray(values, dtype=np.float64)))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--deployed-int8", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--calibration-samples", type=int, default=24)
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    bundle = json.loads(args.bundle.read_text(encoding="utf-8"))
    manifest = bundle["mimi_state_manifest"]
    latent_dim = int(bundle["latent_dim"])
    conv_qdq = args.output_dir / "mimi_decoder_conv_qdq_s8s8.onnx"
    combined = args.output_dir / "mimi_decoder_conv_qdq_matmul_int8.onnx"

    reader = StreamingCalibrationReader(
        args.source, manifest, latent_dim, args.calibration_samples,
    )
    quantize_static(
        model_input=str(args.source),
        model_output=str(conv_qdq),
        calibration_data_reader=reader,
        quant_format=QuantFormat.QDQ,
        activation_type=QuantType.QInt8,
        weight_type=QuantType.QInt8,
        op_types_to_quantize=["Conv"],
        per_channel=True,
        calibrate_method=CalibrationMethod.Percentile,
        extra_options={
            "ActivationSymmetric": True,
            "WeightSymmetric": True,
            "DedicatedQDQPair": True,
        },
    )
    quantize_dynamic(
        model_input=str(conv_qdq),
        model_output=str(combined),
        op_types_to_quantize=["MatMul"],
        weight_type=QuantType.QInt8,
        extra_options={"ForceQuantizeNoType": True, "DefaultTensorType": 1},
    )

    rng = np.random.default_rng(8675309)
    validation_latents = rng.standard_normal((1, 48, latent_dim)).astype(np.float32)
    models = {"fp32": args.source, "convQdqMatmulInt8": combined}
    if args.deployed_int8:
        models["deployedMatmulInt8"] = args.deployed_int8

    sessions = {
        name: ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        for name, path in models.items()
    }
    outputs: dict[str, np.ndarray] = {}
    timings: dict[str, list[float]] = {}
    for name, session in sessions.items():
        # First run initializes kernels; report three warm repetitions.
        run_stream(session, manifest, validation_latents)
        run_times: list[float] = []
        final_audio = np.empty(0, dtype=np.float32)
        for _ in range(3):
            final_audio, chunk_times = run_stream(session, manifest, validation_latents)
            run_times.append(sum(chunk_times))
        outputs[name] = final_audio
        timings[name] = run_times

    reference = outputs["fp32"]
    report = {
        "schemaVersion": 1,
        "source": str(args.source.resolve()),
        "calibrationSamples": args.calibration_samples,
        "files": {
            name: {"path": str(path.resolve()), "bytes": path.stat().st_size}
            for name, path in models.items()
        },
        "operators": {name: operator_counts(path) for name, path in models.items()},
        "qualityVsFp32": {
            name: signal_metrics(reference, audio)
            for name, audio in outputs.items() if name != "fp32"
        },
        "nativeCpuTimingMs48Frames": {
            name: {"samples": values, "median": median(values)}
            for name, values in timings.items()
        },
    }
    candidate_quality = report["qualityVsFp32"]["convQdqMatmulInt8"]
    report["candidatePassesConservativeSignalGate"] = bool(
        candidate_quality["correlation"] >= 0.995
        and candidate_quality["snrDb"] >= 24.0
        and candidate_quality["logSpectralRmseDb"] <= 8.0
    )
    report_path = args.output_dir / "mimi_conv_quant_report.json"
    rendered = json.dumps(report, indent=2) + "\n"
    report_path.write_text(rendered, encoding="utf-8")
    print(rendered, end="")


if __name__ == "__main__":
    main()
