"""Upload the WASM decode-block core to the pocket-reader-assets B2 bucket.

Auth resolution order:
  1. B2_APPLICATION_KEY_ID + B2_APPLICATION_KEY env vars, if both set.
  2. Otherwise the cached SqliteAccountInfo (~/.b2_account_info) written by a
     prior `authorize_account` / `b2 authorize-account`.

Uploads the two artifacts only; verifies each by comparing the local SHA1 to
the SHA1 B2 computed on receipt. Idempotent: re-running re-uploads (B2 keeps
versions; the newest wins at the served path).
"""
import hashlib
import os
import sys
from pathlib import Path

from b2sdk.v2 import B2Api, SqliteAccountInfo

BUCKET = "pocket-reader-assets"
ROOT = Path(__file__).resolve().parents[1]
FILES = [
    (ROOT / "pocket-wasm-block-b2-upload/onnx/english_2026-04/flow_lm_decode_block4_int8.onnx",
     "onnx/english_2026-04/flow_lm_decode_block4_int8.onnx"),
    (ROOT / "pocket-wasm-block-b2-upload/onnx/english_2026-04/flow_lm_bos.npy",
     "onnx/english_2026-04/flow_lm_bos.npy"),
]


def sha1(path: Path) -> str:
    h = hashlib.sha1()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main() -> int:
    for local, _ in FILES:
        if not local.exists():
            print(f"MISSING local file: {local}")
            return 2

    info = SqliteAccountInfo()
    api = B2Api(info)
    key_id = os.environ.get("B2_APPLICATION_KEY_ID")
    key = os.environ.get("B2_APPLICATION_KEY")
    if key_id and key:
        try:
            api.authorize_account("production", key_id, key)
        except TypeError:
            api.authorize_account(application_key_id=key_id, application_key=key, realm="production")
        print("authorized via environment credentials")
    else:
        # Relies on cached SqliteAccountInfo. Raises clearly if absent.
        try:
            _ = api.account_info.get_account_auth_token()
            print("authorized via cached account info")
        except Exception:
            print("No credentials: set B2_APPLICATION_KEY_ID/B2_APPLICATION_KEY "
                  "or run authorize_account first.")
            return 3

    bucket = api.get_bucket_by_name(BUCKET)
    ok = True
    for local, remote in FILES:
        local_sha1 = sha1(local)
        size_mb = local.stat().st_size / 1048576
        print(f"uploading {remote} ({size_mb:.1f} MB, sha1={local_sha1[:12]}...)")
        version = bucket.upload_local_file(
            local_file=str(local),
            file_name=remote,
            content_type="application/octet-stream",
        )
        remote_sha1 = (version.content_sha1 or "").lower()
        match = remote_sha1 == local_sha1
        ok = ok and match
        print(f"  -> uploaded, B2 sha1={remote_sha1[:12]}... "
              f"{'VERIFIED' if match else 'MISMATCH!'}")
    return 0 if ok else 4


if __name__ == "__main__":
    sys.exit(main())
