/**
 * Phase 3 of the Anvil decommission (see MIGRATION_PLAN.md).
 *
 * Converts the Anvil-shaped frontend into a standalone static site:
 *
 *   1. Unwraps public/index.html. It is NOT html -- the whole page is stored
 *      inside a prop:html attribute of a single <anvil-form> element, so every
 *      internal double quote is escaped.
 *   2. Unescapes the attribute encoding (&quot; first, &amp; LAST -- doing it
 *      the other way round would turn &amp;quot; into a literal quote).
 *      &copy; and friends are left alone; they are real HTML entities.
 *   3. Rewrites every _/theme/<file> reference onto the public/assets layout,
 *      resolving each file's real subdirectory from disk rather than guessing.
 *   4. Emits a real document: <!DOCTYPE html> + <head> built from
 *      standard-page.html (which is exactly what Anvil injected) + <body>.
 *
 * Idempotent: re-running on already-converted output is a no-op.
 *
 * Usage:  node tools/convert_to_static.mjs [--check]
 *         --check reports what would change and exits 1 if anything would.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');
const checkOnly = process.argv.includes('--check');

const FORM_PREFIX = '<anvil-form container="HtmlTemplate" prop:html="';
const FORM_SUFFIX = '" prop:visible="true"></anvil-form>';

/** Map every asset basename to its public/-relative URL, read from disk. */
async function buildAssetMap() {
  const map = new Map();
  for (const sub of ['js', 'css', 'fonts', 'img', 'icons']) {
    const dir = path.join(pub, 'assets', sub);
    for (const name of await readdir(dir)) {
      map.set(name, `/assets/${sub}/${name}`);
    }
  }
  return map;
}

/**
 * Rewrite _/theme/<file>[?v=tag] -> /assets/<subdir>/<file>[?v=tag].
 * Throws on an unknown file: a silently unrewritten URL would 404 at runtime,
 * which is exactly the class of bug this migration must not ship.
 */
