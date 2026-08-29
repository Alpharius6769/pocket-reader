#!/system/bin/sh
# Jetsam emulation v4 — budget applies to THE WEB APP, not to Chrome.
#
# A blank Chrome tab on this image costs 52 MB of anon before any page content
# exists (V8 isolate, Blink, compositor, font caches). That is Chrome's fixed
# cost, not Pocket Reader's, so it is accounted for and then excluded: the kill
# threshold is BASELINE + APP_BUDGET, and the trace reports app-only MB.
#
# Still anon-only (rss+swap): iOS counts phys_footprint, never the clean
# file-backed pages of the browser binary (~233 MB of Chrome .so here).
BASELINE_MB=52
APP_BUDGET_MB=350
LIMIT_MB=$((BASELINE_MB + APP_BUDGET_MB))
LOG=/data/local/tmp/jetsam.log
TRACE=/data/local/tmp/memtrace.csv
: > "$LOG"; echo "sample,app_mb,anon_mb,cache_mb,pids" > "$TRACE"
echo "baseline=${BASELINE_MB}MB app_budget=${APP_BUDGET_MB}MB kill_at_anon=${LIMIT_MB}MB" >> "$LOG"
PEAK=0; N=0
while true; do
  for P in $(ps -A -o PID,NAME | grep 'sandboxed_process' | awk '{print $1}'); do
    grep -q "^$P$" /dev/memcg/tabcap/cgroup.procs 2>/dev/null || echo "$P" > /dev/memcg/tabcap/cgroup.procs 2>/dev/null
  done
  R=$(awk '/^rss /{print $2}' /dev/memcg/tabcap/memory.stat)
  W=$(awk '/^swap /{print $2}' /dev/memcg/tabcap/memory.stat)
  C=$(awk '/^cache /{print $2}' /dev/memcg/tabcap/memory.stat)
  [ -z "$R" ] && R=0; [ -z "$W" ] && W=0; [ -z "$C" ] && C=0
  A=$(( (R + W) / 1048576 ))
  APP=$((A - BASELINE_MB)); [ "$APP" -lt 0 ] && APP=0
  N=$((N + 1))
  echo "$N,$APP,$A,$((C/1048576)),\"$(cat /dev/memcg/tabcap/cgroup.procs | tr '\n' ' ')\"" >> "$TRACE"
  if [ "$APP" -gt "$PEAK" ]; then PEAK=$APP; echo "sample$N peak_app=${PEAK}MB (anon ${A})" >> "$LOG"; fi
  if [ "$A" -gt "$LIMIT_MB" ]; then
    BIG=$(ps -A -o PID,RSS,NAME | grep 'sandboxed_process' | sort -k2 -n -r | head -1 | awk '{print $1}')
    echo "sample$N JETSAM_KILL app=${APP}MB budget=${APP_BUDGET_MB}MB (anon ${A} > ${LIMIT_MB}) victim=$BIG" >> "$LOG"
    [ -n "$BIG" ] && kill -9 "$BIG"
    PEAK=0; sleep 3
  fi
  sleep 0.25
done
