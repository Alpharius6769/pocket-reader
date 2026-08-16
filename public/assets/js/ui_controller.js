import { animate } from './motion_lite.js';

export function showView(viewId) {
  try {
    const doSwitch = () => {
      document.querySelectorAll('.view').forEach((v) => {
        if (v) v.classList.remove('active-view');
      });

      const activeEl = document.getElementById(viewId);
      if (activeEl) {
        activeEl.classList.add('active-view');
        animate(activeEl, { opacity: [0, 1], y: ["20px", "0px"] }, { duration: 0.3, easing: [0.22, 1, 0.36, 1] });
      }
      window.currentActiveView = viewId; // diagnostics.js tags log entries with the active view

      // First-visit tips for this page (skipped once dismissed; re-enable in Settings).
      if (typeof window._maybeShowPageTips === 'function') window._maybeShowPageTips(viewId);

      document.querySelectorAll('.nav-btn').forEach((btn) => {
        btn.classList.remove('active-view');
        const clickAction = btn.getAttribute('onclick');
        if (clickAction && clickAction.includes(viewId)) {
          btn.classList.add('active-view');
        }
      });

      // Keep the mobile "More" tab lit while one of its collapsed views is
      // active, and close the popover after any navigation.
      const _moreBtn = document.getElementById('nav-more-btn');
      if (_moreBtn) {
        const secondaryViews = ['search-view', 'hmofa-view', 'settings-view', 'about-view', 'away-mode-view'];
        _moreBtn.classList.toggle('active-view', secondaryViews.includes(viewId));
      }
      if (typeof window.closeNavMore === 'function') window.closeNavMore();

      if (viewId === 'settings-view') {
        if (typeof window.initSettingsUI === 'function') window.initSettingsUI();
        if (typeof window._populateProfileSettings === 'function') window._populateProfileSettings();
        if (typeof window.refreshSiteHealth === 'function') window.refreshSiteHealth();
        if (typeof window.refreshPerfPanel === 'function') window.refreshPerfPanel();
        if (typeof window.renderPocketDeviceSetupSummary === 'function') window.renderPocketDeviceSetupSummary();
      }

      if (viewId === 'away-mode-view') {
        // renderAwayModeUI lives in buffer_manager.js, which is lazy-loaded with
        // the narration runtime. On a cold start it does not exist yet, so the
        // old typeof guard silently rendered nothing and the queue and Quick Add
        // lists came up empty -- they only appeared once some other action
        // (opening a story) had pulled the runtime in. Load it first.
        Promise.resolve(window.ensureNarrationRuntime?.())
          .then(() => window.renderAwayModeUI?.())
          .catch(() => {});
      }

      if (viewId === 'home-view') {
        if (typeof window.updateBookmarksFolder === 'function') window.updateBookmarksFolder();
      }

      if (viewId === 'profile-view') {
        if (typeof window.checkForNewAchievements === 'function') window.checkForNewAchievements();
        if (typeof window.renderAchievements === 'function') window.renderAchievements();
        if (typeof window.renderProfileExtras === 'function') window.renderProfileExtras();
      }

      const vc = document.querySelector('.view-container');
      if (vc) {
        // Chapter text remains internally scrollable, but the reader shell must
        // also scroll when the playback stack is taller than the available view.
        // This prevents Bookmark and Favorite from being clipped on short desktop
        // windows as well as phones.
        vc.style.overflowY = 'auto';
      }

      if (viewId === 'library-view' && !window.curatedLibraryLoaded) {
        // Curated stories seed at app launch (library_manager.seedCuratedLibrary);
        // this is the retry path if that boot-time fetch failed or timed out.
        if (typeof window.seedCuratedLibrary === 'function') window.seedCuratedLibrary();
      }
      if (viewId === 'library-view' && typeof window.renderLibrary === 'function') {
        window.renderLibrary(false);
      }

      if (viewId === 'hmofa-view') {
        // The catalog is ~640 KB gzipped, so it is fetched on first open rather
        // than at launch for a view most sessions never visit.
        window.ensureHmofaMasterlistLoaded?.();
      }

      if (viewId === 'reading-view') {
        const sb = document.getElementById('reader-sidebar');
        if (sb) {
          if (window.innerWidth <= 900) sb.classList.add('collapsed');
          else sb.classList.remove('collapsed');
        }

        _syncReaderSidebarArrow();

        if (typeof window.updateReaderUIText === 'function') window.updateReaderUIText();
      }

      if (vc && viewId !== 'reading-view') vc.scrollTo(0, 0);
    };

    if (document.startViewTransition) {
      const transition = document.startViewTransition(() => {
        try { doSwitch(); } catch (e) { console.error('View transition error:', e); }
      });
      // Some browsers can exceed the View Transition DOM-update
      // budget during startup. The view is already switched; consume the
      // non-fatal timeout so it does not become an app-level runtime error.
      [transition.ready, transition.updateCallbackDone, transition.finished]
        .forEach((phase) => phase?.catch(() => {}));
    } else {
      doSwitch();
    }
  } catch (e) {
    console.error('Error switching view:', e);
  }
}
window.showView = showView;

// ── Mobile bottom-bar "More" popover ─────────────────────────────────────────
// The bottom bar shows Home/Library/Reader/Profile/More; the remaining views
// collapse into a popover sheet toggled by the More tab (declutters the bar so
// labels aren't truncated). No-ops on desktop, where all tabs are visible.
const _navMoreMobileQuery = window.matchMedia('(max-width: 600px)');
function _syncNavMoreAccessibility(open = false) {
  const group = document.getElementById('nav-more-group');
  const btn = document.getElementById('nav-more-btn');
  if (!group) return;
  const hidden = _navMoreMobileQuery.matches && !open;
  group.setAttribute('aria-hidden', hidden ? 'true' : 'false');
  if (hidden) group.setAttribute('inert', '');
  else group.removeAttribute('inert');
  if (btn) btn.setAttribute('aria-expanded', open && _navMoreMobileQuery.matches ? 'true' : 'false');
}
window._syncNavMoreAccessibility = _syncNavMoreAccessibility;

window.toggleNavMore = function(event) {
  if (event) { event.stopPropagation(); event.preventDefault(); }
  const group = document.getElementById('nav-more-group');
  const btn = document.getElementById('nav-more-btn');
  if (!group) return;
  const open = group.classList.toggle('open');
  _syncNavMoreAccessibility(open);
};
window.closeNavMore = function() {
  const group = document.getElementById('nav-more-group');
  const btn = document.getElementById('nav-more-btn');
  if (group) {
    if (group.contains(document.activeElement)) btn?.focus({ preventScroll: true });
    group.classList.remove('open');
  }
  _syncNavMoreAccessibility(false);
};
_navMoreMobileQuery.addEventListener?.('change', () => {
  const group = document.getElementById('nav-more-group');
  if (group) group.classList.remove('open');
  _syncNavMoreAccessibility(false);
});
requestAnimationFrame(() => _syncNavMoreAccessibility(false));
// Tap outside the popover (and outside the More tab) closes it.
document.addEventListener('click', (e) => {
  const group = document.getElementById('nav-more-group');
  if (!group || !group.classList.contains('open')) return;
  const btn = document.getElementById('nav-more-btn');
  if (group.contains(e.target) || (btn && btn.contains(e.target))) return;
  window.closeNavMore();
}, true);

export function toggleReaderSidebar() {
  const sb = document.getElementById('reader-sidebar');
  if (!sb) return;
  sb.classList.toggle('collapsed');
  _syncReaderSidebarArrow();
}
window.toggleReaderSidebar = toggleReaderSidebar;

function _syncReaderSidebarArrow() {
  const sb = document.getElementById('reader-sidebar');
  const arrow = document.getElementById('reader-sidebar-toggle-arrow');
  const toggleBtn = document.querySelector('.reader-sidebar-toggle');

  if (sb && arrow && toggleBtn) {
    if (sb.classList.contains('collapsed')) {
      arrow.textContent = '>';
      toggleBtn.style.left = '8px';
    } else {
      arrow.textContent = '◀';
      toggleBtn.style.left = '280px';
    }
  }
}

export function switchReaderTab(tabName) {
  try {
    ['info', 'chapters', 'bookmarks'].forEach((name) => {
      const btn = document.getElementById(`tab-btn-${name}`);
      const content = document.getElementById(`tab-content-${name}`);
      if (btn) btn.classList.remove('active');
      if (content) content.style.display = 'none';
    });

    const actBtn = document.getElementById(`tab-btn-${tabName}`);
    const actContent = document.getElementById(`tab-content-${tabName}`);

    if (actBtn) actBtn.classList.add('active');
    if (actContent) actContent.style.display = 'block';

    if (tabName === 'bookmarks') renderBookmarksTab();
    if (tabName === 'chapters') renderChaptersTab();
  } catch (e) {
    console.error('Error switching reader tab:', e);
  }
}
window.switchReaderTab = switchReaderTab;

export function renderChaptersTab() {
  const container = document.getElementById('tab-content-chapters');
  if (!container) return;

  if (!window.currentStory || !window.currentStory.chapters) {
    container.innerHTML = '<p style="color:var(--text-muted);">No chapters available.</p>';
    return;
  }

  let html = '<ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px;">';
  window.userProfile.library = window.userProfile.library || [];

  function _formatChapterTitle(idx, title) {
    if (!title || !title.trim()) return `Chapter ${idx + 1}`;
    let t = title.trim();
    // Strip out "Chapter Summary...", "Summary:...", or appended summary text
    t = t.replace(/\s*(?:Chapter\s+Summary|Summary:|\n).*$/is, '').trim();
    if (!t) return `Chapter ${idx + 1}`;
    // Bare "Chapter N" (no subtitle) — always renumber to sequential position
    if (/^chapter\s+\d+\s*$/i.test(t)) return `Chapter ${idx + 1}`;
    // Already has a "Chapter N:" prefix — keep clean title as-is
    if (/^chapter\s+\d+\s*:/i.test(t)) return t;
    return `Chapter ${idx + 1}: ${t}`;
  }

  window.currentStory.chapters.forEach((ch, idx) => {
    const title = _formatChapterTitle(idx, ch.title);
    html += `<li style="background:var(--bg-mid);border:1px solid var(--border-color);border-radius:6px;padding:10px;cursor:pointer;color:var(--accent-blue-text);font-weight:600;transition:border-color 0.1s;" 
 onmouseover="this.style.borderColor='var(--accent-blue)'" onmouseout="this.style.borderColor='var(--border-color)'" onclick="window.jumpToBookmark(${idx}, 0)">${_escapeHtml(title)}</li>`;
  });
  html += '</ul>';
  container.innerHTML = html;
}
window.renderChaptersTab = renderChaptersTab;

