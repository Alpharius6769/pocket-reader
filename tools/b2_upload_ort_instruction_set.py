#!/usr/bin/env python3
"""Snapshot current browser ORT instruction-set sources to B2 (unused until restore)."""

from __future__ import annotations

import io
import os
import tarfile
from datetime import datetime, timezone
from pathlib import Path

import boto3
from botocore.client import Config

ENG = Path(r"C:\Users\Chris\Documents\Web Build Antigravity Branch")
FILES = [
    "public/assets/js/pocket_worker.js",
    "public/assets/js/audio_core.js",
    "public/assets/js/buffer_manager.js",
    "public/assets/js/pocket_backend_policy.js",
    "public/assets/js/device_setup.js",
    "public/assets/js/settings_manager.js",
    "public/sw.js",
    "AGENT_HANDOFF_MASTER.md",
]


def main() -> int:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name in FILES:
            path = ENG / name
            if not path.exists():
                print("skip missing", name)
                continue
            tar.add(path, arcname=f"onnx-browser-code/{Path(name).name}")
    payload = buf.getvalue()
    key = f"backup/onnx-ort-browser-{stamp}/instruction-set-ort-browser.tar.gz"
    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["B2_ENDPOINT"],
        aws_access_key_id=os.environ["B2_KEY_ID"],
        aws_secret_access_key=os.environ["B2_APP_KEY"],
        config=Config(signature_version="s3v4"),
    )
    s3.put_object(
        Bucket=os.environ["B2_BUCKET"],
        Key=key,
        Body=payload,
        ContentType="application/gzip",
    )
    print(f"uploaded s3://{os.environ['B2_BUCKET']}/{key} bytes={len(payload)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
