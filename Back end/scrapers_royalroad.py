import os
import re
import asyncio
from typing import List
from bs4 import BeautifulSoup
from scrapers_core import fetch, make_client, log
from scrapers_cloudflare import CloudflareBlocked
from parsers_core import Chapter, ScrapeResult, clean_text, split_paragraphs


async def scrape_royalroad(url: str, **kwargs) -> ScrapeResult:
    html = await fetch(url)
    soup = BeautifulSoup(html, "html.parser")

    title_tag = soup.find("h1", class_=re.compile(
        r"font-white|title")) or soup.find("h1")
    title = title_tag.get_text(strip=True) if title_tag else "RoyalRoad Story"

    synopsis_div = soup.find("div", class_=re.compile(
        r"description|fiction-description|summary"))
    synopsis = synopsis_div.get_text(" ", strip=True) if synopsis_div else ""

    genres = [t.get_text(strip=True)
              for t in soup.select("a.fiction-tag, .tags .label")]

    art_tag = soup.find(
        "img", class_=re.compile(r"thumbnail|cover|faction")) or soup.find(
        "div", class_=re.compile(r"fiction-cover"))
    artwork_url = None
    if art_tag:
        artwork_url = art_tag.get("src") or (
            art_tag.find("img") and art_tag.find("img").get("src"))
        if artwork_url:
            from urllib.parse import urljoin
            artwork_url = urljoin("https://www.royalroad.com", artwork_url)

    content = soup.find("div", class_=re.compile(
        r"chapter-inner|chapter-content"))
    if content:
        paras = split_paragraphs(clean_text(content.get_text("\n\n")))
        if paras:
            return ScrapeResult(
                title=title, chapters=[Chapter(title=title, paragraphs=paras)],
                synopsis=synopsis, genres=genres, artwork_url=artwork_url,
            )

    chapter_links = []
    table = soup.find("table", id="chapters")
    if table:
        for row in table.find_all("tr")[1:]:
            link = row.find("a", href=True)
            if link:
                chapter_links.append(
                    ("https://www.royalroad.com" +
                     link["href"],
                        link.get_text(
                         strip=True)))

    if not chapter_links:
        raise RuntimeError(
            "Could not find story content on RoyalRoad.\n"
            "Try pasting the URL of a specific chapter."
        )

    RR_MAX_CHAPTERS = int(os.environ.get("RR_MAX_CHAPTERS", 200))
    if len(chapter_links) > RR_MAX_CHAPTERS:
        chapter_links = chapter_links[:RR_MAX_CHAPTERS]

    chapters: List[Chapter] = []
    dropped = 0
    client = make_client()
    RR_CHAPTER_DELAY = float(os.environ.get("RR_CHAPTER_DELAY", 1.0))

    try:
        for idx, (ch_url, ch_title) in enumerate(chapter_links):
            if idx > 0:
                await asyncio.sleep(RR_CHAPTER_DELAY)
            try:
                ch_html = await fetch(ch_url, client=client)
                ch_soup = BeautifulSoup(ch_html, "html.parser")
                ch_content = ch_soup.find(
                    "div", class_=re.compile(r"chapter-inner|chapter-content"))
                if ch_content:
                    paras = split_paragraphs(
                        clean_text(ch_content.get_text("\n\n")))
                    if paras:
                        chapters.append(Chapter(title=ch_title, paragraphs=paras))
            except CloudflareBlocked:
                raise
            except Exception as e:
                dropped += 1
                log.debug("RoyalRoad chapter fetch failed (%s): %s", ch_url, e)
                continue
    finally:
        await client.aclose()

    if dropped:
        log.warning(
            "RoyalRoad: %d of %d chapters could not be fetched.",
            dropped, len(chapter_links))

    if not chapters:
        raise RuntimeError("Could not fetch any chapters from RoyalRoad.")
    return ScrapeResult(
        title=title,
        chapters=chapters,
        synopsis=synopsis,
        genres=genres,
        artwork_url=artwork_url)