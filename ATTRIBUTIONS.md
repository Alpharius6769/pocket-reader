# Third-Party Attributions

This document tracks third-party software, models, services, icons, and data
sources used by Alpharius' Pocket Reader. It is an engineering attribution
inventory, not legal advice.

Pocket Reader code authored by Chris (Alpharius67 / Fluffarius) is proprietary,
all rights reserved. The Virtue character, Virtue artwork/dialogue/lore, and
Pocket Reader branding are separately proprietary. See `LICENSE`, `NOTICE`, and
`CHARACTER_LICENSE.md`.

Going proprietary does not alter the terms of the third-party components listed
below. Their licenses and obligations — notably OFL-1.1 bundled license texts,
CC-BY-3.0 attribution for Game-Icons.net, and MPL-2.0 for pywebpush — continue
to apply in full.

Last reviewed: 2026-09-04.

## Browser TTS and ML Runtime

### ONNX Runtime Web

- Author: Microsoft
- License: MIT License
- Source: https://github.com/microsoft/onnxruntime
- Used as: WebAssembly/WebGPU inference runtime for browser-side TTS.

### Motion

- Maintainer: Motion One / Framer contributors
- License: MIT License
- Source: https://www.npmjs.com/package/motion
- Used as: Frontend animation helper imported from jsDelivr.

### SentencePiece JavaScript/WASM bundle

- Upstream: Google SentencePiece and related JS/WASM packaging
- License: Apache License 2.0 for SentencePiece
- Source: https://github.com/google/sentencepiece
- Used as: Browser tokenizer support for Pocket TTS model bundles. The app now
  fetches this through the model asset proxy rather than storing a local copy.

### Pocket TTS model and voice asset bundles

- Upstream: `kyutai/pocket-tts` (Kyutai), paper arXiv:2509.06926
- License: **Creative Commons Attribution 4.0 International (CC BY 4.0)**
- Source: https://huggingface.co/kyutai/pocket-tts
- Catalog/code: https://github.com/kyutai-labs/pocket-tts
- Provider/maintainer: Project-controlled asset bucket; the ONNX INT8 and FP16
  bundles in that bucket are exports of the upstream Kyutai weights.
- Location: Served through the Cloudflare Worker from Backblaze B2.
- Used as: Highest browser-side TTS tier and precompiled voice state files.
- Commercial use: permitted. CC BY 4.0 allows commercial use and the creation
  and distribution of derivative works -- which is what the ONNX export and its
  quantized and FP16 variants are -- provided attribution is given and changes
  are indicated. This file and `NOTICE` carry that attribution; the exports are
  listed as modifications below.
- Modifications made by this project: conversion of the upstream weights to
  ONNX, dynamic INT8 quantization (per-tensor originally, and a per-channel
  re-quantization of the fused decode block built with
  `tools/rebuild_pocket_block_int8.py`), an FP16 variant, a fused four-frame
  decode block, and ORT-format repackaging.
- Distribution note: these large model/voice assets are not part of this source
  tree. Attribution obligations travel with the bucket assets, so keep this
  entry in sync with what is actually served.

### Kokoro-82M (narration engine)

- Upstream: hexgrad/Kokoro-82M, ONNX build `onnx-community/Kokoro-82M-v1.0-ONNX`
- License: Apache-2.0
- Source: https://huggingface.co/hexgrad/Kokoro-82M
- ONNX build: https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX
- DOI: 10.57967/hf/4329
- Architecture: StyleTTS2, finetuned from `yl4579/StyleTTS2-LJSpeech`.
- Used as: the middle narration tier, run in-browser through ONNX Runtime Web.
  One 86 MB session, non-autoregressive.
- Shipped voices: `af_heart`, `af_bella`, `bf_emma`, `am_michael`, `am_fenrir`,
  `am_puck`. Voice style tables ship as `.bin` files alongside the model.
- Distribution note: the model and voice tables are served through the
  Cloudflare Worker from Backblaze B2 rather than stored in this source tree.

