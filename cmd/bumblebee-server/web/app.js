/* ── state ─────────────────────────────────────────────────────────── */
let fleet = [];
let staleAfterHours = 96; // default 2×48h; synced from server on load
const $ = id => document.getElementById(id);

/* ── helpers ────────────────────────────────────────────────────────── */
function timeAgo(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function sevBadges(counts) {
  if (!counts) return '';
  return ['critical','high','medium','low','unknown']
    .filter(s => counts[s] > 0)
    .map(s => `<span class="badge ${s}">${s}: ${counts[s]}</span>`)
    .join('');
}

function lightLabel(l) {
  return {red:'🔴 Findings detected', yellow:'🟡 Low/medium findings', green:'🟢 Clean', gray:'⚪ No recent report'}[l] || l;
}

function sortedFleet(list) {
  const order = {red:0, yellow:1, gray:2, green:3};
  return [...list].sort((a,b) =>
    (order[a.light]??9)-(order[b.light]??9) ||
    (a.endpoint?.hostname||'').localeCompare(b.endpoint?.hostname||''));
}

const SEV_ORDER = {critical:0, high:1, medium:2, low:3, unknown:4};
const SEV_COLOR = {
  critical:'#e5484d', high:'#e5484d',
  medium:'#e8b339',   low:'#e8b339',
  unknown:'#8b9aa8'
};

/* ── tabs ───────────────────────────────────────────────────────────── */
document.querySelectorAll('.tab').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-section').forEach(s => s.classList.add('hidden'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.remove('hidden');
    if (btn.dataset.tab === 'install') renderInstall();
  };
});

/* ── fleet tab ──────────────────────────────────────────────────────── */
function renderStaleDropdown() {
  const options = [
    { label: '12 hours',  hours: 12   },
    { label: '24 hours',  hours: 24   },
    { label: '48 hours (2 days)',  hours: 48   },
    { label: '72 hours (3 days)',  hours: 72   },
    { label: '1 week',    hours: 168  },
    { label: '2 weeks',   hours: 336  },
    { label: '30 days',   hours: 720  },
    { label: 'Never',     hours: 87600 },
  ];
  const sel = $('stale-select');
  if (!sel) return;
  sel.innerHTML = options.map(o =>
    `<option value="${o.hours}" ${Math.round(staleAfterHours) === o.hours ? 'selected' : ''}>${o.label}</option>`
  ).join('');
}

async function onStaleChange(sel) {
  const hours = parseFloat(sel.value);
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stale_after_hours: hours })
    });
    staleAfterHours = hours;
    renderFleet(); // re-color cards immediately
  } catch(e) {
    alert('Failed to update: ' + e);
  }
}

async function deleteEndpoint(id, hostname) {
  if (!confirm(`Remove "${hostname}" from the fleet?\n\nThis deletes its history from the server. The agent on that machine keeps running until you uninstall it there.`)) return;
  try {
    await fetch(`/api/delete/${id}`, { method: 'DELETE' });
    fleet = fleet.filter(e => e.id !== id);
    renderFleet();
    renderReports();
  } catch(e) {
    alert('Delete failed: ' + e);
  }
}

