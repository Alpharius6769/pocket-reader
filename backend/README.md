---
title: Alpharius' Pocket Reader
emoji: 📖
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
license: other
license_name: pocket-reader-proprietary
short_description: Edge-routed audiobook reader with browser-side TTS.
---

# Alpharius' Pocket Reader

FastAPI backend for the Pocket Reader web app. This Space is a lightweight I/O
router: it searches and scrapes supported story sources, parses uploaded files,
serves bundled curated PDFs, registers push subscriptions, and provides health
and diagnostics endpoints.

No neural text-to-speech inference runs here. Narration runs in the browser.
The frontend is hosted on GitHub Pages and talks to this Space through the
Cloudflare Worker `pocket-reader-proxy`.

Hugging Face Spaces reads the YAML block above as this Space's configuration.
`sdk: docker` is required: this is not a Gradio app. `app_port` matches the
container (`7860`). Keep this file in `backend/` so deploys do not delete it.
