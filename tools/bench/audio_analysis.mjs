// Objective per-paragraph audio features for tools/longform_bench.mjs.
//
// Pure Node, no dependencies, no models. Everything here is a measurement a
// human can sanity-check by ear against the WAV it came from; none of it is a
// quality score. The drift metrics use FIXED units (documented on
// DRIFT_UNITS) rather than scaling by the run's own variance, so a baseline run
// and an after-the-rebuild run are on the same axis.

export const FRAME_RATE_HZ = 12.5; // Pocket emits one latent frame per 80 ms.

export function readWav(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const tag = (offset) => String.fromCharCode(...buffer.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let offset = 12;
  let sampleRate = 24000;
  let bits = 16;
  let channels = 1;
  while (offset + 8 <= buffer.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error(`unsupported bit depth ${bits}`);
      const frames = Math.floor(size / 2 / channels);
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i += 1) samples[i] = view.getInt16(offset + 8 + i * 2 * channels, true) / 32768;
      return { sampleRate, samples };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  return quantile(finite, 0.5);
}

const FFT_SIZE = 1024;
const HOP = 480; // 20 ms at 24 kHz
const MEL_BANDS = 26;
const MFCC_COUNT = 12; // c1..c12; c0 (loudness) is excluded from timbre

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

function melFilterbank(sampleRate) {
  const toMel = (hz) => 2595 * Math.log10(1 + hz / 700);
  const toHz = (mel) => 700 * (10 ** (mel / 2595) - 1);
  const lo = toMel(80);
  const hi = toMel(Math.min(7600, sampleRate / 2 - 1));
  const points = Array.from({ length: MEL_BANDS + 2 }, (_, i) => toHz(lo + ((hi - lo) * i) / (MEL_BANDS + 1)));
  const bins = points.map((hz) => Math.floor(((FFT_SIZE + 1) * hz) / sampleRate));
  return Array.from({ length: MEL_BANDS }, (_, m) => {
    const weights = new Float32Array(FFT_SIZE / 2 + 1);
    for (let k = bins[m]; k < bins[m + 1]; k += 1) weights[k] = (k - bins[m]) / Math.max(1, bins[m + 1] - bins[m]);
    for (let k = bins[m + 1]; k < bins[m + 2]; k += 1) weights[k] = (bins[m + 2] - k) / Math.max(1, bins[m + 2] - bins[m + 1]);
    return weights;
  });
}

// Decimate to 8 kHz with a windowed-sinc low-pass, for YIN.
function decimateTo8k(samples, sampleRate) {
  const factor = Math.max(1, Math.round(sampleRate / 8000));
  if (factor === 1) return { data: samples, rate: sampleRate };
  const taps = 63;
  const cutoff = 3600 / sampleRate;
  const kernel = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i += 1) {
    const x = i - (taps - 1) / 2;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    kernel[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)));
    sum += kernel[i];
  }
  for (let i = 0; i < taps; i += 1) kernel[i] /= sum;
  const out = new Float32Array(Math.floor(samples.length / factor));
  for (let o = 0; o < out.length; o += 1) {
    const center = o * factor;
    let acc = 0;
    for (let k = 0; k < taps; k += 1) {
      const idx = center + k - (taps - 1) / 2;
      if (idx >= 0 && idx < samples.length) acc += samples[idx] * kernel[k];
    }
    out[o] = acc;
  }
  return { data: out, rate: sampleRate / factor };
}

// YIN (de Cheveigné & Kawahara 2002), 40 ms window, 20 ms hop, 60-500 Hz.
function yinPitchTrack(samples, sampleRate) {
  const { data, rate } = decimateTo8k(samples, sampleRate);
  const window = Math.round(rate * 0.04);
  const hop = Math.round(rate * 0.02);
  const tauMin = Math.floor(rate / 500);
  const tauMax = Math.ceil(rate / 60);
  const diff = new Float64Array(tauMax + 1);
  const track = [];
  for (let start = 0; start + window + tauMax < data.length; start += hop) {
    let energy = 0;
    for (let j = 0; j < window; j += 1) energy += data[start + j] * data[start + j];
    diff[0] = 0;
    for (let tau = 1; tau <= tauMax; tau += 1) {
      let acc = 0;
      for (let j = 0; j < window; j += 1) {
        const d = data[start + j] - data[start + j + tau];
        acc += d * d;
      }
      diff[tau] = acc;
    }
    let running = 0;
    let bestTau = -1;
    let bestValue = 1;
    const cmnd = new Float64Array(tauMax + 1);
    cmnd[0] = 1;
    for (let tau = 1; tau <= tauMax; tau += 1) {
      running += diff[tau];
      cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1;
    }
    for (let tau = tauMin; tau <= tauMax; tau += 1) {
      if (cmnd[tau] < 0.12) {
        while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau += 1;
        bestTau = tau;
        bestValue = cmnd[tau];
        break;
      }
    }
    if (bestTau < 0) {
      for (let tau = tauMin; tau <= tauMax; tau += 1) {
        if (cmnd[tau] < bestValue) { bestValue = cmnd[tau]; bestTau = tau; }
      }
    }
    let f0 = null;
    if (bestTau > 0 && bestValue < 0.25 && energy / window > 1e-6) {
      const a = cmnd[bestTau - 1] ?? cmnd[bestTau];
      const b = cmnd[bestTau];
      const c = cmnd[bestTau + 1] ?? cmnd[bestTau];
      const denom = a - 2 * b + c;
      const shift = denom !== 0 ? 0.5 * (a - c) / denom : 0;
      f0 = rate / (bestTau + Math.max(-1, Math.min(1, shift)));
    }
    track.push({ timeSec: (start + window / 2) / rate, f0 });
  }
  return track;
}

