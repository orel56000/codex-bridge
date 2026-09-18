/**
 * The local management page served at `http://127.0.0.1:<port>/`.
 *
 * Everything is inline — no CDN, no build step, no network access — so the page
 * works on a machine that is offline and cannot leak anything to a third party.
 * It talks only to the gateway's own `/admin/*` endpoints.
 */
export function managementPage(token: string): string {
  // Only ever interpolated into a JS string literal, and the token is
  // base64url, but escape anyway so this can never become an injection point.
  const safeToken = JSON.stringify(String(token));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Codex Bridge</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa;
    --panel: #ffffff;
    --border: #e4e4e1;
    --text: #1c1c1a;
    --muted: #6d6d68;
    --accent: #2f6f4f;
    --accent-soft: #e8f2ec;
    --danger: #a33a32;
    --track: #ececea;
    --radius: 10px;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17171a;
      --panel: #1e1e22;
      --border: #2e2e34;
      --text: #e9e9e6;
      --muted: #9a9a94;
      --accent: #6bbd90;
      --accent-soft: #1f2f27;
      --danger: #e0796f;
      --track: #2a2a30;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 620px; margin: 0 auto; padding: 48px 16px 64px; }
  h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; margin: 0 0 32px; }
  section {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px 20px;
    margin-bottom: 14px;
  }
  h2 {
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--muted); margin: 0 0 14px;
  }
  .row { display: flex; justify-content: space-between; gap: 16px; padding: 5px 0; font-size: 14px; }
  .row dt { color: var(--muted); }
  .row dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  dl { margin: 0; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 7px; vertical-align: 1px; }
  .ok { background: var(--accent); }
  .bad { background: var(--danger); }
  .idle { background: var(--muted); }
  .meter { display: grid; grid-template-columns: 90px 1fr 46px; align-items: center; gap: 12px; padding: 6px 0; font-size: 14px; }
  .meter span:first-child { color: var(--muted); }
  .track { height: 7px; border-radius: 4px; background: var(--track); overflow: hidden; }
  .fill { height: 100%; background: var(--accent); border-radius: 4px; transition: width .3s ease; }
  .fill.hot { background: var(--danger); }
  .meter .pct { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  button {
    font: inherit; font-size: 13px; padding: 7px 14px; border-radius: 7px;
    border: 1px solid var(--border); background: transparent; color: var(--text); cursor: pointer;
  }
  button:hover:not(:disabled) { background: var(--accent-soft); border-color: var(--accent); }
  button:disabled { opacity: .5; cursor: default; }
  button.danger:hover:not(:disabled) { border-color: var(--danger); background: transparent; color: var(--danger); }
  pre {
    font-family: var(--mono); font-size: 12.5px; line-height: 1.5; white-space: pre-wrap;
    background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    padding: 14px; margin: 14px 0 0; max-height: 340px; overflow: auto;
  }
  code { font-family: var(--mono); font-size: 12.5px; }
  .empty { color: var(--muted); font-size: 13.5px; }
  footer { color: var(--muted); font-size: 12px; text-align: center; margin-top: 28px; }
</style>
</head>
<body>
<main>
  <h1>Codex Bridge</h1>
  <p class="sub">Claude Code, served by Codex over your ChatGPT subscription.</p>

  <section>
    <h2>OpenAI account</h2>
    <div id="account"><p class="empty">Loading…</p></div>
    <div class="actions">
      <button id="connect" hidden>Connect ChatGPT</button>
      <button id="disconnect" class="danger" hidden>Disconnect</button>
    </div>
  </section>

  <section>
    <h2>Codex</h2>
    <dl id="codex"><p class="empty">Loading…</p></dl>
  </section>

  <section>
    <h2>Usage</h2>
    <div id="usage"><p class="empty">Loading…</p></div>
  </section>

  <section>
    <h2>Claude Code</h2>
    <dl id="claude"><p class="empty">Loading…</p></dl>
    <div class="actions">
      <button id="diagnose">Run diagnostics</button>
      <button id="restart">Restart Codex</button>
    </div>
    <pre id="output" hidden></pre>
  </section>

  <footer>Local only &middot; <span id="addr"></span></footer>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  };
  var rows = function (pairs) {
    return '<dl>' + pairs.map(function (p) {
      return '<div class="row"><dt>' + esc(p[0]) + '</dt><dd>' + p[1] + '</dd></div>';
    }).join('') + '</dl>';
  };
  var dot = function (state) { return '<span class="dot ' + state + '"></span>'; };

  function meter(label, win) {
    if (!win) return '';
    var pct = Math.max(0, Math.min(100, Math.round(win.usedPercent)));
    var resets = win.resetsAt ? ' &middot; resets ' + esc(new Date(win.resetsAt).toLocaleString()) : '';
    return '<div class="meter"><span>' + esc(label) + '</span>' +
      '<span class="track"><span class="fill' + (pct >= 85 ? ' hot' : '') + '" style="width:' + pct + '%"></span></span>' +
      '<span class="pct">' + pct + '%</span></div>' +
      (resets ? '<div class="sub" style="margin:-2px 0 8px;font-size:12px">' + resets.replace('&middot;', '') + '</div>' : '');
  }

  function render(s) {
    $('addr').textContent = s.gateway.url || '';

    var a = s.account;
    $('account').innerHTML = a.connected
      ? rows([
          ['Status', dot('ok') + 'Connected'],
          ['Account', esc(a.email || 'signed in')],
          ['Plan', esc(a.plan || 'unknown')],
          ['Auth', esc(a.authMethod || '')]
        ])
      : rows([['Status', dot('bad') + 'Not connected']]) +
        '<p class="empty">Run <code>/logincodex</code> in Claude Code, or use the button below.</p>';
    $('connect').hidden = a.connected;
    $('disconnect').hidden = !a.connected;

    $('codex').innerHTML = rows([
      ['App Server', (s.codex.appServerRunning ? dot('ok') + 'Running' : dot('bad') + 'Stopped')],
      ['Binary', '<code>' + esc(s.codex.binary || 'not found') + '</code>'],
      ['Version', esc(s.codex.version || 'unknown')],
      ['Model', esc(s.model.resolved || 'not resolved')],
      ['Gateway', (s.gateway.running ? dot('ok') : dot('bad')) + esc(s.gateway.host + ':' + s.gateway.port)],
      ['Sessions', String(s.gateway.activeSessions)]
    ]);

    if (!s.usage) {
      $('usage').innerHTML = '<p class="empty">Codex did not report usage for this account.</p>';
    } else {
      var html = '';
      html += meter(s.usage.primary ? s.usage.primary.label : '', s.usage.primary);
      html += meter(s.usage.secondary ? s.usage.secondary.label : '', s.usage.secondary);
      if (!html) html = '<p class="empty">No usage windows reported.</p>';
      if (s.usage.ordinaryUsageAllowed === false) {
        html += '<p class="empty">' + dot('bad') + 'Included usage is currently blocked by OpenAI.</p>';
      }
      $('usage').innerHTML = html;
    }

    $('claude').innerHTML = rows([
      ['Routing', s.claudeCode.configured
        ? dot('ok') + 'Through this gateway'
        : s.claudeCode.pointsElsewhere
          ? dot('bad') + 'Elsewhere'
          : dot('idle') + 'Not configured'],
      ['Base URL', '<code>' + esc(s.claudeCode.baseUrl || 'not set') + '</code>'],
      ['Settings', '<code>' + esc(s.claudeCode.settingsPath) + '</code>']
    ]);
  }

  var TOKEN = ${safeToken};

  function api(path, method) {
    return fetch(path, {
      method: method || 'GET',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN }
    })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error && j.error.message || r.statusText); return j; }); });
  }

  function refresh() {
    return api('/admin/status').then(render).catch(function (e) {
      $('account').innerHTML = '<p class="empty">' + dot('bad') + esc(e.message) + '</p>';
    });
  }

  function show(text) { var o = $('output'); o.hidden = false; o.textContent = text; }

  function busy(btn, fn) {
    btn.disabled = true;
    return Promise.resolve(fn()).finally(function () { btn.disabled = false; });
  }

  $('diagnose').addEventListener('click', function () {
    busy(this, function () {
      show('Running diagnostics…');
      return api('/admin/doctor', 'POST').then(function (r) { show(r.report); }).catch(function (e) { show('Error: ' + e.message); });
    });
  });
  $('restart').addEventListener('click', function () {
    busy(this, function () {
      show('Restarting Codex App Server…');
      return api('/admin/restart', 'POST').then(function () { show('Restarted.'); return refresh(); }).catch(function (e) { show('Error: ' + e.message); });
    });
  });
  $('connect').addEventListener('click', function () {
    busy(this, function () {
      show('Starting ChatGPT sign-in… a browser window should open.');
      return api('/admin/login', 'POST').then(function (r) {
        show(r.url ? ('If no browser opened, visit:\\n' + r.url + (r.userCode ? '\\n\\nCode: ' + r.userCode : '')) : 'Sign-in started.');
        return poll();
      }).catch(function (e) { show('Error: ' + e.message); });
    });
  });
  $('disconnect').addEventListener('click', function () {
    if (!confirm('Disconnect this ChatGPT account from Codex?')) return;
    busy(this, function () {
      return api('/admin/logout', 'POST').then(function () { show('Disconnected.'); return refresh(); }).catch(function (e) { show('Error: ' + e.message); });
    });
  });

  function poll() {
    var tries = 0;
    return new Promise(function (resolve) {
      var iv = setInterval(function () {
        tries += 1;
        api('/admin/status').then(function (s) {
          render(s);
          if (s.account.connected || tries > 150) { clearInterval(iv); resolve(); }
        }).catch(function () {});
      }, 2000);
    });
  }

  refresh();
  setInterval(refresh, 15000);
})();
</script>
</body>
</html>`;
}
