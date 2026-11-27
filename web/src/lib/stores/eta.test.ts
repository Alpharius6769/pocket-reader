import { describe, expect, it } from 'vitest';
import { EtaTracker } from './eta';
import { etaLabel, progressLabel } from '../format';

const run = (ready: number, over: Partial<{ storyKey: string; target: number; preparing: boolean; ok: boolean }> = {}) => ({
  storyKey: 's1',
  ready,
  target: 10,
  preparing: true,
  ok: false,
  ...over,
});

describe('EtaTracker', () => {
  it('has no estimate until a paragraph has been rendered', () => {
    const t = new EtaTracker();
    t.update(run(0), 0);
    expect(t.remaining(3000)).toBeNull();
  });

  it('estimates from the pace of this run and counts down between paragraphs', () => {
    const t = new EtaTracker();
    t.update(run(0), 0);
    t.update(run(1), 4000);
    // One paragraph took 4 s; nine are left.
    expect(t.remaining(4000)).toBeCloseTo(36);
    expect(t.remaining(6000)).toBeCloseTo(34);
  });

  it('drops the warm-up paragraph once there is a second measurement', () => {
    const t = new EtaTracker();
    t.update(run(0), 0);
    t.update(run(1), 12000); // includes loading the voice
    t.update(run(2), 14000);
    t.update(run(3), 16000);
    // 2 s per paragraph, seven left.
    expect(t.remaining(16000)).toBeCloseTo(14);
  });

  it('ignores paragraphs that came straight from the cache', () => {
    const t = new EtaTracker();
    t.update(run(0), 0);
    t.update(run(4), 20); // four cached paragraphs at once
    expect(t.remaining(20)).toBeNull();
    t.update(run(5), 3020);
    expect(t.remaining(3020)).toBeCloseTo(15);
  });

  it('never goes negative when a paragraph runs long', () => {
    const t = new EtaTracker();
    t.update(run(0), 0);
    t.update(run(9), 9000);
    expect(t.remaining(60000)).toBe(0);
  });

  it('starts over for another story, another position, or when preparation stops', () => {
    const t = new EtaTracker();
    t.update(run(0), 0);
    t.update(run(2), 4000);
    t.update(run(0, { storyKey: 's2' }), 5000);
    expect(t.remaining(5000)).toBeNull();
    t.update(run(1, { storyKey: 's2' }), 7000);
    t.update(run(0, { storyKey: 's2' }), 8000); // sought elsewhere: the count restarts
    expect(t.remaining(8000)).toBeNull();
    t.update(run(10, { storyKey: 's2', preparing: false, ok: true }), 9000);
    expect(t.active).toBe(false);
  });
});

describe('etaLabel', () => {
  it('reads as plain language', () => {
    expect(etaLabel(null)).toBe('Estimating time…');
    expect(etaLabel(2)).toBe('Almost ready');
    expect(etaLabel(23)).toBe('About 25 seconds left');
    expect(etaLabel(61)).toBe('About 2 min left');
  });
});

describe('progressLabel', () => {
  it('shows listening time in minutes, never a raw fraction of an hour', () => {
    expect(progressLabel({ value: 0.03966666666666667, target: 1, unit: 'hours' })).toBe('2 min / 1 h');
    expect(progressLabel({ value: 0, target: 1, unit: 'hours' })).toBe('0 min / 1 h');
    expect(progressLabel({ value: 3.4567, target: 10, unit: 'hours' })).toBe('3.4 / 10 h');
    expect(progressLabel({ value: 42.9, target: 100, unit: 'hours' })).toBe('42 / 100 h');
  });
  it('shows counts as whole numbers', () => {
    expect(progressLabel({ value: 3, target: 5 })).toBe('3/5');
    expect(progressLabel({ value: 2.9999, target: 7 })).toBe('2/7');
  });
});
