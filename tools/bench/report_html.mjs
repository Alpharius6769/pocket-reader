// HTML views of a longform_bench report. Self-contained: no external scripts,
// fonts or styles, so the files open straight from disk next to their WAVs.

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (value, digits = 2) => (value == null || !Number.isFinite(Number(value)) ? '–' : Number(value).toFixed(digits));

const STYLE = `
:root { --bg:#f7f7f5; --panel:#ffffff; --ink:#1d1d1f; --muted:#6b6b70; --line:#e3e3e0;
  --s1:#2f6fdf; --s2:#d9480f; --s3:#2b8a3e; --warn:#b35c00; --bad:#c92a2a; --ok:#2b8a3e; --chip:#efefec; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#141416; --panel:#1d1d20; --ink:#ececef;
  --muted:#9a9aa2; --line:#323238; --s1:#6ea0ff; --s2:#ff8a4c; --s3:#5fd07a; --warn:#ffb347; --bad:#ff6b6b; --ok:#5fd07a; --chip:#2a2a2f; } }
:root[data-theme="dark"] { --bg:#141416; --panel:#1d1d20; --ink:#ececef; --muted:#9a9aa2; --line:#323238;
  --s1:#6ea0ff; --s2:#ff8a4c; --s3:#5fd07a; --warn:#ffb347; --bad:#ff6b6b; --ok:#5fd07a; --chip:#2a2a2f; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:1280px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:16px; margin:32px 0 10px; }
.sub { color:var(--muted); margin:0 0 20px; }
.tiles { display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:10px; }
.tile { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px; }
.tile .k { color:var(--muted); font-size:12px; } .tile .v { font-size:22px; font-weight:600; margin-top:2px; font-variant-numeric:tabular-nums; }
.tile .n { color:var(--muted); font-size:11px; margin-top:2px; }
.panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px; overflow-x:auto; }
.charts { display:grid; grid-template-columns:repeat(auto-fit,minmax(380px,1fr)); gap:10px; }
svg text { fill:var(--muted); font-size:10px; }
table { border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; }
th, td { border-bottom:1px solid var(--line); padding:6px 6px; text-align:right; vertical-align:top; white-space:nowrap; }
th { color:var(--muted); font-weight:500; font-size:12px; position:sticky; top:0; background:var(--panel); }
td.l, th.l { text-align:left; } td.text { white-space:normal; min-width:280px; max-width:420px; color:var(--muted); font-size:12px; }
.chip { display:inline-block; padding:1px 7px; border-radius:99px; background:var(--chip); font-size:12px; }
.ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); }
audio { height:28px; width:210px; }
.legend span { margin-right:14px; font-size:12px; color:var(--muted); } .legend i { display:inline-block; width:10px; height:3px; margin-right:5px; vertical-align:middle; }
details { margin-top:8px; } code { font-size:12px; }
ul.method li { margin:4px 0; color:var(--muted); }
@media (max-width:600px) { .charts { grid-template-columns:1fr; } audio { width:160px; } }
`;

