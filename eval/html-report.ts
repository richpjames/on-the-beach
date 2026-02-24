import type { EvalReport } from "./types";

const MODEL_PALETTE = [
  "#e8a44a", // amber
  "#5aafcf", // blue
  "#c77dba", // purple
  "#7bc67e", // green
  "#f06292", // pink
  "#4db6ac", // teal
];

export function generateHtml(report: EvalReport): string {
  const date = report.timestamp.slice(0, 10);
  const gridCols = `repeat(${report.models.length}, 1fr)`;

  // Strip ocrText before embedding — keeps HTML file size manageable.
  // JSON artifacts written by results.ts retain raw OCR output.
  const reportForEmbed = {
    ...report,
    results: Object.fromEntries(
      Object.entries(report.results).map(([model, data]) => [
        model,
        {
          ...data,
          details: data.details.map(({ ocrText: _ocrText, ...rest }) => rest),
        },
      ]),
    ),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OCR Eval — ${date}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=DM+Sans:ital,wght@0,400;0,500;0,700;1,400&family=Playfair+Display:wght@700;900&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0e0e0e;
    --surface: #171717;
    --surface2: #1e1e1e;
    --border: #2a2a2a;
    --text: #e8e4de;
    --text-dim: #8a847a;
    --amber: #e8a44a;
    --amber-dim: rgba(232,164,74,0.15);
    --green: #5cb87a;
    --green-dim: rgba(92,184,122,0.12);
    --red: #d15a5a;
    --red-dim: rgba(209,90,90,0.12);
    --yellow: #c9a84c;
    --yellow-dim: rgba(201,168,76,0.12);
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'DM Sans', sans-serif;
    line-height: 1.5;
    min-height: 100vh;
  }

  .noise {
    position: fixed; inset: 0; z-index: 0; pointer-events: none; opacity: 0.03;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    background-size: 256px 256px;
  }

  .container {
    position: relative; z-index: 1;
    max-width: 1400px;
    margin: 0 auto;
    padding: 48px 32px 80px;
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 48px;
  }

  header .label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--amber);
    margin-bottom: 8px;
  }

  header h1 {
    font-family: 'Playfair Display', serif;
    font-weight: 900;
    font-size: 36px;
    letter-spacing: -0.02em;
    color: var(--text);
    margin-bottom: 6px;
  }

  header .meta {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: var(--text-dim);
  }

  /* ─── Save Button ─── */
  .save-btn {
    all: unset;
    cursor: pointer;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.05em;
    padding: 10px 18px;
    border-radius: 8px;
    background: var(--surface2);
    border: 1px solid var(--border);
    color: var(--text-dim);
    transition: all 0.2s;
    white-space: nowrap;
    flex-shrink: 0;
    margin-left: 24px;
    margin-top: 6px;
  }

  .save-btn:hover { border-color: var(--amber); color: var(--amber); background: var(--amber-dim); }
  .save-btn.has-changes { border-color: var(--amber); color: var(--amber); background: var(--amber-dim); }

  /* ─── Summary Cards ─── */
  .summary-grid {
    display: grid;
    grid-template-columns: ${gridCols};
    gap: 16px;
    margin-bottom: 48px;
  }

  .model-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px;
    position: relative;
    overflow: hidden;
    animation: fadeUp 0.5s ease both;
  }

  .model-card-accent {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
  }

  .model-card .model-name {
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 16px;
  }

  .overall-score {
    font-family: 'Playfair Display', serif;
    font-size: 48px;
    font-weight: 900;
    letter-spacing: -0.03em;
    margin-bottom: 16px;
  }

  .overall-label {
    font-size: 12px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 4px;
  }

  .stat-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 0;
    border-top: 1px solid var(--border);
    font-size: 13px;
  }

  .stat-row .stat-label {
    color: var(--text-dim);
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
  }

  .stat-row .stat-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    font-weight: 600;
  }

  .bar-track {
    width: 80px;
    height: 4px;
    background: var(--surface2);
    border-radius: 2px;
    margin: 0 12px;
    flex-shrink: 0;
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.4s ease;
  }

  /* ─── Section Headers ─── */
  .section-title {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--text-dim);
    margin-bottom: 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }

  /* ─── Detail Table ─── */
  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    animation: fadeUp 0.5s ease 0.25s both;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  thead th {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-dim);
    padding: 14px 12px;
    text-align: left;
    background: var(--surface2);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 2;
    white-space: nowrap;
  }

  thead th.group-header {
    text-align: center;
    border-left: 1px solid var(--border);
    padding: 8px 12px;
  }

  thead th:first-child { border-radius: 11px 0 0 0; }
  thead th:last-child { border-radius: 0 11px 0 0; }

  tbody td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }

  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: rgba(232,164,74,0.03); }

  .col-id {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--text-dim);
    max-width: 160px;
    word-break: break-all;
  }

  .col-expected { color: var(--text); font-weight: 500; }
  .col-expected .artist { color: var(--text); }
  .col-expected .title { color: var(--text-dim); font-style: italic; }

  .model-col {
    border-left: 1px solid var(--border);
    min-width: 200px;
  }

  .model-result { display: flex; flex-direction: column; gap: 2px; }

  .model-result .artist,
  .model-result .title {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }

  .model-result .field-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    flex-shrink: 0;
    width: 10px;
  }

  .model-result .field-value { font-size: 12px; line-height: 1.4; }

  .model-result .field-value.null-val {
    color: var(--red);
    opacity: 0.5;
    font-style: italic;
  }

  .score-pills { display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap; }

  .pill {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 4px;
    line-height: 1.4;
  }

  .pill.exact { letter-spacing: 0; }
  .pill.s-perfect { background: var(--green-dim); color: var(--green); }
  .pill.s-good    { background: var(--yellow-dim); color: var(--yellow); }
  .pill.s-poor    { background: var(--red-dim); color: var(--red); }
  .pill.s-zero    { background: rgba(255,255,255,0.04); color: var(--text-dim); opacity: 0.5; }

  /* ─── Mark Correct ─── */
  .mark-wrap { margin-top: 6px; min-height: 22px; }

  .mark-btn {
    all: unset;
    cursor: pointer;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid var(--border);
    color: var(--text-dim);
    transition: all 0.15s;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .mark-btn:hover { border-color: var(--green); color: var(--green); }

  .mark-btn.corrected {
    background: var(--green-dim);
    border-color: var(--green);
    color: var(--green);
  }

  .undo-hint {
    color: var(--text-dim);
    margin-left: 2px;
    font-size: 9px;
    opacity: 0.7;
  }

  /* Winner badge */
  .winner-badge {
    display: inline-block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--green-dim);
    color: var(--green);
    margin-left: 8px;
    vertical-align: middle;
  }

  /* Legend */
  .legend { display: flex; gap: 20px; margin-top: 16px; margin-bottom: 24px; flex-wrap: wrap; }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: var(--text-dim);
  }

  .legend-swatch { width: 12px; height: 12px; border-radius: 3px; }
  .legend-swatch.perfect { background: var(--green-dim); border: 1px solid var(--green); }
  .legend-swatch.good    { background: var(--yellow-dim); border: 1px solid var(--yellow); }
  .legend-swatch.poor    { background: var(--red-dim); border: 1px solid var(--red); }
  .legend-swatch.zero    { background: rgba(255,255,255,0.04); border: 1px solid var(--text-dim); opacity: 0.5; }

  @media (max-width: 900px) {
    .summary-grid { grid-template-columns: 1fr; }
    .container { padding: 24px 16px 48px; }
    header h1 { font-size: 28px; }
    header { flex-direction: column; gap: 16px; }
    .save-btn { margin-left: 0; }
  }

  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