export function renderBookmarksTab() {
  const container = document.getElementById('tab-content-bookmarks');
  if (!container) return;

  if (!window.currentStory || !window.userProfile?.library) {
    container.innerHTML = '<p style="color:var(--text-muted);">Bookmarks appear here.</p>';
    return;
  }

  const storyRef = window.currentStory.storyKey || window.getStoryStableKey?.(window.currentStory) || window.currentStory.title;
  const libStory = window.findLibraryStoryByRef?.(storyRef, window.userProfile.library);

  if (!libStory || !libStory.bookmarks || libStory.bookmarks.length === 0) {
    container.innerHTML =
      '<p style="color:var(--text-muted);">No bookmarks saved yet. Click the Bookmark button to save your spot.</p>';
    return;
  }

  let html = '<ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px;">';
  const sorted = libStory.bookmarks.filter((bookmark) => !bookmark.deletedAt).sort((a, b) => b.ts - a.ts);

  sorted.forEach((bm) => {
    const dateStr = new Date(bm.ts).toLocaleDateString();
    const timeStr = new Date(bm.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    html += `<li style="background:var(--bg-mid);border:1px solid var(--border-color);border-radius:6px;padding:10px;cursor:pointer;" 
 onclick="window.jumpToBookmark(${bm.c},${bm.p})"><div style="font-size:0.8rem;color:var(--accent-blue-text);margin-bottom:4px;font-weight:bold;">Chapter ${bm.c + 1}-${dateStr}${timeStr}</div><div style="font-size:0.85rem;color:var(--text-main);font-style:italic;">"${_escapeHtml(bm.t)}"</div></li>`;
  });

  html += '</ul>';
  container.innerHTML = html;
}
window.renderBookmarksTab = renderBookmarksTab;

export function jumpToBookmark(c, p) {
  window.currentChapterIndex = c;
  window.currentParagraphIndex = p;
  window._readerHasScrolled = false;
  window.updateReaderUIText();

  if (window.userProfile && window.userProfile.library && window.currentStory) {
    const storyRef = window.currentStory.storyKey || window.getStoryStableKey?.(window.currentStory) || window.currentStory.title;
    const libStory = window.findLibraryStoryByRef?.(storyRef, window.userProfile.library);
    if (libStory) {
      libStory.progressChapter = c;
      libStory.progressParagraph = p;
      if (typeof window.saveLocalData === 'function') window.saveLocalData();
    }
  }
}
window.jumpToBookmark = jumpToBookmark;

export function populateReaderUI(storyObj, authorFallback) {
  if (!storyObj) return;

  const safeTitle = storyObj.title || "Unknown";
  const safeAuthor = storyObj.author || authorFallback || "Unknown";
  const el = (id) => document.getElementById(id);

  if (el('reader-title-side')) el('reader-title-side').innerText = safeTitle;
  if (el('reader-author-side')) el('reader-author-side').innerText = safeAuthor;
  if (el('reader-words-side')) el('reader-words-side').innerText = storyObj.words || "-";

  if (el('reader-cover-side')) {
    if (storyObj.coverImage) {
      el('reader-cover-side').innerHTML = `<img src="${_escapeHtml(storyObj.coverImage)}" style="width:100%;height:100%;object-fit:cover;border-radius:6px;">`;
    } else {
      const initials = (safeTitle.match(/\b\w/g) || ['?']).slice(0, 2).join('').toUpperCase();
      el('reader-cover-side').innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 140" style="width:100%;height:100%;border-radius:6px;display:block;" aria-label="${_escapeHtml(safeTitle)}"><rect width="100" height="140" rx="6" fill="#1e2a3a"/><rect x="18" y="20" width="64" height="8" rx="3" fill="#4a6fa5"/><rect x="18" y="36" width="64" height="6" rx="3" fill="#2d4a7a"/><rect x="18" y="50" width="48" height="6" rx="3" fill="#2d4a7a"/><text x="50" y="105" text-anchor="middle" dominant-baseline="middle" font-family="system-ui,sans-serif" font-size="28" font-weight="bold" fill="#4a6fa5" opacity="0.85">${initials}</text></svg>`;
    }
  }

  let totalWords = 0;
  if (storyObj.chapters) {
    storyObj.chapters.forEach(c => {
      const chTitle = c.title || '';
      (c.paragraphs || []).forEach(p => {
        // Skip author notes, chapter headings repeated as text, URLs, etc.
        if (_isMetaParagraph(p, storyObj.title, chTitle, safeAuthor)) return;
        totalWords += p.split(/\s+/).filter(Boolean).length;
      });
    });
  }
  const estMins = Math.ceil(totalWords / 250);
  const statsText = `${totalWords.toLocaleString()} words • ~${estMins} min listening time`;
  if (el('reader-stats')) el('reader-stats').innerText = statsText;
  if (el('reader-time-side')) el('reader-time-side').innerText = estMins >= 60
    ? `~${Math.floor(estMins/60)}h ${estMins%60}m`
    : `~${estMins} min`;

  // Set current rating in sidebar star widget
  const storyRef = storyObj.storyKey || window.getStoryStableKey?.(storyObj) || storyObj.title;
  const libEntry = window.findLibraryStoryByRef?.(storyRef, window.userProfile?.library || []);
  const currentRating = libEntry?.userRating || 0;
  if (currentRating > 0) {
    const ratingInput = document.getElementById(`reader-star${currentRating}`);
    if (ratingInput) ratingInput.checked = true;
  } else {
    document.querySelectorAll('#reader-star-rating input').forEach(i => i.checked = false);
  }

  const progBar = el('chapter-progress-bar');
  if (progBar && storyObj.chapters) {
    _buildReaderProgressIndex(storyObj);
    progBar.max = Math.max(0, (window._readerTotalParas || 1) - 1);
    progBar.value = _readerGlobalIndex(window.currentChapterIndex || 0, window.currentParagraphIndex || 0);

    // Notches mark each chapter's starting position along the whole-story bar.
    const notches = el('chapter-notches');
    if (notches) {
      notches.innerHTML = '';
      (window._readerParaOffsets || []).forEach((off) => {
        const opt = document.createElement('option');
        opt.value = off;
        notches.appendChild(opt);
      });
    }
  }
  if (el('reader-title')) el('reader-title').innerText = safeTitle;
  if (el('reader-author')) el('reader-author').innerText = `by ${safeAuthor}`;
  if (el('reader-summary')) el('reader-summary').innerText = storyObj.synopsis || "";

  const preset = libEntry?.narrationPreset || storyObj.narrationPreset || {};
  if (Object.keys(preset).length) storyObj.narrationPreset = { ...preset };
  const voice = preset.voice || window.userProfile?.settings?.pocketVoice;
  if (voice && el('voice-selector')) el('voice-selector').value = voice;
  // The story's narrationPreset.speed is applied by audio_core's
  // getEffectivePlaybackRate() when the next paragraph plays; there is no
  // slider or label to mirror it into.

  window._readerHasScrolled = false;
  renderFullStory(storyObj);
}
window.populateReaderUI = populateReaderUI;

export function renderFullStory(storyObj) {
  const contentDiv = document.getElementById('reader-content');
  if (!contentDiv || !storyObj || !storyObj.chapters) return;

  const parts = [];

  for (let c = 0; c < storyObj.chapters.length; c++) {
    const chapter = storyObj.chapters[c];

    function _fmt(idx, t) {
      if (!t || !t.trim() || t.trim().toLowerCase() === `chapter ${idx+1}`) return `Chapter ${idx + 1}`;
      const tStr = t.trim();
      if (/^chapter\s+\d+/i.test(tStr)) return tStr;
      return `Chapter ${idx + 1}: ${tStr}`;
    }
    const chapterTitle = _fmt(c, chapter.title);
    // Chapter 0 title is already shown by the <h2 id="reader-chapter-title"> above the content.
    // Chapters 1+ need a visible heading so the reader knows where each chapter starts when scrolling.
    if (c === 0) {
      parts.push(`<span id="reader-ch-0"></span>`);
    } else {
      parts.push(`<h1 class="chapter-title" id="reader-ch-${c}">${_escapeHtml(chapterTitle)}</h1>`);
    }

    (chapter.paragraphs || []).forEach((para, p) => {
      const isMeta = _isMetaParagraph(para, storyObj.title, chapterTitle, storyObj.author);
      const cls = isMeta ? 'reader-paragraph meta' : 'reader-paragraph';
      const metaAttr = isMeta ? ' data-meta="true"' : '';
      parts.push(
        `<p class="${cls}" id="reader-p-${c}-${p}" ` +
        `data-chapter="${c}" data-paragraph="${p}"${metaAttr}>${_escapeHtml(para)}</p>`
      );
    });
  }

  contentDiv.innerHTML = parts.join("");

  contentDiv.querySelectorAll('.reader-paragraph').forEach(p => {
    p.ondblclick = () => {
      const c = parseInt(p.dataset.chapter, 10);
      const paraIdx = parseInt(p.dataset.paragraph, 10);
      if (!isNaN(c) && !isNaN(paraIdx) && typeof window.seekToParagraph === 'function') {
        window.seekToParagraph(c, paraIdx);
      }
    };
  });

  updateReaderUIText();
}
window.renderFullStory = renderFullStory;

// Live "time remaining" estimate shown by the seek bar. Counts only narratable
// text (skips meta paragraphs, matching the total-time figure) from the current
// position to the end, then scales by the chosen playback speed so it tracks
// both reading progress and speed changes. The 250 wpm base keeps it consistent
// with the total listening-time estimate shown at the top of the reader.
function _wordsRemaining() {
  const story = window.currentStory;
  if (!story || !story.chapters) return 0;
  // Fast path: O(1) lookup against the suffix-sum array precomputed in
  // _buildReaderProgressIndex (avoids an O(remaining-paragraphs) scan — with a
  // per-paragraph _isMetaParagraph regex — on every paragraph advance).
  const suffix = window._readerParaWords;
  if (Array.isArray(suffix) && window._readerParaOffsets) {
    const g = _readerGlobalIndex(window.currentChapterIndex || 0, window.currentParagraphIndex || 0);
    if (g >= 0 && g < suffix.length) return suffix[g];
  }
  // Fallback: index missing/stale — compute directly.
  const ci = window.currentChapterIndex || 0;
  const pi = window.currentParagraphIndex || 0;
  let words = 0;
  for (let c = ci; c < story.chapters.length; c++) {
    const chap = story.chapters[c];
    if (!chap || !chap.paragraphs) continue;
    const startP = (c === ci) ? pi : 0;
    for (let p = startP; p < chap.paragraphs.length; p++) {
      const para = chap.paragraphs[p];
      if (_isMetaParagraph(para, story.title, chap.title || '', story.author)) continue;
      words += para.split(/\s+/).filter(Boolean).length;
    }
  }
  return words;
}

export function updateTimeRemaining() {
  const elT = document.getElementById('reader-time-remaining');
  if (!elT) return;
  const story = window.currentStory;
  if (!story || !story.chapters) { elT.innerText = ''; return; }
  // Reads the profile/preset rate, not a DOM control -- the time estimate was
  // always computed at 1.0x regardless of the user's configured speed.
  const speed = window.getEffectivePlaybackRate?.()
    || Number(window.currentStory?.narrationPreset?.speed)
    || Number(window.userProfile?.settings?.speed)
    || 1;
  const words = _wordsRemaining();
  if (words <= 0) { elT.innerText = '✓ Finished'; return; }
  const mins = Math.max(1, Math.ceil(words / (250 * speed)));
  elT.innerText = mins >= 60
    ? `⏱ ~${Math.floor(mins / 60)}h ${mins % 60}m left`
    : `⏱ ~${mins} min left`;
}
window.updateTimeRemaining = updateTimeRemaining;

// ── Whole-story progress bar (paragraph resolution) ──────────────────────────
// The reader seek bar tracks position across the entire story at paragraph
// granularity (not just whole chapters), so it advances live while narration
// plays and dragging it scrubs to any paragraph. _readerParaOffsets[c] holds the
// number of paragraphs before chapter c; _readerTotalParas is the grand total.
function _buildReaderProgressIndex(storyObj) {
  const offsets = [];
  let total = 0;
  const chapters = (storyObj && storyObj.chapters) || [];
  const title = storyObj && storyObj.title;
  const storyAuthor = storyObj && storyObj.author;
  // First pass: chapter offsets + narratable word count per global paragraph.
  const perPara = [];
  chapters.forEach((ch) => {
    offsets.push(total);
    const paras = (ch && ch.paragraphs) || [];
    const chTitle = (ch && ch.title) || '';
    for (let p = 0; p < paras.length; p++) {
      const para = paras[p];
      perPara.push(_isMetaParagraph(para, title, chTitle, storyAuthor) ? 0 : para.split(/\s+/).filter(Boolean).length);
    }
    total += paras.length;
  });
  // Suffix sums: words[g] = narratable words from global paragraph g to the end,
  // so _wordsRemaining() is an O(1) lookup. words[total] = 0 (past the end).
  const words = new Array(total + 1);
  words[total] = 0;
  for (let g = total - 1; g >= 0; g--) words[g] = words[g + 1] + perPara[g];
  window._readerParaOffsets = offsets;
  window._readerTotalParas = total;
  window._readerParaWords = words;
}
// Exposed so library_manager (chapter-merge) can rebuild the index in place.
window._buildReaderProgressIndex = _buildReaderProgressIndex;

function _readerGlobalIndex(c, p) {
  const offs = window._readerParaOffsets;
  if (!offs || !offs.length) return 0;
  c = Math.max(0, Math.min(c || 0, offs.length - 1));
  return offs[c] + Math.max(0, p || 0);
}

function _readerLocateGlobal(g) {
  const offs = window._readerParaOffsets || [0];
  g = Math.max(0, Math.min(g, (window._readerTotalParas || 1) - 1));
  let c = 0;
  for (let i = 0; i < offs.length; i++) { if (offs[i] <= g) c = i; else break; }
  return { c, p: g - offs[c] };
}

// oninput while dragging: preview the target and hold off live updates so the
// thumb doesn't get yanked back by playback advancing underneath the drag.
window._readerSeekPreview = function(v) {
  window._readerSeeking = true;
  const loc = _readerLocateGlobal(parseInt(v, 10) || 0);
  const story = window.currentStory;
  const elP = document.getElementById('chapter-seek-preview');
  if (elP && story && story.chapters) {
    const ch = story.chapters[loc.c];
    function _fmt(idx, t) {
      if (!t || !t.trim() || t.trim().toLowerCase() === `chapter ${idx+1}`) return `Chapter ${idx + 1}`;
      const tStr = t.trim();
      if (/^chapter\s+\d+/i.test(tStr)) return tStr;
      return `Chapter ${idx + 1}: ${tStr}`;
    }
    elP.textContent = _fmt(loc.c, ch?.title) + ' •  ' + (loc.p + 1);
    elP.style.opacity = '1';
  }
};

// onchange (drag released / click): commit the scrub to that paragraph.
window._readerSeekCommit = function(v) {
  const loc = _readerLocateGlobal(parseInt(v, 10) || 0);
  if (typeof window.seekToParagraph === 'function') window.seekToParagraph(loc.c, loc.p);
  // Pin the bar to the committed position immediately, then release the lock —
  // so resuming live updates can't briefly snap the thumb back to the pre-seek
  // spot (the old fixed 300ms timer could expire mid-paragraph-advance).
  const progBar = document.getElementById('chapter-progress-bar');
  if (progBar) progBar.value = _readerGlobalIndex(loc.c, loc.p);
  const elP = document.getElementById('chapter-seek-preview');
  if (elP) setTimeout(() => { elP.style.opacity = '0'; }, 1200);
  window._readerSeeking = false;
};

export function updateReaderUIText() {
  if (!window.currentStory) return;

  const currentChapter = window.currentStory.chapters[window.currentChapterIndex];
  if (!currentChapter) return; // stale/out-of-range index after a chapter merge
  const chTitleEl = document.getElementById('reader-chapter-title');
  function _fmt(idx, t) {
    if (!t || !t.trim() || t.trim().toLowerCase() === `chapter ${idx+1}`) return `Chapter ${idx + 1}`;
    const tStr = t.trim();
    if (/^chapter\s+\d+/i.test(tStr)) return tStr;
    return `Chapter ${idx + 1}: ${tStr}`;
  }
  if (chTitleEl) chTitleEl.innerText = _fmt(window.currentChapterIndex, currentChapter.title);

  const progBar = document.getElementById('chapter-progress-bar');
  if (progBar && !window._readerSeeking) {
    if (!window._readerParaOffsets) _buildReaderProgressIndex(window.currentStory);
    progBar.value = _readerGlobalIndex(window.currentChapterIndex || 0, window.currentParagraphIndex || 0);
  }

  updateTimeRemaining();

  document.querySelectorAll('#reader-content .reader-paragraph.highlight').forEach((el) => el.classList.remove('highlight'));

  const activeId = `reader-p-${window.currentChapterIndex}-${window.currentParagraphIndex}`;
  const activeEl = document.getElementById(activeId);

  if (activeEl) {
    activeEl.classList.add('highlight');

    const isInitialResume = !window._readerHasScrolled && (window.currentChapterIndex > 0 || window.currentParagraphIndex > 0);
    const scrollBehavior = window.userProfile?.settings?.scrollBehavior || 'smooth';

    if (scrollBehavior !== 'none') {
      if (isInitialResume) {
        activeEl.scrollIntoView({ behavior: 'auto', block: 'start' });
      } else {
        activeEl.scrollIntoView({ behavior: scrollBehavior, block: 'nearest' });
      }
    }

    window._readerHasScrolled = true;
  }
}
window.updateReaderUIText = updateReaderUIText;

function _escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Author-note detection ──────────────────────────────────────────────────
// Design rule: false-positives (reading a real note as story) are ACCEPTABLE.
// False-negatives (skipping real story content) are NOT acceptable.
// Only return true when confidence is very high.  If in doubt, return false.
function _isMetaParagraph(text, storyTitle = null, chapterTitle = null, storyAuthor = null) {
  if (!text || !text.trim()) return true; // empty
  const raw   = text.trim();
  const lower = raw.toLowerCase();

  // ── Tier 1: Unambiguous structural markers ──────────────────────────────
  // These patterns appear exclusively in author notes / metadata, never in prose.

  // Explicit A/N headers (all common variants)
  if (/^a\/n\b/i.test(raw))                          return true; // A/N: or A/N -
  if (/^\[a\/n\]/i.test(raw))                         return true; // [A/N]
  if (/^\(a\/n\)/i.test(raw))                         return true; // (A/N)
  if (/^~a\/n~/i.test(raw))                           return true; // ~A/N~
  if (/^\*+a\/n\*+/i.test(raw))                       return true; // *A/N* **A/N**
  if (/^author['']?s?\s+note/i.test(raw))             return true; // Author's Note / Author Note:
  if (/^note from (the )?author/i.test(raw))          return true;
  if (/^from (the )?author\b/i.test(raw))             return true;

  // AO3 chapter-note section headers
  if (/^notes?:\s/i.test(raw) && raw.length < 600)   return true; // "Notes: ..." header block
  if (/^end\s*notes?:/i.test(raw))                    return true;
  if (/^chapter\s+notes?:/i.test(raw))                return true;
  if (/^beginning\s+notes?:/i.test(raw))              return true;

  // Fanfic disclaimer boilerplate
  if (/^disclaimer:/i.test(raw) && raw.length < 500) return true;
  if (/^summary:/i.test(raw))                         return true;
  if (/^title:\s/i.test(raw))                         return true;

  // Story / export metadata lines
  if (lower.startsWith('content warning') || lower.startsWith('cw:') || lower.startsWith('tw:'))   return true;
  if (lower.startsWith('status:'))                                        return true;
  if (lower.startsWith('published:') && raw.length < 80)                 return true;
  if (lower.startsWith('updated:')   && raw.length < 80)                 return true;
  if (lower.startsWith('words:')     && raw.length < 80)                 return true;
  if (lower.startsWith('original source:'))                               return true;
  if (lower.startsWith('exported with the assistance of'))                return true;
  if (lower.startsWith('fichub.net'))                                     return true;
  if (lower.startsWith('http://') || lower.startsWith('https://'))       return true;
  if (/^[=\-\*_~]{3,}$/.test(raw))                                       return true; // --- === ~~~

  // ── Tier 2: Story / chapter title echoes ────────────────────────────────
  // Very short paragraph that IS essentially just the title
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normText = norm(lower);
  if (storyTitle) {
    const nt = norm(storyTitle);
    if (nt.length >= 3 && normText === nt) return true;
    if (nt.length >= 3 && normText.startsWith(nt) && normText.length <= nt.length + 8) return true;
  }
  if (chapterTitle) {
    const nc = norm(chapterTitle);
    if (nc.length >= 3 && normText === nc) return true;
    if (nc.length >= 3 && normText.startsWith(nc) && normText.length <= nc.length + 8) return true;
    // AO3/PDF exports often emit "Chapter 1" as a separate line immediately
    // before the fuller "Chapter 1: Title" heading.
    if (/^(chapter|part|book)\s+(?:\d+|[ivxlcdm]+)$/i.test(raw)
        && nc.startsWith(normText)) return true;
  }
  if (storyAuthor) {
    const na = norm(storyAuthor);
    if (na.length >= 3 && normText === na) return true;
  }

  // ── Tier 3: Multi-signal detection for SHORT paragraphs only ────────────
  // Only applied to paragraphs ≤ 75 words.  Requires 2 independent signals
  // from different signal groups so a single phrase in story dialogue can't
  // accidentally trip the filter.
  const wordCount = lower.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 75) {
    let hits = 0;

    // Group A – Direct reader address
    if (/\b(dear readers?|hello (everyone|all|guys|folks)|hey (everyone|all|guys|folks)|hi (everyone|all|guys|folks))\b/.test(lower)) hits++;

    // Group B – Explicit thanks-for-reading phrasing
    if (/\bthank(s| you) (so much )?for (reading|your support|the kudos|all the)\b/.test(lower)) hits++;

    // Group C – Beta / editing acknowledgement
    if (/\b(beta.?read(er|ers|ing)?|proofread(er|ers|ing)?|edited by|my beta)\b/.test(lower)) hits++;

    // Group D – Comment / kudos call-to-action
    if (/\b(leave a comment|drop (a|some) kudos?|let me know (what|in the)|your thoughts( and| below| are))\b/.test(lower)) hits++;

    // Group E – Author's own publishing meta
    if (/\b(cross.?post(ed|ing)?|next chapter (will|should|is)|see you (next|in the next)|until next (chapter|time|update))\b/.test(lower)) hits++;

    // Group F – Self-referential social / platform links in an author context
    if (/\b(find me (on|at)|follow me (on|at)|my (tumblr|twitter|instagram|ao3 profile))\b/.test(lower)) hits++;

    if (hits >= 2) return true;
  }

  return false;
}

