from typing import Optional


class CloudflareBlocked(Exception):
    """Raised when a fetch returns a Cloudflare challenge page."""

    def __init__(self, url: str, reason: str = ""):
        super().__init__(f"Cloudflare blocked: {url} ({reason})")
        self.url = url
        self.reason = reason


_CF_HEADER_MARKERS = ("cloudflare",)
_CF_BODY_MARKERS = (
    "<title>Just a moment...</title>",
    "<title>Attention Required! | Cloudflare</title>",
    "cf-browser-verification",
    "cf-challenge-running",
)


def detect_cloudflare(response, body_text: str) -> Optional[str]:
    """Inspect a response for Cloudflare challenge markers."""
    try:
        h = {k.lower(): v for k, v in response.headers.items()}
    except Exception:
        h = {}

    if "cf-mitigated" in h:
        return f"cf-mitigated={h.get('cf-mitigated')}"

    if response.status_code in (403, 503) and "cf-ray" in h:
        return f"status={response.status_code} cf-ray={h.get('cf-ray')}"

    srv = (h.get("server") or "").lower()
    if any(m in srv for m in _CF_HEADER_MARKERS):
        if body_text and any(m in body_text for m in _CF_BODY_MARKERS):
            return "server=cloudflare + body marker"

    if body_text:
        for marker in _CF_BODY_MARKERS:
            if marker in body_text:
                return f"body marker: {marker[:40]}"

    return None