</head>
<body>
<div class="noise"></div>
<div class="container">

<header>
  <div>
    <div class="label">Vinyl OCR Model Evaluation</div>
    <h1>Mistral Model Comparison</h1>
    <div class="meta">${report.timestamp.replace(/\.\d{3}Z$/, "Z")} &middot; ${report.caseCount} test cases &middot; artist + title extraction</div>
  </div>
  <button class="save-btn" id="save-btn" onclick="saveJson()">Save JSON</button>
</header>

<div class="section-title">Overall Scores</div>
<div class="summary-grid" id="summary"></div>

<div class="section-title">Per-Case Results</div>
<div class="legend">
  <div class="legend-item"><div class="legend-swatch perfect"></div> Exact / &ge;0.8 fuzzy</div>
  <div class="legend-item"><div class="legend-swatch good"></div> &ge;0.5 fuzzy</div>
  <div class="legend-item"><div class="legend-swatch poor"></div> &gt;0 fuzzy</div>
  <div class="legend-item"><div class="legend-swatch zero"></div> 0 / null</div>
</div>
<div class="table-wrap">
  <table id="detail-table"></table>
</div>

</div>

<script>
var PALETTE = ${JSON.stringify(MODEL_PALETTE)};
var DATA = ${JSON.stringify(reportForEmbed)};
var models = DATA.models;

