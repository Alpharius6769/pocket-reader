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


_AO3_EXPORT_SIGNATURE_RE = re.compile(
    r"posted\s+originally\s+on\s+the\s+archive\s+of\s+our\s+own",
    re.IGNORECASE,
)
_CHAPTER_HEADING_RE = re.compile(
    r"^(?:chapter|part|book)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)"
    r"(?:\s*[:\-]\s*[^\n]{0,160})?$",
    re.IGNORECASE,
)
_OPENING_META_MARKER_RE = re.compile(
    r"^(?:chapter\s+)?(?:summary|notes?)\s*:?\s*$",
    re.IGNORECASE,
)
_END_META_MARKER_RE = re.compile(
    r"^(?:chapter\s+end\s+notes?|end\s+notes?|afterword)\s*:?\s*$",
    re.IGNORECASE,
)
_NOTES_TO_STORY_RE = re.compile(
    r"see\s+the\s+end\s+of\s+the\s+chapter\s+for\s+more\s+notes[.!:]?",
    re.IGNORECASE,
)


def _looks_like_author_note(text: str) -> bool:
    """High-confidence author-note prose used only after a note marker."""
    value = re.sub(r"\s+", " ", text or "").strip().lower()
    if not value:
        return True
    signals = (
        r"\b(?:hello|hi|hey|dear)\s+(?:readers?|everyone|all|guys|folks)\b",
        r"\bthanks?(?:\s+you)?\b.*\b(?:reading|support|comments?|kudos|beta)\b",
        r"\b(?:my|this|the)\s+(?:other\s+)?(?:work|story|chapter|writing|outline|draft)\b",
        # First-person authorial only. This was a bare verb alternation
        # (wrote|written|writing|...), which matches ordinary third-person
        # narration -- "He had written to her every day that winter" was being
        # deleted as an author note whenever it followed a Notes:/Summary: marker.
        r"\b(?:i|i've|i'm|we|we've)\s+(?:have\s+|had\s+|been\s+)?"
        r"(?:wrote|written|writing|rewrote|rewritten|published|updated)\b",
        r"\bbeta(?:\s+read(?:er|ing)?s?)\b",
        r"\b(?:leave|drop)\s+(?:a\s+)?(?:comment|kudos)\b",
        r"\b(?:without\s+further\s+ado|please\s+enjoy|hope\s+you\s+enjoy)\b",
        r"\b(?:check\s+out|find\s+me|follow\s+me)\b.*\b(?:work|story|archive|ao3|tumblr|twitter)\b",
        r"^(?:story\s+outline|pass\s+(?:one|two|\d+)|beta\s+pass|publish)\b",
        r"\b(?:next|current)\s+(?:story\s+)?updates?\b",
    )
    return any(re.search(pattern, value, re.IGNORECASE) for pattern in signals)


def _strip_leading_chapter_labels(
        text: str,
        chapter_title: str = "",
        story_title: str = "",
        author: str = "") -> str:
    """Remove export headings embedded at the start of the first prose block."""
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    if not lines:
        return ""

    def _key(value: str) -> str:
        return re.sub(r"[^a-z0-9]", "", (value or "").lower())

    title_keys = {_key(chapter_title), _key(story_title), _key(author)}
    title_keys.discard("")
    last_heading = -1
    for index, line in enumerate(lines[:6]):
        if _CHAPTER_HEADING_RE.match(line) or _key(line) in title_keys:
            last_heading = index
    if last_heading >= 0:
        lines = lines[last_heading + 1:]

    if lines and author and _key(lines[0]) == _key(author):
        lines.pop(0)
    elif len(lines) >= 2 and re.fullmatch(r"[\w .'\-]{2,60}", lines[0]):
        if len(lines[0].split()) <= 4 and len(lines[1].split()) >= 6:
            lines.pop(0)
    return "\n".join(lines).strip()


