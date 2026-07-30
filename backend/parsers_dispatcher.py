from pathlib import Path
from typing import List, Optional
from parsers_core import Chapter, guard_zip_bomb, sanitize_narration_chapters

# Format mappings
from parsers_epub import parse_epub, extract_epub_metadata, extract_epub_cover
from parsers_pdf import parse_pdf, extract_pdf_metadata, extract_pdf_cover
from parsers_document import parse_docx, extract_docx_metadata, parse_html_file, parse_txt


def extract_metadata(path) -> dict:
    ext = Path(path).suffix.lower()
    if ext in (".epub", ".docx"):
        guard_zip_bomb(path)
    if ext == ".epub":
        return extract_epub_metadata(path)
    if ext == ".pdf":
        return extract_pdf_metadata(path)
    if ext == ".docx":
        return extract_docx_metadata(path)
    return {}


def parse_file(path) -> List[Chapter]:
    ext = Path(path).suffix.lower()

    dispatch = {
        ".epub": parse_epub,
        ".pdf": parse_pdf,
        ".docx": parse_docx,
        ".txt": parse_txt,
        ".html": parse_html_file,
        ".htm": parse_html_file,
    }

    if ext == ".doc":
        raise ValueError(
            "Legacy .doc files are unsupported. Resave your file as .docx and re-upload.")

    if ext in (".mobi", ".azw", ".azw3"):
        raise ValueError(
            "Kindle formats (.mobi/.azw/.azw3) are not supported. "
            "Convert to EPUB or PDF (e.g. with Calibre) and re-upload.")

    if ext not in dispatch:
        raise ValueError(
            f"Unsupported format: {ext}. Supported types: EPUB, PDF, DOCX, TXT, HTML")

    if ext in (".epub", ".docx"):
        guard_zip_bomb(path)
    chapters = dispatch[ext](path)
    metadata = extract_metadata(path)
    chapters = sanitize_narration_chapters(
        chapters,
        story_title=metadata.get("title", ""),
        author=metadata.get("author", ""),
    )
    if not chapters:
        raise RuntimeError(
            "Zero parseable text chapters could be isolated from this file asset.")
    return chapters


def extract_cover(path) -> Optional[bytes]:
    """Isolate and extract cover artwork bytes based on file format extension."""
    ext = Path(path).suffix.lower()
    if ext == ".epub":
        return extract_epub_cover(path)
    if ext == ".pdf":
        return extract_pdf_cover(path)
    return None
