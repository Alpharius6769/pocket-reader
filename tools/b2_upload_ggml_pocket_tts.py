#!/usr/bin/env python3
"""Upload local audio.cpp PocketTTS model tree to B2 under ggml/pocket-tts/."""

from __future__ import annotations

import mimetypes
import os
import sys
from pathlib import Path

import boto3
from botocore.client import Config

ROOT = Path(r"C:\Users\Chris\Documents\Web Build Antigravity Branch\vendor\audiocpp-models\pocket-tts")
PREFIX = "ggml/pocket-tts/"


def main() -> int:
    if not ROOT.exists():
        print("missing", ROOT, file=sys.stderr)
        return 1
    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["B2_ENDPOINT"],
        aws_access_key_id=os.environ["B2_KEY_ID"],
        aws_secret_access_key=os.environ["B2_APP_KEY"],
        config=Config(signature_version="s3v4"),
    )
    bucket = os.environ["B2_BUCKET"]
    uploaded = 0
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if ".cache" in path.parts:
            continue
        rel = path.relative_to(ROOT).as_posix()
        key = PREFIX + rel
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        print(f"upload {key} ({path.stat().st_size})")
        s3.upload_file(
            str(path),
            bucket,
            key,
            ExtraArgs={"ContentType": ctype},
        )
        uploaded += 1
    readme = (
        "# GGML PocketTTS (audio.cpp)\n\n"
        "Native safetensors layout for [audio.cpp](https://github.com/0xShug0/audio.cpp) "
        "`pocket_tts` family (issue kyutai-labs/pocket-tts#203).\n\n"
        "These weights are **not** loaded by the Anvil browser ORT worker. "
        "Browser production remains under `onnx/`. "
        "ONNX browser backup: `backup/onnx-ort-browser-20260717/`.\n\n"
        "Local run:\n"
        "```\n"
        "audiocpp_cli --task tts --family pocket_tts --model <this-dir> "
        "--backend cpu|cuda --voice-id alba --text \"Hello\" --out out.wav\n"
        "```\n"
    )
    s3.put_object(
        Bucket=bucket,
        Key=PREFIX + "README.md",
        Body=readme.encode("utf-8"),
        ContentType="text/markdown; charset=utf-8",
    )
    print(f"uploaded={uploaded}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
