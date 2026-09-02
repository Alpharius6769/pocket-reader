// The packaged native build's proxy credential.
//
// Why this file exists at all: the Capacitor WebView serves the bundled app
// from https://localhost, and the Worker cannot treat that origin as proof of
// anything -- any non-browser caller can send the same header. So the routes
// that attach the Worker's own credentials (/api/ forwards HF_TOKEN to a
// private Space, /catalog-api/ writes with CATALOG_PROXY_KEY, /?url= is a
// host-allowlisted fetcher) require a real credential from the app instead.
//
// Read this before treating the value below as a secret: it ships inside an
// APK/IPA, so anyone holding the binary can extract it. It raises the cost of
// abuse from "send an Origin header" to "unpack a build"; it is not secret, and
// it is a DIFFERENT token from the backend hop's PROXY_AUTH_TOKEN so that a
// leak here is rotated on its own and never confers the backend's identity.
//
// KEY stays empty in git. public/ ships verbatim to GitHub Pages, so a key
// committed here would be published on the open web -- which is exactly the
// hole this indirection avoids. tools/inject_native_app_key.mjs rewrites the
// line below in the COPIED build assets (android/…/assets/public, ios/…/public)
// after `npx cap sync`, and refuses to write into public/ itself.
const NATIVE_APP_PROXY_KEY = ''; // pocket:native-app-proxy-key

// The web build leaves this empty and is unaffected: its own origin already
// authorises it, and no header is added.
export function nativeAppProxyKey() {
  return String(NATIVE_APP_PROXY_KEY || '').trim();
}

const PROXY_ORIGIN = 'https://pocket-reader-proxy.alpharius67.workers.dev';

// Only the credential-attaching routes. /models/, /ggml/ and /backup/ are
// deliberately excluded: they serve public B2 assets, need no authorisation,
// and adding a non-safelisted header to them would force a CORS preflight in
// front of every single model-weight and ORT request the narration engines make.
const KEYED_PATH_PREFIXES = ['/api/', '/catalog-api'];

function needsProxyKey(url) {
  try {
    const parsed = new URL(url, PROXY_ORIGIN);
    if (parsed.origin !== PROXY_ORIGIN) return false;
    if (parsed.searchParams.has('url')) return true;   // the generic ?url= proxy
    return KEYED_PATH_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix));
  } catch {
    return false;
  }
}

// A decorator rather than an edit at every call site: the proxy is reached from
// api_core, hmofa_community and diagnostics across a dozen fetches, and a header
// that only ever exists in the native build should not be threaded through all
// of them. Scoped hard -- one header, one origin, only the keyed routes -- and
// entirely inert when no key was injected.
export function installNativeAppProxyKey(scope = globalThis) {
  const key = nativeAppProxyKey();
  if (!key) return false;
  if (scope.__pocketNativeProxyKeyInstalled) return true;
  const originalFetch = scope.fetch;
  if (typeof originalFetch !== 'function') return false;

  scope.fetch = function pocketNativeKeyedFetch(input, init) {
    try {
      const url = (input && typeof input === 'object' && 'url' in input) ? input.url : String(input);
      if (needsProxyKey(url)) {
        const request = new Request(input, init);
        // Never overwrite a key a caller set deliberately.
        if (!request.headers.has('X-Pocket-Proxy-Key')) {
          request.headers.set('X-Pocket-Proxy-Key', key);
        }
        return originalFetch.call(this, request);
      }
    } catch {
      /* Fall through to the untouched fetch rather than break the request. */
    }
    return originalFetch.call(this, input, init);
  };
  scope.__pocketNativeProxyKeyInstalled = true;
  return true;
}

installNativeAppProxyKey();