### KittenTTS Nano 0.1 (narration engine)

- Upstream: KittenML/kitten-tts-nano-0.1, ONNX build
  `onnx-community/kitten-tts-nano-0.1-ONNX`
- License: Apache-2.0
- Source: https://huggingface.co/KittenML/kitten-tts-nano-0.1
- Used as: the lightest narration tier, for devices that cannot hold Kokoro.
  15M parameters; roughly 12x less resident memory than Kokoro.
- Shipped voices: `expr-voice-3-f`, `expr-voice-4-f`, `expr-voice-5-f`,
  `expr-voice-3-m`, `expr-voice-4-m`, `expr-voice-5-m`. Each voice is a single
  256-float style vector, unlike Kokoro's (510, 1, 256) table.
- Distribution note: served through the Cloudflare Worker from Backblaze B2
  rather than stored in this source tree.

### Voice-Zero Emotional Pack

- Upstream: OwenTyme/voice-zero
- License: CC0 unless otherwise noted by Voice-Zero.
- Source: https://github.com/OwenTyme/voice-zero
- Used as: Source voice references for the Pocket Reader Pocket TTS emotional
  voice catalog.
- Selected voices: Donald Malone (default voice), Bill Boerst, Jason Mayoff, Kristin Hughes,
  Jodi Krangle Expressive, and Karen Savage.
- Runtime asset names: `donald_malone`, `bill_boerst`, `jason_mayoff`,
  `kristin_hughes`, `jodi_krangle_expressive`, and `karen_savage`, each with
  emotion suffixes such as `_neutral`, `_sad`, and `_happy`.
- Distribution note: source `.flac` references and converted `.safetensors`
  files are not stored in this source tree. The maintainer tool records source
  URLs and writes a runtime manifest for the uploaded B2/Cloudflare assets.
- Status: RETIRED from the shipped catalog. These voices are no longer
  offered in the app; a stored setting naming one is migrated to a live voice
  of the same gender. The converted assets remain in the bucket, so the
  attribution above still applies and is kept for that reason.

### Kyutai Pocket TTS catalog voices (Alba, Jane, Charles, Michael, George, Noah, Mary, Eve)

- Upstream: Kyutai Pocket TTS voice catalog
- Sources:
  - Alba: https://huggingface.co/kyutai/tts-voices/blob/main/alba-mackenna/casual.wav (CC BY 4.0, Alba MacKenna)
  - Jane: https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p339_023_enhanced.wav (CC BY 4.0, VCTK p339)
  - Charles: https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p254_023_enhanced.wav (CC BY 4.0, VCTK p254)
  - Michael: https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p360_023_enhanced.wav (CC BY 4.0, VCTK p360)
  - George: https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p315_023_enhanced.wav (CC BY 4.0, VCTK p315, American New England)
  - Noah: https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p345_023_enhanced.wav (CC BY 4.0, VCTK p345, American Florida)
  - Mary: https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p333_023_enhanced.wav (CC BY 4.0, VCTK p333, American Indiana)
  - Eve: https://huggingface.co/kyutai/tts-voices/blob/main/vctk/p361_023_enhanced.wav (CC BY 4.0, VCTK p361, American New Jersey)
- Catalog: https://github.com/kyutai-labs/pocket-tts
- Used as: Additional Pocket TTS narrator voices. Each has a single official
  reference, so only the `_neutral` conditioning file is shipped.
- Runtime asset names: `alba_neutral`, `jane_neutral`, `charles_neutral`,
  `michael_neutral`, `george_neutral`, `noah_neutral`, `mary_neutral`,
  `eve_neutral`.
- Distribution note: converted `.safetensors` files live on B2 under `voices/v2/`
  and are served through the Cloudflare Worker. Not stored in this source tree.

### Rayne (Personal Clone)

- Status: RETIRED from the shipped catalog and no longer offered in the app.