export function analyzeSamples(samples, sampleRate, { words = 0 } = {}) {
  const durationSec = samples.length / sampleRate;
  const win = hann(FFT_SIZE);
  const mel = melFilterbank(sampleRate);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const binHz = sampleRate / FFT_SIZE;
  const loBin = Math.ceil(100 / binHz);
  const hiBin = Math.min(FFT_SIZE / 2, Math.floor(8000 / binHz));
  const frames = [];
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped += 1;
  }
  for (let start = 0; start + FFT_SIZE <= samples.length; start += HOP) {
    let power = 0;
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const s = samples[start + i];
      power += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    power /= FFT_SIZE;
    fftInPlace(re, im);
    let num = 0;
    let den = 0;
    let logSum = 0;
    let linSum = 0;
    const spectrum = new Float64Array(FFT_SIZE / 2 + 1);
    for (let k = 0; k <= FFT_SIZE / 2; k += 1) spectrum[k] = re[k] * re[k] + im[k] * im[k];
    for (let k = loBin; k <= hiBin; k += 1) {
      const p = spectrum[k];
      num += p * k * binHz;
      den += p;
      logSum += Math.log(p + 1e-12);
      linSum += p;
    }
    const bandCount = hiBin - loBin + 1;
    const flatness = linSum > 0 ? Math.exp(logSum / bandCount) / (linSum / bandCount) : 1;
    const melEnergies = mel.map((weights) => {
      let e = 0;
      for (let k = 0; k < weights.length; k += 1) if (weights[k]) e += weights[k] * spectrum[k];
      return Math.log(e + 1e-10);
    });
    const mfcc = [];
    for (let c = 1; c <= MFCC_COUNT; c += 1) {
      let acc = 0;
      for (let m = 0; m < MEL_BANDS; m += 1) acc += melEnergies[m] * Math.cos((Math.PI * c * (m + 0.5)) / MEL_BANDS);
      mfcc.push(acc * Math.sqrt(2 / MEL_BANDS));
    }
    frames.push({
      timeSec: (start + FFT_SIZE / 2) / sampleRate,
      rmsDb: 10 * Math.log10(power + 1e-12),
      centroidHz: den > 0 ? num / den : 0,
      flatness,
      mfcc,
    });
  }

  // Activity: within 30 dB of the loud end of this clip, and above -55 dBFS.
  const sortedDb = frames.map((f) => f.rmsDb).sort((a, b) => a - b);
  const loud = quantile(sortedDb, 0.95) ?? -100;
  const threshold = Math.max(-55, loud - 30);
  for (const frame of frames) frame.active = frame.rmsDb > threshold;
  const active = frames.filter((f) => f.active);
  const hopSec = HOP / sampleRate;
  const activeSec = active.length * hopSec;
  const firstActive = frames.findIndex((f) => f.active);
  let lastActive = -1;
  for (let i = frames.length - 1; i >= 0; i -= 1) if (frames[i].active) { lastActive = i; break; }
  const leadingSilenceSec = firstActive < 0 ? durationSec : frames[firstActive].timeSec;
  const trailingSilenceSec = lastActive < 0 ? durationSec : Math.max(0, durationSec - frames[lastActive].timeSec);
  // Longest run of inactive frames strictly inside the speech span: a
  // mid-paragraph dropout, or an over-long chunk gap.
  let maxInternalSilenceSec = 0;
  let run = 0;
  for (let i = Math.max(0, firstActive); i <= lastActive; i += 1) {
    if (frames[i].active) {
      maxInternalSilenceSec = Math.max(maxInternalSilenceSec, run * hopSec);
      run = 0;
    } else run += 1;
  }

  const meanPower = active.length
    ? active.reduce((sum, f) => sum + 10 ** (f.rmsDb / 10), 0) / active.length
    : 0;
  const pitch = yinPitchTrack(samples, sampleRate);
  // Only keep pitch where the 20 ms analysis frame was active.
  const activeAt = (t) => {
    const idx = Math.round((t * sampleRate - FFT_SIZE / 2) / HOP);
    return frames[Math.max(0, Math.min(frames.length - 1, idx))]?.active === true;
  };
  const f0s = pitch.filter((p) => p.f0 != null && activeAt(p.timeSec)).map((p) => p.f0).sort((a, b) => a - b);
  const pitchFramesActive = pitch.filter((p) => activeAt(p.timeSec)).length;
  const st = (ratio) => (ratio > 0 ? 12 * Math.log2(ratio) : null);
  const f0Median = quantile(f0s, 0.5);
  const mfccMean = Array.from({ length: MFCC_COUNT }, (_, c) => (active.length
    ? active.reduce((sum, f) => sum + f.mfcc[c], 0) / active.length
    : 0));
  const speechSpanSec = Math.max(0, durationSec - leadingSilenceSec - trailingSilenceSec);
  return {
    durationSec: round(durationSec, 3),
    activeSpeechSec: round(activeSec, 3),
    leadingSilenceSec: round(leadingSilenceSec, 3),
    trailingSilenceSec: round(trailingSilenceSec, 3),
    maxInternalSilenceSec: round(maxInternalSilenceSec, 3),
    endsInSpeech: trailingSilenceSec < 0.1,
    rmsDb: round(meanPower > 0 ? 10 * Math.log10(meanPower) : -120, 2),
    peak: round(peak, 4),
    clippedSamples: clipped,
    centroidHz: round(active.length ? active.reduce((s, f) => s + f.centroidHz, 0) / active.length : 0, 1),
    flatness: round(active.length ? active.reduce((s, f) => s + f.flatness, 0) / active.length : 0, 4),
    f0MedianHz: f0Median == null ? null : round(f0Median, 1),
    f0P10Hz: f0s.length ? round(quantile(f0s, 0.1), 1) : null,
    f0P90Hz: f0s.length ? round(quantile(f0s, 0.9), 1) : null,
    f0SpreadSt: f0s.length ? round(st(quantile(f0s, 0.75) / quantile(f0s, 0.25)), 2) : null,
    f0RangeSt: f0s.length ? round(st(quantile(f0s, 0.9) / quantile(f0s, 0.1)), 2) : null,
    voicedFraction: pitchFramesActive ? round(f0s.length / pitchFramesActive, 3) : 0,
    wordsPerSecActive: activeSec > 0 ? round(words / activeSec, 2) : null,
    wordsPerSecSpan: speechSpanSec > 0 ? round(words / speechSpanSec, 2) : null,
    mfccMean: mfccMean.map((v) => round(v, 3)),
  };
}

