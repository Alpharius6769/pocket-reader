// SSRF guard: reject obviously-internal targets. Catches IP-literal private
// ranges and well-known internal hostnames. Note: cannot resolve DNS names to
// their IPs at the edge, so a hostname that resolves to a private IP is not
// caught here; pair with network-level egress controls if that matters.
function isBlockedHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") ||
      h === "metadata.google.internal") return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((x) => x > 255)) return true;
    const [a, b] = o;
    if (a === 0 || a === 10 || a === 127) return true;          // this-net / 10/8 / loopback
    if (a === 169 && b === 254) return true;                    // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16/12
    if (a === 192 && b === 168) return true;                    // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT 100.64/10
    if (a >= 224) return true;                                  // multicast / reserved
  }
  if (h.includes(":")) {                                        // IPv6 literal
    if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") ||
        h.startsWith("fe80") || h === "::") return true;
  }
  return false;
}

// Allowlist for the generic ?url= proxy: only the hosts this app actually fetches
// through the Worker (AO3 + FicHub today). This keeps it from being abused as an
// open proxy; the IP blocklist above cannot resolve DNS at the edge, so a public
// hostname pointing at an internal IP, or any third-party host, would otherwise be
// proxied. Extend without redeploying code by setting the ALLOWED_PROXY_HOSTS
// Worker variable (comma-separated hostnames); subdomains are matched too.
function hostAllowed(hostname, env) {
  const h = (hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  const defaults = ["archiveofourown.org", "fichub.net"];
  const list = (env && env.ALLOWED_PROXY_HOSTS)
    ? env.ALLOWED_PROXY_HOSTS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : defaults;
  return list.some((a) => h === a || h.endsWith("." + a));
}

// The Capacitor WebView's own page origin. Android with androidScheme "https"
// serves the bundled app from https://localhost, iOS uses capacitor://localhost,
// and http://localhost covers an androidScheme of "http".
//
// These are REFLECTABLE but never AUTHORISING, and keeping those two ideas
// apart is the whole fix. Reflecting an origin in Access-Control-Allow-Origin
// only decides which browser page may READ a response the Worker already chose
// to serve; it decides nothing about whether to serve it. Authorisation is a
// separate question, answered per route below, and an Origin header can never
// answer it because any non-browser caller can send any Origin it likes.
const NATIVE_APP_ORIGINS = Object.freeze([
  "https://localhost",
  "http://localhost",
  "capacitor://localhost",
]);

function isNativeAppOrigin(origin) {
  return NATIVE_APP_ORIGINS.includes(origin);
}

// Restrict CORS to known app origins. Configure extra origins via the
// ALLOWED_ORIGINS Worker variable (comma-separated).
function resolveAllowedOrigin(request, env) {
  // Only origins that actually exist. The two pocket-reader-f2y.pages.dev
  // entries that used to sit here were left over from the Cloudflare Pages
  // deploy, which is gone -- both names are NXDOMAIN. A *.pages.dev name that
  // nobody owns can be claimed by creating a Pages project with that name, so
  // trusting a dead one is a standing subdomain-takeover path into routes that
  // attach this Worker's own credentials: /api/ forwards with HF_TOKEN, and
  // /catalog-api/ writes with CATALOG_PROXY_KEY. Add a preview origin back
  // through the ALLOWED_ORIGINS variable while it exists, not in code.
  const defaults = [
    "https://alpharius6769.github.io",
  ];
  const extra = (env && env.ALLOWED_ORIGINS)
    ? env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const allowed = [...defaults, ...extra];
  const origin = request.headers.get("Origin") || "";
  if (allowed.includes(origin)) return origin;
  // Loopback is a development affordance and must be opted into. It previously
  // applied unconditionally, so production reflected CORS for any port or scheme
  // on localhost/127.0.0.1/::1. Set ALLOW_LOCALHOST_ORIGINS=1 for local dev.
  if (env && String(env.ALLOW_LOCALHOST_ORIGINS || "") === "1") {
    try {
      const parsed = new URL(origin);
      if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.toLowerCase())) return origin;
    } catch (_) {
      // Ignore malformed origins and fall through to the default deny.
    }
  }
  return null;
}

