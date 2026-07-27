from typing import Optional
from urllib.parse import urlparse
from parsers_core import ScrapeResult

# Site-specific imports
from scrapers_ao3 import scrape_ao3
from scrapers_royalroad import scrape_royalroad
from scrapers_wattpad import scrape_wattpad
from scrapers_furaffinity import scrape_furaffinity
from scrapers_sofurry import scrape_sofurry
from scrapers_googledocs import scrape_googledocs
from scrapers_generic import scrape_generic


def _hostname_matches(hostname: str, domain: str) -> bool:
    return hostname == domain or hostname.endswith("." + domain)


def detect_site(url: str) -> str:
    try:
        parsed = urlparse(url or "")
        host = (parsed.hostname or "").lower().rstrip(".")
        path = parsed.path or ""
    except Exception:
        return "generic"

    if _hostname_matches(host, "archiveofourown.org") or _hostname_matches(host, "ao3.org"):
        return "ao3"
    if _hostname_matches(host, "royalroad.com"):
        return "royalroad"
    if _hostname_matches(host, "wattpad.com"):
        return "wattpad"
    if _hostname_matches(host, "furaffinity.net"):
        return "furaffinity"
    if _hostname_matches(host, "sofurry.com"):
        return "sofurry"
    if _hostname_matches(host, "docs.google.com") and path.startswith("/document/"):
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