function round(value, digits) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

// One unit on every axis is roughly "a just-noticeable but real change" in a
// narrator's delivery. Fixed, so two runs' drift scores are comparable.
export const DRIFT_UNITS = Object.freeze({
  f0MedianSt: { unit: 1, describe: '1 semitone of median pitch' },
  f0SpreadSt: { unit: 1, describe: '1 semitone of pitch IQR' },
  centroidOct: { unit: 0.25, describe: 'a quarter-octave of spectral centroid' },
  flatness: { unit: 0.05, describe: '0.05 of spectral flatness' },
  rmsDb: { unit: 3, describe: '3 dB of loudness' },
  wordsPerSec: { unit: 0.5, describe: '0.5 words/s of speaking rate' },
});

export function prosodyVector(features) {
  if (!features || features.f0MedianHz == null || !features.centroidHz) return null;
  return [
    12 * Math.log2(features.f0MedianHz / 100) / DRIFT_UNITS.f0MedianSt.unit,
    (features.f0SpreadSt ?? 0) / DRIFT_UNITS.f0SpreadSt.unit,
    Math.log2(features.centroidHz) / DRIFT_UNITS.centroidOct.unit,
    features.flatness / DRIFT_UNITS.flatness.unit,
    features.rmsDb / DRIFT_UNITS.rmsDb.unit,
    (features.wordsPerSecActive ?? 0) / DRIFT_UNITS.wordsPerSec.unit,
  ];
}

function meanVector(vectors) {
  const valid = vectors.filter(Boolean);
  if (!valid.length) return null;
  return valid[0].map((_, i) => valid.reduce((sum, v) => sum + v[i], 0) / valid.length);
}

function distance(a, b) {
  if (!a || !b) return null;
  let acc = 0;
  for (let i = 0; i < a.length; i += 1) acc += (a[i] - b[i]) ** 2;
  return Math.sqrt(acc / a.length);
}

// Rolling 5-paragraph windows vs the first 5. Returned per window start.
export function rollingDrift(vectors, size = 5) {
  if (vectors.length < size) return [];
  const reference = meanVector(vectors.slice(0, size));
  const out = [];
  for (let start = 0; start + size <= vectors.length; start += 1) {
    out.push({
      start,
      end: start + size - 1,
      distance: round(distance(meanVector(vectors.slice(start, start + size)), reference), 3),
    });
  }
  return out;
}