// Which origin may be reflected in Access-Control-Allow-Origin. This is the
// trusted web origin plus the native shell's own page origin, and it is
// deliberately WIDER than resolveAllowedOrigin: the native build has to be able
// to read responses from the public asset routes, but must not inherit the
// trusted web origin's authority over the credential-attaching ones.
function resolveCorsOrigin(request, env) {
  const trusted = resolveAllowedOrigin(request, env);
  if (trusted) return trusted;
  const origin = request.headers.get("Origin") || "";
  return isNativeAppOrigin(origin) ? origin : null;
}

function timingSafeEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ""));
  const b = new TextEncoder().encode(String(right || ""));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index % Math.max(1, a.length)] || 0)
      ^ (b[index % Math.max(1, b.length)] || 0);
  }
  return difference === 0;
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303
    || status === 307 || status === 308;
}

function buildUpstreamHeaders(request, extra = {}) {
  const headers = new Headers();
  for (const name of ["Accept", "Accept-Language", "Range", "User-Agent", "Content-Type", "Content-Length"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const visitorIp = extra.visitorIp || "";
  if (visitorIp) {
    headers.set("CF-Connecting-IP", visitorIp);
    headers.set("X-Forwarded-For", visitorIp);
  }
  return headers;
}

function modelAssetCandidateUrls(url, b2BaseUrl) {
  const path = url.pathname;

  // Native audio.cpp / GGML PocketTTS weights and unused ONNX rollback trees.
  // Served for desktop/server tooling — not loaded by the browser ORT worker.
  if (path.startsWith("/ggml/") || path.startsWith("/backup/")) {
    return [b2BaseUrl + path + url.search];
  }

  if (!path.startsWith("/models/")) return [];

  const withoutModels = path.replace(/^\/models\//, "/");
  const candidates = [b2BaseUrl + withoutModels + url.search];

  if (!withoutModels.startsWith("/voices/")) {
    candidates.push(b2BaseUrl + "/models" + withoutModels + url.search);
  }

  // Allow /models/ggml/... and /models/backup/... aliases onto the B2 roots.
  if (withoutModels.startsWith("/ggml/") || withoutModels.startsWith("/backup/")) {
    candidates.unshift(b2BaseUrl + withoutModels + url.search);
  }

  if (withoutModels.startsWith("/Pocket%20TTS%20Onnx/")) {
    candidates.push(
      b2BaseUrl + withoutModels.replace(/^\/Pocket%20TTS%20Onnx\//, "/onnx/") + url.search,
      b2BaseUrl + "/models" + withoutModels.replace(/^\/Pocket%20TTS%20Onnx\//, "/onnx/") + url.search
    );
  }

  return [...new Set(candidates)];
}

function cacheControlForModelAsset(url, response) {
  if (!response.ok) {
    return "no-store";
  }
  if (response.status === 206) {
    return "public, max-age=86400";
  }
  if (url.pathname.includes("/english_2026-04-webgpu-fp16-r3/")) {
    return "public, max-age=31536000, immutable";
  }
  if (url.pathname.endsWith("/sentencepiece.js") || url.pathname.endsWith("/bundle.json")) {
    return "public, max-age=300, must-revalidate";
  }
  return "public, max-age=31536000, immutable";
}

function shouldEdgeCacheModelRequest(request, url) {
  if (request.method !== "GET") return false;
  if (request.headers.has("Range") || request.headers.has("Authorization")) return false;
  if (!(url.pathname.startsWith("/models/") ||
        url.pathname.startsWith("/ggml/") ||
        url.pathname.startsWith("/backup/"))) {
    return false;
  }
  return !url.pathname.endsWith("/bundle.json") &&
    !url.pathname.endsWith("/sentencepiece.js") &&
    !url.pathname.endsWith("/README.md") &&
    !url.pathname.endsWith("/RESTORE_ONNX_BROWSER.md") &&
    !url.pathname.endsWith("/manifest.json");
}

function modelEdgeCacheKey(url) {
  const key = new URL(url.toString());
  key.hash = "";
  return new Request(key.toString(), { method: "GET" });
}

function finalizeModelResponse(response, corsOrigin, edgeCacheStatus) {
  const result = new Response(response.body, response);
  result.headers.set("Access-Control-Allow-Origin", corsOrigin);
  result.headers.set(
    "Access-Control-Expose-Headers",
    "Content-Range, Content-Length, ETag, Digest, X-Asset-Integrity, X-Asset-Revision, X-Pocket-Edge-Cache",
  );
  result.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  result.headers.set("Vary", "Origin");
  result.headers.set("X-Pocket-Edge-Cache", edgeCacheStatus);
  return result;
}

// "null" is a real origin, not a placeholder for "none".
//
// Every response below falls back to `corsOrigin = ... || "null"` when there is
// nothing to reflect, and then sends it. But a sandboxed iframe, a data: URL and
// some file: pages all report their origin AS the string "null", so
// `Access-Control-Allow-Origin: null` grants read access to exactly those
// contexts instead of denying everyone. On /models/ that is public open-weights
// files, so the cost is hotlinked bandwidth rather than exposure -- but a
// request carrying no Origin at all is not a browser CORS request in the first
// place, and answering it with a CORS grant is meaningless at best.
//
// Non-browser callers (curl, the backend hop) ignore CORS headers entirely, so
// dropping the header costs them nothing and closes the sandboxed-iframe case.
// Requests that DO carry an Origin are untouched: a disallowed one is already
// refused earlier, and an allowed one is reflected by name.
function withoutMeaninglessCorsGrant(request, response) {
  if (request.headers.get("Origin")) return response;
  if (response.headers.get("Access-Control-Allow-Origin") !== "null") return response;
  const cleaned = new Response(response.body, response);
  cleaned.headers.delete("Access-Control-Allow-Origin");
  return cleaned;
}

const handlers = {
  async fetch(request, env, ctx) {
    return withoutMeaninglessCorsGrant(request, await handlers.handleFetch(request, env, ctx));
  },

  async handleFetch(request, env, ctx) {
    const url = new URL(request.url);
    const allowedOrigin = resolveAllowedOrigin(request, env);
    const requestOrigin = request.headers.get("Origin") || "";
    const nativeAppOrigin = !allowedOrigin && isNativeAppOrigin(requestOrigin);
    const corsOrigin = resolveCorsOrigin(request, env) || "null";

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      if (corsOrigin === "null") {
        return new Response(null, { status: 403 });
      }
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Methods": "GET, HEAD, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, User-Agent, Accept, Accept-Language, Range, X-Pocket-Proxy-Key",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin",
        },
      });
    }

    // Non-browser callers (the backend's own proxy hop, ops tooling) present a
    // shared token instead of an Origin. Resolved once here because BOTH the
    // /api/ backend proxy and the generic ?url= proxy gate on it.
    const proxyKey = request.headers.get("X-Pocket-Proxy-Key") || "";
    const expectedProxyToken = env.PROXY_AUTH_TOKEN || env.WORKER_PROXY_TOKEN || "";
    const backendAuthorized = Boolean(
      expectedProxyToken
      && proxyKey
      && timingSafeEqual(proxyKey, expectedProxyToken),
    );

    // The native build's own credential, injected at package time (see
    // tools/inject_native_app_key.mjs). Deliberately NOT the backend hop token:
    // this one ships inside an APK, so it is extractable by anyone holding the
    // binary and must be rotatable without touching the backend's own access.
    // It raises the cost of abuse from "send a header" to "decompile a build";
    // it is not a secret, and nothing that needs to be one may rest on it.
    // Unset means inert -- no caller is authorised by this path.
    const expectedAppToken = env.APP_PROXY_TOKEN || "";
    const appAuthorized = Boolean(
      expectedAppToken
      && proxyKey
      && timingSafeEqual(proxyKey, expectedAppToken),
    );

    // An Origin the Worker will not even reflect is refused outright. Native
    // app origins are reflectable, so they fall through to the per-route
    // authorisation gates rather than being rejected here -- which is what
    // previously 403'd the Capacitor build on EVERY route, including the public
    // model assets that a caller sending no Origin at all could already fetch.
    if (requestOrigin && corsOrigin === "null") {
      return new Response("Forbidden: origin is not allowed.", {
        status: 403,
        headers: { "Vary": "Origin", "Content-Type": "text/plain" },
      });
    }
    if (url.pathname.startsWith("/api/")) {
      // This route attaches HF_TOKEN and forwards to a PRIVATE Space, so an
      // absent Origin must not mean "unchecked". Browsers always send Origin on
      // a cross-origin fetch, so the app is unaffected; a header-less caller
      // (curl, a script) previously reached every backend route with the
      // Worker's own credentials attached, burning Zyte quota and Space CPU.
      // A native app origin is reflectable but carries no authority of its own,
      // so the packaged build has to present APP_PROXY_TOKEN like any other
      // non-browser caller.
      if (!allowedOrigin && !backendAuthorized && !appAuthorized) {
        return new Response(nativeAppOrigin
          ? "Forbidden: this build is missing its proxy key. Package it with tools/inject_native_app_key.mjs."
          : "Forbidden: proxy authentication is required.", {
          status: 403,
          headers: { "Vary": "Origin", "Content-Type": "text/plain" },
        });
      }
      const targetUrl = new URL(url.pathname + url.search, "https://alpharius6769-pocket-reader.hf.space");
      const visitorIp = request.headers.get("CF-Connecting-IP") || "";
      const hfHeaders = buildUpstreamHeaders(request, { visitorIp });
      if (env.HF_TOKEN) {
        hfHeaders.set("Authorization", `Bearer ${env.HF_TOKEN}`);
      }
      const fetchRequest = new Request(targetUrl, {
        method: request.method,
        headers: hfHeaders,
        body: (request.method !== "GET" && request.method !== "HEAD") ? request.body : undefined,
        redirect: "manual",
        duplex: (request.method !== "GET" && request.method !== "HEAD") ? "half" : undefined
      });
      try {
        let response = await fetch(fetchRequest, { signal: AbortSignal.timeout(60000) });
        let newResponse = new Response(response.body, response);
        newResponse.headers.set("Access-Control-Allow-Origin", corsOrigin);
        newResponse.headers.set("Vary", "Origin");
        newResponse.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
        // Keep upstream CORS headers but ensure our origin is allowed
        newResponse.headers.set("Access-Control-Expose-Headers", response.headers.get("Access-Control-Expose-Headers") || "*");
        return newResponse;
      } catch (err) {
        return new Response(`API Proxy Error: ${err.message}`, {
            status: 502,
            headers: {
              "Access-Control-Allow-Origin": corsOrigin,
              "Cross-Origin-Resource-Policy": "cross-origin",
              "Vary": "Origin",
              "Content-Type": "text/plain"
            }
        });
      }
    }

    // Anthronomicon catalog-api is origin-locked to GitHub Pages. Pocket Reader
    // Android (and any non-Pages origin) cannot satisfy that check, so this
    // Worker re-originates the four community routes with the published Pages
    // origin. Curator/Turnstile routes are not proxied.
    if (url.pathname === "/catalog-api" || url.pathname.startsWith("/catalog-api/")) {
      const route = url.pathname.replace(/^\/catalog-api\/?/, "");
      const allowedGet = new Set(["community-snapshot", "story-metadata"]);
      const allowedPost = new Set(["rate", "click"]);
      const corsHeaders = {
        "Access-Control-Allow-Origin": corsOrigin,
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Vary": "Origin",
        "Content-Type": "application/json; charset=utf-8",
      };
      // Gated exactly like /api/ and the ?url= proxy. This route's whole job is
      // to ATTACH a trusted Origin, so an ungated version is strictly worse than
      // forging the header against Supabase directly: every request would also
      // arrive from a Cloudflare address, collapsing the caller identity any
      // upstream per-IP limit depends on. rate and click move a shared aggregate,
      // and clientToken is caller-supplied, so per-device dedupe upstream is not
      // a substitute for authenticating the caller here.
      //
      // The Capacitor build sends Origin: https://localhost, which is reflected
      // for CORS but grants nothing here -- anything that is not a browser can
      // send that header, so allowlisting it would have opened these writes to
      // the world. Instead the packaged build carries APP_PROXY_TOKEN, injected
      // into the copied web assets at package time by
      // tools/inject_native_app_key.mjs so the key never enters public/ (which
      // ships verbatim to GitHub Pages, where a committed key would be public).
      //
      // Be clear about what that buys: a key inside an APK is extractable by
      // anyone holding the APK. It is a cost barrier, not a secret. It is a
      // token separate from PROXY_AUTH_TOKEN precisely so that when it leaks it
      // can be rotated on its own without disturbing the backend hop, and so a
      // leaked app key never confers the backend's identity.
      if (!allowedOrigin && !backendAuthorized && !appAuthorized) {
        return new Response(
          JSON.stringify({
            error: nativeAppOrigin
              ? "This build is missing its proxy key. Package it with tools/inject_native_app_key.mjs."
              : "Proxy authentication is required.",
          }),
          { status: 403, headers: corsHeaders },
        );
      }
      if (request.method === "GET" || request.method === "HEAD") {
        if (!allowedGet.has(route)) {
          return new Response(JSON.stringify({ error: "Route not found." }), {
            status: 404,
            headers: corsHeaders,
          });
        }
      } else if (request.method === "POST") {
        if (!allowedPost.has(route)) {
          return new Response(JSON.stringify({ error: "Route not found." }), {
            status: 404,
            headers: corsHeaders,
          });
        }
      } else {
        return new Response(JSON.stringify({ error: "Method not allowed." }), {
          status: 405,
          headers: { ...corsHeaders, Allow: "GET, HEAD, POST, OPTIONS" },
        });
      }
      const catalogBase = "https://gupifxfvktfejqhfenml.supabase.co/functions/v1/catalog-api";
      const target = new URL(`${catalogBase}/${route}${url.search}`);
      const upstreamHeaders = new Headers();
      upstreamHeaders.set("Accept", "application/json");
      upstreamHeaders.set("Origin", "https://alpharius6769.github.io");
      upstreamHeaders.set("Referer", "https://alpharius6769.github.io/hmofa-story-index/");
      // Prove to catalog-api that this really is the proxy. Anyone can forge
      // the Origin above; only the Worker holds this key, so the function can
      // require it (or a Turnstile token) before accepting a write.
      if (env && env.CATALOG_PROXY_KEY) {
        upstreamHeaders.set("X-Catalog-Key", env.CATALOG_PROXY_KEY);
      }
      // Without this every proxied request reaches Supabase from a Cloudflare
      // address, so the upstream per-IP rate limit sees one caller and real
      // users throttle each other. Only trusted when X-Catalog-Key checks out.
      const clientIp = request.headers.get("CF-Connecting-IP");
      if (clientIp) upstreamHeaders.set("X-Client-IP", clientIp);
      upstreamHeaders.set(
        "User-Agent",
        request.headers.get("User-Agent") || "PocketReader-Proxy/1.0",
      );
      if (request.method === "POST") {
        upstreamHeaders.set(
          "Content-Type",
          request.headers.get("Content-Type") || "application/json",
        );
      }
      try {
        const upstream = await fetch(target, {
          method: request.method,
          headers: upstreamHeaders,
          body: request.method === "POST" ? request.body : undefined,
          redirect: "manual",
          duplex: request.method === "POST" ? "half" : undefined,
          signal: AbortSignal.timeout(15000),
        });
        if (isRedirectStatus(upstream.status)) {
          await upstream.body?.cancel?.();
          return new Response(JSON.stringify({ error: "Catalog proxy redirect rejected." }), {
            status: 502,
            headers: corsHeaders,
          });
        }
        const proxied = new Response(upstream.body, upstream);
        proxied.headers.set("Access-Control-Allow-Origin", corsOrigin);
        proxied.headers.set("Vary", "Origin");
        proxied.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
        return proxied;
      } catch (err) {
        return new Response(JSON.stringify({ error: `Catalog proxy error: ${err.message}` }), {
          status: 502,
          headers: corsHeaders,
        });
      }
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Only GET and HEAD are supported for this route.", {
        status: 405,
        headers: { "Allow": "GET, HEAD, OPTIONS", "Vary": "Origin" },
      });
    }

    // Route model/asset requests directly to Backblaze B2 (ORT browser, GGML
    // native audio.cpp weights, and unused ONNX rollback backups).
    if (url.pathname.startsWith('/models/') ||
        url.pathname.startsWith('/ggml/') ||
        url.pathname.startsWith('/backup/')) {
      const b2BaseUrl = "https://f005.backblazeb2.com/file/pocket-reader-assets";
      const candidateUrls = modelAssetCandidateUrls(url, b2BaseUrl);
      const edgeCacheEligible = shouldEdgeCacheModelRequest(request, url);
      const edgeCache = globalThis.caches?.default;
      const edgeCacheKey = edgeCacheEligible ? modelEdgeCacheKey(url) : null;
      if (edgeCache && edgeCacheKey) {
        try {
          const cached = await edgeCache.match(edgeCacheKey);
          if (cached) return finalizeModelResponse(cached, corsOrigin, "HIT");
        } catch (error) {
          console.warn("Model edge-cache lookup failed", error?.message || error);
        }
      }
      
      const b2Headers = buildUpstreamHeaders(request);

      try {
        let response = null;
        for (let index = 0; index < candidateUrls.length; index += 1) {
          const targetB2Url = candidateUrls[index];
          const fetchRequest = new Request(targetB2Url, {
            method: request.method,
            headers: b2Headers,
            // Cloudflare's production runtime currently rejects redirect:error
            // despite it appearing in the Request API documentation. Manual
            // mode preserves the no-follow guarantee and lets us fail closed.
            redirect: "manual"
          });
          response = await fetch(fetchRequest, { signal: AbortSignal.timeout(25000) });
          if (isRedirectStatus(response.status)) {
            await response.body?.cancel?.();
            throw new Error(`B2 redirect rejected (HTTP ${response.status}).`);
          }
          // Only a 404 is worth trying the next candidate path. (The method
          // check that used to be OR'd in here was unreachable — non-GET/HEAD
          // requests are already rejected above.)
          if (response.status !== 404) {
            break;
          }
          if (index < candidateUrls.length - 1) {
            await response.body?.cancel?.();
          }
        }
        if (!response) {
          response = new Response("Model asset not found.", { status: 404, headers: { "Content-Type": "text/plain" } });
        }
        let newResponse = new Response(response.body, response);

        // B2 serves .mjs/.wasm as octet-stream, but ES-module import() rejects
        // non-JavaScript MIME types and WebAssembly.instantiateStreaming wants
        // application/wasm. Fix them here so the self-hosted ONNX Runtime loads.
        if (response.ok) {
          if (url.pathname.endsWith(".mjs") || url.pathname.endsWith(".js")) {
            newResponse.headers.set("Content-Type", "text/javascript; charset=utf-8");
          } else if (url.pathname.endsWith(".wasm")) {
            newResponse.headers.set("Content-Type", "application/wasm");
          } else if (url.pathname.endsWith(".json")) {
            newResponse.headers.set("Content-Type", "application/json; charset=utf-8");
          } else if (url.pathname.endsWith(".onnx") || url.pathname.endsWith(".bin") ||
                     url.pathname.endsWith(".npy") || url.pathname.endsWith(".model") ||
                     url.pathname.endsWith(".safetensors")) {
            newResponse.headers.set("Content-Type", "application/octet-stream");
          }
        }

        const assetIntegrity = response.headers.get("X-Bz-Info-Sha256") || response.headers.get("X-Bz-Content-Sha1") || response.headers.get("ETag");
        if (assetIntegrity) newResponse.headers.set("X-Asset-Integrity", assetIntegrity.replace(/^\"|\"$/g, ""));
        if (url.pathname.includes("/onnxruntime/1.27.0/")) newResponse.headers.set("X-Asset-Revision", "onnxruntime-web-1.27.0");
        else if (url.pathname.includes("/english_2026-04-webgpu-fp16-r3/")) newResponse.headers.set("X-Asset-Revision", "english-2026-04-fp16-r3");

        // Dynamic Range Caching Guard: avoid caching partial byte ranges as
        // permanent immutable outputs. Runtime JS/metadata stay revalidatable.
        newResponse.headers.set("Cache-Control", cacheControlForModelAsset(url, response));
        if (edgeCache && edgeCacheKey && response.status === 200) {
          ctx.waitUntil(
            edgeCache.put(edgeCacheKey, newResponse.clone()).catch((error) => {
              console.warn("Model edge-cache write failed", error?.message || error);
            }),
          );
        }
        return finalizeModelResponse(
          newResponse,
          corsOrigin,
          edgeCacheKey && response.status === 200 ? "MISS" : "BYPASS",
        );
      } catch (err) {
        return new Response(`B2 Proxy Error: ${err.message}`, {
            status: 502,
            headers: {
              "Access-Control-Allow-Origin": corsOrigin,
              "Cross-Origin-Resource-Policy": "cross-origin",
              "Vary": "Origin",
              "Content-Type": "text/plain"
            }
        });
      }
    }

    const targetUrlString = url.searchParams.get("url");
    if (!targetUrlString) {
      // CORS headers on the error paths too, so a browser surfaces this message
      // instead of an opaque "failed to fetch".
      return new Response("Missing 'url' parameter or not a /models|/ggml|/backup request", {
        status: 400,
        headers: { "Access-Control-Allow-Origin": corsOrigin, "Vary": "Origin", "Content-Type": "text/plain" },
      });
    }

    let targetUrl;
    try {
      targetUrl = new URL(decodeURIComponent(targetUrlString));
    } catch (err) {
      return new Response("Invalid 'url' parameter", {
        status: 400,
        headers: { "Access-Control-Allow-Origin": corsOrigin, "Vary": "Origin", "Content-Type": "text/plain" },
      });
    }

    if (targetUrl.hostname.includes("workers.dev")) {
        return new Response("Forbidden: Circular proxying is not allowed.", {
          status: 403,
          headers: { "Access-Control-Allow-Origin": corsOrigin, "Vary": "Origin", "Content-Type": "text/plain" },
        });
    }

    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
        return new Response("Forbidden: only http(s) URLs may be proxied.", {
            status: 403, headers: { "Access-Control-Allow-Origin": corsOrigin, "Vary": "Origin" }
        });
    }
    if (targetUrl.username || targetUrl.password) {
        return new Response("Forbidden: credentials in proxy URLs are not allowed.", {
            status: 403, headers: { "Access-Control-Allow-Origin": corsOrigin, "Vary": "Origin" }
        });
    }
    if (targetUrl.port && targetUrl.port !== "80" && targetUrl.port !== "443") {
        return new Response("Forbidden: target port is not allowed.", {
            status: 403, headers: { "Access-Control-Allow-Origin": corsOrigin, "Vary": "Origin" }
        });
    }
    if (isBlockedHost(targetUrl.hostname)) {
        return new Response("Forbidden: target host is not allowed.", {
            status: 403, headers: { "Access-Control-Allow-Origin": corsOrigin, "Vary": "Origin" }
        });
    }
    if (!hostAllowed(targetUrl.hostname, env)) {
        return new Response("Forbidden: target host is not on the proxy allowlist.", {
            status: 403, headers: { "Access-Control-Allow-Origin": corsOrigin, "Vary": "Origin" }
        });
    }
    if (!allowedOrigin && !backendAuthorized && !appAuthorized) {
      return new Response(nativeAppOrigin
        ? "Forbidden: this build is missing its proxy key. Package it with tools/inject_native_app_key.mjs."
        : "Forbidden: proxy authentication is required.", {
        status: 403,
        headers: { "Vary": "Origin", "Content-Type": "text/plain" },
      });
    }

    const proxyHeaders = buildUpstreamHeaders(request);

    const fetchRequest = new Request(targetUrl, {
      method: request.method,
      headers: proxyHeaders,
      redirect: "manual"
    });

    try {
      let response = await fetch(fetchRequest, { signal: AbortSignal.timeout(25000) });
      let newResponse = new Response(response.body, response);
      newResponse.headers.set("Access-Control-Allow-Origin", corsOrigin);
      newResponse.headers.set("Vary", "Origin");
      return newResponse;
    } catch (err) {
      return new Response(`Proxy Error: ${err.message}`, {
          status: 502,
          headers: {
            "Access-Control-Allow-Origin": corsOrigin,
            "Vary": "Origin",
            "Content-Type": "text/plain"
          }
      });
    }
  },

  async scheduled(controller, env, ctx) {
    // The Space owns subscriptions and VAPID delivery. The Worker only starts
    // its authenticated sweep; this secret never reaches the browser.
    if (!env.CHAPTER_SYNC_URL || !env.ADMIN_PUSH_SECRET) {
      console.warn("Chapter sync skipped: Worker secret or endpoint is not configured.");
      return;
    }
    ctx.waitUntil((async () => {
      try {
        const headers = { "X-Admin-Secret": env.ADMIN_PUSH_SECRET };
        if (env.HF_TOKEN) {
          headers.Authorization = `Bearer ${env.HF_TOKEN}`;
        }
        const response = await fetch(env.CHAPTER_SYNC_URL, {
          method: "POST",
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(120000),
        });
        if (isRedirectStatus(response.status)) {
          await response.body?.cancel?.();
          console.warn("Chapter sync redirect rejected with status", response.status);
          return;
        }
        if (!response.ok) {
          console.warn("Chapter sync sweep failed with status", response.status);
          return;
        }
        const result = await response.json().catch(() => null);
        console.log("Chapter sync sweep complete", result && result.checked !== undefined
          ? { checked: result.checked, notified: result.notified }
          : "");
      } catch (error) {
        console.warn("Chapter sync sweep request failed", error && error.message ? error.message : error);
      }
    })());
  },
};

export default handlers;