function renderFleet() {
  const q = $('filter').value.trim().toLowerCase();
  const filtered = sortedFleet(fleet).filter(e =>
    !q || [e.endpoint?.hostname, e.endpoint?.username, e.endpoint?.os,
            e.endpoint?.arch, e.agent_version].join(' ').toLowerCase().includes(q));

  const counts = {red:0, yellow:0, green:0, gray:0};
  fleet.forEach(e => counts[e.light] = (counts[e.light]||0)+1);
  $('summary').innerHTML = `<b>${fleet.length}</b> endpoints &nbsp;·&nbsp;
    <span style="color:var(--red)">${counts.red||0} red</span> &nbsp;
    <span style="color:var(--yellow)">${counts.yellow||0} yellow</span> &nbsp;
    <span style="color:var(--green)">${counts.green||0} green</span> &nbsp;
    <span style="color:var(--gray)">${counts.gray||0} stale</span>`;

  if (!filtered.length) {
    $('grid').innerHTML = `<div class="empty">No endpoints yet.<br>Go to <b>Install Agent</b> tab for setup instructions.</div>`;
    return;
  }

  $('grid').innerHTML = filtered.map(e => `
    <div class="card ${e.light}" data-id="${e.id}">
      <div class="card-top">
        <div class="host">${e.endpoint?.hostname || '(unknown)'}</div>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="light ${e.light}"></div>
          <button class="del-btn" title="Remove from fleet"
            onclick="event.stopPropagation();deleteEndpoint('${e.id}','${(e.endpoint?.hostname||'?').replace(/'/g,"\\'")}')">🗑</button>
        </div>
      </div>
      <div class="meta">
        ${e.endpoint?.os||'?'} / ${e.endpoint?.arch||'?'} · ${e.endpoint?.username||'?'}<br>
        profile: ${e.profile||'?'} · packages: ${e.package_count??0}<br>
        last report: ${timeAgo(e.last_seen)} · status: ${e.last_status||'?'}
      </div>
      ${e.agent_version ? `<div class="agent-ver">bumblebee v${e.agent_version}</div>` : ''}
      <div>${sevBadges(e.severity_counts)}</div>
    </div>`).join('');

  $('grid').querySelectorAll('.card').forEach(c =>
    c.onclick = () => showDetail(c.dataset.id));
}

$('filter').addEventListener('input', renderFleet);

/* ── reports tab ────────────────────────────────────────────────────── */
function renderReports() {
  const q = $('filter-reports').value.trim().toLowerCase();
  const filtered = sortedFleet(fleet).filter(e =>
    !q || (e.endpoint?.hostname||'').toLowerCase().includes(q));

  if (!filtered.length) {
    $('reports-list').innerHTML = '<div class="empty">No endpoints have reported yet.</div>';
    return;
  }
  $('reports-list').innerHTML = filtered.map(e => `
    <div class="report-row">
      <div class="rlight ${e.light}"></div>
      <div class="rinfo">
        <div class="rhost">${e.endpoint?.hostname||'(unknown)'}
          ${e.agent_version ? `<span class="ver-chip">v${e.agent_version}</span>` : ''}
        </div>
        <div class="rmeta">
          ${e.endpoint?.os||'?'} / ${e.endpoint?.arch||'?'} · user: ${e.endpoint?.username||'?'} ·
          packages: ${e.package_count??0} · ${lightLabel(e.light)} · last report: ${timeAgo(e.last_seen)}
        </div>
      </div>
      <div class="ractions">
        <button class="btn btn-primary" onclick="downloadReport('${e.id}')">⬇ HTML Report</button>
        <button class="btn" onclick="showDetail('${e.id}')">View</button>
        <button class="btn btn-danger" onclick="deleteEndpoint('${e.id}','${(e.endpoint?.hostname||'?').replace(/'/g,"\\'")}')">🗑 Remove</button>
      </div>
    </div>`).join('');
}

$('filter-reports').addEventListener('input', renderReports);
$('downloadAll').onclick = () => fleet.forEach(e => setTimeout(() => downloadReport(e.id), 300));

