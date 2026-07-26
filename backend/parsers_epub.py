import os
import zipfile
import posixpath
from typing import List, Optional
from lxml import etree
from bs4 import BeautifulSoup
from parsers_core import (
    Chapter, clean_text, split_paragraphs, drop_front_back_matter,
    MAX_PARSED_TEXT_CHARS)

MAX_EPUB_SPINE_ITEMS = int(os.environ.get("MAX_EPUB_SPINE_ITEMS", 5000))

_CONTAINER = "META-INF/container.xml"

_NS = {
    "cnt": "urn:oasis:names:tc:opendocument:xmlns:container",
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
}


def _xml_parser():
    # EPUBs are untrusted user uploads. Disable external-entity resolution,
    # network access, and DTD loading, and reject the billion-laughs "huge
    # tree" expansion. This closes the XXE / entity-expansion surface that the
    # previous library left open by using lxml's permissive defaults.
    return etree.XMLParser(
        resolve_entities=False, no_network=True,
        load_dtd=False, dtd_validation=False, huge_tree=False)


def _opf_path(zf) -> Optional[str]:
    try:
        data = zf.read(_CONTAINER)
    except KeyError:
        return None
    root = etree.fromstring(data, _xml_parser())
    el = root.find(".//cnt:rootfiles/cnt:rootfile", _NS)
    return el.get("full-path") if el is not None else None


def _parse_opf(zf, opf_path):
    root = etree.fromstring(zf.read(opf_path), _xml_parser())
    manifest = {}
    for item in root.findall(".//opf:manifest/opf:item", _NS):
        manifest[item.get("id")] = {
            "href": item.get("href"),
            "type": (item.get("media-type") or "").lower(),
            "props": item.get("properties") or "",
        }
    spine = [it.get("idref")
             for it in root.findall(".//opf:spine/opf:itemref", _NS)
             if it.get("idref")]
    return root, manifest, spine


def _resolve(opf_path, href):
    if not href:
        return None
    base = posixpath.dirname(opf_path)
    return posixpath.normpath(posixpath.join(base, href)) if base else href


def _is_doc(entry) -> bool:
    href = (entry.get("href") or "").lower()
    return "html" in entry.get("type", "") or href.endswith(
        (".xhtml", ".html", ".htm"))


def _toc_title_map(zf, opf_path, root, manifest) -> dict:
    """Map content-file path -> chapter title using the EPUB navigation
    (EPUB3 nav document or EPUB2 NCX). This is the authoritative source of
    chapter names; guessing from the first heading in each file is only a
    fallback (it repeats the work title across front-matter pages and misses
    real chapter names). Returns {} when no usable navigation is present."""
    def _join(start_dir, href):
        h = (href or "").split("#")[0]
        if not h:
            return None
        return posixpath.normpath(posixpath.join(start_dir, h)) if start_dir else h

    # EPUB 3 — manifest item flagged properties="nav"
    nav_entry = next(
        (e for e in manifest.values()
         if "nav" in (e.get("props") or "").split()), None)
    if nav_entry:
        try:
            nav_full = _resolve(opf_path, nav_entry["href"])
            soup = BeautifulSoup(zf.read(nav_full), "html.parser")
            nav = soup.find("nav", attrs={"epub:type": "toc"}) or soup.find("nav")
            nav_dir = posixpath.dirname(nav_full)
            mapping = {}
            if nav:
                for a in nav.find_all("a", href=True):
                    title = a.get_text(" ", strip=True)
                    full = _join(nav_dir, a["href"])
                    if title and full and full not in mapping:
                        mapping[full] = title
            if mapping:
                return mapping
        except Exception:
            pass

    # EPUB 2 — NCX (spine@toc id, or manifest media-type x-dtbncx+xml)
    ncx_href = None
    spine_el = root.find(".//opf:spine", _NS)
    ncx_id = spine_el.get("toc") if spine_el is not None else None
    if ncx_id and ncx_id in manifest:
        ncx_href = manifest[ncx_id]["href"]
    if not ncx_href:
        for e in manifest.values():
            if "dtbncx" in (e.get("type") or ""):
                ncx_href = e["href"]
                break
    if ncx_href:
        try:
            ncx_full = _resolve(opf_path, ncx_href)
            ncx_root = etree.fromstring(zf.read(ncx_full), _xml_parser())
            ncx_ns = {"ncx": "http://www.daisy.org/z3986/2005/ncx/"}
            ncx_dir = posixpath.dirname(ncx_full)
            mapping = {}
            for np in ncx_root.findall(".//ncx:navPoint", ncx_ns):
                label = np.find("./ncx:navLabel/ncx:text", ncx_ns)
                content = np.find("./ncx:content", ncx_ns)
                if label is None or content is None:
                    continue
                title = (label.text or "").strip()
                full = _join(ncx_dir, content.get("src"))
                if title and full and full not in mapping:
                    mapping[full] = title
            if mapping:
                return mapping
        except Exception:
            pass
    return {}


