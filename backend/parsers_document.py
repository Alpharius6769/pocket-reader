import re
from pathlib import Path
from typing import List
from bs4 import BeautifulSoup
try:
    from docx import Document
except ImportError:
    Document = None
from parsers_core import (
    Chapter, clean_text, split_paragraphs, MAX_PARSED_TEXT_CHARS)


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
    text = (main or soup).get_text("\n\n")
    # Cap extracted text (matches EPUB/PDF) so a huge HTML upload or scrape
    # cannot emit a story beyond the intended size limit.
    if len(text) > MAX_PARSED_TEXT_CHARS:
        text = text[:MAX_PARSED_TEXT_CHARS]
    paras = split_paragraphs(clean_text(text))
    return [Chapter(title=title, paragraphs=paras)] if paras else []


def parse_html_file(path) -> List[Chapter]:
    with open(str(path), "r", encoding="utf-8", errors="replace") as f:
        return parse_html_string(f.read(), Path(str(path)).stem)


def parse_txt(path) -> List[Chapter]:
    with open(str(path), "r", encoding="utf-8", errors="replace") as f:
        # Read at most the cap so a huge .txt cannot balloon into memory or
        # produce a story far larger than the EPUB/PDF paths allow.
        text = f.read(MAX_PARSED_TEXT_CHARS)
    paras = split_paragraphs(clean_text(text))
    if not paras:
        # Preserve dialogue fragments down to 1 character (e.g., punctuation or "—")
        paras = [line.strip() for line in text.splitlines() if len(line.strip()) > 0]
    return [Chapter(title=Path(str(path)).stem, paragraphs=paras)] if paras else []