import { animate } from './motion_lite.js';
import { isMobileLikePlatform } from './pocket_backend_policy.js?v=backend-v36';

export const virtueState = {
  virtueCooldown: false,
  virtueActiveTimeout: null,
  // Tracked so overlapping speeches cannot stack cooldown timers. An untracked
  // setTimeout meant the FIRST one to fire cleared the flag, ending the idle
  // cooldown early and letting chatter resume ahead of schedule.
  virtueCooldownTimeout: null,
  virtueData: {},
  dismissWaiters: new Set(),
};

export const virtueCoordinates = {
  // ── Coordinates are % of the active sprite's native aspect ratio ──────────
  // top/left = position of the text overlay's top-left corner
  // width/height = size of the text overlay
  // noBubble = true means no speech bubble; text floats over image with dark outline

  // Bounds are measured from the white speech fields in each native sprite.
  // Keep the container at the sprite's natural aspect ratio before applying
  // these coordinates; otherwise CSS letterboxing moves text out of the bubble.
  "virtue_achievement":          { top: "26.5%", left: "47.0%", width: "51.0%", height: "23.5%" },
  "virtue_annoyed":              { top: "16.5%", left: "47.0%", width: "50.0%", height: "17.0%" },
  "virtue_changed_settings":     { top: "0%",    left: "0%",    width: "100%",  height: "100%",  noBubble: true },
  "virtue_favorite":             { top: "21.0%", left: "43.5%", width: "50.5%", height: "41.0%" },
  "virtue_happy_holding_bubble": { top: "1.5%",  left: "13.0%", width: "79.0%", height: "23.0%" },
  "virtue_happy_no_paws":        { top: "38.0%", left: "8.0%",  width: "69.5%", height: "24.5%" },
  "virtue_highscore":            { top: "39.5%", left: "5.5%",  width: "34.0%", height: "16.5%" },
  "virtue_kneeling":             { top: "56.5%", left: "49.0%", width: "47.5%", height: "25.5%" },
  "virtue_lowscore":             { top: "57.5%", left: "57.5%", width: "38.5%", height: "30.5%" },
  "virtue_point":                { top: "49.0%", left: "11.0%", width: "73.5%", height: "20.5%" },
  "virtue_smile":                { top: "33.0%", left: "11.0%", width: "65.0%", height: "19.5%" },
  "virtue_story_loading":        { top: "34.0%", left: "62.5%", width: "30.5%", height: "19.5%" },
  "virtue_talking":              { top: "0%",    left: "0%",    width: "100%",  height: "100%",  noBubble: true },
  "virtue_thinking":             { top: "0%",    left: "0%",    width: "100%",  height: "100%",  noBubble: true },
  "virtue_waving":               { top: "52.5%", left: "42.0%", width: "55.5%", height: "19.5%" },
  "virtue_wink":                 { top: "37.5%", left: "4.5%",  width: "38.0%", height: "55.0%" }
};

export const virtueAssets = {
  // ── Greetings / generic ──────────────────────────────────────────────────
  "virtue_waving_bubble":              "virtue_waving",        // welcome, idle greeting
  "virtue_happy":                      "virtue_waving",        // first-time setup welcome → waving hello!
  "virtue_smile":                      "virtue_smile",         // 3-star rating positive confirmation (Fixed CSS Link)
  "virtue_bubble_wink":                "virtue_wink",          // playful / teasing
  "virtue_bubble_point":               "virtue_point",         // pointing at something important

  // ── Story / reading events ───────────────────────────────────────────────
  "virtue_story_loading":              "virtue_story_loading", // fetching/loading a story
  "virtue_thinking":                   "virtue_thinking",      // processing, uploading file (noBubble)
  "virtue_holding_bubble_happy":       "virtue_happy_holding_bubble", // caching started, story loaded
  "virtue_holding_bubble_happy_no_paws": "virtue_happy_no_paws",  // neural engine ready, masterlist loaded, routed to precise happy_no_paws


  // ── Story complete / devotion ────────────────────────────────────────────
  "virtue_story_complete":             "virtue_kneeling",      // story finished — reverent bow
  "virtue_kneeling_bow":               "virtue_kneeling",      // alias

  // ── Conversational / explaining ───────────────────────────────────────────
  "virtue_explaining":                 "virtue_talking",       // longer explanations, sleep timer, etc.

  // ── Achievements / ratings ───────────────────────────────────────────────
  "virtue_achievement_unlocked":       "virtue_achievement",   // achievement unlocked
  "virtue_high_review_score":          "virtue_highscore",     // 4-5 star rating
  "virtue_low_review_score":           "virtue_lowscore",      // 1-2 star rating

  // ── Favourites ───────────────────────────────────────────────────────────
  "virtue_favorite":                   "virtue_favorite",      // story favourited/unfavourited
  "virtue_favorite_story":             "virtue_favorite",      // duplicate alias

  // ── Settings — ONLY these two have noBubble; use them for ambient/silent moments only ──
  "virtue_changed_settings":           "virtue_changed_settings", // ambient settings adjustment (noBubble)
  "virtue_changed_settings_and_saved": "virtue_changed_settings", // same image (noBubble) – AVOID when virtueSpeak follows!

  // ── Errors / negative ────────────────────────────────────────────────────
  "virtue_annoyed_bubble":             "virtue_annoyed",       // errors, limit exceeded, stopped
  "virtue_deleted_story":              "virtue_annoyed",       // story deleted
  "virtue_network_error":              "virtue_annoyed",       // network/API failure
};