// Canonical meta-paragraph detector. Exposed on window so audio_core (playback)
// and buffer_manager (caching) skip exactly the same paragraphs this reader uses
// for word-count/render — previously three divergent copies disagreed, so
// playback read author-notes the cache skipped.
window.isMetaParagraph = _isMetaParagraph;

// showLoadingOverlay(headline, sub, onCancel?) — when onCancel is supplied a
// Cancel button is shown so the user can abort a long/stuck fetch (e.g. FicHub's
// "this can take up to a minute" wait) instead of being trapped on the overlay.
export function showLoadingOverlay(headline, sub, onCancel) {
  let ov = document.getElementById('global-loading-overlay');

  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'global-loading-overlay';
    ov.className = 'global-loading-overlay';
    ov.innerHTML = `<div class="global-loading-card"><div class="global-loading-spinner"></div><div class="global-loading-headline" id="_loading-headline"></div><div class="global-loading-sub" id="_loading-sub"></div><button id="_loading-cancel" class="pr-btn-outline" style="display:none; margin-top:18px;">Cancel</button></div>`;
    document.body.appendChild(ov);
    document.getElementById('_loading-cancel').addEventListener('click', () => {
      const fn = window._loadingCancelHandler;
      window._loadingCancelHandler = null;
      hideLoadingOverlay();
      if (typeof fn === 'function') { try { fn(); } catch (e) {} }
    });
  }

  document.getElementById('_loading-headline').textContent = headline || 'Loading...';
  document.getElementById('_loading-sub').textContent = sub || '';
  window._loadingCancelHandler = (typeof onCancel === 'function') ? onCancel : null;
  const cancelBtn = document.getElementById('_loading-cancel');
  if (cancelBtn) cancelBtn.style.display = window._loadingCancelHandler ? '' : 'none';
  // Delay the actual reveal so quick operations (opening an already-cached
  // story, a sub-300ms fetch) never flash the full-screen modal — it only
  // appears for genuinely slow waits. Text/cancel above are set immediately so
  // the overlay is correct if/when it does show. If it is already visible, or a
  // reveal is already scheduled, just keep the updated text (don't re-delay).
  if (ov.classList.contains('active') || window._loadingOverlayTimer) return;
  window._loadingOverlayTimer = setTimeout(() => {
    window._loadingOverlayTimer = null;
    ov.classList.add('active');
  }, 300);
}
window.showLoadingOverlay = showLoadingOverlay;

export function hideLoadingOverlay() {
  // Cancel any pending reveal so a fast operation that finishes inside the
  // 300ms window never shows the overlay at all.
  if (window._loadingOverlayTimer) {
    clearTimeout(window._loadingOverlayTimer);
    window._loadingOverlayTimer = null;
  }
  const ov = document.getElementById('global-loading-overlay');
  if (ov) ov.classList.remove('active');
  window._loadingCancelHandler = null;
  const cancelBtn = document.getElementById('_loading-cancel');
  if (cancelBtn) cancelBtn.style.display = 'none';
}
window.hideLoadingOverlay = hideLoadingOverlay;

export function showSettingsModal(title, bodyHtml) {
  let overlay = document.getElementById('settings-modal-overlay');

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'settings-modal-overlay';
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
  }

  if (!document.getElementById('settings-modal-title')) {
    const closeIcon = window.prIcon ? window.prIcon('x') : '<span aria-hidden="true">X</span>';
    overlay.innerHTML = `<div class="cache-modal settings-dialog-panel"><button id="settings-modal-close" class="icon-btn settings-dialog-close" aria-label="Close dialog" title="Close">${closeIcon}</button><h3 id="settings-modal-title">Settings</h3><div id="settings-modal-body" class="settings-dialog-body"></div></div>`;
    document.getElementById('settings-modal-close').onclick = () => {
      overlay.classList.remove('active');
      if (typeof window.releaseQueuedModal === 'function') window.releaseQueuedModal('settings-modal-overlay');
    };
  }

  const reveal = () => {
    document.getElementById('settings-modal-title').textContent = title;
    document.getElementById('settings-modal-body').innerHTML = bodyHtml;
    overlay.classList.add('active');
  };
  if (typeof window.queueModalReveal === 'function') {
    return window.queueModalReveal('settings-modal-overlay', reveal, { priority: 75, eventKey: `settings-${title}` });
  }
  reveal();
}
window.showSettingsModal = showSettingsModal;

