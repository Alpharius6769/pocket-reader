from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper
from safetensors.torch import load_file


def load_flow_lm(path: Path) -> dict[str, np.ndarray]:
    return {k: v.float().numpy() for k, v in load_file(str(path)).items() if k.startswith("flow_lm.")}


def quantize_like(weight: np.ndarray, scale_shape: tuple[int, ...]) -> tuple[np.ndarray, np.ndarray]:
    absmax = np.abs(weight).max(axis=0) if scale_shape else np.abs(weight).max()
    scale = (absmax / 127.0).astype(np.float32)
    safe = np.where(scale == 0, np.float32(1), scale)
    q = np.clip(np.round(weight / safe), -127, 127).astype(np.int8)
    return q, scale.reshape(scale_shape)


class Index:
    def __init__(self, old: dict[str, np.ndarray], new: dict[str, np.ndarray]):
        self.old = old
        self.new = new
        self.by_size: dict[int, list[str]] = defaultdict(list)
        for key, value in old.items():
            self.by_size[value.size].append(key)
        self.changed = {k for k in old if not np.array_equal(old[k], new[k])}

    def layouts(self, key: str, shape: tuple[int, ...]):
        value = self.old[key]
        yield "plain", value.reshape(shape)
        if value.ndim == 2 and value.T.size == int(np.prod(shape)):
            yield "transpose", value.T.reshape(shape)

    def new_value(self, key: str, layout: str, shape: tuple[int, ...]) -> np.ndarray:
        value = self.new[key]
        return (value.T if layout == "transpose" else value).reshape(shape)

    def match_float(self, array: np.ndarray):
        target = array.astype(np.float32)
        scored = []
        for key in self.by_size.get(array.size, []):
            for layout, candidate in self.layouts(key, array.shape):
                if np.array_equal(candidate.astype(array.dtype).astype(np.float32), target):
                    scored.append((0.0, key, layout))
                    continue
                if array.size < 16:
                    continue
                ref = float(np.abs(candidate).max())
                err = float(np.abs(candidate - target).max())
                if ref > 0 and err <= 1e-3 * ref:
                    scored.append((err / ref, key, layout))
        if not scored:
            return []
        scored.sort()
        best = scored[0]
        return [(k, l) for e, k, l in scored if e <= max(best[0] * 4, 1e-9)]

    def match_dequantized(self, deq: np.ndarray):
        best = None
        for key in self.by_size.get(deq.size, []):
            for layout, candidate in self.layouts(key, deq.shape):
                scale = np.abs(candidate).max() + 1e-12
                err = float(np.abs(candidate - deq).max() / scale)
                if best is None or err < best[0]:
                    best = (err, key, layout)
        return best


def iter_graphs(graph):
    yield graph
    for node in graph.node:
        for attr in node.attribute:
            if attr.type == onnx.AttributeProto.GRAPH:
                yield from iter_graphs(attr.g)
            elif attr.type == onnx.AttributeProto.GRAPHS:
                for sub in attr.graphs:
                    yield from iter_graphs(sub)


def tensor_slots(model):
    for graph in iter_graphs(model.graph):
        for init in graph.initializer:
            yield init
        for node in graph.node:
            if node.op_type == "Constant":
                for attr in node.attribute:
                    if attr.name == "value" and attr.type == onnx.AttributeProto.TENSOR:
                        yield attr.t


def all_nodes(model):
    for graph in iter_graphs(model.graph):
        yield from graph.node


def resolve_int8_weights(model, slots) -> dict[str, tuple[str, str | None]]:
    producers, consumers = {}, defaultdict(list)
    for node in all_nodes(model):
        for out in node.output:
            producers[out] = node
        for name in node.input:
            consumers[name].append(node)

    def weight_scale(mm):
        for cast in consumers.get(mm.output[0], []):
            if cast.op_type != "Cast":
                continue
            for mul in consumers.get(cast.output[0], []):
                if mul.op_type != "Mul":
                    continue
                for slot, other in enumerate(mul.input):
                    if other == cast.output[0]:
                        continue
                    if other in slots:
                        return other, (mul, slot)
                    combine = producers.get(other)
                    if combine is not None and combine.op_type == "Mul":
                        found = [(i, x) for i, x in enumerate(combine.input) if x in slots]
                        if len(found) == 1:
                            return found[0][1], (combine, found[0][0])
        raise SystemExit(f"cannot trace the weight scale of MatMulInteger {mm.name or mm.output[0]}")

    resolved: dict[str, tuple[str, str | None]] = {}
    sites: dict[str, list] = defaultdict(list)
    for node in all_nodes(model):
        if node.op_type != "MatMulInteger" or node.input[1] not in slots:
            continue
        weight = node.input[1]
        zero = node.input[3] if len(node.input) > 3 and node.input[3] else None
        scale, site = weight_scale(node)
        if resolved.setdefault(weight, (scale, zero)) != (scale, zero):
            raise SystemExit(f"{weight} is consumed with two different scales; refusing to guess")
        sites[weight].append(site)
    return resolved, sites


