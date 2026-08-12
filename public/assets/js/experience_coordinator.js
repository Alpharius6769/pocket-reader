// Serializes transient UI so achievements, companion feedback, and modals do
// not overwrite each other or appear on top of an interactive screen.
const MAX_PENDING_EVENTS = 12;
const BLOCKING_OVERLAY_IDS = Object.freeze([
  'global-loading-overlay',
  'cache-modal-overlay',
  'wip-modal-overlay',
  'settings-modal-overlay',
  'first-time-setup-modal',
  'caching-progress-modal',
  'feature-dialog',
]);

// Virtue events used to queue 5–6 deep and play back-to-back. Keep at most one
// pending companion beat, and space appearances so the next cannot start instantly.
const VIRTUE_ID_RE = /^(virtue:|virtue-speech:)/;
const MIN_VIRTUE_GAP_MS = 12000;
const ACHIEVEMENT_VIRTUE_DEBOUNCE_MS = 900;

let sequence = 0;
let activeEvent = null;
let wakeTimer = null;
let virtueGapUntil = 0;
let achievementVirtueTimer = null;
let pendingAchievementVirtue = null;
const pendingEvents = [];
const modalReleases = new Map();

function isVisible(element) {
  if (!element) return false;
  if (element.classList.contains('active')) return true;
  return element.style.display === 'flex' || element.style.display === 'block';
}

function hasBlockingOverlay() {
  return BLOCKING_OVERLAY_IDS.some((id) => isVisible(document.getElementById(id)));
}

function isVirtueEventId(id) {
  return VIRTUE_ID_RE.test(String(id || ''));
}

function dropPendingVirtueEvents(exceptId = '') {
  for (let index = pendingEvents.length - 1; index >= 0; index -= 1) {
    const event = pendingEvents[index];
    // Don't drop high-priority interactive virtue events.
    if (!isVirtueEventId(event.id) || event.id === exceptId || event.priority >= 50) continue;
    pendingEvents.splice(index, 1);
    event.resolve(false);
  }
}

function schedulePump(delay = 0) {
  if (wakeTimer) return;
  wakeTimer = window.setTimeout(() => {
    wakeTimer = null;
    pump();
  }, delay);
}

function pump() {
  if (activeEvent || !pendingEvents.length) return;
  const next = pendingEvents[0];
  if (!next.allowDuringModal && hasBlockingOverlay()) {
    schedulePump(300);
    return;
  }
  if (isVirtueEventId(next.id)) {
    const wait = Math.max(0, virtueGapUntil - Date.now());
    if (wait > 0 && next.priority < 50) {
      schedulePump(wait);
      return;
    }
  }

  pendingEvents.shift();
  activeEvent = next;
  let succeeded = true;
  Promise.resolve()
    .then(next.run)
    .catch((error) => {
      succeeded = false;
      console.warn('[ExperienceQueue] Event failed:', next.id, error);
    })
    .finally(() => {
      if (isVirtueEventId(next.id)) {
        virtueGapUntil = Date.now() + MIN_VIRTUE_GAP_MS;
      }
      activeEvent = null;
      next.resolve(succeeded);
      schedulePump();
    });
}

export function enqueueExperience({ id, priority = 0, allowDuringModal = false, run }) {
  if (typeof run !== 'function') return Promise.resolve(false);
  const eventId = String(id || `event-${Date.now()}`);
  if (activeEvent?.id === eventId || pendingEvents.some((event) => event.id === eventId)) {
    return Promise.resolve(false);
  }

  if (isVirtueEventId(eventId)) {
    // One companion beat at a time: drop queued Virtue and replace with the newest.
    dropPendingVirtueEvents(eventId);
    if (activeEvent && isVirtueEventId(activeEvent.id) && Number(priority) < Number(activeEvent.priority || 0)) {
      return Promise.resolve(false);
    }
  }

  if (pendingEvents.length >= MAX_PENDING_EVENTS) {
    const removable = pendingEvents.findIndex((event) => event.priority < priority);
    if (removable < 0) return Promise.resolve(false);
    const [dropped] = pendingEvents.splice(removable, 1);
    dropped.resolve(false);
  }

  return new Promise((resolve) => {
    pendingEvents.push({ id: eventId, priority, allowDuringModal, run, sequence: sequence++, resolve });
    pendingEvents.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
    schedulePump();
  });
}
window.enqueueExperience = enqueueExperience;

export function cancelQueuedExperience(id) {
  const eventId = String(id || '');
  const index = pendingEvents.findIndex((event) => event.id === eventId);
  if (index < 0) return false;
  const [event] = pendingEvents.splice(index, 1);
  event.resolve(false);
  return true;
}
window.cancelQueuedExperience = cancelQueuedExperience;

function ensureNoticeRegion() {
  let region = document.getElementById('experience-notice-region');
  if (!region) {
    region = document.createElement('div');
    region.id = 'experience-notice-region';
    region.className = 'experience-notice-region';
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
  }
  return region;
}

