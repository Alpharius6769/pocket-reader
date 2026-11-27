"""Story text must reach the narrator as the author wrote it.

Found 2026-11-26: every HTML-to-text path treated a text NODE as a paragraph or
as a word boundary, and a sentence is several text nodes as soon as it holds one
inline tag. EPUB and four site scrapers split "the <em>very</em> big dog" into
three paragraphs; the AO3 scraper glued it into "theverybig dog". The AO3
scraper also took the site's admin banner as Chapter 1 of single-chapter works.
"""
import os
import pathlib
import sys
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from bs4 import BeautifulSoup  # noqa: E402

from parsers_core import html_paragraphs  # noqa: E402
from parsers_document import parse_html_string  # noqa: E402
from parsers_epub import parse_epub  # noqa: E402
from scrapers_ao3 import _collect_ao3_chapters, _story_body_divs  # noqa: E402


def paragraphs(html):
    return html_paragraphs(BeautifulSoup(html, "html.parser"))


class HtmlParagraphs(unittest.TestCase):
    def test_inline_formatting_stays_inside_its_sentence(self):
        self.assertEqual(
            paragraphs("<p>She looked at the <em>very</em> big dog and <strong>ran</strong>.</p>"),
            ["She looked at the very big dog and ran."],
        )

    def test_links_and_spans_do_not_break_or_glue(self):
        self.assertEqual(
            paragraphs('<p>See <a href="#">the map</a><span>,</span> then go.</p>'),
            ["See the map, then go."],
        )

    def test_block_elements_and_line_breaks_end_a_paragraph(self):
        self.assertEqual(
            paragraphs('<div><p>One.</p><p>"Two."<br/>&gt;Three.<br>&gt;Four.</p>Bare text.<div>Nested.</div></div>'),
            ["One.", '"Two."', ">Three.", ">Four.", "Bare text.", "Nested."],
        )

    def test_source_newlines_are_spaces_not_breaks(self):
        self.assertEqual(paragraphs("<p>A line\n   wrapped in\n the source.</p>"), ["A line wrapped in the source."])

    def test_short_dialogue_is_kept(self):
        self.assertEqual(paragraphs("<p>No.</p><p>Okay.</p><p>I</p>"), ["No.", "Okay.", "I"])

    def test_scripts_styles_and_comments_are_not_prose(self):
        self.assertEqual(
            paragraphs("<div><script>var a = 1;</script><style>p{}</style><!-- note --><p>Prose.</p></div>"),
            ["Prose."],
        )

    def test_a_cap_stops_extraction(self):
        soup = BeautifulSoup("<p>" + "a" * 50 + "</p><p>" + "b" * 50 + "</p><p>ccc</p>", "html.parser")
        out = html_paragraphs(soup, max_chars=60)
        self.assertEqual(sum(len(p) for p in out), 60)
        self.assertEqual(len(out), 2)


AO3_SINGLE = """
<html><body><div id="outer">
<div class="alert announcement group" id="admin-banner"><div class="userstuff">
  <p>The Archive is back. <strong>No data has been deleted.</strong></p></div></div>
<div id="workskin">
  <div class="preface group"><h2 class="title heading">A Work</h2>
    <div class="summary module"><blockquote class="userstuff"><p>The summary.</p></blockquote></div></div>
  <div id="chapters" role="article"><h3 class="landmark heading" id="work">Work Text:</h3>
    <div class="userstuff"><p>"Hello," she said.<br/>&gt;You step into the <em>hallway</em>.<br/>&gt;She laughs.</p>
      <p>No.</p><p>* * *</p><p>The end.</p></div></div>
</div></div></body></html>
"""

