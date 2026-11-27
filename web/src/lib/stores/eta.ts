import { readable } from 'svelte/store';
import type { RunwayState } from '../core/bridge';
import { player } from './player';

/**
 * Time left until the starting runway is ready, measured from how long the
 * paragraphs of this very run have taken.
 *
 * Two things would skew a naive "elapsed / done" estimate and are left out:
 *  - paragraphs found in the cache arrive at once and say nothing about pace;
 *  - the first rendered paragraph also pays for warming the voice up.
 */

/** A step faster than this per paragraph came from the cache, not the voice. */
const CACHED_MS = 250;

type RunwaySample = Pick<RunwayState, 'storyKey' | 'ready' | 'target' | 'preparing' | 'ok'>;

export class EtaTracker {
  private key = '';
  private target = 0;
  private startedAt = 0;
  private startReady = 0;
  private marks: { t: number; ready: number }[] = [];

  get active() {
    return this.key !== '';
  }

  reset() {
    this.key = '';
    this.target = 0;
    this.marks = [];
  }

  update(r: RunwaySample, now: number) {
    if (!r.preparing || r.ok || !(r.target > 0)) {
      this.reset();
      return;
    }
    const key = `${r.storyKey}:${r.target}`;
    const lastReady = this.marks.length ? this.marks[this.marks.length - 1].ready : this.startReady;
    if (key !== this.key || r.ready < lastReady) {
      this.key = key;
      this.startedAt = now;
      this.startReady = r.ready;
      this.marks = [];
    } else if (r.ready > lastReady) {
      this.marks.push({ t: now, ready: r.ready });
    }
    this.target = r.target;
  }

  /** Seconds left, or null while there is nothing to measure from yet. */
  remaining(now: number): number | null {
    if (!this.active || !this.marks.length) return null;
    const steps: { ms: number; n: number }[] = [];
    let prev = { t: this.startedAt, ready: this.startReady };
    for (const m of this.marks) {
      const n = m.ready - prev.ready;
      const ms = m.t - prev.t;
      if (n > 0 && ms / n >= CACHED_MS) steps.push({ ms, n });
      prev = m;
    }
    if (!steps.length) return null;
    // With more than one measured step, the first (voice warm-up) is dropped.
    const used = steps.length > 1 ? steps.slice(1) : steps;
    const perParagraph = used.reduce((a, s) => a + s.ms, 0) / used.reduce((a, s) => a + s.n, 0);
    const last = this.marks[this.marks.length - 1];
    const left = Math.max(0, this.target - last.ready);
    return Math.max(0, perParagraph * left - (now - last.t)) / 1000;
  }
}

/** Seconds until Play unlocks; null when not preparing or not yet measurable. */
export const runwayEta = readable<number | null>(null, (set) => {
  const tracker = new EtaTracker();
  let timer: ReturnType<typeof setInterval> | undefined;
  const publish = () => set(tracker.remaining(Date.now()));
  const unsubscribe = player.subscribe((p) => {
    tracker.update(p.runway, Date.now());
    publish();
    if (tracker.active && !timer) timer = setInterval(publish, 1000);
    else if (!tracker.active && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  });
  return () => {
    unsubscribe();
    if (timer) clearInterval(timer);
  };
});
