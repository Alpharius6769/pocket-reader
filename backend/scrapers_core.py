import os
import socket
import asyncio
import ipaddress
import logging
import time
import httpx
from contextlib import asynccontextmanager
from typing import Optional, Iterable
from urllib.parse import urlparse, urljoin

from scrapers_cloudflare import detect_cloudflare, CloudflareBlocked

log = logging.getLogger("pocket-reader.scrapers")

# ── AO3 politeness gate ───────────────────────────────────────────────────────
# Every app user's AO3 traffic egresses from this backend's IP (or the CF
# worker's), so AO3 sees ALL users as one client. Two protections:
#   1. A global semaphore serializes AO3-bound requests (default 2 in flight)
#      so a burst of users can't stampede AO3 into rate-limiting the shared IP.
#   2. A 429-streak breaker: after AO3_429_STREAK_THRESHOLD consecutive 429s,
#      AO3 fetches route through Zyte (rotating IPs) for AO3_ZYTE_COOLDOWN_SEC.
AO3_MAX_CONCURRENCY = max(1, int(os.environ.get("AO3_MAX_CONCURRENCY", 2)))
AO3_429_STREAK_THRESHOLD = max(1, int(os.environ.get("AO3_429_STREAK_THRESHOLD", 3)))
AO3_ZYTE_COOLDOWN_SEC = max(30, int(os.environ.get("AO3_ZYTE_COOLDOWN_SEC", 600)))

_ao3_semaphore = asyncio.Semaphore(AO3_MAX_CONCURRENCY)
_ao3_429_streak = 0
_ao3_zyte_until = 0.0


def is_ao3_url(url: Optional[str]) -> bool:
    try:
        host = (urlparse(url or "").hostname or "").lower().rstrip(".")
    except Exception:
        return False
    return host in (
        "archiveofourown.org", "www.archiveofourown.org",
        "ao3.org", "www.ao3.org",
    )


@asynccontextmanager
async def ao3_gate(url: Optional[str] = None):
    """Serialize AO3-bound requests; a no-op for every other host."""
    if url is not None and not is_ao3_url(url):
        yield
        return
    async with _ao3_semaphore:
        yield


def note_ao3_status(status_code: Optional[int]) -> None:
    """Track consecutive AO3 429s and trip the Zyte failover breaker."""
    global _ao3_429_streak, _ao3_zyte_until
    if status_code == 429:
        _ao3_429_streak += 1
        if _ao3_429_streak >= AO3_429_STREAK_THRESHOLD and not ao3_zyte_forced():
            if os.environ.get("ZYTE_API_KEY", "").strip():
                _ao3_zyte_until = time.time() + AO3_ZYTE_COOLDOWN_SEC
                log.warning(
                    "ao3: %d consecutive 429s — routing AO3 through Zyte for %ds",
                    _ao3_429_streak, AO3_ZYTE_COOLDOWN_SEC)
            else:
                log.warning(
                    "ao3: %d consecutive 429s but ZYTE_API_KEY is not set; cannot fail over",
                    _ao3_429_streak)
    elif status_code is not None and 200 <= status_code < 400:
        _ao3_429_streak = 0


def ao3_zyte_forced() -> bool:
    return time.time() < _ao3_zyte_until

_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "DNT": "1",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

