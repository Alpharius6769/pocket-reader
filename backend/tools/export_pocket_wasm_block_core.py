"""Export a fixed-frame Pocket TTS decode block for WASM/INT8.

The WebGPU R2/R3 cores proved the unrolled decode-block architecture. On the
WASM backend every run() round-trips the full ~47MB flow-LM state across the
JS/WASM boundary, so K=4 or K=8 reduces that traffic independently of the
runtime binary experiment.

This produces (INT8, matching the deployed english_2026-04 bundle):
  flow_lm_decode_block4_int8.onnx
  flow_lm_bos.npy   (explicit BOS sequence - the block graph has no NaN->BOS
                     substitution, unlike flow_lm_main)

State layout is identical to flow_lm_main's manifest (same init_states /
flatten_state code), so the runtime keeps using flow_lm_main_int8 for text
prefill and swaps only the AR loop.

Usage (from repo root, .venv-webgpu-export python):
  python "Back end/tools/export_pocket_wasm_block_core.py" \
    --exporter-dir pocket-webgpu-r2-build/exporter \
    --output-dir pocket-wasm-block-b2-upload/onnx/english_2026-04 \
    --frames 4
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from collections import defaultdict, deque
from pathlib import Path

import numpy as np
import torch


def toposort_graph(model):
    """ORT requires topologically ordered nodes; the traced unrolled loop can
    emit them out of order. Kahn's algorithm over node value dependencies."""
    graph = model.graph
    available = {i.name for i in graph.initializer} | {i.name for i in graph.input}
    producers = {}
    for idx, node in enumerate(graph.node):
        for out in node.output:
            producers[out] = idx
    indegree = [0] * len(graph.node)
    dependents = defaultdict(list)
    for idx, node in enumerate(graph.node):
        for inp in node.input:
            if inp and inp not in available and inp in producers:
                dependents[producers[inp]].append(idx)
                indegree[idx] += 1
    queue = deque(i for i, d in enumerate(indegree) if d == 0)
    order = []
    while queue:
        i = queue.popleft()
        order.append(i)
        for j in dependents[i]:
            indegree[j] -= 1
            if indegree[j] == 0:
                queue.append(j)
    if len(order) != len(graph.node):
        raise RuntimeError("Graph has a dependency cycle; cannot toposort.")
    nodes = [graph.node[i] for i in order]
    del graph.node[:]
    graph.node.extend(nodes)
    return model


def fold_identity_nodes(model):
    """The unrolled trace aliases shared weights through Identity nodes, and
    onnxruntime's dynamic quantizer only quantizes a MatMul whose B input is a
    direct initializer - so every FFN MatMul behind an Identity was silently
    skipped, leaving 264MB of fp32 weights in the 'int8' model. Rewire
    consumers to the Identity's source and drop the alias."""
    graph = model.graph
    graph_outputs = {o.name for o in graph.output}
    alias = {}
    kept = []
    for node in graph.node:
        if node.op_type == "Identity" and node.output[0] not in graph_outputs:
            alias[node.output[0]] = node.input[0]
        else:
            kept.append(node)

    def resolve(name):
        while name in alias:
            name = alias[name]
        return name

    for node in kept:
        for i, inp in enumerate(node.input):
            node.input[i] = resolve(inp)
    removed = len(graph.node) - len(kept)
    del graph.node[:]
    graph.node.extend(kept)
    return model, removed