// ─── Capture original scores before any mutation ───
var ORIG_SCORES = {};
for (var _m = 0; _m < models.length; _m++) {
  var _model = models[_m];
  ORIG_SCORES[_model] = DATA.results[_model].details.map(function(d) {
    return { artistExact: d.scores.artistExact, titleExact: d.scores.titleExact, artistFuzzy: d.scores.artistFuzzy, titleFuzzy: d.scores.titleFuzzy };
  });
}

// ─── Corrections (persisted in localStorage) ───
var STORAGE_KEY = 'eval-corrections-' + DATA.timestamp;
var corrections = {};
try { corrections = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch(e) {}

// Apply any saved corrections before first render
for (var _key in corrections) {
  var _parts = _key.split('_');
  var _mi = parseInt(_parts[0], 10), _ci = parseInt(_parts[1], 10);
  if (models[_mi] && DATA.results[models[_mi]].details[_ci]) {
    DATA.results[models[_mi]].details[_ci].scores = { artistExact: 1, titleExact: 1, artistFuzzy: 1, titleFuzzy: 1 };
  }
}
for (var _mii = 0; _mii < models.length; _mii++) recalcSummary(_mii);

// ─── Helpers ───
function modelColor(i) { return PALETTE[i % PALETTE.length]; }
function pct(v) { return (v * 100).toFixed(1) + '%'; }
function scoreClass(v) {
  return v >= 0.8 ? 's-perfect' : v >= 0.5 ? 's-good' : v > 0 ? 's-poor' : 's-zero';
}
function shortName(m) { return m.replace('mistral-', ''); }
function esc(s) {
  if (s == null) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function isPerfect(scores) {
  return scores.artistExact === 1 && scores.titleExact === 1 && scores.artistFuzzy === 1 && scores.titleFuzzy === 1;
}

function recalcSummary(mi) {
  var m = models[mi];
  var details = DATA.results[m].details;
  var n = details.length;
  var ae = 0, te = 0, af = 0, tf = 0;
  for (var i = 0; i < n; i++) {
    ae += details[i].scores.artistExact;
    te += details[i].scores.titleExact;
    af += details[i].scores.artistFuzzy;
    tf += details[i].scores.titleFuzzy;
  }
  ae /= n; te /= n; af /= n; tf /= n;
  DATA.results[m].summary = { artistExact: ae, titleExact: te, artistFuzzy: af, titleFuzzy: tf, overall: (ae + te + af + tf) / 4 };
}

// ─── Mark / Undo ───
function markCorrect(mi, ci) {
  var key = mi + '_' + ci;
  corrections[key] = true;
  DATA.results[models[mi]].details[ci].scores = { artistExact: 1, titleExact: 1, artistFuzzy: 1, titleFuzzy: 1 };
  recalcSummary(mi);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(corrections));
  renderPills(mi, ci);
  renderMarkBtn(mi, ci);
  updateSummaryCard(mi);
  updateSaveBtn();
}

function undoCorrect(mi, ci) {
  var key = mi + '_' + ci;
  delete corrections[key];
  var orig = ORIG_SCORES[models[mi]][ci];
  DATA.results[models[mi]].details[ci].scores = { artistExact: orig.artistExact, titleExact: orig.titleExact, artistFuzzy: orig.artistFuzzy, titleFuzzy: orig.titleFuzzy };
  recalcSummary(mi);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(corrections));
  renderPills(mi, ci);
  renderMarkBtn(mi, ci);
  updateSummaryCard(mi);
  updateSaveBtn();
}

// ─── DOM Update Helpers ───
function renderPills(mi, ci) {
  var el = document.getElementById('pills-' + mi + '-' + ci);
  if (!el) return;
  var s = DATA.results[models[mi]].details[ci].scores;
  el.innerHTML =
    '<span class="pill exact ' + scoreClass(s.artistExact) + '" title="Artist exact">A:' + (s.artistExact ? '&#10003;' : '&#10007;') + '</span>' +
    '<span class="pill exact ' + scoreClass(s.titleExact) + '" title="Title exact">T:' + (s.titleExact ? '&#10003;' : '&#10007;') + '</span>' +
    '<span class="pill ' + scoreClass(s.artistFuzzy) + '" title="Artist fuzzy: ' + pct(s.artistFuzzy) + '">' + pct(s.artistFuzzy) + '</span>' +
    '<span class="pill ' + scoreClass(s.titleFuzzy) + '" title="Title fuzzy: ' + pct(s.titleFuzzy) + '">' + pct(s.titleFuzzy) + '</span>';
}