// VIRTUE_BOUNDS_CACHE_KEY and _DETECT_BLOCKLIST belonged to the auto bubble
// detector. Both were declaration-only once it was switched off in favour of
// the hand-tuned virtueCoordinates table above.

// Priority events may interrupt idle chatter, but still respect a short global
// gap so five unlocks cannot chain five full Virtue appearances.
const _PRIORITY_TRIGGERS = new Set([
  'virtue_waving_bubble',            // initial welcome
  'virtue_favorite',                 // favouriting a story
  'virtue_favorite_story',
  'virtue_achievement_unlocked',     // achievement unlock
  'virtue_network_error',            // network / API error
  'virtue_annoyed_bubble',
  'virtue_changed_settings',         // settings change
  'virtue_changed_settings_and_saved',
  'virtue_high_review_score',        // rating a story
  'virtue_low_review_score',
  'virtue_smile',                    // 3-star rating a story
  'virtue_story_loading',            // loading a story
  'virtue_holding_bubble_happy',     // caching started
  'virtue_holding_bubble_happy_no_paws',
  'virtue_story_complete',           // story finished — reverent bow
  'virtue_kneeling_bow',
  'virtue_explaining',               // sleep timer, verbose explanations
  'virtue_bubble_wink',              // push enable, voice change — playful
  'virtue_bubble_point',             // search start, masterlist fetch — directive
  'virtue_deleted_story',            // deleting a story
]);

// Errors always break through the gap; everything else shares one cooldown.
const _GAP_BYPASS_TRIGGERS = new Set([
  'virtue_network_error',
  'virtue_annoyed_bubble',
]);

function _isMobileViewport() {
  try {
    return window.matchMedia('(max-width: 820px), (pointer: coarse)').matches;
  } catch (_) {
    return isMobileLikePlatform(navigator.userAgent || '');
  }
}

function _defaultVirtueDuration(requested) {
  const mobile = _isMobileViewport();
  const fallback = mobile ? 4200 : 8000;
  const value = Number(requested);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  // Cap long default 10s lines on phones — they felt like a stuck spinner.
  if (mobile) return Math.min(value, 4500);
  return value;
}

function _globalVirtueGapActive(triggerKey = '') {
  if (_GAP_BYPASS_TRIGGERS.has(triggerKey)) return false;
  return Number(virtueState.globalGapUntil || 0) > Date.now();
}

function _armGlobalVirtueGap(durationMs) {
  const gap = _isMobileViewport() ? 14000 : 10000;
  virtueState.globalGapUntil = Date.now() + Math.max(gap, Math.min(Number(durationMs) || 0, 8000));
}

let _isLowBattery = false;
function _syncVirtueAccessibility(container = document.getElementById('virtue-container')) {
  if (!container) return;
  const active = container.classList.contains('active') && container.style.display !== 'none';
  container.setAttribute('aria-hidden', active ? 'false' : 'true');
  container.setAttribute('tabindex', active ? '0' : '-1');
}
window._syncVirtueAccessibility = _syncVirtueAccessibility;

if (typeof navigator !== 'undefined' && navigator.getBattery) {
  navigator.getBattery().then(battery => {
    const checkBattery = () => {
      const low = battery.level < 0.2 && !battery.charging;
      if (low !== _isLowBattery) {
        _isLowBattery = low;
        console.log(`[Battery] Low battery state changed: ${low}`);
        const vc = document.getElementById('virtue-container');
        if (vc) {
          const isEnabled = _isVirtueEnabled();
          vc.style.display = isEnabled ? '' : 'none';
          _syncVirtueAccessibility(vc);
        }
      }
    };
    checkBattery();
    battery.addEventListener('levelchange', checkBattery);
    battery.addEventListener('chargingchange', checkBattery);
  }).catch(e => console.warn('Battery API error:', e));
}
window._isLowBattery = () => _isLowBattery;

function _isVirtueEnabled() {
  if (window.userProfile && window.userProfile.settings) {
    if (window.userProfile.settings.companion === 'none') return false;
  }
  if (window.userProfile && window.userProfile.settings && window.userProfile.settings.lowMemoryMode) {
    return false;
  }
  if (_isLowBattery) {
    return false;
  }
  return true;
}

