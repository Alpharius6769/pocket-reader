#!/usr/bin/env python3
"""
Maintainer utility: build the identity-anchored Voice-Zero v2 Pocket TTS pack.

Why v2 exists: each v1 {voice}_{emotion}.safetensors was converted from a
*different* reference recording, so switching emotions at runtime swaps the
entire speaker prior — the narrator's timbre (sometimes even perceived gender)
drifts between emotions. v2 rebuilds every emotion state from a composite
reference that opens with a fixed slice of the SAME speaker's neutral clip:

    [anchor: first N sec of neutral] + [short gap] + [emotion clip, capped]

The shared anchor pins speaker identity across all 13 emotion states, while
the emotion clip sits last so its prosody carries into generation. Total
composite duration is capped at ~10.4s — below the longest v1 reference that
is known to fit the runtime flow-LM state manifest.

Normalization matches build_voice_zero_pack.py --normalize-references
(ffmpeg silenceremove + loudnorm I=-23:TP=-3:LRA=11) so v2 keeps v1's loudness
conventions. Output is resampled to 24kHz mono (mimi's native rate).

Not runtime app code. Dependencies: ffmpeg on PATH, plus
  pip install pocket-tts safetensors numpy soundfile torch torchaudio
"""

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except AttributeError:
    pass

SAMPLE_RATE = 24000
EMOTIONS = [
    "neutral", "calm", "happy", "sad", "worried", "surprised", "tired",
    "frustrated", "anger", "excited", "enthused", "shout", "confused",
]
# source directory name -> runtime asset voice id
VOICE_DIR_MAP = {
    "donald_malone": "donald_malone",
    "bill_boerst": "bill_boerst",
    "jason_mayoff": "jason_mayoff",
    "kristin_hughes": "kristin_hughes",
    "jodi_krangle-expressive": "jodi_krangle_expressive",
    "karen_savage": "karen_savage",
}


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--source", required=True, help="source-flac root (per-speaker subdirs).")
    p.add_argument("--output", required=True, help="Output root for the v2 pack.")
    p.add_argument("--anchor-sec", type=float, default=3.2, help="Neutral anchor length.")
    p.add_argument("--gap-sec", type=float, default=0.3, help="Silence between anchor and emotion clip.")
    p.add_argument("--emotion-cap-sec", type=float, default=6.9, help="Max emotion clip length.")
    p.add_argument("--language", default="english")
    p.add_argument("--voices", nargs="*", help="Restrict to these source dir names.")
    p.add_argument("--emotions", nargs="*", help="Restrict to these emotions.")
    p.add_argument("--skip-existing", action="store_true", help="Skip already-built .safetensors.")
    p.add_argument("--stage-only", action="store_true", help="Build anchored WAVs but skip model conversion.")
    return p.parse_args()


def run_ffmpeg(args_list):
    result = subprocess.run(["ffmpeg", "-hide_banner", "-y", *args_list],
                            capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip()[-800:])


