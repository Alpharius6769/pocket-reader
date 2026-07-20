// Short, deterministic CPU scaling probe used only by first-device setup.
// It does not inspect files, identifiers, sensors, or account data.

function runIntegerKernel(iterations, seed) {
  let a = (seed | 0) ^ 0x6d2b79f5;
  let b = 0x1b873593;
  for (let i = 0; i < iterations; i++) {
    a = Math.imul(a ^ (a >>> 15), 0x2c1b3c6d);
    b = Math.imul(b ^ (b >>> 13), 0x297a2d39);
    a = (a + b + i) | 0;
  }
  return (a ^ b) >>> 0;
}

self.onmessage = (event) => {
  const data = event.data || {};
  const iterations = Math.max(1, Math.min(20_000_000, Number(data.iterations) || 1));
  const startedAt = performance.now();
  const checksum = runIntegerKernel(iterations, Number(data.seed) || 1);
  self.postMessage({
    id: data.id,
    elapsedMs: performance.now() - startedAt,
    checksum,
  });
};
