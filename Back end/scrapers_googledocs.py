import re

from scrapers_core import fetch
from parsers_core import ScrapeResult, Chapter, clean_text, split_paragraphs


def _extract_doc_id(url: str) -> str:
    """Pull the document ID out of any Google Docs URL shape."""
    m = re.search(r"/document/d/([a-zA-Z0-9_-]+)", url)
    if m:
        return m.group(1)
    m = re.search(r"[?&]id=([a-zA-Z0-9_-]+)", url)
    if m:
        return m.group(1)
    raise RuntimeError("Could not find a Google Docs document ID in the URL.")


async def scrape_googledocs(url: str, **kwargs) -> ScrapeResult:
    """Fetch a publicly-shared Google Doc via its plain-text export endpoint.

    The /edit page is a JavaScript app with no readable article HTML, so the
    generic scraper fails on it. Google exposes a clean text export at
    /document/d/{id}/export?format=txt which we fetch through the edge proxy.
    """
    doc_id = _extract_doc_id(url)
    export_url = f"https://docs.google.com/document/d/{doc_id}/export?format=txt"

    text = await fetch(export_url)
    text = clean_text(text or "")

    if not text or len(text.strip()) < 20:
        raise RuntimeError(
            "This Google Doc returned no readable text — it may be private. "
            "Ask the author to set sharing to 'Anyone with the link', or download it.")

    # First non-empty line is usually the title; fall back to a generic label.
    lines = [ln.strip() for ln in text.split("\n") if ln.strip()]
    title = lines[0][:120] if lines else "Google Doc"

    paragraphs = split_paragraphs(text)
    if not paragraphs:
        paragraphs = [p.strip() for p in text.split("\n") if p.strip()]
    if not paragraphs:
        raise RuntimeError("Could not extract readable text from this Google Doc.")

    return ScrapeResult(
        title=title,
        chapters=[Chapter(title=title, paragraphs=paragraphs)],
    )