def transplant_model(path: Path, out: Path, index: Index, report: dict) -> None:
    model = onnx.load(str(path), load_external_data=True)
    slots = {}
    for tensor in tensor_slots(model):
        slots.setdefault(tensor.name, []).append(tensor)
    replaced, verified, exact, unmatched, ambiguous = [], 0, 0, [], []
    handled = set()
    resolved, sites = resolve_int8_weights(model, slots)

    for name, (scale_name, zero_name) in resolved.items():
        q = numpy_helper.to_array(slots[name][0])
        scale = numpy_helper.to_array(slots[scale_name][0])
        zero = numpy_helper.to_array(slots[zero_name][0]) if zero_name else np.zeros(1, np.int8)
        if q.dtype != np.int8 or q.ndim != 2 or np.any(zero != 0):
            raise SystemExit(f"{path.name}: {name} is not symmetric int8 [K,N]; refusing to guess its recipe")
        handled.update({name, scale_name})
        deq = q.astype(np.float32) * scale.astype(np.float32)
        best = index.match_dequantized(deq)
        if best is None or best[0] > 0.01:
            unmatched.append(f"{name} (int8 {list(q.shape)}, best relerr {best[0] if best else 'n/a'})")
            continue
        _, key, layout = best
        old_w = next(c for l, c in index.layouts(key, q.shape) if l == layout)
        q_check, s_check = quantize_like(old_w, scale.shape)
        if not np.allclose(s_check, scale, rtol=1e-3, atol=0) or np.mean(q_check != q) > 0.001:
            raise SystemExit(f"{path.name}: requantizing April {key} does not reproduce the deployed {name}; recipe mismatch")
        verified += 1
        exact += int(np.array_equal(q_check, q))
        if key not in index.changed:
            continue
        q_new, s_new = quantize_like(index.new_value(key, layout, q.shape), scale.shape)
        for t in slots[name]:
            t.CopyFrom(numpy_helper.from_array(q_new, name))
        sharers = [w for w, (s, _) in resolved.items() if s == scale_name and w != name]
        if sharers:
            mine = {id(node) for node, _ in sites[name]}
            theirs = {id(node) for w in sharers for node, _ in sites[w]}
            if mine & theirs:
                raise SystemExit(f"{path.name}: {name} and {sharers} share the node that applies {scale_name}")
            split = f"{scale_name}__{name}"
            model.graph.initializer.append(numpy_helper.from_array(s_new.astype(scale.dtype), split))
            for node, slot in sites[name]:
                node.input[slot] = split
            replaced.append(f"{key} -> {split} (scale split from shared {scale_name})")
        else:
            for t in slots[scale_name]:
                t.CopyFrom(numpy_helper.from_array(s_new.astype(scale.dtype), scale_name))
        replaced.append(f"{key} -> {name} (int8 {'per-channel' if scale.shape else 'per-tensor'})")

    stray = [n for n, t in slots.items() if n not in handled and t[0].data_type == onnx.TensorProto.INT8 and int(np.prod(t[0].dims) if t[0].dims else 1) > 4096]
    if stray:
        raise SystemExit(f"{path.name}: int8 weights not reached through MatMulInteger: {stray[:5]}")

    for name, tensors in slots.items():
        if name in handled:
            continue
        array = numpy_helper.to_array(tensors[0])
        if array.dtype not in (np.float32, np.float16) or array.size == 0:
            continue
        hits = index.match_float(array)
        keys = {k for k, _ in hits}
        if not hits:
            if array.size >= 256:
                unmatched.append(f"{name} ({array.dtype} {list(array.shape)})")
            continue
        changed_keys = keys & index.changed
        if not changed_keys:
            continue
        if len(keys) > 1:
            ambiguous.append(f"{name} matches {sorted(keys)}")
            continue
        key, layout = hits[0]
        value = index.new_value(key, layout, array.shape).astype(array.dtype)
        for t in tensors:
            t.CopyFrom(numpy_helper.from_array(value, name))
        replaced.append(f"{key} -> {name} ({array.dtype})")

    if ambiguous:
        raise SystemExit(f"{path.name}: ambiguous tensors, refusing to write: {ambiguous}")
    out.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(out))
    report[path.name] = {
        "replaced": len(replaced),
        "int8_recipe_verified": verified,
        "int8_recipe_byte_exact": exact,
        "unmatched_large_tensors": unmatched,
        "changed_keys_used": sorted({r.split(" -> ")[0] for r in replaced}),
    }


def transplant_npy(path: Path, out: Path, index: Index, report: dict) -> None:
    array = np.load(path)
    hits = index.match_float(array)
    if len({k for k, _ in hits}) != 1:
        raise SystemExit(f"{path.name}: expected exactly one source tensor, found {hits}")
    key, layout = hits[0]
    out.parent.mkdir(parents=True, exist_ok=True)
    np.save(out, index.new_value(key, layout, array.shape).astype(array.dtype))
    report[path.name] = {"replaced": 1, "changed_keys_used": [key]}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Rebuild deployed Pocket TTS graphs for a retrained checkpoint with the same architecture. "
        "Each weight is located by matching the old checkpoint, then replaced (INT8 tensors are re-quantized "
        "with the recipe proven to reproduce the deployed bytes)."
    )
    parser.add_argument("--old-weights", type=Path, required=True)
    parser.add_argument("--new-weights", type=Path, required=True)
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("files", nargs="+")
    args = parser.parse_args()

    index = Index(load_flow_lm(args.old_weights), load_flow_lm(args.new_weights))
    report: dict[str, dict] = {"changed_checkpoint_keys": sorted(index.changed)}
    for rel in args.files:
        src = args.input_dir / rel
        dst = args.output_dir / rel
        if src.suffix == ".npy":
            transplant_npy(src, dst, index, report)
        else:
            transplant_model(src, dst, index, report)
        report[src.name]["sha256"] = sha256(dst)
        report[src.name]["bytes"] = dst.stat().st_size
        print(f"{rel}: {json.dumps({k: v for k, v in report[src.name].items() if k != 'changed_keys_used'})}")
    (args.output_dir / "transplant_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