- Author: Chris (Alpharius67 / Fluffarius)
- Origin: AI-generated voice created by the maintainer.
- License: Project-owned. No third-party rights apply; free for the project to
  use, including commercially.
- Used as: Optional custom user-cloned Pocket TTS voice.
- Runtime asset names: `rayne`, with emotion suffixes such as `_neutral`.
- Distribution note: source `.wav` reference and converted `.safetensors` files
  are not stored in this source tree; they live with the other runtime voice
  assets on B2 and are served through the Cloudflare Worker.

### Pocket TTS voice conversion maintainer tool

- Location: `tools/build_voice_zero_pack.py` and `tools/convert_pocket_voice.py`
- Used as: Optional local maintainer utility for precompiling compatible voice
  samples into `.safetensors` files.
- Runtime note: not loaded by the web app or backend API at runtime.
- Optional dependencies: `pocket-tts`, `safetensors`, `numpy`, `soundfile`,
  `torch`, and `torchaudio`.

## Backend Python Dependencies

Pinned backend dependencies are listed in `requirements.txt`.

### FastAPI

- Author: Sebastian Ramirez and contributors
- License: MIT License
- Source: https://github.com/fastapi/fastapi
- Used as: Backend API framework.

### Uvicorn

- Author: Encode OSS Ltd.
- License: BSD-3-Clause
- Source: https://github.com/encode/uvicorn
- Used as: ASGI server for the Docker container.

### Pydantic

- Author: Samuel Colvin and contributors
- License: MIT License
- Source: https://github.com/pydantic/pydantic
- Used as: Request model validation.

### python-multipart

- Author: Andrew Dunham and contributors
- License: Apache License 2.0
- Source: https://github.com/Kludex/python-multipart
- Used as: Multipart upload parsing for `/api/upload`.

### pypdfium2

- Maintainer: pypdfium2 project
- License: Apache-2.0/BSD-3-Clause; bundles PDFium under BSD-style terms
- Source: https://github.com/pypdfium2-team/pypdfium2
- Used as: PDF text extraction, page counting, metadata extraction, and cover
  rendering.

### Pillow

- Maintainer: Pillow contributors
- License: HPND/MIT-CMU style license
- Source: https://github.com/python-pillow/Pillow
- Used as: Image encoding for rendered PDF covers.

### python-docx

- Author: Steve Canny and contributors
- License: MIT License
- Source: https://github.com/python-openxml/python-docx
- Used as: DOCX parsing and metadata extraction.

### beautifulsoup4

- Author: Leonard Richardson
- License: MIT License
- Source: https://www.crummy.com/software/BeautifulSoup/
- Used as: HTML parsing for scrapers and HTML uploads.

### lxml

- Maintainer: lxml project
- License: BSD-3-Clause; depends on libxml2/libxslt under permissive licenses
- Source: https://lxml.de/
- Used as: HTML/XML parser for EPUB and scraper parsing.

### httpx

- Author: Encode OSS Ltd.
- License: BSD-3-Clause
- Source: https://github.com/encode/httpx
- Used as: Async HTTP client for backend scraping, proxying, FicHub, Zyte, and
  site-health checks.

### pywebpush

- Maintainer: Mozilla Services / web-push-libs contributors
- License: Mozilla Public License 2.0
- Source: https://github.com/web-push-libs/pywebpush
- Used as: VAPID signing and browser push dispatch.
- Compliance note: MPL-2.0 is file-level copyleft. If MPL-covered files are
  modified and distributed, those modifications must be made available under
  MPL terms.

### aiosqlite

- Maintainer: aiosqlite contributors
- License: MIT License
- Source: https://github.com/omnilib/aiosqlite
- Used as: Async SQLite access for push subscriptions, limited favorite-story
  push snapshots, and disabled legacy state-sync tables.

## Infrastructure and Hosted Services

### Hugging Face Spaces

- Provider: Hugging Face
- Used as: Docker hosting for the FastAPI backend.

### Cloudflare Workers

