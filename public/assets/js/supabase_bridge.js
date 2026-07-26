/**
 * Supabase auth + profile sync bridge. Replaces the Anvil Skulpt bridge.
 *
 * CONTRACT: implements the SAME nine window.anvil* names, signatures and return
 * shapes that FrontEnd_code.py installed, because ~25 call sites across
 * sync_core, ui_controller, library_manager, settings_manager and cinematic_ui
 * already depend on them. Renaming is deliberately deferred until after cutover
 * so this swap is one file plus a script tag. See MIGRATION_PLAN.md Phase 4.
 *
 *   anvilGetCurrentUser()                        -> email string | null
 *   anvilLogin()                                 -> email string | null
 *   anvilLogout()                                -> true
 *   anvilSyncProfile(profile, isSyncing)         -> boolean
 *   anvilSyncProfileV3(profile, baseRev, devId)  -> { profile, revision, syncedAt }
 *   anvilLoadProfile()                           -> profile object | null
 *   anvilSaveAvatar(dataUrl)                     -> boolean
 *   anvilLoadAvatar()                            -> data URL string | null
 *   anvilDeleteAccountData(confirmation)         -> boolean
 *
 * NO SDK. Talks to GoTrue and PostgREST over fetch(), matching the project's
 * existing discipline of self-hosting everything (ORT, fonts, icons) rather than
 * pulling a CDN dependency into the critical path.
 *
 * The publishable key below is designed to ship in frontend JS. Access is
 * enforced by Row Level Security, not by key secrecy.
 */
import { mergeProfile, normalizeProfile } from './profile_merge.js?v=merge-v1';

const SUPABASE_URL = 'https://dctjxeqjtctyvvrdlcxo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_KUGiCZjxfxQb2eQwOTQO0A_MY8ihwur';
const SESSION_KEY = 'pr_supabase_session_v1';
const MAX_AVATAR_BYTES = 256 * 1024;
const COMMIT_ATTEMPTS = 5;

const log = (level, message, detail) => {
  window.Diagnostics?.log?.(level, message, detail);
  if (level === 'ERROR') console.error(message, detail ?? '');
};

// ---------------------------------------------------------------- session ----

let session = null;
try {
  session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
} catch (_) { session = null; }

function storeSession(next) {
  session = next;
  try {
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
  } catch (_) { /* private mode: session stays in memory only */ }
}

const authHeaders = (token) => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${token || SUPABASE_KEY}`,
  'Content-Type': 'application/json',
});

async function gotrue(path, { method = 'POST', body, token } = {}) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    method,
    headers: authHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch (_) { return null; } })() : null;
  if (!res.ok) {
    const detail = json?.error_description || json?.msg || json?.message || `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return json;
}

/** Refresh when the access token is within 60s of expiry. Returns a token or null. */
async function accessToken() {
  if (!session?.access_token) return null;
  const expiresAt = Number(session.expires_at || 0) * 1000;
  if (expiresAt && Date.now() < expiresAt - 60000) return session.access_token;
  if (!session.refresh_token) { storeSession(null); return null; }
  try {
    const next = await gotrue('/token?grant_type=refresh_token', { body: { refresh_token: session.refresh_token } });
    storeSession(next);
    return next.access_token;
  } catch (err) {
    // A refresh token that no longer works means the session is genuinely over.
    log('WARN', 'Supabase session refresh failed; signing out', String(err));
    storeSession(null);
    return null;
  }
}

async function rest(path, { method = 'GET', body, headers = {} } = {}) {
  const token = await accessToken();
  if (!token) throw new Error('You must be logged in.');
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: { ...authHeaders(token), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch (_) { return null; } })() : null;
  if (!res.ok) throw new Error(json?.message || json?.hint || `HTTP ${res.status}`);
  return json;
}

// ------------------------------------------------------------- login form ----

/**
 * Anvil supplied login_with_form(); nothing replaces it, so this builds a
 * minimal modal. Resolves to an email on success, or null if dismissed --
 * matching the old contract, where a cancelled login was null rather than a
 * thrown error.
 */