def parse_epub(path) -> List[Chapter]:
    chapters = []
    with zipfile.ZipFile(str(path)) as zf:
        opf_path = _opf_path(zf)
        if not opf_path:
            return []
        root, manifest, spine = _parse_opf(zf, opf_path)
        names = set(zf.namelist())
        toc_titles = _toc_title_map(zf, opf_path, root, manifest)

        # Reading order: follow the spine; fall back to manifest order.
        ordered = [manifest[idref] for idref in spine
                   if idref in manifest and _is_doc(manifest[idref])]
        if not ordered:
            ordered = [e for e in manifest.values() if _is_doc(e)]
        ordered = ordered[:MAX_EPUB_SPINE_ITEMS]

        seen_documents = set()
        parsed_chars = 0
        for entry in ordered:
            full = _resolve(opf_path, entry.get("href"))
            if not full or full not in names or full in seen_documents:
                continue
            seen_documents.add(full)
            try:
                content = zf.read(full)
            except KeyError:
                continue
            soup = BeautifulSoup(content, "html.parser")
            heading = soup.find(["h1", "h2", "h3"])
            # Prefer the navigation's title; fall back to a heading, then file name.
            title = (toc_titles.get(full)
                     or (heading.get_text(strip=True) if heading else None)
                     or posixpath.basename(full))
            if heading:
                heading.decompose()
            paras = split_paragraphs(clean_text(soup.get_text("\n\n")))
            if not paras:
                continue
            parsed_chars += sum(len(paragraph) for paragraph in paras)
            if parsed_chars > MAX_PARSED_TEXT_CHARS:
                raise ValueError("This EPUB contains too much parsed text.")
            # Merge consecutive sections sharing a title (front-matter repeats,
            # or one chapter split across multiple files) so the chapter list
            # doesn't show duplicates like "Planetfall, Planetfall".
            if chapters and chapters[-1].title == title:
                chapters[-1].paragraphs.extend(paras)
            else:
                chapters.append(Chapter(title=title, paragraphs=paras))
    # Drop preface / afterword / author's-notes sections so they're never listed
    # or narrated (AO3 exports always wrap content in these).
    return drop_front_back_matter(chapters)


def extract_epub_metadata(path) -> dict:
    try:
        with zipfile.ZipFile(str(path)) as zf:
            opf_path = _opf_path(zf)
            if not opf_path:
                return {}
            root, _, _ = _parse_opf(zf, opf_path)

        def _first(tag):
            el = root.find(".//dc:" + tag, _NS)
            return (el.text or "").strip() if el is not None and el.text else ""
        return {
            "title": _first("title"),
            "author": _first("creator"),
            "language": _first("language"),
            "description": _first("description"),
            "publisher": _first("publisher"),
        }
    except Exception:
        return {}


def extract_epub_cover(path) -> Optional[bytes]:
    _IMAGE_SIGS = (b"\xff\xd8\xff", b"\x89PNG", b"GIF8", b"RIFF")
    try:
        with zipfile.ZipFile(str(path)) as zf:
            opf_path = _opf_path(zf)
            if not opf_path:
                return None
            root, manifest, _ = _parse_opf(zf, opf_path)

            cover_id = None
            # EPUB 2: <meta name="cover" content="<id>"/> (namespace-agnostic)
            for el in root.iter():
                if not isinstance(el.tag, str):
                    continue
                if etree.QName(el).localname == "meta" and \
                        (el.get("name") or "").lower() == "cover":
                    cover_id = el.get("content")
                    break
            # EPUB 3: manifest item with properties="cover-image"
            if not cover_id:
                for cid, entry in manifest.items():
                    if "cover-image" in (entry.get("props") or ""):
                        cover_id = cid
                        break

            href = manifest.get(cover_id, {}).get("href") if cover_id else None
            full = _resolve(opf_path, href)
            if full:
                try:
                    return zf.read(full)
                except KeyError:
                    pass

            # Fallback: any image whose name hints "cover"
            for name in zf.namelist():
                low = name.lower()
                if "cover" in low and low.endswith(
                        (".jpg", ".jpeg", ".png", ".gif")):
                    data = zf.read(name)
                    if any(data.startswith(sig) for sig in _IMAGE_SIGS):
                        return data
    except Exception:
        pass
    return None
