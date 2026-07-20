import os
import re
import zipfile
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class Chapter:
    title: str
    paragraphs: List[str] = field(default_factory=list)


@dataclass
class ScrapeResult:
    title: str
    chapters: List[Chapter]
    synopsis: str = ""
    genres: List[str] = field(default_factory=list)
    artwork_url: Optional[str] = None
    author: str = ""
    fandoms: List[str] = field(default_factory=list)
    additional_tags: List[str] = field(default_factory=list)
    content_rating: str = ""


def clean_text(text: str) -> str:
    """Normalize line endings and condense excessive whitespace spacing."""
    text = re.sub(r"\r\n|\r", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def split_paragraphs(text: str) -> List[str]:
    """Slice raw text into paragraph arrays based on standard blank lines."""
    return [p.strip() for p in text.split("\n\n") if len(p.strip()) > 0]


# Front- and back-matter section titles that should never be listed as a chapter
# or narrated. Matched against the whole normalized title, so a real chapter
# like "Notes from the Underground" or "The Afterword Incident" is not dropped.
# Prologue, epilogue, and interlude are intentionally absent; those are story
# content. AO3 exports in particular emit "Preface", "Afterword", and
# per-chapter "Notes" sections.
_SKIP_SECTION_RE = re.compile(
    r"""^(
        preface
      | foreword
      | introduction
      | intro
      | afterword s?
      | (author'?s?\ |authors\ |translator'?s?\ |editor'?s?\ )? note s?
      | (beginning|end|chapter|additional|closing|opening|further)\ notes?
      | end\ ?notes?
      | foot\ ?notes?
      | acknowledge?ments?
      | dedication
      | epigraph
      | colophon
      | copyright(\ notice)?
      | title\ page
      | cover(\ page)?
      | (table\ of\ )?contents
      | toc
      | about\ the\ author
      | summary
      | works?\ inspired\ by\ this(\ one)?
    )$""",
    re.IGNORECASE | re.VERBOSE,
)


def _normalize_section_title(title: str) -> str:
    t = (title or "").strip().lower()
    edge_punctuation = r"[\s\"'\u201c\u201d\u2018\u2019()\[\]\-\u2014\u2013:.]+"
    t = re.sub(r"^" + edge_punctuation, "", t)
    t = re.sub(edge_punctuation + r"$", "", t)
    return re.sub(r"\s+", " ", t)


def is_front_back_matter(title: str) -> bool:
    """Return True for front/back-matter sections that should not be narrated."""
    norm = _normalize_section_title(title)
    return bool(norm) and bool(_SKIP_SECTION_RE.match(norm))


def drop_front_back_matter(chapters: list) -> list:
    """Remove front/back matter, but keep the original list if all sections match."""
    kept = [c for c in chapters if not is_front_back_matter(c.title)]
    return kept or chapters


# Decompression-bomb guards for zip-based uploads (EPUB, DOCX).
MAX_UNCOMPRESSED_BYTES = int(
    os.environ.get("MAX_UNCOMPRESSED_BYTES", 300 * 1024 * 1024))
MAX_COMPRESSION_RATIO = int(os.environ.get("MAX_COMPRESSION_RATIO", 200))
MAX_ZIP_MEMBERS = int(os.environ.get("MAX_ZIP_MEMBERS", 10_000))
MAX_PARSED_TEXT_CHARS = int(
    os.environ.get("MAX_PARSED_TEXT_CHARS", 5_000_000))


def guard_zip_bomb(path) -> None:
    """Reject zip-based files that would expand to an unsafe size.

    Inspects the central directory without extraction. EPUB and DOCX are both
    zip containers, so a small upload could otherwise balloon into GB of RAM
    during parsing.
    """
    try:
        with zipfile.ZipFile(str(path)) as zf:
            if len(zf.infolist()) > MAX_ZIP_MEMBERS:
                raise ValueError("This archive contains too many files.")
            total = 0
            for info in zf.infolist():
                total += info.file_size
                if total > MAX_UNCOMPRESSED_BYTES:
                    raise ValueError(
                        "This file expands beyond the allowed size limit.")
                if info.compress_size > 0 and info.file_size > 1024 * 1024:
                    if info.file_size / info.compress_size > MAX_COMPRESSION_RATIO:
                        raise ValueError(
                            "This file has an abnormal compression ratio (possible zip bomb).")
    except zipfile.BadZipFile:
        # Not a valid zip; let the downstream parser surface its own error.
        return


# Configurable PDF parsing heuristics.
PDF_MIN_PARAS = int(os.environ.get("PDF_MIN_PARAS", 8))
PDF_AVG_WORD_THRESHOLD = int(os.environ.get("PDF_AVG_WORD_THRESHOLD", 400))
PDF_DEEP_SPLIT_THRESHOLD = int(os.environ.get("PDF_DEEP_SPLIT_THRESHOLD", 120))


def split_paragraphs_pdf(text: str) -> List[str]:
    """Advanced heuristic parser to counteract hard line breaks inside PDFs."""
    naive = [p.strip() for p in text.split("\n\n") if len(p.strip()) > 0]
    if len(naive) >= PDF_MIN_PARAS:
        avg_words = sum(len(p.split()) for p in naive) / max(len(naive), 1)
        if avg_words < PDF_AVG_WORD_THRESHOLD:
            return naive

    augmented = re.sub(
        r'([.!?]["\u201d\u2019\)]?)\n(?=[A-Z"\u201c\u2018\(])',
        r"\1\n\n",
        text,
    )
    augmented = re.sub(
        r'([\u201d"])\n(?=["A-Z\u201c\u2018])',
        r"\1\n\n",
        augmented,
    )
    paras = [p.strip() for p in augmented.split("\n\n") if len(p.strip()) > 0]

    avg = sum(len(p.split()) for p in paras) / max(len(paras), 1)
    if avg > PDF_DEEP_SPLIT_THRESHOLD and paras:
        all_text = "\n\n".join(paras)
        more = re.sub(
            r'([.!?]["\u201d\u2019\)]?)\s*\n',
            r"\1\n\n",
            all_text,
        )
        deep = [p.strip() for p in more.split("\n\n") if len(p.strip()) > 0]
        if len(deep) > len(paras):
            paras = deep

    return paras if len(paras) >= len(naive) else naive
