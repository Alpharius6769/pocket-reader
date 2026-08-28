from pathlib import Path
from typing import List
from parsers_core import Chapter, guard_zip_bomb, sanitize_narration_chapters

# Format mappings
from parsers_epub import parse_epub, extract_epub_metadata
from parsers_pdf import parse_pdf, extract_pdf_metadata
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


# No extract_cover(): nothing in the stack consumes cover bytes. The upload
# payload carries title, author, words and chapters only, and the reader draws
# its own placeholder from the title when a story has no coverImage. The
# dispatcher and the two format extractors it fanned out to were unreachable.