// In-app notice for short status messages. alert() blocks the whole page, looks
// like a system-level failure inside an installed PWA, and on iOS standalone it
// interrupts audio focus — a poor fit for "still caching, 12 of 20 ready".
// Falls back to alert() only if the companion is unavailable, so a message is
// never silently lost.
export function pocketNotify(message, durationMs = 5000) {
  const text = String(message || '').trim();
  if (!text) return;
  if (typeof window.virtueSpeak === 'function') {
    window.virtueSpeak(text, durationMs);
    return;
  }
  if (typeof alert === 'function') alert(text);
}
window.pocketNotify = pocketNotify;

export function closeCacheModal() {
  const modal = document.getElementById('cache-modal-overlay');
  if (modal) modal.classList.remove('active');
  if (typeof window.releaseQueuedModal === 'function') window.releaseQueuedModal('cache-modal-overlay');

  if (window.currentStory) {
    window.currentStory.cacheDecisionMade = true;
    if (typeof window.saveLocalData === 'function') window.saveLocalData();
  }
}
window.closeCacheModal = closeCacheModal;

export function openCacheModal() {
  const modal = document.getElementById('cache-modal-overlay');
  if (!modal) return;
  // Story loading is blocked on the user's cache choice. Do not queue this
  // behind companion or achievement reveals; that made the decision appear
  // several seconds after the reader had already loaded.
  modal.classList.add('active');
}
window.openCacheModal = openCacheModal;

export function closeWipModal() {
  const cb = document.getElementById('hide-wip-checkbox');
  if (cb && cb.checked) {
    try {
      localStorage.setItem('hide_wip_warning', 'true');
    } catch (e) {}
  }

  const modal = document.getElementById('wip-modal-overlay');
  if (modal) modal.classList.remove('active');
}
window.closeWipModal = closeWipModal;

export function setLibraryFilter(filter) {
  document.querySelectorAll('.filter-chip').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-filter') === filter);
  });

  window.currentLibraryFilter = filter;
  if (typeof window.renderLibrary === 'function') window.renderLibrary();
}
window.setLibraryFilter = setLibraryFilter;

export function setLibraryView(mode) {
  const gridEl = document.getElementById('library-grid');
  if (!gridEl) return;

  const isList = mode === 'list';
  gridEl.classList.toggle('list-mode', isList);

  document.getElementById('library-mode-grid').classList.toggle('active', !isList);
  document.getElementById('library-mode-list').classList.toggle('active', isList);

  try {
    localStorage.setItem('pocketReaderLibraryMode', mode);
  } catch (e) {}

  if (typeof window.renderLibrary === 'function') window.renderLibrary();
}
window.setLibraryView = setLibraryView;

// ── PWA Install Banner ────────────────────────────────────────────────────
// Single source of truth for all PWA install logic.

let _pwaDeferred = null; // holds the Android beforeinstallprompt event

function _isPWA() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}
function _isMobile() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || ((navigator.maxTouchPoints || 0) > 0 && Math.min(window.screen.width, window.screen.height) <= 1024);
}
function _isIOS() {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
}
function _shouldShowPWABanner() {
  if (_isPWA())   return false;   // already installed
  if (!_isMobile()) return false; // desktop — not needed
  if (localStorage.getItem('pwaBannerDismissed') === 'true') return false;
  if (localStorage.getItem('pr_device_profile_handoff_v1') === 'pending') return false;
  // Let a brand-new user finish the account-creation wizard first; the banner
  // is re-triggered by completeFirstTimeSetup/skipFirstTimeSetup so it never
  // competes with the setup modal (Issue 4).
  if (localStorage.getItem('pr_setup_complete') !== 'true') return false;
  return true;
}

window.showIOSInstallPrompt = function() {
  localStorage.removeItem('pwaBannerDismissed');
  _showPWABanner();
};

function _buildBannerAction() {
  const el = document.getElementById('pwa-banner-action');
  if (!el) return;
  if (_isIOS()) {
    el.innerHTML =
      `<div class="pwa-ios-steps">` +
      `<div class="pwa-ios-step"><span class="pwa-step-num">1</span>Open this page in <strong>Safari</strong></div>` +
      `<div class="pwa-ios-step"><span class="pwa-step-num">2</span>Tap the <strong>Share ↑</strong> button at the bottom of the screen</div>` +
      `<div class="pwa-ios-step"><span class="pwa-step-num">3</span>Scroll down and tap <strong>"Add to Home Screen"</strong>, then tap <strong>Add</strong></div>` +
      `</div>`;
  } else if (_pwaDeferred) {
    el.innerHTML =
      `<button class="pr-btn-primary pwa-install-btn-main" onclick="window.installPWA()">` +
      `Install Pocket Reader</button>`;
  } else {
    el.innerHTML =
      `<p class="pwa-manual-hint">Open your browser menu, then choose <strong>"Add to Home Screen"</strong> or <strong>"Install App"</strong></p>`;
  }
}

function _startCountdown() {
  const cb   = document.getElementById('pwa-permanent-dismiss');
  const span = document.getElementById('pwa-countdown');
  const lbl  = document.getElementById('pwa-dismiss-label-text');
  if (!cb) return;
  cb.disabled = true;
  let secs = 3;
  const iv = setInterval(() => {
    secs--;
    if (secs <= 0) {
      clearInterval(iv);
      cb.disabled = false;
      if (lbl) lbl.textContent = "Don't show again";
    } else {
      if (span) span.textContent = secs;
    }
  }, 1000);
}

function _showPWABanner() {
  if (!_shouldShowPWABanner()) return;
  const banner = document.getElementById('pwa-install-banner');
  if (!banner) return;
  _buildBannerAction();
  banner.style.display = 'flex';
  requestAnimationFrame(_syncPWABannerInset);
  _startCountdown();
}

function _syncPWABannerInset() {
  const banner = document.getElementById('pwa-install-banner');
  const visible = !!banner && getComputedStyle(banner).display !== 'none';
  document.documentElement.classList.toggle('pwa-install-banner-visible', visible);
  if (visible) {
    document.documentElement.style.setProperty('--pwa-banner-inset', `${Math.ceil(banner.getBoundingClientRect().height)}px`);
  } else {
    document.documentElement.style.removeProperty('--pwa-banner-inset');
  }
}

// Close for this session only — shows again next load
window.closePWASession = () => {
  const b = document.getElementById('pwa-install-banner');
  if (b) b.style.display = 'none';
  _syncPWABannerInset();
};

// Permanently dismiss — never shows again on this device/browser
window.dismissPWAPermanently = () => {
  localStorage.setItem('pwaBannerDismissed', 'true');
  const b = document.getElementById('pwa-install-banner');
  if (b) b.style.display = 'none';
  _syncPWABannerInset();
};

window.installPWA = async () => {
  if (!_pwaDeferred) return;
  _pwaDeferred.prompt();
  const { outcome } = await _pwaDeferred.userChoice;
  _pwaDeferred = null;
  if (outcome === 'accepted') window.dismissPWAPermanently();
};


// Android Chrome fires this when the page is installable
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _pwaDeferred = e;
  // Update/show the banner now that we have the real install prompt
  const actionEl = document.getElementById('pwa-banner-action');
  if (actionEl && document.getElementById('pwa-install-banner')?.style.display === 'flex') {
    _buildBannerAction(); // swap manual hint for real install button
    requestAnimationFrame(_syncPWABannerInset);
  } else {
    _showPWABanner();
  }
});
window.addEventListener('resize', () => {
  if (document.documentElement.classList.contains('pwa-install-banner-visible')) {
    requestAnimationFrame(_syncPWABannerInset);
  }
}, { passive: true });

// Hide the banner when install completes
window.addEventListener('appinstalled', () => {
  window.dismissPWAPermanently();
});

// Show on load for mobile non-PWA users (iOS never fires beforeinstallprompt, so
// the banner has to be shown proactively). Deferred modules load after the
// document is already parsed, so DOMContentLoaded has usually fired by the time
// this runs — call directly in that case rather than waiting for an event that
// will never arrive (which is why the banner previously didn't appear on iOS).
function _maybeShowPWABannerOnLoad() {
  if (_shouldShowPWABanner()) {
    // Run after the current interaction commits. The old 1.5s delay made the
    // post-setup install prompt easy to miss and unreliable on mobile browsers.
    setTimeout(_showPWABanner, 250);
  }
}
window._maybeShowPWABanner = _maybeShowPWABannerOnLoad;
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _maybeShowPWABannerOnLoad);
} else {
  _maybeShowPWABannerOnLoad();
}

// ── Layout-shell scroll guard ────────────────────────────────────────────────
// overflow:hidden hides the scrollbar but does NOT stop the browser from
// programmatically scrolling a container to reveal a newly focused control. With
// the bar hidden, that silently nudges the top bar and side nav "up and out" as
// the user clicks around. These shells must never scroll, so pin them to 0,0 —
// the real content scroller (.view-container) is deliberately left alone.
function _pinLayoutShell() {
  const shells = [];
  ['.app-wrapper', '.main-content'].forEach((sel) =>
    document.querySelectorAll(sel).forEach((e) => shells.push(e)));
  const reset = (e) => { if (e.scrollTop) e.scrollTop = 0; if (e.scrollLeft) e.scrollLeft = 0; };
  // A focused input inside a position:fixed overlay (the setup wizard, the
  // settings modal, etc.) legitimately needs the browser to scroll it into view
  // above the mobile keyboard. Pinning the shell/root back to 0,0 in that case
  // would shove the input behind the keyboard, so skip the clamp then (Issue 12).
  const inFixedOverlay = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (getComputedStyle(n).position === 'fixed') return true;
    }
    return false;
  };
  const focusedInOverlay = () => {
    const a = document.activeElement;
    return !!(a && inFixedOverlay(a));
  };
  const resetRoot = () => {
    if (focusedInOverlay()) return;
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  };
  shells.forEach((e) => { reset(e); e.addEventListener('scroll', () => reset(e), { passive: true }); });
  window.addEventListener('scroll', resetRoot, { passive: true });
  // After a focus change the engine may scroll on the next frame — clamp it back.
  // Coalesce to at most one pending rAF so rapid focusin events (every input tap)
  // don't pile up animation-frame callbacks.
  let pending = 0;
  document.addEventListener('focusin', () => {
    if (focusedInOverlay()) return;
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = 0; shells.forEach(reset); resetRoot(); });
  }, { passive: true });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _pinLayoutShell);
} else {
  _pinLayoutShell();
}

window.isAppReady = true;

// ── First-time page tips ─────────────────────────────────────────────────────
// Lightweight guided popovers that point (with an arrow) at a key feature the
// first time a user visits each page. Each page can be dismissed permanently via
// a checkbox; all of them can be re-enabled from Settings (window.resetTips).
const _TIPS_BY_VIEW = {
  'home-view': [
    { sel: '#global-search', title: 'Find a story', text: 'Search Archive of Our Own, or paste any story link here to start reading right away.' },
  ],
  'library-view': [
    { sel: '.lib-options-btn', title: 'Story options', text: 'Tap the ⋮ on any story for Permanent Cache, Away Mode, and "Check for New Chapters".' },
    { sel: '#start-precache-btn', title: 'Away Mode', text: 'Queue stories to fully cache in the background so you can listen offline later, even with the app closed.' },
  ],
  'search-view': [
    { sel: '#ao3-page-search', title: 'Search AO3', text: 'Search Archive of Our Own by title, author, or keywords — or paste a direct story link.' },
  ],
  'reading-view': [
    { sel: '#play-btn-main', title: 'Play narration', text: 'Press play to begin. Audio is cached as you listen so playback stays smooth.' },
    { sel: '#voice-selector', title: 'Choose a voice', text: 'Pick a narration voice. Switching voices re-caches the story in the new voice — your other cached voices are kept.' },
  ],
  'hmofa-view': [
    { title: 'HMOFA Masterlist', text: 'Browse the community-curated HMOFA Masterlist. Tap any story to load and narrate it.' },
  ],
  'profile-view': [
    { title: 'Your profile', text: 'Your listening stats and achievements live here — they grow as you read, rate, and explore.' },
  ],
  'settings-view': [
    { title: 'Settings', text: 'Tune the voice, worker count, GPU options and more here. You can also re-enable these tips at the bottom of this page.' },
  ],
};

function _tipDone(view) {
  try { return localStorage.getItem('pr_tips_' + view) === 'done'; } catch (e) { return false; }
}

function _clearTip() {
  const ex = document.getElementById('pr-tip-layer');
  if (ex) {
    if (ex._hl) { ex._hl.style.outline = ''; ex._hl.style.outlineOffset = ''; }
    ex.remove();
  }
}

// Visibility test that also works for position:fixed elements — offsetParent is
// null for fixed boxes even when on screen, which previously made the reader's
// fixed control bar (and the tip targets inside it) look "hidden".
function _isElemVisible(el) {
  if (!el) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}

