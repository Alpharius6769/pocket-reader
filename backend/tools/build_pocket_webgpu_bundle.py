"""Build the legacy R1 FP16 developer-comparison bundle.

R1 is intentionally not eligible for production auto-selection. Use the R2
certifier before publishing any replacement under the R2 bundle path.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import urllib.request
from pathlib import Path

import onnx
from onnx import TensorProto, helper
from onnxruntime.transformers.float16 import convert_float_to_float16


HF_BASE = "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/main/onnx/english_2026-04"
SOURCE_FILES = {
    "text_conditioner": "text_conditioner.onnx",
    "flow_lm_main": "flow_lm_main.onnx",
    "flow_lm_flow": "flow_lm_flow.onnx",
    "mimi_decoder": "mimi_decoder.onnx",
}
SUPPORT_FILES = ("bundle.json", "tokenizer.model", "bos_before_voice.npy")
OUTPUT_FILES = {stem: f"{stem}_fp16.onnx" for stem in SOURCE_FILES}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.stat().st_size:
        return
    temporary = destination.with_suffix(destination.suffix + ".partial")
    request = urllib.request.Request(url, headers={"User-Agent": "Pocket-Reader-WebGPU-Bundle/1"})
    with urllib.request.urlopen(request, timeout=120) as response, temporary.open("wb") as output:
        shutil.copyfileobj(response, output, length=1024 * 1024)
    temporary.replace(destination)


def signature(model: onnx.ModelProto) -> dict[str, list[dict[str, object]]]:
    initializer_names = {item.name for item in model.graph.initializer}

    def describe(values):
        rows = []
        for value in values:
            if value.name in initializer_names:
                continue
            tensor = value.type.tensor_type
            dims = []
            for dim in tensor.shape.dim:
                dims.append(dim.dim_value if dim.HasField("dim_value") else dim.dim_param)
            rows.append({"name": value.name, "type": tensor.elem_type, "dims": dims})
        return rows

    return {"inputs": describe(model.graph.input), "outputs": describe(model.graph.output)}


def restore_float32_boundaries(model: onnx.ModelProto, source_signature: dict[str, list[dict[str, object]]]) -> None:
    """Keep public FP32 I/O while internal tensors and weights use FP16."""
    float_inputs = {row["name"] for row in source_signature["inputs"] if row["type"] == TensorProto.FLOAT}
    float_outputs = {row["name"] for row in source_signature["outputs"] if row["type"] == TensorProto.FLOAT}

    input_casts = []
    for value in model.graph.input:
        if value.name not in float_inputs:
            continue
        public_name = value.name
        internal_name = f"{public_name}__fp16_internal"
        value.type.tensor_type.elem_type = TensorProto.FLOAT
        for node in model.graph.node:
            for index, name in enumerate(node.input):
                if name == public_name:
                    node.input[index] = internal_name
        input_casts.append(helper.make_node("Cast", [public_name], [internal_name], to=TensorProto.FLOAT16, name=f"{public_name}__to_fp16"))

    for node in reversed(input_casts):
        model.graph.node.insert(0, node)

    output_casts = []
    for value in model.graph.output:
        if value.name not in float_outputs:
            continue
        public_name = value.name
        internal_name = f"{public_name}__fp16_internal"
        value.type.tensor_type.elem_type = TensorProto.FLOAT
        for node in model.graph.node:
            for index, name in enumerate(node.output):
                if name == public_name:
                    node.output[index] = internal_name
            for index, name in enumerate(node.input):
                if name == public_name:
                    node.input[index] = internal_name
        for info in model.graph.value_info:
            if info.name == public_name:
                info.name = internal_name
        output_casts.append(helper.make_node("Cast", [internal_name], [public_name], to=TensorProto.FLOAT, name=f"{public_name}__to_fp32"))

    model.graph.node.extend(output_casts)


def topologically_sort_graph(model: onnx.ModelProto) -> None:
    available = {value.name for value in model.graph.input}
    available.update(value.name for value in model.graph.initializer)
    pending = list(model.graph.node)
    ordered = []
    while pending:
        next_pending = []
        progressed = False
        for node in pending:
            if all(not name or name in available for name in node.input):
                ordered.append(node)
                available.update(name for name in node.output if name)
                progressed = True
            else:
                next_pending.append(node)
        if not progressed:
            missing = sorted({name for node in next_pending for name in node.input if name and name not in available})
            raise RuntimeError(f"Unable to topologically sort graph; unresolved inputs: {missing[:10]}")
        pending = next_pending
    del model.graph.node[:]
    model.graph.node.extend(ordered)


def range_output_types(model: onnx.ModelProto) -> dict[str, int]:
    inferred = onnx.shape_inference.infer_shapes(model)
    value_types = {
        value.name: value.type.tensor_type.elem_type
        for value in (*inferred.graph.input, *inferred.graph.value_info, *inferred.graph.output)
        if value.type.HasField("tensor_type")
    }
    return {
        output_name: value_types.get(output_name, 0)
        for node in inferred.graph.node if node.op_type == "Range"
        for output_name in node.output
    }


def keep_range_in_float32(model: onnx.ModelProto, original_range_types: dict[str, int]) -> None:
    """Range has no FP16 kernel; surround it with explicit boundary casts."""
    rewritten = []
    for node in model.graph.node:
        if node.op_type != "Range" or not any(original_range_types.get(name) == TensorProto.FLOAT for name in node.output):
            rewritten.append(node)
            continue
        for index, input_name in enumerate(list(node.input)):
            cast_name = f"{node.name or 'Range'}__input_{index}_fp32"
            rewritten.append(helper.make_node("Cast", [input_name], [cast_name], to=TensorProto.FLOAT, name=f"{cast_name}__cast"))
            node.input[index] = cast_name
        for index, output_name in enumerate(list(node.output)):
            internal_name = f"{output_name}__range_fp32"
            node.output[index] = internal_name
            rewritten.append(node)
            rewritten.append(helper.make_node("Cast", [internal_name], [output_name], to=TensorProto.FLOAT16, name=f"{output_name}__range_to_fp16"))
            break
    del model.graph.node[:]
    model.graph.node.extend(rewritten)


def convert_model(source: Path, destination: Path) -> dict[str, object]:
    source_model = onnx.load(str(source), load_external_data=True)
    source_signature = signature(source_model)
    original_range_types = range_output_types(source_model)
    converted = convert_float_to_float16(
        source_model,
        keep_io_types=False,
        disable_shape_infer=False,
        max_finite_val=65504.0,
        op_block_list=[],
    )
    keep_range_in_float32(converted, original_range_types)
    restore_float32_boundaries(converted, source_signature)
    topologically_sort_graph(converted)
    onnx.checker.check_model(converted, full_check=True)
    converted_signature = signature(converted)
    if converted_signature != source_signature:
        raise RuntimeError(f"Graph interface changed during FP16 conversion: {source.name}")
    onnx.save_model(converted, str(destination))
    verified = onnx.load(str(destination), load_external_data=True)
    onnx.checker.check_model(verified, full_check=True)
    if signature(verified) != source_signature:
        raise RuntimeError(f"Saved graph interface mismatch: {destination.name}")
    return {
        "source_bytes": source.stat().st_size,
        "bytes": destination.stat().st_size,
        "sha256": sha256(destination),
        "interface": source_signature,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work-dir", type=Path, default=Path("pocket-webgpu-build"))
    parser.add_argument("--output-dir", type=Path, default=Path("pocket-webgpu-b2-upload"))
    args = parser.parse_args()

    source_dir = args.work_dir / "source"
    bundle_dir = args.output_dir / "onnx" / "english_2026-04-webgpu-fp16"
    source_dir.mkdir(parents=True, exist_ok=True)
    bundle_dir.mkdir(parents=True, exist_ok=True)

    for filename in (*SUPPORT_FILES, *SOURCE_FILES.values()):
        download(f"{HF_BASE}/{filename}?download=true", source_dir / filename)

    source_manifest = json.loads((source_dir / "bundle.json").read_text(encoding="utf-8"))
    artifacts: dict[str, dict[str, object]] = {}
    for stem, source_name in SOURCE_FILES.items():
        output_name = OUTPUT_FILES[stem]
        artifacts[output_name] = convert_model(source_dir / source_name, bundle_dir / output_name)

    for filename in ("tokenizer.model", "bos_before_voice.npy"):
        shutil.copy2(source_dir / filename, bundle_dir / filename)
        artifacts[filename] = {
            "bytes": (bundle_dir / filename).stat().st_size,
            "sha256": sha256(bundle_dir / filename),
        }

    manifest = {
        **source_manifest,
        "bundle_name": "english_2026-04-webgpu-fp16",
        "backend": "webgpu-resident",
        "precision": "fp16",
        "runtime": "onnxruntime-web",
        "runtime_version": "1.27.0",
        "model_revision": "english-2026-04-fp16-r1",
        "certified_for_auto_selection": False,
        "source_repository": "KevinAHM/pocket-tts-onnx",
        "source_bundle": "english_2026-04",
        "model_files": OUTPUT_FILES,
        "artifacts": artifacts,
    }
    manifest_path = bundle_dir / "bundle.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    artifacts["bundle.json"] = {"bytes": manifest_path.stat().st_size, "sha256": sha256(manifest_path)}

    integrity_path = bundle_dir / "integrity.json"
    integrity_path.write_text(json.dumps({"revision": manifest["model_revision"], "files": artifacts}, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(bundle_dir), "files": artifacts}, indent=2))


if __name__ == "__main__":
    main()
