"""AO3 search filters, search result details, and chapters in text files.

Found 2026-11-27 on the live site:

* Choosing a rating in the search filters returned no works at all. The app
  sent AO3 the rating's name ("General"); AO3's form wants its numeric id.
* A search result had no description, rating or kudos: the page lists them and
  the parser never read them.
* A pasted AO3 search link lost its own sort order and language to the request
  model's defaults.
* A plain-text story was always one chapter, its "Chapter 2" lines read aloud.
"""
import asyncio
import os
import pathlib
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, urlparse

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from parsers_document import parse_txt, split_txt_chapters, _is_txt_heading  # noqa: E402

try:  # The API module needs the full backend environment.
    import app as backend_app  # noqa: E402
except Exception as exc:  # pragma: no cover - reported by the skip below
    backend_app = None
    IMPORT_ERROR = exc


BLURB = """
<html><body>
<h3 class="heading">1,234 Found</h3>
<ol class="work index group">
  <li class="work blurb group" id="work_77">
    <div class="header module">
      <h4 class="heading"><a href="/works/77">A Quiet Morning</a> by <a rel="author" href="/users/ilse">Ilse</a></h4>
      <h5 class="fandoms heading"><a class="tag" href="#">Original Work</a></h5>
      <ul class="required-tags">
        <li><a class="help symbol"><span class="rating-general-audience rating" title="General Audiences"><span class="text">General Audiences</span></span></a></li>
      </ul>
      <p class="datetime">27 Nov 2026</p>
    </div>
    <ul class="tags commas"><li><a class="tag" href="#">Fluff</a></li></ul>
    <blockquote class="userstuff summary"><p>She made <em>very</em> good tea.</p><p>He did not.</p></blockquote>
    <dl class="stats">
      <dd class="words">2,322</dd><dd class="chapters">1/1</dd><dd class="kudos"><a href="#">1,005</a></dd>
    </dl>
  </li>
</ol>
<ol class="pagination"><li class="next"><a href="?page=2">Next</a></li></ol>
</body></html>
"""


@unittest.skipIf(backend_app is None, "backend environment not installed")
class Ao3Search(unittest.TestCase):
    def search(self, **fields):
        """Run the search route against a canned AO3 page; return (response, urls asked for)."""
        asked = []

        async def fake_fetch(url, timeout=45):
            asked.append(url)
            return BLURB

        class NoCache:
            async def get(self, key):
                return None

            async def put(self, key, value, ttl_seconds=None):
                return None

        saved = (backend_app.proxy_fetch, backend_app.SEARCH_CACHE, backend_app._require_scrape_budget)
        backend_app.proxy_fetch = fake_fetch
        backend_app.SEARCH_CACHE = NoCache()
        backend_app._require_scrape_budget = lambda *a, **k: None
        try:
            request = backend_app.SearchRequest(**fields)
            out = asyncio.run(backend_app.search_ao3(request, None))
        finally:
            backend_app.proxy_fetch, backend_app.SEARCH_CACHE, backend_app._require_scrape_budget = saved
        return out, [parse_qs(urlparse(u).query) for u in asked]

    def test_rating_and_category_are_sent_as_the_ids_ao3_understands(self):
        _, (query,) = self.search(query="cozy", rating="General", category="F/M", language="en")
        self.assertEqual(query["work_search[rating_ids]"], ["10"])
        self.assertEqual(query["work_search[category_ids][]"], ["22"])
        for name, wanted in (("Teen", "11"), ("Mature", "12"), ("Explicit", "13"), ("Not Rated", "9")):
            _, (q,) = self.search(query="cozy", rating=name)
            self.assertEqual(q["work_search[rating_ids]"], [wanted], name)

    def test_any_rating_sends_no_rating_filter(self):
        _, (query,) = self.search(query="cozy", rating="Any", language="Any")
        self.assertNotIn("work_search[rating_ids]", query)
        self.assertNotIn("work_search[language_id]", query)

    def test_complete_only_uses_ao3s_own_value(self):
        _, (query,) = self.search(query="cozy", complete="1", words_max=10000)
        self.assertEqual(query["work_search[complete]"], ["T"])
        self.assertEqual(query["work_search[words_to]"], ["10000"])

    def test_results_carry_summary_rating_kudos_and_the_total(self):
        out, _ = self.search(query="cozy")
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["total"], 1234)
        self.assertTrue(out["has_more"])
        (work,) = out["results"]
        self.assertEqual(work["title"], "A Quiet Morning")
        self.assertEqual(work["rating"], "General")
        self.assertEqual(work["kudos"], "1,005")
        # Inline markup stays inside its sentence; paragraphs stay apart.
        self.assertEqual(work["summary"], "She made very good tea.\n\nHe did not.")

    def test_a_pasted_search_link_keeps_its_own_sort_and_language(self):
        link = ("https://archiveofourown.org/works/search?work_search%5Bquery%5D=cozy"
                "&work_search%5Bsort_column%5D=kudos_count&work_search%5Blanguage_id%5D=fr")
        # What the app sends for a pasted link: the link, a page and a limit.
        _, (query,) = self.search(query=link, page=1, limit=15)
        self.assertEqual(query["work_search[sort_column]"], ["kudos_count"])
        self.assertEqual(query["work_search[language_id]"], ["fr"])
        self.assertEqual(query["work_search[query]"], ["cozy"])


