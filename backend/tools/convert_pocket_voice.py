#!/usr/bin/env python3
"""
Maintainer utility: convert voice samples for Pocket TTS.

This is not runtime app code. It converts local .flac/.wav/.mp3/.ogg voice
samples into browser-compatible .safetensors conditioning files.

Optional dependencies:
  pip install pocket-tts safetensors numpy soundfile torch torchaudio
"""

import argparse
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except AttributeError:
    pass


def parse_args():
    parser = argparse.ArgumentParser(
        description="Convert audio samples to Pocket TTS .safetensors conditioning files.",
        formatter_class=argparse.RawTextHelpFormatter,
    )
    parser.add_argument("-i", "--input", required=True, help="Single audio file or directory.")
    parser.add_argument("-o", "--output", default=".", help="Output directory.")
    parser.add_argument("--language", default="english", help="Pocket TTS language model.")
    parser.add_argument(
        "--no-neutral-suffix",
        action="store_true",
        help="Save as name.safetensors instead of name_neutral.safetensors.",
    )
    return parser.parse_args()


def convert_single_file(model, export_fn, file_path: Path, output_dir: Path, add_neutral_suffix: bool):
    filename = file_path.stem.lower()
    voice_zero_mappings = {
        "donald_malone": "donald_malone",
        "bill_boerst": "bill_boerst",
        "jason_mayoff": "jason_mayoff",
        "kristin_hughes": "kristin_hughes",
        "jodi_krangle-expressive": "jodi_krangle_expressive",
        "jodi_krangle_expressive": "jodi_krangle_expressive",
        "karen_savage": "karen_savage",
    }

    clean_name = voice_zero_mappings.get(filename, filename)
    target_name = f"{clean_name}{'_neutral' if add_neutral_suffix and not clean_name.endswith('_neutral') else ''}.safetensors"
    dest_path = output_dir / target_name

    print(f"Processing: {file_path.name}")
    print(f"   Clean name: {clean_name}")
    print(f"   Target path: {dest_path}")

    start_time = time.time()
    try:
        voice_state = model.get_state_for_audio_prompt(str(file_path))
        export_fn(voice_state, dest_path)
        elapsed = time.time() - start_time
        print(f"Successful. Created {target_name} in {elapsed:.2f}s\n")
        return True
    except Exception as exc:
        print(f"Failed to convert {file_path.name}: {exc}\n")
        return False


def main():
    args = parse_args()
    print("=" * 60)
    print("Pocket TTS Voice Precompiler (.flac/.wav/.mp3/.ogg -> .safetensors)")
    print("=" * 60)

    print("Loading PyTorch and Pocket TTS modules...")
    try:
        from pocket_tts import TTSModel, export_model_state
    except ImportError:
        print("Error: 'pocket-tts' or 'safetensors' is not installed.")
        print("Run: pip install pocket-tts safetensors numpy soundfile torch torchaudio")
        sys.exit(1)

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Error: input path '{args.input}' does not exist.")
        sys.exit(1)

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Initializing neural engine with '{args.language}' model...")
    try:
        model = TTSModel.load_model(language=args.language)
    except Exception as exc:
        print(f"Failed to load neural model: {exc}")
        sys.exit(1)

    audio_files = []
    if input_path.is_file():
        if input_path.suffix.lower() in [".flac", ".wav", ".mp3", ".ogg"]:
            audio_files.append(input_path)
        else:
            print(f"Error: '{input_path.name}' is not a supported audio format.")
            sys.exit(1)
    else:
        for ext in ["*.flac", "*.wav", "*.mp3", "*.ogg"]:
            audio_files.extend(input_path.glob(ext))
            audio_files.extend(input_path.glob(ext.upper()))
        # Windows glob is case-insensitive, so "*.wav" and "*.WAV" each match
        # the same files. Deduping keeps a directory convert from running twice.
        seen = set()
        unique = []
        for file_path in audio_files:
            key = str(file_path.resolve()).lower()
            if key in seen:
                continue
            seen.add(key)
            unique.append(file_path)
        audio_files = unique

    if not audio_files:
        print(f"No compatible audio files found in '{input_path}'.")
        sys.exit(0)

    print(f"Found {len(audio_files)} audio file(s) for conversion.")
    print("-" * 60)

    success_count = 0
    add_neutral = not args.no_neutral_suffix
    for file_path in audio_files:
        if convert_single_file(model, export_model_state, file_path, output_dir, add_neutral):
            success_count += 1

    print("=" * 60)
    print("Completed conversion task.")
    print(f"   Total processed: {len(audio_files)}")
    print(f"   Successfully converted: {success_count}")
    print(f"   Failed: {len(audio_files) - success_count}")
    print(f"Output directory: {output_dir.resolve()}")
    print("=" * 60)


if __name__ == "__main__":
    main()