function lineChart({ title, series, xLabels, height = 180, yUnit = '', bars = null }) {
  const width = 560;
  const pad = { l: 40, r: 10, t: 22, b: 22 };
  const all = series.flatMap((s) => s.values).concat(bars ? bars.values : []).filter((v) => Number.isFinite(v));
  if (!all.length) return `<div class="panel"><strong>${esc(title)}</strong><p class="sub">no data</p></div>`;
  let lo = Math.min(0, ...all);
  let hi = Math.max(...all);
  if (hi === lo) hi = lo + 1;
  const n = Math.max(2, xLabels.length);
  const x = (i) => pad.l + ((width - pad.l - pad.r) * i) / (n - 1);
  const y = (v) => pad.t + (height - pad.t - pad.b) * (1 - (v - lo) / (hi - lo));
  const ticks = [lo, (lo + hi) / 2, hi];
  const grid = ticks.map((t) => `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)"/><text x="${pad.l - 4}" y="${y(t) + 3}" text-anchor="end">${fmt(t, Math.abs(hi - lo) < 5 ? 2 : 0)}</text>`).join('');
  const step = Math.max(1, Math.ceil(n / 12));
  const xt = xLabels.map((label, i) => (i % step === 0 ? `<text x="${x(i)}" y="${height - 6}" text-anchor="middle">${esc(label)}</text>` : '')).join('');
  const barW = Math.max(2, (width - pad.l - pad.r) / n * 0.6);
  const barSvg = bars ? bars.values.map((v, i) => (Number.isFinite(v) && v > 0
    ? `<rect x="${x(i) - barW / 2}" y="${y(v)}" width="${barW}" height="${y(lo) - y(v)}" fill="${bars.color}" opacity="0.55"><title>${esc(bars.name)} p${i}: ${fmt(v)}</title></rect>` : '')).join('') : '';
  const lines = series.map((s) => {
    const pts = s.values.map((v, i) => (Number.isFinite(v) ? `${x(i + (s.offset || 0))},${y(v)}` : null));
    const segments = [];
    let cur = [];
    for (const p of pts) { if (p) cur.push(p); else if (cur.length) { segments.push(cur); cur = []; } }
    if (cur.length) segments.push(cur);
    const dots = s.values.map((v, i) => (Number.isFinite(v) ? `<circle cx="${x(i + (s.offset || 0))}" cy="${y(v)}" r="2.2" fill="${s.color}"><title>${esc(s.name)} ${i}: ${fmt(v)}</title></circle>` : '')).join('');
    return segments.map((seg) => `<polyline fill="none" stroke="${s.color}" stroke-width="1.6" points="${seg.join(' ')}"/>`).join('') + dots;
  }).join('');
  const legend = [...series, ...(bars ? [bars] : [])].map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
  return `<div class="panel"><strong>${esc(title)}</strong>${yUnit ? ` <span class="sub">(${esc(yUnit)})</span>` : ''}
<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(title)}">${grid}${barSvg}${lines}${xt}</svg>
<div class="legend">${legend}</div></div>`;
}

function tile(key, value, note = '', cls = '') {
  return `<div class="tile"><div class="k">${esc(key)}</div><div class="v ${cls}">${value}</div>${note ? `<div class="n">${esc(note)}</div>` : ''}</div>`;
}

