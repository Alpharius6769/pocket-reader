"""Export Pocket TTS WebGPU R2 prefill and four-frame decode core graphs."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn


def configure_imports(exporter_dir: Path) -> None:
    sys.path.insert(0, str(exporter_dir.resolve()))
    # Importing this module installs the same streaming-state patches used by
    # the verified upstream ONNX export.
    __import__("scripts.export_flow_lm")


class StateWrapper(nn.Module):
    def __init__(self, flow_lm, state_structure):
        super().__init__()
        self.flow_lm = flow_lm
        self.state_structure = state_structure

    def unflatten(self, flat_state):
        from onnx_export.export_utils import unflatten_state

        return unflatten_state(flat_state, self.state_structure)[0]

    @staticmethod
    def increment(model_state, increment):
        def visit(state):
            if "step" in state:
                state["step"] = state["step"] + increment
            if "offset" in state:
                state["offset"] = state["offset"] + increment
            for value in state.values():
                if isinstance(value, dict):
                    visit(value)

        visit(model_state)

    @staticmethod
    def flatten(model_state):
        from onnx_export.export_utils import flatten_state

        return flatten_state(model_state)


class FlowLmPrefillWrapper(StateWrapper):
    def forward(self, text_embeddings, flat_state):
        model_state = self.unflatten(flat_state)
        batch = text_embeddings.shape[0]
        empty_sequence = torch.zeros(
            (batch, 0, self.flow_lm.ldim),
            dtype=text_embeddings.dtype,
            device=text_embeddings.device,
        )
        empty_projected = torch.zeros(
            (batch, 0, self.flow_lm.dim),
            dtype=text_embeddings.dtype,
            device=text_embeddings.device,
        )
        self.flow_lm.backbone(
            empty_projected,
            text_embeddings,
            empty_sequence,
            model_state=model_state,
        )
        self.increment(model_state, text_embeddings.shape[1])
        return tuple(self.flatten(model_state))


class FlowLmDecodeBlockWrapper(StateWrapper):
    def __init__(self, flow_lm, state_structure, frames: int = 4):
        super().__init__(flow_lm, state_structure)
        self.frames = frames

    def forward(self, sequence, random_latents, flat_state):
        model_state = self.unflatten(flat_state)
        latents = []
        eos_logits = []
        current = sequence
        empty_text = torch.zeros(
            (sequence.shape[0], 0, self.flow_lm.dim),
            dtype=sequence.dtype,
            device=sequence.device,
        )
        s = torch.zeros((sequence.shape[0], 1), dtype=sequence.dtype, device=sequence.device)
        t = torch.ones((sequence.shape[0], 1), dtype=sequence.dtype, device=sequence.device)

        for index in range(self.frames):
            projected = self.flow_lm.input_linear(current)
            transformer_out = self.flow_lm.backbone(
                projected,
                empty_text,
                current,
                model_state=model_state,
            )
            conditioning = transformer_out[:, 0].to(torch.float32)
            eos_logits.append(self.flow_lm.out_eos(conditioning))
            noise = random_latents[:, index]
            # Pocket's production path uses one LSD step, where x += flow_dir.
            latent = noise + self.flow_lm.flow_net(conditioning, s, t, noise)
            latents.append(latent.unsqueeze(1))
            current = latent.unsqueeze(1)
            self.increment(model_state, 1)

        return (
            torch.cat(latents, dim=1),
            current,
            torch.cat(eos_logits, dim=1),
            *self.flatten(model_state),
        )


class FlowLmDecodeBlock4Wrapper(FlowLmDecodeBlockWrapper):
    """Compatibility name retained for the certified R2/R3 four-frame graph."""

    def __init__(self, flow_lm, state_structure):
        super().__init__(flow_lm, state_structure, frames=4)


def export(exporter_dir: Path, output_dir: Path, language: str) -> dict[str, object]:
    configure_imports(exporter_dir)
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

    prefill = FlowLmPrefillWrapper(model.flow_lm, structure).eval()
    dummy_text = torch.randn(1, 8, model.flow_lm.dim)
    prefill_path = output_dir / "flow_lm_prefill.onnx"
    torch.onnx.export(
        prefill,
        (dummy_text, flat_state),
        str(prefill_path),
        input_names=["text_embeddings", *state_inputs],
        output_names=state_outputs,
        dynamic_axes={"text_embeddings": {1: "text_len"}},
        opset_version=14,
        dynamo=False,
    )

    decode = FlowLmDecodeBlock4Wrapper(model.flow_lm, structure).eval()
    dummy_sequence = model.flow_lm.bos_emb.detach().reshape(1, 1, model.flow_lm.ldim).to(torch.float32)
    dummy_random = torch.randn(1, 4, model.flow_lm.ldim)
    decode_path = output_dir / "flow_lm_decode_block4.onnx"
    torch.onnx.export(
        decode,
        (dummy_sequence, dummy_random, flat_state),
        str(decode_path),
        input_names=["sequence", "random_latents", *state_inputs],
        output_names=["latents", "next_sequence", "eos_logits", *state_outputs],
        opset_version=14,
        dynamo=False,
    )

    bos_path = output_dir / "flow_lm_bos.npy"
    np.save(bos_path, dummy_sequence.numpy())
    metadata = {
        "language": language,
        "decode_block_frames": 4,
        "state_inputs": state_inputs,
        "state_outputs": state_outputs,
        "files": [prefill_path.name, decode_path.name, bos_path.name],
    }
    (output_dir / "r2_core.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return metadata


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exporter-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--language", default="english_2026-04")
    args = parser.parse_args()
    print(json.dumps(export(args.exporter_dir, args.output_dir, args.language), indent=2))


if __name__ == "__main__":
    main()
