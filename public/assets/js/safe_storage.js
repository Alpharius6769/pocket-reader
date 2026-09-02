// Storage that cannot throw.
//
// localStorage and sessionStorage throw in more situations than they are
// usually written for: setItem raises QuotaExceededError once the origin is
// full, and every method can raise SecurityError where site data is blocked
// (an embedded context, a browser configured to refuse storage, some
// enterprise policies). An uncaught throw there does not degrade the feature
// that wanted to remember something -- it aborts whatever handler was running,
// which is how a full disk turns into "narration stopped working".
//
// These wrappers keep the exact semantics of the real API for the success path,
// including getItem's null-for-missing, so they are drop-in at a call site.
//
// IMPORTANT -- do NOT blanket-replace every storage call with these. Code that
// wraps a write in its own try/catch is often relying on the throw: the profile
// save in library_manager catches QuotaExceededError and retries with a slimmed
// payload, and a non-throwing setItem would silently skip that recovery and
// lose data instead of shedding it. These are for the call sites that had no
// handler at all, where the honest behaviour is "remember it if you can".

function readFrom(storage, key) {
  try {
    return storage.getItem(key);
  } catch (_) {
    return null;   // matches getItem's own answer for "nothing stored"
  }
}

// Returns whether the value actually persisted, so a caller that cares can tell
// the difference between "saved" and "storage refused it". Most do not care,
// which is exactly why they had no try/catch to begin with.
function writeTo(storage, key, value) {
  try {
    storage.setItem(key, value);
    return true;
  } catch (_) {
    return false;
  }
}

function removeFrom(storage, key) {
  try {
    storage.removeItem(key);
    return true;
  } catch (_) {
    return false;
  }
}

function clearAll(storage) {
  try {
    storage.clear();
    return true;
  } catch (_) {
    return false;
  }
}

// Resolved lazily on each call rather than captured once: accessing
// globalThis.localStorage can itself throw, and doing that at module scope
// would break the import for every consumer instead of one call.
function localBacking() {
  try {
    return globalThis.localStorage;
  } catch (_) {
    return null;
  }
}

function sessionBacking() {
  try {
    return globalThis.sessionStorage;
  } catch (_) {
    return null;
  }
}

const guard = (backing) => ({
  getItem(key) {
    const store = backing();
    return store ? readFrom(store, key) : null;
  },
  setItem(key, value) {
    const store = backing();
    return store ? writeTo(store, key, value) : false;
  },
  removeItem(key) {
    const store = backing();
    return store ? removeFrom(store, key) : false;
  },
  clear() {
    const store = backing();
    return store ? clearAll(store) : false;
  },
});

export const prLocal = guard(localBacking);
export const prSession = guard(sessionBacking);

// Also published on window so a non-module context can reach them.
globalThis.prLocal = prLocal;
globalThis.prSession = prSession;