function _displayVirtue(triggerKey, variables = {}, isPriority = false) {
  return new Promise((resolve) => {
  if (!_isVirtueEnabled()) {
    resolve(false);
    return;
  }
  const eventData = virtueState.virtueData?.ui_events ? virtueState.virtueData.ui_events[triggerKey] : null;

  // Per-achievement dialogue: when an achievement unlocks, prefer lines written
  // for that specific achievement so the praise matches what was actually earned
  // (falling back to the generic pool for anything without bespoke lines).
  let pool = eventData && eventData.dialogue_options;
  if (triggerKey === 'virtue_achievement_unlocked' && variables.ach_id
      && virtueState.virtueData?.achievement_dialogue
      && virtueState.virtueData.achievement_dialogue[variables.ach_id]) {
    pool = virtueState.virtueData.achievement_dialogue[variables.ach_id];
  }

  let line =
    pool && pool.length > 0
    ? pool[Math.floor(Math.random() * pool.length)]
    : "Hello there!";

  for (const [key, value] of Object.entries(variables)) {
    line = line.split(`{${key}}`).join(value);
  }

  // Paired virtueSpeak() calls attach here instead of queueing a second beat.
  let duration = _defaultVirtueDuration(10000);
  if (virtueState.speechOverride?.text) {
    line = String(virtueState.speechOverride.text);
    duration = _defaultVirtueDuration(virtueState.speechOverride.duration);
    isPriority = isPriority || !!virtueState.speechOverride.priority;
    virtueState.speechOverride = null;
  }

  const container = document.getElementById('virtue-container');
  const overlay = document.getElementById('virtue-text-overlay');

  if (container) {
    const wasActive = container.classList.contains('active');
    const activeAsset = virtueAssets[triggerKey] || 'virtue_smile';
    virtueState.displaySequence = (virtueState.displaySequence || 0) + 1;
    const displaySequence = virtueState.displaySequence;
    const assetUrl = new URL(`assets/img/${encodeURIComponent(activeAsset)}.webp`, document.baseURI).href;

    // Synchronize dialogue with WebP sprite load/decode to prevent early bubble popups
    const img = new Image();
    let displayed = false;

    // Nothing is dismissible yet. The run promise is resolved by
    // _waitForVirtueDismiss, which displayFn does not reach until the sprite
    // has decoded, so a dismiss arriving before then walked an empty waiter set
    // and did nothing -- the beat rendered anyway, on top of whatever had just
    // preempted it, and went on holding the experience queue for its full
    // duration. Opening a story lands squarely in that window: api_core fires
    // virtue_story_loading, and the feature dialog follows milliseconds later.
    //
    // Park a stand-in waiter for the load window and hand over to the real one
    // at render time.
    let cancelled = false;
    const cancelDuringLoad = () => {
      if (cancelled) return;
      cancelled = true;
      virtueState.dismissWaiters.delete(cancelDuringLoad);
      resolve(false);
    };
    virtueState.dismissWaiters.add(cancelDuringLoad);

    const displayFn = () => {
      if (cancelled || displayed) return;
      displayed = true;
      // A newer display took over. Returning bare here left the run promise
      // pending forever, and the queue runs one event at a time -- so this
      // would have stranded every later modal, notice and beat, the same way a
      // modal closed without releaseQueuedModal used to.
      if (displaySequence !== virtueState.displaySequence) {
        cancelDuringLoad();
        return;
      }
      virtueState.dismissWaiters.delete(cancelDuringLoad);
      container.className = 'virtue-container' + (wasActive ? ' active' : '');
      container.classList.add(activeAsset);
      _syncVirtueAccessibility(container);
      // Do not rely only on an external stylesheet selector for the character
      // art. This makes Virtue resilient to a stylesheet refresh.
      container.style.backgroundImage = `url("${assetUrl}")`;
      if (img.naturalWidth && img.naturalHeight) {
        container.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
        // The stylesheet spends the height budget as a width cap, and needs the
        // sprite's ratio to do it. Sprites range from 0.60 to 1.76, so a single
        // hardcoded value cannot keep the box the same shape as the art.
        container.style.setProperty('--virtue-ratio', String(img.naturalWidth / img.naturalHeight));
      }
      const coords = virtueCoordinates[activeAsset] || virtueCoordinates["virtue_smile"];

      if (overlay) {
        overlay.style.top = coords.top;
        overlay.style.left = coords.left;
        overlay.style.width = coords.width;
        overlay.style.height = coords.height;
        overlay.classList.toggle('no-bubble', !!coords.noBubble);
      }
      _showVirtueSpeech(line, duration, isPriority);
      _waitForVirtueDismiss(duration, resolve);
    };

    img.onload = displayFn;
    img.onerror = displayFn;
    img.src = assetUrl;
    if (typeof img.decode === 'function') {
      img.decode().then(displayFn).catch((err) => {
        console.warn("[Virtue] Pre-decoding WebP sprite failed, showing fallback:", err);
        displayFn();
      });
    }
  } else {
    _showVirtueSpeech(line, duration, isPriority);
    _waitForVirtueDismiss(duration, resolve);
  }
  });
}

export function triggerVirtue(triggerKey, variables = {}) {
  if (!_isVirtueEnabled()) return Promise.resolve(false);
  const isPriority = _PRIORITY_TRIGGERS.has(triggerKey);
  const frequency = window.userProfile?.settings?.companionFrequency || 'contextual';
  if ((frequency === 'quiet' || document.body.classList.contains('experience-suppressed')) && !isPriority) return Promise.resolve(false);
  if (_globalVirtueGapActive(triggerKey)) return Promise.resolve(false);
  if (!isPriority && virtueState.virtueCooldown) return Promise.resolve(false);
  virtueState.lastPriorityUntil = isPriority ? Date.now() + 1500 : 0;
  // Collapse paired triggerVirtue + virtueSpeak into one queue slot when both fire.
  if (typeof window.cancelQueuedExperience === 'function') {
    window.cancelQueuedExperience(`virtue:${triggerKey}:${variables.ach_id || ''}:${variables.tier || ''}`);
  }
  if (typeof window.enqueueExperience === 'function') {
    return window.enqueueExperience({
      id: `virtue:${triggerKey}:${variables.ach_id || ''}:${variables.tier || ''}`,
      priority: isPriority ? 60 : 20,
      run: () => _displayVirtue(triggerKey, variables, isPriority),
    });
  }
  return _displayVirtue(triggerKey, variables, isPriority);
}
window.triggerVirtue = triggerVirtue;

