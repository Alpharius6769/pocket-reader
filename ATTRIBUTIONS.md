# Frontend Attributions

Last reviewed: 2026-07-15.

## Lucide

- Source: https://github.com/lucide-icons/lucide
- License: ISC
- Use: locally bundled SVG icon sprite in `theme/assets/lucide-sprite.svg`.

## Literata

- Source: https://github.com/googlefonts/literata
- License: SIL Open Font License 1.1
- Use: local editorial and reader typography.

## IBM Plex Sans

- Source: https://github.com/IBM/plex
- License: SIL Open Font License 1.1
- Use: local application-control typography.

## Rayne (default voice)

- Author: Chris (Alpharius67 / Fluffarius)
- Origin: AI-generated voice created by the maintainer.
- License: Project-owned. No third-party rights apply; free for the project to
	use, including commercially.
- Use: default Pocket TTS voice for all new profiles and the global voice
	fallback.
- Runtime asset names: `rayne`, with emotion suffixes such as `_neutral`.
- Distribution note: source `.wav` reference and converted `.safetensors`
	files are not stored in this source tree; they live with the other runtime
	voice assets on B2 and are served through the Cloudflare Worker.

## Other Project Components

Pocket TTS, Voice-Zero, ONNX Runtime Web, Motion, Anvil Works, Hugging Face,
Cloudflare, Backblaze B2, Zyte, story-source platforms, Game-Icons.net assets,
and project-owned artwork are documented in the backend repository's full
`ATTRIBUTIONS.md` and `NOTICE` files.

Pocket Reader application code is proprietary, all rights reserved (see
`LICENSE` in the backend repository). Virtue artwork, dialogue, lore, character
identity, Pocket Reader branding, and project-owned navigation art are
separately proprietary works owned by Chris (Alpharius67 / Fluffarius), all
rights reserved.

The third-party components above retain their own licenses. Lucide (ISC),
Literata and IBM Plex Sans (OFL-1.1) obligations continue to apply, and their
bundled license texts must ship with the frontend.
