import re
from pathlib import Path
from typing import List
from bs4 import BeautifulSoup
try:
    from docx import Document
except ImportError:
    Document = None
from parsers_core import (
    Chapter, clean_text, split_paragraphs, html_paragraphs,
    MAX_PARSED_TEXT_CHARS)


def parse_docx(path) -> List[Chapter]:
    if Document is None:
        raise RuntimeError('python-docx not installed')
    doc = Document(str(path))
    chapters, cur_title, cur_paras = [], None, []
    # Bound the extracted text like the EPUB/PDF parsers do, so an oversized
    # DOCX cannot produce a story far larger than the intended cap (which would
    # bloat the API response, the client's IndexedDB copy, and every cache job).
    total_chars = 0

    for para in doc.paragraphs:
        # Check style properties safely
        style_name = para.style.name if para.style else ""
        text = para.text.strip()
        if not text:
            continue
        total_chars += len(text)
        if total_chars > MAX_PARSED_TEXT_CHARS:
            break

        # Match against standard English names, localized variations, or explicit chapters
        is_heading = False
        if style_name:
            if re.search(r'(heading|titre|überschrift|título|titolo|chapter|rubrik)', style_name, re.IGNORECASE):
                is_heading = True
        
        if is_heading:
            if cur_paras:
                chapters.append(Chapter(title=cur_title or "Section", paragraphs=cur_paras))
            cur_title, cur_paras = text, []
        else:
            cur_paras.append(text)

    if cur_paras:
        chapters.append(Chapter(title=cur_title or Path(str(path)).stem, paragraphs=cur_paras))
    return chapters


def extract_docx_metadata(path) -> dict:
    if Document is None:
        return {}
    try:
        doc = Document(str(path))
        props = doc.core_properties
        return {
            "title": (props.title or "") if props else "",
            "author": (props.author or "") if props else "",
        }
    except Exception:
        return {}


def parse_html_string(
        html: str,
        default_title: str = "Story") -> List[Chapter]:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "header", "footer", "aside"]):
        tag.decompose()

    title_tag = soup.find("title") or soup.find("h1")
    title = title_tag.get_text(strip=True) if title_tag else default_title

    main = (
        soup.find("main") or soup.find("article") or soup.find(
            "div",
            class_=re.compile(
                r"content|story|chapter|text",
                re.I)) or soup.body)
    # Capped (matches EPUB/PDF) so a huge HTML upload or scrape cannot emit a
    # story beyond the intended size limit.
    paras = html_paragraphs(main or soup, max_chars=MAX_PARSED_TEXT_CHARS)
    return [Chapter(title=title, paragraphs=paras)] if paras else []


def parse_html_file(path) -> List[Chapter]:
    with open(str(path), "r", encoding="utf-8", errors="replace") as f:
        return parse_html_string(f.read(), Path(str(path)).stem)


# A line that is a chapter heading in a plain-text story: "Chapter 12",
# "CHAPTER TWO: The Ledger", "Part III", "Prologue". Short, on its own, and not
# a sentence.
_NUMBER_WORDS = (
    r"(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|"
    r"sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|"
    r"hundred|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|final)")
_TXT_HEADING = re.compile(
    r"^(?:chapter|part|book|act)\s+(?:\d{1,4}|[ivxlcdm]{1,8}|" + _NUMBER_WORDS + r"(?:[- ][a-z]+)?)\b[^\n]{0,70}$"
    r"|^(?:prologue|epilogue|interlude|afterword|foreword|preface)\b[^\n]{0,50}$",
    re.IGNORECASE)


def _is_txt_heading(paragraph: str) -> bool:
    text = (paragraph or "").strip()
    if not text or len(text) > 80 or "\n" in text:
        return False
    if not _TXT_HEADING.match(text):
        return False
    # "Part of me wanted to leave." begins like a heading and is a sentence.
    return not re.search(r"[.!?,;]$", text) or bool(re.match(r"^(?:chapter|part|book|act)\s+\d", text, re.I))


def split_txt_chapters(paras: List[str], default_title: str) -> List[Chapter]:
    """Split paragraphs at chapter headings.

    A text file used to become one chapter whatever it contained, with its
    "Chapter 2" lines read out as part of the story. Two or more heading lines
    are needed before anything is split, so a story that merely contains the
    word is left whole.
    """
    marks = [i for i, p in enumerate(paras) if _is_txt_heading(p)]
    if len(marks) < 2:
        return [Chapter(title=default_title, paragraphs=paras)] if paras else []
    chapters: List[Chapter] = []
    front = paras[:marks[0]]
    # A title and a byline above the first heading are not a chapter of their
    # own; they open the first one. A real foreword is.
    front_is_brief = sum(len(p.split()) for p in front) < 40
    if front and not front_is_brief:
        chapters.append(Chapter(title="Beginning", paragraphs=front))
    for n, start in enumerate(marks):
        end = marks[n + 1] if n + 1 < len(marks) else len(paras)
        body = paras[start + 1:end]
        if n == 0 and front and front_is_brief:
            body = front + body
        if body:
            chapters.append(Chapter(title=paras[start].strip(), paragraphs=body))
    return chapters or [Chapter(title=default_title, paragraphs=paras)]


def parse_txt(path) -> List[Chapter]:
    with open(str(path), "r", encoding="utf-8-sig", errors="replace") as f:
        # Read at most the cap so a huge .txt cannot balloon into memory or
        # produce a story far larger than the EPUB/PDF paths allow.
        text = f.read(MAX_PARSED_TEXT_CHARS)
    paras = split_paragraphs(clean_text(text))
    if not paras:
        # Preserve dialogue fragments down to 1 character (e.g., punctuation or "—")
        paras = [line.strip() for line in text.splitlines() if len(line.strip()) > 0]
    return split_txt_chapters(paras, Path(str(path)).stem)