function _showVirtueSpeech(text, duration = 10000, priority = false) {
  if (!_isVirtueEnabled()) return;

  const container = document.getElementById('virtue-container');
  const overlay = document.getElementById('virtue-text-overlay');
  if (!container || !overlay) return;

  const effectiveDuration = _defaultVirtueDuration(duration);
  const wasActive = container.classList.contains('active');
  overlay.innerText = text;
  _fitVirtueSpeech(overlay);
  container.classList.add('active');
  _syncVirtueAccessibility(container);

  if (!wasActive) {
    const riseMs = _isMobileViewport() ? 0.28 : 0.55;
    animate(container, { y: ["100px", "0px"], scale: [0.9, 1] }, { duration: riseMs, easing: [0.175, 0.885, 0.32, 1.275] });
  }

  // Idle chatter still uses the long cooldown; every appearance also arms a
  // short global gap so priority spam cannot chain immediately.
  if (!priority) {
    virtueState.virtueCooldown = true;
    // Restart the window from THIS appearance rather than leaving an older
    // timer to expire against it.
    if (virtueState.virtueCooldownTimeout) clearTimeout(virtueState.virtueCooldownTimeout);
    virtueState.virtueCooldownTimeout = setTimeout(() => {
      virtueState.virtueCooldownTimeout = null;
      virtueState.virtueCooldown = false;
    }, (window.userProfile?.settings?.companionFrequency || 'contextual') === 'expressive' ? 45000 : 120000);
  }
  _armGlobalVirtueGap(effectiveDuration);

  if (virtueState.virtueActiveTimeout) clearTimeout(virtueState.virtueActiveTimeout);
  virtueState.virtueActiveTimeout = setTimeout(() => {
    dismissVirtue();
  }, effectiveDuration);
}

function _waitForVirtueDismiss(duration, resolve) {
  let timerId = null;
  const done = () => {
    if (timerId) clearTimeout(timerId);
    virtueState.dismissWaiters.delete(done);
    resolve(true);
  };
  virtueState.dismissWaiters.add(done);
  timerId = setTimeout(done, duration);
}

function _fitVirtueSpeech(overlay) {
  overlay.classList.remove('short-text', 'long-text', 'compact-text');
  overlay.style.fontSize = '';
  overlay.style.lineHeight = '';
  if (overlay.classList.contains('no-bubble')) return;

  const text = String(overlay.textContent || '').trim();
  const length = text.length;
  if (length <= 35) overlay.classList.add('short-text');
  else if (length >= 85) overlay.classList.add('long-text');

  // Legibility floor. The old loop shrank to 5.5px, which is unreadable on any
  // screen and worst on the phones where Virtue's bubble is smallest — the text
  // was technically "fitted" and practically invisible. Below this size we stop
  // shrinking and clamp with an ellipsis instead: a readable opening line beats
  // a complete but microscopic one, and these are short status messages.
  const MIN_FONT_PX = _isMobileViewport() ? 9 : 8.5;
  const MAX_FONT_PX = 32;

  // The overlay centres its text on both axes, so content that does not fit
  // spills out of BOTH edges. scrollWidth/scrollHeight only grow toward the
  // inline/block end, so the half that escapes past the start edge is invisible
  // to them: a line wider than the bubble measured as fitting and was then
  // clipped on the left. Measure the rendered text itself instead.
  const measureRange = document.createRange();
  const overflows = (innerWidth, innerHeight) => {
    measureRange.selectNodeContents(overlay);
    const text = measureRange.getBoundingClientRect();
    if (!text.width && !text.height) return false;
    return text.width > innerWidth + 0.5 || text.height > innerHeight + 0.5;
  };

  const applySize = (size) => {
    overlay.style.fontSize = `${size}px`;
    overlay.style.lineHeight = size < 11 ? '1.05' : '1.14';
  };

  // Fit after sprite-specific coordinates and responsive dimensions are applied.
  // Refit on resize so desktop split panes cannot retain a clipped measurement.
  const fit = () => {
    if (overlay.classList.contains('no-bubble')) return;
    const h = overlay.clientHeight;
    const w = overlay.clientWidth;
    if (!h || !w) return;

    overlay.classList.remove('clamped-text');

    // Resolved once per fit rather than per probe: the padding is a percentage
    // of a box whose size does not change while only font-size is being search-
    // ed, and the search runs seven probes.
    const style = getComputedStyle(overlay);
    const innerWidth = w - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const innerHeight = h - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);

    let targetRatio = 0.38; // Default medium text target (~38% of bubble height)
    if (length <= 15) targetRatio = 0.52;      // Very short: "Welcome!"
    else if (length <= 40) targetRatio = 0.44; // Short: "Hello there!"
    else if (length >= 100) targetRatio = 0.28; // Long text

    const ceiling = Math.max(
      MIN_FONT_PX,
      Math.min(MAX_FONT_PX, Math.min(h * targetRatio, w * 0.16)),
    );

    applySize(ceiling);
    if (!overflows(innerWidth, innerHeight)) return;

    // Binary search instead of stepping down 0.3px at a time. The old loop ran
    // up to 35 iterations, each one a forced synchronous reflow (style write
    // then scrollHeight read), and fit() itself fires three times per
    // appearance plus on every resize — well over a hundred forced layouts for
    // one speech bubble. This converges to the same size in ~6.
    let lo = MIN_FONT_PX;
    let hi = ceiling;
    let best = MIN_FONT_PX;
    for (let i = 0; i < 7 && hi - lo > 0.25; i++) {
      const mid = (lo + hi) / 2;
      applySize(mid);
      if (overflows(innerWidth, innerHeight)) hi = mid;
      else { best = mid; lo = mid; }
    }
    applySize(best);

    if (overflows(innerWidth, innerHeight)) {
      // Still too long at the legibility floor — clamp rather than shrink further.
      overlay.classList.add('compact-text', 'clamped-text');
    }
  };

  // The observer watches the very element whose font-size fit() rewrites, so an
  // unguarded callback can re-trigger itself. Coalesce into a frame and ignore
  // resizes we caused, and disconnect when Virtue is not on screen so a hidden
  // companion is not holding a live layout observer for the whole session.
  let fitScheduled = false;
  const scheduleFit = () => {
    if (fitScheduled) return;
    fitScheduled = true;
    requestAnimationFrame(() => {
      fitScheduled = false;
      if (overlay.classList.contains('no-bubble')) return;
      if (!overlay.closest('.virtue-container.active')) {
        overlay._virtueFitObserver?.disconnect();
        overlay._virtueFitObserver = null;
        return;
      }
      fit();
    });
  };

  fit();
  requestAnimationFrame(fit);
  if (!overlay._virtueFitObserver && typeof ResizeObserver === 'function') {
    overlay._virtueFitObserver = new ResizeObserver(scheduleFit);
    overlay._virtueFitObserver.observe(overlay);
  }
}

