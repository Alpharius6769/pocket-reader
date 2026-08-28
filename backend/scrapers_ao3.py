import re
import httpx
from typing import Optional
from bs4 import BeautifulSoup
from scrapers_core import fetch
from scrapers_cloudflare import CloudflareBlocked
from parsers_core import Chapter, ScrapeResult


def _with_query_flag(url: str, flag: str) -> str:
    if flag in url:
        return url
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}{flag}"


def _ensure_ao3_full_work(url: str) -> str:
    """Ensure multi-chapter AO3 works return all chapters, and rated works skip
    the adult-content interstitial. Without view_adult=true, Mature/Explicit
    works return a consent page with no chapter text, which surfaced as
    'No readable chapters found' on otherwise valid works."""
    if "/works/" in url:
        if "/chapters/" not in url:
            url = _with_query_flag(url, "view_full_work=true")
        url = _with_query_flag(url, "view_adult=true")
    return url


def _find_chapters_dd(soup):
    """Locate the 'Chapters: X/Y' stat.

    The scoped selector is tried first because it is unambiguous, but it cannot
    be the only one: the HTML that actually reaches us through the Zyte proxy is
    a reduced render with no `dl.work.meta.group` wrapper at all — the stats list
    sits in a bare `<dl>` whose only classed descendant is `dl.stats`. That made
    this return None for EVERY work, so the client never got an authoritative
    count, never took the fast "no new chapters" path, and fell through to a full
    re-scrape of the whole story on every update check.

    The value is still validated by the caller's regex and range clamp, so
    widening the search cannot let malformed markup through.
    """
    return (
        soup.select_one("dl.work.meta.group dd.chapters")
        or soup.select_one("dl.stats dd.chapters")
        or soup.select_one("dd.chapters")
    )


def parse_published_chapter_count(html: str) -> Optional[int]:
    """Parse the published chapter count from AO3 work HTML — the 'X' in the
    'Chapters: X/Y' work stat. Returns None when the stat isn't present."""
    try:
        soup = BeautifulSoup(html, "html.parser")
        dd = _find_chapters_dd(soup)
        if not dd:
            return None
        m = re.match(r"^\s*(\d+)\s*/", dd.get_text(strip=True))
        if not m:
            return None
        n = int(m.group(1))
        # Sanity clamp: a count of 0 or an absurdly large value is almost
        # certainly malformed/hostile HTML, not a real work. Reject it so it
        # can't drive client-side merge/slice decisions.
        if n < 1 or n > 5000:
            return None
        return n
    except Exception:
        return None


def parse_ao3_chapter_info(html: str) -> tuple[Optional[int], Optional[int]]:
    """Return AO3's published and declared chapter counts from Chapters: X/Y."""
    try:
        soup = BeautifulSoup(html, "html.parser")
        dd = _find_chapters_dd(soup)
        if not dd:
            return None, None
        match = re.match(r"^\s*(\d+)\s*/\s*(\d+|\?)", dd.get_text(strip=True))
        if not match:
            return None, None
        published = int(match.group(1))
        if published < 1 or published > 5000:
            return None, None
        total_raw = match.group(2)
        declared_total = int(total_raw) if total_raw.isdigit() else None
        if declared_total is not None and (declared_total < published or declared_total > 5000):
            declared_total = None
        return published, declared_total
    except Exception:
        return None, None


async def ao3_published_chapter_count(
        url: str, client: Optional[httpx.AsyncClient] = None) -> Optional[int]:
    """Lightweight fetch to parse published chapter count."""
    try:
        # Rated works serve the adult-content interstitial without this flag,
        # and the interstitial carries no Chapters: X/Y work stat.
        if "/works/" in url:
            url = _with_query_flag(url, "view_adult=true")
        html = await fetch(url, client=client, timeout=15)
        return parse_published_chapter_count(html)
    except CloudflareBlocked:
        raise
    except Exception:
        return None


async def scrape_ao3(url: str) -> ScrapeResult:
    url = _ensure_ao3_full_work(url)
    html = await fetch(url)
    soup = BeautifulSoup(html, "html.parser")

    if "Terms of Service" in soup.get_text() and not soup.find("div",
                                                               class_="userstuff"):
        from scrapers_cloudflare import CloudflareBlocked
        raise CloudflareBlocked(url, "TOS gate")

    # Find chapter content divs, carefully avoiding summary/notes which also use .userstuff
    content_divs = soup.select("div.userstuff[role='article']")
    if not content_divs:
        # Fallback: get all userstuff divs but exclude those inside preface/notes/summaries
        all_userstuff = soup.find_all("div", class_="userstuff")
        content_divs = [d for d in all_userstuff if not d.find_parent(class_=["preface", "notes", "summary"])]

    if not content_divs:
        raise RuntimeError("No story content found. The parser is blind.")

    title_tag = soup.select_one(
        "h2.title.heading") or soup.find("h2", class_="title")
    title = title_tag.get_text(strip=True) if title_tag else "AO3 Story"

    author_tags = soup.select("h3.byline.heading a[rel='author'], h3.byline a")
    author = ", ".join(a.get_text(strip=True)
                       for a in author_tags) if author_tags else ""

    fandoms = [a.get_text(strip=True)
               for a in soup.select("dd.fandom.tags a.tag")]
    additional_tags = [a.get_text(strip=True) for a in soup.select(
        "dd.freeform.tags a.tag, dd.character.tags a.tag, dd.relationship.tags a.tag"
    )]
    genres = [a.get_text(strip=True)
              for a in soup.select("dd.category.tags a.tag")]

    rating_tag = soup.select_one("dd.rating.tags a.tag")
    content_rating = rating_tag.get_text(strip=True) if rating_tag else ""

    summary_div = soup.select_one(
        ".preface .summary .userstuff, .summary blockquote.userstuff")
    synopsis = summary_div.get_text(" ", strip=True) if summary_div else ""

    artwork_url = None
    for sel in (
        ".preface .summary .userstuff img",
        ".preface .notes .userstuff img",
            ".preface img"):
        img = soup.select_one(sel)
        if img and img.get("src"):
            src = img["src"]
            artwork_url = "https:" + src if src.startswith("//") else src
            if artwork_url.startswith("/"):
                artwork_url = "https://archiveofourown.org" + artwork_url
            break

    chapters = []
    chapter_titles = [t.get_text(strip=True)
                      for t in soup.select("#chapters .chapter h3.title")]
    for i, div in enumerate(content_divs):
        paras = [
            p.get_text(
                strip=True) for p in div.find_all("p") if len(
                p.get_text(
                    strip=True)) > 5]
        if not paras:
            continue
        ch_title = chapter_titles[i] if i < len(
            chapter_titles) else f"Chapter {i + 1}"
        chapters.append(Chapter(title=ch_title, paragraphs=paras))

    if not chapters:
        raise RuntimeError("No readable chapters found.")

    return ScrapeResult(
        title=title, chapters=chapters, synopsis=synopsis, genres=genres,
        author=author, fandoms=fandoms, additional_tags=additional_tags,
        content_rating=content_rating, artwork_url=artwork_url
    )
