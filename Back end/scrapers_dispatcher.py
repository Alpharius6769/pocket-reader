from typing import Optional
from parsers_core import ScrapeResult

# Site-specific imports
from scrapers_ao3 import scrape_ao3
from scrapers_royalroad import scrape_royalroad
from scrapers_wattpad import scrape_wattpad
from scrapers_furaffinity import scrape_furaffinity
from scrapers_sofurry import scrape_sofurry
from scrapers_googledocs import scrape_googledocs
from scrapers_generic import scrape_generic


def detect_site(url: str) -> str:
    lower = url.lower()
    if "archiveofourown.org" in lower or "ao3.org" in lower:
        return "ao3"
    if "royalroad.com" in lower:
        return "royalroad"
    if "wattpad.com" in lower:
        return "wattpad"
    if "furaffinity.net" in lower:
        return "furaffinity"
    if "sofurry.com" in lower:
        return "sofurry"
    if "docs.google.com/document/" in lower:
        return "googledocs"
    return "generic"


async def scrape_url(url: str, cookies: Optional[dict] = None) -> ScrapeResult:
    """Dispatch URL to the correct site-specific parser."""
    site = detect_site(url)

    fn_map = {
        "ao3": scrape_ao3,
        "royalroad": scrape_royalroad,
        "wattpad": scrape_wattpad,
        "furaffinity": scrape_furaffinity,
        "sofurry": scrape_sofurry,
        "googledocs": scrape_googledocs,
        "generic": scrape_generic
    }

    # return block
    scraper = fn_map.get(site, scrape_generic)

    extra_kwargs = {}
    if cookies:
        if site == "furaffinity" and isinstance(cookies.get("fa"), dict):
            extra_kwargs["extra_cookies"] = cookies["fa"]
        elif site == "sofurry" and isinstance(cookies.get("sofurry"), dict):
            extra_kwargs["extra_cookies"] = cookies["sofurry"]
            
    # Standard clean dispatch. All target scrapers now accept **kwargs safely.
    return await scraper(url, **extra_kwargs)