MAX_FETCH_BYTES = int(os.environ.get("MAX_FETCH_BYTES", 2 * 1024 * 1024))
MAX_ZYTE_RESPONSE_BYTES = int(os.environ.get(
    "MAX_ZYTE_RESPONSE_BYTES",
    (MAX_FETCH_BYTES * 4 // 3) + 128 * 1024,
))
DEFAULT_TIMEOUT = int(os.environ.get("SCRAPER_TIMEOUT", 20))
MAX_REDIRECTS = int(os.environ.get("MAX_REDIRECTS", 5))
WORKER_PROXY_BASE = os.environ.get(
    "WORKER_PROXY_BASE",
    "https://pocket-reader-proxy.alpharius67.workers.dev").rstrip("/")
WORKER_PROXY_TOKEN = (
    os.environ.get("WORKER_PROXY_TOKEN") or os.environ.get("PROXY_AUTH_TOKEN") or ""
).strip()


async def _read_limited_response(
        response: httpx.Response,
        max_bytes: int = MAX_FETCH_BYTES) -> bytes:
    content_length = response.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > max_bytes:
                raise RuntimeError("Response too large")
        except ValueError:
            pass
    content = bytearray()
    async for chunk in response.aiter_bytes():
        content.extend(chunk)
        if len(content) > max_bytes:
            raise RuntimeError("Response too large")
    return bytes(content)


def _assert_public_connected_peer(response: httpx.Response) -> None:
    """Reject a private address after the HTTP client's DNS resolution."""
    stream = response.extensions.get("network_stream")
    peer = stream.get_extra_info("server_addr") if stream else None
    peer_ip = peer[0] if isinstance(peer, tuple) and peer else peer
    if not peer_ip or _ip_is_blocked(str(peer_ip)):
        raise RuntimeError("Blocked connection to a private/internal address")


async def _zyte_request(
        client: httpx.AsyncClient,
        key: str,
        payload: dict,
        timeout: int) -> httpx.Response:
    async with client.stream(
        "POST",
        "https://api.zyte.com/v1/extract",
        auth=httpx.BasicAuth(key, ""),
        json=payload,
        timeout=timeout,
    ) as response:
        body = await _read_limited_response(response, MAX_ZYTE_RESPONSE_BYTES)
        # aiter_bytes() (inside _read_limited_response) already applied
        # Content-Encoding decompression while streaming, so passing the
        # original headers through unchanged makes httpx try to decompress the
        # now-plain body a second time on construction, raising "zlib.error:
        # Error -3 while decompressing data: incorrect header check".
        headers = httpx.Headers(response.headers)
        for stale in ("content-encoding", "transfer-encoding", "content-length"):
            headers.pop(stale, None)
        return httpx.Response(
            response.status_code,
            headers=headers,
            content=body,
            request=response.request,
        )


def _worker_proxy_headers() -> dict:
    return {"X-Pocket-Proxy-Key": WORKER_PROXY_TOKEN} if WORKER_PROXY_TOKEN else {}


def _clean_hostname(host: Optional[str]) -> Optional[str]:
    if not host:
        return None
    cleaned = host.strip().strip("[]").rstrip(".").lower()
    if not cleaned or any(ord(ch) < 33 for ch in cleaned):
        return None
    try:
        return cleaned.encode("idna").decode("ascii")
    except Exception:
        return None


def _ip_is_blocked(ip_text: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_text)
    except ValueError:
        return True
    return not ip.is_global


def host_is_blocked(host: Optional[str]) -> bool:
    """True if host resolves to private, loopback, link-local, or otherwise
    non-global address space."""
    cleaned = _clean_hostname(host)
    if not cleaned:
        return True

    try:
        ipaddress.ip_address(cleaned)
        return _ip_is_blocked(cleaned)
    except ValueError:
        pass

    try:
        infos = socket.getaddrinfo(cleaned, None, type=socket.SOCK_STREAM)
    except Exception:
        return True

    ips = {info[4][0] for info in infos if info and info[4]}
    if not ips:
        return True
    return any(_ip_is_blocked(ip) for ip in ips)


def _host_allowed(host: str, allowed_hosts: Optional[Iterable[str]]) -> bool:
    if not allowed_hosts:
        return True
    cleaned = _clean_hostname(host)
    allowed = {_clean_hostname(item) for item in allowed_hosts}
    allowed.discard(None)
    return cleaned in allowed


def assert_public_url(
        url: str,
        *,
        allowed_hosts: Optional[Iterable[str]] = None,
        allowed_ports: Iterable[int] = (80, 443)) -> None:
    try:
        p = urlparse(url)
        port = p.port
    except Exception as exc:
        raise RuntimeError("Blocked malformed URL") from exc

    if p.scheme not in ("http", "https"):
        raise RuntimeError("Blocked non-http(s) URL")
    if not p.hostname:
        raise RuntimeError("Blocked URL without a hostname")
    if p.username or p.password:
        raise RuntimeError("Blocked URL with embedded credentials")
    if port is not None and port not in set(allowed_ports):
        raise RuntimeError("Blocked URL with a non-standard port")
    if allowed_hosts and not _host_allowed(p.hostname, allowed_hosts):
        raise RuntimeError("Blocked URL host is not allowed")
    if host_is_blocked(p.hostname):
        raise RuntimeError("Blocked request to a private/internal address")


def make_client(
    retries: int = 3,
    timeout: int = DEFAULT_TIMEOUT,
    follow_redirects: bool = True) -> httpx.AsyncClient:
    """Create a clean httpx.AsyncClient with retry/backoff.

    follow_redirects defaults to True for back-compat with direct-request callers
    (FicHub API, cover images, RoyalRoad chapters, etc.). fetch() below creates
    its own client with follow_redirects=False so it can validate every redirect
    hop against the SSRF guard instead of letting httpx follow blindly."""
    limits = httpx.Limits(max_keepalive_connections=10, max_connections=50)
    transport = httpx.AsyncHTTPTransport(retries=retries)
    c = httpx.AsyncClient(
        headers=_HEADERS,
        timeout=timeout,
        limits=limits,
        transport=transport,
        follow_redirects=follow_redirects
    )
    return c


async def zyte_fetch(url: str, timeout: int = DEFAULT_TIMEOUT) -> Optional[str]:
    """Fetch a URL's HTML via Zyte's smart-proxy API.

    Tries standard httpResponseBody fetch first for speed. If it fails or returns
    a Cloudflare block, it falls back to browserHtml rendering (full headless browser)
    to execute JavaScript and bypass Cloudflare challenges.
    """
    assert_public_url(url)
    key = os.environ.get("ZYTE_API_KEY", "").strip()
    if not key:
        log.warning("zyte: ZYTE_API_KEY is not configured in environment variables. Zyte scraping is disabled.")
        return None

    import base64

    # ── Tier 1: Fast HTTP Response Fetch ──────────────────────────────────────
    payload_http = {"url": url, "httpResponseBody": True, "followRedirect": False}
    try:
        log.info("zyte: trying fast HTTP fetch for %s", url[:80])
        async with httpx.AsyncClient(timeout=timeout) as zc:
            resp = await _zyte_request(zc, key, payload_http, timeout)

        if resp.status_code == 200:
            b64 = resp.json().get("httpResponseBody")
            if b64:
                decoded = base64.b64decode(b64, validate=True)
                if len(decoded) > MAX_FETCH_BYTES:
                    raise RuntimeError("Response too large")
                body_text = decoded.decode("utf-8", errors="replace")
                cf_reason = detect_cloudflare(resp, body_text)
                if not cf_reason:
                    log.info("zyte: fast HTTP fetch OK")
                    return body_text
                log.warning("zyte: HTTP fetch returned Cloudflare block: %s", cf_reason)
            else:
                log.warning("zyte: HTTP fetch returned no body")
        else:
            try:
                error_detail = resp.json().get("detail", resp.text)
            except Exception:
                error_detail = resp.text
            log.warning("zyte: HTTP fetch failed with status %s: %s", resp.status_code, error_detail)
    except Exception as e:
        log.warning("zyte: HTTP fetch exception: %s", e)

    # ── Tier 2: Headless Browser Rendering (Cloudflare Bypass) ─────────────────
    payload_browser = {"url": url, "browserHtml": True, "followRedirect": False}
    try:
        log.info("zyte: trying browserHtml rendering (Cloudflare bypass) for %s", url[:80])
        async with httpx.AsyncClient(timeout=timeout + 15) as zc:  # extend timeout for browser startup
            resp = await _zyte_request(zc, key, payload_browser, timeout + 15)

        if resp.status_code == 200:
            html = resp.json().get("browserHtml")
            if html:
                if len(html.encode("utf-8")) > MAX_FETCH_BYTES:
                    raise RuntimeError("Response too large")
                cf_reason = detect_cloudflare(resp, html)
                if not cf_reason:
                    log.info("zyte: browserHtml bypass OK")
                    return html
                log.error("zyte: browserHtml bypass still blocked: %s", cf_reason)
            else:
                log.warning("zyte: browserHtml returned no body")
        else:
            try:
                error_detail = resp.json().get("detail", resp.text)
            except Exception:
                error_detail = resp.text
            log.error("zyte: browserHtml failed with status %s: %s", resp.status_code, error_detail)
    except Exception as e:
        log.error("zyte: browserHtml exception: %s", e)

    return None


async def zyte_fetch_binary(url: str, timeout: int = DEFAULT_TIMEOUT) -> Optional[bytes]:
    """Fetch a URL's binary payload via Zyte's smart-proxy API when ZYTE_API_KEY is set.

    Returns the decoded bytes, or None when Zyte isn't configured or the request fails.
    """
    assert_public_url(url)
    key = os.environ.get("ZYTE_API_KEY", "").strip()
    if not key:
        return None
    import base64
    payload = {"url": url, "httpResponseBody": True, "followRedirect": False}
    try:
        async with httpx.AsyncClient(timeout=timeout) as zc:
            resp = await _zyte_request(zc, key, payload, timeout)
        if resp.status_code == 200:
            b64 = resp.json().get("httpResponseBody")
            if b64:
                decoded = base64.b64decode(b64, validate=True)
                if len(decoded) > MAX_FETCH_BYTES:
                    raise RuntimeError("Response too large")
                return decoded
            log.warning("Zyte returned no body for binary %s", url[:80])
        else:
            log.warning("Zyte API binary failed (%s) for %s", resp.status_code, url[:80])
    except Exception as e:
        log.warning("Zyte fetch binary error for %s: %s", url[:80], e)
    return None


async def proxy_fetch(url: str, timeout: int = DEFAULT_TIMEOUT) -> Optional[str]:
    """Fetch HTML text routing via Zyte smart proxy first, then falling back to the custom
    Cloudflare Worker proxy before attempting a direct request.
    """
    assert_public_url(url)  # validate before any proxy path, not just the direct-fetch path
    # 1. Try Zyte
    zyte_body = await zyte_fetch(url, timeout=timeout)
    if zyte_body:
        return zyte_body
    
    # 2. Try Cloudflare Worker Proxy
    import urllib.parse
    proxy_url = f"{WORKER_PROXY_BASE}/?url={urllib.parse.quote(url)}"
    try:
        async with ao3_gate(url):
            async with httpx.AsyncClient(timeout=timeout) as zc:
                async with zc.stream(
                        "GET", proxy_url, headers=_worker_proxy_headers(),
                        timeout=timeout) as streamed:
                    body = await _read_limited_response(streamed)
                    # aiter_bytes() (inside _read_limited_response) already
                    # decompressed the body while streaming; passing the
                    # original headers through would make httpx try to
                    # decompress the now-plain body again on construction and
                    # raise "zlib.error: incorrect header check".
                    headers = httpx.Headers(streamed.headers)
                    for stale in ("content-encoding", "transfer-encoding", "content-length"):
                        headers.pop(stale, None)
                    resp = httpx.Response(
                        streamed.status_code,
                        headers=headers,
                        content=body,
                        request=streamed.request,
                    )
        if is_ao3_url(url):
            note_ao3_status(resp.status_code)
        if resp.status_code == 200:
            cf_reason = detect_cloudflare(resp, resp.text)
            if not cf_reason:
                return resp.text
            log.warning("CF Proxy returned Cloudflare block for %s: %s", url[:80], cf_reason)
        else:
            log.warning("CF Proxy failed (%s) for %s", resp.status_code, url[:80])
    except Exception as e:
        log.warning("CF Proxy fetch error for %s: %s", url[:80], e)
    return None


async def proxy_fetch_binary(url: str, timeout: int = DEFAULT_TIMEOUT) -> Optional[bytes]:
    """Fetch binary payload routing via Zyte smart proxy first, then falling back to the custom
    Cloudflare Worker proxy before attempting a direct request.
    """
    assert_public_url(url)  # validate before any proxy path, not just the direct-fetch path
    # 1. Try Zyte
    zyte_bytes = await zyte_fetch_binary(url, timeout=timeout)
    if zyte_bytes:
        return zyte_bytes
        
    # 2. Try Cloudflare Worker Proxy
    import urllib.parse
    proxy_url = f"{WORKER_PROXY_BASE}/?url={urllib.parse.quote(url)}"
    try:
        async with ao3_gate(url):
            async with httpx.AsyncClient(timeout=timeout) as zc:
                async with zc.stream(
                        "GET", proxy_url, headers=_worker_proxy_headers(),
                        timeout=timeout) as streamed:
                    body = await _read_limited_response(streamed)
                    # aiter_bytes() (inside _read_limited_response) already
                    # decompressed the body while streaming; passing the
                    # original headers through would make httpx try to
                    # decompress the now-plain body again on construction and
                    # raise "zlib.error: incorrect header check".
                    headers = httpx.Headers(streamed.headers)
                    for stale in ("content-encoding", "transfer-encoding", "content-length"):
                        headers.pop(stale, None)
                    resp = httpx.Response(
                        streamed.status_code,
                        headers=headers,
                        content=body,
                        request=streamed.request,
                    )
        if is_ao3_url(url):
            note_ao3_status(resp.status_code)
        if resp.status_code == 200:
            return resp.content
        else:
            log.warning("CF Proxy binary failed (%s) for %s", resp.status_code, url[:80])
    except Exception as e:
        log.warning("CF Proxy fetch binary error for %s: %s", url[:80], e)
    return None


async def fetch(url: str,
          client: Optional[httpx.AsyncClient] = None,
          timeout: int = DEFAULT_TIMEOUT,
          extra_cookies: Optional[dict] = None) -> str:
    """Fetch HTML text with streaming, size guards, and Cloudflare detection."""
    # Route through Zyte or Cloudflare Worker Proxy when no explicit client was supplied
    if client is None:
        _zbody = await proxy_fetch(url, timeout=timeout)
        if _zbody is not None:
            return _zbody
    elif is_ao3_url(url) and ao3_zyte_forced():
        # 429-streak breaker is active: even direct-client callers (e.g. the
        # chapter-count sweep) spend Zyte credits instead of hammering AO3
        # from the shared backend IP.
        _zbody = await zyte_fetch(url, timeout=timeout)
        if _zbody is not None:
            return _zbody
    c = client or make_client(timeout=timeout, follow_redirects=False)
    # Always manage redirects here, even when a caller passes a shared client,
    # so every redirect hop is validated against the SSRF guard before fetching.
    manage_redirects = True
    lower_url = url.lower()

    if "archiveofourown.org" in lower_url or "ao3.org" in lower_url:
        try:
            c.cookies.set("accepted_tos", "true", domain="archiveofourown.org")
            c.cookies.set("view_adult", "true", domain="archiveofourown.org")
        except Exception:
            pass

    if extra_cookies:
        for k, v in extra_cookies.items():
            if v:
                try:
                    c.cookies.set(str(k), str(v))
                except Exception:
                    pass


    try:
        content_bytes = bytearray()
        resp = None
        current = url
        hops = 0
        async with ao3_gate(url):
            while True:
                # Validate every hop (initial URL + each redirect target) so a public
                # page can't redirect us into a private/internal address.
                await asyncio.to_thread(assert_public_url, current)
                async with c.stream("GET", current, timeout=timeout, follow_redirects=False) as r:
                    _assert_public_connected_peer(r)
                    if (manage_redirects and r.is_redirect
                            and r.headers.get("location")):
                        hops += 1
                        if hops > MAX_REDIRECTS:
                            raise RuntimeError("Too many redirects")
                        current = urljoin(current, r.headers["location"])
                        continue
                    resp = r
                    async for chunk in r.aiter_bytes():
                        content_bytes.extend(chunk)
                        if len(content_bytes) > MAX_FETCH_BYTES:
                            raise RuntimeError("Response too large")
                    break
        if is_ao3_url(url) and resp is not None:
            note_ao3_status(resp.status_code)
    except httpx.TimeoutException:
        if not client: await c.aclose()
        raise RuntimeError(f"Timed out fetching {url}") from None
    except RuntimeError:
        # Re-raise our own guard errors verbatim (Response too large, SSRF block,
        # too many redirects) rather than masking them as a generic read failure.
        if not client: await c.aclose()
        raise
    except Exception as e:
        if not client: await c.aclose()
        raise RuntimeError("Failed to read response body") from e

    encoding = resp.encoding or "utf-8"
    if encoding.upper() in ('ISO-8859-1', 'LATIN-1'):
        encoding = "utf-8"

    body_text = content_bytes.decode(encoding, errors="replace")

    cf_reason = detect_cloudflare(resp, body_text)
    if cf_reason:
        if not client: await c.aclose()
        raise CloudflareBlocked(url, cf_reason)

    if not client: await c.aclose()
    resp.raise_for_status()
    return body_text


async def fetch_image(url: str,
                client: Optional[httpx.AsyncClient] = None,
                timeout: int = 15) -> Optional[bytes]:
    """Download image bytes from a URL."""
    assert_public_url(url)
    c = client or make_client(follow_redirects=False)
    result = None
    try:
        async with c.stream(
                "GET", url, timeout=timeout, follow_redirects=False) as resp:
            _assert_public_connected_peer(resp)
            if (resp.status_code == 200
                    and resp.headers.get("content-type", "").startswith("image/")):
                result = await _read_limited_response(resp)
    except Exception as e:
        log.debug("fetch_image failed for %s: %s", url, e)
    if not client: await c.aclose()
    return result
