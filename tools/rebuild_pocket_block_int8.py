#!/usr/bin/env python3
"""Rebuild the Pocket TTS decode block as a PER-CHANNEL INT8 model.

Maintainer tool. Not loaded by the app or the backend at runtime.

Why this exists
---------------
The decode block shipped as INT8 with a single scalar scale per weight matrix.
Scored against the FP16 build of the same model on identical inputs, rolling the
recurrent state forward the way pocket_worker.js does, that lands at

    latent SNR   9.89 dB      eos SNR  21.46 dB      max|err| 0.76

The latents drive the vocoder, so this is upstream of everything else in the
pipeline -- the single largest quality loss in Pocket TTS. Re-quantizing the same
weights with per-channel scales gives

    latent SNR  23.31 dB      eos SNR  30.42 dB      max|err| 0.19

a 4.7x reduction in noise power, in a file that is 1.8 MB SMALLER and loads
roughly twice as fast in ORT Web.

The Gemm problem
----------------
ORT's quantizer rewrites Gemm to MatMul before quantizing and gets it wrong on
this graph: /flow_net/cond_embed/Gemm_MatMul fails shape inference even when the
node is excluded from quantization, so the rewrite -- not the quantization -- is
the defect. All 92 Gemms here are (alpha=1, beta=1, transA=0, transB=1) with the
weight as an initializer, so this tool folds them to MatMul + Add itself, which
is exact. Verified: the folded FP32 master scores 66.10 dB against FP16, i.e.
only FP16's own mantissa limit.

Variants that were measured and rejected
----------------------------------------
    per-channel + reduce_range          17.08 dB   86.4 MB   (worse)
    per-channel + 8 worst left float    22.46 dB  108.4 MB   (worse, bigger)
    per-channel + 24 worst left float   23.11 dB  117.8 MB   (worse, bigger)

Plain per-channel wins on both axes: exclusions target the dynamic-range problem
that per-channel already solves, and only add size.

Usage
-----
    python tools/rebuild_pocket_block_int8.py \
        --fp16 path/to/flow_lm_decode_block4_fp16.onnx \
        --out  path/to/flow_lm_decode_block4_int8_pc.onnx

Then score it before uploading anything:

    python tools/rebuild_pocket_block_int8.py --score \
        --fp16 fp16.onnx --candidate out.onnx --bundle bundle.json --bos flow_lm_bos.npy
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


# ── FP16 -> FP32 ────────────────────────────────────────────────────────────

def widen_to_fp32(model: onnx.ModelProto) -> int:
    converted = 0
    for init in model.graph.initializer:
        if init.data_type == TensorProto.FLOAT16:
            arr = numpy_helper.to_array(init).astype(np.float32)
            init.CopyFrom(numpy_helper.from_array(arr, init.name))
            converted += 1
    for vis in (model.graph.input, model.graph.output, model.graph.value_info):
        for vi in vis:
            tt = vi.type.tensor_type
            if tt.elem_type == TensorProto.FLOAT16:
                tt.elem_type = TensorProto.FLOAT
    for node in model.graph.node:
        for attr in node.attribute:
            if attr.name == "to" and attr.i == TensorProto.FLOAT16:
                attr.i = TensorProto.FLOAT
            if attr.type == onnx.AttributeProto.TENSOR and attr.t.data_type == TensorProto.FLOAT16:
                arr = numpy_helper.to_array(attr.t).astype(np.float32)
                attr.t.CopyFrom(numpy_helper.from_array(arr, attr.t.name))
                converted += 1
    return converted


# ── Gemm -> MatMul + Add ────────────────────────────────────────────────────

def fold_gemms(model: onnx.ModelProto) -> int:
    graph = model.graph
    inits = {i.name: i for i in graph.initializer}
    out_nodes, folded = [], 0
    for node in graph.node:
        if node.op_type != "Gemm":
            out_nodes.append(node)
            continue
        attrs = {a.name: (a.i if a.type == onnx.AttributeProto.INT else a.f)
                 for a in node.attribute}
        if (attrs.get("alpha", 1.0) != 1.0 or attrs.get("beta", 1.0) != 1.0
                or attrs.get("transA", 0) != 0 or attrs.get("transB", 0) != 1
                or len(node.input) != 3 or node.input[1] not in inits):
            # Anything outside the uniform shape this model uses is left alone
            # rather than folded on a guess.
            out_nodes.append(node)
            continue
        a_name, b_name, c_name = node.input
        bt_name = b_name + "_T"
        if bt_name not in inits:
            b = numpy_helper.to_array(inits[b_name])
            t = numpy_helper.from_array(np.ascontiguousarray(b.T), bt_name)
            graph.initializer.append(t)
            inits[bt_name] = t
        mm_out = node.output[0] + "_mm"
        out_nodes.append(helper.make_node("MatMul", [a_name, bt_name], [mm_out],
                                          name=node.name + "_mm"))
        out_nodes.append(helper.make_node("Add", [mm_out, c_name], [node.output[0]],
                                          name=node.name + "_bias"))
        folded += 1
    del graph.node[:]
    graph.node.extend(out_nodes)
    return folded


def build(fp16_path: str, out_path: str, workdir: str) -> str:
    from onnxruntime.quantization import quantize_dynamic, QuantType

    os.makedirs(workdir, exist_ok=True)
    master = os.path.join(workdir, "master_fp32_degemm.onnx")

    print(f"loading {fp16_path}")
    model = onnx.load(fp16_path)
    print(f"  widened {widen_to_fp32(model)} fp16 tensors to fp32")
    print(f"  folded  {fold_gemms(model)} Gemm nodes to MatMul + Add")
    onnx.save(model, master, save_as_external_data=False)
    print(f"  master: {os.path.getsize(master) / 1e6:.1f} MB")

    print("quantizing (per-channel, int8 weights)")
    quantize_dynamic(
        master, out_path,
        per_channel=True, reduce_range=False, weight_type=QuantType.QInt8,
        extra_options={"DefaultTensorType": int(TensorProto.FLOAT)},
    )
    print(f"  {out_path}: {os.path.getsize(out_path) / 1e6:.1f} MB")

    import onnxruntime as ort
    o = ort.SessionOptions()
    o.log_severity_level = 3
    ort.InferenceSession(out_path, o, providers=["CPUExecutionProvider"])
    print("  loads: OK")

    ref = {i.name for i in onnx.load(fp16_path, load_external_data=False).graph.input}
    got = {i.name for i in onnx.load(out_path, load_external_data=False).graph.input}
    if ref != got:
        raise SystemExit(f"input contract changed: {ref ^ got}")
    print("  I/O contract: identical to the FP16 master")
    return out_path


# ── Scoring ─────────────────────────────────────────────────────────────────

def score(candidate: str, fp16: str, bundle: str, bos: str, blocks: int = 6,
          seeds=(1, 2, 3)) -> float:
    import json
    import onnxruntime as ort

    with open(bundle, "r", encoding="utf-8") as f:
        manifest = {e["input_name"]: e for e in json.load(f)["flow_lm_state_manifest"]}
    np_of = {TensorProto.FLOAT: np.float32, TensorProto.BOOL: np.bool_,
             TensorProto.INT64: np.int64}

    def sess(path):
        o = ort.SessionOptions()
        o.log_severity_level = 3
        return ort.InferenceSession(path, o, providers=["CPUExecutionProvider"])

    def template(path):
        m = onnx.load(path, load_external_data=False)
        feeds = {}
        for i in m.graph.input:
            if i.name in ("sequence", "random_latents"):
                continue
            tt = i.type.tensor_type
            dims = [(d.dim_value if d.HasField("dim_value") else 1) for d in tt.shape.dim]
            fill = manifest.get(i.name, {}).get("fill", "zeros")
            make = np.ones if fill == "ones" else np.zeros
            feeds[i.name] = make(dims, dtype=np_of[tt.elem_type])
        return feeds

    bos_arr = np.load(bos).reshape(1, 1, -1).astype(np.float32)

    def rollout(s, tpl, seed):
        feeds = {k: v.copy() for k, v in tpl.items()}
        names = [o.name for o in s.get_outputs()]
        rng = np.random.default_rng(seed)
        seq, lat = bos_arr, []
        for _ in range(blocks):
            feeds["sequence"] = seq
            feeds["random_latents"] = rng.standard_normal((1, 4, bos_arr.shape[-1])).astype(np.float32)
            outs = dict(zip(names, s.run(names, feeds)))
            lat.append(np.asarray(outs["latents"], dtype=np.float64).reshape(-1))
            seq = outs["next_sequence"]
            for k in list(feeds):
                if k in ("sequence", "random_latents"):
                    continue
                nxt = outs.get("out_" + k)
                if nxt is not None:
                    feeds[k] = nxt
        return np.concatenate(lat)

    ref_s, cand_s, tpl = sess(fp16), sess(candidate), template(fp16)
    snrs = []
    for seed in seeds:
        a, b = rollout(ref_s, tpl, seed), rollout(cand_s, tpl, seed)
        noise = float(np.mean((a - b) ** 2))
        snrs.append(10 * np.log10(float(np.mean(a ** 2)) / noise) if noise > 0 else float("inf"))
    mean = float(np.mean(snrs))
    print(f"latent SNR vs FP16: {mean:.2f} dB   ({os.path.getsize(candidate)/1e6:.1f} MB)")
    return mean


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fp16", required=True, help="FP16 decode-block master")
    ap.add_argument("--out", help="output INT8 path (build mode)")
    ap.add_argument("--workdir", default="build/pocket-block", help="scratch directory")
    ap.add_argument("--score", action="store_true", help="score a candidate instead of building")
    ap.add_argument("--candidate", help="model to score")
    ap.add_argument("--bundle", help="bundle.json (for the state manifest)")
    ap.add_argument("--bos", help="flow_lm_bos.npy")
    ap.add_argument("--blocks", type=int, default=6)
    args = ap.parse_args()

    if args.score:
        for required in ("candidate", "bundle", "bos"):
            if not getattr(args, required):
                ap.error(f"--score needs --{required}")
        score(args.candidate, args.fp16, args.bundle, args.bos, blocks=args.blocks)
        return

    if not args.out:
        ap.error("build mode needs --out")
    build(args.fp16, args.out, args.workdir)
    print("\nScore it against the FP16 master before uploading:")
    print(f"  python {sys.argv[0]} --score --fp16 {args.fp16} "
          f"--candidate {args.out} --bundle bundle.json --bos flow_lm_bos.npy")


if __name__ == "__main__":
    main()
