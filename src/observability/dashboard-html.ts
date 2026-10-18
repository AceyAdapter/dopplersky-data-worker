export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Dopplersky worker</title>
  <link rel="icon" href="data:,">
  <style>
    :root {
      --canvas:#080b11; --surface:#0f141c; --raised:#161d27; --sunken:#05070b;
      --line:#232c39; --line-strong:#33404f; --ink:#e8edf4; --muted:#8c9aac;
      --faint:#5c6979; --blue:#4c9eff; --blue-wash:rgba(76,158,255,.10);
      --red:#ff6b57; --red-wash:rgba(255,107,87,.10); --alert:#f2b544;
      --sans:system-ui,-apple-system,"Segoe UI",sans-serif;
      --mono:ui-monospace,"SFMono-Regular",Menlo,monospace;
    }
    * { box-sizing:border-box; }
    html { background:var(--canvas); color:var(--ink); }
    body { margin:0; font:14px/1.45 var(--sans); -webkit-font-smoothing:antialiased; }
    body::before {
      content:""; position:fixed; inset:0 0 auto; height:220px; pointer-events:none; opacity:.18;
      background-image:radial-gradient(var(--blue) .7px,transparent .8px); background-size:5px 5px;
      mask-image:linear-gradient(to bottom,#000,transparent);
    }
    button,select { font:inherit; }
    :focus-visible { outline:2px solid var(--blue); outline-offset:2px; }
    .shell { width:min(1480px,100%); margin:auto; padding:24px; position:relative; }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; margin-bottom:24px; }
    .eyebrow,.label,th { color:var(--faint); font:500 11px/1.2 var(--mono); letter-spacing:.08em; text-transform:uppercase; }
    h1 { font:500 clamp(26px,4vw,38px)/1.1 Georgia,serif; margin:5px 0 0; letter-spacing:-.02em; }
    .connection { display:flex; align-items:center; gap:9px; color:var(--muted); font-family:var(--mono); font-size:12px; }
    .dot { width:8px; height:8px; border-radius:50%; background:var(--alert); box-shadow:0 0 0 4px rgba(242,181,68,.08); }
    .connection.live .dot { background:var(--blue); box-shadow:0 0 0 4px var(--blue-wash); }
    .connection.offline .dot { background:var(--red); box-shadow:0 0 0 4px var(--red-wash); }
    .kpis { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); border:1px solid var(--line); border-radius:14px; overflow:hidden; background:var(--surface); margin-bottom:16px; }
    .kpi { padding:18px 20px; min-width:0; border-right:1px solid var(--line); }
    .kpi:last-child { border:0; }
    .value { display:block; margin-top:8px; font:500 28px/1 var(--mono); letter-spacing:-.04em; font-variant-numeric:tabular-nums; white-space:nowrap; }
    .sub { display:block; margin-top:7px; color:var(--muted); font:12px/1.3 var(--mono); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .danger { color:var(--red)!important; } .warn { color:var(--alert)!important; } .good { color:var(--blue)!important; }
    .grid { display:grid; grid-template-columns:minmax(0,1.7fr) minmax(340px,.8fr); gap:16px; align-items:start; }
    .stack { display:grid; gap:16px; min-width:0; }
    .panel { border:1px solid var(--line); border-radius:14px; background:var(--surface); min-width:0; overflow:hidden; }
    .panel-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; padding:16px 18px 13px; border-bottom:1px solid var(--line); }
    h2 { font-size:14px; font-weight:600; margin:0; }
    .caption { color:var(--muted); font:11px/1.4 var(--mono); margin-top:3px; }
    .legend { display:flex; gap:14px; align-items:center; color:var(--muted); font:11px/1 var(--mono); }
    .legend i { display:inline-block; width:12px; height:2px; margin-right:5px; vertical-align:middle; }
    .chart { padding:14px 18px 12px; background:var(--sunken); }
    .chart svg { display:block; width:100%; height:150px; overflow:visible; }
    .chart-line { fill:none; stroke-width:2; vector-effect:non-scaling-stroke; }
    .chart-fill { fill:var(--blue-wash); stroke:none; }
    .chart-grid { stroke:var(--line); stroke-width:1; vector-effect:non-scaling-stroke; }
    .chart-meta { display:flex; justify-content:space-between; color:var(--faint); font:10px/1 var(--mono); margin-top:8px; }
    .table-wrap { overflow:auto; }
    table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
    th { text-align:right; font-weight:500; padding:10px 12px; border-bottom:1px solid var(--line); white-space:nowrap; }
    th:first-child,td:first-child { text-align:left; padding-left:18px; }
    td { padding:10px 12px; border-bottom:1px solid color-mix(in srgb,var(--line) 70%,transparent); text-align:right; font:12px/1.25 var(--mono); white-space:nowrap; }
    tbody tr:last-child td { border-bottom:0; }
    tbody tr:hover { background:var(--raised); }
    .kind { color:var(--ink); } .muted { color:var(--muted); } .faint { color:var(--faint); }
    .priority { display:inline-flex; min-width:28px; justify-content:center; border:1px solid var(--line); border-radius:6px; padding:2px 5px; color:var(--muted); }
    .meters { padding:5px 18px 14px; }
    .worker-strip { display:flex; flex-wrap:wrap; gap:6px; padding:12px 18px 4px; }
    .worker-chip { border:1px solid var(--line); border-radius:6px; padding:5px 7px; color:var(--muted); font:11px/1 var(--mono); }
    .meter { padding:12px 0; border-bottom:1px solid var(--line); }
    .meter:last-child { border:0; }
    .meter-top { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
    .meter-name { font-weight:550; }
    .meter-value { font:12px/1 var(--mono); color:var(--muted); font-variant-numeric:tabular-nums; }
    .bar { height:3px; border-radius:99px; background:var(--sunken); margin-top:9px; overflow:hidden; }
    .bar span { display:block; height:100%; background:var(--blue); transition:width .18s ease-out; }
    .fact-grid { display:grid; grid-template-columns:1fr 1fr; }
    .fact { padding:15px 18px; border-right:1px solid var(--line); border-bottom:1px solid var(--line); }
    .fact:nth-child(even) { border-right:0; }
    .fact-value { display:block; font:16px/1.2 var(--mono); margin-top:6px; font-variant-numeric:tabular-nums; }
    .empty { padding:24px 18px; color:var(--muted); text-align:center; font-size:13px; }
    .rising { margin-bottom:16px; scroll-margin-top:16px; }
    .rising-controls { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    .rising-controls input { min-width:180px; max-width:100%; border:1px solid var(--line-strong); border-radius:6px; padding:6px 9px; background:var(--sunken); color:var(--ink); font:12px var(--sans); }
    .rising .table-wrap { max-height:510px; }
    .rising th { position:sticky; top:0; background:var(--surface); z-index:1; }
    .rising td { vertical-align:top; }
    .post-cell { min-width:260px; max-width:440px; white-space:normal; }
    .post-text { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; margin-top:5px; font:13px/1.45 var(--sans); color:var(--muted); overflow-wrap:anywhere; }
    .post-links { display:flex; flex-wrap:wrap; gap:7px; min-width:125px; }
    .post-links a { display:inline-block; padding:5px 8px; border:1px solid var(--line-strong); border-radius:6px; color:var(--muted); text-decoration:none; font:11px var(--mono); }
    .post-links a:first-child { color:var(--blue); border-color:var(--blue); background:var(--blue-wash); }
    .post-links a:hover { color:var(--ink); border-color:var(--blue); }
    .rising-meta { padding:10px 18px; border-top:1px solid var(--line); color:var(--muted); font:11px/1.5 var(--mono); }
    .rising-meta.err { color:var(--red); }
    .stale-rows { opacity:.55; }
    @media(max-width:700px) {
      .rising .panel-head { flex-wrap:wrap; }
      .rising-controls { width:100%; justify-content:flex-start; }
      .rising-controls input { flex:1; }
    }
    .accounts { margin-top:16px; }
    .acct-sub { display:block; color:var(--faint); font:10px/1.3 var(--mono); margin-top:2px; max-width:320px; overflow:hidden; text-overflow:ellipsis; }
    .acct-note { color:var(--muted); font:11px/1.4 var(--mono); text-align:right; max-width:320px; }
    .acct-note.err { color:var(--red); }
    .state-pill { display:inline-flex; padding:2px 8px; border-radius:6px; border:1px solid var(--line); color:var(--muted); text-transform:capitalize; }
    .tgl { border:1px solid var(--line-strong); border-radius:6px; padding:3px 11px; min-width:50px; background:var(--sunken); color:var(--muted); font:11px/1 var(--mono); cursor:pointer; }
    .tgl:hover { border-color:var(--blue); color:var(--ink); }
    .tgl.on { border-color:var(--blue); color:var(--blue); background:var(--blue-wash); }
    .tgl.off { color:var(--faint); }
    .tgl.danger-hover:hover { border-color:var(--red); color:var(--red); background:var(--red-wash); }
    .tgl[disabled] { opacity:.45; cursor:default; }
    .error-list { list-style:none; padding:4px 18px 12px; margin:0; }
    .error-list li { display:grid; grid-template-columns:94px 1fr; gap:10px; padding:10px 0; border-bottom:1px solid var(--line); }
    .error-list li:last-child { border:0; }
    .error-time { color:var(--faint); font:11px/1.35 var(--mono); }
    .error-copy { min-width:0; }
    .error-copy b { color:var(--red); font:11px/1.35 var(--mono); }
    .error-copy p { color:var(--muted); margin:3px 0 0; overflow-wrap:anywhere; }
    footer { display:flex; justify-content:space-between; gap:16px; margin-top:16px; color:var(--faint); font:11px/1.4 var(--mono); }
    .skeleton { background:linear-gradient(90deg,var(--surface),var(--raised),var(--surface)); background-size:200% 100%; animation:shimmer 1.4s infinite linear; color:transparent!important; border-radius:4px; }
    @keyframes shimmer { to { background-position:-200% 0; } }
    @media (max-width:1000px) { .kpis { grid-template-columns:repeat(3,1fr); } .kpi:nth-child(3) { border-right:0; } .kpi:nth-child(-n+3) { border-bottom:1px solid var(--line); } .grid { grid-template-columns:1fr; } }
    @media (max-width:640px) { .shell { padding:16px; } header { align-items:flex-start; flex-direction:column; } .kpis { grid-template-columns:1fr 1fr; } .kpi { border-bottom:1px solid var(--line); } .kpi:nth-child(odd) { border-right:1px solid var(--line); } .kpi:nth-child(even) { border-right:0; } .kpi:last-child { grid-column:1/-1; } .fact-grid { grid-template-columns:1fr; } .fact { border-right:0; } footer { flex-direction:column; } }
    @media (prefers-reduced-motion:reduce) { *,*::before,*::after { animation:none!important; transition:none!important; } }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div><div class="eyebrow">Dopplersky / local operations</div><h1>Worker pulse</h1></div>
      <div class="connection" id="connection"><span class="dot"></span><span id="connectionText">Connecting…</span></div>
    </header>

    <section class="kpis" aria-label="Worker summary">
      <div class="kpi"><span class="label">This worker</span><span class="value skeleton" id="active">0 / 0</span><span class="sub" id="activeSub">busy slots</span></div>
      <div class="kpi"><span class="label">Handled / sec</span><span class="value skeleton" id="throughput">0.00</span><span class="sub">rolling 60 seconds</span></div>
      <div class="kpi"><span class="label">Overdue jobs</span><span class="value skeleton" id="overdue">0</span><span class="sub" id="overdueSub">by due_at</span></div>
      <div class="kpi"><span class="label">AppView p95</span><span class="value skeleton" id="latency">—</span><span class="sub" id="latencySub">last 60 seconds</span></div>
      <div class="kpi"><span class="label">ETA at this rate</span><span class="value skeleton" id="eta">—</span><span class="sub">global overdue ÷ this worker's rate</span></div>
    </section>

    <section class="panel rising" id="risingPanel" aria-labelledby="risingHeading">
      <div class="panel-head">
        <div><h2 id="risingHeading">Rising posts <span class="state-pill">Private</span></h2><div class="caption">Tracked original posts · last 48h · ranked by observed recent interactions/hour</div></div>
        <div class="rising-controls"><input id="risingFilter" type="search" aria-label="Filter displayed rising posts" placeholder="Filter these results…"><button class="tgl" id="risingRefresh" type="button">Refresh</button></div>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Post</th><th>Age</th><th>Recent gain</th><th>Rate / hour</th><th>Prior / hour</th><th>Last sample</th><th>Open</th></tr></thead><tbody id="risingRows"><tr><td colspan="7" class="empty">Loading recent post observations…</td></tr></tbody></table></div>
      <div class="rising-meta" id="risingStatus" role="status">Read-only · refreshes at most every 30s · no audience data</div>
      <div class="rising-meta">Rates use 10–60 minutes of saved observations; latest sample must be within 15 minutes. Saved samples record changes, so gaps are not filled. Dopplersky links select the post and exclude your visit from analytics; normal sign-in and Premium rules still apply.</div>
    </section>

    <div class="grid">
      <div class="stack">
        <section class="panel">
          <div class="panel-head"><div><h2>Handling rate</h2><div class="caption">Per-second process activity · last 2 minutes</div></div><div class="legend"><span><i style="background:var(--blue)"></i>jobs</span><span><i style="background:var(--alert)"></i>AppView</span></div></div>
          <div class="chart"><svg id="rateChart" viewBox="0 0 900 150" preserveAspectRatio="none" role="img" aria-label="Jobs handled and AppView requests per second"><line class="chart-grid" x1="0" y1="149" x2="900" y2="149"></line><line class="chart-grid" x1="0" y1="75" x2="900" y2="75"></line><path class="chart-fill" id="jobFill"></path><polyline class="chart-line" id="jobLine" stroke="var(--blue)"></polyline><polyline class="chart-line" id="requestLine" stroke="var(--alert)"></polyline></svg><div class="chart-meta"><span>2 min ago</span><span id="chartMax">scale —</span><span>now</span></div></div>
        </section>

        <section class="panel">
          <div class="panel-head"><div><h2>Durable queue</h2><div class="caption">Standing work is expected; overdue age is the pressure signal</div></div><div class="caption" id="queueSample">—</div></div>
          <div class="table-wrap"><table><thead><tr><th>Kind</th><th>Pri</th><th>Total</th><th>Overdue</th><th>Leased</th><th>p50 age</th><th>p95 age</th></tr></thead><tbody id="queueRows"><tr><td colspan="7" class="empty">Waiting for first snapshot…</td></tr></tbody></table></div>
        </section>

        <section class="panel">
          <div class="panel-head"><div><h2>AppView calls</h2><div class="caption">Actual HTTP attempts, including client retries · last 60 seconds</div></div><div class="caption" id="appviewSummary">—</div></div>
          <div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>Requests</th><th>p95</th><th>Errors</th><th>429s</th></tr></thead><tbody id="endpointRows"><tr><td colspan="5" class="empty">No calls since this worker started.</td></tr></tbody></table></div>
        </section>
      </div>

      <aside class="stack">
        <section class="panel">
          <div class="panel-head"><div><h2>Worker outcomes</h2><div class="caption">This process · since start</div></div><div class="caption" id="uptime">—</div></div>
          <div class="worker-strip" id="workerLeases"><span class="worker-chip">No active shared leases</span></div>
          <div class="meters" id="jobMeters"><div class="empty">No jobs handled yet.</div></div>
        </section>

        <section class="panel">
          <div class="panel-head"><div><h2>Workload</h2><div class="caption">Replay, maintenance, and database pressure</div></div></div>
          <div class="fact-grid">
            <div class="fact"><span class="label">Tracked accounts</span><span class="fact-value" id="accounts">—</span></div>
            <div class="fact"><span class="label">Enabled posts</span><span class="fact-value" id="posts">—</span></div>
            <div class="fact"><span class="label">30d replay set</span><span class="fact-value" id="replayPosts">—</span></div>
            <div class="fact"><span class="label">Cold posts due</span><span class="fact-value" id="coldDue">—</span></div>
            <div class="fact"><span class="label">Samples / hour</span><span class="fact-value" id="samples">—</span></div>
            <div class="fact"><span class="label">Database</span><span class="fact-value" id="database">—</span></div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><div><h2>Onboarding</h2><div class="caption" id="accountStates">Account baseline states</div></div></div>
          <div class="table-wrap"><table><thead><tr><th>Account</th><th>State</th><th>Pages</th><th>Posts</th><th>Idle</th></tr></thead><tbody id="onboardingRows"><tr><td colspan="5" class="empty">No recent baseline runs.</td></tr></tbody></table></div>
        </section>

        <section class="panel">
          <div class="panel-head"><div><h2>Recent job errors</h2><div class="caption">Current process only · newest first</div></div></div>
          <ul class="error-list" id="errors"><li class="empty">No job errors since restart.</li></ul>
        </section>
      </aside>
    </div>

    <section class="panel accounts" id="accountsPanel">
      <div class="panel-head">
        <div><h2>Tracked accounts</h2><div class="caption" id="accountsCaption">Every account this worker collects · toggle collection and audience</div></div>
        <div class="acct-note" id="accountsNote"></div>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Account</th><th>Followers</th><th>Posts</th><th>State</th><th>Last profile</th><th>Collection</th><th>Audience</th></tr></thead><tbody id="accountRows"><tr><td colspan="7" class="empty">Waiting for first snapshot…</td></tr></tbody></table></div>
    </section>

    <footer><span id="worker">worker —</span><span id="sampleMeta">SSE every 2s · counters reset on restart</span></footer>
  </main>
  <script>
    (function () {
      var lastMessageAt = 0;
      var connection = document.getElementById('connection');
      var connectionText = document.getElementById('connectionText');
      var source = new EventSource('/events');
      source.addEventListener('snapshot', function (event) {
        try { render(JSON.parse(event.data)); lastMessageAt = Date.now(); setConnection('live', 'Live · just now'); }
        catch (error) { setConnection('offline', 'Snapshot error'); }
      });
      source.addEventListener('dashboard-error', function () { setConnection('offline', 'Database read failed'); });
      source.onopen = function () { setConnection('', 'Connected · waiting for data'); };
      source.onerror = function () { setConnection('offline', 'Reconnecting…'); };
      window.setInterval(function () {
        if (!lastMessageAt) return;
        var age = Math.floor((Date.now() - lastMessageAt) / 1000);
        if (age > 5) setConnection('offline', 'Stale · ' + age + 's ago');
        else setConnection('live', 'Live · ' + (age === 0 ? 'just now' : age + 's ago'));
      }, 1000);

      function render(data) {
        var runtime = data.runtime;
        var db = data.database;
        set('active', number(runtime.active) + ' / ' + number(runtime.concurrency));
        set('activeSub', runtime.active >= runtime.concurrency ? 'all local slots occupied' : 'busy slots');
        setClass('active', runtime.active >= runtime.concurrency ? 'warn' : 'good');
        set('throughput', runtime.handledPerSecond.toFixed(2));
        set('overdue', number(db.queueTotals.overdue));
        set('overdueSub', number(db.queueTotals.scheduled) + ' scheduled · ' + number(db.queueTotals.expiredLeases) + ' expired leases');
        setClass('overdue', db.queueTotals.expiredLeases > 0 ? 'danger' : db.queueTotals.overdue > 0 ? 'warn' : 'good');
        set('latency', runtime.lastMinute.appviewP95Ms == null ? '—' : durationMs(runtime.lastMinute.appviewP95Ms));
        set('latencySub', number(runtime.lastMinute.appviewRequests) + ' requests · ' + number(runtime.lastMinute.appviewErrors) + ' errors');
        setClass('latency', runtime.lastMinute.appview429s > 0 ? 'danger' : runtime.lastMinute.appviewErrors > 0 ? 'warn' : 'good');
        set('eta', estimate(db.queueTotals.overdue, runtime.handledPerSecond));
        set('queueSample', 'DB ' + durationMs(db.queryDurationMs));
        set('uptime', formatAge(runtime.uptimeSeconds));
        set('worker', runtime.workerId + ' · started ' + new Date(runtime.startedAt).toLocaleString());
        set('sampleMeta', 'SSE every 2s · DB ' + durationMs(db.queryDurationMs) + ' · counters reset on restart');

        renderSeries(runtime.series);
        renderQueue(db.queue);
        renderJobs(runtime.jobsByKind);
        renderWorkers(db.workers, runtime.workerId);
        renderEndpoints(runtime.appviewByEndpoint, runtime.lastMinute);
        renderWorkload(db.workload);
        renderOnboarding(db.accounts, db.onboarding);
        renderAccounts(db.trackedAccounts);
        renderErrors(runtime.recentErrors);
        document.querySelectorAll('.skeleton').forEach(function (node) { node.classList.remove('skeleton'); });
      }

      var risingSnapshot = null;
      var risingLoading = false;
      var risingFailed = false;
      var risingLastAttempt = 0;
      var risingRefresh = document.getElementById('risingRefresh');
      var risingFilter = document.getElementById('risingFilter');
      risingRefresh.addEventListener('click', loadRisingPosts);
      risingFilter.addEventListener('input', function () { if (risingSnapshot) renderRisingPosts(risingSnapshot); });
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden && Date.now() - risingLastAttempt >= 30000) loadRisingPosts();
      });
      window.setInterval(function () { if (!document.hidden) loadRisingPosts(); }, 30000);
      loadRisingPosts();

      function loadRisingPosts() {
        if (risingLoading) return;
        risingLoading = true;
        risingLastAttempt = Date.now();
        risingRefresh.disabled = true;
        var controller = new AbortController();
        var timeout = window.setTimeout(function () { controller.abort(); }, 15000);
        fetch('/rising-posts', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
          .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
          .then(function (data) {
            if (!data || !Array.isArray(data.rows)) throw new Error('Invalid snapshot');
            risingFailed = false;
            risingSnapshot = data;
            document.getElementById('risingRows').classList.remove('stale-rows');
            renderRisingPosts(data);
          })
          .catch(function () {
            risingFailed = true;
            document.getElementById('risingStatus').className = 'rising-meta err';
            set('risingStatus', risingSnapshot ? 'Refresh failed. Showing older results; check each sample time. Retrying in 30s.' : 'Rising posts could not be loaded. Retrying in 30s; worker monitoring is unaffected.');
            if (risingSnapshot) document.getElementById('risingRows').classList.add('stale-rows');
            else document.getElementById('risingRows').innerHTML = '<tr><td colspan="7" class="empty">Data unavailable. No ranking has been inferred.</td></tr>';
          })
          .finally(function () { window.clearTimeout(timeout); risingLoading = false; risingRefresh.disabled = false; });
      }

      function renderRisingPosts(data) {
        var filter = risingFilter.value.trim().toLowerCase();
        var rows = data.rows.filter(function (row) { return !filter || ((row.handle || row.authorDid) + ' ' + (row.text || '')).toLowerCase().includes(filter); });
        var target = document.getElementById('risingRows');
        if (!rows.length) {
          target.innerHTML = '<tr><td colspan="7" class="empty">' + (filter ? 'No matching posts in these results.' : 'No posts currently have fresh, positive growth over a qualifying observation window. Young, stale, unchanged or corrected series may be omitted.') + '</td></tr>';
        } else {
          target.innerHTML = rows.map(function (row) {
            var links = risingPostLinks(row);
            var latestAge = Math.max(0, (Date.now() - Date.parse(row.latestSampleAt)) / 1000);
            var prior = row.previousInteractionsPerHour;
            var trend = prior == null ? 'No comparable prior window' : row.interactionsPerHour > prior ? '↑ Faster than prior window' : row.interactionsPerHour < prior ? '↓ Slower than prior window' : 'Same rate as prior window';
            return '<tr><td class="post-cell"><span class="kind">' + escapeHtml(row.handle ? '@' + row.handle : row.authorDid) + '</span><span class="post-text">' + escapeHtml(row.text || 'Post text unavailable') + '</span></td>'
              + '<td class="muted">' + age(Math.max(0, (Date.now() - Date.parse(row.createdAt)) / 1000)) + '</td>'
              + '<td>+' + number(row.gainedInteractions) + '<span class="acct-sub">in ' + row.observedMinutes.toFixed(1) + ' min</span></td>'
              + '<td class="good">' + rate(row.interactionsPerHour) + '<span class="acct-sub">' + number(row.interactions) + ' total</span></td>'
              + '<td class="muted">' + (prior == null ? '—' : rate(prior)) + '<span class="acct-sub">' + trend + '</span></td>'
              + '<td class="' + (latestAge > data.freshnessMinutes * 60 ? 'warn' : 'muted') + '">' + age(latestAge) + ' ago<span class="acct-sub">' + number(row.sampleCount) + ' saved · max gap ' + row.maxGapMinutes.toFixed(1) + 'm</span></td>'
              + '<td><div class="post-links">' + (links.dopplersky ? '<a href="' + escapeHtml(links.dopplersky) + '" target="_blank" rel="noopener noreferrer">Dopplersky ↗</a>' : '<span class="faint">Handle unavailable</span>')
              + (links.bluesky ? '<a href="' + escapeHtml(links.bluesky) + '" target="_blank" rel="noopener noreferrer">Bluesky ↗</a>' : '') + '</div></td></tr>';
          }).join('');
        }
        if (!risingFailed) {
          document.getElementById('risingStatus').className = 'rising-meta';
          set('risingStatus', 'Showing ' + rows.length + (filter ? ' of ' + data.rows.length + ' displayed' : ' of ' + number(data.totalEligible) + ' qualifying') + ' · snapshot ' + new Date(data.sampledAt).toLocaleTimeString() + ' · query ' + durationMs(data.queryDurationMs) + ' · refreshes at most every 30s');
        }
      }

      function risingPostLinks(row) {
        var match = /^at:\/\/(did:[^/?#]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._~:-]+)$/.exec(row.uri || '');
        if (!match || match[1] !== row.authorDid) return { dopplersky: null, bluesky: null };
        var dopplersky = row.handle ? new URL('https://dopplersky.com/user/' + encodeURIComponent(row.handle) + '/posts') : null;
        if (dopplersky) { dopplersky.searchParams.set('post', row.uri); dopplersky.searchParams.set('internal', '1'); }
        return { dopplersky: dopplersky ? dopplersky.href : null, bluesky: 'https://bsky.app/profile/' + encodeURIComponent(row.authorDid) + '/post/' + encodeURIComponent(match[2]) };
      }

      function rate(value) { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value); }

      function renderSeries(series) {
        var jobs = series.map(function (point) { return point.handled; });
        var requests = series.map(function (point) { return point.appviewRequests; });
        var max = Math.max(1, Math.max.apply(null, jobs.concat(requests)));
        var jobPoints = points(jobs, max);
        var requestPoints = points(requests, max);
        document.getElementById('jobLine').setAttribute('points', jobPoints);
        document.getElementById('requestLine').setAttribute('points', requestPoints);
        document.getElementById('jobFill').setAttribute('d', 'M 0 150 L ' + jobPoints.replace(/ /g, ' L ') + ' L 900 150 Z');
        set('chartMax', 'scale 0–' + max + '/s');
      }

      function renderQueue(rows) {
        var target = document.getElementById('queueRows');
        if (!rows.length) { target.innerHTML = '<tr><td colspan="7" class="empty">Queue is empty.</td></tr>'; return; }
        target.innerHTML = rows.map(function (row) {
          var ageClass = row.p95OverdueSeconds > 300 ? 'warn' : 'muted';
          return '<tr><td class="kind">' + escapeHtml(row.kind) + '</td><td><span class="priority">' + row.priority + '</span></td><td>' + number(row.total) + '</td><td class="' + (row.expiredLeases ? 'danger' : row.overdue ? 'warn' : 'muted') + '">' + number(row.overdue) + '</td><td>' + number(row.leased) + '</td><td class="muted">' + age(row.p50OverdueSeconds) + '</td><td class="' + ageClass + '">' + age(row.p95OverdueSeconds) + '</td></tr>';
        }).join('');
      }

      function renderJobs(rows) {
        var target = document.getElementById('jobMeters');
        if (!rows.length) { target.innerHTML = '<div class="empty">No jobs handled yet.</div>'; return; }
        var max = Math.max.apply(null, rows.map(function (row) { return row.claimed; }).concat([1]));
        target.innerHTML = rows.map(function (row) {
          var handled = row.completed + row.rescheduled + row.failed + row.degraded;
          var failures = row.failed + row.degraded;
          return '<div class="meter"><div class="meter-top"><span class="meter-name">' + escapeHtml(row.kind) + '</span><span class="meter-value ' + (failures ? 'danger' : '') + '">' + number(handled) + ' handled · ' + number(failures) + ' errors</span></div><div class="bar"><span style="width:' + Math.max(1, row.claimed / max * 100) + '%"></span></div></div>';
        }).join('');
      }

      function renderWorkers(rows, localWorkerId) {
        var target = document.getElementById('workerLeases');
        if (!rows.length) { target.innerHTML = '<span class="worker-chip">No active shared leases</span>'; return; }
        target.innerHTML = rows.map(function (row) {
          return '<span class="worker-chip ' + (row.workerId === localWorkerId ? 'good' : '') + '">' + escapeHtml(row.workerId) + ' · ' + number(row.activeLeases) + ' leased</span>';
        }).join('');
      }

      function renderEndpoints(rows, minute) {
        set('appviewSummary', number(minute.appviewRequests) + '/min · p50 ' + (minute.appviewP50Ms == null ? '—' : durationMs(minute.appviewP50Ms)));
        var target = document.getElementById('endpointRows');
        if (!rows.length) { target.innerHTML = '<tr><td colspan="5" class="empty">No AppView calls in the last minute.</td></tr>'; return; }
        target.innerHTML = rows.map(function (row) {
          return '<tr><td class="kind">' + escapeHtml(shortEndpoint(row.endpoint)) + '</td><td>' + number(row.requests) + '</td><td class="muted">' + (row.p95Ms == null ? '—' : durationMs(row.p95Ms)) + '</td><td class="' + (row.errors ? 'danger' : 'muted') + '">' + number(row.errors) + '</td><td class="' + (row.rateLimited ? 'danger' : 'muted') + '">' + number(row.rateLimited) + '</td></tr>';
        }).join('');
      }

      function renderWorkload(workload) {
        set('accounts', number(workload.trackedAccounts)); set('posts', number(workload.enabledPosts));
        set('replayPosts', number(workload.replayWindowPosts)); set('coldDue', number(workload.dueMaintenancePosts));
        set('samples', number(workload.replaySamplesLastHour));
        set('database', bytes(workload.databaseBytes) + ' · ' + number(workload.databaseConnections) + ' conn');
      }

      function renderOnboarding(states, rows) {
        set('accountStates', states.length ? states.map(function (state) { return state.state + ' ' + state.count; }).join(' · ') : 'No enabled accounts');
        var target = document.getElementById('onboardingRows');
        if (!rows.length) { target.innerHTML = '<tr><td colspan="5" class="empty">No active or recently completed baselines.</td></tr>'; return; }
        target.innerHTML = rows.map(function (row) {
          return '<tr><td class="kind">' + escapeHtml(row.handle) + '</td><td class="' + (row.state === 'degraded' ? 'danger' : row.state === 'ready' ? 'good' : 'warn') + '">' + escapeHtml(row.state) + '</td><td>' + number(row.pagesProcessed) + '</td><td>' + number(row.postsDiscovered) + '</td><td class="muted">' + age(row.idleSeconds) + '</td></tr>';
        }).join('');
      }

      function renderAccounts(data) {
        var rows = (data && data.rows) || [];
        var total = data ? data.total : 0;
        set('accountsCaption', rows.length
          ? 'Showing ' + rows.length + (total > rows.length ? ' of ' + number(total) : '') + ' tracked · toggle collection and audience'
          : 'Every account this worker collects · toggle collection and audience');
        var target = document.getElementById('accountRows');
        if (!rows.length) { target.innerHTML = '<tr><td colspan="7" class="empty">No tracked accounts yet.</td></tr>'; return; }
        target.innerHTML = rows.map(function (row) {
          var stateClass = row.baselineState === 'degraded' ? 'danger' : row.baselineState === 'cancelled' ? 'faint' : row.baselineState === 'ready' ? 'good' : 'warn';
          var did = escapeHtml(row.did);
          var handle = escapeHtml(row.handle);
          var collection = row.enabled
            ? '<button class="tgl on danger-hover" data-did="' + did + '" data-action="disable" data-handle="' + handle + '">On</button>'
            : '<button class="tgl off" data-did="' + did + '" data-action="enable" data-handle="' + handle + '">Off</button>';
          var audience = row.audienceEnabled
            ? '<button class="tgl on" data-did="' + did + '" data-action="audience-off" data-handle="' + handle + '">On</button>'
            : '<button class="tgl off" data-did="' + did + '" data-action="audience-on" data-handle="' + handle + '">Off</button>';
          return '<tr><td class="kind">' + handle + '<span class="acct-sub">' + did + '</span></td>'
            + '<td>' + (row.followers == null ? '<span class="faint">—</span>' : number(row.followers)) + '</td>'
            + '<td>' + number(row.trackedPosts) + '</td>'
            + '<td><span class="state-pill ' + stateClass + '">' + escapeHtml(row.baselineState) + '</span></td>'
            + '<td class="muted">' + age(row.lastProfileRefreshSeconds) + '</td>'
            + '<td>' + collection + '</td>'
            + '<td>' + audience + '</td></tr>';
        }).join('');
      }

      var accountsPanel = document.getElementById('accountsPanel');
      accountsPanel.addEventListener('click', function (event) {
        var button = event.target.closest && event.target.closest('button.tgl');
        if (!button || button.disabled) return;
        var action = button.getAttribute('data-action');
        var did = button.getAttribute('data-did');
        var handle = button.getAttribute('data-handle') || did;
        if (action === 'disable' && !window.confirm('Disable ' + handle + '?\n\nThis cancels its collection runs and deletes its queued jobs. You can re-enable it here — already-collected data is kept.')) return;
        postAction(did, action, button);
      });

      function postAction(did, action, button) {
        var original = button.textContent;
        button.disabled = true;
        button.textContent = '…';
        var restore = function () { button.disabled = false; button.textContent = original; };
        fetch('/actions/account', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ did: did, action: action }),
        }).then(function (response) {
          return response.json().catch(function () { return {}; }).then(function (data) {
            if (response.ok && data.ok) { note('', ''); }
            else { note('Action failed: ' + (data.error || ('HTTP ' + response.status)), 'err'); restore(); }
          });
        }).catch(function () { note('Network error — action not applied', 'err'); restore(); });
      }

      function note(text, kind) {
        var el = document.getElementById('accountsNote');
        el.textContent = text;
        el.className = 'acct-note' + (kind ? ' ' + kind : '');
      }

      function renderErrors(rows) {
        var target = document.getElementById('errors');
        if (!rows.length) { target.innerHTML = '<li class="empty">No job errors since restart.</li>'; return; }
        target.innerHTML = rows.slice(0, 8).map(function (row) {
          return '<li><span class="error-time">' + new Date(row.at).toLocaleTimeString() + '</span><div class="error-copy"><b>' + escapeHtml(row.kind) + (row.degraded ? ' · degraded' : '') + '</b><p>' + escapeHtml(row.message) + '</p></div></li>';
        }).join('');
      }

      function points(values, max) { return values.map(function (value, index) { return (index / Math.max(1, values.length - 1) * 900).toFixed(1) + ',' + (146 - value / max * 140).toFixed(1); }).join(' '); }
      function number(value) { return new Intl.NumberFormat().format(value || 0); }
      function durationMs(value) { return value >= 1000 ? (value / 1000).toFixed(1) + 's' : Math.round(value) + 'ms'; }
      function age(seconds) { if (seconds == null) return '—'; if (seconds < 60) return Math.round(seconds) + 's'; if (seconds < 3600) return Math.round(seconds / 60) + 'm'; if (seconds < 86400) return (seconds / 3600).toFixed(seconds < 36000 ? 1 : 0) + 'h'; return (seconds / 86400).toFixed(1) + 'd'; }
      function formatAge(seconds) { return 'up ' + age(seconds); }
      function estimate(overdue, rate) { if (!overdue || overdue <= 0) return 'current'; if (!rate || rate <= 0) return '—'; return age(overdue / rate); }
      function bytes(value) { if (!value) return '0 B'; var units = ['B','KB','MB','GB','TB']; var power = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024))); return (value / Math.pow(1024, power)).toFixed(power > 1 ? 1 : 0) + ' ' + units[power]; }
      function shortEndpoint(value) { return value.replace(/^app\.bsky\./, ''); }
      function escapeHtml(value) { return String(value).replace(/[&<>"']/g, function (char) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]; }); }
      function set(id, value) { document.getElementById(id).textContent = value; }
      function setClass(id, name) { var node = document.getElementById(id); node.classList.remove('danger','warn','good'); if (name) node.classList.add(name); }
      function setConnection(state, text) { connection.className = 'connection ' + state; connectionText.textContent = text; }
    })();
  </script>
</body>
</html>`;