// Any full-screen modal/overlay a tip must not render behind or fight with.
function _isBlockingOverlayOpen() {
  const ids = ['global-loading-overlay', 'cache-modal-overlay', 'wip-modal-overlay',
               'settings-modal-overlay', 'first-time-setup-modal', 'caching-progress-modal'];
  return ids.some((id) => _isElemVisible(document.getElementById(id)));
}

// The very first view is pre-marked `active-view` in the shell HTML and is
// never routed through showView(), so none of the view-entry work above ever
// ran for it: no first-visit tips, and no achievement check. A reader had to
// navigate away and come back before the page they landed on would introduce
// itself — and achievements earned before the first navigation went unnoticed.
//
// Re-entering the view through showView() would restart its entry animation on
// a page that is already painted, so replay just the side effects instead.
function _runInitialViewEntry() {
  const active = document.querySelector('.view.active-view');
  const viewId = active?.id;
  if (!viewId) return;
  window.currentActiveView = viewId;
  try {
    if (typeof window.checkForNewAchievements === 'function') window.checkForNewAchievements();
    if (viewId === 'profile-view') {
      if (typeof window.renderAchievements === 'function') window.renderAchievements();
      if (typeof window.renderProfileExtras === 'function') window.renderProfileExtras();
    }
    if (viewId === 'home-view' && typeof window.updateBookmarksFolder === 'function') {
      window.updateBookmarksFolder();
    }
    if (typeof window._maybeShowPageTips === 'function') window._maybeShowPageTips(viewId);
  } catch (error) {
    console.warn('[UI] Initial view entry failed:', error);
  }
}

// Deferred through a task in both branches on purpose: the helpers this calls
// (_maybeShowPageTips here, checkForNewAchievements in library_manager) are
// assigned further down this module and in modules that execute after it, so
// running synchronously would find them undefined and silently do nothing —
// the exact failure being fixed.
const _scheduleInitialViewEntry = () => setTimeout(_runInitialViewEntry, 0);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _scheduleInitialViewEntry, { once: true });
} else {
  _scheduleInitialViewEntry();
}

// Bumped whenever a new page's tips start, so a timer left over from a previous
// view (e.g. one waiting on a modal to close) bails instead of popping over the
// page the user has since navigated to.
let _tipSeq = 0;

window._maybeShowPageTips = function(viewId) {
  _clearTip();
  const token = ++_tipSeq;
  const tips = _TIPS_BY_VIEW[viewId];
  if (!tips || _tipDone(viewId)) return;
  let waited = 0;
  const start = () => {
    if (token !== _tipSeq) return;                       // navigated away
    // Hold tips until the page has settled and nothing is covering it — this is
    // what stops reader tips from colliding with the "Prepare narration" popup.
    if (_isBlockingOverlayOpen() && waited++ < 60) return setTimeout(start, 500);
    _runTipSequence(viewId, tips, 0, 0, token);
  };
  setTimeout(start, 650);
};

function _runTipSequence(view, tips, idx, attempt, token) {
  if (token !== _tipSeq) return;                         // a newer view took over
  _clearTip();
  if (idx >= tips.length) { try { localStorage.setItem('pr_tips_' + view, 'done'); } catch (e) {} return; }
  // A modal may have opened mid-sequence — wait it out rather than render behind it.
  if (_isBlockingOverlayOpen()) return setTimeout(() => _runTipSequence(view, tips, idx, attempt, token), 500);
  const tip = tips[idx];
  const target = tip.sel ? document.querySelector(tip.sel) : null;
  if (tip.sel && !_isElemVisible(target)) {
    // Target may load asynchronously (library cards arrive after a fetch). Wait
    // briefly, then skip this tip if it never appears — without blocking the rest.
    if ((attempt || 0) < 8) return setTimeout(() => _runTipSequence(view, tips, idx, (attempt || 0) + 1, token), 400);
    return _runTipSequence(view, tips, idx + 1, 0, token);
  }
  _renderTip(view, tips, idx, tip, target, token);
}

function _renderTip(view, tips, idx, tip, target, token) {
  // A newer page-tip sequence (navigation) may have started before we got here —
  // bail so the tip isn't appended into / scrolled within a view the user left.
  if (token !== _tipSeq) return;
  const isLast = idx >= tips.length - 1;
  const layer = document.createElement('div');
  layer.id = 'pr-tip-layer';
  layer.style.cssText = 'position:fixed;inset:0;z-index:11000;background:rgba(0,0,0,0.35);';
  const card = document.createElement('div');
  card.style.cssText = 'position:absolute;max-width:300px;background:var(--bg-surface,#1e2a3a);color:var(--text-main,#e8edf2);border:1px solid var(--accent-green,#3ecf8e);border-radius:10px;padding:14px 16px;box-shadow:0 6px 24px rgba(0,0,0,0.5);font-size:0.9rem;line-height:1.45;';
  card.innerHTML =
    `<div style="font-weight:700;color:var(--accent-green,#3ecf8e);margin-bottom:6px;">${tip.title || 'Tip'}</div>` +
    `<div style="margin-bottom:12px;">${tip.text || ''}</div>` +
    `<label style="display:flex;align-items:center;gap:8px;font-size:0.78rem;color:var(--text-muted,#9fb0c3);margin-bottom:12px;cursor:pointer;">` +
    `<input type="checkbox" id="pr-tip-dismiss"> Don't show tips on this page again</label>` +
    `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">` +
    `<span style="font-size:0.75rem;color:var(--text-muted,#9fb0c3);">${idx + 1} / ${tips.length}</span>` +
    `<button id="pr-tip-next" class="pr-btn-primary" style="padding:6px 16px;">${isLast ? 'Got it' : 'Next'}</button>` +
    `</div>`;
  layer.appendChild(card);
  document.body.appendChild(layer);

  // Position the card near the target (with an arrow); centered if it has none.
  const cardW = Math.min(300, card.offsetWidth || 300);
  const cardH = card.offsetHeight || 150;
  if (target && _isElemVisible(target)) {
    // Bring the target on screen first so the card/arrow anchor to where it
    // actually is, not to an off-screen rect that clamps the card to the edge.
    const rPre = target.getBoundingClientRect();
    if (rPre.top < 8 || rPre.bottom > window.innerHeight - 8) {
      try { target.scrollIntoView({ block: 'center', behavior: 'instant' }); }
      catch (e) { try { target.scrollIntoView(); } catch (_) {} }
    }
    const r = target.getBoundingClientRect();
    const gap = 14;
    const spaceBelow = window.innerHeight - r.bottom;
    const spaceAbove = r.top;
    // Prefer below; flip above only when below won't fit and above has more room.
    const arrowDown = !(spaceBelow >= cardH + gap || spaceBelow >= spaceAbove);
    let top = arrowDown ? (r.top - cardH - gap) : (r.bottom + gap);
    top = Math.max(8, Math.min(top, window.innerHeight - cardH - 8));
    const left = Math.min(Math.max(8, r.left + r.width / 2 - cardW / 2), window.innerWidth - cardW - 8);
    card.style.top = top + 'px';
    card.style.left = left + 'px';
    target.style.outline = '2px solid var(--accent-green,#3ecf8e)';
    target.style.outlineOffset = '3px';
    layer._hl = target;
    // Arrow points from the card edge toward the target's horizontal centre.
    const arrow = document.createElement('div');
    const ax = Math.min(Math.max(r.left + r.width / 2 - 9, left + 12), left + cardW - 30);
    arrow.style.cssText = 'position:absolute;width:0;height:0;border-left:9px solid transparent;border-right:9px solid transparent;left:' + ax + 'px;';
    if (arrowDown) { arrow.style.top = (top + cardH) + 'px'; arrow.style.borderTop = '10px solid var(--accent-green,#3ecf8e)'; }
    else { arrow.style.top = (top - 10) + 'px'; arrow.style.borderBottom = '10px solid var(--accent-green,#3ecf8e)'; }
    layer.appendChild(arrow);
  } else {
    card.style.top = '50%'; card.style.left = '50%'; card.style.transform = 'translate(-50%,-50%)';
  }

  const finish = (dismissAll) => {
    _clearTip();
    if (dismissAll) { try { localStorage.setItem('pr_tips_' + view, 'done'); } catch (e) {} return; }
    _runTipSequence(view, tips, idx + 1, 0, token);
  };
  const nextBtn = card.querySelector('#pr-tip-next');
  if (nextBtn) nextBtn.onclick = () => finish((card.querySelector('#pr-tip-dismiss') && card.querySelector('#pr-tip-dismiss').checked) || isLast);
  layer.onclick = (e) => { if (e.target === layer) finish(!!(card.querySelector('#pr-tip-dismiss') && card.querySelector('#pr-tip-dismiss').checked)); };
}

// Re-enable all page tips (called from the Settings button).
window.resetTips = function() {
  try {
    Object.keys(_TIPS_BY_VIEW).forEach((v) => localStorage.removeItem('pr_tips_' + v));
  } catch (e) {}
  if (window.virtueSpeak) window.virtueSpeak("Tips re-enabled - they'll pop up again as you visit each page.", 5000);
  else if (typeof alert === 'function') alert('Tips re-enabled.');
};

// The embedded story index lives on a fixed origin. Everything below is scoped
// to it: the handshake is posted only to this origin, and inbound story-load
// commands are accepted only from it.
// Drops the ?tts_fast=1 flag and reloads unisolated. Narration can be started
// again afterwards; it re-isolates on demand.
export function exitPocketNarrationIsolation() {
  try {
    const target = new URL(window.location.href);
    target.searchParams.delete('tts_fast');
    window.location.replace(target.toString());
  } catch (_) {
    window.location.replace('/');
  }
}
window.exitPocketNarrationIsolation = exitPocketNarrationIsolation;

export function handleHmofaManualFetch() {
  const input = document.getElementById('hmofa-url-input');
  if (!input) return;
  const val = String(input.value || '').trim();
  if (!val) {
    if (window.virtueSpeak) window.virtueSpeak("Paste an AO3 story URL or Work ID first!", 4000);
    return;
  }
  const normUrl = typeof window.normalizeStoryUrl === 'function' ? window.normalizeStoryUrl(val) : val;
  input.value = '';
  _handleHmofaStoryIntercept(normUrl, '');
}
window.handleHmofaManualFetch = handleHmofaManualFetch;

export function _handleHmofaStoryIntercept(url, title = '') {
  if (!url) return;
  const displayTitle = title ? `"${title}"` : 'story';
  if (window.virtueSpeak) {
    window.virtueSpeak(`Loading ${displayTitle} into Pocket Reader...`, 5000);
  }
  if (typeof window.loadStory === 'function') {
    window.loadStory(url);
  }
}
window._handleHmofaStoryIntercept = _handleHmofaStoryIntercept;

// Add a shelf of stories to the library in one gesture. Only the last one is
// opened — importing twelve stories should not yank the reader through twelve
// story loads — and the rest land in the library ready to read.
const HMOFA_BATCH_LIMIT = 25;

export async function _handleHmofaStoryBatch(stories) {
  const normalize = (value) => (typeof window.normalizeStoryUrl === 'function'
    ? window.normalizeStoryUrl(value)
    : value);
  const entries = stories
    .map((story) => (typeof story === 'string' ? { url: story } : (story || {})))
    .map((story) => ({
      url: normalize(story.url || story.storyUrl || story.link || story.href || ''),
      title: story.title || story.storyTitle || '',
    }))
    .filter((story) => story.url)
    .slice(0, HMOFA_BATCH_LIMIT);

  if (!entries.length) return { added: 0, failed: 0 };
  if (stories.length > HMOFA_BATCH_LIMIT && window.virtueSpeak) {
    window.virtueSpeak(`That's a lot at once — taking the first ${HMOFA_BATCH_LIMIT}.`, 5000);
  }

  if (typeof window.loadStory !== 'function') return { added: 0, failed: entries.length };

  let added = 0;
  let failed = 0;
  // Sequential on purpose. Each import hits the scrape backend, and loadStory
  // aborts any load still in flight — concurrent calls would cancel each other
  // and only the last would survive. preventNavigate keeps the reader where
  // they are and suppresses the per-story overlay; only the final story opens.
  for (const entry of entries.slice(0, -1)) {
    try {
      await window.loadStory(entry.url, { preventNavigate: true });
      added += 1;
    } catch (error) {
      failed += 1;
      window.Diagnostics?.log('WARN', 'HMOFA batch import skipped a story', {
        url: entry.url, error: error?.message || String(error),
      });
    }
  }

  const last = entries[entries.length - 1];
  _handleHmofaStoryIntercept(last.url, last.title);
  added += 1;

  if (window.virtueSpeak && entries.length > 1) {
    window.virtueSpeak(
      failed
        ? `Added ${added} to your library — ${failed} couldn't be fetched.`
        : `Added ${added} stories to your library.`,
      5000,
    );
  }
  return { added, failed };
}
window._handleHmofaStoryBatch = _handleHmofaStoryBatch;

