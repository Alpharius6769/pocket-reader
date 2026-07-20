# GGML / audio.cpp path (kyutai-labs/pocket-tts#203)

Status date: 2026-07-17

## What issue #203 is

[Issue #203](https://github.com/kyutai-labs/pocket-tts/issues/203) announces
[audio.cpp](https://github.com/0xShug0/audio.cpp): a **native C++ / GGML**
Pocket TTS engine (CPU / CUDA / Vulkan / Metal). Headline numbers are from
**CUDA**, not from browsers. Related browser work in the ecosystem is a
**Chrome/Edge extension + native helper**
([pocket-tts-browser-engine](https://github.com/jjmlovesgit/pocket-tts-browser-engine)),
not an in-page WASM replacement for ONNX Runtime Web.

## What Pocket Reader is today

Alpharius' Pocket Reader narrates **inside the browser** (Anvil PWA) using
ONNX Runtime Web (threaded WASM ×2/×4 on phones, optional WebGPU on desktop).
That path must keep working on Pixel / iPhone without installing a native
binary.

**audio.cpp cannot be dropped into Anvil as a browser engine.** There is no
upstream Emscripten/WASM build of `pocket_tts` in audio.cpp. Replacing the
loaded browser instruction set with GGML would brick mobile offline narration.

## What we shipped on remotes (2026-07-17)

### Backblaze B2 (`pocket-reader-assets`)

| Prefix | Purpose |
|--------|---------|
| `onnx/` | **Active** browser ORT/WebGPU models (unchanged, still loaded) |
| `backup/onnx-ort-browser-20260717/` | **Unused** full copy of `onnx/` + restore docs |
| `backup/onnx-ort-browser-20260717/instruction-set-ort-browser.tar.gz` | Snapshot of ORT browser JS/Python sources for rollback |
| `ggml/pocket-tts/` | Native safetensors layout for audio.cpp `pocket_tts` (English + embeddings) |

Restore browser ORT from backup: see
`backup/onnx-ort-browser-20260717/RESTORE_ONNX_BROWSER.md` on B2.

### Cloudflare Worker (`pocket-reader-proxy`)

Worker now proxies:

- `/models/...` (existing ORT/voices)
- `/ggml/...` → B2 `ggml/...`
- `/backup/...` → B2 `backup/...`
- `/models/ggml/...` and `/models/backup/...` aliases

Browser production still fetches ORT under `/models` → `onnx/`.

### Hugging Face

HF CLI is authenticated as `alpharius6769`. PocketTTS English snapshot was
installed via `vendor/audio.cpp/tools/model_manager.py install pocket_tts`.
No Space rewrite: the Space remains scrapers/library API. Hosting
`audiocpp_server` would require a **GPU Space** and would make narration
server-side (breaks offline PWA).

### Anvil

**No production engine swap.** Live app remains ORT WASM/WebGPU
(`pocket-reader-core-v109`). Switching Anvil to “GGML” without a browser
runtime would stop narration on phones.

### Zyte

Not involved in TTS inference. No change.

### Local native tooling

```text
vendor/audio.cpp/                     # upstream clone
vendor/audiocpp-windows/cpu-*/        # Windows prebuilt CLI + server
vendor/audiocpp-models/pocket-tts/    # English model tree
```

CPU smoke on this PC (`audiocpp_cli --backend cpu ...`) currently aborts with:

```text
GGML_ASSERT(buf != NULL && "tensor buffer not set")
```

after flow-LM steps (release 0.3 portable/balance/fast). No NVIDIA toolkit on
this machine (`nvidia-smi` missing), so the CUDA path from #203 was not
validated here. Next validation step: run the same model tree on a CUDA host
or wait for an audio.cpp CPU fix.

Example once a working backend is available:

```powershell
.\audiocpp_cli.exe --task tts --family pocket_tts `
  --model C:\...\vendor\audiocpp-models\pocket-tts `
  --backend cuda --voice-id alba `
  --text "Hello from audio.cpp." --out out.wav

.\audiocpp_server.exe --config tools\audiocpp_server.pocket.json --backend cuda --port 8787
```

OpenAI-style: `POST /v1/audio/speech`.

## Policy going forward

1. **Browsers keep loading ORT** until a real WASM/GGML (or proven sidecar)
   path exists and passes Pixel + iPhone smoke.
2. **GGML assets stay on B2** for native/desktop/server experiments.
3. **ONNX backup stays unloaded** so we can roll back without rebuilding.
4. Do **not** delete `onnx/` or ship Anvil builds that only speak to
   `audiocpp_server` unless offline mobile is explicitly abandoned.

## Suggested next engineering steps (when unblocked)

1. Reproduce PocketTTS on a CUDA Windows/Linux box with release 0.3+.
2. Stand up `audiocpp_server` locally; optional desktop Settings opt-in in
   Anvil that POSTs to `http://127.0.0.1:8787/v1/audio/speech` with ORT
   fallback.
3. Only then consider HF GPU Space hosting for shared native inference.
4. Track upstream WASM / browser-engine maturity separately from the PWA.