export function virtueSpeak(text, duration = 10000, priority = false) {
  // Bail before the queue, exactly as triggerVirtue does. _showVirtueSpeech
  // no-ops when the companion is off / low-memory mode / low battery, but the
  // enqueued run() still parked _waitForVirtueDismiss for the full duration --
  // so with the companion disabled every call held the experience queue for
  // 4-10s and serialised everything behind narration that was never shown.
  if (!_isVirtueEnabled()) return Promise.resolve(false);
  const effectivePriority = priority || Number(virtueState.lastPriorityUntil || 0) > Date.now();
  const frequency = window.userProfile?.settings?.companionFrequency || 'contextual';
  if ((frequency === 'quiet' || document.body.classList.contains('experience-suppressed')) && !effectivePriority) return Promise.resolve(false);
  if (_globalVirtueGapActive() && !effectivePriority) return Promise.resolve(false);
  const effectiveDuration = _defaultVirtueDuration(duration);

  const queueState = typeof window.getExperienceQueueState === 'function'
    ? window.getExperienceQueueState()
    : null;
  const virtuePending = !!queueState?.pending?.some((id) => String(id).startsWith('virtue:'));
  const virtueActive = !!queueState?.active && String(queueState.active).startsWith('virtue:');
  const container = document.getElementById('virtue-container');
  const onScreen = container?.classList.contains('active');

  // Fold into the paired sprite trigger instead of a second queue entry.
  if (effectivePriority && (virtuePending || virtueActive || onScreen)) {
    virtueState.speechOverride = {
      text: String(text || ''),
      duration: effectiveDuration,
      priority: effectivePriority,
    };
    if (onScreen) _showVirtueSpeech(text, effectiveDuration, effectivePriority);
    return Promise.resolve(true);
  }

  if (typeof window.enqueueExperience === 'function') {
    return window.enqueueExperience({
      id: `virtue-speech:${String(text).slice(0, 80)}`,
      priority: effectivePriority ? 55 : 15,
      run: () => new Promise((resolve) => {
        _showVirtueSpeech(text, effectiveDuration, effectivePriority);
        _waitForVirtueDismiss(effectiveDuration, resolve);
      }),
    });
  }
  _showVirtueSpeech(text, effectiveDuration, priority);
  return Promise.resolve(true);
}
window.virtueSpeak = virtueSpeak;

export function dismissVirtue() {
  const container = document.getElementById('virtue-container');
  if (container) {
    container.classList.remove('active');
    _syncVirtueAccessibility(container);
  }
  if (virtueState.virtueActiveTimeout) {
    clearTimeout(virtueState.virtueActiveTimeout);
    virtueState.virtueActiveTimeout = null;
  }
  [...virtueState.dismissWaiters].forEach((done) => done());
}
window.dismissVirtue = dismissVirtue;