function _initMasterlistStickyScrollbar() {}
window._initMasterlistStickyScrollbar = _initMasterlistStickyScrollbar;

// Service worker strategy:
// - Debug env (/debug/ URL): unregister everything; the debug environment does
//   not support SharedArrayBuffer and must remain unobstructed.
// - Production: auto-register for offline asset caching only.
if ('serviceWorker' in navigator) {
  // The app runs standalone on Pages; no host-shell frame escape is needed.

  const isDebug = window.location.pathname.startsWith('/debug/');
  if (isDebug) {
    navigator.serviceWorker.getRegistrations()
      .then(regs => regs.forEach(r => r.unregister()))
      .catch(() => {});
  } else {
    // Register the service worker purely for offline asset caching.
    //
    // We deliberately do NOT reload on `controllerchange`. Isolation is entered
    // explicitly through the ?tts_fast=1 narration handoff so ordinary account
    // and OAuth pages retain their popup relationship.
    const swUrl = new URL('sw.js?v=160', document.baseURI).href;
    const swFallbackUrl = new URL('sw.js', document.baseURI).href;
    const registrationPromise = window.__prServiceWorkerRegistration || navigator.serviceWorker
    .register(swUrl)
    .catch(() => navigator.serviceWorker.register(swFallbackUrl));
    window.__prServiceWorkerRegistration = registrationPromise
      .catch((err) => {
        window.__prServiceWorkerError = {
          name: err?.name || 'Error',
          message: err?.message || String(err),
        };
        console.warn("[Service Worker] Registration failed:", err);
        return null;
      });
  }
}

window._setupAvatarUpload = async function(ev) {
  const f = ev && ev.target && ev.target.files && ev.target.files[0];
  if (!f) return;
  ev.target.value = '';
  try {
    const prepared = typeof window.prepareAvatarForStorage === 'function'
      ? await window.prepareAvatarForStorage(f)
      : await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error || new Error('Could not read avatar image.'));
          reader.readAsDataURL(f);
        });
    const img = document.getElementById('setup-avatar-preview');
    if (img) img.src = prepared;
  } catch (error) {
    console.error('[Setup] Failed to prepare avatar:', error);
  }
};

// Live preview of the reader font/size (and app text-size labels) in the wizard,
// so users see their choice before committing.
window._setupPreview = function() {
  const prev = document.getElementById('setup-preview');
  const font = document.getElementById('setup-reader-font');
  const rsize = document.getElementById('setup-reader-size');
  const asize = document.getElementById('setup-app-size');
  const rLbl = document.getElementById('setup-reader-size-label');
  const aLbl = document.getElementById('setup-app-size-label');
  if (rsize && rLbl) rLbl.innerText = rsize.value + 'pt';
  if (asize && aLbl) aLbl.innerText = asize.value + 'pt';
  if (asize) {
    const appSize = Math.max(10, Math.min(18, Number(asize.value) || 13));
    // The setup picker should preview the application scale immediately, not
    // just update its label. applySettings() persists the same value on save.
    document.documentElement.style.setProperty('--app-font-size', `${appSize}pt`);
  }
  if (prev) {
    if (font) prev.style.fontFamily = font.value;
    if (rsize) prev.style.fontSize = rsize.value + 'pt';
  }
};

function _readFavInputs(prefix) {
  const out = [];
  for (let i = 1; i <= 5; i++) {
    const v = (document.getElementById(prefix + i)?.value || '').trim();
    if (v) out.push(v);
  }
  return out;
}

const SETUP_DRAFT_STORAGE_KEY = 'pr_setup_draft_v1';
const SETUP_AUTH_STORAGE_KEY = 'pr_setup_auth_v1';
const DEVICE_PROFILE_HANDOFF_KEY = 'pr_device_profile_handoff_v1';
const SETUP_DRAFT_FIELD_IDS = [
  'setup-username', 'setup-usertype', 'setup-companion', 'setup-theme',
  'setup-reader-font', 'setup-reader-size', 'setup-app-size', 'setup-genre',
  'setup-fandom', 'setup-length', 'setup-mood',
  'setup-fav-1', 'setup-fav-2', 'setup-fav-3', 'setup-fav-4', 'setup-fav-5',
];

function _readSetupDraft() {
  const values = {};
  SETUP_DRAFT_FIELD_IDS.forEach((id) => {
    const element = document.getElementById(id);
    if (element) values[id] = element.value;
  });
  const avatar = document.getElementById('setup-avatar-preview')?.src || '';
  const rememberLogin = document.getElementById('setup-remember-login')?.checked;
  return {
    values,
    avatar: avatar.startsWith('data:') ? avatar : '',
    rememberLogin: rememberLogin !== false,
  };
}

function _persistSetupDraft() {
  try { localStorage.setItem(SETUP_DRAFT_STORAGE_KEY, JSON.stringify(_readSetupDraft())); } catch (_) {}
}

function _restoreSetupDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETUP_DRAFT_STORAGE_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return false;
    Object.entries(saved.values || {}).forEach(([id, value]) => {
      const element = document.getElementById(id);
      if (element && value != null) element.value = String(value);
    });
    const avatar = document.getElementById('setup-avatar-preview');
    if (avatar && saved.avatar?.startsWith('data:')) avatar.src = saved.avatar;
    const remember = document.getElementById('setup-remember-login');
    if (remember && typeof saved.rememberLogin === 'boolean') remember.checked = saved.rememberLogin;
    window._setupPreview?.();
    return true;
  } catch (_) {
    return false;
  }
}
window.restoreSetupDraft = _restoreSetupDraft;

function _restoreSetupAccountState() {
  if (localStorage.getItem('pr_setup_complete') === 'true' && localStorage.getItem(DEVICE_PROFILE_HANDOFF_KEY) !== 'pending') return false;
  try {
    const auth = JSON.parse(localStorage.getItem(SETUP_AUTH_STORAGE_KEY) || 'null');
    if (!auth?.email) return false;
    const statusEl = document.getElementById('setup-cloud-status');
    const btn = document.getElementById('setup-cloud-btn');
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.innerHTML = 'Signed in as <strong>' + _escapeHtml(auth.email)
        + '</strong>. Your setup choices are still here; choose Save and Start Reading to finish and sync them.';
    }
    if (btn) btn.textContent = 'Switch Account';
    return true;
  } catch (_) {
    return false;
  }
}

function _restoreFirstTimeSetupState() {
  if (localStorage.getItem('pr_setup_complete') === 'true' && localStorage.getItem(DEVICE_PROFILE_HANDOFF_KEY) !== 'pending') return;
  _restoreSetupDraft();
  _restoreSetupAccountState();
}

document.addEventListener('input', (event) => {
  if (SETUP_DRAFT_FIELD_IDS.includes(event.target?.id)) _persistSetupDraft();
});
document.addEventListener('change', (event) => {
  if (SETUP_DRAFT_FIELD_IDS.includes(event.target?.id) || event.target?.id === 'setup-remember-login') _persistSetupDraft();
});
setTimeout(_restoreFirstTimeSetupState, 100);
setTimeout(_restoreFirstTimeSetupState, 1200);

function _deferCloudLoginOutsideFastNarration(action) {
  const url = new URL(window.location.href);
  if (url.searchParams.get('tts_fast') !== '1') return false;
  sessionStorage.setItem('pr_resume_cloud_login_v1', action);
  url.searchParams.delete('tts_fast');
  window.location.replace(url.href);
  return true;
}

window._setupCloudLogin = async function() {
  const btn = document.getElementById('setup-cloud-btn');
  const statusEl = document.getElementById('setup-cloud-status');
  const modal = document.getElementById('first-time-setup-modal');
  _persistSetupDraft();
  if (_deferCloudLoginOutsideFastNarration('setup')) return;
  if (!window.pocketCloud?.login) {
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Cloud service is not ready yet. Please wait a moment and try again.'; }
    return;
  }
  if (window._setupLoginInFlight) return;
  window._setupLoginInFlight = true;
  if (btn) btn.disabled = true;
  const gatewayButtons = [...document.querySelectorAll('#setup-account-gateway .account-option')];
  gatewayButtons.forEach((button) => { button.disabled = true; });
  // The cloud bridge displays its secure login form above the app shell. Leaving this
  // high-z-index onboarding overlay visible intercepts the form and looks like
  // a frozen screen, especially on mobile/PWA.
  const reopenSetup = modal?.style.display === 'flex' || getComputedStyle(modal || document.body).display === 'flex';
  if (reopenSetup && modal) {
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  try {
    const email = await window.pocketCloud.login();
    if (email) {
      // First-time setup runs on a fresh profile, so the account logging in
      // simply adopts it as owner.
      localStorage.setItem('pr_profile_owner', email);
      localStorage.setItem(SETUP_AUTH_STORAGE_KEY, JSON.stringify({ email, signedInAt: Date.now() }));
      window._cloudPushAllowed = true;
      window.userProfile = window.userProfile || { settings: {} };
      window.userProfile.isLoggedIn = true;
      window.userProfile.cloudEmail = email;
      const remember = document.getElementById('setup-remember-login')?.checked !== false;
      localStorage.setItem('pr_remember_login', remember ? 'true' : 'false');
      // The topbar display-name slot shows the user's chosen name (set on setup
      // completion), not the raw email (Issue 8); the email appears in the
      // status line below and on the Profile cloud-sync card.
      if (statusEl) { statusEl.style.display = 'block'; statusEl.innerHTML = `Signed in as <strong>${_escapeHtml(email)}</strong> - your profile will be backed up when you finish setup.`; }
      if (btn) btn.textContent = 'Switch Account';
    }
  } catch(e) {
    console.warn('[Setup] Cloud login cancelled or failed:', e);
  } finally {
    window._setupLoginInFlight = false;
    if (btn) btn.disabled = false;
    gatewayButtons.forEach((button) => { button.disabled = false; });
    if (reopenSetup && modal) {
      _restoreSetupDraft();
      if (typeof window.activatePocketModal === 'function') {
        window.activatePocketModal(modal, '#setup-username');
      } else {
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
      }
    }
  }
};

window.completeFirstTimeSetup = () => {
  const p = window.userProfile = window.userProfile || {};
  p.settings = p.settings || {};

  const username = (document.getElementById('setup-username')?.value || '').trim() || 'Guest Reader';
  const avatar = document.getElementById('setup-avatar-preview')?.src || '';
  const userCategory = document.getElementById('setup-usertype')?.value || '';
  const rawCompanion = document.getElementById('setup-companion')?.value || 'virtue';
  const companion = ['virtue', 'none', 'jade'].includes(rawCompanion) ? rawCompanion : 'virtue';
  const theme = document.getElementById('setup-theme')?.value || 'slate';
  const readerFont = document.getElementById('setup-reader-font')?.value || '';
  const readerSize = parseInt(document.getElementById('setup-reader-size')?.value || '13', 10);
  const appSize = parseInt(document.getElementById('setup-app-size')?.value || '13', 10);
  const favoriteGenre = (document.getElementById('setup-genre')?.value || '').trim();
  const currentlyReading = (document.getElementById('setup-currently')?.value || '').trim();
  const favoriteCharacter = (document.getElementById('setup-character')?.value || '').trim();
  const narratorPref = document.getElementById('setup-narrator-pref')?.value || '';
  const favoriteStories = _readFavInputs('setup-fav-');

  // Canonical profile fields — these are what the rest of the app reads.
  p.displayName = username;
  if (avatar && avatar.startsWith('data:')) p.avatar = avatar;
  if (avatar && avatar.startsWith('data:') && window._cloudPushAllowed && typeof window.pocketCloud?.saveAvatar === 'function') {
    window.pocketCloud.saveAvatar(avatar).catch((error) => console.warn('[CloudSync] Setup avatar upload failed:', error));
  }
  p.userCategory = userCategory;
  p.companion = companion;
  p.favoriteGenre = favoriteGenre;
  p.currentlyReading = currentlyReading;
  p.favoriteCharacter = favoriteCharacter;
  // Same canonical property names the profile editor writes, so a value entered
  // at setup shows up pre-filled when the reader later opens Edit Profile
  // instead of appearing to have been discarded.
  p.favoriteFandom = (document.getElementById('setup-fandom')?.value || '').trim();
  p.preferredLength = document.getElementById('setup-length')?.value || '';
  p.readingMood = document.getElementById('setup-mood')?.value || '';
  p.favoriteStories = favoriteStories;
  p.goals = p.goals || {};
  const setupGoalMins = parseInt(document.getElementById('setup-goal-weekly-minutes')?.value || '120', 10);
  p.goals.weeklyMinutes = isNaN(setupGoalMins) ? 120 : setupGoalMins;
  const setupGoalChaps = parseInt(document.getElementById('setup-goal-weekly-chapters')?.value || '0', 10);
  p.goals.weeklyChapters = isNaN(setupGoalChaps) ? 0 : setupGoalChaps;
  p.goals.streakEnabled = document.getElementById('setup-goal-streak-enabled')?.checked !== false;
  p.goals.updatedAt = Date.now();
  p.settings.theme = theme;
  p.settings.companion = companion;
  if (readerFont) p.settings.readerFontFamily = readerFont;
  p.settings.readerFontSize = readerSize;
  p.settings.appFontSize = appSize;
  ['displayName', 'userCategory', 'companion', 'favoriteGenre', 'currentlyReading', 'favoriteCharacter', 'favoriteStories'].forEach((field) => window.stampProfileField?.(field));
  ['theme', 'companion', 'readerFontFamily', 'readerFontSize', 'appFontSize'].forEach((field) => window.stampSyncedSetting?.(field));

  if (narratorPref === 'Male' || narratorPref === 'Female') {
    const defaultVoice = narratorPref === 'Male' ? 'bill_boerst' : 'rayne';
    const voiceSelector = document.getElementById('voice-selector');
    if (voiceSelector) {
      voiceSelector.value = defaultVoice;
      if (typeof window.onVoiceSelectionChange === 'function') {
        window.onVoiceSelectionChange(defaultVoice);
      }
    }
  }

  // Sync the matching Settings controls so they reflect the wizard choices.
  // (Profile fields — name/category/genre/favorites — live on the Profile page
  // now and are filled by renderProfileExtras() below.)
  const set = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined && val !== '') el.value = val; };
  set('app-theme-select', theme);
  set('companion-select', companion);
  set('reading-font-select', readerFont);
  set('reader-font-slider', readerSize);
  set('app-font-slider', appSize);

  if (typeof window.updateDisplayName === 'function') window.updateDisplayName(username);
  if (p.avatar) ['topbar-avatar-img', 'profile-avatar-img', 'settings-avatar-img'].forEach((id) => { const el = document.getElementById(id); if (el) el.src = p.avatar; });
  if (typeof window.applySettings === 'function') window.applySettings();
  if (typeof window.renderProfileExtras === 'function') window.renderProfileExtras();
  // The wizard is a deliberate settings choice — stamp it so it wins over an
  // older cloud profile on the next cross-device sync (Issue 9).
  if (typeof window.markSettingsEdited === 'function') window.markSettingsEdited();
  if (typeof window.saveLocalData === 'function') window.saveLocalData();

  // Verify active authentication state so newly logged-in accounts (via Google OAuth or email)
  // are properly attached and synchronized before completing onboarding.
  const sessionOwner = localStorage.getItem('pr_profile_owner');
  if ((sessionOwner && sessionOwner !== 'Guest Reader') || p.cloudEmail || p.isLoggedIn) {
    const activeEmail = p.cloudEmail || sessionOwner;
    if (activeEmail && activeEmail !== 'Guest Reader') {
      localStorage.setItem('pr_profile_owner', activeEmail);
      p.isLoggedIn = true;
      p.cloudEmail = activeEmail;
      window._cloudPushAllowed = true;
    }
  }

  localStorage.setItem('pr_setup_complete', 'true');
  localStorage.removeItem(DEVICE_PROFILE_HANDOFF_KEY);
  document.documentElement.classList.add('pr-setup-complete');
  localStorage.removeItem(SETUP_DRAFT_STORAGE_KEY);
  localStorage.removeItem(SETUP_AUTH_STORAGE_KEY);
  if (p.isLoggedIn && typeof window.queueCloudSync === 'function') {
    window.queueCloudSync('onboarding-complete', { immediate: true });
    window.flushCloudSync?.();
  }
  if (typeof window.renderProfileExtras === 'function') window.renderProfileExtras();
  if (typeof window.renderAccountCenter === 'function') window.renderAccountCenter();
  const modal = document.getElementById('first-time-setup-modal');
  if (modal) {
    window.deactivatePocketModal?.(modal);
    modal.style.display = 'none';
  }

  // Now that account setup is done, the mobile install banner can appear
  // without colliding with the setup wizard (Issue 4).
  if (typeof window._maybeShowPWABanner === 'function') window._maybeShowPWABanner();
  setTimeout(() => window.maybeShowDeviceSupportNotice?.(), 250);

  if (companion === 'virtue' && typeof window.triggerVirtue === 'function') {
    window.triggerVirtue('virtue_waving_bubble');
    window.virtueSpeak("All set! I'm so excited to start reading with you, " + username + "!", 5000);
  }
};