function showLoginForm() {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:2147483100;display:flex;align-items:center;'
      + 'justify-content:center;background:rgba(0,0,0,.6);backdrop-filter:blur(3px)';

    const card = document.createElement('form');
    card.setAttribute('aria-label', 'Sign in to Pocket Reader');
    card.style.cssText = 'width:min(92vw,360px);padding:22px;border-radius:14px;background:#16181c;color:#e8e8ea;'
      + "border:1px solid #2c3038;font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";

    const h = document.createElement('h2');
    h.textContent = 'Sign in';
    h.style.cssText = 'margin:0 0 4px;font-size:18px';
    const sub = document.createElement('p');
    sub.textContent = 'Sync your library across devices. Optional — the app works fully offline without an account.';
    sub.style.cssText = 'margin:0 0 16px;opacity:.75;font-size:13px';

    const field = (type, placeholder, autocomplete) => {
      const i = document.createElement('input');
      i.type = type; i.placeholder = placeholder; i.required = true; i.autocomplete = autocomplete;
      i.style.cssText = 'width:100%;box-sizing:border-box;margin-bottom:10px;padding:11px 12px;border-radius:9px;'
        + 'background:#0f1114;color:#e8e8ea;border:1px solid #3a3f49;font:inherit';
      return i;
    };
    const email = field('email', 'Email', 'email');
    const password = field('password', 'Password', 'current-password');

    const status = document.createElement('p');
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = 'margin:8px 0 0;min-height:1.2em;font-size:13px;color:#ff9d9d';

    const btn = (label, primary, type = 'button') => {
      const b = document.createElement('button');
      b.type = type; b.textContent = label;
      b.style.cssText = 'flex:1;padding:11px;border-radius:9px;cursor:pointer;font:inherit;font-weight:600;'
        + (primary ? 'background:#4a9eff;color:#08111c;border:1px solid #4a9eff'
                   : 'background:transparent;color:#e8e8ea;border:1px solid #3a3f49');
      return b;
    };
    const signIn = btn('Sign in', true, 'submit');
    const signUp = btn('Create account');
    const google = btn('Continue with Google');
    google.style.flex = '1 1 100%';
    const cancel = btn('Cancel');
    cancel.style.flex = '0 0 auto';

    const row1 = document.createElement('div');
    row1.style.cssText = 'display:flex;gap:8px;margin-bottom:8px';
    row1.append(signIn, signUp);
    const row2 = document.createElement('div');
    row2.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    row2.append(google, cancel);

    const close = (value) => { backdrop.remove(); resolve(value); };
    const busy = (on) => [signIn, signUp, google].forEach((b) => { b.disabled = on; });

    const attempt = async (fn, okMessage) => {
      if (!email.value || !password.value) { status.textContent = 'Email and password are required.'; return; }
      busy(true);
      status.style.color = '#ff9d9d';
      status.textContent = '';
      try {
        const result = await fn();
        if (result === 'confirm') {
          status.style.color = '#9ae6a0';
          status.textContent = okMessage;
          busy(false);
          return;
        }
        close(result);
      } catch (err) {
        status.textContent = String(err.message || err);
        busy(false);
      }
    };

    card.addEventListener('submit', (e) => {
      e.preventDefault();
      attempt(async () => {
        const next = await gotrue('/token?grant_type=password', {
          body: { email: email.value.trim(), password: password.value },
        });
        storeSession(next);
        return next.user?.email || email.value.trim();
      });
    });

    signUp.addEventListener('click', () => attempt(async () => {
      const next = await gotrue('/signup', { body: { email: email.value.trim(), password: password.value } });
      // Email confirmation is required on this project, so signup returns a user
      // without a session. Say so instead of appearing to hang.
      if (next?.access_token) { storeSession(next); return next.user?.email || email.value.trim(); }
      return 'confirm';
    }, 'Check your email to confirm the account, then sign in.'));

    google.addEventListener('click', () => {
      // Full-page redirect, not a popup: COOP is not applied to ordinary
      // navigations here, but a redirect avoids the popup-blocker and
      // isolation pitfalls entirely.
      const redirect = encodeURIComponent(window.location.origin + window.location.pathname);
      window.location.href = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${redirect}`;
    });

    cancel.addEventListener('click', () => close(null));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', esc); close(null); }
    });

    card.append(h, sub, email, password, row1, row2, status);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    email.focus();
  });
}

/**
 * Google OAuth returns tokens in the URL fragment. Consume it before anything
 * reads location, and scrub the fragment so tokens never linger in history or
 * get copied into a shared link.
 */
function consumeOAuthFragment() {
  if (!window.location.hash || window.location.hash.length < 2) return;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const accessTokenValue = params.get('access_token');
  if (!accessTokenValue) return;
  storeSession({
    access_token: accessTokenValue,
    refresh_token: params.get('refresh_token'),
    expires_at: Number(params.get('expires_at') || 0),
    token_type: params.get('token_type'),
  });
  history.replaceState(null, '', window.location.pathname + window.location.search);
  log('INFO', 'Signed in via Google OAuth redirect');
}
consumeOAuthFragment();

// ------------------------------------------------------------------ bridge ---

async function getCurrentUser() {
  const token = await accessToken();
  if (!token) return null;
  try {
    const user = await gotrue('/user', { method: 'GET', token });
    return user?.email || null;
  } catch (err) {
    log('WARN', 'Supabase user lookup failed', String(err));
    return null;
  }
}

/** Read the caller's own row. RLS scopes this to one row; avatar bytes excluded. */
async function readProfileRow() {
  const rows = await rest('/user_profiles?select=profile_data,revision&limit=1');
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * Merge locally, then commit through the compare-and-swap RPC. If another
 * device committed first the RPC returns nothing, so re-read and re-merge
 * rather than overwriting their work. This is the replacement for Anvil's
 * serializable transaction retry.
 */
async function syncProfileV3(profileData, baseRevision = 0, deviceId = null) {
  const incoming = typeof profileData === 'string' ? profileData : JSON.stringify(profileData ?? {});
  let lastError = null;

  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt += 1) {
    const row = await readProfileRow();
    const cloud = row?.profile_data ?? {};
    const expected = Number(row?.revision ?? 0);
    const merged = mergeProfile(cloud, incoming, deviceId);

    const committed = await rest('/rpc/commit_user_profile', {
      method: 'POST',
      body: { p_expected_revision: expected, p_profile: merged },
    });
    const record = Array.isArray(committed) ? committed[0] : committed;

    if (record && record.revision != null) {
      merged.revision = Number(record.revision);
      return { profile: merged, revision: Number(record.revision), syncedAt: Date.now() };
    }
    lastError = new Error('Profile changed on another device during sync');
    // Small backoff so two devices racing do not lock-step forever.
    await new Promise((r) => setTimeout(r, 80 * (attempt + 1)));
  }
  throw lastError || new Error('Profile sync failed');
}

async function loadProfile() {
  try {
    const row = await readProfileRow();
    if (!row?.profile_data) return null;
    const profile = normalizeProfile(row.profile_data, 'legacy');
    profile.revision = Number(row.revision ?? 0);
    return profile;
  } catch (err) {
    // Never surface as an exception: sync_core treats a throw as "no cloud
    // profile" and can silently skip a real one (the Anvil Issue-10 behaviour).
    log('WARN', 'Failed to load cloud profile', String(err));
    return null;
  }
}

function decodeAvatar(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.includes(',')) throw new Error('Avatar must be an image data URL');
  const [header, payload] = [dataUrl.slice(0, dataUrl.indexOf(',')), dataUrl.slice(dataUrl.indexOf(',') + 1)];
  const mime = /^data:([^;,]+)/.exec(header)?.[1] || 'image/webp';
  if (!mime.startsWith('image/')) throw new Error('Avatar must be an image');
  const binary = atob(payload);
  if (binary.length > MAX_AVATAR_BYTES) throw new Error('Avatar is too large');
  return { mime, payload };
}

async function saveAvatar(dataUrl) {
  try {
    const { mime, payload } = decodeAvatar(dataUrl);
    // \x-prefixed hex is Postgres' bytea input format over JSON.
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const hex = `\\x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    await rest('/user_profiles?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: { user_id: (await currentUserId()), avatar_bytes: hex, avatar_mime: mime, avatar_hash: hash },
    });
    return true;
  } catch (err) {
    log('ERROR', 'Failed to save avatar', String(err));
    return false;
  }
}

