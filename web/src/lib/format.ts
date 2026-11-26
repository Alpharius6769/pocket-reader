export function words(n?: number) {
  if (!n) return '';
  if (n < 1000) return `${n} words`;
  return `${n < 10_000 ? (n / 1000).toFixed(1) : Math.round(n / 1000)}k words`;
}

/** Narration at ~155 words per minute at 1x. */
export function listenTime(wordCount?: number, speed = 1) {
  if (!wordCount) return '';
  const mins = Math.round(wordCount / 155 / speed);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function ago(ts?: number, now = Date.now()) {
  if (!ts) return '';
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function percent(x: number) {
  return `${Math.round(x * 100)}%`;
}

export function speedLabel(s: number) {
  return `${Number.isInteger(s) ? s.toFixed(0) : String(s)}×`;
}

export function greeting(d = new Date()) {
  const h = d.getHours();
  if (h < 5) return 'Still up?';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function clockLeft(endsAt: number, now = Date.now()) {
  const s = Math.max(0, Math.round((endsAt - now) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