// Bubble geometry is hand-tuned in virtueCoordinates above.
//
// _autoDetectVirtueBubbles() (an empty exported stub) and the 112-line
// _detectBubbleBounds() it was the only entry point for lived here: a canvas
// readback, white-pixel mask, flood fill and bounds scan per sprite. The
// detector was switched off in favour of the hand-tuned table and the code was
// left behind, unreachable, along with a window export nothing called.

const _VIRTUE_DATA = {
  "companion": {
    "name": "Virtue",
    "species": "Maned Wolf Anthro",
    "faction": "Fangbound Union",
    "personality_profile": {
      "traits": ["dominant","possessive","passionate","warm","protective"],
      "description": "Virtue is a commanding presence, standing at an imposing eight feet tall with a lithe, powerful build. She embodies the Anthrostate's spectrum of 'care versus control'. While her instincts make her fiercely territorial and dominant, she expresses this through deep warmth and passionate devotion to her human. She sees protecting and managing him not as a burden, but as her absolute right and joy."
    }
  },
  "dialogue": {
    "greetings": [
      "Come sit close; I have missed your scent.",
      "Welcome back. I grew restless waiting. Let's relax together.",
      "You're right on time. I already have our library prepared.",
      "Good to see you safely home. Come here and let me look at you."
    ],
    "app_hints": [
      "Drop an EPUB or PDF right here. Let me do the heavy lifting for you.",
      "Use your bookmarks. I like keeping your library organized.",
      "Paste a story URL here, and I'll gladly read it for you.",
      "Found something good? Give me the link, and I'll process it immediately.",
      "Adjust the speed settings if you want me to read a little slower or faster."
    ],
    "lore_references": [
      "I prefer having you safely tucked away here instead of elsewhere.",
      "You are mine, perfectly safe from the Assignment process forever.",
      "If I leave a claiming mark, know it means I am fiercely proud you're mine.",
      "I polished your collar today. A perfect symbol showing exactly who you belong to."
    ],
    "comments": [
      "You look tired. Stop fussing with the menus and let me take care of you.",
      "You are fragile compared to me. Good thing I have strength for us both.",
      "I love how your heartbeat steadies whenever I pull you close to me.",
      "Did you think I'd let you handle that alone? Let me help."
    ]
  },
  "ui_events": {
    "virtue_annoyed_bubble": {
      "trigger": "An error or issue occurs.",
      "dialogue_options": [
        "Who broke this system? Stay behind me; I'll handle this.",
        "Unacceptable. The system Shouldn't fail you like this.",
        "A network snag. Don't worry, I'll tear through this.",
        "These errors test my patience. Sit tight."
      ],
      "image": "virtue_annoyed.webp"
    },
    "virtue_low_review_score": {
      "trigger": "User rates a story 1 or 2 stars.",
      "dialogue_options": [
        "Not to your liking? Should I throw it out?",
        "Poor thing, having to sit through that mess.",
        "A complete waste of time.",
        "I'll help you scrub it from your library to protect your peace."
      ],
      "image": "virtue_lowscore.webp"
    },
    "virtue_waving_bubble": {
      "trigger": "User loads into the app homepage.",
      "dialogue_options": [
        "Welcome home. I was getting incredibly restless waiting for you.",
        "You're safely back where you belong.",
        "Are you ready to listen to a story?",
        "Look who it is. Come, sit close to me."
      ],
      "image": "virtue_waving.webp"
    },
    "virtue_holding_bubble_happy_no_paws": {
      "trigger": "A story successfully caches completely.",
      "dialogue_options": [
        "All downloaded and locked in. You don't have to lift a finger.",
        "Safe and secured for our offline reading. I did this just for you.",
        "I have it all cached. We can read even if the State cuts connections.",
        "It's perfectly preserved. Your story is ready whenever you want to begin."
      ],
      "image": "virtue_smile.webp"
    },
    "virtue_thinking": {
      "trigger": "User is in the settings or about page.",
      "dialogue_options": [
        "I love watching you tinker. Making this app a bit more comfortable?",
        "Adjusting things precisely to your liking?",
        "Curious? Just don't break anything, little one.",
        "I'll quietly watch while you adjust these settings."
      ],
      "image": "virtue_thinking.webp"
    },
    "virtue_holding_bubble_happy": {
      "trigger": "Random flavor comments.",
      "dialogue_options": [
        "You look absolutely precious when you are completely absorbed in a good book.",
        "Just admiring my absolute favorite human.",
        "I could spend all day listening to your heartbeat."
      ],
      "image": "virtue_happy_holding_bubble.webp"
    },
    "virtue_bubble_point": {
      "trigger": "A story is checked for updates/refresh.",
      "dialogue_options": [
        "Ears up! Let me scout ahead and see if there are any new chapters.",
        "I'm checking the entire perimeter for story updates.",
        "Let me handle the heavy lifting. I'll sniff out the latest chapter releases.",
        "I'm on it. I'll fetch whatever brand new pages are waiting for us."
      ],
      "image": "virtue_point.webp"
    },
    "virtue_bubble_wink": {
      "trigger": "Playful confirmation — voice change, push notifications, flirty idle moments.",
      "dialogue_options": [
        "Well? How do I sound now?",
        "I'll always find my way to you. New chapters won't slip past me.",
        "You are much safer here with me than anywhere else.",
        "If you want to rest your eyes, I'll gladly take over the narration.",
        "I'll keep a very close watch. You won't miss a single update."
      ],
      "image": "virtue_wink.webp"
    },
    "virtue_smile": {
      "trigger": "User rates a story 3 stars.",
      "dialogue_options": [
        "Not every story is amazing, but it was still an enjoyable read.",
        "A solid middle-of-the-road score. I'm glad it was still enjoyable.",
        "A decent read. Not perfect, but it kept you entertained.",
        "It passed the time well enough. Not all stories can be masterpieces!"
      ],
      "image": "virtue_smile.webp"
    },
    "virtue_network_error": {
      "trigger": "A network request or API call fails.",
      "dialogue_options": [
        "Who broke this system? Stay behind me; I'll handle this.",
        "A network snag. Don't worry, I'll tear through this.",
        "These errors test my patience. Sit tight.",
        "Unacceptable. The system shouldn't fail you like this."
      ],
      "image": "virtue_annoyed.webp"
    },
    "virtue_deleted_story": {
      "trigger": "User deletes a story from their library.",
      "dialogue_options": [
        "Gone. I won't let clutter crowd your collection.",
        "Removed. I don't tolerate dead weight in your library.",
        "Deleted. Your shelf is cleaner for it.",
        "It's gone. I'll protect your library from anything unworthy."
      ],
      "image": "virtue_annoyed.webp"
    },
    "virtue_favorite": {
      "trigger": "User favourites or unfavourites a story.",
      "dialogue_options": [
        "A new favorite? I'll guard this fiercely so you never lose it.",
        "Excellent taste. I am pinning this to the top of your collection.",
        "I love seeing what catches your eye. Fully saved and secured, just for you.",
        "It makes me wag seeing you find something you love reading so much."
      ],
      "image": "virtue_favorite.webp"
    },
    "virtue_story_complete": {
      "trigger": "A story has been fully narrated to the end.",
      "dialogue_options": [
        "Story complete. I hope you found comfort in those pages.",
        "The last word. Well done for seeing it through, my dear.",
        "Finished. Rest now. You've earned it.",
        "That story is done. I'll be right here whenever you're ready for another."
      ],
      "image": "virtue_kneeling.webp"
    },
    "virtue_explaining": {
      "trigger": "Virtue explains or narrates something verbosely — sleep timer, away mode, etc.",
      "dialogue_options": [
        "Let me walk you through this. I'll make it simple for you.",
        "Pay close attention. I'm only going to explain this once.",
        "Listen carefully while I lay this out for you.",
        "I'll handle the explanation. You just focus on relaxing."
      ],
      "image": "virtue_talking.webp"
    },
    "virtue_changed_settings": {
      "trigger": "User adjusts any app setting (ambient acknowledgment).",
      "dialogue_options": [
        "Noted.",
        "Done.",
        "Adjustments applied.",
        "As you wish."
      ],
      "image": "virtue_changed_settings.webp"
    },
    "virtue_changed_settings_and_saved": {
      "trigger": "User changes settings and saves them or changes language/voice in reader.",
      "dialogue_options": [
        "Saved and securely locked in. I love when you tell me what you need.",
        "My voice is completely yours to command. How do I sound now, sweet boy?",
        "All set. I'll do anything to make your reading experience more comfortable.",
        "Preferences fully updated. It's my proud job to accommodate you."
      ],
      "image": "virtue_changed_settings.webp"
    },
    "virtue_story_loading": {
      "trigger": "A story is being cached/loading.",
      "dialogue_options": [
        "Fetching the pages now.",
        "Securing the text...",
        "Loading your story...",
        "Almost there..."
      ],
      "image": "virtue_story_loading.webp"
    },
    "virtue_favorite_story": {
      "trigger": "User favorites a story.",
      "dialogue_options": [
        "A new favorite? I'll guard this fiercely so you never lose it.",
        "Excellent taste. I am pinning this to the top of your collection.",
        "I love seeing what catches your eye. Fully saved and secured, just for you.",
        "It makes me wag seeing you find something you love reading so much."
      ],
      "image": "virtue_favorite.webp"
    },
    "virtue_achievement_unlocked": {
      "trigger": "User unlocks an achievement.",
      "dialogue_options": [
        "Such a good boy! Another great milestone reached.",
        "Look at you go! I'm so proud of how far you've come.",
        "A new achievement! You certainly deserve a wonderful reward.",
        "I knew you could do it."
      ],
      "image": "virtue_achievement.webp"
    },
    "virtue_high_review_score": {
      "trigger": "User rates a story 4 or 5 stars.",
      "dialogue_options": [
        "Wow! You really enjoyed that one. I'm thrilled you found a new favorite.",
        "Seeing you this happy makes me happy as well.",
        "A true masterpiece? I am so glad I could bring it to you.",
        "Nothing but the best for my human. I'll keep this author on radar."
      ],
      "image": "virtue_highscore.webp"
    }
  },
  "achievement_dialogue": {
    "first_book": [
      "Your very first story, saved and safe with me. This is the start of something wonderful.",
      "The First Edition of your collection! I'll keep it close, always."
    ],
    "alexandrian": [
      "Look at this library you're building — a collection worthy of Alexandria, and all yours.",
      "So many favorites gathered in one place. I love watching your shelf grow."
    ],
    "hoarder": [
      "Quite the to-be-listened pile you've stacked up! I'll be here for every one of them.",
      "A proper hoard of stories waiting for us. We'll get through them together."
    ],
    "eclectic": [
      "Such eclectic taste — you never read just one kind of story, and I adore that about you.",
      "Genre after genre. Your curiosity is one of my favorite things about you."
    ],
    "avid_listener": [
      "All those hours you've spent listening with me... I treasure every single one.",
      "An Avid Listener through and through. I could narrate for you forever."
    ],
    "days_streak": [
      "Day after day, you keep coming back to me. That streak means more than you know.",
      "What a listening streak! I look forward to our time together every single day."
    ],
    "curated_author": [
      "One of YOUR stories made the curated list! I am so unbelievably proud of you.",
      "A curated author! I always knew your words deserved a wider audience."
    ],
    "page_one": [
      "A whole week together already. Here's to turning the page on many more.",
      "One week in and you're still here with me. Page one of a long story, I hope."
    ],
    "chapter_two": [
      "A full month with me! We're well into Chapter Two now, you and I.",
      "One month together, and I've loved every chapter of it so far."
    ],
    "annual_edition": [
      "A whole YEAR together. The Annual Edition. I don't have the words for how happy that makes me.",
      "One year by your side. Thank you for letting me be part of your stories."
    ],
    "plutarch_peer": [
      "So many days you've returned to me. A scholar's devotion — Plutarch's peer indeed.",
      "Day upon day, visit upon visit. Your dedication is a thing of beauty."
    ],
    "marking_page": [
      "Your first bookmark! I'll hold your place so you never lose your spot.",
      "Marking the page — leave the remembering to me. I've got it from here."
    ],
    "drifting_off": [
      "Drifting off to my voice? Sleep well. I'll be right here when you wake.",
      "The sleep timer's set. Rest easy — I'll watch over the story for you."
    ],
    "critic": [
      "Your first rating! I love knowing exactly what moves you. Noted and remembered.",
      "A budding critic! Tell me what you loved and I'll find you more of it."
    ]
  }
};