export function renderReportHtml(report) {
  const h = report.headline;
  const rows = report.paragraphs;
  const labels = rows.map((r) => `p${r.index}`);
  const verdictClass = (v) => (v === 'clean' ? 'ok' : v.startsWith('soft') || v.startsWith('retried, then') ? 'warn' : 'bad');
  const driftLabels = report.prosodyDrift.map((w) => `${w.start}`);
  const tiles = [
    tile('Time to first audio (cold)', `${fmt(h.timeToFirstAudioColdMs / 1000, 1)} s`, h.timeToFirstAudioIncludes),
    tile('Engine load', h.engineLoadMs == null ? '–' : `${fmt(h.engineLoadMs / 1000, 1)} s`, 'neural state loading → ready'),
    tile('RTF overall', fmt(h.rtfOverall, 3), `wall ${fmt(h.synthWallSec, 0)} s / audio ${fmt(h.audioSec, 0)} s`),
    tile('RTF median (warm)', fmt(h.rtfMedianWarm, 3), `worst ${fmt(h.rtfWorstWarm, 3)}`),
    tile('Stalls', `${h.stallCount}`, `${fmt(h.stallTotalSec, 1)} s total, worst ${fmt(h.stallWorstSec, 1)} s`, h.stallCount ? 'warn' : 'ok'),
    tile('Retries', `${h.retryRenders}`, `${h.retryParagraphs} paragraphs, ${h.bestEffortParagraphs} best-effort`, h.retryRenders ? 'warn' : 'ok'),
    tile('Guard soft warnings', `${h.softWarnings}`, `${h.failedParagraphs} failed paragraphs`, h.failedParagraphs ? 'bad' : ''),
    tile('Frame-budget stops', `${h.frameBudgetStops}`, 'runaway chunks cut at the budget', h.frameBudgetStops ? 'warn' : 'ok'),
    tile('Early-EOS suspects', `${h.earlyEosSuspects}`, 'short vs token count, or no tail', h.earlyEosSuspects ? 'warn' : 'ok'),
    tile('Prosody drift', `${fmt(h.prosodyDriftMax)}`, `max over windows; final ${fmt(h.prosodyDriftFinal)}`),
    tile('Timbre drift (MFCC)', `${fmt(h.timbreDriftMax)}`, `max; final ${fmt(h.timbreDriftFinal)}`),
    tile('Worker recycles', `${h.workerRecycles}`, `drift-guard transitions: ${h.driftGuardTransitions}`),
    tile('Median F0', `${fmt(h.f0MedianHzRun, 0)} Hz`, `longest internal silence ${fmt(h.maxInternalSilenceSec, 2)} s`),
    tile('Peak browser memory', h.peakPrivateMemoryMb ? `${h.peakPrivateMemoryMb} MB` : '–', 'private bytes, all Chrome processes'),
  ].join('');

  const charts = [
    lineChart({
      title: 'Synthesis speed and stalls per paragraph', xLabels: labels, yUnit: 'RTF / seconds',
      series: [{ name: 'wall RTF', values: rows.map((r) => r.wallRtf), color: 'var(--s1)' }],
      bars: { name: 'stall (s)', values: rows.map((r) => r.stallSec), color: 'var(--s2)' },
    }),
    lineChart({
      title: 'Drift from the opening 5 paragraphs', xLabels: driftLabels, yUnit: 'window start paragraph',
      series: [
        { name: 'prosody (fixed units)', values: report.prosodyDrift.map((w) => w.distance), color: 'var(--s1)' },
        { name: 'timbre (MFCC)', values: report.timbreDrift.map((w) => w.distance), color: 'var(--s2)' },
      ],
    }),
    lineChart({
      title: 'Median F0 and F0 spread', xLabels: labels, yUnit: 'Hz / semitones x10',
      series: [
        { name: 'median F0 (Hz)', values: rows.map((r) => r.features?.f0MedianHz), color: 'var(--s1)' },
        { name: 'F0 IQR (st x10)', values: rows.map((r) => (r.features?.f0SpreadSt == null ? null : r.features.f0SpreadSt * 10)), color: 'var(--s3)' },
      ],
    }),
    lineChart({
      title: 'Speaking rate and loudness', xLabels: labels, yUnit: 'words/s ; dBFS/10',
      series: [
        { name: 'words/s (active)', values: rows.map((r) => r.features?.wordsPerSecActive), color: 'var(--s1)' },
        { name: 'RMS dBFS / -10', values: rows.map((r) => (r.features ? -r.features.rmsDb / 10 : null)), color: 'var(--s2)' },
      ],
    }),
    lineChart({
      title: 'Spectral centroid and flatness', xLabels: labels, yUnit: 'kHz ; flatness x10',
      series: [
        { name: 'centroid (kHz)', values: rows.map((r) => (r.features ? r.features.centroidHz / 1000 : null)), color: 'var(--s1)' },
        { name: 'flatness x10', values: rows.map((r) => (r.features ? r.features.flatness * 10 : null)), color: 'var(--s2)' },
      ],
    }),
    lineChart({
      title: 'Browser memory', xLabels: labels, yUnit: 'MB',
      series: [
        { name: 'private MB', values: rows.map((r) => r.privateMemoryMb), color: 'var(--s1)' },
        { name: 'page JS heap MB', values: rows.map((r) => r.jsHeapMb), color: 'var(--s3)' },
      ],
    }),
  ].join('');

  const tableRows = rows.map((r) => {
    const f = r.features || {};
    return `<tr>
<td class="l">p${r.index}${r.recycledBefore ? ' <span class="chip" title="worker recycled before this paragraph">recycle</span>' : ''}${r.streamed ? ' <span class="chip">stream</span>' : ''}</td>
<td class="l">${r.wav ? `<audio controls preload="none" src="${esc(r.wav)}"></audio>` : '<span class="bad">no audio</span>'}</td>
<td class="l ${verdictClass(r.verdict)}">${esc(r.verdict)}</td>
<td class="l">${esc(r.emotion || '–')}${r.rawEmotion && r.rawEmotion !== r.emotion ? ` <span class="sub">(raw ${esc(r.rawEmotion)})</span>` : ''}</td>
<td>${fmt(r.temperature)}</td><td>${fmt(r.wallMs / 1000, 1)}</td><td>${fmt(r.wallRtf, 3)}</td>
<td class="${r.stallSec > 0.05 ? 'warn' : ''}">${fmt(r.stallSec, 2)}</td><td>${r.retryRenders}</td>
<td>${r.tokens}${r.tokensExact ? '' : '*'}</td><td>${r.textChunks ?? '–'}</td><td>${r.frames ?? '–'}</td>
<td class="${r.frameBudgetStops ? 'warn' : ''}">${r.frameBudgetStops ?? '–'}</td>
<td class="${r.earlyEosSuspect ? 'warn' : ''}" title="${esc(r.earlyEosReasons.join('; '))}">${r.actualSpeechFrames ?? '–'} / ${r.expectedSpeechFrames ?? '–'}${r.earlyEosSuspect ? ' ⚑' : ''}</td>
<td>${fmt(f.durationSec, 1)}</td><td>${fmt(f.f0MedianHz, 0)}</td><td>${fmt(f.f0SpreadSt, 2)}</td><td>${fmt(f.centroidHz, 0)}</td>
<td>${fmt(f.wordsPerSecActive, 2)}</td><td>${fmt(f.rmsDb, 1)}</td><td>${fmt(f.flatness, 3)}</td><td>${fmt(f.maxInternalSilenceSec, 2)}</td>
<td class="text">${esc(r.text)}${r.guardLogs.length ? `<details><summary>guard log</summary>${r.guardLogs.map((m) => `<div>${esc(m)}</div>`).join('')}</details>` : ''}</td>
</tr>`;
  }).join('');

  const m = report.method;
  const env = report.environment;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Longform Bench Report</title><style>${STYLE}</style></head>
<body><main>
<h1>Long-form narration bench: ${esc(report.label)}</h1>
<p class="sub">${esc(report.generatedAt)} · git ${esc(report.git.head || '?')}${report.git.publicDirty ? ' (public/ has local changes)' : ''} ·
voice ${esc(report.options.voice)} · ${esc(report.options.threads)} WASM threads (ran ${esc(rows[0]?.wasmThreads ?? '?')}) ·
expressive ${report.options.expressive ? 'on' : 'off'} · emotion mode ${esc(report.options.emotionMode)} ·
${esc(env.selectedBackend || rows[0]?.arMode || '')} · ${esc(env.userAgent || '')}</p>
<div class="tiles">${tiles}</div>
<h2>Trends</h2>
<div class="charts">${charts}</div>
<h2>Paragraphs</h2>
<div class="panel"><table>
<thead><tr><th class="l">#</th><th class="l">audio</th><th class="l">guard verdict</th><th class="l">emotion</th><th>temp</th><th>synth s</th><th>RTF</th>
<th>stall s</th><th>retries</th><th>tokens</th><th>chunks</th><th>frames</th><th>budget stops</th><th>speech frames / expected</th>
<th>dur s</th><th>F0 Hz</th><th>F0 IQR st</th><th>centroid Hz</th><th>words/s</th><th>RMS dB</th><th>flatness</th><th>max gap s</th><th class="l">text</th></tr></thead>
<tbody>${tableRows}</tbody></table>
${rows.some((r) => !r.tokensExact) ? '<p class="sub">* token count estimated (words x 1.3): the tokenizer could not be loaded.</p>' : ''}
</div>
<h2>Method</h2>
<div class="panel"><ul class="method">
<li><strong>Path:</strong> ${esc(m.path)}</li>
<li><strong>Stalls:</strong> ${esc(m.stalls)}</li>
<li><strong>RTF:</strong> ${esc(m.rtf)}</li>
<li><strong>Early EOS:</strong> ${esc(m.earlyEos)}. Tokens: ${esc(m.tokens)}</li>
<li><strong>Drift:</strong> ${esc(m.drift)}. One prosody unit = ${Object.values(m.driftUnits).map((u) => esc(u.describe)).join(', ')}.</li>
<li><strong>Caveat:</strong> ${esc(m.caveat)}</li>
<li><strong>Core hashes:</strong> ${Object.entries(report.coreHashes).map(([k, v]) => `<code>${esc(k)} ${esc(v)}</code>`).join(' · ')}</li>
</ul></div>
</main></body></html>
`;
}

export function renderAbTestHtml(report) {
  const items = (report.abtest || []).map((entry) => ({
    id: entry.id,
    word: entry.word,
    text: entry.text,
    respelledText: entry.respelledText,
    natural: entry.natural?.wav || null,
    respelled: entry.respelled?.wav || null,
    naturalDur: entry.natural?.features?.durationSec ?? null,
    respelledDur: entry.respelled?.features?.durationSec ?? null,
  }));
  const data = JSON.stringify({ label: report.label, generatedAt: report.generatedAt, items }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Respelling AB Test</title><style>${STYLE}
.pair { display:grid; grid-template-columns: 1fr; gap:8px; }
.row { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin:6px 0; }
.row b { min-width:20px; } button { font:inherit; padding:5px 12px; border-radius:8px; border:1px solid var(--line); background:var(--chip); color:var(--ink); cursor:pointer; }
button[aria-pressed="true"] { border-color:var(--s1); outline:2px solid var(--s1); }
.reveal { color:var(--muted); font-size:12px; } .hidden { display:none; }
textarea { width:100%; min-height:120px; font:12px ui-monospace,monospace; background:var(--panel); color:var(--ink); border:1px solid var(--line); border-radius:8px; }
</style></head>
<body><main>
<h1>Respelling A/B: ${esc(report.label)}</h1>
<p class="sub">Each sentence was rendered twice through the real narration path with the same voice and seed: once with the production
pseudo-word respelling (e.g. <code>does → duz</code>), once with that respelling disabled so the model sees the word as written. The two clips
are shown as X and Y in a random order per sentence. Pick the one that sounds right: correct word, natural voice. Choices stay in this browser;
use "Copy results" to hand them back.</p>
<p><label><input type="checkbox" id="showAll"> reveal which clip is which</label></p>
<div id="list"></div>
<h2>Results</h2>
<div class="panel"><p id="summary" class="sub"></p><button id="copy" type="button">Copy results</button>
<textarea id="out" readonly></textarea></div>
<script>
const DATA = ${data};
const KEY = 'pr-abtest-' + DATA.label + '-' + DATA.generatedAt;
let state = {};
try { state = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { state = {}; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} render(); };
function seededFlip(id) { let h = 0; for (const c of id + DATA.generatedAt) h = (h * 31 + c.charCodeAt(0)) | 0; return (h & 1) === 1; }
const list = document.getElementById('list');
DATA.items.forEach((item) => {
  const flip = seededFlip(item.id);
  const x = flip ? 'respelled' : 'natural';
  const y = flip ? 'natural' : 'respelled';
  item.order = { X: x, Y: y };
  const el = document.createElement('div');
  el.className = 'panel';
  el.style.marginBottom = '10px';
  const clip = (side) => item[side] ? '<audio controls preload="none" src="' + item[side] + '"></audio>' : '<span class="bad">missing</span>';
  el.innerHTML = '<div class="pair"><div><strong>' + item.word + '</strong> <span class="sub">' + item.text.replace(/</g, '&lt;') + '</span></div>'
    + '<div class="row"><b>X</b>' + clip(x) + '<span class="reveal hidden" data-r>' + x + '</span></div>'
    + '<div class="row"><b>Y</b>' + clip(y) + '<span class="reveal hidden" data-r>' + y + '</span></div>'
    + '<div class="row"><button data-c="X" type="button">X sounds right</button><button data-c="Y" type="button">Y sounds right</button>'
    + '<button data-c="same" type="button">No difference</button><button data-c="both-bad" type="button">Both wrong</button></div>'
    + '<div class="reveal hidden" data-r>respelled text sent to the model: <code>' + String(item.respelledText || '').replace(/</g, '&lt;') + '</code></div></div>';
  el.querySelectorAll('button[data-c]').forEach((btn) => btn.addEventListener('click', () => { state[item.id] = btn.dataset.c; save(); }));
  item.el = el;
  list.appendChild(el);
});
document.getElementById('showAll').addEventListener('change', render);
document.getElementById('copy').addEventListener('click', async () => {
  const out = document.getElementById('out');
  out.select();
  try { await navigator.clipboard.writeText(out.value); } catch (_) { document.execCommand && document.execCommand('copy'); }
});
function render() {
  const reveal = document.getElementById('showAll').checked;
  const tally = { natural: 0, respelled: 0, same: 0, 'both-bad': 0 };
  const results = DATA.items.map((item) => {
    const choice = state[item.id] || null;
    item.el.querySelectorAll('button[data-c]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.c === choice)));
    item.el.querySelectorAll('[data-r]').forEach((n) => n.classList.toggle('hidden', !reveal));
    const preferred = choice === 'X' || choice === 'Y' ? item.order[choice] : choice;
    if (preferred) tally[preferred] += 1;
    return { id: item.id, word: item.word, preferred };
  });
  const answered = results.filter((r) => r.preferred).length;
  document.getElementById('summary').textContent = answered + ' of ' + results.length + ' answered. Natural spelling preferred: '
    + tally.natural + ', respelled preferred: ' + tally.respelled + ', no difference: ' + tally.same + ', both wrong: ' + tally['both-bad'] + '.';
  document.getElementById('out').value = JSON.stringify({ label: DATA.label, generatedAt: DATA.generatedAt, results }, null, 2);
}
render();
</script>
</main></body></html>
`;
}
