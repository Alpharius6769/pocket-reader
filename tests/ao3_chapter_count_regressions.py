import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from scrapers_ao3 import parse_ao3_chapter_info, parse_published_chapter_count


# The shape Zyte actually returns: no `dl.work.meta.group` wrapper anywhere, the
# stats sitting in a bare <dl> whose inner list is `dl.stats`, and the current
# chapter number wrapped in an <a>. The old scoped-only selector matched nothing
# here, so every work returned count=None — the client never got an
# authoritative count, never took the fast "no new chapters" path, and fell
# through to a full re-scrape of the entire story on every update check.
ZYTE_SHAPE = """
<dl>
  <dd class="stats">
    <dl class="stats">
      <dt class="words">Words:</dt><dd class="words">42,951</dd>
      <dt class="chapters">Chapters:</dt>
      <dd class="chapters"><a href="/works/76351491/chapters/221790486">3</a>/?</dd>
    </dl>
  </dd>
</dl>
"""

# The full work page, which the scoped selector was written for. Must keep working.
CANONICAL_SHAPE = """
<dl class="work meta group">
  <dd class="stats">
    <dl class="stats">
      <dt class="chapters">Chapters:</dt>
      <dd class="chapters"><a href="/works/1/chapters/2">7</a>/12</dd>
    </dl>
  </dd>
</dl>
"""


class Ao3ChapterCountTests(unittest.TestCase):
    def test_reduced_proxy_html_yields_a_count(self):
        self.assertEqual(parse_ao3_chapter_info(ZYTE_SHAPE), (3, None))
        self.assertEqual(parse_published_chapter_count(ZYTE_SHAPE), 3)

    def test_canonical_work_page_still_parses(self):
        self.assertEqual(parse_ao3_chapter_info(CANONICAL_SHAPE), (7, 12))
        self.assertEqual(parse_published_chapter_count(CANONICAL_SHAPE), 7)

    def test_completed_work_reports_its_declared_total(self):
        html = '<dl class="stats"><dd class="chapters">5/5</dd></dl>'
        self.assertEqual(parse_ao3_chapter_info(html), (5, 5))

    def test_chapter_number_inside_an_anchor_is_not_lost(self):
        # A multi-chapter work links the current chapter; a single-chapter work
        # does not. Only multi-chapter works can ever gain a chapter, so losing
        # the anchored form meant failing on exactly the works that update.
        html = '<dd class="chapters"><a href="/works/1/chapters/2">19</a>/?</dd>'
        self.assertEqual(parse_ao3_chapter_info(html), (19, None))

    def test_widened_search_still_rejects_malformed_values(self):
        # Relaxing the selector must not relax validation.
        for html in [
            "",
            "<html><body>no stats here</body></html>",
            '<dd class="chapters">0/5</dd>',        # a work has at least one chapter
            '<dd class="chapters">99999/1</dd>',    # absurd count
            '<dd class="chapters">not a number</dd>',
        ]:
            self.assertEqual(parse_ao3_chapter_info(html), (None, None), html[:40])
            self.assertIsNone(parse_published_chapter_count(html), html[:40])

    def test_declared_total_below_published_is_discarded(self):
        # "4/2" is incoherent; the published count survives, the total does not.
        published, declared = parse_ao3_chapter_info('<dd class="chapters">4/2</dd>')
        self.assertEqual(published, 4)
        self.assertIsNone(declared)


if __name__ == "__main__":
    unittest.main()
