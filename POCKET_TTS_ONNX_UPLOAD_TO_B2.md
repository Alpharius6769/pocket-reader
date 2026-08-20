# Pocket TTS ONNX Upload Notes

> ORT 1.27 runtime files remain valid. The old FP16 R1 model folder is retired
> from production selection and retained only for comparison. Production
> WebGPU requires a certified `onnx/english_2026-04-webgpu-fp16-r3/` bundle.
> Keep this INT8 bundle in place as the guaranteed threaded-WASM fallback.

The Pocket TTS voice `.safetensors` files are already a separate asset set under
B2 `voices/`. The console error below is for the core ONNX runtime bundle, not a
voice file:

```text
/models/Pocket TTS Onnx/english_2026-04/flow_lm_main_int8.onnx -> 404
```

## Historical Root Cause

`pocket_worker.js` requests model files through the Cloudflare Worker:

```text
https://pocket-reader-proxy.alpharius67.workers.dev/models/Pocket%20TTS%20Onnx/english_2026-04/<file>
```

The Worker maps `/models/...` to the Backblaze B2 bucket
`pocket-reader-assets`. The original failure occurred because the ONNX bundle
paths were absent while voice files under `voices/` were present. The INT8
bundle has since been uploaded and remains the production fallback.

## WebGPU R3 Bundle

The separate production R3 upload folder is:

```text
pocket-webgpu-r3-b2-upload/
```

Upload its `onnx/` contents without renaming them. R3 contains the strict FP16
four-frame WebGPU core, a benchmark-gated FP16 Mimi candidate, BOS tensor,
manifest, integrity data, and certification report. It deliberately reuses the
existing INT8 bundle for text conditioning, paragraph prefill, tokenizer data,
and the guaranteed Mimi fallback.

Required R3 B2 keys:

```text
onnx/english_2026-04-webgpu-fp16-r3/bundle.json
onnx/english_2026-04-webgpu-fp16-r3/flow_lm_decode_block4_fp16.onnx
onnx/english_2026-04-webgpu-fp16-r3/mimi_decoder_fp16.onnx
onnx/english_2026-04-webgpu-fp16-r3/flow_lm_bos.npy
onnx/english_2026-04-webgpu-fp16-r3/certification.json
onnx/english_2026-04-webgpu-fp16-r3/integrity.json
```

The runtime benchmarks graph capture and the GPU Mimi candidate separately.
Each is retained only for a stable full-pipeline win; otherwise R3 continues
with the strict WebGPU core and threaded-WASM Mimi decoder.

## Source

The current ONNX export used by this app is:

```text
https://huggingface.co/KevinAHM/pocket-tts-onnx
```

The model card documents per-language bundles under:

```text
onnx/<language>/
```

License noted by the model card: CC BY 4.0 for model weights, Apache 2.0 for
code. Keep that attribution in B2/release notes.

## Prepared Local Upload Folder

The B2-ready asset folder is:

```text
pocket-tts-onnx-b2-upload/
```

Upload the contents of that folder to the root of the `pocket-reader-assets`
B2 bucket. Do not upload the wrapping folder name.

The prepared folder contains all five language bundles currently configured in
`pocket_worker.js`:

```text
english_2026-04
german
italian
portuguese
spanish
```

It intentionally contains only the runtime files the app loads: bundle metadata,
tokenizer, BOS reference, and INT8 inference ONNX files. It does not include
unused FP32 exports, encoder exports, or `_24l` bundles.

## Required B2 Keys

Upload the prepared bundle to this preferred layout. The Worker supports this
layout after the backend patch in this branch.

Preferred B2 layout:

```text
onnx/english_2026-04/bundle.json
onnx/english_2026-04/tokenizer.model
onnx/english_2026-04/bos_before_voice.npy
onnx/english_2026-04/text_conditioner_int8.onnx
onnx/english_2026-04/flow_lm_main_int8.onnx
onnx/english_2026-04/flow_lm_flow_int8.onnx
onnx/english_2026-04/mimi_decoder_int8.onnx
```

Repeat the same seven files under:

```text
onnx/german/
onnx/italian/
onnx/portuguese/
onnx/spanish/
```

Legacy app layout, also supported:

```text
Pocket TTS Onnx/english_2026-04/bundle.json
Pocket TTS Onnx/english_2026-04/tokenizer.model
Pocket TTS Onnx/english_2026-04/bos_before_voice.npy
Pocket TTS Onnx/english_2026-04/text_conditioner_int8.onnx
Pocket TTS Onnx/english_2026-04/flow_lm_main_int8.onnx
Pocket TTS Onnx/english_2026-04/flow_lm_flow_int8.onnx
Pocket TTS Onnx/english_2026-04/mimi_decoder_int8.onnx
```

The current worker also requests a root browser tokenizer module:

```text
sentencepiece.js
```

Use `@sctg/sentencepiece-js` browser build `dist/index.js`, uploaded to B2 as
`sentencepiece.js`, unless `pocket_worker.js` is later changed to import another
module URL.

Important browser patch: the raw npm ESM build statically imports Node `fs` and
`buffer`, which fails inside browser module workers. The prepared local
`pocket-tts-onnx-b2-upload/sentencepiece.js` removes those imports, removes the
unused filesystem loaders, and keeps the app's in-memory
`loadFromB64StringModel()` tokenizer path.

Current prepared `sentencepiece.js`:

```text
bytes: 4019283
sha256: 1371cb5e2ee08c7faca8ad53f7cad5a5c41759530f6ade52156dbd8c13059860
```

`pocket_worker.js` imports it with:

```text
/models/sentencepiece.js?v=sp-1371cb5e
```

This query version bypasses stale immutable browser/module caches after the B2
object is overwritten.

## Download Commands

These commands were already run to create `pocket-tts-onnx-b2-upload`. Keep
them here for reproducibility.

```powershell
$target = Join-Path (Get-Location) 'pocket-tts-onnx-b2-upload'
New-Item -ItemType Directory -Force -Path $target | Out-Null
$langs = @('english_2026-04','german','italian','portuguese','spanish')
$files = @(
  'bundle.json',
  'tokenizer.model',
  'bos_before_voice.npy',
  'text_conditioner_int8.onnx',
  'flow_lm_main_int8.onnx',
  'flow_lm_flow_int8.onnx',
  'mimi_decoder_int8.onnx'
)
$hfArgs = @('download','KevinAHM/pocket-tts-onnx','--local-dir',$target)
foreach ($lang in $langs) {
  foreach ($file in $files) {
    $hfArgs += @('--include', "onnx/$lang/$file")
  }
}
& .\.venv-voice\Scripts\hf.exe @hfArgs
```

For `sentencepiece.js`:

```powershell
mkdir sentencepiece-js-package
cd sentencepiece-js-package
npm pack @sctg/sentencepiece-js@1.3.3
tar -xf .\sctg-sentencepiece-js-1.3.3.tgz
copy .\package\dist\index.js ..\sentencepiece.js
cd ..
```

Upload `sentencepiece.js` to the B2 bucket root.

## Verification URLs

After upload and Worker deploy, these must return `200`:

```text
https://pocket-reader-proxy.alpharius67.workers.dev/models/Pocket%20TTS%20Onnx/english_2026-04/bundle.json
https://pocket-reader-proxy.alpharius67.workers.dev/models/Pocket%20TTS%20Onnx/english_2026-04/flow_lm_main_int8.onnx
https://pocket-reader-proxy.alpharius67.workers.dev/models/Pocket%20TTS%20Onnx/english_2026-04/flow_lm_flow_int8.onnx
https://pocket-reader-proxy.alpharius67.workers.dev/models/Pocket%20TTS%20Onnx/english_2026-04/mimi_decoder_int8.onnx
https://pocket-reader-proxy.alpharius67.workers.dev/models/Pocket%20TTS%20Onnx/english_2026-04/text_conditioner_int8.onnx
https://pocket-reader-proxy.alpharius67.workers.dev/models/sentencepiece.js
```

The direct B2 preferred-layout checks are:

```text
https://f005.backblazeb2.com/file/pocket-reader-assets/onnx/english_2026-04/bundle.json
https://f005.backblazeb2.com/file/pocket-reader-assets/onnx/english_2026-04/flow_lm_main_int8.onnx
https://f005.backblazeb2.com/file/pocket-reader-assets/sentencepiece.js
```