function renderMarkBtn(mi, ci) {
  var el = document.getElementById('markwrap-' + mi + '-' + ci);
  if (!el) return;
  var key = mi + '_' + ci;
  var isCorrected = !!corrections[key];
  var origPerfect = isPerfect(ORIG_SCORES[models[mi]][ci]);
  if (origPerfect && !isCorrected) { el.innerHTML = ''; return; }
  if (isCorrected) {
    el.innerHTML = '<button class="mark-btn corrected" onclick="undoCorrect(' + mi + ',' + ci + ')">' +
      '&#10003; corrected <span class="undo-hint">&#8629; undo</span></button>';
  } else {
    el.innerHTML = '<button class="mark-btn" onclick="markCorrect(' + mi + ',' + ci + ')">Mark &#10003;</button>';
  }
}

function updateSummaryCard(mi) {
  var s = DATA.results[models[mi]].summary;
  var keys = ['ae', 'te', 'af', 'tf'];
  var vals = [s.artistExact, s.titleExact, s.artistFuzzy, s.titleFuzzy];

  var overallEl = document.getElementById('overall-' + mi);
  if (overallEl) overallEl.textContent = pct(s.overall);

  for (var i = 0; i < 4; i++) {
    var ve = document.getElementById('val-' + keys[i] + '-' + mi);
    var be = document.getElementById('bar-' + keys[i] + '-' + mi);
    if (ve) ve.textContent = pct(vals[i]);
    if (be) be.style.width = (vals[i] * 100) + '%';
  }

  // Update winner badges across all cards
  var best = -Infinity;
  for (var mii = 0; mii < models.length; mii++) {
    if (DATA.results[models[mii]].summary.overall > best) best = DATA.results[models[mii]].summary.overall;
  }
  for (var mji = 0; mji < models.length; mji++) {
    var badge = document.getElementById('badge-' + mji);
    if (badge) badge.style.display = DATA.results[models[mji]].summary.overall === best ? '' : 'none';
  }
}

function updateSaveBtn() {
  var btn = document.getElementById('save-btn');
  if (!btn) return;
  var count = Object.keys(corrections).length;
  btn.textContent = count ? 'Save JSON (' + count + ')' : 'Save JSON';
  btn.className = count ? 'save-btn has-changes' : 'save-btn';
}

// ─── Save JSON ───
async function saveJson() {
  var btn = document.getElementById('save-btn');
  var json = JSON.stringify(DATA, null, 2);
  var blob = new Blob([json], { type: 'application/json' });
  var filename = DATA.timestamp.replace(/[:.]/g, '-') + '.json';

  function setLabel(label) { if (btn) btn.textContent = label; }
  function restoreLabel() { updateSaveBtn(); }

  if (window.showSaveFilePicker) {
    try {
      var handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'JSON file', accept: { 'application/json': ['.json'] } }]
      });
      var writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      setLabel('Saved &#10003;');
      setTimeout(restoreLabel, 2000);
    } catch(e) {
      if (e.name !== 'AbortError') {
        triggerDownload(blob, filename);
        setLabel('Downloaded &#10003;');
        setTimeout(restoreLabel, 2000);
      }
    }
  } else {
    triggerDownload(blob, filename);
    setLabel('Downloaded &#10003;');
    setTimeout(restoreLabel, 2000);
  }
}

function triggerDownload(blob, filename) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

// ─── Summary Cards ───
var summaryEl = document.getElementById('summary');
var _bestOverall = -Infinity;
for (var _bmi = 0; _bmi < models.length; _bmi++) {
  if (DATA.results[models[_bmi]].summary.overall > _bestOverall) _bestOverall = DATA.results[models[_bmi]].summary.overall;
}

models.forEach(function(m, i) {
  var s = DATA.results[m].summary;
  var color = modelColor(i);
  var isBest = s.overall === _bestOverall;
  var card = document.createElement('div');
  card.className = 'model-card';
  card.style.animationDelay = (0.05 + i * 0.07) + 's';
  card.innerHTML =
    '<div class="model-card-accent" style="background:' + color + '"></div>' +
    '<div class="model-name" style="color:' + color + '">' + esc(shortName(m)) +
      '<span class="winner-badge" id="badge-' + i + '" style="display:' + (isBest ? '' : 'none') + '">best</span>' +
    '</div>' +
    '<div class="overall-label">Overall</div>' +
    '<div class="overall-score" id="overall-' + i + '">' + pct(s.overall) + '</div>' +
    statRow('Artist exact', 'ae', i, s.artistExact, color) +
    statRow('Title exact',  'te', i, s.titleExact,  color) +
    statRow('Artist fuzzy', 'af', i, s.artistFuzzy, color) +
    statRow('Title fuzzy',  'tf', i, s.titleFuzzy,  color);
  summaryEl.appendChild(card);
});