// "Skip for now" — nothing is required; set a sensible default name and dismiss.
window.skipFirstTimeSetup = () => {
  const p = window.userProfile = window.userProfile || {};
  p.settings = p.settings || {};
  if (!p.displayName) { p.displayName = 'Guest Reader'; if (typeof window.updateDisplayName === 'function') window.updateDisplayName('Guest Reader'); }
  if (p.companion === undefined) p.companion = 'virtue';
  if (p.settings.companion === undefined) p.settings.companion = p.companion;
  if (p.settings.theme === undefined) p.settings.theme = 'slate';
  if (p.settings.touchTargetSize === undefined) p.settings.touchTargetSize = false;
  if (typeof window.saveLocalData === 'function') window.saveLocalData();
  localStorage.setItem('pr_setup_complete', 'true');
  localStorage.removeItem(DEVICE_PROFILE_HANDOFF_KEY);
  document.documentElement.classList.add('pr-setup-complete');
  localStorage.removeItem(SETUP_DRAFT_STORAGE_KEY);
  const modal = document.getElementById('first-time-setup-modal');
  if (modal) {
    window.deactivatePocketModal?.(modal);
    modal.style.display = 'none';
  }

  // Setup dismissed — safe to surface the mobile install banner now (Issue 4).
  if (typeof window._maybeShowPWABanner === 'function') window._maybeShowPWABanner();
  setTimeout(() => window.maybeShowDeviceSupportNotice?.(), 250);
};

// ISSUE 6 & 8 FIX: Rendering the Profile page horizontal pill-badges natively
window.renderProfileExtras = function() {
  const p = window.userProfile || {};
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = val || '';
  };
  const setDisp = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val || '-';
  };

  setVal('profile-edit-name', p.displayName);
  setVal('profile-edit-category', p.userCategory);
  setVal('profile-edit-genre', p.favoriteGenre);
  setVal('profile-edit-fandom', p.favoriteFandom);
  setVal('profile-edit-character', p.favoriteCharacter);
  setVal('profile-edit-length', p.preferredLength);
  setVal('profile-edit-mood', p.readingMood);
  setVal('profile-edit-currently', p.currentlyReading);

  p.goals = p.goals || { weeklyMinutes: 120, weeklyChapters: 0, streakEnabled: true };
  setVal('profile-edit-goal-minutes', p.goals.weeklyMinutes ?? 120);
  setVal('profile-edit-goal-chapters', p.goals.weeklyChapters ?? 0);
  const editStreak = document.getElementById('profile-edit-goal-streak');
  if (editStreak) editStreak.checked = p.goals.streakEnabled !== false;

  setDisp('profile-disp-name', p.displayName);
  setDisp('profile-disp-category', p.userCategory);
  setDisp('profile-disp-genre', p.favoriteGenre);
  setDisp('profile-disp-fandom', p.favoriteFandom);
  setDisp('profile-disp-character', p.favoriteCharacter);
  setDisp('profile-disp-length', p.preferredLength);
  setDisp('profile-disp-mood', p.readingMood);
  setDisp('profile-disp-currently', p.currentlyReading);
  setDisp('profile-disp-goal-mins', `${p.goals.weeklyMinutes ?? 120} min/week`);
  setDisp('profile-disp-goal-chaps', p.goals.weeklyChapters ? `${p.goals.weeklyChapters} chapters/week` : 'None');
  setDisp('profile-disp-goal-streak', p.goals.streakEnabled !== false ? 'Enabled' : 'Disabled');

  const favs = Array.isArray(p.favoriteStories) ? p.favoriteStories : [];
  for (let i = 0; i < 5; i++) setVal('profile-edit-fav-' + (i + 1), favs[i] || '');

  // Convert text inputs directly into flex-box HTML node elements
  const favsList = document.getElementById('profile-disp-favs');
  if (favsList) {
    favsList.innerHTML = '';
    if (favs.length === 0) {
      const li = document.createElement('li');
      li.textContent = '-';
      favsList.appendChild(li);
    } else {
      favs.forEach(f => {
        const li = document.createElement('li');
        li.textContent = f;
        favsList.appendChild(li);
      });
    }
  }

  const cat = document.getElementById('profile-category');
  if (cat) { if (p.userCategory) { cat.textContent = p.userCategory; cat.style.display = ''; } else { cat.style.display = 'none'; } }
  const nameEl = document.getElementById('profile-name');
  if (nameEl && p.displayName) nameEl.textContent = p.displayName;
  if (p.avatar) { const a = document.getElementById('profile-avatar-img'); if (a) a.src = p.avatar; }

  // Auto-sync isLoggedIn flag if session owner matches
  const owner = localStorage.getItem('pr_profile_owner');
  if (owner && owner !== 'Guest Reader' && (!p.isLoggedIn || !p.cloudEmail)) {
    p.isLoggedIn = true;
    p.cloudEmail = owner;
    window._cloudPushAllowed = true;
  }

  // Update Cloud Sync centerpiece card state dynamically
  const statusTextEl = document.getElementById('cloud-sync-status-text');
  const actionsEl = document.getElementById('cloud-sync-actions');
  if (statusTextEl && actionsEl) {
    if (p.isLoggedIn && p.cloudEmail) {
      statusTextEl.innerHTML = `Synced with cloud: <strong>${_escapeHtml(p.cloudEmail)}</strong>.<br><span style="font-size:0.8rem;color:var(--text-muted);">Your profile data, library list, and settings are securely backed up.</span>`;
      actionsEl.innerHTML = `<button class="pr-btn-outline" onclick="window.triggerCloudLogout()" style="color:#ff6b6b; border-color:#ff6b6b; padding:8px 16px;">Log Out</button> <button class="pr-btn-primary" onclick="window.triggerCloudSync()" style="padding:8px 16px; margin-left:8px;">Sync Now</button>`;
    } else {
      statusTextEl.innerHTML = `Currently operating in <strong>Guest (Offline-Only)</strong> mode.<br><span style="font-size:0.8rem;color:var(--text-muted);">Login to securely backup and sync your reading list, settings, and stats across devices.</span>`;
      actionsEl.innerHTML = `<button class="pr-btn-primary" onclick="window.triggerCloudLogin()" style="padding:8px 16px;">Log In / Sync</button>`;
    }
  }
};