export function queueNotice({ id, title, message, tone = 'info', duration = 4200, actionLabel = '', action = null }) {
  return enqueueExperience({
    id: `notice:${id || title || Date.now()}`,
    priority: tone === 'error' ? 70 : 35,
    run: () => new Promise((resolve) => {
      const region = ensureNoticeRegion();
      const notice = document.createElement('section');
      notice.className = `experience-notice tone-${tone}`;
      notice.innerHTML = `<div><strong>${escapeHtml(title || '')}</strong><p>${escapeHtml(message || '')}</p></div>${actionLabel ? `<button class="pr-btn-sub">${escapeHtml(actionLabel)}</button>` : ''}`;
      notice.querySelector('button')?.addEventListener('click', () => { action?.(); notice.remove(); resolve(true); }, { once: true });
      region.appendChild(notice);
      requestAnimationFrame(() => notice.classList.add('active'));
      setTimeout(() => {
        notice.classList.remove('active');
        setTimeout(() => { notice.remove(); resolve(true); }, 220);
      }, duration);
    }),
  });
}
window.queueNotice = queueNotice;

export function setExperienceSuppressed(suppressed, reason = '') {
  document.body.classList.toggle('experience-suppressed', !!suppressed);
  document.body.dataset.experienceSuppressed = suppressed ? reason : '';
}
window.setExperienceSuppressed = setExperienceSuppressed;

export function queueModalReveal(id, reveal, { priority = 80, eventKey = id, allowDuringModal = false } = {}) {
  const modalId = String(id || 'modal');
  return enqueueExperience({
    id: `modal:${String(eventKey || modalId)}`,
    priority,
    allowDuringModal,
    run: () => new Promise((resolve) => {
      modalReleases.set(modalId, resolve);
      reveal();
    }),
  });
}
window.queueModalReveal = queueModalReveal;

export function releaseQueuedModal(id) {
  const modalId = String(id || '');
  const release = modalReleases.get(modalId);
  if (!release) return;
  modalReleases.delete(modalId);
  release(true);
}
window.releaseQueuedModal = releaseQueuedModal;

function ensureAchievementRegion() {
  let region = document.getElementById('achievement-unlock-region');
  if (region) return region;
  region = document.createElement('div');
  region.id = 'achievement-unlock-region';
  region.className = 'achievement-unlock-region';
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  document.body.appendChild(region);
  return region;
}

function showAchievementUnlock({ ach_id, ach_title, tier }) {
  return new Promise((resolve) => {
    const region = ensureAchievementRegion();
    const iconId = /^[a-z0-9_]+$/i.test(String(ach_id || '')) ? ach_id : 'first_book';
    region.innerHTML = `
      <section class="achievement-unlock-toast" role="status">
        <div class="achievement-unlock-radiance" aria-hidden="true"></div>
        <div class="achievement-unlock-emblem" aria-hidden="true">
          <img src="assets/icons/ach_${iconId}.svg" alt="">
        </div>
        <p class="achievement-unlock-kicker">Achievement unlocked</p>
        <h2>${escapeHtml(ach_title || 'New achievement')}</h2>
        ${tier ? `<p class="achievement-unlock-tier">${escapeHtml(tier)}</p>` : ''}
        <p class="achievement-unlock-detail">Added to your reader profile</p>
      </section>`;
    region.classList.add('active');
    window.setTimeout(() => {
      region.classList.remove('active');
      window.setTimeout(() => {
        region.replaceChildren();
        resolve(true);
      }, 220);
    }, 1600);
  });
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[char]));
}

function scheduleAchievementVirtue(details) {
  pendingAchievementVirtue = details || {};
  if (achievementVirtueTimer) return;
  achievementVirtueTimer = window.setTimeout(() => {
    achievementVirtueTimer = null;
    const payload = pendingAchievementVirtue;
    pendingAchievementVirtue = null;
    if (typeof window.triggerVirtue === 'function') {
      window.triggerVirtue('virtue_achievement_unlocked', payload || {});
    }
  }, ACHIEVEMENT_VIRTUE_DEBOUNCE_MS);
}

export function queueAchievementUnlock(details) {
  const id = `${details?.ach_id || 'achievement'}:${details?.tier || 'base'}`;
  return enqueueExperience({
    id: `achievement:${id}`,
    priority: 100,
    allowDuringModal: true,
    run: () => showAchievementUnlock(details || {}),
  }).then((shown) => {
    // One Virtue reaction for a burst of unlocks, not one per toast.
    if (shown) scheduleAchievementVirtue(details || {});
    return shown;
  });
}
window.queueAchievementUnlock = queueAchievementUnlock;

window.getExperienceQueueState = () => ({
  active: activeEvent?.id || null,
  pending: pendingEvents.map((event) => event.id),
  blocked: hasBlockingOverlay(),
  virtueGapUntil,
});
