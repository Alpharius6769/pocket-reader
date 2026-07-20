"""Upload and verify the immutable unified Pocket WASM core."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

from b2sdk.v2 import B2Api, SqliteAccountInfo


ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / "pocket-wasm-unified-build/onnx/english_2026-04/flow_lm_unified_block4_int8.onnx"
REMOTE = "onnx/english_2026-04/flow_lm_unified_block4_int8.onnx"
BUCKET = os.environ.get("B2_BUCKET", "pocket-reader-assets")


def digest(path: Path) -> str:
    value = hashlib.sha1()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            value.update(block)
    return value.hexdigest()


def main() -> None:
    if not LOCAL.is_file():
        raise SystemExit(f"Missing unified model: {LOCAL}")
    info = SqliteAccountInfo()
    api = B2Api(info)
    key_id = os.environ.get("B2_APPLICATION_KEY_ID") or os.environ.get("B2_KEY_ID")
    key = os.environ.get("B2_APPLICATION_KEY") or os.environ.get("B2_APP_KEY")
    if key_id and key:
        api.authorize_account("production", key_id, key)
    else:
        info.get_account_auth_token()
    local_sha1 = digest(LOCAL)
    bucket = api.get_bucket_by_name(BUCKET)
    version = bucket.upload_local_file(
        local_file=str(LOCAL),
        file_name=REMOTE,
        content_type="application/octet-stream",
        file_infos={"b2-cache-control": "public, max-age=31536000, immutable"},
    )
    remote_sha1 = str(version.content_sha1 or "").lower()
    if remote_sha1 != local_sha1:
        raise SystemExit(f"B2 SHA1 mismatch: local={local_sha1} remote={remote_sha1}")
    print(f"uploaded b2://{BUCKET}/{REMOTE}")
    print(f"bytes={LOCAL.stat().st_size} sha1={local_sha1}")


if __name__ == "__main__":
    main()
