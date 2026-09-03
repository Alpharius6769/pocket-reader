"""
Alpharius' Pocket Reader API (FastAPI) — EDGE OPTIMIZED

Lightweight I/O router only. No machine learning inference happens here.
This backend handles:
  • Story scraping (Routed entirely via Cloudflare Worker edge)
  • File upload + parse
  • HMOFA masterlist proxy + caching
  • User profile + library cloud sync (SQLite-backed)
  • Web Push subscription registry + fanout
  • Periodic chapter-sync sweep
"""

import collections
import os
import json
import logging
import threading
import pathlib
import tempfile
import re
import hashlib
import hmac
import secrets
import time as _time
from typing import Optional
from urllib.parse import urlparse, parse_qsl
from dataclasses import asdict

import httpx
import aiosqlite
import asyncio
import uvicorn
from fastapi import FastAPI, HTTPException, File, UploadFile, Body, Header, Request
from fastapi.responses import Response, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Backend modules
from scrapers_dispatcher import scrape_url
from scrapers_cloudflare import CloudflareBlocked, detect_cloudflare
from scrapers_core import (
    make_client, assert_public_url, proxy_fetch, proxy_fetch_binary,
    _assert_public_connected_peer, _worker_proxy_headers,
)
from scrapers_ao3 import ao3_published_chapter_count, parse_ao3_chapter_info, parse_published_chapter_count
from parsers_core import ScrapeResult, sanitize_narration_chapters
import parsers_dispatcher

try:
    from pywebpush import webpush, WebPushException
    PYWEBPUSH_AVAILABLE = True
except Exception:
    PYWEBPUSH_AVAILABLE = False

# Logging


class InMemoryLogHandler(logging.Handler):
    def __init__(self, capacity=500):
        super().__init__()
        self.log_buffer = collections.deque(maxlen=capacity)

    def emit(self, record):
        try:
            msg = self.format(record)
            self.log_buffer.append(msg)
        except Exception:
            self.handleError(record)


_mem_handler = InMemoryLogHandler(capacity=500)
_mem_handler.setFormatter(logging.Formatter(
    "%(asctime)s %(levelname)s: %(message)s"))

logging.basicConfig(
    level=logging.INFO,
    handlers=[
        logging.StreamHandler(),
        _mem_handler])
log = logging.getLogger("pocket-reader.app")

# Config
# Exact-match origin list (no wildcards). The ALLOWED_ORIGINS env var on the
# Hugging Face Space overrides this entirely; this default applies only when
# that variable is unset or empty.
#
# It used to list two pocket-reader-f2y.pages.dev names and NOT the real origin.
# Those were removed from the Worker's own default and from wrangler.toml when
# the Cloudflare Pages deploy was retired, for a reason that applies just as
# much here: both names are NXDOMAIN, and an unowned *.pages.dev name can be
# claimed by anyone who creates a Pages project with it. Trusting a dead one is
# a standing subdomain-takeover path -- and while the env var normally masks
# this default, a blank or missing variable would have fallen back to allowing
# two names the project does not own while blocking the one it does.
DEFAULT_ALLOWED_ORIGINS = "https://alpharius6769.github.io"
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS)
if not ALLOWED_ORIGINS.strip():
    ALLOWED_ORIGINS = DEFAULT_ALLOWED_ORIGINS
DATABASE_PATH = os.environ.get(
    "SUBSCRIPTIONS_DB",
    "/data/subscriptions.sqlite")
ALLOW_EPHEMERAL_DB = os.environ.get(
    "ALLOW_EPHEMERAL_DB",
    "false").strip().lower() in {"1", "true", "yes"}
_database_actual_path: Optional[str] = None
_database_durable = False

VAPID_PUBLIC = os.environ.get("VAPID_PUBLIC")
VAPID_PRIVATE = os.environ.get("VAPID_PRIVATE")
VAPID_SUB = os.environ.get("VAPID_SUB", "mailto:admin@example.com")

# Shared secret gating the internal /api/send-push endpoint. When unset the
# endpoint fails closed (403) since the frontend never calls it directly.
ADMIN_PUSH_SECRET = os.environ.get("ADMIN_PUSH_SECRET", "")
MAX_FICHUB_RESPONSE_BYTES = int(
    os.environ.get("MAX_FICHUB_RESPONSE_BYTES", 25 * 1024 * 1024))
