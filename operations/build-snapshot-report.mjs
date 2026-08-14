// Renders the hourly live_snapshots observation data as a browsable HTML
// report: stacked hourly histograms (stream age, NSFW), directory-vs-HLS
// verification, tag distribution, and a per-instance persistence table.
// Pure read + presentation — no writes, no relay calls.
//
// Usage: node operations/build-snapshot-report.mjs [--out <path>] [--no-open]
//   DATABASE_URL overrides the default local docker Postgres (port 5544,
//   the local compose stack).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from './lib/arg-parser.mjs';

import pg from 'pg';

const { flags } = parseArgs(process.argv.slice(2), {
  booleans: ['--no-open'],
  defaults: {
    '--out': path.join(os.tmpdir(), 'livelier', 'live-snapshots-report.html'),
  },
});

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://bridges:bridges@localhost:5544/bridges';
const OUT = path.resolve(String(flags['--out']));

// House palette pill colours.
const AGE_BUCKETS = [
  { key: 'lt1h', label: '< 1 h', color: '#c81e1e', max: 1 },
  { key: 'h1to6', label: '1–6 h', color: '#e8a33d', max: 6 },
  { key: 'h6to24', label: '6–24 h', color: '#1a56db', max: 24 },
  { key: 'd1to7', label: '1–7 d', color: '#7ba7f7', max: 168 },
  { key: 'gt7d', label: '> 7 d', color: '#d3ddf0', max: Infinity },
];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ageBucket(hours) {
  return AGE_BUCKETS.find((b) => hours < b.max) ?? AGE_BUCKETS[AGE_BUCKETS.length - 1];
}

function hourLabel(date) {
  return `${String(date.getHours()).padStart(2, '0')}:00`;
}

function dayLabel(date) {
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

async function loadSnapshots() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    const { rows } = await pool.query(
      `SELECT id, captured_at, directory_live_count, bridged_live_count,
              hls_live, hls_ended, hls_error, schema_version, raw
         FROM live_snapshots ORDER BY captured_at`
    );
    return rows;
  } finally {
    await pool.end();
  }
}

/** Per-snapshot derived numbers + per-instance accumulation across the window. */
function analyse(snapshots) {
  const instances = new Map(); // url -> { name, tags, nsfw, present, maxAgeH, lastSeenIdx }
  const hours = snapshots.map((snap, idx) => {
    const at = new Date(snap.captured_at);
    const byAge = Object.fromEntries(AGE_BUCKETS.map((b) => [b.key, 0]));
    let nsfw = 0;
    for (const item of snap.raw) {
      const started = item.streamingSince ? new Date(item.streamingSince) : null;
      const ageH = started ? Math.max(0, (at - started) / 3_600_000) : Infinity;
      byAge[ageBucket(ageH).key] += 1;
      if (item.nsfw) nsfw += 1;

      const rec = instances.get(item.url) ?? {
        url: item.url,
        name: item.name || item.url,
        tags: new Set(),
        nsfw: false,
        present: 0,
        maxAgeH: 0,
        firstIdx: idx,
        lastIdx: idx,
      };
      rec.present += 1;
      rec.lastIdx = idx;
      rec.nsfw = rec.nsfw || Boolean(item.nsfw);
      rec.maxAgeH = Math.max(rec.maxAgeH, Number.isFinite(ageH) ? ageH : 0);
      for (const t of item.tags ?? []) if (t?.slug) rec.tags.add(t.slug);
      instances.set(item.url, rec);
    }
    return {
      at,
      total: snap.raw.length,
      byAge,
      nsfw,
      sfw: snap.raw.length - nsfw,
      directory: snap.directory_live_count,
      bridged: snap.bridged_live_count,
      hlsLive: snap.hls_live,
      hlsEnded: snap.hls_ended,
      hlsError: snap.hls_error,
      newUrls: [],
    };
  });

  // New arrivals: first appearance after the baseline snapshot.
  for (const rec of instances.values()) {
    if (rec.firstIdx > 0) hours[rec.firstIdx].newUrls.push(rec.url);
  }

  // Mean concurrent count per tag across the window.
  const tagHours = new Map();
  for (const snap of snapshots) {
    for (const item of snap.raw) {
      for (const t of item.tags ?? []) {
        if (t?.slug) tagHours.set(t.slug, (tagHours.get(t.slug) ?? 0) + 1);
      }
    }
  }
  const topTags = [...tagHours.entries()]
    .map(([slug, n]) => ({ slug, mean: n / snapshots.length }))
    .sort((a, b) => b.mean - a.mean)
    .slice(0, 16);

  return { hours, instances: [...instances.values()], topTags };
}