function rewriteThemeUrls(text, assets, seen) {
  // %20 matters: several icons are named e.g. "profile 512.png" on disk but
  // appear URL-encoded in markup. Decode for the lookup, re-encode on output.
  // The leading slash is optional and MUST be consumed when present: markup
  // uses relative "_/theme/x", the service worker uses absolute "/_/theme/x",
  // and leaving that slash behind yields "//assets/x" -- a protocol-relative
  // URL the browser resolves against the host "assets", not this origin.
  return text.replace(/\/?_\/theme\/([A-Za-z0-9_.\-%]+?)(\?[^"'\s>)]*)?(?=["'\s>)])/g,
    (match, rawFile, query = '') => {
      const file = decodeURIComponent(rawFile);
      const target = assets.get(file);
      if (!target) {
        throw new Error(`_/theme/${rawFile} has no counterpart under public/assets/ (from: ${match})`);
      }
      seen.add(file);
      const dir = target.slice(0, target.lastIndexOf('/') + 1);
      return dir + encodeURIComponent(file) + query;
    });
}

/**
 * The service worker also branches on the Anvil path namespace to pick a cache
 * strategy. Those are predicates rather than URLs, so the URL rewriter cannot
 * see them, and leaving them behind would silently disable network-first
 * updates for code and cache-first for images on the new origin.
 */
/**
 * The page registers the worker from Anvil's server endpoint. On Pages the
 * worker is a static file at the origin root. Without this the worker never
 * registers at all -- taking offline support AND the COOP/COEP isolation that
 * threaded narration depends on down with it.
 */
function rewriteServiceWorkerRegistration(text) {
  return text.replace(/\/_\/api\/serviceworker\.js/g, '/sw.js');
}

function rewriteServiceWorkerPaths(text) {
  let out = text.replace(/'\/_\/theme\/'/g, "'/assets/'");
  // Drop the trailing /_/api/ clause: nothing serves Anvil's API namespace on
  // Pages, so the guard can never fire. It is the last clause in the ||-chain,
  // so the preceding line's operator goes with it.
  // NOTE: the /_/g in the base64url decoder elsewhere in this file is a regex
  // literal, NOT a path -- it must not be touched.
  // Line-ending tolerant: this working tree is CRLF, so a literal \n would not
  // match and the clause would silently survive.
  out = out.replace(
    /(url\.origin\.indexOf\('hf\.space'\) !== -1) \|\|\r?\n\s*\(event\.request\.mode !== 'navigate' && url\.pathname\.indexOf\('\/_\/api\/'\) === 0\)/,
    '$1',
  );

  // The self-interception guard matched Anvil's endpoint name. The static
  // worker is /sw.js, so without this the worker would start intercepting
  // fetches for its own script.
  out = out.replace(
    "url.pathname.indexOf('serviceworker') !== -1 ||",
    "url.pathname === '/sw.js' ||",
  );
  out = out.replace(
    '// Never intercept the service worker script itself or Anvil internals',
    '// Never intercept the service worker script itself or backend API calls',
  );
  // Anvil served its platform endpoints under /_/ and this skipped them while
  // letting /_/theme/ through. Cloudflare Pages has no /_/ namespace, so the
  // whole clause is dead weight that would only confuse the next reader.
  out = out.replace(
    /\(event\.request\.mode !== 'navigate' && url\.pathname\.indexOf\('\/_\/'\) === 0 && url\.pathname\.indexOf\('\/assets\/'\) !== 0\) \|\|\s*/,
    '',
  );
  return out;
}

/**
 * Recover the page body, from either shape:
 *   - the original Anvil form (first run), or
 *   - an already-converted document (re-run), by taking what is between the
 *     body tags. Without this branch a second run would treat the whole
 *     converted document as body content and wrap it in a second shell.
 */
function extractBody(raw) {
  const trimmed = raw.trimEnd();

  if (trimmed.startsWith(FORM_PREFIX)) {
    if (!trimmed.endsWith(FORM_SUFFIX)) {
      throw new Error('index.html opens with an <anvil-form> wrapper but does not close with one');
    }
    const inner = trimmed.slice(FORM_PREFIX.length, trimmed.length - FORM_SUFFIX.length);
    // Order matters: &quot; before &amp;, so an escaped literal "&quot;"
    // (stored as &amp;quot;) survives as text instead of collapsing to a quote.
    return { body: inner.replace(/&quot;/g, '"').replace(/&amp;/g, '&'), converted: false };
  }

  const open = trimmed.indexOf('<body>');
  const close = trimmed.lastIndexOf('</body>');
  if (open !== -1 && close > open) {
    return { body: trimmed.slice(open + '<body>'.length, close), converted: true };
  }

  throw new Error('index.html is neither an <anvil-form> wrapper nor a document with a <body>');
}

const assets = await buildAssetMap();
const seen = new Set();

// ---- head: standard-page.html is verbatim what Anvil injected into <head> ----
// The service-worker registration <script> lives in the head, not the body.
const headRaw = await readFile(path.join(pub, 'standard-page.html'), 'utf8');
const head = rewriteServiceWorkerRegistration(rewriteThemeUrls(headRaw, assets, seen));

// ---- body: unwrap the anvil-form ----
const indexRaw = await readFile(path.join(pub, 'index.html'), 'utf8');
const extracted = extractBody(indexRaw);
if (extracted.converted) {
  console.log('index.html is already a document; regenerating from its <body>.');
}
const body = rewriteServiceWorkerRegistration(rewriteThemeUrls(extracted.body, assets, seen));

const documentHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/assets/img/pocket_reader_icon.webp" type="image/webp">
<link rel="apple-touch-icon" href="/assets/img/pocket_reader_icon-logo.jpeg">
${head.trim()}
</head>
<body>
${body.trim()}
</body>
</html>
`;

// ---- service worker + loader carry their own _/theme/ references ----
const swRaw = await readFile(path.join(pub, 'sw.js'), 'utf8');
const sw = rewriteServiceWorkerPaths(rewriteThemeUrls(swRaw, assets, seen));

const loaderPath = path.join(pub, 'assets', 'js', 'narration_runtime_loader.js');
const loaderRaw = await readFile(loaderPath, 'utf8');
const loader = rewriteThemeUrls(loaderRaw, assets, seen);

const writes = [
  [path.join(pub, 'index.html'), documentHtml, indexRaw],
  [path.join(pub, 'sw.js'), sw, swRaw],
  [loaderPath, loader, loaderRaw],
];

const changed = writes.filter(([, next, prev]) => next !== prev).map(([f]) => path.relative(root, f));

if (checkOnly) {
  if (changed.length) {
    console.error(`Would rewrite:\n  ${changed.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('Already static; no rewrite needed.');
  }
} else {
  for (const [file, next] of writes) await writeFile(file, next, 'utf8');
  console.log(`Rewrote ${changed.length} file(s): ${changed.join(', ') || 'none'}`);
  console.log(`Resolved ${seen.size} distinct _/theme/ assets onto /assets/**.`);
}
