from bs4 import BeautifulSoup
from scrapers_core import fetch
from parsers_core import ScrapeResult
from parsers_document import parse_html_string


async def scrape_generic(url: str, **kwargs) -> ScrapeResult:
    html = await fetch(url)
    soup = BeautifulSoup(html, "html.parser")
    og_img = soup.find("meta", {"property": "og:image"})
    artwork_url = og_img.get("content") if og_img else None

    chapters = parse_html_string(html, default_title=url)
    if not chapters or not chapters[0].paragraphs:
        raise RuntimeError("Could not extract readable text from this URL.")

    return ScrapeResult(
        title=chapters[0].title,
        chapters=chapters,
        artwork_url=artwork_url)