/** One stacked column chart: rows of {at, segments:[{label,color,value}], total}. */
function stackedChart(bins, maxTotal, footnote) {
  const cols = bins
    .map((bin, idx) => {
      const segs = bin.segments
        .filter((s) => s.value > 0)
        .map(
          (s) =>
            `<div class="seg" data-series="${esc(s.key ?? s.label)}" data-value="${s.value}" style="height:${(s.value / maxTotal) * 100}%;background:${s.color}" title="${esc(
              `${hourLabel(bin.at)} — ${s.label}: ${s.value}`
            )}"></div>`
        )
        .join('');
      const newDay = idx === 0 || bin.at.getDate() !== bins[idx - 1].at.getDate();
      return `<div class="col" title="${esc(`${dayLabel(bin.at)} ${hourLabel(bin.at)} — total ${bin.total}`)}">
        <div class="colTotal">${bin.total}</div>
        <div class="colBars">${segs}</div>
        <div class="colLabel">${hourLabel(bin.at)}${newDay ? `<span class="day">${dayLabel(bin.at)}</span>` : ''}</div>
      </div>`;
    })
    .join('');
  return `<div class="chart">${cols}</div>${footnote ? `<div class="footnote">${footnote}</div>` : ''}`;
}

function legend(entries) {
  return `<div class="legend">${entries
    .map(
      (e) =>
        `<span data-series="${esc(e.key ?? e.label)}" title="click to toggle this series"><i style="background:${e.color}"></i>${esc(e.label)}</span>`
    )
    .join('')}</div>`;
}

