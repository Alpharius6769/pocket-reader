import { cubicOut } from 'svelte/easing';
import type { TransitionConfig } from 'svelte/transition';

export function reducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** iOS-like sheet curve (matches --ease-sheet). */
export function sheetEase(t: number) {
  // cubic-bezier(0.32, 0.72, 0, 1) approximated
  return 1 - Math.pow(1 - t, 3.4);
}

/** Slide up from below the viewport. Fades instead when motion is reduced. */
export function slideUp(_node: Element, { duration = 380 } = {}): TransitionConfig {
  if (reducedMotion()) return { duration: 120, css: (t) => `opacity:${t}` };
  return { duration, easing: sheetEase, css: (t) => `transform: translate3d(0, ${(1 - t) * 100}%, 0)` };
}

export function fade(_node: Element, { duration = 220 } = {}): TransitionConfig {
  return { duration: reducedMotion() ? 80 : duration, easing: cubicOut, css: (t) => `opacity:${t}` };
}

export function pushIn(_node: Element, { duration = 340, dir = 1 } = {}): TransitionConfig {
  if (reducedMotion()) return { duration: 80, css: (t) => `opacity:${t}` };
  return { duration, easing: sheetEase, css: (t) => `transform: translate3d(${(1 - t) * 30 * dir}%, 0, 0); opacity:${0.4 + t * 0.6}` };
}

interface DragOptions {
  onDismiss: () => void;
  /** Only start a drag when the gesture begins inside an element matching this. */
  handle?: string;
  /** Element whose scrollTop must be 0 before a downward drag can start. */
  scroller?: string;
}

/**
 * Swipe-down-to-dismiss for sheets. Follows the finger 1:1, rubber-bands upward,
 * dismisses past 28% of the sheet height or on a quick flick.
 */
export function dragDismiss(node: HTMLElement, opts: DragOptions) {
  let options = opts;
  let startY = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  let dragging = false;
  let pointerId = -1;

  function canStart(target: EventTarget | null) {
    const el = target as HTMLElement | null;
    if (!el) return false;
    if (el.closest('input, textarea, select, [data-no-drag]')) return false;
    if (options.handle && el.closest(options.handle)) return true;
    if (options.scroller) {
      const sc = el.closest(options.scroller) as HTMLElement | null;
      if (sc) return sc.scrollTop <= 0;
    }
    return !options.handle;
  }

  function down(e: PointerEvent) {
    if (e.button !== 0 || !canStart(e.target)) return;
    startY = lastY = e.clientY;
    lastT = performance.now();
    velocity = 0;
    pointerId = e.pointerId;
    dragging = false;
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function move(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    const dy = e.clientY - startY;
    if (!dragging) {
      if (dy < 6) {
        if (dy < -6) cleanup();
        return;
      }
      dragging = true;
      node.style.transition = 'none';
    }
    e.preventDefault();
    const now = performance.now();
    velocity = (e.clientY - lastY) / Math.max(1, now - lastT);
    lastY = e.clientY;
    lastT = now;
    const offset = dy > 0 ? dy : dy / 6;
    node.style.transform = `translate3d(0, ${offset}px, 0)`;
  }

  function up(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    const dy = e.clientY - startY;
    const wasDragging = dragging;
    cleanup();
    if (!wasDragging) return;
    node.style.transition = `transform var(--dur-2) var(--ease-sheet)`;
    if (dy > node.offsetHeight * 0.28 || velocity > 0.6) {
      node.style.transform = `translate3d(0, 100%, 0)`;
      setTimeout(() => {
        node.style.transform = '';
        node.style.transition = '';
        options.onDismiss();
      }, reducedMotion() ? 0 : 200);
    } else {
      node.style.transform = '';
    }
  }

  function cleanup() {
    dragging = false;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  }

  node.addEventListener('pointerdown', down);
  return {
    update(next: DragOptions) {
      options = next;
    },
    destroy() {
      cleanup();
      node.removeEventListener('pointerdown', down);
    },
  };
}

/** Long-press (default 650ms) without a context menu. */
export function longPress(node: HTMLElement, handler: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fn = handler;
  const start = () => {
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, 650);
  };
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const menu = (e: Event) => e.preventDefault();
  node.addEventListener('pointerdown', start);
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointerleave', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('contextmenu', menu);
  return {
    update(next: () => void) {
      fn = next;
    },
    destroy() {
      cancel();
      node.removeEventListener('pointerdown', start);
      node.removeEventListener('pointerup', cancel);
      node.removeEventListener('pointerleave', cancel);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('contextmenu', menu);
    },
  };
}