function statRow(label, key, mi, val, color) {
  return '<div class="stat-row">' +
    '<span class="stat-label">' + label + '</span>' +
    '<div class="bar-track"><div class="bar-fill" id="bar-' + key + '-' + mi + '" style="background:' + color + ';width:' + (val * 100) + '%"></div></div>' +
    '<span class="stat-value" id="val-' + key + '-' + mi + '">' + pct(val) + '</span>' +
    '</div>';
}

// Initialize save button state
updateSaveBtn();

// ─── Detail Table ───
var table = document.getElementById('detail-table');

var modelHeaders = models.map(function(m, i) {
  return '<th class="group-header" style="color:' + modelColor(i) + '">' + esc(shortName(m)) + '</th>';
}).join('');

table.innerHTML =
  '<thead><tr>' +
  '<th style="width:140px">#</th>' +
  '<th style="width:200px">Expected</th>' +
  modelHeaders +
  '</tr></thead><tbody></tbody>';

var tbody = table.querySelector('tbody');
var cases = DATA.results[models[0]].details;

cases.forEach(function(c, ci) {
  var row = document.createElement('tr');
  var modelCells = '';

  models.forEach(function(m, mi) {
    var d = DATA.results[m].details[ci];
    var s = d.scores;
    var key = mi + '_' + ci;
    var isCorrected = !!corrections[key];
    var origPerfect = isPerfect(ORIG_SCORES[m][ci]);

    var artistVal = d.actual.artist === null
      ? '<span class="field-value null-val">null</span>'
      : '<span class="field-value">' + esc(d.actual.artist) + '</span>';
    var titleVal = d.actual.title === null
      ? '<span class="field-value null-val">null</span>'
      : '<span class="field-value">' + esc(d.actual.title) + '</span>';

    var markBtnHtml = '';
    if (!origPerfect || isCorrected) {
      markBtnHtml = isCorrected
        ? '<button class="mark-btn corrected" onclick="undoCorrect(' + mi + ',' + ci + ')">&#10003; corrected <span class="undo-hint">&#8629; undo</span></button>'
        : '<button class="mark-btn" onclick="markCorrect(' + mi + ',' + ci + ')">Mark &#10003;</button>';
    }

    modelCells +=
      '<td class="model-col">' +
        '<div class="model-result">' +
          '<div class="artist"><span class="field-label">A</span>' + artistVal + '</div>' +
          '<div class="title"><span class="field-label">T</span>' + titleVal + '</div>' +
          '<div class="score-pills" id="pills-' + mi + '-' + ci + '">' +
            '<span class="pill exact ' + scoreClass(s.artistExact) + '" title="Artist exact">A:' + (s.artistExact ? '&#10003;' : '&#10007;') + '</span>' +
            '<span class="pill exact ' + scoreClass(s.titleExact) + '" title="Title exact">T:' + (s.titleExact ? '&#10003;' : '&#10007;') + '</span>' +
            '<span class="pill ' + scoreClass(s.artistFuzzy) + '" title="Artist fuzzy: ' + pct(s.artistFuzzy) + '">' + pct(s.artistFuzzy) + '</span>' +
            '<span class="pill ' + scoreClass(s.titleFuzzy) + '" title="Title fuzzy: ' + pct(s.titleFuzzy) + '">' + pct(s.titleFuzzy) + '</span>' +
          '</div>' +
          '<div class="mark-wrap" id="markwrap-' + mi + '-' + ci + '">' + markBtnHtml + '</div>' +
        '</div>' +
      '</td>';
  });

  row.innerHTML =
    '<td class="col-id">' + (ci + 1) + '. ' + esc(c.id) + '</td>' +
    '<td class="col-expected">' +
      '<div class="artist">' + esc(c.expected.artist) + '</div>' +
      '<div class="title">' + esc(c.expected.title) + '</div>' +
    '</td>' +
    modelCells;

  tbody.appendChild(row);
});
</script>
</body>
</html>`;
}
