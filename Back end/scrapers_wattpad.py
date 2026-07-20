import re
from bs4 import BeautifulSoup
from scrapers_core import fetch, make_client, log
from parsers_core import Chapter, ScrapeResult, clean_text, split_paragraphs


async def scrape_wattpad(url: str, **kwargs) -> ScrapeResult:
    part_match = re.search(r"wattpad\.com/(\d+)", url)

    if part_match:
        part_id = part_match.group(1)
        try:
            async with make_client() as client:
                resp = await client.get(
                    f"https://www.wattpad.com/apiv2/storytext?id={part_id}",
                    timeout=20)
                if resp.ok and resp.text.strip():
                    paras = split_paragraphs(
                        clean_text(
                            BeautifulSoup(
                                resp.text,
                                "html.parser").get_text("\n\n")))
                    if paras:
                        title, synopsis, genres, artwork_url, meta = "Wattpad Story", "", [], None, {}
                        try:
                            meta_resp = await client.get(
                                f"https://www.wattpad.com/api/v3/story_parts/{part_id}?fields=title,group(title,description,categories,cover)",
                                timeout=10,
                            )
                            meta = meta_resp.json()
                            g = meta.get("group", {})
                            title = g.get("title", title)
                            synopsis = g.get("description", "")
                            genres = [
                                c.get(
                                    "name",
                                    "") for c in g.get(
                                    "categories",
                                    []) if c.get("name")]
                            artwork_url = g.get("cover")
                        except Exception:
                            pass
                        return ScrapeResult(
                            title=title,
                            chapters=[
                                Chapter(
                                    title=meta.get(
                                        "title",
                                        "Chapter"),
                                    paragraphs=paras)],
                            synopsis=synopsis,
                            genres=genres,
                            artwork_url=artwork_url,
                        )
        except Exception as e:
            log.debug("Wattpad API path failed, falling back to HTML scrape: %s", e)

    soup = BeautifulSoup(await fetch(url), "html.parser")
    og_title = soup.find("meta", {"property": "og:title"})
    og_img = soup.find("meta", {"property": "og:image"})
    og_desc = soup.find("meta", {"property": "og:description"})
    title = og_title.get(
        "content",
        "Wattpad Story") if og_title else "Wattpad Story"
    artwork_url = og_img.get("content") if og_img else None
    synopsis = og_desc.get("content", "") if og_desc else ""

    content = soup.find("pre",
                        class_="part-content") or soup.find("div",
                                                            class_=re.compile(r"story-part|part-content"))
    if content:
        paras = split_paragraphs(clean_text(content.get_text("\n\n")))
        if paras:
            return ScrapeResult(
                title=title, chapters=[Chapter(title=title, paragraphs=paras)],
                synopsis=synopsis, artwork_url=artwork_url,
            )

    raise RuntimeError(
        "Could not extract Wattpad content.\n"
        "Wattpad uses JavaScript rendering. Download the story as EPUB from Wattpad and open that file instead."
    )