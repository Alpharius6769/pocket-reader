"""Convert an AO3 EPUB export to a readable, self-contained curated PDF."""
from __future__ import annotations

import argparse
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from bs4 import BeautifulSoup
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer


def _text(html: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    out: list[str] = []
    for node in soup.select("h1, h2, h3, h4, p, blockquote, li"):
        value = " ".join(node.get_text(" ", strip=True).split())
        if value:
            out.append(value)
    return out


def extract(epub: Path) -> tuple[str, str, list[str]]:
    with zipfile.ZipFile(epub) as zf:
        container = ET.fromstring(zf.read("META-INF/container.xml"))
        rootfile = container.find(".//{*}rootfile").attrib["full-path"]
        opf = ET.fromstring(zf.read(rootfile))
        base = Path(rootfile).parent
        metadata = opf.find("{*}metadata")
        title = next((x.text for x in metadata.findall("{*}title") if x.text), epub.stem)
        author = next((x.text for x in metadata.findall("{*}creator") if x.text), "")
        manifest = {x.attrib["id"]: x.attrib["href"] for x in opf.findall("{*}manifest/{*}item")}
        chunks: list[str] = []
        for item in opf.findall("{*}spine/{*}itemref"):
            href = manifest.get(item.attrib.get("idref"))
            if not href:
                continue
            path = (base / href).as_posix()
            if path in zf.namelist():
                chunks.extend(_text(zf.read(path).decode("utf-8", errors="replace")))
        return str(title), str(author), chunks


def convert(src: Path, dst: Path) -> None:
    title, author, lines = extract(src)
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("Title", parent=styles["Title"], alignment=TA_CENTER, spaceAfter=18)
    author_style = ParagraphStyle("Author", parent=styles["Normal"], alignment=TA_CENTER, spaceAfter=24)
    body = ParagraphStyle("Story", parent=styles["BodyText"], leading=14, spaceAfter=8)
    heading = ParagraphStyle("Heading", parent=styles["Heading2"], spaceBefore=16, spaceAfter=10, keepWithNext=True)
    story = [Paragraph(title, title_style)]
    if author:
        story.append(Paragraph(author, author_style))
    for line in lines:
        safe = line.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        if re.match(r"^(chapter|prologue|epilogue)\b", line, re.I):
            story.append(Paragraph(safe, heading))
        else:
            story.append(Paragraph(safe, body))
    dst.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(str(dst), pagesize=LETTER, rightMargin=.75 * inch, leftMargin=.75 * inch,
                            topMargin=.7 * inch, bottomMargin=.7 * inch, title=title, author=author)
    doc.build(story)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    convert(args.source, args.destination)