- Provider: Cloudflare
- Used as: Edge proxy for model assets and selected external fetches.

### Backblaze B2

- Provider: Backblaze
- Used as: Origin object storage for large model and voice assets served
  through the Cloudflare Worker.

### Zyte API

- Provider: Zyte
- Source: https://www.zyte.com/
- Used as: Optional smart-proxy/headless-browser fetch path for Cloudflare-
  protected story and FicHub requests when `ZYTE_API_KEY` is configured.

### FicHub

- Provider: FicHub
- Source: https://fichub.net/
- Used as: Optional AO3 EPUB archive/relay source for works that can be
  resolved through FicHub.

### jsDelivr

- Provider: jsDelivr, Cloudflare, Fastly
- Source: https://www.jsdelivr.com/
- Used as: CDN for the remaining browser ESM animation import (Motion). ONNX
  Runtime Web is self-hosted through the versioned Cloudflare/B2 asset path.

## Icons, Artwork, and Fonts

### Lucide

- Maintainer: Lucide contributors
- License: ISC License
- Source: https://github.com/lucide-icons/lucide
- Used as: Locally bundled interface icon sprite. The distributed frontend
  includes the upstream license text as `LICENSE-LUCIDE.txt`.

### Literata

- Author: The Literata Project Authors
- License: SIL Open Font License 1.1
- Source: https://github.com/googlefonts/literata
- Used as: Locally bundled editorial and reader typography.


### Virtue artwork and Pocket Reader branding

- Author: Chris (Alpharius67 / Fluffarius)
- License: Proprietary; all rights reserved
- Used as: App companion character, sprites, iconography, app name, and visual
  identity.
- Terms: See `CHARACTER_LICENSE.md`.

### Navigation/app icons

- Author: Chris (Alpharius67 / Fluffarius)
- License: Proprietary; all rights reserved
- Used as: Pocket Reader navigation and app icons in `public/assets/img/`.

### Game-Icons.net achievement icons

- Authors: Lorc, Delapouite, and Game-Icons.net contributors
- License: Creative Commons Attribution 3.0 Unported (CC BY 3.0)
- Source: https://game-icons.net/
- Used as: Achievement SVG icons in `public/assets/achievements/`.
- Attribution requirement: retain credit to Game-Icons.net and authors.

The Cloudflare Pages frontend includes the complete upstream license text for
both bundled font families. System and browser-provided fallback fonts retain their own
platform licenses.

## Story-Source Platforms

Pocket Reader can fetch or help parse content from third-party story platforms.
Those platforms and all story authors retain their own rights and terms.

- Archive of Our Own (AO3): https://archiveofourown.org/
- Royal Road: https://www.royalroad.com/
- Wattpad: https://www.wattpad.com/
- FurAffinity: https://www.furaffinity.net/
- SoFurry: https://www.sofurry.com/
- Google Docs public/exported documents: https://docs.google.com/

Pocket Reader claims no ownership over story content. Users are responsible for
using the app consistently with source-site terms and author permissions.

## Community Data Sources

### HMOFA Masterlist & Anthronomicon

- Source & Live Site: https://alpharius6769.github.io/hmofa-story-index/
- Created by: Chris (Alpharius67 / Fluffarius)
- Used as: Embedded interactive catalog view in Pocket Reader with an app-specific postMessage bridge & story fetch wrapper. The live standalone HMOFA website remains independent.
- Rights note: Individual stories remain the property of their respective authors.

## Bundled Curated PDFs

The `curated_library` PDFs are bundled for reader convenience and app
presentation. Copyright remains with each story's original author. Pocket
Reader claims no ownership over bundled story text. Authors may request removal
by contacting the maintainer.

## Unsupported Formats

Kindle `.mobi`, `.azw`, and `.azw3` uploads are intentionally unsupported. This
avoids adding GPL/AGPL parser dependencies and avoids ambiguous proprietary
format handling. Users should convert such files to EPUB or PDF before upload.
