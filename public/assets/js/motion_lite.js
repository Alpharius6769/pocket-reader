// motion_lite.js — tiny local replacement for the `motion` CDN dependency.
//
// The app used exactly three animate() call sites (entrance fades/slides) plus
// stagger(), so importing motion@11 from jsDelivr meant a CDN outage or an
// offline launch broke ES-module resolution for ui_controller,
// virtue_controller, and library_manager — the whole UI. This shim implements
// the same call signatures on the native Web Animations API (supported by
// every browser this app targets, including iOS Safari).
//
// Supported subset (matches actual usage — extend here if a new call site
// needs more):
//   animate(elOrList, { opacity: [0,1], y: ["20px","0px"], scale: [0.9,1] },
//           { duration: 0.3, easing: [x1,y1,x2,y2] | "ease-out", delay: n | stagger(n) })
//   stagger(intervalSec) -> (index) => index * intervalSec

function _toTransform(keyframes, side) {
  const parts = [];
  if (keyframes.y !== undefined) {
    const v = Array.isArray(keyframes.y) ? keyframes.y[side] : keyframes.y;
    parts.push(`translateY(${typeof v === 'number' ? `${v}px` : v})`);
  }
  if (keyframes.x !== undefined) {
    const v = Array.isArray(keyframes.x) ? keyframes.x[side] : keyframes.x;
    parts.push(`translateX(${typeof v === 'number' ? `${v}px` : v})`);
  }
  if (keyframes.scale !== undefined) {
    const v = Array.isArray(keyframes.scale) ? keyframes.scale[side] : keyframes.scale;
    parts.push(`scale(${v})`);
  }
  return parts.length ? parts.join(' ') : null;
}

function _waapiKeyframes(keyframes) {
  const from = {};
  const to = {};
  for (const [prop, value] of Object.entries(keyframes)) {
    if (prop === 'x' || prop === 'y' || prop === 'scale') continue; // folded into transform
    from[prop] = Array.isArray(value) ? value[0] : undefined;
    to[prop] = Array.isArray(value) ? value[value.length - 1] : value;
  }
  const tFrom = _toTransform(keyframes, 0);
  const tTo = _toTransform(keyframes, 1);
  if (tFrom !== null) from.transform = tFrom;
  if (tTo !== null) to.transform = tTo;
  // Drop undefined "from" values so WAAPI infers them from computed style.
  for (const k of Object.keys(from)) {
    if (from[k] === undefined) delete from[k];
  }
  return [from, to];
}

function _easingString(easing) {
  if (Array.isArray(easing) && easing.length === 4) return `cubic-bezier(${easing.join(',')})`;
  if (typeof easing === 'string') return easing;
  return 'ease';
}

export function stagger(intervalSec = 0.1) {
  return (index) => (Number(index) || 0) * intervalSec;
}

export function animate(targets, keyframes, options = {}) {
  const els = (targets instanceof Element) ? [targets]
    : Array.from(targets || []).filter((el) => el instanceof Element);
  if (!els.length) return { finished: Promise.resolve() };

  const frames = _waapiKeyframes(keyframes || {});
  const durationMs = (Number(options.duration) || 0.3) * 1000;
  const easing = _easingString(options.easing);
  const animations = els.map((el, i) => {
    const delaySec = typeof options.delay === 'function'
      ? options.delay(i, els.length)
      : (Number(options.delay) || 0);
    try {
      // fill: 'backwards' holds the FIRST keyframe during the (staggered) delay
      // so nothing flashes before its turn, then releases on finish. We
      // deliberately do NOT use 'forwards'/'both' or commitStyles(): every call
      // site's final keyframe already equals the element's resting CSS (library
      // cards -> default opacity 1, views -> .active-view, virtue -> .active),
      // so releasing reverts to the correct visible state with no end-state pop.
      // Persisting the end state instead would write an inline transform that
      // overrides `:hover` transforms and block later `el.style.opacity` tweaks
      // (e.g. the library "check updates" dimming). Requires that no persistent
      // CSS rule leaves an element hidden at rest (see removed `.story-card
      // { opacity: 0 }`).
      return el.animate(frames, {
        duration: durationMs,
        delay: delaySec * 1000,
        easing,
        fill: 'backwards',
      });
    } catch (e) {
      return null; // never let a cosmetic animation break the caller
    }
  }).filter(Boolean);

  return {
    finished: Promise.allSettled(animations.map((a) => a.finished)).then(() => undefined),
    cancel: () => animations.forEach((a) => { try { a.cancel(); } catch (e) {} }),
  };
}
