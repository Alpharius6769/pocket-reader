import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from parsers_core import Chapter, sanitize_narration_chapters


class NarrationDocumentCleanupTests(unittest.TestCase):
    def test_ao3_single_chapter_front_matter_is_removed(self):
        chapters = [Chapter("Assigned_Before", [
            "Assigned Before Breakfast\nPreface\nPosted originally on the Archive of Our Own at https://archiveofourown.org/works/1",
            "Summary\nThis is the summary, not story prose.",
            "Notes\nThanks to my beta readers.",
            "Chapter 1: Assigned Before Breakfast\nAssigned Before Breakfast\nChapter 1\nAvidreader85\nThe first real sentence.",
            "The second real sentence.",
            "Chapter End Notes\nThanks for reading.",
        ])]
        cleaned = sanitize_narration_chapters(chapters, story_title="Assigned Before Breakfast", author="Avidreader85")
        self.assertEqual(len(cleaned), 1)
        self.assertEqual(cleaned[0].paragraphs, [
            "The first real sentence.",
            "The second real sentence.",
        ])

    def test_chapter_summary_and_opening_notes_are_removed_without_dropping_story(self):
        chapters = [Chapter("Chapter 2: A New Dawn", [
            "Chapter 2: A New Dawn\nChapter Summary\nA short summary.",
            "Chapter Notes\nHello readers!",
            "I wrote this chapter over the weekend and thank my beta readers.",
            "See the end of the chapter for more notes\nI woke to warmth and opened my eyes.",
            "The real story continues.",
        ])]
        cleaned = sanitize_narration_chapters(chapters)
        self.assertEqual(cleaned[0].paragraphs, [
            "I woke to warmth and opened my eyes.",
            "The real story continues.",
        ])

    def test_end_notes_truncation_requires_a_real_ao3_export(self):
        # Truncating at an "End Notes"/"Afterword" line is only meaningful in an
        # actual AO3 export. Applying it to arbitrary uploaded prose silently
        # discarded the rest of the chapter -- and because loadStoryChapters
        # writes the sanitized result back, the loss was permanent. So in a
        # document with no AO3 signature the marker is just text.
        chapters = [Chapter("Chapter 2: A New Dawn", [
            "I woke to warmth and opened my eyes.",
            "Chapter End Notes\nThanks for reading.",
            "The story keeps going after that line.",
        ])]
        cleaned = sanitize_narration_chapters(chapters)
        self.assertEqual(cleaned[0].paragraphs[0], "I woke to warmth and opened my eyes.")
        self.assertIn(
            "The story keeps going after that line.",
            cleaned[0].paragraphs,
            "a non-AO3 document must not be truncated at an end-notes marker",
        )

    def test_end_notes_truncation_applies_inside_an_ao3_export(self):
        chapters = [Chapter("Chapter 1", [
            "Posted originally on the Archive of Our Own at https://archiveofourown.org/works/1",
            "Chapter 1\nThe first real sentence.",
            "The second real sentence.",
            "Chapter End Notes\nThanks for reading.",
            "Update schedule and comments.",
        ])]
        cleaned = sanitize_narration_chapters(chapters)
        flattened = [p for chapter in cleaned for p in chapter.paragraphs]
        self.assertIn("The second real sentence.", flattened)
        self.assertNotIn("Update schedule and comments.", flattened)
        self.assertFalse(
            any("Thanks for reading." in p for p in flattened),
            "an AO3 export must still be truncated at its end-notes marker",
        )

    def test_legitimate_story_titles_and_prose_are_preserved(self):
        chapters = [Chapter("Notes from the Underground", [
            "Notes from the Underground",
            "I am a sick man. I am a spiteful man.",
        ])]
        cleaned = sanitize_narration_chapters(chapters)
        self.assertEqual(len(cleaned), 1)
        self.assertEqual(cleaned[0].title, "Notes from the Underground")
        self.assertEqual(cleaned[0].paragraphs[-1], "I am a sick man. I am a spiteful man.")


if __name__ == "__main__":
    unittest.main()