window.triggerCloudLogin = async function() {
  if (_deferCloudLoginOutsideFastNarration('profile')) return;
  if (!window.pocketCloud?.login) {
    if (typeof window.triggerVirtue === 'function') {
      window.triggerVirtue('virtue_annoyed_bubble');
      window.virtueSpeak('Cloud service is not ready yet. Please wait a moment and try again.', 4000);
    }
    return;
  }
  try {
    if (typeof window.triggerVirtue === 'function') window.triggerVirtue('virtue_thinking');
    const email = await window.pocketCloud.login();
    if (email) {
      // ── Account isolation ────────────────────────────────────────────────
      // If this device's local profile belongs to a DIFFERENT account, wipe it
      // and reboot; the fresh boot pulls the new account's cloud profile.
      // Guest-owned local data (no recorded owner) is adopted by the account
      // logging in, preserving the guest-then-sign-up flow.
      const owner = localStorage.getItem('pr_profile_owner') || '';
      if (owner && owner !== email) {
        if (typeof window.resetLocalProfile === 'function') {
          await window.resetLocalProfile({ preserveSetup: true });
        }
        location.reload();
        return;
      }
      localStorage.setItem('pr_profile_owner', email);
      window._cloudPushAllowed = true;

      window.userProfile.isLoggedIn = true;
      window.userProfile.cloudEmail = email;

      // Pull cloud profile
      if (typeof window.pocketCloud?.loadProfile === 'function') {
        const cloudProfile = await window.pocketCloud.loadProfile();
        if (cloudProfile) {
          console.log("[CloudSync] Loaded cloud profile during login:", cloudProfile);
          // If the user is mid first-time-setup, the choices they just made in
          // the wizard must win over an older cloud profile (Issue 7). Outside
          // setup, mergeProfileIntoCurrent falls back to most-recently-edited
          // settings winning (Issue 9).
          const setupOpen = document.getElementById('first-time-setup-modal')?.style.display === 'flex';
          const merged = typeof window.mergeProfileIntoCurrent === 'function'
            ? window.mergeProfileIntoCurrent(cloudProfile, { purgeStorage: true, localSettingsWin: setupOpen })
            : false;
          if (merged) {
            console.log("[CloudSync] Merged cloud profile into local storage.");
            if (typeof window.saveLocalData === 'function') window.saveLocalData();
            if (typeof window.renderLibrary === 'function') window.renderLibrary();
            if (typeof window.initSettingsUI === 'function') window.initSettingsUI();
            if (typeof window.applySettings === 'function') window.applySettings();
          }
        }
      }

      // Explicitly push local profile to cloud now that we're authenticated
      if (typeof window.queueCloudSync === 'function') {
        await window.queueCloudSync('login', { immediate: true });
        await window.flushCloudSync?.();
      } else if (typeof window.pocketCloud?.saveProfile === 'function') {
        const localForPush = typeof window.cloneProfileForSync === 'function'
          ? window.cloneProfileForSync()
          : JSON.parse(JSON.stringify(window.userProfile));
        try { await window.pocketCloud.saveProfile(localForPush); } catch (_) {}
      }

      // Reflect the (merged) display name in the topbar — not the raw email,
      // which made the name flash the address then revert. The cloud email is
      // shown on the Profile cloud-sync card instead (Issue 8). updateDisplayName
      // also persists the merged profile via saveLocalData.
      if (typeof window.updateDisplayName === 'function') {
        window.updateDisplayName(window.userProfile.displayName || 'Guest Reader');
      } else if (typeof window.saveLocalData === 'function') {
        window.saveLocalData();
      }
      window.renderProfileExtras();

      if (typeof window.triggerVirtue === 'function') {
        window.triggerVirtue('virtue_holding_bubble_happy_no_paws');
        window.virtueSpeak(`Welcome, ${email}! Your profile is now synced to the cloud.`, 5000);
      } else {
        alert(`Successfully logged in as ${email}. Cloud sync is active!`);
      }
    }
  } catch (e) {
    console.error("Login failed:", e);
  }
};

async function _resumeDeferredCloudLogin() {
  const action = sessionStorage.getItem('pr_resume_cloud_login_v1');
  if (!action || new URL(window.location.href).searchParams.get('tts_fast') === '1') return;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30000) {
    if (typeof window.pocketCloud?.login === 'function') {
      sessionStorage.removeItem('pr_resume_cloud_login_v1');
      if (action === 'setup') await window._setupCloudLogin?.();
      else await window.triggerCloudLogin?.();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
setTimeout(() => { _resumeDeferredCloudLogin().catch((error) => console.warn('[Account] Deferred login could not resume:', error)); }, 0);

async function _resumeStoryUpdateFromNotification() {
  const pageUrl = new URL(window.location.href);
  const sourceUrl = pageUrl.searchParams.get('story_update');
  if (!sourceUrl) return;
  pageUrl.searchParams.delete('story_update');
  history.replaceState(null, '', pageUrl.href);

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30000) {
    const story = (window.userProfile?.library || []).find((item) => {
      const candidate = item.sourceUrl || item.url || '';
      return candidate === sourceUrl;
    });
    if (story && typeof window.checkStoryUpdate === 'function') {
      // checkStoryUpdate resolves its first argument through findLibraryStoryByRef,
      // which only falls back to a title match when that title is UNIQUE. Passing
      // a title meant two same-titled library entries resolved to null and the
      // update check silently did nothing. The story object is already in hand.
      await window.checkStoryUpdate(story.storyKey || window.getStoryStableKey?.(story) || story.title, sourceUrl);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// Mobile foregrounds constantly — app switcher, notifications, lock screen —
// and every visibilitychange used to fire a fresh sweep of up to three
// sequential AO3 scrapes. Ten app switches while reading was thirty backend
// scrapes on cellular. The floor keeps the 30-minute interval and the
// notification path working while collapsing foreground churn.
const SUBSCRIPTION_SWEEP_MIN_INTERVAL_MS = 15 * 60 * 1000;
let _lastSubscriptionSweepAt = 0;

function _scheduleSubscribedStoryChecks({ force = false } = {}) {
  if (document.hidden) return;
  const now = Date.now();
  if (!force && now - _lastSubscriptionSweepAt < SUBSCRIPTION_SWEEP_MIN_INTERVAL_MS) return;
  _lastSubscriptionSweepAt = now;
  window.checkSubscribedStoryUpdates?.().catch((error) => {
    console.warn('[Updates] Scheduled story update check failed:', error);
  });
}

setTimeout(() => { _resumeStoryUpdateFromNotification().catch((error) => console.warn('[Updates] Notification update failed:', error)); }, 1500);
setTimeout(_scheduleSubscribedStoryChecks, 10000);
setInterval(_scheduleSubscribedStoryChecks, 30 * 60 * 1000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') _scheduleSubscribedStoryChecks();
});
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type !== 'story-update' || !event.data.storyUrl) return;
    const story = (window.userProfile?.library || []).find((item) => (item.sourceUrl || item.url) === event.data.storyUrl);
    if (story) {
      window.checkStoryUpdate?.(story.storyKey || window.getStoryStableKey?.(story) || story.title, event.data.storyUrl);
    }
  });
}

window.triggerCloudLogout = async function() {
  if (typeof window.pocketCloud?.logout !== 'function') return;
  if (!confirm("Log out? Your library, settings, and reading progress will be removed from this device so the next reader starts fresh. Everything stays safe in your cloud profile — log back in anytime to restore it.")) return;
  try {
    await window.pocketCloud.logout();
    localStorage.removeItem('pr_remember_login');
    window._cloudPushAllowed = false;

    // Account isolation: wipe this device's copy of the profile (and cached
    // story text/audio/avatar) so the next user never sees this account's
    // library. The reload boots a clean guest profile with curated defaults.
    if (typeof window.resetLocalProfile === 'function') {
      await window.resetLocalProfile({ preserveSetup: true });
    }
    location.reload();
  } catch (e) {
    console.error("Logout failed:", e);
  }
};

window.triggerCloudSync = async function() {
  // Verify live auth state — don't rely solely on the cached isLoggedIn flag,
  // which may not be set after a page reload if checkCloudSyncOnStartup didn't run.
  if (typeof window.pocketCloud?.getCurrentUser !== 'function' || typeof window.pocketCloud?.saveProfile !== 'function') return;
  const _say = (msg, dur) => {
    if (typeof window.triggerVirtue === 'function') window.triggerVirtue('virtue_thinking');
    if (typeof window.virtueSpeak === 'function') window.virtueSpeak(msg, dur || 4000);
  };
  const _done = (msg) => {
    if (typeof window.triggerVirtue === 'function') window.triggerVirtue('virtue_holding_bubble_happy_no_paws');
    if (typeof window.virtueSpeak === 'function') window.virtueSpeak(msg, 4000);
  };
  const _fail = (msg) => {
    if (typeof window.triggerVirtue === 'function') window.triggerVirtue('virtue_annoyed_bubble');
    if (typeof window.virtueSpeak === 'function') window.virtueSpeak(msg, 5000);
  };
  try {
    _say("Syncing with cloud...");
    const email = await window.pocketCloud.getCurrentUser();
    if (!email) {
      _fail("You're not logged in. Use 'Log In / Sync' first.");
      return;
    }

    // Account isolation: never push a profile that belongs to a different
    // account. Reset and reboot so the new account's cloud profile loads.
    const owner = localStorage.getItem('pr_profile_owner') || '';
    if (owner && owner !== email) {
      if (typeof window.resetLocalProfile === 'function') {
        await window.resetLocalProfile({ preserveSetup: true });
      }
      location.reload();
      return;
    }
    localStorage.setItem('pr_profile_owner', email);
    window._cloudPushAllowed = true;

    // Keep isLoggedIn in sync with actual auth state
    window.userProfile.isLoggedIn = true;
    window.userProfile.cloudEmail = email;

    if (typeof window.queueCloudSync === 'function' && typeof window.flushCloudSync === 'function') {
      await window.queueCloudSync('manual', { immediate: true });
      const synced = await window.flushCloudSync();
      if (!synced) throw new Error(window.cloudSyncState?.lastError || 'Sync failed');
      window.renderProfileExtras();
      _done(`Synced with ${email}. Your profile is up to date.`);
      return;
    }

    // ── Step 1: push local → cloud ────────────────────────────────────────
    // Serialize a lite copy (no avatar blob, no chapter text).
    const localForPush = typeof window.cloneProfileForSync === 'function'
      ? window.cloneProfileForSync()
      : JSON.parse(JSON.stringify(window.userProfile));
    await window.pocketCloud.saveProfile(localForPush);

    // ── Step 2: pull cloud → local and merge ──────────────────────────────
    if (typeof window.pocketCloud?.loadProfile === 'function') {
      const cloudProfile = await window.pocketCloud.loadProfile();
      if (cloudProfile && typeof window.mergeProfileIntoCurrent === 'function') {
        window.mergeProfileIntoCurrent(cloudProfile, { localSettingsWin: true, purgeStorage: true });
      }
    }

    // ── Step 3: persist merged state locally and refresh UI ───────────────
    if (typeof window.saveLocalData === 'function') window.saveLocalData();
    if (typeof window.pocketCloud?.saveProfile === 'function' && typeof window.cloneProfileForSync === 'function') {
      try { await window.pocketCloud.saveProfile(window.cloneProfileForSync()); } catch (_) {}
    }
    if (typeof window.renderLibrary === 'function') window.renderLibrary();
    if (typeof window.initSettingsUI === 'function') window.initSettingsUI();
    if (typeof window.applySettings === 'function') window.applySettings();
    window.renderProfileExtras();
    _done(`Synced with ${email}. Library and settings are up-to-date.`);

  } catch (e) {
    console.error("Cloud sync failed:", e);
    _fail("Cloud sync failed. Please check your connection and try again.");
  }
};

// ISSUE 8 FIX: Safely wrap saveLocalData in an execution interval inside user edits
window.saveProfileDetails = function() {
  const p = window.userProfile = window.userProfile || {};
  const val = (id) => (document.getElementById(id)?.value || '').trim();
  const name = val('profile-edit-name');
  if (name && typeof window.updateDisplayName === 'function') window.updateDisplayName(name);
  p.userCategory = document.getElementById('profile-edit-category')?.value || '';
  p.favoriteGenre = val('profile-edit-genre');
  p.favoriteFandom = val('profile-edit-fandom');
  p.favoriteCharacter = val('profile-edit-character');
  p.preferredLength = document.getElementById('profile-edit-length')?.value || '';
  p.readingMood = document.getElementById('profile-edit-mood')?.value || '';
  p.currentlyReading = val('profile-edit-currently');
  p.favoriteStories = _readFavInputs('profile-edit-fav-');
  p.goals = p.goals || {};
  const goalMins = parseInt(document.getElementById('profile-edit-goal-minutes')?.value || '', 10);
  if (!isNaN(goalMins)) p.goals.weeklyMinutes = goalMins;
  const goalChaps = parseInt(document.getElementById('profile-edit-goal-chapters')?.value || '', 10);
  if (!isNaN(goalChaps)) p.goals.weeklyChapters = goalChaps;
  const streakChk = document.getElementById('profile-edit-goal-streak');
  if (streakChk) p.goals.streakEnabled = streakChk.checked;
  p.goals.updatedAt = Date.now();
  ['displayName', 'userCategory', 'favoriteGenre', 'favoriteFandom', 'favoriteCharacter', 'preferredLength', 'readingMood', 'currentlyReading', 'favoriteStories'].forEach((field) => {
    if (typeof window.stampProfileField === 'function') window.stampProfileField(field);
  });

  window.renderProfileExtras();

  if (typeof window.saveLocalData === 'function') {
    clearTimeout(window._profileSaveT);
    window._profileSaveT = setTimeout(() => window.saveLocalData(), 100);
  }

  const hint = document.getElementById('profile-save-hint');
  if (hint) {
    hint.style.opacity = '1';
    clearTimeout(window._profileSaveHintT);
    window._profileSaveHintT = setTimeout(() => { hint.style.opacity = '0'; }, 1200);
  }
};

window._populateProfileSettings = function() {
  if (typeof window.renderProfileExtras === 'function') window.renderProfileExtras();
};

window._setControlsLocked = function(locked) {
  ['reader-engine-select', 'voice-selector', 'voice-engine-select'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = locked;
    el.style.opacity = locked ? '0.5' : '1';
    el.style.cursor = locked ? 'not-allowed' : 'pointer';
    el.title = locked ? 'Please pause playback to change this setting' : '';
  });
};

window.uiControllerLoaded = true;