/* ── report generation (full packages + findings) ───────────────────── */
async function downloadReport(id) {
  const e = fleet.find(x => x.id === id);
  if (!e) return;

  const btn = document.querySelector(`[onclick="downloadReport('${id}')"]`);
  if (btn) { btn.textContent = '⏳ Building…'; btn.disabled = true; }

  let packages = [];
  try {
    const res = await fetch(`/api/packages/${id}`);
    packages = await res.json();
  } catch(_) {}

  if (btn) { btn.textContent = '⬇ HTML Report'; btn.disabled = false; }

  const lightColor = {red:'#e5484d', yellow:'#e8b339', green:'#3fb950', gray:'#4b5b68'}[e.light]||'#4b5b68';
  const lightEmoji = {red:'🔴', yellow:'🟡', green:'🟢', gray:'⚪'}[e.light]||'⚪';

  const findings = [...(e.findings||[])].sort((a,b) =>
    (SEV_ORDER[a.severity]??5)-(SEV_ORDER[b.severity]??5));

  const findingRows = findings.map(f => {
    const col = SEV_COLOR[f.severity]||'#8b9aa8';
    return `<tr>
      <td><span style="color:${col};font-weight:700">${f.severity||'unknown'}</span></td>
      <td>${f.package_name||''}</td>
      <td>${f.version||''}</td>
      <td>${f.ecosystem||''}</td>
      <td>${f.catalog_name||f.catalog_id||''}</td>
      <td style="color:#8b9aa8;font-size:12px">${f.source_file||''}</td>
    </tr>`;
  }).join('');

  const pkgRows = packages.map(p => `<tr>
    <td>${p.ecosystem||''}</td>
    <td>${p.name||''}</td>
    <td>${p.version||''}</td>
    <td style="color:#8b9aa8;font-size:12px">${p.source_file||''}</td>
    <td style="color:#8b9aa8">${p.source_type||''}</td>
  </tr>`).join('');

  const sevSummary = Object.entries(e.severity_counts||{})
    .filter(([,v])=>v>0)
    .map(([k,v])=>`<span style="margin-right:18px"><b style="color:${SEV_COLOR[k]||'#8b9aa8'}">${v}</b> ${k}</span>`)
    .join('') || '<span style="color:#3fb950">none</span>';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>bumblebee report — ${e.endpoint?.hostname||'unknown'}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Raleway:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root { font-family:'Raleway',sans-serif; }
  body { background:#0b0f14; color:#e6edf3; margin:0; padding:40px; font-size:15px; }
  .header { display:flex; align-items:center; gap:22px; margin-bottom:36px;
    padding-bottom:24px; border-bottom:1px solid #25313d; }
  .light-big { width:56px; height:56px; border-radius:50%; flex:none;
    background:${lightColor}; box-shadow:0 0 32px ${lightColor}88; }
  h1 { font-size:28px; margin:0 0 5px; font-weight:800; }
  .sub { color:#8b9aa8; font-size:14px; line-height:1.7; }
  .stats { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr));
    gap:14px; margin-bottom:36px; }
  .stat { background:#131a22; border:1px solid #25313d; border-radius:12px; padding:18px 20px; }
  .stat-label { color:#8b9aa8; font-size:11px; text-transform:uppercase;
    letter-spacing:.08em; font-weight:600; }
  .stat-value { font-size:26px; font-weight:700; margin-top:6px; }
  h2 { font-size:17px; font-weight:700; color:#8b9aa8; text-transform:uppercase;
    letter-spacing:.06em; margin:36px 0 12px; padding-bottom:8px; border-bottom:1px solid #25313d; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th { text-align:left; padding:10px 12px; color:#8b9aa8; font-weight:600;
    font-size:12px; text-transform:uppercase; letter-spacing:.05em;
    background:#131a22; border-bottom:2px solid #25313d; }
  td { padding:10px 12px; border-bottom:1px solid #1a232d; }
  tr:hover td { background:#131a22; }
  .clean-box { background:#131a22; border:1px solid #25313d; border-radius:12px;
    padding:40px; text-align:center; color:#8b9aa8; font-size:16px; }
  .clean-box span { font-size:28px; display:block; margin-bottom:10px; }
  .footer { margin-top:48px; color:#4b5b68; font-size:12px;
    border-top:1px solid #25313d; padding-top:18px; }
  a { color:#58a6ff; }
  .count-chip { background:#1a232d; border:1px solid #25313d; border-radius:6px;
    padding:2px 10px; font-size:13px; color:#8b9aa8; margin-left:10px; }
</style>
</head>
<body>
<div class="header">
  <div class="light-big"></div>
  <div>
    <h1>${lightEmoji} ${e.endpoint?.hostname||'unknown'}</h1>
    <div class="sub">
      ${e.endpoint?.os||'?'} · ${e.endpoint?.arch||'?'} · user: ${e.endpoint?.username||'?'}
      ${e.agent_version ? ` · bumblebee v${e.agent_version}` : ''}<br>
      profile: ${e.profile||'?'} · last scan: ${e.last_seen ? new Date(e.last_seen).toLocaleString() : 'n/a'} · status: ${e.last_status||'?'}
    </div>
  </div>
</div>

<div class="stats">
  <div class="stat">
    <div class="stat-label">Status</div>
    <div class="stat-value" style="color:${lightColor}">${lightLabel(e.light)}</div>
  </div>
  <div class="stat">
    <div class="stat-label">Packages scanned</div>
    <div class="stat-value">${e.package_count??0}</div>
  </div>
  <div class="stat">
    <div class="stat-label">Findings</div>
    <div class="stat-value" style="color:${findings.length>0?lightColor:'#3fb950'}">${findings.length}</div>
  </div>
  <div class="stat">
    <div class="stat-label">Severity breakdown</div>
    <div style="margin-top:10px;font-size:14px">${sevSummary}</div>
  </div>
</div>

<h2>Findings <span class="count-chip">${findings.length}</span></h2>
${findings.length ? `
<table>
  <thead><tr>
    <th>Severity</th><th>Package</th><th>Version</th>
    <th>Ecosystem</th><th>Threat catalog</th><th>Source file</th>
  </tr></thead>
  <tbody>${findingRows}</tbody>
</table>` : `
<div class="clean-box">
  <span>✅</span>
  No findings on the latest completed scan — this endpoint is clean.
</div>`}

<h2>All packages <span class="count-chip">${packages.length}</span></h2>
${packages.length ? `
<table>
  <thead><tr>
    <th>Ecosystem</th><th>Package</th><th>Version</th><th>Source file</th><th>Type</th>
  </tr></thead>
  <tbody>${pkgRows}</tbody>
</table>` : `<div class="clean-box"><span>📦</span>No package data available — run a scan first.</div>`}

<div class="footer">
  Generated by <a href="https://github.com/perplexityai/bumblebee">🐝 bumblebee</a>
  on ${new Date().toLocaleString()} · Device: ${e.endpoint?.device_id||e.id}
</div>
</body></html>`;

  const blob = new Blob([html], {type:'text/html'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bumblebee-${(e.endpoint?.hostname||e.id).replace(/[^a-z0-9]/gi,'-')}-${new Date().toISOString().slice(0,10)}.html`;
  a.click();
}

/* ── install tab (macOS + Linux only) ───────────────────────────────── */
function renderInstall() {
  const host = location.hostname || 'YOUR-SERVER';
  const port = location.port || '8080';

  const code = text => `<div class="code-wrap">
    <pre>${text.trim()}</pre>
    <button class="copy-btn" onclick="copyCode(this)">Copy</button>
  </div>`;

  $('installPage').innerHTML = `
    <h1>Install bumblebee agent</h1>
    <p class="intro">
      The agent is the unmodified
      <a href="https://github.com/perplexityai/bumblebee" target="_blank">perplexityai/bumblebee @latest</a>
      — always downloaded directly from their official GitHub releases.
      The one-liner installs it, schedules scans every 6 hours, and runs the first one immediately.
    </p>

    <div class="os-block">
      <h2>🍎 macOS</h2>
      <div class="step">
        <p><strong>Install and enroll</strong> — paste into Terminal:</p>
        ${code(`curl -fsSL http://${host}:${port}/install.sh | bash`)}
      </div>
      <div class="step">
        <p><strong>What happens:</strong> downloads the correct arm64/amd64 binary from GitHub,
        installs to <code>~/.bumblebee/bin/</code>, creates a launchd LaunchAgent at
        <code>~/Library/LaunchAgents/com.bumblebee.scan.plist</code> that runs every 6 hours,
        then fires an immediate first scan so the host appears on the dashboard right away.</p>
      </div>
      <div class="step">
        <p><strong>Manual scan</strong> (run anytime between schedules):</p>
        ${code(`~/.bumblebee/bin/bumblebee scan --profile baseline --output http --http-url http://${host}:${port}/ingest --http-gzip --http-allow-insecure`)}
      </div>
      <div class="step">
        <p><strong>Uninstall:</strong></p>
        ${code(`curl -fsSL http://${host}:${port}/uninstall.sh | bash`)}
      </div>
    </div>

    <div class="os-block">
      <h2>🐧 Linux</h2>
      <div class="step">
        <p><strong>Install and enroll</strong> — paste into any shell:</p>
        ${code(`curl -fsSL http://${host}:${port}/install.sh | bash`)}
      </div>
      <div class="step">
        <p><strong>What happens:</strong> downloads the correct amd64/arm64 binary from GitHub,
        installs to <code>~/.bumblebee/bin/</code>, and adds a crontab entry
        (<code>0 */6 * * *</code>) to scan every 6 hours.</p>
      </div>
      <div class="step">
        <p><strong>Manual scan:</strong></p>
        ${code(`~/.bumblebee/bin/bumblebee scan --profile baseline --output http --http-url http://${host}:${port}/ingest --http-gzip --http-allow-insecure`)}
      </div>
      <div class="step">
        <p><strong>Uninstall:</strong></p>
        ${code(`curl -fsSL http://${host}:${port}/uninstall.sh | bash`)}
      </div>
    </div>

    <div class="os-block">
      <h2>⚙️ Advanced options</h2>
      <div class="step">
        <p>Pass extra flags after <code>bash</code>:</p>
        ${code(`curl -fsSL http://${host}:${port}/install.sh | bash -s -- \\
  --interval 12       # scan every 12h instead of 6h
  --profile deep      # deeper scan (baseline | project | deep)
  --version v0.1.2    # pin a specific bumblebee release
  --binary-url URL    # use internal mirror instead of GitHub
  --auth-token TOKEN  # if server requires --ingest-token-env`)}
      </div>
    </div>

    <div class="os-block" style="border-color:rgba(229,72,77,.25)">
      <h2>🗑 Uninstall remote agent</h2>
      <div class="step">
        <p>Run this <strong>on the remote machine</strong> to remove the schedule and binary:</p>
        ${code(`curl -fsSL http://${host}:${port}/uninstall.sh | bash`)}
      </div>
      <div class="step">
        <p>Remove the schedule but <strong>keep the binary</strong>:</p>
        ${code(`curl -fsSL http://${host}:${port}/uninstall.sh | bash -s -- --keep-binary`)}
      </div>
      <div class="note">
        💡 <code>make clean</code> only resets the <em>server</em> machine.
        Always use the uninstall one-liner on each remote agent machine.
      </div>
    </div>

    <a class="ghlink" href="https://github.com/perplexityai/bumblebee" target="_blank">
      ↗ perplexityai/bumblebee on GitHub — macOS &amp; Linux @latest
    </a>`;
}

function copyCode(btn) {
  const text = btn.previousElementSibling.textContent;

  const succeed = () => {
    btn.textContent = 'Copied!'; btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1800);
  };
  const fail = () => {
    btn.textContent = 'Select & copy manually';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2500);
  };

  // navigator.clipboard requires HTTPS or localhost — falls back to
  // execCommand for plain-HTTP LAN access (e.g. http://10.0.0.x:8080)
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(succeed).catch(() => execCopy(text, succeed, fail));
  } else {
    execCopy(text, succeed, fail);
  }
}

function execCopy(text, succeed, fail) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy') ? succeed() : fail();
  } catch(_) {
    fail();
  }
  document.body.removeChild(ta);
}

/* ── detail modal ───────────────────────────────────────────────────── */
$('closeDetail').onclick = () => $('detail').classList.add('hidden');
$('detail').onclick = e => { if (e.target === $('detail')) $('detail').classList.add('hidden'); };

async function showDetail(id) {
  const e = fleet.find(x => x.id === id);
  if (!e) return;

  const lightColor = {red:'#e5484d',yellow:'#e8b339',green:'#3fb950',gray:'#4b5b68'}[e.light]||'#4b5b68';
  const lightEmoji = {red:'🔴',yellow:'🟡',green:'🟢',gray:'⚪'}[e.light]||'⚪';

  // Show modal immediately with spinner while packages load
  $('detailBody').innerHTML = `
    <h2>
      <span class="light ${e.light}" style="width:18px;height:18px;box-shadow:0 0 12px ${lightColor}"></span>
      ${e.endpoint?.hostname||'unknown'}
      ${e.agent_version ? `<span style="font-size:13px;color:var(--accent);font-weight:500"> v${e.agent_version}</span>` : ''}
    </h2>
    <div class="meta">
      ${e.endpoint?.os||'?'} / ${e.endpoint?.arch||'?'} · user: ${e.endpoint?.username||'?'} ·
      profile: ${e.profile||'?'}<br>
      packages scanned: ${e.package_count??0} · last report: ${timeAgo(e.last_seen)} · status: ${e.last_status||'?'}
      ${e.last_error ? ` · <span style="color:var(--red)">${e.last_error}</span>` : ''}
    </div>
    <div style="margin:16px 0 24px">
      <button class="btn btn-primary" onclick="downloadReport('${e.id}')">⬇ Download HTML report</button>
    </div>
    <div id="modal-content" style="color:var(--muted);padding:40px;text-align:center">
      Loading packages…
    </div>`;
  $('detail').classList.remove('hidden');

  // Fetch packages
  let packages = [];
  try {
    const res = await fetch(`/api/packages/${id}`);
    packages = await res.json();
  } catch(_) {}

  const findings = [...(e.findings||[])].sort((a,b) =>
    (SEV_ORDER[a.severity]??5)-(SEV_ORDER[b.severity]??5));

  const findingRows = findings.map(f => `<tr>
    <td class="sev ${f.severity||''}">${f.severity||'unknown'}</td>
    <td><strong>${f.package_name||''}</strong> <span style="color:var(--muted);font-size:12px">@${f.version||''}</span></td>
    <td>${f.ecosystem||''}</td>
    <td>${f.catalog_name||f.catalog_id||''}</td>
    <td style="color:var(--muted);font-size:12px">${f.source_file||''}</td>
  </tr>`).join('');

  const pkgRows = packages.map(p => `<tr>
    <td style="color:var(--muted);font-size:12px">${p.ecosystem||''}</td>
    <td><strong>${p.name||''}</strong></td>
    <td style="color:var(--muted)">${p.version||''}</td>
    <td style="color:var(--muted);font-size:12px">${p.source_file||''}</td>
    <td style="color:var(--muted);font-size:12px">${p.source_type||''}</td>
  </tr>`).join('');

  // Stats row
  const sevSummary = Object.entries(e.severity_counts||{})
    .filter(([,v])=>v>0)
    .map(([k,v])=>`<span style="margin-right:14px"><b style="color:${SEV_COLOR[k]||'#8b9aa8'}">${v}</b> ${k}</span>`)
    .join('') || '<span style="color:var(--green)">none</span>';

  $('modal-content').innerHTML = `
    <!-- stat boxes -->
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:28px">
      <div class="stat-box">
        <div class="stat-label">Status</div>
        <div class="stat-val" style="color:${lightColor}">${lightEmoji} ${lightLabel(e.light)}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Packages scanned</div>
        <div class="stat-val">${e.package_count??0}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Findings</div>
        <div class="stat-val" style="color:${findings.length>0?lightColor:'var(--green)'}">${findings.length}</div>
      </div>
      <div class="stat-box" style="grid-column:span 2">
        <div class="stat-label">Severity breakdown</div>
        <div style="margin-top:8px;font-size:14px">${sevSummary}</div>
      </div>
    </div>

    <!-- findings -->
    <div class="section-hdr">
      Findings
      <span class="count-chip">${findings.length}</span>
    </div>
    ${findings.length ? `
      <table>
        <thead><tr>
          <th>Severity</th><th>Package</th><th>Ecosystem</th><th>Threat</th><th>Source file</th>
        </tr></thead>
        <tbody>${findingRows}</tbody>
      </table>` : `
      <div class="clean-banner">✅ No findings on the latest completed scan — this endpoint is clean.</div>`}

    <!-- packages -->
    <div class="section-hdr" style="margin-top:28px">
      All packages
      <span class="count-chip">${packages.length}</span>
    </div>
    ${packages.length ? `
      <table>
        <thead><tr>
          <th>Ecosystem</th><th>Package</th><th>Version</th><th>Source file</th><th>Type</th>
        </tr></thead>
        <tbody>${pkgRows}</tbody>
      </table>` : `
      <div class="clean-banner">📦 No package data — run a scan first.</div>`}`;
}

/* ── polling ────────────────────────────────────────────────────────── */
async function poll() {
  try {
    const [fleetRes, configRes] = await Promise.all([
      fetch('/api/fleet'),
      fetch('/api/config'),
    ]);
    const data = await fleetRes.json();
    fleet = Array.isArray(data) ? data : [];
    const cfg = await configRes.json();
    staleAfterHours = cfg.stale_after_hours || 96;
    renderStaleDropdown();
    renderFleet();
    renderReports();
  } catch(e) {
    $('summary').textContent = 'connection error: ' + e;
  }
}

poll();
setInterval(poll, 10000);