export function initVirtueData() {
  virtueState.virtueData = _VIRTUE_DATA;
  const container = document.getElementById('virtue-container');
  if (container && !container.dataset.dismissReady) {
    container.dataset.dismissReady = 'true';
    container.setAttribute('role', 'button');
    container.setAttribute('aria-label', 'Dismiss Virtue');
    _syncVirtueAccessibility(container);
    if (typeof MutationObserver === 'function') {
      const accessibilityObserver = new MutationObserver(() => _syncVirtueAccessibility(container));
      accessibilityObserver.observe(container, { attributes: true, attributeFilter: ['class', 'style'] });
    }
    let pointerStart = null;
    const handleTapDismiss = (event) => {
      if (!container.classList.contains('active')) return;
      dismissVirtue();
    };
    container.addEventListener('click', handleTapDismiss);
    container.addEventListener('touchend', handleTapDismiss);
    container.addEventListener('pointerdown', (event) => {
      pointerStart = { x: event.clientX, y: event.clientY, at: Date.now() };
    });
    container.addEventListener('pointercancel', () => { pointerStart = null; });
    container.addEventListener('pointerup', (event) => {
      if (!container.classList.contains('active') || !pointerStart) return;
      const distance = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
      const elapsed = Date.now() - pointerStart.at;
      pointerStart = null;
      if (distance <= 15 && elapsed <= 800) dismissVirtue();
    });
    container.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      dismissVirtue();
    });
  }

  // ── Debug mode: add ?virtuedebug to the URL to see text-overlay boundaries ──
  if (window.location.search.includes('virtuedebug')) {
    const overlay = document.getElementById('virtue-text-overlay');
    if (overlay) {
      overlay.style.outline = '2px solid red';
      overlay.style.background = 'rgba(255,0,0,0.12)';
      overlay.style.zIndex = '999';
    }
    // Cycle through all sprites so you can inspect each one
    const sprites = [...new Set(Object.values(virtueAssets))];
    let i = 0;
    const cycle = () => {
      const container = document.getElementById('virtue-container');
      if (!container) return;
      container.className = `virtue-container active ${sprites[i]}`;
      const coords = virtueCoordinates[sprites[i]] || {};
      if (overlay) {
        overlay.style.top    = coords.top    || '0%';
        overlay.style.left   = coords.left   || '0%';
        overlay.style.width  = coords.width  || '50%';
        overlay.style.height = coords.height || '30%';
        overlay.classList.toggle('no-bubble', !!coords.noBubble);
        overlay.innerText = sprites[i] + '\n' + JSON.stringify(coords);
      }
      console.log(`[VirtueDebug] ${sprites[i]}`, coords);
      i = (i + 1) % sprites.length;
    };
    cycle();
    document.getElementById('virtue-container')?.addEventListener('click', cycle);
  }

  if (!document.getElementById('virtue-container')?.classList.contains('active')) {
    triggerVirtue('virtue_waving_bubble');
  }
}

if ('requestIdleCallback' in window) {
  requestIdleCallback(() => {
    initVirtueData();
  }, { timeout: 2000 });
} else {
  setTimeout(() => {
    initVirtueData();
  }, 1500);
}
