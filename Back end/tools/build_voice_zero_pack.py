#!/usr/bin/env python3
"""
Build and audit the Pocket Reader Voice-Zero emotional voice pack.

Default mode downloads the selected Voice-Zero emotion references to a temp
folder, audits their basic audio health with ffprobe/ffmpeg, and prints a JSON
report. Pass --download-only to keep source .flac files, or --convert to write
Pocket TTS .safetensors files ready for the B2/Cloudflare voice asset path.

Optional conversion dependencies:
  pip install pocket-tts safetensors numpy soundfile torch torchaudio

System dependency for audit mode:
  ffprobe and ffmpeg on PATH
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from dataclasses import dataclass, asdict
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except AttributeError:
    pass


VOICE_ZERO_RAW_BASE = "https://raw.githubusercontent.com/OwenTyme/voice-zero/main/voices-emotion"
VOICE_ZERO_REPO = "https://github.com/OwenTyme/voice-zero"

PRIMARY_EMOTIONS = ["neutral", "calm", "happy", "sad", "worried", "surprised", "tired", "frustrated"]
GATED_EMOTIONS = ["anger", "excited", "enthused", "shout"]
EXTRA_EMOTIONS = ["confused"]
ALL_EMOTIONS = PRIMARY_EMOTIONS + GATED_EMOTIONS + EXTRA_EMOTIONS


@dataclass(frozen=True)
class VoiceSpec:
    id: str
    display_name: str
    gender: str
    accent: str
    source_folder: str
    recommended: bool
    recommended_use: str
    source_url: str
    origin_url: str
    license: str = "CC0 via Voice-Zero unless otherwise noted by Voice-Zero"


VOICE_SPECS = [
    VoiceSpec(
        id="donald_malone",
        display_name="Donald Malone",
        gender="male",
        accent="American, Midwestern",
        source_folder="donald_malone",
        recommended=True,
        recommended_use="Default male narrator; calm long-form narration and broad emotional coverage.",
        source_url=f"{VOICE_ZERO_REPO}/tree/main/voices-emotion/donald_malone",
        origin_url="https://librivox.org/short-poetry-collection-204-by-various/",
    ),
    VoiceSpec(
        id="bill_boerst",
        display_name="Bill Boerst",
        gender="male",
        accent="American",
        source_folder="bill_boerst",
        recommended=True,
        recommended_use="Warm alternate male voice for narration and dialogue-heavy stories.",
        source_url=f"{VOICE_ZERO_REPO}/tree/main/voices-emotion/bill_boerst",
        origin_url="https://librivox.org/",
    ),
    VoiceSpec(
        id="jason_mayoff",
        display_name="Jason Mayoff",
        gender="male",
        accent="American",
        source_folder="jason_mayoff",
        recommended=False,
        recommended_use="Clear, serious male voice for tense scenes and grounded narration.",
        source_url=f"{VOICE_ZERO_REPO}/tree/main/voices-emotion/jason_mayoff",
        origin_url="https://librivox.org/",
    ),
    VoiceSpec(
        id="kristin_hughes",
        display_name="Kristin Hughes",
        gender="female",
        accent="American, Iowa",
        source_folder="kristin_hughes",
        recommended=True,
        recommended_use="Default female narrator; clean long-form tone and stable emotion references.",
        source_url=f"{VOICE_ZERO_REPO}/tree/main/voices-emotion/kristin_hughes",
        origin_url="https://librivox.org/",
    ),
    VoiceSpec(
        id="jodi_krangle_expressive",
        display_name="Jodi Krangle Expressive",
        gender="female",
        accent="American",
        source_folder="jodi_krangle-expressive",
        recommended=True,
        recommended_use="Expressive female voice for dialogue, companion lines, and emotional passages.",
        source_url=f"{VOICE_ZERO_REPO}/tree/main/voices-emotion/jodi_krangle-expressive",
        origin_url="https://librivox.org/short-science-fiction-collection-vol-002/",
    ),
    VoiceSpec(
        id="karen_savage",
        display_name="Karen Savage",
        gender="female",
        accent="American",
        source_folder="karen_savage",
        recommended=False,
        recommended_use="Polished female narrator for steady audiobook-style delivery.",
        source_url=f"{VOICE_ZERO_REPO}/tree/main/voices-emotion/karen_savage",
        origin_url="https://librivox.org/",
    ),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Audit, download, and optionally convert the selected Voice-Zero Pocket voice pack.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--audit-only", action="store_true", help="Download to temp storage, audit, and exit.")
    parser.add_argument("--download-only", action="store_true", help="Download source .flac files and exit.")
    parser.add_argument("--convert", action="store_true", help="Convert downloaded .flac files to Pocket .safetensors.")
    parser.add_argument("--source-output", default="", help="Directory for source .flac files. Required to keep downloads.")
    parser.add_argument("--output", default="voice-zero-pocket-pack", help="Directory for converted .safetensors and manifest.")
    parser.add_argument("--language", default="english", help="Pocket TTS language model for conversion.")
    parser.add_argument("--emotions", nargs="+", choices=ALL_EMOTIONS, default=ALL_EMOTIONS, help="Emotion files to process.")
    parser.add_argument("--timeout", type=int, default=60, help="Download timeout in seconds per file.")
    parser.add_argument("--normalize-references", action="store_true", help="Trim silence and loudness-normalize source FLACs before audit/conversion.")
    return parser.parse_args()


def run_command(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, text=True, capture_output=True, check=False)


def ensure_tool(name: str) -> None:
    if shutil.which(name):
        return
    raise SystemExit(f"Required tool not found on PATH: {name}")


def download_file(url: str, dest: Path, timeout: int) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        return
    req = urllib.request.Request(url, headers={"User-Agent": "PocketReaderVoicePackBuilder/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        if getattr(response, "status", 200) >= 400:
            raise RuntimeError(f"HTTP {response.status} while downloading {url}")
        dest.write_bytes(response.read())


def source_path(root: Path, voice: VoiceSpec, emotion: str) -> Path:
    return root / voice.source_folder / f"{emotion}.flac"


def source_url(voice: VoiceSpec, emotion: str) -> str:
    return f"{VOICE_ZERO_RAW_BASE}/{voice.source_folder}/{emotion}.flac"


def parse_volume(stderr: str) -> tuple[float | None, float | None]:
    mean_match = re.search(r"mean_volume:\s*([-0-9.]+)\s*dB", stderr)
    max_match = re.search(r"max_volume:\s*([-0-9.]+)\s*dB", stderr)
    mean = float(mean_match.group(1)) if mean_match else None
    max_vol = float(max_match.group(1)) if max_match else None
    return mean, max_vol


def audit_file(path: Path) -> dict:
    ffprobe = run_command([
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        str(path),
    ])
    if ffprobe.returncode != 0:
        return {"path": str(path), "ok": False, "reason": ffprobe.stderr.strip() or "ffprobe failed"}

    duration = None
    try:
        duration = float(json.loads(ffprobe.stdout)["format"]["duration"])
    except (KeyError, ValueError, json.JSONDecodeError):
        pass

    ffmpeg = run_command([
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-i",
        str(path),
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
    ])
    mean_volume, max_volume = parse_volume(ffmpeg.stderr)

    warnings = []
    score = 100.0
    if duration is None:
        warnings.append("missing duration")
        score -= 25
    elif duration < 5:
        warnings.append("very short reference")
        score -= 20
    elif duration < 7:
        warnings.append("short reference")
        score -= 8
    elif duration > 14:
        warnings.append("long reference")
        score -= 5

    if max_volume is not None:
        if max_volume >= -0.5:
            warnings.append("possible clipping")
            score -= 25
        elif max_volume < -12:
            warnings.append("quiet peak")
            score -= 8
        elif max_volume < -9:
            warnings.append("slightly quiet peak")
            score -= 4

    if mean_volume is not None and mean_volume < -32:
        warnings.append("low average loudness")
        score -= 8

    return {
        "path": str(path),
        "ok": score >= 80,
        "duration_sec": round(duration, 3) if duration is not None else None,
        "mean_volume_db": mean_volume,
        "max_volume_db": max_volume,
        "score": max(0, round(score, 1)),
        "warnings": warnings,
    }


def normalize_reference(source: Path, dest: Path) -> dict:
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-y",
        "-i",
        str(source),
        "-af",
        "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05:"
        "stop_periods=1:stop_threshold=-45dB:stop_silence=0.15,"
        "loudnorm=I=-23:TP=-3:LRA=11",
        str(dest),
    ]
    started = time.time()
    result = run_command(cmd)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"ffmpeg normalization failed for {source}")
    return {
        "source": str(source),
        "path": str(dest),
        "elapsed_sec": round(time.time() - started, 2),
        "bytes": dest.stat().st_size,
    }


def convert_file(model, export_fn, source: Path, dest: Path) -> dict:
    dest.parent.mkdir(parents=True, exist_ok=True)
    started = time.time()
    voice_state = model.get_state_for_audio_prompt(str(source))
    export_fn(voice_state, dest)
    return {"path": str(dest), "elapsed_sec": round(time.time() - started, 2), "bytes": dest.stat().st_size}


def build_runtime_manifest(emotions: list[str]) -> dict:
    return {
        "id": "voice-zero-emotional-v1",
        "title": "Voice-Zero Emotional Pack",
        "sourceRepository": VOICE_ZERO_REPO,
        "license": "CC0 unless otherwise noted by Voice-Zero",
        "defaultVoice": "donald_malone",
        "defaultEmotion": "neutral",
        "primaryEmotions": PRIMARY_EMOTIONS,
        "gatedEmotions": GATED_EMOTIONS,
        "extraEmotions": EXTRA_EMOTIONS,
        "voices": [
            {
                **asdict(voice),
                "availableEmotions": emotions,
                "assetIds": [f"{voice.id}_{emotion}" for emotion in emotions],
                "fallbackEmotions": {
                    "calm": "neutral",
                    "happy": "calm",
                    "sad": "calm",
                    "worried": "calm",
                    "surprised": "happy",
                    "tired": "calm",
                    "frustrated": "worried",
                    "confused": "worried",
                    "anger": "frustrated",
                    "excited": "happy",
                    "enthused": "happy",
                    "shout": "surprised",
                },
            }
            for voice in VOICE_SPECS
        ],
    }


def main() -> int:
    args = parse_args()
    if not args.audit_only and not args.download_only and not args.convert:
        args.audit_only = True

    ensure_tool("ffprobe")
    ensure_tool("ffmpeg")

    if args.source_output:
        source_root = Path(args.source_output)
        temp_ctx = None
    elif args.download_only or args.convert:
        source_root = Path(args.output) / "source-flac"
        temp_ctx = None
    else:
        temp_ctx = tempfile.TemporaryDirectory(prefix="voice-zero-pack-")
        source_root = Path(temp_ctx.name)

    output_root = Path(args.output)
    normalized_root = output_root / "normalized-source-flac" if args.normalize_references else None
    working_root = normalized_root or source_root
    report = {
        "pack": "voice-zero-emotional-v1",
        "sourceRepository": VOICE_ZERO_REPO,
        "processedEmotions": args.emotions,
        "normalizedReferences": bool(args.normalize_references),
        "voices": [],
        "normalized": [],
        "converted": [],
    }

    try:
        for voice in VOICE_SPECS:
            voice_report = {"voice": asdict(voice), "assets": {}}
            for emotion in args.emotions:
                src = source_path(source_root, voice, emotion)
                download_file(source_url(voice, emotion), src, args.timeout)
                audit_src = src
                if args.normalize_references and normalized_root is not None:
                    norm = source_path(normalized_root, voice, emotion)
                    report["normalized"].append(normalize_reference(src, norm))
                    audit_src = norm
                voice_report["assets"][emotion] = audit_file(audit_src)
                if args.normalize_references and not voice_report["assets"][emotion].get("ok"):
                    raise RuntimeError(f"Normalized reference failed audit: {audit_src}")
            report["voices"].append(voice_report)

        if args.download_only or args.convert:
            output_root.mkdir(parents=True, exist_ok=True)
            manifest_path = output_root / "voice-zero-emotional-v1.manifest.json"
            manifest_path.write_text(json.dumps(build_runtime_manifest(args.emotions), indent=2), encoding="utf-8")
            report["runtimeManifest"] = str(manifest_path)

        if args.convert:
            try:
                from pocket_tts import TTSModel, export_model_state
            except ImportError as exc:
                raise SystemExit(
                    "Conversion requires pocket-tts and its optional dependencies. "
                    "Install: pip install pocket-tts safetensors numpy soundfile torch torchaudio"
                ) from exc

            model = TTSModel.load_model(language=args.language)
            for voice in VOICE_SPECS:
                for emotion in args.emotions:
                    src = source_path(working_root, voice, emotion)
                    dest = output_root / f"{voice.id}_{emotion}.safetensors"
                    report["converted"].append(convert_file(model, export_model_state, src, dest))

        if args.download_only or args.convert:
            report_path = output_root / "voice-zero-audit-report.json"
            report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
            report["auditReport"] = str(report_path)

        print(json.dumps(report, indent=2))
        return 0
    finally:
        if temp_ctx is not None:
            temp_ctx.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