def decompose_gemm_nodes(model):
    """onnxruntime's dynamic quantizer mis-handles Gemm with transB=1 here
    (it emits MatMulInteger without transposing the weight). Decompose every
    initializer-weighted Gemm into MatMul(A, W_T) + Add(bias), matching the
    plain-MatMul form the deployed single-step exports already use."""
    import onnx
    from onnx import helper, numpy_helper

    graph = model.graph
    inits = {i.name: i for i in graph.initializer}
    new_nodes = []
    new_inits = []
    counter = 0
    for node in graph.node:
        if node.op_type != "Gemm" or len(node.input) < 2 or node.input[1] not in inits:
            new_nodes.append(node)
            continue
        attrs = {a.name: a for a in node.attribute}
        alpha = attrs["alpha"].f if "alpha" in attrs else 1.0
        beta = attrs["beta"].f if "beta" in attrs else 1.0
        trans_a = attrs["transA"].i if "transA" in attrs else 0
        trans_b = attrs["transB"].i if "transB" in attrs else 0
        if alpha != 1.0 or beta != 1.0 or trans_a != 0:
            new_nodes.append(node)
            continue
        weight = numpy_helper.to_array(inits[node.input[1]])
        if trans_b:
            weight = weight.T.copy()
        wt_name = f"{node.input[1]}_mmT_{counter}"
        counter += 1
        new_inits.append(numpy_helper.from_array(weight, wt_name))
        mm_out = f"{node.output[0]}_mm"
        base = node.name or node.output[0]
        new_nodes.append(helper.make_node(
            "MatMul", [node.input[0], wt_name], [mm_out], name=f"{base}_MatMulD"))
        if len(node.input) >= 3 and node.input[2]:
            new_nodes.append(helper.make_node(
                "Add", [mm_out, node.input[2]], [node.output[0]], name=f"{base}_BiasAdd"))
        else:
            new_nodes.append(helper.make_node(
                "Identity", [mm_out], [node.output[0]], name=f"{base}_Out"))
    del graph.node[:]
    graph.node.extend(new_nodes)
    graph.initializer.extend(new_inits)
    return model, len(new_inits)


def eliminate_dead_nodes(model):
    """Backward liveness from graph outputs: the quantizer leaves the original
    fp32 weights connected through dead Identity chains, keeping 264MB alive."""
    graph = model.graph
    live_values = {o.name for o in graph.output}
    changed = True
    live_nodes = set()
    while changed:
        changed = False
        for idx, node in enumerate(graph.node):
            if idx in live_nodes:
                continue
            if any(out in live_values for out in node.output):
                live_nodes.add(idx)
                for inp in node.input:
                    if inp and inp not in live_values:
                        live_values.add(inp)
                        changed = True
    kept = [graph.node[i] for i in range(len(graph.node)) if i in live_nodes]
    removed = len(graph.node) - len(kept)
    del graph.node[:]
    graph.node.extend(kept)
    return model, removed


def prune_unused_initializers(model):
    """quantize_dynamic rewires MatMul nodes onto quantized weight copies but
    leaves the original fp32 initializers in the graph - hundreds of MB of
    orphans. Remove every initializer no node or graph output references."""
    graph = model.graph
    referenced = set()
    for node in graph.node:
        referenced.update(inp for inp in node.input if inp)
        for attr in node.attribute:
            if attr.g:
                for sub in attr.g.node:
                    referenced.update(i for i in sub.input if i)
    referenced.update(o.name for o in graph.output)
    keep = [init for init in graph.initializer if init.name in referenced]
    pruned = len(graph.initializer) - len(keep)
    del graph.initializer[:]
    graph.initializer.extend(keep)
    return model, pruned


def dedupe_initializers(model):
    """Merge byte-identical initializers (the quantizer emits one int8 copy of
    a shared weight per consuming MatMul in the unrolled block)."""
    import onnx
    from onnx import numpy_helper

    seen = {}
    rename = {}
    keep = []
    for init in model.graph.initializer:
        arr = numpy_helper.to_array(init)
        key = hashlib.sha256(
            str(init.data_type).encode() + b"|"
            + ",".join(map(str, init.dims)).encode() + b"|"
            + arr.tobytes()
        ).hexdigest()
        if key in seen:
            rename[init.name] = seen[key]
        else:
            seen[key] = init.name
            keep.append(init)
    for node in model.graph.node:
        for i, name in enumerate(node.input):
            if name in rename:
                node.input[i] = rename[name]
    del model.graph.initializer[:]
    model.graph.initializer.extend(keep)
    return model, len(rename)


