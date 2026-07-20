import re
from typing import Optional
from bs4 import BeautifulSoup
from scrapers_core import fetch
from parsers_core import Chapter, ScrapeResult, clean_text, split_paragraphs


async def scrape_sofurry(
        url: str,
        extra_cookies: Optional[dict] = None) -> ScrapeResult:
    html = await fetch(url, extra_cookies=extra_cookies)
    soup = BeautifulSoup(html, "html.parser")

    og_title = soup.find("meta", {"property": "og:title"})
    og_img = soup.find("meta", {"property": "og:image"})
    og_desc = soup.find("meta", {"property": "og:description"})
    title_tag = soup.find("h1", class_=re.compile(
        r"title|heading")) or soup.find("h1")

    title = og_title.get("content") if og_title else (
        title_tag.get_text(strip=True) if title_tag else "SoFurry Story")
    if not title:
        title = title_tag.get_text(
            strip=True) if title_tag else "SoFurry Story"
    synopsis = og_desc.get("content", "") if og_desc else ""
    artwork_url = og_img.get("content") if og_img else None

    genres = [t.get_text(strip=True)
              for t in soup.select(".tag, .story-tag, .tag-list a")]

    content = (
        soup.find(
            "div",
            class_=re.compile(
                r"story\.text|sfContentBody|submission\.text|story-body",
                re.I)) or soup.find(
            "div",
            id=re.compile(
                r"sfContent|storyBody",
                re.I)))
    if not content:
        raise RuntimeError(
            "Could not find story text on SoFurry. The story may require login.")

    paras = split_paragraphs(clean_text(content.get_text("\n\n")))
    if not paras:
        raise RuntimeError("Story appears empty or requires login.")

    return ScrapeResult(
        title=title, chapters=[Chapter(title=title, paragraphs=paras)],
        synopsis=synopsis, genres=genres, artwork_url=artwork_url
    )
