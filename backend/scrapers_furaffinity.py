import re
from typing import Optional
from bs4 import BeautifulSoup
from scrapers_core import fetch
from parsers_core import Chapter, ScrapeResult, clean_text, split_paragraphs


async def scrape_furaffinity(
        url: str,
        extra_cookies: Optional[dict] = None) -> ScrapeResult:
    html = await fetch(url, extra_cookies=extra_cookies)
    if "You must be logged in" in html or "Log in to FurAffinity" in html or 'class="login-container"' in html:
        raise RuntimeError(
            "FurAffinity requires login for this content.\n"
            "Log in, download the story file, and open it directly."
        )

    soup = BeautifulSoup(html, "html.parser")

    title_tag = soup.find("div",
                          class_="submission-title") or soup.find("h2",
                                                                  class_=re.compile(r"submission|title"))
    title = (title_tag.find("p") or title_tag).get_text(
        strip=True) if title_tag else "FurAffinity Story"

    genres = [t.get_text(strip=True) for t in soup.select(
        "section.tags-row span.tag, .submission-tag-list span")]

    art_tag = soup.find(
        "img", id="submissionImg") or soup.find(
        "img", class_=re.compile(r"submission"))
    artwork_url = None
    if art_tag:
        src = art_tag.get("src", "")
        if src:
            artwork_url = ("https:" + src) if src.startswith("//") else src

    content = soup.find("div", class_="submission-description")
    if not content:
        raise RuntimeError(
            "Could not find story text on this FurAffinity page.")

    paras = split_paragraphs(clean_text(content.get_text("\n\n")))
    if not paras:
        raise RuntimeError("The submission appears to be empty or image-only.")

    return ScrapeResult(
        title=title,
        chapters=[
            Chapter(
                title=title,
                paragraphs=paras)],
        genres=genres,
        artwork_url=artwork_url)