class TextFileChapters(unittest.TestCase):
    def parse(self, text, name="my_story.txt"):
        folder = tempfile.mkdtemp()
        path = os.path.join(folder, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        return parse_txt(path)

    def test_heading_lines_start_chapters_and_are_not_read_as_text(self):
        chapters = self.parse(
            "The Ledger\nby A. Writer\n\nChapter 1: Arrival\n\nThe ferry left at dawn.\n\n"
            "\"You're late,\" said the keeper.\n\nChapter 2: The Ledger\n\nIt was older than the lighthouse.\n\n"
            "Epilogue\n\nThe end.\n")
        self.assertEqual([c.title for c in chapters], ["Chapter 1: Arrival", "Chapter 2: The Ledger", "Epilogue"])
        # A title and byline above the first heading open the first chapter.
        self.assertEqual(chapters[0].paragraphs[0], "The Ledger\nby A. Writer")
        self.assertEqual(chapters[0].paragraphs[1:], ["The ferry left at dawn.", "\"You're late,\" said the keeper."])
        self.assertEqual(chapters[1].paragraphs, ["It was older than the lighthouse."])
        for chapter in chapters:
            self.assertFalse(any(_is_txt_heading(p) for p in chapter.paragraphs))

    def test_a_story_that_only_mentions_a_chapter_is_left_whole(self):
        chapters = self.parse("One.\n\nChapter one was dull.\n\nPart of me wanted to leave.\n\nTwo.", "plain.txt")
        self.assertEqual(len(chapters), 1)
        self.assertEqual(len(chapters[0].paragraphs), 4)
        # One heading is not enough to split on either.
        self.assertEqual(len(self.parse("Chapter 1\n\nOnly this.\n\nAnd this.")), 1)

    def test_a_real_foreword_is_its_own_chapter(self):
        foreword = " ".join(["word"] * 60)
        chapters = split_txt_chapters([foreword, "Chapter 1", "a", "Chapter 2", "b"], "story")
        self.assertEqual([c.title for c in chapters], ["Beginning", "Chapter 1", "Chapter 2"])

    def test_what_counts_as_a_heading(self):
        for line in ("Chapter 12", "CHAPTER TWO: The Ledger", "Part III", "Prologue", "Book One", "Act I",
                     "Interlude: Rain", "Chapter Twenty-One", "Chapter 3."):
            self.assertTrue(_is_txt_heading(line), line)
        for line in ("Part of me wanted to leave.", "Chapter one was dull.", "Part of me", "The end.",
                     "Chapter 1 began, as these things do, with a very long sentence that is plainly a paragraph of prose."):
            self.assertFalse(_is_txt_heading(line), line)

    def test_a_byte_order_mark_is_not_part_of_the_first_word(self):
        chapters = self.parse("﻿Hello there.\n\nSecond.")
        self.assertEqual(chapters[0].paragraphs[0], "Hello there.")


if __name__ == "__main__":
    unittest.main()
