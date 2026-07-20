import os
import io
from pathlib import Path
from typing import List, Optional
import pypdfium2 as pdfium
from parsers_core import (
    Chapter, clean_text, split_paragraphs_pdf, drop_front_back_matter,
    MAX_PARSED_TEXT_CHARS)

MAX_PDF_PAGES = int(os.environ.get("MAX_PDF_PAGES", 3000))
MAX_PDF_TEXT_CHARS = min(
    int(os.environ.get("MAX_PDF_TEXT_CHARS", 5_000_000)),
    MAX_PARSED_TEXT_CHARS,
)


def _page_text(pdf, index: int) -> str:
    page = pdf[index]
    try:
        textpage = page.get_textpage()
        try:
            return textpage.get_text_range() or ""
        finally:
            textpage.close()
    finally:
        page.close()


def _toc_boundaries(pdf) -> List[tuple]:
    """Top-level outline entries as (page_index, title), filtered to a
    monotonically non-decreasing page sequence. pypdfium2 reports unresolved
    or named destinations as page 0, which would otherwise produce overlapping
    or duplicated chapter ranges; dropping out-of-order entries folds that
    stray content into the preceding chapter instead of duplicating it."""
    bounds = []
    last = -1
    for bm in pdf.get_toc():
        if bm.level != 0:
            continue
        dest = bm.get_dest()
        page_index = dest.get_index() if dest else None
        if page_index is None or page_index < last:
            continue
        bounds.append((page_index, (bm.get_title() or "").strip()))
        last = page_index
    return bounds


def parse_pdf(path) -> List[Chapter]:
    pdf = pdfium.PdfDocument(str(path))
    try:
        n_pages = len(pdf)
        bounds = _toc_boundaries(pdf)
        if bounds:
            chapters = []
            pages_read = 0
            remaining_chars = MAX_PDF_TEXT_CHARS
            for n, (start, title) in enumerate(bounds):
                if pages_read >= MAX_PDF_PAGES or remaining_chars <= 0:
                    break
                end = bounds[n + 1][0] if n + 1 < len(bounds) else n_pages
                start = max(0, start)
                end = min(end, n_pages)
                page_text = []
                for p in range(start, end):
                    if pages_read >= MAX_PDF_PAGES or remaining_chars <= 0:
                        break
                    value = _page_text(pdf, p)
                    pages_read += 1
                    if len(value) > remaining_chars:
                        value = value[:remaining_chars]
                    remaining_chars -= len(value)
                    page_text.append(value)
                text = "\n".join(page_text)
                paras = split_paragraphs_pdf(clean_text(text))
                if paras:
                    chapters.append(
                        Chapter(title=title or f"Chapter {n + 1}",
                                paragraphs=paras))
            # Drop preface / afterword / per-chapter "Notes" outline entries so
            # they're never listed or narrated.
            chapters = drop_front_back_matter(chapters)
            if chapters:
                return chapters

        # Fallback: cap pages and accumulated text so a huge PDF can't exhaust
        # memory on the free-tier worker.
        paras_accum = []
        total_chars = 0
        for pnum in range(min(n_pages, MAX_PDF_PAGES)):
            t = _page_text(pdf, pnum)
            if not t:
                continue
            remaining_chars = MAX_PDF_TEXT_CHARS - total_chars
            if remaining_chars <= 0:
                break
            if len(t) > remaining_chars:
                t = t[:remaining_chars]
            paras_accum.append(t)
            total_chars += len(t)
            if total_chars >= MAX_PDF_TEXT_CHARS:
                break
        full_text = "\n\n".join(paras_accum)
        paras = split_paragraphs_pdf(clean_text(full_text))
        return [
            Chapter(
                title=Path(
                    str(path)).stem,
                paragraphs=paras)] if paras else []
    finally:
        pdf.close()


def extract_pdf_metadata(path) -> dict:
    try:
        pdf = pdfium.PdfDocument(str(path))
        try:
            meta = pdf.get_metadata_dict() or {}
            return {
                "title": meta.get("Title", "") or "",
                "author": meta.get("Author", "") or "",
                "subject": meta.get("Subject", "") or "",
                "keywords": meta.get("Keywords", "") or "",
            }
        finally:
            pdf.close()
    except Exception:
        return {}


def extract_pdf_cover(path) -> Optional[bytes]:
    try:
        pdf = pdfium.PdfDocument(str(path))
        try:
            page = pdf[0]
            try:
                bitmap = page.render(scale=2.0, draw_annots=False)
                pil = bitmap.to_pil()
                if pil.mode != "RGB":
                    pil = pil.convert("RGB")
                buf = io.BytesIO()
                pil.save(buf, format="PNG")
                return buf.getvalue()
            finally:
                page.close()
        finally:
            pdf.close()
    except Exception:
        return None