def load_r2_module(tools_dir: Path):
    spec = importlib.util.spec_from_file_location(
        "export_pocket_webgpu_r2_core", tools_dir / "export_pocket_webgpu_r2_core.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def export(exporter_dir: Path, output_dir: Path, language: str, frames: int = 4) -> dict[str, object]:
    if frames not in (2, 4, 6, 8):
        raise ValueError("Only isolated block2, block4, block6, and block8 candidates are supported.")
    tools_dir = Path(__file__).resolve().parent
    r2 = load_r2_module(tools_dir)
    r2.configure_imports(exporter_dir)
    from onnx_export.export_utils import flatten_state, get_state_structure
    from pocket_tts.models.tts_model import TTSModel
    from pocket_tts.modules.stateful_module import init_states

    torch.manual_seed(42)
    output_dir.mkdir(parents=True, exist_ok=True)
    model = TTSModel.load_model(language=language).cpu().eval()
    state = init_states(model.flow_lm, batch_size=1, sequence_length=1000)
    structure = get_state_structure(state)
    flat_state = flatten_state(state)
    state_inputs = [f"state_{index}" for index in range(len(flat_state))]
    state_outputs = [f"out_state_{index}" for index in range(len(flat_state))]

    decode = r2.FlowLmDecodeBlockWrapper(model.flow_lm, structure, frames=frames).eval()
    bos_sequence = model.flow_lm.bos_emb.detach().reshape(1, 1, model.flow_lm.ldim).to(torch.float32)
    dummy_random = torch.randn(1, frames, model.flow_lm.ldim)

    model_stem = f"flow_lm_decode_block{frames}"
    fp32_path = output_dir / f"{model_stem}.onnx"
    torch.onnx.export(
        decode,
        (bos_sequence, dummy_random, flat_state),
        str(fp32_path),
        input_names=["sequence", "random_latents", *state_inputs],
        output_names=["latents", "next_sequence", "eos_logits", *state_outputs],
        opset_version=14,
        dynamo=False,
    )

    # Post-process the traced export: topologically sort (ORT rejects the raw
    # unrolled trace's node order) and dedupe shared initializers, then apply
    # the same quantization recipe as the deployed bundle
    # (exporter/scripts/quantize.py): shape inference + dynamic MatMul INT8.
    import onnx
    from onnxruntime.quantization import QuantType, quantize_dynamic

    fp32_model = onnx.load(str(fp32_path))
    fp32_model = toposort_graph(fp32_model)
    fp32_model, folded = fold_identity_nodes(fp32_model)
    fp32_model, gemms = decompose_gemm_nodes(fp32_model)
    fp32_model, fp32_dupes = dedupe_initializers(fp32_model)
    onnx.save(fp32_model, str(fp32_path))
    print(f"fp32 post-process: {folded} Identity aliases folded, {gemms} Gemm "
          f"weights decomposed, {fp32_dupes} duplicates merged, "
          f"{fp32_path.stat().st_size/1048576:.1f} MB")

    inferred = onnx.shape_inference.infer_shapes(onnx.load(str(fp32_path)))
    temp_path = output_dir / f"{model_stem}.temp.onnx"
    onnx.save(inferred, str(temp_path))
    int8_path = output_dir / f"{model_stem}_int8.onnx"
    quantize_dynamic(
        model_input=str(temp_path),
        model_output=str(int8_path),
        op_types_to_quantize=["MatMul"],
        weight_type=QuantType.QInt8,
        extra_options={"ForceQuantizeNoType": True, "DefaultTensorType": 1},
    )
    temp_path.unlink(missing_ok=True)

    int8_model = onnx.load(str(int8_path))
    int8_model = toposort_graph(int8_model)
    int8_model, dead = eliminate_dead_nodes(int8_model)
    int8_model, int8_dupes = dedupe_initializers(int8_model)
    int8_model, pruned = prune_unused_initializers(int8_model)
    onnx.save(int8_model, str(int8_path))
    print(f"int8 post-process: {dead} dead nodes removed, {int8_dupes} duplicates "
          f"merged, {pruned} orphans pruned, {int8_path.stat().st_size/1048576:.1f} MB")

    bos_path = output_dir / "flow_lm_bos.npy"
    np.save(bos_path, bos_sequence.numpy())

    metadata = {
        "language": language,
        "decode_block_frames": frames,
        "backend": "wasm-int8",
        "files": {
            "fp32": fp32_path.name,
            "int8": int8_path.name,
            "bos": bos_path.name,
        },
        "bytes": {
            "fp32": fp32_path.stat().st_size,
            "int8": int8_path.stat().st_size,
        },
    }
    metadata_name = "wasm_block_core.json" if frames == 4 else f"wasm_block{frames}_core.json"
    (output_dir / metadata_name).write_text(
        json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return metadata


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exporter-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--language", default="english_2026-04")
    parser.add_argument("--frames", type=int, choices=(2, 4, 6, 8), default=4)
    args = parser.parse_args()
    print(json.dumps(export(args.exporter_dir, args.output_dir, args.language, args.frames), indent=2))


if __name__ == "__main__":
    main()