function buildHtml({ hours, instances, topTags }) {
  const maxTotal = Math.max(...hours.map((h) => h.total)) + 2;
  const first = hours[0].at;
  const last = hours[hours.length - 1].at;
  const windowH = Math.round((last - first) / 3_600_000);
  const meanLive = Math.round(hours.reduce((a, h) => a + h.total, 0) / hours.length);
  const peak = Math.max(...hours.map((h) => h.total));
  const alwaysOn = instances.filter((i) => i.present === hours.length).length;
  const arrivals = hours.reduce((a, h) => a + h.newUrls.length, 0);
  const meanNsfw = (hours.reduce((a, h) => a + h.nsfw, 0) / hours.length).toFixed(1);

  const ageBins = hours.map((h) => ({
    at: h.at,
    total: h.total,
    segments: AGE_BUCKETS.map((b) => ({ key: b.key, label: b.label, color: b.color, value: h.byAge[b.key] })),
  }));
  const nsfwBins = hours.map((h) => ({
    at: h.at,
    total: h.total,
    segments: [
      { key: 'sfw', label: 'SFW', color: '#9fb6d9', value: h.sfw },
      { key: 'nsfw', label: 'NSFW (bridged with NIP-36 content-warning)', color: '#7e3af2', value: h.nsfw },
    ],
  }));
  const verifyBins = hours.map((h) => ({
    at: h.at,
    total: h.hlsLive,
    segments: [
      { key: 'hls-live', label: 'HLS-verified live', color: '#046c4e', value: h.hlsLive - h.hlsEnded - h.hlsError },
      { key: 'hls-ended', label: 'HLS says ended (offline slate / gone)', color: '#e8a33d', value: h.hlsEnded },
      { key: 'hls-error', label: 'HLS probe error', color: '#c81e1e', value: h.hlsError },
    ],
  }));
  const churnBins = hours.map((h) => ({
    at: h.at,
    total: h.newUrls.length,
    segments: [{ label: 'instances first seen this hour', color: '#1a56db', value: h.newUrls.length }],
  }));
  const maxChurn = Math.max(1, ...churnBins.map((b) => b.total));

  const maxTagMean = Math.max(...topTags.map((t) => t.mean));
  const tagRows = topTags
    .map(
      (t) => `<div class="tagRow">
        <div class="tagName">${esc(t.slug)}</div>
        <div class="tagBarWrap"><div class="tagBar" style="width:${(t.mean / maxTagMean) * 100}%"></div></div>
        <div class="tagVal">${t.mean.toFixed(1)}</div>
      </div>`
    )
    .join('');

  const tableRows = instances
    .sort((a, b) => b.present - a.present || a.name.localeCompare(b.name))
    .map((i) => {
      const pct = Math.round((i.present / hours.length) * 100);
      const liveNow = i.lastIdx === hours.length - 1;
      return `<tr>
        <td><a href="${esc(i.url)}" target="_blank">${esc(i.name)}</a></td>
        <td class="num" data-sort="${i.present}">${i.present}/${hours.length} <span class="muted">(${pct}%)</span></td>
        <td class="num" data-sort="${i.maxAgeH.toFixed(1)}">${
          i.maxAgeH >= 48 ? `${(i.maxAgeH / 24).toFixed(1)} d` : `${i.maxAgeH.toFixed(1)} h`
        }</td>
        <td data-sort="${liveNow ? 1 : 0}">${
          liveNow ? '<span class="pill pill-live">live</span>' : '<span class="pill pill-gone">gone</span>'
        }</td>
        <td data-sort="${i.nsfw ? 1 : 0}">${i.nsfw ? '<span class="pill pill-nsfw">nsfw</span>' : ''}</td>
        <td class="small">${[...i.tags].slice(0, 8).map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')}</td>
      </tr>`;
    })
    .join('\n');

  return `<!doctype html><html><head><meta charset="utf-8">
<title>Owncast bridge — hourly live snapshots</title>
<style>
  body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:24px;color:#111;background:#fff}
  h1{font-size:20px;margin:0 0 4px}
  h2{font-size:15px;margin:28px 0 2px}
  .meta{color:#555;margin-bottom:16px}
  .cards{display:flex;gap:12px;margin:14px 0;flex-wrap:wrap}
  .card{border:1px solid #e5e5e5;border-radius:8px;padding:10px 16px;background:#fafafa;min-width:110px}
  .card .big{font-size:26px;font-weight:600;line-height:1.1}
  .card div:last-child{color:#666;font-size:12px}
  .chart{display:flex;align-items:flex-end;gap:6px;height:240px;margin:10px 0 40px;border-bottom:1px solid #ddd;padding-bottom:2px}
  .col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%;min-width:0}
  .colBars{display:flex;flex-direction:column-reverse;flex:0 0 auto;height:100%;justify-content:flex-start}
  .col{position:relative}
  .colTotal{font-size:10px;color:#888;text-align:center}
  .seg{width:100%}
  .seg:hover{filter:brightness(.85)}
  .colLabel{position:absolute;top:100%;left:0;right:0;text-align:center;font-size:10px;color:#666;padding-top:3px;white-space:nowrap}
  .colLabel .day{display:block;font-weight:600;color:#111}
  .chartWrap{margin-bottom:24px}
  .legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:#444;margin:6px 0}
  .legend i{display:inline-block;width:11px;height:11px;border-radius:2px;margin-right:5px;vertical-align:-1px}
  .legend [data-series]{cursor:pointer;user-select:none}
  .legend [data-series]:hover{color:#111}
  .legend [data-series].off{opacity:.4;text-decoration:line-through}
  .footnote{font-size:12px;color:#777;margin-top:2px}
  .tagRow{display:flex;align-items:center;gap:10px;margin:3px 0;max-width:640px}
  .tagName{width:150px;text-align:right;font-size:12px;color:#333}
  .tagBarWrap{flex:1;background:#f2f4f8;border-radius:3px}
  .tagBar{height:14px;background:#1a56db;border-radius:3px;min-width:2px}
  .tagVal{width:44px;font-size:12px;color:#555}
  .scroll{overflow-x:auto;margin-top:12px}
  table{border-collapse:collapse;width:100%}
  th,td{padding:7px 8px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
  th{position:sticky;top:0;background:#fafafa;border-bottom:2px solid #ddd;font-size:12px;text-transform:uppercase;letter-spacing:.03em;color:#555;cursor:pointer;user-select:none}
  th:hover{background:#f0f2f5;color:#111}
  tr:hover{background:#fcfcff}
  .num{text-align:right;color:#333}
  .small{font-size:12px}
  .muted{color:#999}
  a{color:#1a56db;text-decoration:none}
  a:hover{text-decoration:underline}
  .pill{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600}
  .pill-live{background:#e6f6ec;color:#046c4e}
  .pill-gone{background:#f0f0f0;color:#888}
  .pill-nsfw{background:#f3ebff;color:#7e3af2}
  .tag{display:inline-block;background:#eef1f5;color:#4b5563;border-radius:3px;padding:0 5px;font-size:10px;letter-spacing:.02em}
</style></head><body>
<h1>Owncast bridge — hourly live snapshots</h1>
<div class="meta">${hours.length} snapshots, ${esc(dayLabel(first))} ${hourLabel(first)} → ${esc(dayLabel(last))} ${hourLabel(last)} local (~${windowH} h) · source: <code>live_snapshots</code> in the local bridge Postgres · generated ${esc(new Date().toISOString())}</div>

<div class="cards">
  <div class="card"><div class="big">${meanLive}</div><div>mean live / hour</div></div>
  <div class="card"><div class="big">${peak}</div><div>peak live</div></div>
  <div class="card"><div class="big">${instances.length}</div><div>distinct instances seen</div></div>
  <div class="card"><div class="big">${alwaysOn}</div><div>present in every snapshot</div></div>
  <div class="card"><div class="big">${arrivals}</div><div>new arrivals after baseline</div></div>
  <div class="card"><div class="big">${meanNsfw}</div><div>mean NSFW / hour</div></div>
</div>

<div class="chartWrap">
<h2>Live streams per hour, by time-already-streaming</h2>
${legend(AGE_BUCKETS)}
${stackedChart(ageBins, maxTotal, 'Age = snapshot time minus the instance’s reported <code>streamingSince</code>. The dominant pale band is the always-on tail (24/7 cams, radio loops); the red/amber base is real short-form live sessions.')}
</div>

<div class="chartWrap">
<h2>NSFW mix per hour</h2>
${legend([
    { key: 'sfw', label: 'SFW', color: '#9fb6d9' },
    { key: 'nsfw', label: 'NSFW', color: '#7e3af2' },
  ])}
${stackedChart(nsfwBins, maxTotal, 'Since the NIP-36 change, NSFW streams are bridged and tagged with a content-warning rather than dropped — the first snapshot predates that change (directory 61 vs bridged 52).')}
</div>

<div class="chartWrap">
<h2>HLS liveness verification per hour</h2>
${legend([
    { key: 'hls-live', label: 'HLS-verified live', color: '#046c4e' },
    { key: 'hls-ended', label: 'HLS says ended', color: '#e8a33d' },
    { key: 'hls-error', label: 'probe error', color: '#c81e1e' },
  ])}
${stackedChart(verifyBins, maxTotal, 'The poller independently probes each instance’s HLS playlist (Owncast-aware: an offline slate behind a master playlist counts as ended). Green tracking the directory count means the directory is a trustworthy liveness source.')}
</div>

<div class="chartWrap">
<h2>Churn: instances first seen, per hour</h2>
${stackedChart(churnBins, maxChurn + 1, 'First-ever appearance within the observation window (baseline hour excluded — everything is “new” there).')}
</div>

<h2>Most common tags (mean concurrent streams carrying the tag)</h2>
${tagRows}

<h2>Instances (${instances.length})</h2>
<div class="scroll">
<table id="inst">
<thead><tr>
  <th data-dir="asc">instance</th><th data-dir="desc">snapshots present</th>
  <th data-dir="desc">longest observed session</th><th data-dir="desc">now</th>
  <th data-dir="desc">nsfw</th><th data-dir="asc">tags</th>
</tr></thead>
<tbody>
${tableRows}
</tbody></table>
</div>

<script>
// Click a legend entry to toggle its series off/on. Remaining segments are
// rescaled to the visible max (matching the server-side "+2 headroom" scale),
// and each column's total updates to the visible sum.
(function () {
  document.querySelectorAll('.chartWrap').forEach(function (wrap) {
    var legend = wrap.querySelector('.legend');
    var chart = wrap.querySelector('.chart');
    if (!legend || !chart) return;
    var cols = [].slice.call(chart.querySelectorAll('.col'));
    legend.querySelectorAll('[data-series]').forEach(function (entry) {
      entry.addEventListener('click', function () {
        entry.classList.toggle('off');
        var off = {};
        legend.querySelectorAll('[data-series].off').forEach(function (e) {
          off[e.dataset.series] = true;
        });
        var sums = cols.map(function (col) {
          var sum = 0;
          col.querySelectorAll('.seg').forEach(function (seg) {
            if (!off[seg.dataset.series]) sum += Number(seg.dataset.value);
          });
          return sum;
        });
        var scale = Math.max.apply(null, sums.concat(1)) + 2;
        cols.forEach(function (col, i) {
          col.querySelectorAll('.seg').forEach(function (seg) {
            var hidden = off[seg.dataset.series];
            seg.style.display = hidden ? 'none' : '';
            if (!hidden) seg.style.height = (Number(seg.dataset.value) / scale) * 100 + '%';
          });
          var total = col.querySelector('.colTotal');
          if (total) total.textContent = sums[i];
        });
      });
    });
  });
})();

// Click a header to sort; data-sort attr wins over cell text .
(function () {
  var table = document.getElementById('inst');
  var tbody = table.tBodies[0];
  var headers = [].slice.call(table.tHead.rows[0].cells);
  function valueOf(row, i) {
    var raw = row.cells[i].getAttribute('data-sort');
    if (raw == null) raw = row.cells[i].textContent.trim();
    var num = parseFloat(raw);
    return raw !== '' && !isNaN(num) && /^-?[0-9.]+/.test(raw) ? num : raw.toLowerCase();
  }
  headers.forEach(function (th, i) {
    th.addEventListener('click', function () {
      var dir = th.dataset.active === 'asc' ? 'desc' : th.dataset.active === 'desc' ? 'asc' : th.dataset.dir;
      headers.forEach(function (h) { delete h.dataset.active; });
      th.dataset.active = dir;
      var rows = [].slice.call(tbody.rows);
      rows.sort(function (a, b) {
        var va = valueOf(a, i), vb = valueOf(b, i);
        if (va < vb) return dir === 'asc' ? -1 : 1;
        if (va > vb) return dir === 'asc' ? 1 : -1;
        return 0;
      });
      rows.forEach(function (r) { tbody.appendChild(r); });
    });
  });
})();
</script>
</body></html>`;
}

const snapshots = await loadSnapshots();
if (!snapshots.length) {
  console.error('No rows in live_snapshots — nothing to report.');
  process.exit(1);
}
const html = buildHtml(analyse(snapshots));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.error(`Report: ${OUT} (${snapshots.length} snapshots)`);
if (!flags['--no-open']) {
  spawn('open', [OUT], { stdio: 'ignore', detached: true }).unref();
}
