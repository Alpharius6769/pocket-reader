export const POCKET_PERFORMANCE_POLICY_VERSION = 'perfv1';

export function shouldRetryPocketQuality(quality) {
  return quality?.fatal === true;
}

export function computePocketFrameBudget({
  wordCount = 0,
  tokenCount = 0,
  tailFrames = 0,
  maxFrames = 500,
} = {}) {
  const words = Math.max(0, Number(wordCount) || 0);
  const tokens = Math.max(0, Number(tokenCount) || 0);
  const tail = Math.max(0, Number(tailFrames) || 0);
  const ceiling = Math.max(1, Number(maxFrames) || 500);

  // Pocket emits 80 ms of audio per frame. These bounds allow substantially
  // slower-than-audiobook speech plus a generous tail, while preventing a
  // missed EOS from spending 40 seconds on every short clause.
  const wordBudget = Math.ceil(words * 8 + 50 + tail);
  const tokenBudget = Math.ceil(tokens * 6 + 40 + tail);
  return Math.min(ceiling, Math.max(80, wordBudget, tokenBudget));
}