def _split_marker(text: str, marker_re: re.Pattern) -> tuple[str, str, bool]:
    """Split a paragraph around a line-shaped structural marker."""
    lines = (text or "").splitlines()
    for index, line in enumerate(lines):
        if marker_re.match(line.strip()):
            return (
                "\n".join(lines[:index]).strip(),
                "\n".join(lines[index + 1:]).strip(),
                True,
            )
    match = marker_re.search((text or "").strip())
    if match:
        return (text[:match.start()].strip(), text[match.end():].strip(), True)
    return (text.strip(), "", False)


def sanitize_narration_chapters(
        chapters: list,
        *,
        story_title: str = "",
        author: str = "") -> list:
    """Remove embedded export metadata while preserving story prose."""
    source = drop_front_back_matter(chapters or [])
    result = []
    document_opening = "\n".join(
        paragraph
        for chapter in source[:2]
        for paragraph in (chapter.paragraphs or [])[:12]
    )
    ao3_export = bool(_AO3_EXPORT_SIGNATURE_RE.search(document_opening))

    if ao3_export:
        expanded = []
        for chapter in source:
            values = list(chapter.paragraphs or [])
            boundaries = []
            for index, paragraph in enumerate(values):
                heading = next((
                    line.strip() for line in str(paragraph or "").splitlines()
                    if _CHAPTER_HEADING_RE.match(line.strip())
                ), None)
                if heading:
                    boundaries.append((index, heading))
            if boundaries and (boundaries[0][0] > 0 or len(boundaries) > 1):
                for position, (start, heading) in enumerate(boundaries):
                    end = boundaries[position + 1][0] if position + 1 < len(boundaries) else len(values)
                    expanded.append(Chapter(title=heading, paragraphs=values[start:end]))
            else:
                expanded.append(chapter)
        source = expanded

    for chapter in source:
        paragraphs = [str(value or "").strip()
                      for value in (chapter.paragraphs or [])
                      if str(value or "").strip()]
        if not paragraphs:
            continue

        cleaned = []
        intro_meta = False
        saw_intro_meta = False
        for index, raw in enumerate(paragraphs):
            text = raw

            # Only an actual AO3 export may be truncated at an end-of-notes
            # marker. This used to fire on ANY document, so an uploaded story
            # containing a line that is exactly "End Notes" or "Afterword"
            # silently discarded every remaining paragraph of that chapter.
            before_end, _, has_end = (
                _split_marker(text, _END_META_MARKER_RE) if ao3_export else ("", "", False)
            )
            if has_end:
                if before_end:
                    cleaned.append(before_end)
                break

            transition = _NOTES_TO_STORY_RE.search(text)
            if transition:
                text = text[transition.end():].lstrip(" \t\r\n:-")
                intro_meta = False
                saw_intro_meta = True
                if not text:
                    continue

            _, _, has_meta = _split_marker(text, _OPENING_META_MARKER_RE)
            if has_meta and (index < 20 or not cleaned):
                intro_meta = True
                saw_intro_meta = True
                continue

            if intro_meta and _looks_like_author_note(text):
                continue
            if intro_meta:
                intro_meta = False

            if not cleaned:
                text = _strip_leading_chapter_labels(
                    text,
                    chapter_title=chapter.title,
                    story_title=story_title,
                    author=author,
                )
            if text:
                cleaned.append(text)

        if cleaned:
            result.append(Chapter(title=chapter.title, paragraphs=cleaned))
        elif not saw_intro_meta and not ao3_export:
            result.append(chapter)

    collapsed = []
    number_re = re.compile(
        r"^(?:chapter|part|book)\s+(\d+|[ivxlcdm]+)\b",
        re.IGNORECASE,
    )
    for chapter in result:
        match = number_re.match((chapter.title or "").strip())
        prior_match = number_re.match((collapsed[-1].title or "").strip()) if collapsed else None
        if match and prior_match and match.group(1).lower() == prior_match.group(1).lower():
            prior = collapsed[-1]
            if len(prior.paragraphs) <= 12 and len(chapter.paragraphs) > len(prior.paragraphs):
                collapsed[-1] = chapter
            else:
                prior.paragraphs.extend(chapter.paragraphs)
            continue
        collapsed.append(chapter)

    return collapsed or source


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
