/**
 * New-chapter push alerts.
 *
 * This was part of settings_manager.js, which the v2 rebuild removed whole
 * because its applySettings() read old form fields back into settings. Push
 * went with it: nothing asked for permission, nothing subscribed, and nothing
 * unsubscribed, so the toggle stored a flag and readers who had subscribed in
 * the old app could not turn their alerts off.
 *
 * The backend contract is unchanged (POST /api/subscribe, /api/unsubscribe,
 * GET /api/vapid-public-key), and so are the stored keys, so an existing
 * subscription is recognised and can be cancelled.
 */

const USER_ID_KEY = 'pocketReaderPushUserId';
const AUTH_TOKEN_KEY = 'pocketReaderPushAuthToken';
const META_CACHE = 'pr-push-meta';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/* eslint-disable @typescript-eslint/no-explicit-any */
const w = window as unknown as Record<string, any>;

let volatileUserId = '';
let volatileToken = '';

export class PushError extends Error {}

/** Why push cannot be used here, or null when it can. Written for the reader. */
export function pushUnavailableReason(): string | null {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    const apple = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    return apple
      ? 'On iPhone and iPad, alerts work once Pocket Reader is added to your Home Screen and opened from there.'
      : 'This browser cannot deliver notifications.';
  }
  return null;
}

function apiBase(): string {
  return String(w.HF_API_BASE || '');
}

function storeToken(token: string) {
  volatileToken = token || '';
  try {
    if (volatileToken) localStorage.setItem(AUTH_TOKEN_KEY, volatileToken);
    else localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch {
    /* storage blocked: the in-memory copy serves this session */
  }
}

function token(): string {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY) || volatileToken;
  } catch {
    return volatileToken;
  }
}

function newUuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function userId(): string {
  try {
    let id = localStorage.getItem(USER_ID_KEY) || '';
    if (!UUID_RE.test(id)) {
      id = newUuid();
      localStorage.setItem(USER_ID_KEY, id);
      storeToken('');
    }
    return id;
  } catch {
    if (!volatileUserId) volatileUserId = newUuid();
    return volatileUserId;
  }
}

function applicationServerKey(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The followed AO3 stories the backend sweep should watch. Nothing else leaves the device. */
function profileSnapshot() {
  const library: any[] = Array.isArray(w.userProfile?.library) ? w.userProfile.library : [];
  return {
    library: library
      .filter((s) => s?.updateSubscribed && /archiveofourown\.org/i.test(s?.sourceUrl || s?.url || ''))
      .map((s) => ({
        title: s.title || 'your story',
        url: s.sourceUrl || s.url || '',
        storyKey: s.storyKey || '',
        publishedChapters: Number(s.publishedChapters || s.totalChapters) || 0,
        updateSubscribed: true,
      })),
  };
}

async function vapidKey(): Promise<string> {
  if (w.VAPID_PUBLIC_KEY) return String(w.VAPID_PUBLIC_KEY);
  const response = await fetch(`${apiBase()}/api/vapid-public-key`);
  if (!response.ok) throw new PushError('The alert service is not available right now.');
  const data = await response.json();
  if (!data?.public_key) throw new PushError('The alert service is not set up.');
  w.VAPID_PUBLIC_KEY = String(data.public_key);
  return w.VAPID_PUBLIC_KEY;
}

async function register(subscription: PushSubscription) {
  const response = await fetch(`${apiBase()}/api/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: userId(),
      subscription: subscription.toJSON(),
      profile: profileSnapshot(),
      auth_token: token() || null,
    }),
  });
  if (!response.ok) throw new PushError(`Alerts could not be turned on (the service answered ${response.status}).`);
  const data = await response.json();
  if (data?.auth_token) storeToken(String(data.auth_token));
  // The service worker re-subscribes from this if the browser rotates the
  // subscription while no page is open (sw.js pushsubscriptionchange).
  try {
    const meta = { user_id: userId(), auth_token: token() || null, vapidKey: w.VAPID_PUBLIC_KEY || '', apiBase: apiBase() };
    const cache = await caches.open(META_CACHE);
    await cache.put('/pr-push-meta', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
  } catch {
    /* Cache Storage unavailable: alerts still work until a rotation */
  }
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const known = (await w.__prServiceWorkerRegistration) || (await navigator.serviceWorker.getRegistration());
  if (!known) throw new PushError('Alerts need the installed app. Reload Pocket Reader and try again.');
  return known;
}

/**
 * Turn alerts on. MUST be called synchronously from the tap: the permission
 * prompt is refused on iOS once an await has intervened.
 */
export function enablePush(): Promise<void> {
  const reason = pushUnavailableReason();
  if (reason) return Promise.reject(new PushError(reason));
  // Requested before anything is awaited.
  const permission = Notification.permission === 'granted' ? Promise.resolve('granted' as NotificationPermission) : Notification.requestPermission();
  return permission.then(async (result) => {
    if (result !== 'granted') throw new PushError('Notifications are blocked for Pocket Reader. Allow them in your browser or phone settings, then try again.');
    const key = await vapidKey();
    const reg = await registration();
    const subscription =
      (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(key) }));
    await register(subscription);
  });
}

/** Turn alerts off everywhere: the backend record, the browser subscription and the stash. */
export async function disablePush(): Promise<void> {
  try {
    await caches.delete(META_CACHE);
  } catch {
    /* nothing stashed */
  }
  const auth = token();
  if (auth && apiBase()) {
    try {
      const response = await fetch(`${apiBase()}/api/unsubscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId(), auth_token: auth }),
      });
      if (response.ok) storeToken('');
    } catch {
      /* offline: the browser subscription below is still removed */
    }
  }
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    const subscription = await reg?.pushManager?.getSubscription?.();
    await subscription?.unsubscribe?.();
  } catch {
    /* no subscription */
  }
}

/** Send the current list of followed stories. No-op unless alerts are on and subscribed. */
export async function syncPushProfile(): Promise<void> {
  if (w.userProfile?.settings?.pushUpdates !== true || pushUnavailableReason()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const subscription = await reg?.pushManager?.getSubscription();
    if (subscription) await register(subscription);
  } catch {
    /* retried on the next change */
  }
}
