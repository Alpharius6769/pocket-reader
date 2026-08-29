# iPhone-class OOM rig (Android emulator)

Reproduces the iOS memory kill on a Windows PC. Safari gives no heap numbers and
no crash log; this rig gives both, on a device with a comparable CPU and a real,
enforced memory ceiling.

## Why an Android emulator can stand in for an iPhone

It emulates the **memory ceiling and the kill**, not the engine. Chrome is V8 +
Blink; iOS is JavaScriptCore + WebKit. Allocation *counts* differ in detail. What
transfers is the shape: a 4 GB device class, an ~350 MB per-tab footprint budget,
and a hard kill when the tab crosses it.

## The one thing that must be right: what counts toward the budget

iOS Jetsam kills a WebContent process on `phys_footprint` — anonymous and dirty
memory. It does **not** count clean file-backed pages, i.e. the browser's own
binary. On this emulator Chrome's mapped shared libraries are ~233 MB of file
cache. Charging those against a 350 MB budget kills the tab after ~90 MB of real
JS/WASM heap and measures Chrome, not Pocket Reader.

So the cgroup hard limit is only a backstop. The budget is enforced Jetsam-style
on **anon (rss + swap)** by `jetsam.sh`, which polls at 250 ms and SIGKILLs the
largest renderer when anon crosses the limit.

Second trap, learned the hard way: the `?tts_fast=1` isolation reload spawns a
**new renderer process**. An earlier version of this script latched onto the
stale pre-reload renderer with `head -1` and reported a flat 68 MB while the real
tab was at 479 MB. `jetsam.sh` now caps *every* Chrome renderer.

## Setup

    AVD: Pixel 7 Pro, system-images;android-34;google_apis;x86_64
         hw.ramSize=4096M, hw.cpu.ncore=4
    (google_apis, NOT ...playstore — `adb root` is required and Play images deny it)

    adb root
    adb shell 'mkdir -p /dev/memcg/tabcap
      echo 3 > /dev/memcg/tabcap/memory.move_charge_at_immigrate
      echo 0 > /dev/memcg/tabcap/memory.swappiness
      echo 2147483648 > /dev/memcg/tabcap/memory.memsw.limit_in_bytes
      echo 2147483648 > /dev/memcg/tabcap/memory.limit_in_bytes'

`memsw` must be raised BEFORE `memory.limit_in_bytes`, and it matters: zram swap
is active, so without a memsw cap the tab swaps instead of dying.

Chrome needs remote debugging, which it only opens if it reads the command-line
file (`ro.debuggable=1` on a userdebug image):

    adb shell "echo 'chrome --disable-fre --no-first-run --remote-debugging-socket-name=chrome_devtools_remote' > /data/local/tmp/chrome-command-line"
    adb forward tcp:9222 localabstract:chrome_devtools_remote

Then drive it with Playwright: `chromium.connectOverCDP('http://127.0.0.1:9222')`.

Note for Git Bash on Windows: prefix adb calls with `MSYS_NO_PATHCONV=1` or
`/data/local/tmp/...` is rewritten into a Windows path.

## Run

    adb push jetsam.sh /data/local/tmp/ && adb shell 'chmod 755 /data/local/tmp/jetsam.sh'
    adb shell '(nohup /data/local/tmp/jetsam.sh >/dev/null 2>&1 &)'

Writes `/data/local/tmp/memtrace.csv` (250 ms samples) and `/data/local/tmp/jetsam.log`.
Set `LIMIT_MB` very high to measure a true peak without the kill.

## Excluding Chrome's own cost

A blank Chrome tab on this image costs **52 MB of anon** before any page content
exists. That is Chrome, not Pocket Reader. `jetsam.sh` subtracts it, so
`APP_BUDGET_MB` is what the *web app* gets and `app_mb` in the trace is app-only.

Device RAM stays at **4096M** deliberately. The app gates on
`navigator.deviceMemory === 4` to pick Kokoro and raise its Away Mode warning;
at 6-8 GB Chrome reports 8 and the app selects Pocket TTS instead, which is a
different test. Adjust `APP_BUDGET_MB`, never `hw.ramSize`.

## Result on 2026-08-28 (Kokoro, app-only accounting)

| | app-only |
|---|---|
| idle, story open | 27 MB |
| **transient peak, ORT session build** | **396-400 MB** |
| **steady state while synthesizing** | **295-299 MB** |

Against a 350 MB app budget: killed at the spike, ~50 MB over, before caching a
single paragraph. At a 400 MB budget it *still* died (405 MB observed). At 700 MB
it survives, and settles to 298 MB -- **55 MB under the 350 MB budget**.

So sustained operation fits an iPhone-class budget comfortably. The only thing
that breaches it is the session-build transient in `kokoro_worker.js loadModel()`,
which holds the ~86 MB fetched buffer alive across
`InferenceSession.create(buffer, { graphOptimizationLevel: 'all' })` -- the trace
shows +64 MB then +184 MB in two consecutive 250 ms samples.

The trace also shows the engine being torn down and rebuilt ~2 minutes in,
spiking to 400 MB a **second** time. The spike is not a one-time risk at story
open; every engine reload re-rolls it.

## What this rig does NOT tell you

Speed. Emulated x86 WASM inference ran ~1 paragraph per 3-5 minutes here, orders
of magnitude slower than an iPhone 13. Memory figures transfer; timings do not.
Reaching 40 paragraphs is not practical on this rig for that reason.