async function loadAvatar() {
  try {
    const rows = await rest('/user_profiles?select=avatar_bytes,avatar_mime&limit=1');
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row?.avatar_bytes) return null;
    const hex = String(row.avatar_bytes).replace(/^\\x/, '');
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return `data:${row.avatar_mime || 'image/webp'};base64,${btoa(binary)}`;
  } catch (err) {
    log('WARN', 'Failed to load avatar', String(err));
    return null;
  }
}

async function currentUserId() {
  const token = await accessToken();
  if (!token) throw new Error('You must be logged in.');
  const user = await gotrue('/user', { method: 'GET', token });
  if (!user?.id) throw new Error('Could not resolve the signed-in user.');
  return user.id;
}

async function deleteAccountData(confirmation) {
  if (String(confirmation || '').trim().toUpperCase() !== 'DELETE') return false;
  try {
    await rest('/user_profiles', { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    return true;
  } catch (err) {
    log('ERROR', 'Failed to delete account data', String(err));
    return false;
  }
}

// The nine names the existing call sites expect.
window.anvilGetCurrentUser = getCurrentUser;
window.anvilLogin = async () => {
  const existing = await getCurrentUser();
  if (existing) return existing;
  return showLoginForm();
};
window.anvilLogout = async () => {
  const token = await accessToken();
  if (token) { try { await gotrue('/logout', { token }); } catch (_) { /* local sign-out still applies */ } }
  storeSession(null);
  return true;
};
window.anvilSyncProfileV3 = syncProfileV3;
window.anvilSyncProfile = async (profileData) => {
  try { return !!(await syncProfileV3(profileData, 0, null)); }
  catch (err) { log('WARN', 'Legacy profile push failed', String(err)); return false; }
};
window.anvilLoadProfile = loadProfile;
window.anvilSaveAvatar = saveAvatar;
window.anvilLoadAvatar = loadAvatar;
window.anvilDeleteAccountData = deleteAccountData;

// Forward-looking aliases; the anvil* names are removed once call sites move.
window.pocketAuth = {
  getCurrentUser, login: window.anvilLogin, logout: window.anvilLogout,
  syncProfile: syncProfileV3, loadProfile, saveAvatar, loadAvatar, deleteAccountData,
  isSignedIn: () => !!session?.access_token,
};
