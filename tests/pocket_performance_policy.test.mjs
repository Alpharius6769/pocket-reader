import assert from 'node:assert/strict';
import test from 'node:test';

import {
  POCKET_PERFORMANCE_POLICY_VERSION,
  computePocketFrameBudget,
  shouldRetryPocketQuality,
} from '../pocket_performance_policy.js';

test('performance policy is versioned', () => {
  assert.equal(POCKET_PERFORMANCE_POLICY_VERSION, 'perfv1');
});

test('soft quality warnings do not double synthesis work', () => {
  assert.equal(shouldRetryPocketQuality({ fatal: false, reasons: ['clipping'] }), false);
  assert.equal(shouldRetryPocketQuality({ fatal: false, reasons: ['pitch shift'] }), false);
});

test('fatal quality failures receive one retry', () => {
  assert.equal(shouldRetryPocketQuality({ fatal: true, reasons: ['empty output'] }), true);
});

test('short clauses get a small budget, never the full frame ceiling', () => {
  assert.equal(computePocketFrameBudget({ wordCount: 8, tokenCount: 12, tailFrames: 4 }), 118);
});

// The pure function defaults maxFrames to 500, but the WORKER owns the runtime
// ceiling and passes MAX_FRAMES (600 = 48 s). Long chunks are clamped to
// whatever ceiling the caller supplies — so both are pinned here explicitly.
test('long chunks are clamped to the supplied frame ceiling', () => {
  assert.equal(computePocketFrameBudget({ wordCount: 80, tokenCount: 100, tailFrames: 4 }), 500); // default fallback
  assert.equal(computePocketFrameBudget({ wordCount: 80, tokenCount: 100, tailFrames: 4, maxFrames: 600 }), 600); // worker runtime
});