def normalize_clip(source: Path, dest: Path):
    """Loudness-normalize to v1's targets and resample to 24kHz mono.

    NOTE: the v1 builder's optional silenceremove chain truncates clips at the
    first *internal* pause (stop_periods=1), destroying most of the reference.
    Silence handling here is edge-only trimming, done in numpy (edge_trim) so
    interior pauses are always preserved.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    run_ffmpeg([
        "-i", str(source),
        "-af", "loudnorm=I=-23:TP=-3:LRA=11",
        "-ar", str(SAMPLE_RATE), "-ac", "1",
        str(dest),
    ])


def edge_trim(x, sample_rate, thresh_db=-45.0, pad_sec=0.05):
    """Trim leading/trailing silence only; interior pauses are untouched."""
    import numpy as np
    thresh = 10.0 ** (thresh_db / 20.0)
    voiced = np.flatnonzero(np.abs(x) > thresh)
    if voiced.size == 0:
        return x
    pad = int(pad_sec * sample_rate)
    start = max(0, int(voiced[0]) - pad)
    end = min(len(x), int(voiced[-1]) + pad)
    return x[start:end]


def median_f0(x, sample_rate, fmin=60.0, fmax=400.0):
    """Median F0 over voiced frames via normalized autocorrelation.

    Mirrors the runtime guard in audio_core.js (_estimateMedianPitchHz) so
    offline anchor selection and in-browser pitch checks agree.
    """
    import numpy as np
    win = int(sample_rate * 0.03)
    hop = int(sample_rate * 0.06)
    min_lag = int(sample_rate / fmax)
    max_lag = int(sample_rate / fmin)
    pitches = []
    for start in range(0, len(x) - win - max_lag, hop):
        frame = x[start:start + win]
        energy = float(np.dot(frame, frame))
        if np.sqrt(energy / win) < 0.01:
            continue
        best_corr, best_lag = 0.0, 0
        for lag in range(min_lag, max_lag + 1):
            shifted = x[start + lag:start + lag + win]
            e2 = float(np.dot(shifted, shifted))
            norm = np.sqrt(energy * e2) or 1.0
            score = float(np.dot(frame, shifted)) / norm
            if score > best_corr:
                best_corr, best_lag = score, lag
        if best_corr > 0.5 and best_lag:
            pitches.append(sample_rate / best_lag)
    if len(pitches) < 5:
        return None, 0
    return float(np.median(pitches)), len(pitches)


def pick_anchor_window(neutral, sample_rate, anchor_sec, target_f0):
    """Choose the anchor slice of the neutral clip whose median F0 best matches
    the emotion clip. Pitch-mismatched anchors make the composite reference
    demonstrate a mid-stream tone change, which the model then reproduces as
    random pitch blips during narration. Same recording either way, so speaker
    identity is unaffected — only tonal continuity improves."""
    import numpy as np
    win = int(anchor_sec * sample_rate)
    step = int(0.25 * sample_rate)
    best = (None, 0.0, None)  # (offset, delta_penalty, f0)
    fallback = neutral[:win]
    if target_f0 is None:
        return fallback, 0.0, None
    for off in range(0, max(1, len(neutral) - win), step):
        seg = neutral[off:off + win]
        f0, voiced = median_f0(seg, sample_rate)
        if f0 is None or voiced < 8:
            continue
        penalty = abs(np.log2(f0 / target_f0))  # octaves off target
        if best[0] is None or penalty < best[1]:
            best = (off, penalty, f0)
    if best[0] is None:
        return fallback, None, None
    return neutral[best[0]:best[0] + win], best[0] / sample_rate, best[2]


def build_anchored_wav(neutral_wav: Path, emotion_wav: Path, dest: Path,
                       anchor_sec: float, gap_sec: float, cap_sec: float):
    """Concatenate [pitch-matched neutral anchor][gap][emotion clip]."""
    import numpy as np
    import soundfile as sf

    neutral, sr_a = sf.read(neutral_wav, dtype="float32")
    emotion, sr_e = sf.read(emotion_wav, dtype="float32")
    assert sr_a == SAMPLE_RATE and sr_e == SAMPLE_RATE, "staging must be 24kHz"

    neutral = edge_trim(neutral, SAMPLE_RATE)
    emotion = edge_trim(emotion, SAMPLE_RATE)[: int(cap_sec * SAMPLE_RATE)]

    emotion_f0, _voiced = median_f0(emotion, SAMPLE_RATE)
    anchor, anchor_offset, anchor_f0 = pick_anchor_window(
        neutral, SAMPLE_RATE, anchor_sec, emotion_f0)
    anchor = np.copy(anchor)

    fade = int(0.010 * SAMPLE_RATE)  # 10ms edge fades prevent join clicks
    if len(anchor) > fade:
        anchor[-fade:] *= np.linspace(1.0, 0.0, fade, dtype="float32")
    if len(emotion) > fade:
        emotion[:fade] *= np.linspace(0.0, 1.0, fade, dtype="float32")

    gap = np.zeros(int(gap_sec * SAMPLE_RATE), dtype="float32")
    composite = np.concatenate([anchor, gap, emotion])
    dest.parent.mkdir(parents=True, exist_ok=True)
    sf.write(dest, composite, SAMPLE_RATE)

    delta_semitones = None
    if emotion_f0 and anchor_f0:
        delta_semitones = round(abs(12.0 * np.log2(anchor_f0 / emotion_f0)), 2)
    return {
        "compositeSec": len(composite) / SAMPLE_RATE,
        "anchorOffsetSec": round(anchor_offset, 2) if anchor_offset is not None else None,
        "anchorF0": round(anchor_f0, 1) if anchor_f0 else None,
        "emotionF0": round(emotion_f0, 1) if emotion_f0 else None,
        "anchorDeltaSemitones": delta_semitones,
    }


def main() -> int:
    args = parse_args()
    source_root = Path(args.source)
    output_root = Path(args.output)
    staging_norm = output_root / "staging" / "normalized"
    staging_anchored = output_root / "staging" / "anchored"
    pack_dir = output_root / "pack"
    pack_dir.mkdir(parents=True, exist_ok=True)

    voice_dirs = args.voices or list(VOICE_DIR_MAP.keys())
    emotions = args.emotions or EMOTIONS
    report = {"id": "voice-zero-emotional-v2-anchored", "sampleRate": SAMPLE_RATE,
              "anchorSec": args.anchor_sec, "gapSec": args.gap_sec,
              "emotionCapSec": args.emotion_cap_sec, "items": []}

    model = None
    export_fn = None
    if not args.stage_only:
        print("Loading Pocket TTS model (cached weights)...")
        from pocket_tts import TTSModel, export_model_state
        model = TTSModel.load_model(language=args.language)
        export_fn = export_model_state

    for vdir in voice_dirs:
        asset_voice = VOICE_DIR_MAP[vdir]
        src_dir = source_root / vdir
        if not src_dir.is_dir():
            print(f"!! missing source dir: {src_dir}")
            continue

        # Stage 1: normalize every needed clip (neutral always required).
        needed = sorted(set(emotions) | {"neutral"})
        for emo in needed:
            src = src_dir / f"{emo}.flac"
            dst = staging_norm / vdir / f"{emo}.wav"
            if not dst.exists():
                if not src.exists():
                    print(f"!! missing {src}")
                    continue
                normalize_clip(src, dst)

        neutral_wav = staging_norm / vdir / "neutral.wav"
        if not neutral_wav.exists():
            print(f"!! no neutral reference for {vdir}; skipping speaker")
            continue

        # Stage 2 + 3: anchored composite -> conditioning state.
        for emo in emotions:
            norm_wav = staging_norm / vdir / f"{emo}.wav"
            if not norm_wav.exists():
                continue
            dest_st = pack_dir / f"{asset_voice}_{emo}.safetensors"
            if args.skip_existing and dest_st.exists():
                print(f"skip existing {dest_st.name}")
                continue

            anchored = staging_anchored / vdir / f"{emo}.wav"
            if emo == "neutral":
                # Neutral IS the identity anchor: full normalized clip, edge-trimmed.
                import numpy as np
                import soundfile as sf
                x, _sr = sf.read(neutral_wav, dtype="float32")
                x = edge_trim(x, SAMPLE_RATE)
                anchored.parent.mkdir(parents=True, exist_ok=True)
                sf.write(anchored, x, SAMPLE_RATE)
                duration = len(x) / SAMPLE_RATE
                ref_wav = anchored
            else:
                meta = build_anchored_wav(neutral_wav, norm_wav, anchored,
                                          args.anchor_sec, args.gap_sec,
                                          args.emotion_cap_sec)
                duration = meta["compositeSec"]
                ref_wav = anchored

            item = {"voice": asset_voice, "emotion": emo,
                    "reference": str(ref_wav), "compositeSec": duration}
            if emo != "neutral":
                item.update({k: v for k, v in meta.items() if k != "compositeSec"})
            if not args.stage_only:
                t0 = time.time()
                state = model.get_state_for_audio_prompt(str(ref_wav))
                export_fn(state, dest_st)
                item.update({"safetensors": str(dest_st),
                             "bytes": dest_st.stat().st_size,
                             "convertSec": round(time.time() - t0, 2)})
                print(f"built {dest_st.name}  ({item['bytes']/1e6:.2f} MB, {item['convertSec']}s)")
            else:
                print(f"staged {ref_wav}")
            report["items"].append(item)

    report_path = output_root / "voice-zero-emotional-v2.report.json"
    report_path.write_text(json.dumps(report, indent=2))
    print(f"\nReport: {report_path}")
    print(f"Items: {len(report['items'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