AO3_MULTI = """
<div id="outer"><div class="alert announcement group" id="admin-banner"><div class="userstuff"><p>Site notice.</p></div></div>
<div id="workskin"><div id="chapters">
  <div class="chapter" id="chapter-1"><div class="chapter preface group"><h3 class="title"><a>Chapter 1</a>: Start</h3>
      <div class="notes module"><blockquote class="userstuff"><p>An author's note.</p></blockquote></div></div>
    <div class="userstuff module" role="article"><h3 class="landmark heading" id="work">Chapter Text</h3>
      <p>One <i>two</i> three.</p></div></div>
  <div class="chapter" id="chapter-2"><div class="chapter preface group"><h3 class="title"><a>Chapter 2</a></h3></div>
    <div class="userstuff module" role="article"><h3 class="landmark heading">Chapter Text</h3>Line a<br><br>Line b</div></div>
</div></div></div>
"""


def ao3_chapters(html):
    soup = BeautifulSoup(html, "html.parser")
    return _collect_ao3_chapters(soup, _story_body_divs(soup))


class Ao3Scraper(unittest.TestCase):
    def test_site_banner_is_not_a_chapter_of_a_single_chapter_work(self):
        chapters = ao3_chapters(AO3_SINGLE)
        self.assertEqual(len(chapters), 1)
        joined = " ".join(chapters[0].paragraphs)
        self.assertNotIn("Archive is back", joined)
        self.assertNotIn("The summary", joined)

    def test_single_chapter_text_keeps_words_apart_and_lines_separate(self):
        self.assertEqual(
            ao3_chapters(AO3_SINGLE)[0].paragraphs,
            ['"Hello," she said.', ">You step into the hallway.", ">She laughs.", "No.", "The end."],
        )

    def test_multi_chapter_work_keeps_titles_bodies_and_drops_landmarks(self):
        chapters = ao3_chapters(AO3_MULTI)
        self.assertEqual([c.title for c in chapters], ["Chapter 1: Start", "Chapter 2"])
        self.assertEqual(chapters[0].paragraphs, ["One two three."])
        # A body with no <p> at all used to come back empty.
        self.assertEqual(chapters[1].paragraphs, ["Line a", "Line b"])


class OtherParsers(unittest.TestCase):
    def test_epub_paragraphs_survive_inline_formatting(self):
        path = os.path.join(tempfile.mkdtemp(), "t.epub")
        with zipfile.ZipFile(path, "w") as z:
            z.writestr("mimetype", "application/epub+zip")
            z.writestr("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="c.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
            z.writestr("c.opf", '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>')
            z.writestr("a.xhtml", "<html><head><title>T</title></head><body><h2>Chapter 1</h2><p>She looked at the <em>very</em> big dog and <strong>ran</strong>.</p><p>Second paragraph.</p></body></html>")
        chapters = parse_epub(path)
        self.assertEqual(len(chapters), 1)
        self.assertEqual(chapters[0].paragraphs, ["She looked at the very big dog and ran.", "Second paragraph."])

    def test_html_upload_paragraphs_survive_inline_formatting(self):
        chapters = parse_html_string("<html><body><main><p>A <b>bold</b> claim.</p><p>Next.</p></main></body></html>")
        self.assertEqual(chapters[0].paragraphs, ["A bold claim.", "Next."])

    def test_no_scraper_goes_back_to_per_node_text(self):
        backend = ROOT / "backend"
        for name in ("parsers_epub.py", "parsers_document.py", "scrapers_royalroad.py",
                     "scrapers_sofurry.py", "scrapers_furaffinity.py", "scrapers_wattpad.py",
                     "scrapers_ao3.py"):
            source = (backend / name).read_text(encoding="utf-8")
            self.assertNotIn('get_text("\\n\\n")', source, name)
            self.assertNotIn("p.get_text(strip=True) for p in", source, name)


class ScrapeCache(unittest.TestCase):
    def test_requests_carrying_cookies_do_not_share_the_cache(self):
        source = (ROOT / "backend" / "app.py").read_text(encoding="utf-8")
        self.assertIn("cacheable = not cookies", source)
        self.assertRegex(source, r"if cacheable:\s+cached = await SCRAPE_CACHE\.get\(cache_key\)")
        self.assertRegex(source, r"if cacheable:\s+await SCRAPE_CACHE\.put\(cache_key, payload\)")


if __name__ == "__main__":
    unittest.main()
