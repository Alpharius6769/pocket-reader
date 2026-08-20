// Community layer for the native masterlist: shared ratings, click tracking and
// the weekly trending list, served by the Anthronomicon's own catalog-api.
//
// This deliberately talks to the SAME backend the live index uses, so a rating
// cast here moves the same aggregate a rating cast on the index does. Two facts
// make that work without touching the index at all:
//
//   - Production is alpharius6769.github.io. The browser sends that origin for
//     /pocket-reader/ exactly as it does for /hmofa-story-index/, and the API's
//     allowlist already accepts it.
//   - Voter identity is the index's own device id, read from the localStorage
//     both apps share on that origin. A reader is therefore one voter across
//     both apps rather than two, so ratings cannot be double-counted and stars
//     they already cast come back lit.
//
// Only the curator intake routes (recommendations, blacklist-requests,
// corrections) call verifyTurnstile server-side. rate and click do not, so
// nothing here needs a challenge widget -- which matters, because
// challenges.cloudflare.com cannot load inside a ?tts_fast=1 narration session.

// Routed through the Worker rather than straight at Supabase: the Worker
// attaches the shared key that catalog-api now requires for writes, and
// forwards the real client IP so per-user rate limits still apply.
const API_BASE = 'https://pocket-reader-proxy.alpharius67.workers.dev/catalog-api';

const STORAGE_KEYS = Object.freeze({
  device: 'hmofa_device_id_v2',
  ratings: 'hmofa_user_ratings_v2',
});

function readStorage(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode or a full quota must not break rating */
  }
}

function parseJson(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// Matches the index's own format so a reader who has rated there is recognised
// as the same voter here, rather than starting over with a fresh identity.
export function getDeviceId() {
  const existing = String(readStorage(STORAGE_KEYS.device, '') || '').trim().slice(0, 200);
  if (existing) return existing;
  const created = `dev-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
  writeStorage(STORAGE_KEYS.device, created);
  return created;
}

async function apiRequest(route, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12000);
  try {
    const response = await fetch(`${API_BASE}/${route}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      credentials: 'omit',
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text ? parseJson(text, null) : null;
    if (!response.ok) {
      const error = new Error(payload?.error || `Request failed with status ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

// ── Local ratings ───────────────────────────────────────────────────────────
// The reader's own scores, kept in the index's key so both apps show the same
// stars. Separate from the community aggregate, which is server-owned.

export function loadLocalRatings() {
  return parseJson(readStorage(STORAGE_KEYS.ratings, '{}'), {});
}

export function saveLocalRating(storyId, score) {
  const ratings = loadLocalRatings();
  ratings[storyId] = score;
  writeStorage(STORAGE_KEYS.ratings, JSON.stringify(ratings));
  return ratings;
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function fetchCommunitySnapshot() {
  const snapshot = await apiRequest('community-snapshot', { method: 'GET', cache: 'no-store' });
  const ratings = snapshot?.ratings && typeof snapshot.ratings === 'object' ? snapshot.ratings : {};
  const trending = Array.isArray(snapshot?.trending)
    ? snapshot.trending.map((id) => String(id || '').slice(0, 128)).filter(Boolean)
    : [];
  return { ratings, trending };
}

// ── Writes ──────────────────────────────────────────────────────────────────

// Wording borrowed from the index so the same failure reads the same way in
// both apps. Each case names the effect rather than the cause: a 400 also
// covers a malformed token, and guessing wrong would mislead the reader.
export function ratingFailureMessage(error) {
  if (error?.status === 400) {
    return 'This story can no longer be rated in the community index. Your rating is saved on this device.';
  }
  if (error?.status === 429) {
    return 'Ratings are coming in faster than the limit allows. Your rating is saved on this device and can be sent again shortly.';
  }
  return 'Your rating is saved on this device but could not be shared. Try again when community activity reconnects.';
}

// The local score is kept whether or not the server accepts it, so a reader
// never loses their own rating to a transient outage.
export async function submitRating(storyId, score) {
  if (!storyId || !Number.isInteger(score) || score < 1 || score > 5) {
    return { ok: false, aggregate: null, message: '' };
  }
  saveLocalRating(storyId, score);
  try {
    const result = await apiRequest('rate', {
      method: 'POST',
      body: JSON.stringify({ storyId, score, clientToken: getDeviceId() }),
    });
    return { ok: true, aggregate: result?.aggregate ?? null, message: '' };
  } catch (error) {
    window.Diagnostics?.log('WARN', 'HMOFA rating not shared', { storyId, error: String(error) });
    return { ok: false, aggregate: null, message: ratingFailureMessage(error) };
  }
}

// Feeds Weekly Trending. Fire-and-forget: a reader opening a story must never
// wait on, or be interrupted by, analytics. keepalive lets it survive the
// navigation into the reader view.
export function trackStoryOpen(storyId) {
  if (!storyId) return;
  apiRequest('click', {
    method: 'POST',
    keepalive: true,
    timeoutMs: 5000,
    body: JSON.stringify({ storyId, clientToken: getDeviceId() }),
  }).catch(() => {});
}
