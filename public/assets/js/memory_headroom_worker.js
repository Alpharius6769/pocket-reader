// Measures how much working memory this tab can actually hold, in a worker, so
// a probe that goes too far kills the worker instead of the page.
//
// Why measure at all: Safari reports neither RAM nor model, so an iPhone 14 Pro
// and an iPhone 15 Pro are byte-identical to a browser -- same 393x852, same
// core count, same user agent -- while sitting on opposite sides of the
// narration ladder. Headroom is the quantity that actually decides the outcome:
// the iPhone failure mode is a TRANSIENT spike while ORT builds its session
// (measured 396-421 MB for Kokoro against a 298-310 MB steady state), so a
// device that narrates happily for an hour can still die in the first seconds.
//
// Why a worker: iOS does not always throw on allocation failure. It reaps the
// whole JS context. Doing this on the main thread risks taking the page with
// it; a dead worker is recoverable and is itself a usable answer.

const CHUNK_MB = 32;
const CHUNK_BYTES = CHUNK_MB * 1024 * 1024;
// 1 GB. Past this the answer stops changing any decision -- every tier is
// already unlocked -- so continuing only buys risk.
const CEILING_MB = 1024;
const PAGE_STRIDE = 4096;

// An allocation that is never read can be a lazy reservation the OS has not
// actually committed, which measures nothing. Touching one byte per page forces
// the commit, and reading it back keeps the write from being optimised away.
function commit(bytes) {
  const view = new Uint8Array(bytes);
  let checksum = 0;
  for (let offset = 0; offset < view.length; offset += PAGE_STRIDE) {
    view[offset] = (offset & 0xff) ^ 0x5a;
    checksum = (checksum + view[offset]) | 0;
  }
  return { view, checksum };
}

function measure(ceilingMb) {
  const held = [];
  let heldMb = 0;
  let checksum = 0;
  let stoppedBy = 'ceiling';
  try {
    while (heldMb + CHUNK_MB <= ceilingMb) {
      const { view, checksum: part } = commit(CHUNK_BYTES);
      held.push(view);
      checksum = (checksum + part) | 0;
      heldMb += CHUNK_MB;
      // Report as we climb. If the next step is the one that gets this worker
      // reaped, the coordinator still knows how far we got.
      self.postMessage({ type: 'progress', heldMb });
    }
  } catch (error) {
    // RangeError from the allocation, or an OOM the engine chose to surface.
    stoppedBy = 'allocation-failed';
  } finally {
    held.length = 0;
  }
  return { heldMb, stoppedBy, checksum };
}

self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type !== 'measure') return;
  const ceilingMb = Math.max(CHUNK_MB, Math.min(CEILING_MB, Number(data.ceilingMb) || CEILING_MB));
  const startedAt = performance.now();
  const result = measure(ceilingMb);
  self.postMessage({
    type: 'result',
    headroomMb: result.heldMb,
    stoppedBy: result.stoppedBy,
    ceilingMb,
    elapsedMs: Math.round(performance.now() - startedAt),
    checksum: result.checksum,
  });
};