MAX_ZYTE_FICHUB_RESPONSE_BYTES = int(os.environ.get(
    "MAX_ZYTE_FICHUB_RESPONSE_BYTES",
    (MAX_FICHUB_RESPONSE_BYTES * 4 // 3) + 256 * 1024,
))

# Startup Environmental Checks

if not VAPID_PUBLIC or not VAPID_PRIVATE:
    log.warning(
        "⚠️ VAPID_PUBLIC or VAPID_PRIVATE is missing! Web Push notifications will be disabled.")
if VAPID_PUBLIC and VAPID_PRIVATE and VAPID_SUB == "mailto:admin@example.com":
    log.error(
        "⚠️ VAPID_SUB is the placeholder default 'mailto:admin@example.com'. "
        "Push notifications will likely be rejected by push relay servers. "
        "Set VAPID_SUB to a real contact URI in HF Space secrets.")
if ALLOWED_ORIGINS == "*":
    log.warning("⚠️ ALLOWED_ORIGINS is set to '*'. This is insecure for production. Set it to the exact frontend origin(s) in the Hugging Face Space variables.")

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _db_conn
    _db_conn = await init_db_async()
    yield
    if _db_conn:
        await _db_conn.close()

app = FastAPI(title="Alpharius' Pocket Reader API - Edge Router", lifespan=lifespan)

if ALLOWED_ORIGINS == "*" or not ALLOWED_ORIGINS.strip():
    allow_origins = ["*"]
    allow_credentials = False
else:
    allow_origins = [o.strip()
                     for o in ALLOWED_ORIGINS.split(",") if o.strip()]
    allow_credentials = True

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE = pathlib.Path(__file__).parent
STATIC_DIR = BASE / "static"
STATIC_DIR.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

CURATED_DIR = BASE / "curated_library"
CURATED_DIR.mkdir(exist_ok=True)


def _safe_curated_pdf_path(filename: str) -> pathlib.Path:
    base = CURATED_DIR.resolve()
    candidate = (CURATED_DIR / filename).resolve()
    if candidate == base or base not in candidate.parents:
        raise HTTPException(
            status_code=400,
            detail="Invalid curated file path")
    return candidate


async def init_db_async(path: str = DATABASE_PATH):
    global _database_actual_path, _database_durable
    actual_path = path
    parent = pathlib.Path(path).parent
    if str(parent) and str(parent) != ".":
        try:
            parent.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            if not ALLOW_EPHEMERAL_DB:
                raise RuntimeError(
                    f"Persistent database directory {parent} is unavailable"
                ) from e
            log.warning(
                "Could not create db parent dir %s: %s — falling back to ephemeral path.",
                parent,
                e)
            actual_path = pathlib.Path("subscriptions.sqlite").name
    try:
        conn = await aiosqlite.connect(actual_path, check_same_thread=False)
    except Exception as e:
        if not ALLOW_EPHEMERAL_DB:
            raise RuntimeError(
                f"Configured subscription database {actual_path} is unavailable"
            ) from e
        log.warning(
            "Could not open %s: %s — falling back to ephemeral path.",
            actual_path,
            e)
        actual_path = "subscriptions.sqlite"
        conn = await aiosqlite.connect(actual_path, check_same_thread=False)

    await conn.execute("""
        CREATE TABLE IF NOT EXISTS subscriptions (
            user_id TEXT PRIMARY KEY,
            subscription_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            auth_token_hash TEXT
        )
    """)
    async with conn.execute("PRAGMA table_info(subscriptions)") as cursor:
        subscription_columns = {row[1] for row in await cursor.fetchall()}
    if "auth_token_hash" not in subscription_columns:
        await conn.execute("ALTER TABLE subscriptions ADD COLUMN auth_token_hash TEXT")
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS user_state (
            user_id TEXT PRIMARY KEY,
            profile_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            size_bytes INTEGER NOT NULL
        )
    """)
    await conn.commit()
    _database_actual_path = actual_path
    normalized_path = str(pathlib.Path(actual_path)).replace("\\", "/")
    _database_durable = normalized_path == "/data/subscriptions.sqlite" or normalized_path.startswith("/data/")
    return conn


_db_conn = None
_db_lock = asyncio.Lock()

# Simple in-memory rate limiter for /api/subscribe (max 5 per IP per 10 min)
_subscribe_rate: dict = {}
_SUBSCRIBE_RATE_WINDOW = 600
_SUBSCRIBE_RATE_MAX = 5
_scrape_rate: dict = {}
_SCRAPE_RATE_WINDOW = int(os.environ.get("SCRAPE_RATE_WINDOW", 60))
_SCRAPE_RATE_MAX = int(os.environ.get("SCRAPE_RATE_MAX", 20))
_SCRAPE_CONCURRENCY = asyncio.Semaphore(
    max(1, int(os.environ.get("SCRAPE_CONCURRENCY", 4))))
_PUSH_USER_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

def _client_ip(request: Request) -> str:
    """Best-effort caller identity for the per-caller rate limiters.

    Behind the Cloudflare Worker every request arrives from a Cloudflare edge
    address, so keying on request.client.host collapses the entire user base
    onto a handful of IPs and makes a per-caller budget behave like a global
    one. The Worker stamps CF-Connecting-IP from the edge-set visitor address
    (not a browser X-Forwarded-For). Trust that header only; fall back to the
    socket peer for direct calls and local development.
    """
    value = request.headers.get("cf-connecting-ip", "")
    if value:
        return value.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


_RATE_LIMIT_EVICT_THRESHOLD = int(os.environ.get("RATE_LIMIT_EVICT_THRESHOLD", 1000))


def _evict_idle_rate_keys(table: dict, window_seconds: int, now: float) -> None:
    """Drop callers whose window has fully expired.

    These tables are keyed by client IP and are never otherwise cleaned up, so
    on a long-lived Space they grow one entry per distinct visitor for the life
    of the process. Only worth walking once the table is large enough that the
    scan cost is justified.
    """
    if len(table) <= _RATE_LIMIT_EVICT_THRESHOLD:
        return
    for key in list(table):
        stamps = table[key]
        if not stamps or now - stamps[-1] >= window_seconds:
            table.pop(key, None)


def _check_subscribe_rate(ip: str) -> bool:
    now = _time.time()
    window = _subscribe_rate.setdefault(ip, [])
    window[:] = [t for t in window if now - t < _SUBSCRIBE_RATE_WINDOW]
    if len(window) >= _SUBSCRIBE_RATE_MAX:
        return False
    window.append(now)
    _evict_idle_rate_keys(_subscribe_rate, _SUBSCRIBE_RATE_WINDOW, now)
    return True


def _check_scrape_rate(ip: str) -> bool:
    now = _time.time()
    window = _scrape_rate.setdefault(ip, [])
    window[:] = [t for t in window if now - t < _SCRAPE_RATE_WINDOW]
    if len(window) >= _SCRAPE_RATE_MAX:
        return False
    window.append(now)
    _evict_idle_rate_keys(_scrape_rate, _SCRAPE_RATE_WINDOW, now)
    return True


def _require_scrape_budget(
        request: Request,
        *,
        detail: str = "Too many story requests — wait a moment and try again.") -> None:
    if not _check_scrape_rate(_client_ip(request)):
        raise HTTPException(
            status_code=429,
            detail=detail,
            headers={"Retry-After": str(_SCRAPE_RATE_WINDOW)})


def _admin_authorized(provided: Optional[str]) -> bool:
    secret = ADMIN_PUSH_SECRET or ""
    token = provided or ""
    if not secret or not token:
        return False
    return hmac.compare_digest(token, secret)


def _push_token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _validate_push_identity(user_id: str):
    if not _PUSH_USER_ID_RE.fullmatch(str(user_id or "")):
        raise HTTPException(status_code=400, detail="Invalid push subscription identifier")


def _validate_push_subscription(subscription: dict):
    if not isinstance(subscription, dict):
        raise HTTPException(status_code=400, detail="Invalid push subscription")
    endpoint = subscription.get("endpoint")
    keys = subscription.get("keys")
    if not isinstance(endpoint, str) or len(endpoint) > 2048 or not _is_allowed_push_endpoint(endpoint):
        raise HTTPException(status_code=400, detail="Invalid push endpoint")
    if not isinstance(keys, dict) or not all(isinstance(keys.get(key), str) for key in ("p256dh", "auth")):
        raise HTTPException(status_code=400, detail="Invalid push subscription keys")
    if len(json.dumps(subscription)) > 8192:
        raise HTTPException(status_code=413, detail="Push subscription is too large")


_DEFAULT_PUSH_ENDPOINT_HOSTS = (
    "fcm.googleapis.com",
    "web.push.apple.com",
    "push.services.mozilla.com",
    "updates.push.services.mozilla.com",
    "notify.windows.com",
)


def _is_allowed_push_endpoint(endpoint: str) -> bool:
    try:
        parsed = urlparse(endpoint)
        host = (parsed.hostname or "").lower().rstrip(".")
        port = parsed.port
    except Exception:
        return False
    configured = tuple(
        value.strip().lower().rstrip(".")
        for value in os.environ.get("PUSH_ENDPOINT_HOSTS", "").split(",")
        if value.strip()
    )
    allowed = _DEFAULT_PUSH_ENDPOINT_HOSTS + configured
    return (
        parsed.scheme == "https"
        and not parsed.username
        and not parsed.password
        and port in (None, 443)
        and any(host == suffix or host.endswith("." + suffix) for suffix in allowed)
    )


def _same_push_subscription(left: dict, right: dict) -> bool:
    return (
        left.get("endpoint") == right.get("endpoint")
        and left.get("keys", {}).get("p256dh") == right.get("keys", {}).get("p256dh")
        and left.get("keys", {}).get("auth") == right.get("keys", {}).get("auth")
    )

class SearchRequest(BaseModel):
    query: Optional[str] = ""
    title: Optional[str] = ""
    author: Optional[str] = ""
    fandom: Optional[str] = ""
    rating: Optional[str] = ""
    category: Optional[str] = ""
    language: Optional[str] = "en"
    sort_column: Optional[str] = "revised_at"
    sort_direction: Optional[str] = "desc"
    page: Optional[int] = 1
    limit: Optional[int] = 15
    words_min: Optional[int] = None
    words_max: Optional[int] = None
    complete: Optional[str] = ""


class ScrapeRequest(BaseModel):
    url: str
    cookies: Optional[dict] = None


class PushSubscription(BaseModel):
    user_id: str
    subscription: dict
    profile: Optional[dict] = None
    auth_token: Optional[str] = None


class StateSaveRequest(BaseModel):
    user_id: str
    profile: dict


class UnsubscribeRequest(BaseModel):
    user_id: str
    auth_token: str


class TTLCache:
    def __init__(self, max_entries: int, ttl_seconds: int, label: str = ""):
        self.max_entries = max_entries
        self.ttl = ttl_seconds
        self.label = label
        self._data: collections.OrderedDict = collections.OrderedDict()
        self._lock = asyncio.Lock()

    async def get(self, key):
        async with self._lock:
            entry = self._data.get(key)
            if not entry:
                return None
            value, expiry = entry
            if _time.time() > expiry:
                self._data.pop(key, None)
                return None
            self._data.move_to_end(key)
            return value

    async def put(self, key, value, ttl_seconds: Optional[int] = None):
        async with self._lock:
            ttl = self.ttl if ttl_seconds is None else ttl_seconds
            self._data[key] = (value, _time.time() + ttl)
            self._data.move_to_end(key)
            if len(self._data) > self.max_entries:
                self._data.popitem(last=False)


SCRAPE_CACHE = TTLCache(max_entries=1000, ttl_seconds=30 * 60, label="scrape")
SEARCH_CACHE = TTLCache(max_entries=500, ttl_seconds=10 * 60, label="search")
SEARCH_NEGATIVE_TTL_SECONDS = int(os.environ.get("SEARCH_NEGATIVE_TTL_SECONDS", 60))
SEARCH_OVERLOAD_TTL_SECONDS = int(os.environ.get("SEARCH_OVERLOAD_TTL_SECONDS", 120))
# Result-bearing searches cache much longer than the 10-min default: AO3 search
# rankings barely move minute-to-minute, and every cache hit is one less request
# against the shared egress IP that all app users funnel through.
SEARCH_POSITIVE_TTL_SECONDS = int(os.environ.get("SEARCH_POSITIVE_TTL_SECONDS", 30 * 60))
# MASTERLIST_CACHE removed with /api/masterlist: it fronted an empty JSON file
# for a route no client calls.


def is_valid_url(url: str) -> bool:
    try:
        u = url.strip().lower()
        return u.startswith("http://") or u.startswith("https://")
    except Exception:
        return False


# SSRF guarding for user-supplied scrape URLs goes through
# scrapers_core.assert_public_url (which itself calls host_is_blocked), so the
# initial-URL check and the per-redirect-hop checks inside scrapers_core.fetch()
# stay in lockstep. The former _resolve_is_blocked wrapper around
# host_is_blocked had no remaining callers.


def safe_http_error(
        log_msg: str,
        client_msg: str = "Internal server error",
        status_code: int = 500):
    log.exception(log_msg)  # full traceback goes to server logs only
    raise HTTPException(status_code=status_code, detail=client_msg)


_startup_time = _time.time()

# FicHub asks API consumers to set a custom User-Agent identifying the project
# with contact info after a "+" (per their API docs and iris's guidance).
FICHUB_USER_AGENT = os.environ.get(
    "FICHUB_USER_AGENT",
    "pocket-reader/1.0 (+https://huggingface.co/spaces/alpharius6769/pocket-reader)")
WORKER_PROXY_BASE = os.environ.get(
    "WORKER_PROXY_BASE",
    "https://pocket-reader-proxy.alpharius67.workers.dev").rstrip("/")


def _fichub_headers() -> dict:
    """Build FicHub request headers: custom UA (required) + Bearer token (if set).

    The Bearer token bypasses FicHub's datacenter IP block (err=-9). Request one
    from verdant@fichub.net or the FicHub Discord, then set FICHUB_TOKEN in the
    HF Space secrets.
    """
    headers = {"User-Agent": FICHUB_USER_AGENT}
    token = os.environ.get("FICHUB_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _canonical_ao3_work_url(value: str) -> Optional[str]:
    try:
        parsed = urlparse(str(value or "").strip())
        port = parsed.port
    except Exception:
        return None
    host = (parsed.hostname or "").lower().rstrip(".")
    match = re.fullmatch(r"/works/(\d+)(?:/chapters/\d+)?/?", parsed.path or "")
    if (
        parsed.scheme not in ("http", "https")
        or host not in ("archiveofourown.org", "www.archiveofourown.org")
        or parsed.username or parsed.password or port not in (None, 80, 443)
        or not match
    ):
        return None
    return f"https://archiveofourown.org/works/{match.group(1)}"


def _sanitize_push_profile(profile: Optional[dict]) -> Optional[dict]:
    """Keep only explicitly subscribed AO3 story metadata for the push sweep."""
    if not isinstance(profile, dict):
        return None
    stories = []
    for story in profile.get("library") or []:
        if not isinstance(story, dict):
            continue
        if not (story.get("updateSubscribed") or story.get("update_subscribed")):
            continue
        url = _canonical_ao3_work_url(
            story.get("sourceUrl") or story.get("source_url") or story.get("url") or "")
        if not url:
            continue
        published = int(story.get("publishedChapters") or story.get("published_chapters") or story.get("totalChapters") or 0)
        if published < 0 or published > 10000:
            continue
        stories.append({
            "title": str(story.get("title") or "your story")[:300],
            "url": url[:1000],
            "story_key": str(story.get("storyKey") or story.get("story_key") or "")[:300],
            "published_chapters": published,
            "update_subscribed": True,
        })
    if not stories:
        return None
    return {"library": stories}


async def _bounded_httpx_request(
        client: httpx.AsyncClient,
        method: str,
        url: str,
        *,
        max_bytes: int,
        verify_peer: bool = False,
        **kwargs) -> httpx.Response:
    async with client.stream(method, url, **kwargs) as response:
        if verify_peer:
            _assert_public_connected_peer(response)
        content_length = response.headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > max_bytes:
                    raise RuntimeError("Upstream response is too large")
            except ValueError:
                pass
        body = bytearray()
        async for chunk in response.aiter_bytes():
            body.extend(chunk)
            if len(body) > max_bytes:
                raise RuntimeError("Upstream response is too large")
        # aiter_bytes() already applied Content-Encoding decompression while
        # streaming, so passing the original headers through unchanged makes
        # httpx try to decompress the now-plain body a second time on any
        # later .content/.text/.json() access, raising "zlib.error: Error -3
        # while decompressing data: incorrect header check". Strip the
        # now-stale encoding/length headers, same as _zyte_reconstruct_response.
        headers = httpx.Headers(response.headers)
        for stale in ("content-encoding", "transfer-encoding", "content-length"):
            headers.pop(stale, None)
        return httpx.Response(
            response.status_code,
            headers=headers,
            content=bytes(body),
            request=response.request,
        )


def _zyte_reconstruct_response(data: dict, zyte_resp) -> Optional[httpx.Response]:
    """Decode a Zyte /v1/extract result into an httpx.Response.

    Returns None when the body is missing or is a Cloudflare challenge page.
    """
    import base64
    b64_body = data.get("httpResponseBody")
    if not b64_body:
        log.warning("fichub/zyte: response contained no httpResponseBody")
        return None
    decoded = base64.b64decode(b64_body, validate=True)
    if len(decoded) > MAX_FICHUB_RESPONSE_BYTES:
        raise RuntimeError("FicHub response is too large")
    # Use the actual HTTP status the target server returned, not Zyte's own 200.
    target_status = data.get("statusCode", 200)
    # Reconstruct headers, stripping hop-by-hop entries that httpx can't relay.
    headers = []
    for h in data.get("httpResponseHeaders", []):
        name_lower = h["name"].lower()
        if name_lower in ("content-encoding", "transfer-encoding", "content-length"):
            continue
        headers.append((h["name"].encode(), h["value"].encode()))
    reconstructed = httpx.Response(
        status_code=target_status,
        content=decoded,
        headers=headers,
        request=zyte_resp.request,
    )
    # If Zyte's residential proxy still received a Cloudflare challenge, tell the caller.
    body_text = decoded.decode("utf-8", errors="replace")
    cf_reason = detect_cloudflare(reconstructed, body_text)
    if cf_reason:
        log.warning("fichub/zyte: Cloudflare challenge in httpResponseBody: %s", cf_reason)
        return None
    return reconstructed


async def _fichub_get(client, url, *, timeout=30, max_retries=2):
    """GET a FicHub URL respecting 429/Retry-After with bounded backoff.

    Priority order:
      1. Zyte API (residential proxy — bypasses Cloudflare without FICHUB_TOKEN)
         a. httpResponseBody (fast, sufficient for a JSON API)
         b. browserHtml fallback if Cloudflare blocks the residential IP too
      2. Cloudflare Worker proxy (CORS-only worker, limited effectiveness)
      3. Direct fetch + FICHUB_TOKEN (last resort, works only with a token)
    """
    import urllib.parse
    await asyncio.to_thread(assert_public_url, url, allowed_hosts={"fichub.net"})

    zyte_api_key = os.environ.get("ZYTE_API_KEY", "").strip()
    if zyte_api_key:
        zyte_auth = httpx.BasicAuth(zyte_api_key, "")
        # Pass FicHub's required custom User-Agent (and Bearer token if set) so
        # FicHub's API accepts the request even through a residential proxy.
        fh_hdrs = _fichub_headers()
        custom_request_headers = [
            {"name": k, "value": v} for k, v in fh_hdrs.items()
        ]

        # ── Tier 1: fast HTTP body fetch via Zyte residential proxy ──────────
        payload_http = {
            "url": url,
            "httpResponseBody": True,
            "httpResponseHeaders": True,
            "followRedirect": False,
            "customHttpRequestHeaders": custom_request_headers,
        }
        log.info("fichub/zyte: tier-1 httpResponseBody for %s", url[:80])
        try:
            zr = await _bounded_httpx_request(
                client, "POST",
                "https://api.zyte.com/v1/extract",
                max_bytes=MAX_ZYTE_FICHUB_RESPONSE_BYTES,
                auth=zyte_auth, json=payload_http, timeout=timeout,
            )
            if zr.status_code == 200:
                reconstructed = _zyte_reconstruct_response(zr.json(), zr)
                if reconstructed is not None:
                    if reconstructed.status_code == 429:
                        try:
                            wait = float(reconstructed.headers.get("Retry-After", "5"))
                        except (TypeError, ValueError):
                            wait = 5.0
                        log.warning("fichub/zyte: tier-1 got 429, waiting %.1fs", wait)
                        await asyncio.sleep(min(max(wait, 1.0), 15.0))
                    else:
                        log.info("fichub/zyte: tier-1 OK (status %d)", reconstructed.status_code)
                        return reconstructed
                # Cloudflare detected — fall through to tier-2
            else:
                log.warning("fichub/zyte: Zyte API returned %s for tier-1", zr.status_code)
        except Exception as e:
            log.warning("fichub/zyte: tier-1 exception: %s", e)

        # ── Tier 2: headless browser via Zyte (Cloudflare JS-challenge bypass) ─
        payload_browser = {
            "url": url,
            "browserHtml": True,
            "followRedirect": False,
            "customHttpRequestHeaders": custom_request_headers,
        }
        log.info("fichub/zyte: tier-2 browserHtml for %s", url[:80])
        try:
            zr = await _bounded_httpx_request(
                client, "POST",
                "https://api.zyte.com/v1/extract",
                max_bytes=MAX_ZYTE_FICHUB_RESPONSE_BYTES,
                auth=zyte_auth, json=payload_browser, timeout=timeout + 20,
            )
            if zr.status_code == 200:
                html = zr.json().get("browserHtml", "")
                if html:
                    if len(html.encode("utf-8")) > MAX_FICHUB_RESPONSE_BYTES:
                        raise RuntimeError("FicHub browser response is too large")
                    cf_reason = detect_cloudflare(zr, html)
                    if cf_reason:
                        log.error("fichub/zyte: tier-2 still blocked: %s", cf_reason)
                    else:
                        # Wrap the HTML body in an httpx.Response so callers see
                        # a uniform interface. Content-Type is application/json
                        # because FicHub's API endpoint returns JSON; if the browser
                        # render returned something else, the JSON check in
                        # fichub-proxy will catch it cleanly.
                        log.info("fichub/zyte: tier-2 OK")
                        return httpx.Response(
                            status_code=200,
                            content=html.encode("utf-8"),
                            headers=[(b"content-type", b"application/json")],
                            request=zr.request,
                        )
            else:
                log.warning("fichub/zyte: Zyte API returned %s for tier-2", zr.status_code)
        except Exception as e:
            log.error("fichub/zyte: tier-2 exception: %s", e)

    # ── Fallback: Cloudflare Worker proxy ─────────────────────────────────────
    proxy_url = f"{WORKER_PROXY_BASE}/?url={urllib.parse.quote(url)}"
    try:
        log.info("fichub: trying Cloudflare Worker proxy fallback")
        resp = await _bounded_httpx_request(
            client, "GET", proxy_url,
            max_bytes=MAX_FICHUB_RESPONSE_BYTES,
            headers={**_fichub_headers(), **_worker_proxy_headers()},
            timeout=timeout, follow_redirects=False)
        if resp.status_code == 200:
            return resp
        log.warning("fichub: CF proxy failed with %s", resp.status_code)
    except Exception as e:
        log.warning("fichub: CF proxy fallback error: %s", e)

    # ── Last resort: direct fetch + FICHUB_TOKEN ──────────────────────────────
    token = os.environ.get("FICHUB_TOKEN", "").strip()
    if not token:
        log.warning("fichub: skipping direct fallback because FICHUB_TOKEN is not configured")
        return httpx.Response(
            status_code=502,
            content=b"FicHub proxy paths failed and FICHUB_TOKEN is not configured.",
            request=httpx.Request("GET", url),
        )

    for attempt in range(max_retries + 1):
        resp = await _bounded_httpx_request(
            client, "GET", url,
            max_bytes=MAX_FICHUB_RESPONSE_BYTES,
            verify_peer=True,
            headers=_fichub_headers(), timeout=timeout, follow_redirects=False)
        if resp.status_code != 429 or attempt == max_retries:
            return resp
        try:
            wait = float(resp.headers.get("Retry-After", "3"))
        except (TypeError, ValueError):
            wait = 3.0
        wait = min(max(wait, 1.0), 10.0)
        log.info("fichub: 429 — retrying after %.1fs (attempt %d)", wait, attempt + 1)
        await asyncio.sleep(wait)
    return resp


@app.get("/")
def read_root():
    return {"status": "Edge API Router is active."}


@app.get("/api/health")
async def health_check():
    """Lightweight liveness + config probe used by the frontend diagnostic tool."""
    uptime_sec = int(_time.time() - _startup_time)
    return {
        "status": "ok",
        "version": "v0.6.0",
        "uptime_sec": uptime_sec,
        "uptime_human": (
            f"{uptime_sec // 3600}h {(uptime_sec % 3600) // 60}m {uptime_sec % 60}s"
        ),
        "config": {
            "zyte_configured":        bool(os.environ.get("ZYTE_API_KEY")),
            "edge_proxy_configured":  bool(WORKER_PROXY_BASE),
            "vapid_configured":       bool(VAPID_PUBLIC and VAPID_PRIVATE),
            "push_lib_available":     PYWEBPUSH_AVAILABLE,
            "database_durable":       _database_durable,
        },
    }


@app.get("/api/diag/logs")
def get_server_logs(x_admin_secret: str = Header(default="")):
    if not _admin_authorized(x_admin_secret):
        raise HTTPException(status_code=403, detail="Forbidden")
    return {"logs": list(_mem_handler.log_buffer)}


def _ao3_search_payload_from_url(raw: str) -> dict:
    """Parse pasted AO3 works/search URLs into the same payload shape as fields."""
    try:
        parsed = urlparse((raw or "").strip())
    except Exception:
        return {}
    host = (parsed.hostname or "").lower().removeprefix("www.")
    if host != "archiveofourown.org" or parsed.path.rstrip("/") != "/works/search":
        return {}
    payload = {}
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        if key == "page" or key.startswith("work_search["):
            payload[key] = value
    return payload


@app.post("/api/search")
async def search_ao3(request: SearchRequest, http_request: Request):
    started = _time.time()
    search_url = "https://archiveofourown.org/works/search"
    raw_query = (request.query or "").strip()
    pasted_payload = _ao3_search_payload_from_url(raw_query)
    page = max(1, int(request.page or 1))
    if pasted_payload.get("page") and page == 1:
        try:
            page = max(1, int(pasted_payload["page"]))
        except (TypeError, ValueError):
            page = 1
    limit = min(15, max(1, int(request.limit or 15)))

    payload = {k: v for k, v in pasted_payload.items() if k != "page"}
    if raw_query and not pasted_payload:
        payload["work_search[query]"] = request.query
    if request.title:
        payload["work_search[title]"] = request.title
    if request.author:
        payload["work_search[creators]"] = request.author
    if request.fandom:
        payload["work_search[fandom_names]"] = request.fandom
    if request.rating and request.rating != "Any":
        payload["work_search[rating_ids]"] = request.rating
    if request.category and request.category != "Any":
        payload["work_search[category_ids][]"] = request.category
    if request.language and request.language != "Any":
        payload["work_search[language_id]"] = request.language
    if request.sort_column:
        payload["work_search[sort_column]"] = request.sort_column
    if request.sort_direction:
        payload["work_search[sort_direction]"] = request.sort_direction
    if request.words_min is not None:
        payload["work_search[words_from]"] = str(request.words_min)
    if request.words_max is not None:
        payload["work_search[words_to]"] = str(request.words_max)
    if request.complete == "1":
        payload["work_search[complete]"] = "1"
    if page > 1:
        payload["page"] = str(page)

    cache_key = json.dumps({"payload": payload, "page": page, "limit": limit}, sort_keys=True, separators=(",", ":")).lower()
    cached = await SEARCH_CACHE.get(cache_key)
    if cached is not None:
        return cached

    # Every cache miss spends Zyte credit against a shared egress IP, so the same
    # per-caller admission control the scrape route uses applies here too. Checked
    # AFTER the cache so a repeated query never consumes budget it does not need.
    _require_scrape_budget(
        http_request,
        detail="Too many searches — wait a moment and try again.")

    def _url_for(search_payload: dict) -> str:
        return str(httpx.URL(search_url, params=search_payload))

    def _search_response(*, results=None, status="ok", reason="", source="proxy", blocked=False, has_more=False, url=None):
        return {
            "query": request.query,
            "results": results or [],
            "page": page,
            "limit": limit,
            "has_more": bool(has_more),
            "next_page": page + 1 if has_more else None,
            "source": source,
            "elapsed_ms": int((_time.time() - started) * 1000),
            "status": status,
            "reason": reason,
            "url": url or _url_for(payload),
            "cloudflare_blocked": blocked,
        }

    def _parse_ao3_search_results(html_text: str):
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html_text, "html.parser")
        works = (soup.find_all("li", class_="work blurb group") or soup.find_all("li", class_="work") or soup.find_all("li", class_="blurb"))
        parsed_results = []
        for work in works:
            heading = work.find("h4", class_="heading")
            if not heading:
                continue
            links = heading.find_all("a")
            if not links:
                continue
            authors = [a.get_text(strip=True) for a in heading.find_all("a", rel="author")]
            if not authors:
                authors = [a.get_text(strip=True) for a in links[1:] if "works" not in a.get("href", "") and "users" in a.get("href", "")]
            fandoms_el = work.find("h5", class_="fandoms")
            stats_el = work.find("dl", class_="stats")
            tags_el = work.find("ul", class_="tags")
            words_dd = stats_el.find("dd", class_="words") if stats_el else None
            chapters_dd = stats_el.find("dd", class_="chapters") if stats_el else None
            datetime_el = work.find("p", class_="datetime")
            parsed_results.append({
                "title": links[0].get_text(strip=True),
                "url": "https://archiveofourown.org" + links[0].get("href", ""),
                "author": ", ".join(authors) if authors else "Anonymous",
                "fandoms": [a.get_text(strip=True) for a in fandoms_el.find_all("a", class_="tag")] if fandoms_el else [],
                "words": words_dd.get_text(strip=True) if words_dd else "",
                "chapters": chapters_dd.get_text(strip=True) if chapters_dd else "",
                "updated": datetime_el.get_text(strip=True) if datetime_el else "",
                "tags": [a.get_text(strip=True) for a in tags_el.find_all("a", class_="tag")] if tags_el else [],
            })
            if len(parsed_results) > limit:
                break
        has_more_results = len(parsed_results) > limit or bool(soup.find("li", class_="next"))
        return parsed_results[:limit], has_more_results

    def _looks_ao3_overloaded(html_text: str) -> bool:
        body_lower = (html_text or "")[:8000].lower()
        return (
            "retry later" in body_lower
            or "ao3 is currently down" in body_lower
            or "we're a bit busy" in body_lower
        )

    async def _run_search_candidate(search_payload: dict, source: str, reason: str = ""):
        candidate_url = _url_for(search_payload)
        html_text = await proxy_fetch(candidate_url, timeout=45)
        if html_text is None:
            return _search_response(
                status="unavailable",
                source=source,
                blocked=True,
                url=candidate_url,
                reason="AO3 search could not be reached through the configured proxy. Direct server search is disabled because AO3 blocks datacenter traffic.",
            )
        if _looks_ao3_overloaded(html_text):
            return _search_response(
                status="overloaded",
                source=source,
                blocked=True,
                url=candidate_url,
                reason="AO3 is currently overloaded. Try again in a minute.",
            )
        parsed_results, has_more_results = _parse_ao3_search_results(html_text)
        return _search_response(
            results=parsed_results,
            status="ok",
            has_more=has_more_results,
            source=source,
            reason=reason,
            url=candidate_url,
        )

    def _empty_result_fallback_payloads():
        pasted_query = (pasted_payload.get("work_search[query]") or "").strip() if pasted_payload else ""
        query_text = (pasted_query or raw_query).strip()
        if not query_text:
            return []
        if request.title or request.author or request.fandom:
            return []
        if any(payload.get(key) for key in (
            "work_search[title]",
            "work_search[creators]",
            "work_search[fandom_names]",
            "work_search[freeform_names]",
            "work_search[character_names]",
            "work_search[relationship_names]",
        )):
            return []
        if len(query_text) > 80 or query_text.startswith("http"):
            return []
        base = dict(payload)
        base.pop("page", None)
        if page > 1:
            return []
        candidates = []
        tag_payload = dict(base)
        tag_payload.pop("work_search[query]", None)
        tag_payload["work_search[freeform_names]"] = query_text
        candidates.append((tag_payload, "proxy:fallback-freeform", "Primary AO3 search was empty; retried as an exact freeform tag search."))

        fandom_payload = dict(base)
        fandom_payload.pop("work_search[query]", None)
        fandom_payload["work_search[fandom_names]"] = query_text
        candidates.append((fandom_payload, "proxy:fallback-fandom", "Primary AO3 search was empty; retried as an exact fandom search."))

        if base.get("work_search[sort_column]") == "revised_at":
            published_payload = dict(base)
            published_payload["work_search[sort_column]"] = "created_at"
            candidates.append((published_payload, "proxy:fallback-created-at", "Primary AO3 search was empty; retried with Date Published sorting."))

        seen = set()
        unique = []
        for candidate_payload, source, reason in candidates:
            if page > 1:
                candidate_payload["page"] = str(page)
            key = json.dumps(candidate_payload, sort_keys=True, separators=(",", ":"))
            if key in seen:
                continue
            seen.add(key)
            unique.append((candidate_payload, source, reason))
        return unique

    try:
        primary_out = await _run_search_candidate(payload, "proxy")
        if primary_out["status"] != "ok":
            ttl = SEARCH_OVERLOAD_TTL_SECONDS if primary_out["status"] == "overloaded" else SEARCH_NEGATIVE_TTL_SECONDS
            await SEARCH_CACHE.put(cache_key, primary_out, ttl_seconds=ttl)
            return primary_out

        if primary_out["results"]:
            await SEARCH_CACHE.put(cache_key, primary_out, ttl_seconds=SEARCH_POSITIVE_TTL_SECONDS)
            return primary_out

        for fallback_payload, source, reason in _empty_result_fallback_payloads():
            fallback_out = await _run_search_candidate(fallback_payload, source, reason)
            if fallback_out["status"] == "ok" and fallback_out["results"]:
                await SEARCH_CACHE.put(cache_key, fallback_out, ttl_seconds=SEARCH_POSITIVE_TTL_SECONDS)
                return fallback_out
            if fallback_out["status"] == "overloaded":
                payload_out = fallback_out
                await SEARCH_CACHE.put(cache_key, payload_out, ttl_seconds=SEARCH_OVERLOAD_TTL_SECONDS)
                return payload_out

        payload_out = primary_out
        await SEARCH_CACHE.put(cache_key, payload_out)
        return payload_out
    except (httpx.ConnectError, httpx.TimeoutException):
        payload_out = _search_response(status="timeout", blocked=True, reason="Network error reaching AO3 - site may be temporarily down")
        await SEARCH_CACHE.put(cache_key, payload_out, ttl_seconds=SEARCH_NEGATIVE_TTL_SECONDS)
        return payload_out
    except httpx.HTTPStatusError as e:
        payload_out = _search_response(status="http_error", blocked=True, reason=f"AO3 returned HTTP {e.response.status_code} - it may be blocking automated requests")
        await SEARCH_CACHE.put(cache_key, payload_out, ttl_seconds=SEARCH_NEGATIVE_TTL_SECONDS)
        return payload_out
    except Exception:
        safe_http_error("AO3 search failed")


# Curated-library response cache. The curated files are static (shipped with
# the app), so the listing only changes on deploy. We cache the built payload
# and invalidate it via a cheap stat signature (name + mtime + size) instead of
# re-opening every PDF on each request. The lock serializes rebuilds so a burst
# of requests right after a cold start can't trigger a thundering herd of opens.
_curated_cache = {"sig": None, "payload": None}
_curated_cache_lock = threading.Lock()

_WITHDRAWN_TITLE_HASHES = {2097602949, 4010063105, 498652239, 3528427211}
_WITHDRAWN_AUTHOR_HASHES = {1741912528}
_WITHDRAWN_FILE_HASHES = {586215127, 4227966908}


def _withdrawn_hash(value: str) -> int:
    normalized = re.sub(r"[^a-z0-9]+", "", str(value or "").lower())
    h = 5381
    for ch in normalized:
        h = ((h << 5) + h) ^ ord(ch)
        h &= 0xFFFFFFFF
    return h


def _curated_is_withdrawn(*, title: str = "", author: str = "", filename: str = "") -> bool:
    if filename and _withdrawn_hash(filename) in _WITHDRAWN_FILE_HASHES:
        return True
    if title and _withdrawn_hash(title) in _WITHDRAWN_TITLE_HASHES:
        return True
    if author and _withdrawn_hash(author) in _WITHDRAWN_AUTHOR_HASHES:
        return True
    return False


def _curated_dir_signature():
    sig = []
    for f in sorted(CURATED_DIR.glob("*")):
        if f.suffix.lower() in (".pdf", ".json", ".epub", ".html", ".txt"):
            if _curated_is_withdrawn(filename=f.name):
                continue
            try:
                st = f.stat()
                sig.append((f.name, st.st_mtime_ns, st.st_size))
            except OSError:
                sig.append((f.name, 0, 0))
    return tuple(sig)


def _curated_pdf_info(path: pathlib.Path) -> dict:
    """Open a curated PDF exactly once and return title/author/pages/source_url.
    Avoids opening the same file three times per request (metadata + page count +
    AO3 source-URL scan), which is costly at cold-start on the free tier."""
    info = {"title": "", "author": "", "pages": 0, "source_url": ""}
    try:
        import pypdfium2 as pdfium
        import re
        ao3_re = re.compile(r"https?://(?:www\.)?archiveofourown\.org/works/\d+")
        pdf = pdfium.PdfDocument(str(path))
        try:
            meta = pdf.get_metadata_dict() or {}
            info["title"] = (meta.get("Title") or "").strip()
            info["author"] = (meta.get("Author") or "").strip()
            info["pages"] = len(pdf)
            text = ""
            for i in range(min(2, len(pdf))):
                page = pdf[i]
                try:
                    tp = page.get_textpage()
                    try:
                        text += tp.get_text_range() or ""
                    finally:
                        tp.close()
                finally:
                    page.close()
                if len(text) > 4000:
                    break
            m = ao3_re.search(text)
            info["source_url"] = m.group(0) if m else ""
        finally:
            pdf.close()
    except Exception:
        pass
    return info


def _build_curated_payload():
    items = []
    for f in sorted(CURATED_DIR.glob("*")):
        if f.suffix.lower() not in [".pdf", ".json", ".epub", ".html", ".txt"]:
            continue
        if _curated_is_withdrawn(filename=f.name):
            continue
        if f.suffix.lower() == ".json":
            try:
                with open(f, "r", encoding="utf-8") as jf:
                    data = json.load(jf)
                if _curated_is_withdrawn(
                    title=data.get("title", f.stem),
                    author=data.get("author", "Unknown"),
                    filename=f.name,
                ):
                    continue
                items.append({
                    "id": f.name,
                    "title": data.get("title", f.stem),
                    "author": data.get("author", "Unknown"),
                    "pages": len(data.get("chapters", [])),
                    "url": f"/api/library/curated/{f.name}",
                    "source_url": data.get("source_url", ""),
                })
            except Exception:
                pass
        elif f.suffix.lower() == ".pdf":
            info = _curated_pdf_info(f)  # single open: metadata + pages + source_url
            title = info["title"] or f.stem.replace("_", " ")
            author = info["author"] or "Unknown"
            if _curated_is_withdrawn(title=title, author=author, filename=f.name):
                continue
            items.append({
                "id": f.name,
                "title": title,
                "author": author,
                "pages": info["pages"],
                "url": f"/api/library/curated/{f.name}",
                "source_url": info["source_url"],
            })
    return {"items": items, "count": len(items)}




@app.get("/api/library/curated")
def list_curated_library():
    try:
        sig = _curated_dir_signature()
        # Fast path: return cached payload under lock (no I/O while holding lock)
        with _curated_cache_lock:
            if _curated_cache["sig"] == sig and _curated_cache["payload"] is not None:
                return _curated_cache["payload"]
        # Slow path: build payload outside the lock so concurrent requests don't queue
        # behind PDF I/O. A second thread may build concurrently — last-writer wins,
        # which is safe since both produce the same result for the same sig.
        payload = _build_curated_payload()
        with _curated_cache_lock:
            _curated_cache["payload"] = payload
            _curated_cache["sig"] = sig
        return payload
    except Exception:
        safe_http_error("Failed to list library")


@app.get("/api/library/curated/{filename}/download")
def download_curated_file(filename: str, request: Request):
    if _curated_is_withdrawn(filename=filename):
        raise HTTPException(status_code=404)
    path = _safe_curated_pdf_path(filename)
    if not path.exists():
        raise HTTPException(status_code=404)
    # Metered like its sibling fetch_curated_story: these are local files rather
    # than upstream fetches, but serving whole PDFs unthrottled is the one
    # curated route that can burn bandwidth without limit.
    _require_scrape_budget(request)
    return FileResponse(path)



@app.get("/api/library/curated/{filename}")
def fetch_curated_story(filename: str, request: Request):
    if _curated_is_withdrawn(filename=filename):
        raise HTTPException(status_code=404)
    path = _safe_curated_pdf_path(filename)
    if not path.exists():
        raise HTTPException(status_code=404)
    _require_scrape_budget(request)
    try:
        if path.suffix.lower() == ".json":
            with open(path, "r", encoding="utf-8") as jf:
                data = json.load(jf)
            if _curated_is_withdrawn(
                title=data.get("title", ""),
                author=data.get("author", ""),
                filename=filename,
            ):
                raise HTTPException(status_code=404)
            return data
        else:
            # For PDFs, read metadata + source URL in one open (parse_file still
            # opens once more to extract chapters — that open is unavoidable here).
            if path.suffix.lower() == ".pdf":
                info = _curated_pdf_info(path)
                meta = {"title": info["title"], "author": info["author"]}
                source_url = info["source_url"]
            else:
                meta = parsers_dispatcher.extract_metadata(path) or {}
                source_url = ""  # non-PDF/JSON formats have no embedded AO3 source URL
            chapters = parsers_dispatcher.parse_file(str(path))
            title = (meta.get("title") or "").strip() or path.stem.replace("_", " ")
            author = (meta.get("author") or "").strip() or "Unknown"
            if _curated_is_withdrawn(title=title, author=author, filename=filename):
                raise HTTPException(status_code=404)
            chapters = sanitize_narration_chapters(
                chapters, story_title=title, author=author)
            words = sum(len(p.split())
                        for ch in chapters for p in (ch.paragraphs or []))
            return {
                "title": title,
                "author": author,
                "words": words,
                "source_url": source_url,
                "chapters": [asdict(ch) for ch in chapters],
            }
    except HTTPException:
        raise
    except Exception:
        safe_http_error("Failed to parse curated file")


@app.get("/api/ao3/chapter_count")
async def ao3_chapter_count(url: str, request: Request):
    """Authoritative published-chapter count for an AO3 work so the client can
    distinguish a real update from re-parse noise (different segmentation, an
    intro page, etc.). Routes through Zyte — the hosting datacenter IP is
    Cloudflare-blocked for direct AO3 requests — and falls back to a direct
    fetch. Returns {"count": int|null}."""
    import re as _re
    # SSRF guard: extract the numeric work id and rebuild a canonical AO3 URL, then
    # fetch ONLY that. Never fetch the raw client-supplied string — a substring
    # check would let "http://169.254.169.254/?x=archiveofourown.org/works/" through
    # to the direct (unguarded, redirect-following) fetch below.
    m = _re.search(r"archiveofourown\.org/works/(\d+)", url or "")
    if not m:
        return {"count": None}
    _require_scrape_budget(request)
    safe_url = f"https://archiveofourown.org/works/{m.group(1)}"
    try:
        html = await proxy_fetch(safe_url, timeout=15)  # match the search path's timeout
        if html:
            count, total = parse_ao3_chapter_info(html)
            if count is not None:
                return {"count": count, "total": total, "source": "zyte"}
    except Exception:
        pass
    
    # In production, direct fetch from datacenter to AO3 is 100% Cloudflare blocked.
    # Bypassing the direct fallback prevents an extra 15-second gateway timeout.
    if os.environ.get("ZYTE_API_KEY"):
        return {"count": None}

    try:
        count = await ao3_published_chapter_count(safe_url)
        return {"count": count, "total": None, "source": "direct"}
    except CloudflareBlocked:
        return {"count": None, "blocked": True}
    except Exception:
        return {"count": None}


# /api/masterlist is retired, not merely unused.
#
# It served backend/masterlist.json -- a file whose stories array is empty --
# while the frontend reads the real catalog straight from the published
# Anthronomicon index and caches it against that build hash. The route, the
# empty data file and the MASTERLIST_CACHE that fronted it were all dead.
#
# 410 rather than deletion, so an old cached frontend gets a definite answer
# instead of an HTML error page it would try to parse as JSON.
@app.get("/api/masterlist")
async def fetch_masterlist():
    raise HTTPException(
        status_code=410,
        detail="The masterlist is served by the Anthronomicon index, not this API.")


@app.get("/api/state/load/{user_id}")
async def load_user_state(user_id: str):
    # Cloud sync runs through Supabase, not this API. These endpoints predate it
    # and were an IDOR surface (any caller could read any user_id), so they stay
    # an explicit 410 for old clients. There is no matching save route: the note
    # here used to point at a save_user_state() that does not exist, and to call
    # sync "not wired up yet", which stopped being true when Supabase landed.
    raise HTTPException(status_code=410, detail="Cloud sync is not available.")


@app.post("/api/subscribe")
async def subscribe(sub: PushSubscription, request: Request):
    if _db_conn is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    _validate_push_identity(sub.user_id)
    _validate_push_subscription(sub.subscription)
    if not _check_subscribe_rate(_client_ip(request)):
        raise HTTPException(status_code=429, detail="Too many subscription requests. Try again later.")
    try:
        sanitized_profile = _sanitize_push_profile(sub.profile)
        issued_token = None
        async with _db_lock:
            async with _db_conn.execute(
                "SELECT subscription_json, auth_token_hash FROM subscriptions WHERE user_id = ?",
                (sub.user_id,),
            ) as cursor:
                existing = await cursor.fetchone()
            if existing:
                stored_subscription = json.loads(existing[0])
                stored_hash = existing[1]
                if stored_hash:
                    supplied_hash = _push_token_hash(sub.auth_token or "")
                    if not hmac.compare_digest(stored_hash, supplied_hash):
                        raise HTTPException(status_code=403, detail="Push subscription ownership check failed")
                    token_hash = stored_hash
                else:
                    # One-time migration for pre-token subscriptions: the browser
                    # must prove possession of the exact existing endpoint + keys.
                    if not _same_push_subscription(stored_subscription, sub.subscription):
                        raise HTTPException(status_code=409, detail="Legacy push subscription must be re-enabled")
                    issued_token = secrets.token_urlsafe(32)
                    token_hash = _push_token_hash(issued_token)
            else:
                issued_token = secrets.token_urlsafe(32)
                token_hash = _push_token_hash(issued_token)
            await _db_conn.execute(
                "INSERT OR REPLACE INTO subscriptions "
                "(user_id, subscription_json, created_at, auth_token_hash) "
                "VALUES (?, ?, strftime('%s','now'), ?)",
                (sub.user_id, json.dumps(sub.subscription), token_hash),
            )
            if sanitized_profile is not None:
                profile_json = json.dumps(sanitized_profile)
                await _db_conn.execute(
                    "INSERT OR REPLACE INTO user_state "
                    "(user_id, profile_json, updated_at, size_bytes) "
                    "VALUES (?, ?, strftime('%s','now'), ?)",
                    (sub.user_id, profile_json, len(profile_json.encode("utf-8"))),
                )
            else:
                await _db_conn.execute(
                    "DELETE FROM user_state WHERE user_id = ?",
                    (sub.user_id,),
                )
            await _db_conn.commit()
    except HTTPException:
        raise
    except Exception as e:
        safe_http_error(f"Failed to subscribe: {e}", "Could not save subscription", 500)
    response = {"status": "subscribed"}
    if issued_token:
        response["auth_token"] = issued_token
    return response


@app.post("/api/unsubscribe")
async def unsubscribe(req: UnsubscribeRequest):
    if _db_conn is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    _validate_push_identity(req.user_id)
    try:
        async with _db_lock:
            async with _db_conn.execute(
                "SELECT auth_token_hash FROM subscriptions WHERE user_id = ?",
                (req.user_id,),
            ) as cursor:
                existing = await cursor.fetchone()
            if existing and (
                not existing[0]
                or not hmac.compare_digest(existing[0], _push_token_hash(req.auth_token or ""))
            ):
                raise HTTPException(status_code=403, detail="Push subscription ownership check failed")
            async with _db_conn.execute(
                "DELETE FROM subscriptions WHERE user_id = ?", (req.user_id,)) as cursor:
                deleted = cursor.rowcount
            await _delete_push_owner_data(req.user_id, delete_subscription=False)
            await _db_conn.commit()
    except HTTPException:
        raise
    except Exception as e:
        safe_http_error(f"Failed to unsubscribe: {e}", "Could not remove subscription", 500)
    return {
        "status": "unsubscribed" if deleted else "not_found",
        "deleted": deleted}


SYNC_MIN_INTERVAL_SEC = int(os.environ.get("SYNC_MIN_INTERVAL_SEC", 30 * 60))
SYNC_MAX_STORIES_PER_SWEEP = int(
    os.environ.get(
        "SYNC_MAX_STORIES_PER_SWEEP", 50))
_last_sync_ts: float = 0.0
_sync_lock = asyncio.Lock()


async def _delete_push_owner_data(
        user_id: str,
        *,
        delete_subscription: bool = True) -> None:
    if _db_conn is None:
        return
    if delete_subscription:
        await _db_conn.execute(
            "DELETE FROM subscriptions WHERE user_id = ?", (user_id,))
    await _db_conn.execute(
        "DELETE FROM user_state WHERE user_id = ?", (user_id,))


async def _send_new_chapter_push(
        user_id: str,
        subscription_json: str,
        story_title: str,
        story_url: str,
        new_count: int,
        story_key: str = "") -> bool:
    if not PYWEBPUSH_AVAILABLE or not VAPID_PRIVATE:
        return False
    try:
        payload = {
            "title": "Alpharius' Pocket Reader",
            "body": f"New chapter: {story_title} (now {new_count} chapters)",
            "url": story_url,
            "type": "story-update",
            "storyUrl": story_url,
            "storyKey": story_key}
        await asyncio.to_thread(
            webpush,
            subscription_info=json.loads(subscription_json),
            data=json.dumps(payload),
            vapid_private_key=VAPID_PRIVATE,
            vapid_claims={"sub": VAPID_SUB},
        )
        return True
    except WebPushException as e:
        status = getattr(
            e.response,
            "status_code",
            None) if e.response is not None else None
        if status in (404, 410):
            try:
                async with _db_lock:
                    await _delete_push_owner_data(user_id)
                    await _db_conn.commit()
            except Exception as prune_err:
                log.warning("Push cleanup failed for %s: %s", user_id, prune_err)
        return False
    except Exception:
        return False


async def _ao3_chapter_count_via_proxy(url: str) -> Optional[int]:
    html = await proxy_fetch(url, timeout=15)
    if not html:
        return None
    return parse_published_chapter_count(html)


async def _run_chapter_sync_sweep() -> dict:
    checked, pushes_queued, skipped_no_state, skipped_no_url = 0, 0, 0, 0
    chapter_count_cache: dict = {}
    cf_aborted = False

    async with _db_lock:
        async with _db_conn.execute("SELECT user_id, subscription_json FROM subscriptions") as cur:
            subs = await cur.fetchall()
        async with _db_conn.execute("SELECT user_id, profile_json FROM user_state") as cur:
            states = {row[0]: row[1] for row in await cur.fetchall()}

    updated_states: dict[str, dict] = {}
    for user_id, sub_json in subs:
        if checked >= SYNC_MAX_STORIES_PER_SWEEP or cf_aborted:
            break
        profile_json = states.get(user_id)
        if not profile_json:
            skipped_no_state += 1
            continue
        try:
            profile = json.loads(profile_json)
        except Exception:
            continue

        library = (profile or {}).get("library") or []
        for story in library:
            if checked >= SYNC_MAX_STORIES_PER_SWEEP or cf_aborted:
                break
            url = (story or {}).get("url") or ""
            if not story.get("update_subscribed") or not url or "archiveofourown.org" not in url:
                skipped_no_url += 1
                continue
            stored_count = int(story.get("published_chapters") or 0)
            try:
                if url in chapter_count_cache:
                    current = chapter_count_cache[url]
                else:
                    current = await _ao3_chapter_count_via_proxy(url)
                    chapter_count_cache[url] = current
                    checked += 1
            except CloudflareBlocked:
                cf_aborted = True
                break
            except Exception:
                continue

            if current is None or current <= stored_count:
                continue
            if await _send_new_chapter_push(
                    user_id,
                    sub_json,
                    story.get("title") or "your story",
                    url,
                    current,
                    str(story.get("story_key") or "")):
                story["published_chapters"] = current
                updated_states[user_id] = json.loads(json.dumps(profile))
                pushes_queued += 1

    if updated_states:
        async with _db_lock:
            for user_id, profile in updated_states.items():
                profile_json = json.dumps(_sanitize_push_profile(profile) or {"library": []})
                await _db_conn.execute(
                    "UPDATE user_state SET profile_json = ?, updated_at = strftime('%s','now'), size_bytes = ? "
                    "WHERE user_id = ?",
                    (profile_json, len(profile_json.encode("utf-8")), user_id),
                )
            await _db_conn.commit()

    return {
        "status": "ok",
        "checked": checked,
        "pushes_queued": pushes_queued,
        "skipped_no_state": skipped_no_state,
        "skipped_no_url": skipped_no_url,
        "cloudflare_aborted": cf_aborted}


SITE_HEALTH_CACHE_TTL_SEC = int(
    os.environ.get(
        "SITE_HEALTH_CACHE_TTL_SEC",
        5 * 60))
SITE_HEALTH_CACHE = TTLCache(
    max_entries=1,
    ttl_seconds=SITE_HEALTH_CACHE_TTL_SEC,
    label="health")
SITE_HEALTH_REFRESH_LOCK = asyncio.Lock()

_HEALTH_TARGETS = [("Archive of Our Own",
                    "https://archiveofourown.org/",
                    {"accepted_tos": "true",
                     "view_adult": "true"},
                    "archiveofourown.org"),
                   ("Royal Road",
                    "https://www.royalroad.com/",
                    {},
                    "royalroad.com"),
                   ("Wattpad",
                    "https://www.wattpad.com/",
                    {},
                    "wattpad.com"),
                   ("FurAffinity",
                    "https://www.furaffinity.net/",
                    {},
                    "furaffinity.net"),
                   ("SoFurry",
                    "https://www.sofurry.com/",
                    {},
                    "sofurry.com"),
                   ]


async def _probe_site(label: str, url: str, cookies: dict, domain: str) -> dict:
    try:
        async with make_client(timeout=6) as client:
            for k, v in cookies.items():
                client.cookies.set(k, v, domain=domain)
            async with client.stream("GET", url) as resp:
                body = bytearray()
                async for chunk in resp.aiter_bytes():
                    remaining = 8192 - len(body)
                    if remaining <= 0:
                        break
                    body.extend(chunk[:remaining])
                    if len(body) >= 8192:
                        break
                body_preview = body.decode(
                    resp.encoding or "utf-8",
                    errors="replace")
                sc = resp.status_code
                is_err = resp.is_error
                cf = detect_cloudflare(resp, body_preview)
    except Exception as e:
        return {"site": label, "status": "unreachable", "note": str(e)[:80]}

    if cf:
        return {"site": label, "status": "cloudflare", "note": cf}

    if sc == 429:
        return {"site": label, "status": "rate_limited", "detail": f"HTTP {sc}"}
    if sc in (401, 403):
        return {"site": label, "status": "login_required", "detail": f"HTTP {sc}"}
    if 500 <= sc < 600:
        return {"site": label, "status": "server_error", "detail": f"HTTP {sc}"}
    if is_err:
        return {"site": label, "status": "http_error", "detail": f"HTTP {sc}"}

    body_lower = body_preview.lower()
    if domain == "furaffinity.net" and ("you must be logged in" in body_lower):
        return {
            "site": label,
            "status": "login_required",
            "note": "site shows login wall"}
    if domain == "sofurry.com" and "please log in" in body_lower:
        return {
            "site": label,
            "status": "login_required",
            "note": "site shows login wall"}

    return {"site": label, "status": "ok"}


@app.get("/api/ao3")
async def fetch_ao3_story(url: str, request: Request):
    """Fetch and parse an AO3 story, entirely server-side.

    NOT on the web app's current path: the frontend ingests AO3 through
    /api/scrape, FicHub, and /api/upload. This is the server-side fallback and
    the manual entry point, kept because it is the only route that can reach a
    work when the browser-side chain is blocked. It is origin-gated and consumes
    the shared scrape budget like every other ingest route.

    Strategy 1 (primary): Download the EPUB directly from AO3's own download button.
      AO3 exposes a /downloads/{id}/title.epub link on every work page; we scrape
      that link then fetch the file — no third-party service required.

    Strategy 2 (fallback): FicHub API (fichub.net/api/v0/epub).
      Used only when AO3 direct download is blocked or fails.

    Cloudflare Workers cannot proxy to other CF-protected sites, so both strategies
    run from the backend server IP with browser-spoofing headers.
    """
    import re as _re
    from bs4 import BeautifulSoup

    # ── Normalise URL ──────────────────────────────────────────────────────────
    # Strip /chapters/NNN, query strings (?view_full_work=true etc.), fragments
    url = url.strip()
    url = _re.sub(r'/chapters/\d+.*$', '', url)
    url = url.split('?')[0].split('#')[0]

    if not url or "archiveofourown.org/works/" not in url:
        raise HTTPException(
            status_code=400,
            detail="Invalid AO3 URL — must contain archiveofourown.org/works/")

    work_id_match = _re.search(r'/works/(\d+)', url)
    if not work_id_match:
        raise HTTPException(status_code=400, detail="Could not extract work ID from URL")
    work_id = work_id_match.group(1)
    canonical_url = f"https://archiveofourown.org/works/{work_id}"

    cached = await SCRAPE_CACHE.get(canonical_url)
    if cached is not None:
        return cached

    _require_scrape_budget(request)

    epub_bytes: Optional[bytes] = None
    fichub_meta: Optional[dict] = None

    # FicHub source code (github.com/FicHub/fichub.net) shows that err=-9 is
    # WebError.internal_datacenter — they block cloud IPs unless a valid
    # Authorization: Bearer TOKEN header is present.  Set FICHUB_TOKEN in HF
    # Space secrets to enable authenticated requests from this server.
    _has_token = bool(os.environ.get("FICHUB_TOKEN", "").strip())

    # ── Strategy 1: FicHub (primary) ──────────────────────────────────────────
    # FicHub hosts their own EPUB repository.  When the story is cached the
    # response is instant and never touches AO3.  With a valid Bearer token
    # datacenter IPs (err=-9) are allowed through.  All requests carry a custom
    # User-Agent and honour 429/Retry-After per FicHub's API rules.
    log.info("ao3: strategy 1 — FicHub%s for work %s",
             " (authenticated)" if _has_token else " (unauthenticated)", work_id)
    try:
        fichub_api = f"https://fichub.net/api/v0/epub?q=archiveofourown.org/works/{work_id}"
        async with make_client(timeout=60) as client:
            fh_resp = await _fichub_get(client, fichub_api, timeout=30)
            if fh_resp.status_code == 200:
                try:
                    fh_data = fh_resp.json()
                except Exception:
                    fh_data = {}
                log.info("ao3: FicHub response err=%s", fh_data.get("err"))
                if fh_data.get("err") == 0:
                    fichub_meta = fh_data.get("meta")  # authoritative title/author/etc.
                    epub_path = fh_data.get("epub_url") or fh_data.get("html_url")
                    if epub_path:
                        dl_url = f"https://fichub.net{epub_path}"
                        log.info("ao3: downloading EPUB from FicHub at %s", dl_url)
                        dl_resp = await _fichub_get(client, dl_url, timeout=60)
                        if dl_resp.is_success and len(dl_resp.content) > 1000:
                            epub_bytes = dl_resp.content
                            log.info("ao3: FicHub download OK (%d bytes)", len(epub_bytes))
                        else:
                            log.warning("ao3: FicHub EPUB fetch HTTP %s / %d bytes",
                                        dl_resp.status_code, len(dl_resp.content))
                else:
                    err_code = fh_data.get("err")
                    log.warning("ao3: FicHub err=%s — %s",
                                err_code,
                                "datacenter IP blocked (set FICHUB_TOKEN env var to fix)"
                                if err_code == -9 else fh_data.get("msg", "?"))
            else:
                log.warning("ao3: FicHub API HTTP %s", fh_resp.status_code)
    except Exception as exc:
        log.warning("ao3: strategy 1 (FicHub) failed: %s", exc)

    # ── Strategy 2: Direct AO3 EPUB download (fallback) ───────────────────────
    # AO3 exposes a /downloads/{id}/title.epub link on every work page.
    # Will fail if AO3's Cloudflare shield blocks the HF server IP.
    if epub_bytes is None:
        log.info("ao3: strategy 2 — direct AO3 EPUB download via proxy for work %s", work_id)
        try:
            # 1. Fetch work page HTML via proxy (Zyte or CF Worker fallback)
            html = await proxy_fetch(canonical_url, timeout=25)

            # If proxy works and returns HTML, find the EPUB download link
            if html:
                soup = BeautifulSoup(html, "html.parser")
                epub_href = None
                for a in soup.find_all("a", href=True):
                    h = a["href"]
                    if "/downloads/" in h and ".epub" in h:
                        epub_href = h
                        break

                if epub_href:
                    epub_url = (epub_href if epub_href.startswith("http")
                                else "https://archiveofourown.org" + epub_href)
                    log.info("ao3: downloading EPUB from AO3 via proxy at %s", epub_url)
                    # 2. Fetch the EPUB bytes via proxy
                    epub_bytes = await proxy_fetch_binary(epub_url, timeout=45)
                    if epub_bytes and len(epub_bytes) > 1000:
                        log.info("ao3: AO3 direct download via proxy OK (%d bytes)", len(epub_bytes))
                    else:
                        epub_bytes = None
                        log.warning("ao3: AO3 direct download via proxy returned invalid body")
                else:
                    log.warning("ao3: no EPUB download link found on work page via proxy")
            else:
                log.warning("ao3: proxy fetch returned no HTML for work page")
        except Exception as exc:
            log.warning("ao3: strategy 2 (AO3 EPUB fetch via proxy) failed: %s", exc)

    if epub_bytes is None:
        raise HTTPException(
            status_code=502,
            detail=(
                "Could not retrieve this AO3 work — AO3's Cloudflare shield is blocking "
                "automated downloads and FicHub is also unavailable. "
                "Download the EPUB from AO3 directly and upload it via 📂 Open File."
            ))

    _max_epub_bytes = int(os.environ.get("MAX_EPUB_BYTES", 60 * 1024 * 1024))
    if len(epub_bytes) > _max_epub_bytes:
        raise HTTPException(
            status_code=413,
            detail="Retrieved EPUB is too large to process.")

    # ── Parse the EPUB ─────────────────────────────────────────────────────────
    with tempfile.TemporaryDirectory() as tmpdir:
        local_path = os.path.join(tmpdir, "story.epub")
        with open(local_path, "wb") as f:
            f.write(epub_bytes)
        try:
            meta     = await asyncio.to_thread(parsers_dispatcher.extract_metadata, local_path)
            chapters = await asyncio.to_thread(parsers_dispatcher.parse_file, local_path)
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"EPUB parse failed: {str(exc)[:120]}")

    # Prefer FicHub's authoritative metadata over EPUB-parsed values when available.
    _fm = fichub_meta or {}
    _fm_title  = (_fm.get("title")  or "").strip()
    _fm_author = (_fm.get("author") or "").strip()
    _fm_desc   = _fm.get("description") or ""
    if _fm_desc:
        import re as _re2
        _fm_desc = _re2.sub(r"<[^>]+>", " ", _fm_desc)
        _fm_desc = _re2.sub(r"\s+", " ", _fm_desc).strip()

    title_val = _fm_title or ((meta.get("title") or "").strip()) or ""
    author_val = _fm_author or ((meta.get("author") or "Unknown").strip())
    chapters = sanitize_narration_chapters(
        chapters, story_title=title_val, author=author_val)

    result = {
        "title":    title_val,
        "author":   author_val,
        "url":      canonical_url,
        "chapters": [asdict(ch) for ch in chapters],
    }
    if _fm_desc:               result["synopsis"] = _fm_desc
    if _fm.get("words"):       result["words"]    = f"{_fm['words']:,}"
    if _fm.get("status"):      result["status"]   = _fm["status"]
    if _fm.get("extraMeta"):   result["extraMeta"] = _fm["extraMeta"]

    await SCRAPE_CACHE.put(canonical_url, result)
    log.info("ao3: parsed %d chapters for '%s'", len(result["chapters"]), result["title"])
    return result


def _scrape_result_payload(result: ScrapeResult, url: str) -> dict:
    """Shape a ScrapeResult into the story object the reader consumes."""
    chapters = sanitize_narration_chapters(
        list(result.chapters or []),
        story_title=result.title or "",
        author=result.author or "",
    )
    if not chapters:
        raise HTTPException(
            status_code=422,
            detail="No readable story text could be extracted from this page.")
    words = sum(len(p.split()) for ch in chapters for p in (ch.paragraphs or []))
    payload = {
        "title": (result.title or "").strip() or "Untitled",
        "author": (result.author or "").strip() or "Unknown",
        "url": url,
        "words": f"{words:,}",
        "chapters": [asdict(ch) for ch in chapters],
    }
    if result.synopsis:
        payload["synopsis"] = result.synopsis
    if result.artwork_url:
        payload["artwork_url"] = result.artwork_url
    for field_name in ("genres", "fandoms", "additional_tags"):
        value = getattr(result, field_name, None)
        if value:
            payload[field_name] = list(value)
    if result.content_rating:
        payload["content_rating"] = result.content_rating
    return payload


@app.post("/api/scrape")
async def scrape_story(req: ScrapeRequest, request: Request):
    """Fetch and parse a story from a supported site.

    Primary ingestion path for every non-AO3 source, and the AO3 fallback when
    FicHub is unavailable. Admission control is deliberate: the shared egress IP
    is the scarce resource, so this is rate limited per caller and bounded by a
    global concurrency semaphore before any outbound request is made.
    """
    url = (req.url or "").strip()
    if not is_valid_url(url):
        raise HTTPException(
            status_code=400,
            detail="Invalid URL format — provide a public http(s) address.")
    try:
        # Resolves the hostname and rejects private/loopback/link-local targets.
        # Redirect hops are re-validated inside scrapers_core.fetch().
        await asyncio.to_thread(assert_public_url, url)
    except RuntimeError:
        raise HTTPException(
            status_code=400,
            detail="That address is not reachable from this service.")

    cache_key = url.split("#")[0]
    cached = await SCRAPE_CACHE.get(cache_key)
    if cached is not None:
        return cached

    _require_scrape_budget(request)

    cookies = req.cookies if isinstance(req.cookies, dict) else None
    try:
        async with _SCRAPE_CONCURRENCY:
            result = await scrape_url(url, cookies)
    except CloudflareBlocked as exc:
        # A soft response, not an error: the frontend renders its "save the page
        # and upload it" recovery flow off this flag.
        return {
            "cloudflare_blocked": True,
            "reason": str(exc) or "The site's bot shield blocked this request.",
            "url": url,
        }
    except HTTPException:
        raise
    except RuntimeError as exc:
        raise HTTPException(status_code=422, detail=str(exc)[:200])
    except Exception:
        safe_http_error(
            f"scrape failed for {url[:120]}",
            "Could not read this story. The site may be down or blocking us.",
            status_code=502)

    payload = _scrape_result_payload(result, url)
    await SCRAPE_CACHE.put(cache_key, payload)
    log.info("scrape: parsed %d chapters for '%s'",
             len(payload["chapters"]), payload["title"])
    return payload


MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", 50 * 1024 * 1024))
_UPLOAD_SUFFIXES = {".pdf", ".epub", ".docx", ".txt", ".html", ".htm"}


@app.post("/api/upload")
async def upload_document(request: Request, file: UploadFile = File(...)):
    """Parse an uploaded document into chapters.

    Also the parse step of the AO3 FicHub path: the client downloads the EPUB
    and posts it here rather than parsing a zip container in the browser.
    """
    _require_scrape_budget(request)
    filename = os.path.basename(file.filename or "").strip() or "document"
    suffix = pathlib.Path(filename).suffix.lower()
    if suffix not in _UPLOAD_SUFFIXES:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type '{suffix or filename}'. "
                   "Supported: EPUB, PDF, DOCX, TXT, HTML.")

    # Stream to disk with a hard ceiling so a large upload can never be buffered
    # whole in memory before the size is known (Content-Length is not trusted).
    with tempfile.TemporaryDirectory() as tmpdir:
        local_path = os.path.join(tmpdir, f"upload{suffix}")
        total = 0
        try:
            with open(local_path, "wb") as out:
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_UPLOAD_BYTES:
                        raise HTTPException(
                            status_code=413,
                            detail=f"File is too large (limit "
                                   f"{MAX_UPLOAD_BYTES // (1024 * 1024)} MB).")
                    out.write(chunk)
        finally:
            await file.close()

        if total == 0:
            raise HTTPException(status_code=400, detail="The uploaded file is empty.")

        try:
            meta = await asyncio.to_thread(
                parsers_dispatcher.extract_metadata, local_path)
            chapters = await asyncio.to_thread(
                parsers_dispatcher.parse_file, local_path)
            meta = meta or {}
            chapters = sanitize_narration_chapters(
                chapters,
                story_title=(meta.get("title") or "").strip(),
                author=(meta.get("author") or "").strip(),
            )
        except HTTPException:
            raise
        except (ValueError, RuntimeError) as exc:
            # Unsupported format / zip-bomb guard / zero parseable chapters all
            # carry a message written for the reader, so surface it verbatim.
            raise HTTPException(status_code=422, detail=str(exc)[:200])
        except Exception:
            safe_http_error(
                f"upload parse failed for {filename[:120]}",
                "Could not parse this document. Try a different file or format.",
                status_code=422)

    meta = meta or {}
    words = sum(len(p.split()) for ch in chapters for p in (ch.paragraphs or []))
    stem = pathlib.Path(filename).stem.replace("_", " ").replace("-", " ").strip()
    payload = {
        "filename": filename,
        "title": (meta.get("title") or "").strip() or stem or "Untitled",
        "author": (meta.get("author") or "").strip() or "Unknown",
        "words": f"{words:,}",
        "chapters": [asdict(ch) for ch in chapters],
    }
    synopsis = (meta.get("description") or meta.get("synopsis") or "").strip()
    if synopsis:
        payload["synopsis"] = synopsis
    log.info("upload: parsed %d chapters from '%s' (%d bytes)",
             len(payload["chapters"]), filename, total)
    return payload


@app.get("/api/fetch-epub")
async def fetch_epub_relay(url: str, request: Request):
    """Relay endpoint: download a FicHub EPUB from the backend server.

    This is Layer 3 of the frontend EPUB download fallback chain.
    When allorigins.win /raw and /get both fail (502, CORS, or size limits),
    the frontend sends the FicHub cache URL here and we download it server-side.

    Without FICHUB_TOKEN: FicHub's datacenter blocklist will reject this (err=-9).
    With FICHUB_TOKEN set in HF secrets: authorized requests bypass the check.
    """
    try:
        await asyncio.to_thread(assert_public_url, url, allowed_hosts={"fichub.net"})
    except RuntimeError:
        raise HTTPException(status_code=400, detail="Only fichub.net URLs are accepted")

    _require_scrape_budget(request)

    _has_token = bool(os.environ.get("FICHUB_TOKEN", "").strip())
    log.info("fetch-epub: downloading %s (token=%s)", url[:80], _has_token)

    try:
        async with make_client(timeout=60) as client:
            # _fichub_get applies custom User-Agent + token + 429/Retry-After handling
            resp = await _fichub_get(client, url, timeout=45)
            if not resp.is_success:
                raise HTTPException(
                    status_code=502,
                    detail=f"FicHub returned HTTP {resp.status_code}")
            content_type = resp.headers.get("content-type", "application/epub+zip")
            if "text" in content_type or "json" in content_type:
                # FicHub returned an error page / JSON instead of binary — blocked
                raise HTTPException(
                    status_code=502,
                    detail="FicHub returned a non-binary response — likely IP blocked. Set FICHUB_TOKEN.")
            return Response(
                content=resp.content,
                media_type="application/epub+zip",
                headers={"Content-Disposition": "attachment; filename=story.epub"},
            )
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("fetch-epub failed: %s", exc)
        raise HTTPException(status_code=502, detail="EPUB relay failed. The file may be unavailable or the backend may be blocked.")


@app.get("/api/fichub-proxy")
async def fichub_proxy(url: str, request: Request):
    """Unified backend proxy for all FicHub requests.
    
    The frontend calls this instead of public CORS proxies like allorigins.win.
    If ZYTE_API_KEY is configured, this securely routes through Zyte.
    """
    try:
        await asyncio.to_thread(assert_public_url, url, allowed_hosts={"fichub.net"})
    except RuntimeError:
        raise HTTPException(status_code=400, detail="Only fichub.net URLs are accepted")

    _require_scrape_budget(request)

    log.info("fichub-proxy: handling %s", url[:100])
    try:
        async with make_client(timeout=60) as client:
            resp = await _fichub_get(client, url, timeout=55)
            
            if not resp.is_success:
                # Map all upstream errors to 502 so the frontend can distinguish
                # "our backend crashed" (500) from "upstream service failed" (502).
                raise HTTPException(status_code=502, detail=f"FicHub returned HTTP {resp.status_code}")

            content_type = resp.headers.get("content-type", "")
            if "json" not in content_type:
                # FicHub returned non-JSON (Cloudflare HTML challenge or error page).
                # Surface as 502 so the frontend retry loop exits immediately.
                log.warning(
                    "fichub-proxy: expected JSON but got %s (%d bytes) — likely Cloudflare block",
                    content_type or "(no content-type)",
                    len(resp.content),
                )
                raise HTTPException(
                    status_code=502,
                    detail="FicHub returned non-JSON response — likely Cloudflare-blocked. Set FICHUB_TOKEN."
                )

            return Response(
                content=resp.content,
                media_type="application/json",
                headers={"Cache-Control": "public, max-age=604800"}
            )
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("fichub-proxy failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"FicHub proxy failed: {str(exc)[:120]}")


@app.get("/api/health/sites")
async def site_health():
    cached = await SITE_HEALTH_CACHE.get("all")
    if cached is not None:
        return cached

    async with SITE_HEALTH_REFRESH_LOCK:
        cached = await SITE_HEALTH_CACHE.get("all")
        if cached is not None:
            return cached

        tasks = [
            asyncio.create_task(_probe_site(label, url, cookies, domain))
            for label, url, cookies, domain in _HEALTH_TARGETS
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        sites = []
        for res, target in zip(results, _HEALTH_TARGETS):
            if isinstance(res, Exception):
                sites.append({"site": target[0], "status": "unreachable", "note": str(res)[:80]})
            else:
                sites.append(res)

        order = {label: i for i, (label, *_rest) in enumerate(_HEALTH_TARGETS)}
        sites.sort(key=lambda r: order.get(r.get("site"), 999))

        payload = {
            "sites": sites,
            "checked_at": int(_time.time()),
            "cache_ttl_sec": SITE_HEALTH_CACHE_TTL_SEC
        }
        await SITE_HEALTH_CACHE.put("all", payload)
        return payload


@app.get("/api/vapid-public-key")
def get_vapid_public_key():
    if not VAPID_PUBLIC:
        raise HTTPException(
            status_code=503,
            detail="Push notifications are not configured on the backend.")
    return {"public_key": VAPID_PUBLIC}


@app.post("/api/sync/chapters")
async def sync_chapters(x_admin_secret: str = Header(default="")):
    if not _admin_authorized(x_admin_secret):
        raise HTTPException(status_code=403, detail="Forbidden")
    global _last_sync_ts
    async with _sync_lock:
        now = _time.time()
        if now - _last_sync_ts < SYNC_MIN_INTERVAL_SEC:
            return {"status": "throttled", "next_in_sec": int(
                SYNC_MIN_INTERVAL_SEC - (now - _last_sync_ts))}
        _last_sync_ts = now
    return await _run_chapter_sync_sweep()


@app.post("/api/send-push/{user_id}")
async def send_push_to_user(user_id: str, payload: dict = Body(...), x_admin_secret: str = Header(None)):
    if not _admin_authorized(x_admin_secret):
        raise HTTPException(status_code=403, detail="Forbidden")
    if not PYWEBPUSH_AVAILABLE:
        raise HTTPException(status_code=501)
    if not VAPID_PRIVATE:
        raise HTTPException(status_code=503,
                            detail="Push notifications are not configured")
    async with _db_lock:
        async with _db_conn.execute(
            "SELECT subscription_json FROM subscriptions WHERE user_id = ?", (user_id,)) as cursor:
            row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=404)

    def _send():
        webpush(
            json.loads(row[0]),
            json.dumps(payload),
            vapid_private_key=VAPID_PRIVATE,
            vapid_claims={"sub": VAPID_SUB})

    try:
        await asyncio.to_thread(_send)
    except WebPushException as e:
        status = getattr(
            e.response, "status_code", None) if e.response is not None else None
        if status in (404, 410):
            async with _db_lock:
                await _db_conn.execute(
                    "DELETE FROM subscriptions WHERE user_id = ?", (user_id,))
                await _db_conn.commit()
            return {"status": "pruned_dead_subscription"}
        log.warning("Push notification failed: %s", e)
        raise HTTPException(status_code=502, detail="Push delivery failed")
    except Exception as e:
        log.warning("Push notification failed: %s", e)
        raise HTTPException(status_code=502, detail="Push delivery failed")
    return {"status": "sent"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 7860)))
