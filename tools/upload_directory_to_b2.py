"""Upload and SHA1-verify one immutable directory under a B2 prefix."""

from __future__ import annotations

import argparse
import hashlib
import mimetypes
import os
import sys
from pathlib import Path

from b2sdk.v2 import B2Api, SqliteAccountInfo


def sha1(path: Path) -> str:
    digest = hashlib.sha1()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("local_dir", type=Path)
    parser.add_argument("remote_prefix")
    parser.add_argument("--bucket", default="pocket-reader-assets")
    parser.add_argument(
        "--cache-control",
        default="public, max-age=31536000, immutable",
        help="Cache-Control metadata stored with every uploaded file.",
    )
    args = parser.parse_args()
    files = sorted(path for path in args.local_dir.iterdir() if path.is_file())
    if not files:
        print(f"No files found in {args.local_dir}")
        return 2

    api = B2Api(SqliteAccountInfo())
    key_id = os.environ.get("B2_APPLICATION_KEY_ID")
    key = os.environ.get("B2_APPLICATION_KEY")
    if key_id and key:
        api.authorize_account("production", key_id, key)
    else:
        try:
            api.account_info.get_account_auth_token()
        except Exception:
            print("No cached or environment B2 credentials are available.")
            return 3
    bucket = api.get_bucket_by_name(args.bucket)

    verified = True
    prefix = args.remote_prefix.replace("\\", "/").strip("/")
    for local in files:
        remote = f"{prefix}/{local.name}"
        local_sha1 = sha1(local)
        content_type = mimetypes.guess_type(local.name)[0] or "application/octet-stream"
        version = bucket.upload_local_file(
            local_file=str(local), file_name=remote, content_type=content_type,
            file_infos={"b2-cache-control": args.cache_control},
        )
        remote_sha1 = (version.content_sha1 or "").lower()
        if remote_sha1 in ("", "none"):
            remote_sha1 = str((version.file_info or {}).get("large_file_sha1", "")).lower()
        matches = remote_sha1 == local_sha1
        verified = verified and matches
        print(f"{remote} {local.stat().st_size} bytes {'VERIFIED' if matches else 'SHA1_MISMATCH'}")
    return 0 if verified else 4


if __name__ == "__main__":
    sys.exit(main())
