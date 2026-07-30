#!/usr/bin/env python3
"""List B2 prefixes and copy active ONNX/runtime assets into a dated backup prefix."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

import boto3
from botocore.client import Config

BACKUP_ROOT = "backup/onnx-ort-browser"
ACTIVE_PREFIXES = (
    "onnx/",
    "models/Pocket TTS Onnx/",
    "models/onnx/",
)


def client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["B2_ENDPOINT"],
        aws_access_key_id=os.environ["B2_KEY_ID"],
        aws_secret_access_key=os.environ["B2_APP_KEY"],
        config=Config(signature_version="s3v4"),
    )


def list_prefix(s3, bucket: str, prefix: str, limit: int | None = None):
    token = None
    keys = []
    while True:
        kwargs = {"Bucket": bucket, "Prefix": prefix, "MaxKeys": 1000}
        if token:
            kwargs["ContinuationToken"] = token
        resp = s3.list_objects_v2(**kwargs)
        for obj in resp.get("Contents") or []:
            keys.append(obj)
            if limit and len(keys) >= limit:
                return keys
        if not resp.get("IsTruncated"):
            break
        token = resp.get("NextContinuationToken")
    return keys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--list-only", action="store_true")
    parser.add_argument("--execute-backup", action="store_true")
    parser.add_argument("--stamp", default=datetime.now(timezone.utc).strftime("%Y%m%d"))
    args = parser.parse_args()

    bucket = os.environ["B2_BUCKET"]
    s3 = client()

    summary = {}
    for prefix in ("onnx/", "models/", "voices/", "backup/", "ggml/", "runtime/"):
        objs = list_prefix(s3, bucket, prefix, limit=30)
        total = len(list_prefix(s3, bucket, prefix)) if args.list_only or True else len(objs)
        # recount without limit for accuracy on small-ish prefixes
        all_objs = list_prefix(s3, bucket, prefix)
        summary[prefix] = {
            "count": len(all_objs),
            "bytes": sum(o["Size"] for o in all_objs),
            "sample": [o["Key"] for o in all_objs[:8]],
        }
        print(f"=== {prefix} count={len(all_objs)} bytes={summary[prefix]['bytes']}")
        for key in summary[prefix]["sample"]:
            print(f"  {key}")

    if args.list_only and not args.execute_backup:
        out = os.path.join(os.path.dirname(__file__), f"b2_inventory_{args.stamp}.json")
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(summary, fh, indent=2)
        print("wrote", out)
        return 0

    if not args.execute_backup:
        print("Pass --execute-backup to copy active ONNX assets into backup/.")
        return 0

    dest_root = f"{BACKUP_ROOT}-{args.stamp}"
    copied = []
    skipped = []
    for prefix in ACTIVE_PREFIXES:
        for obj in list_prefix(s3, bucket, prefix):
            src = obj["Key"]
            if src.endswith("/"):
                continue
            dest = f"{dest_root}/{src}"
            # idempotent
            try:
                s3.head_object(Bucket=bucket, Key=dest)
                skipped.append(dest)
                continue
            except Exception:
                pass
            print(f"copy {src} -> {dest} ({obj['Size']})")
            s3.copy_object(
                Bucket=bucket,
                Key=dest,
                CopySource={"Bucket": bucket, "Key": src},
                MetadataDirective="COPY",
            )
            copied.append(dest)

    manifest = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "destRoot": dest_root,
        "copied": len(copied),
        "skippedExisting": len(skipped),
        "note": (
            "Unused/unloaded ONNX+ORT browser instruction set backup. "
            "Restore by copying keys back under onnx/ and models/Pocket TTS Onnx/, "
            "then redeploy the Cloudflare Pages public/ build with the prior "
            "pocket_worker/audio_core ORT path."
        ),
        "restoreHint": {
            "serviceWorker": "pocket-reader-core-v109 era ORT WASM/WebGPU path",
            "runtime": "onnxruntime-web 1.27.0 relaxed-SIMD",
            "models": "english_2026-04-ort-r1 + english_2026-04-webgpu-fp16-r3",
        },
        "files": copied[:50],
    }
    manifest_key = f"{dest_root}/RESTORE_ONNX_BROWSER.md"
    body = (
        "# ONNX browser path backup\n\n"
        f"Created: {manifest['createdAt']}\n\n"
        "This prefix holds a copy of the production browser Pocket TTS ONNX/ORT "
        "assets so Pocket Reader can roll back if a GGML/native experiment fails "
        "in browsers.\n\n"
        "## Restore\n"
        "1. Copy objects from this prefix back to their original keys (strip the "
        f"`{dest_root}/` prefix).\n"
        "2. Redeploy Cloudflare Pages from the last known-good ORT commit "
        "(pocket-reader-core-v109 / pocket-worker-v33 era).\n"
        "3. Keep Cloudflare `/models` and `/onnx` routes unchanged.\n"
    )
    s3.put_object(
        Bucket=bucket,
        Key=manifest_key,
        Body=body.encode("utf-8"),
        ContentType="text/markdown; charset=utf-8",
    )
    s3.put_object(
        Bucket=bucket,
        Key=f"{dest_root}/manifest.json",
        Body=json.dumps(manifest, indent=2).encode("utf-8"),
        ContentType="application/json",
    )
    print(json.dumps({"destRoot": dest_root, "copied": len(copied), "skipped": len(skipped)}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
