/* Saved Card Finder — UI. All state stays in this tab + localStorage. The only network calls are the optional
   Gmail scan, which goes straight from this browser to Google (see js/gmail.js). */
(function () {
  'use strict';
  var CFG = window.SCF_CONFIG || {}, DB = window.SHOPS_DB, M = window.SCFMatch, X = window.SCFExtract;
  var idx = M.buildIndex(DB);
  var LS = { done: 'scf.done.v1', access: 'scf.access.v1', input: 'scf.input.v1' };
  var $ = function (s) { return document.querySelector(s); };
  var state = { result: null, mailItems: null, gmailItems: null, mailLog: null, gmailLog: null, gmailStats: null };

  function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  var done = load(LS.done, {});
  // Access mode: index.html?access=1 (or #access) is the sign-in link we email buyers. Remembered on this device.
  // Everyone with access sees the full checklist; the landing page only sells access (no Gmail button).
  function hasAccess() { return load(LS.access, false) === true; }
  function isUnlocked() { return hasAccess(); }
  function paymentLive() { return !!CFG.PAYMENT_URL && !/REPLACE|example/i.test(CFG.PAYMENT_URL); }

  function toast(msg) {
    var t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2200);
  }
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k]; else if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }

  var BADGE = { high: 'direct link', medium: 'direct link*', low: 'account page', search: 'search' };
  // One checklist: known shops (card wallets/hubs first), then shops not in our list as 'search' rows.
  function checklist(r) {
    var known = r.matched.slice().sort(function (a, b) { return (b.shop.category === 'hub') - (a.shop.category === 'hub'); });
    return known.concat(r.rows.slice(r.matched.length));
  }
  var BADGE_TITLE = { high: 'Goes straight to the saved cards page', medium: 'Goes to the cards/billing page (may ask you to pick a section)', low: 'Opens your account/app page — follow the steps', search: 'Not in our list yet — searches the shop\'s site for its saved cards page' };

  function render() {
    var r = state.result; if (!r) return;
    var unlocked = isUnlocked(), free = CFG.FREE_RESULTS || 3;
    var list = $('#list'), pw = $('#paywall');
    list.parentNode.insertBefore(pw, list.nextSibling); // park it outside before clearing
    list.innerHTML = '';
    // Hubs (PayPal, Google, Apple…) first: one removal there covers many shops.
    var items = checklist(r);
    items.forEach(function (m, i) {
      var s = m.shop, locked = !unlocked && i >= free;
      var li = el('li', { class: 'item' + (locked ? ' locked' : '') + (done[s.id] ? ' done' : ''), 'data-id': s.id });
      var cb = el('input', { type: 'checkbox', 'aria-label': 'Done: ' + s.name });
      cb.checked = !!done[s.id]; if (locked) cb.disabled = true;
      cb.addEventListener('change', function () {
        if (cb.checked) done[s.id] = Date.now(); else delete done[s.id];
        store(LS.done, done); li.classList.toggle('done', cb.checked); updateProgress();
      });
      var bank = s.category === 'bank';
      var nameRow = el('div', {}, [el('span', { class: 'name', text: s.name }),
        bank ? el('span', { class: 'badge bank', text: 'bank/card issuer — manage in app', title: 'This is the bank that issued a card. Manage or block merchants in its app.' })
          : el('span', { class: 'badge ' + s.confidence, text: BADGE[s.confidence], title: BADGE_TITLE[s.confidence] })]);
      // Locked rows get no real href so the links can't just be read from the page.
      var a = el('a', { class: 'open', href: locked ? '#' : s.url, target: '_blank', rel: 'noopener noreferrer', text: s.guessed ? 'Find saved cards page ↗' : bank ? 'Open bank ↗' : 'Open saved cards page ↗' });
      if (locked) a.setAttribute('tabindex', '-1');
      var meta = el('div', { class: 'meta' }, [
        s.steps ? el('span', { class: 'steps', text: '→ ' + s.steps }) : null,
        s.notes ? el('span', { text: s.notes }) : null,
        s.altUrl && !locked ? el('a', { class: 'alt', href: s.altUrl, target: '_blank', rel: 'noopener noreferrer', text: 'or search Google ↗' }) : null,
        el('div', { class: 'from', text: (s.guessed ? 'From: ' : 'Matched: ') + m.inputs.slice(0, 3).join(', ') + (m.inputs.length > 3 ? ' +' + (m.inputs.length - 3) : '') + (m.count > 1 ? ' (' + m.count + ' emails)' : '') })
      ]);
      li.appendChild(el('label', { class: 'done-box' }, [cb, 'Done']));
      li.appendChild(nameRow); li.appendChild(a); li.appendChild(meta);
      list.appendChild(li);
    });
    var lockedN = unlocked ? 0 : Math.max(0, items.length - free);
    pw.hidden = lockedN === 0;
    // Put the unlock box right after the free rows, and only tease a few blurred rows below it.
    var lockedRows = list.querySelectorAll('.item.locked');
    if (lockedRows.length) list.insertBefore(pw, lockedRows[0]);
    for (var k = 4; k < lockedRows.length; k++) lockedRows[k].remove();
    $('#locked-count').textContent = '+' + lockedN;

    $('#results').hidden = false;
    updateProgress();
    renderStats(); renderSenders();
  }

  // ---- Scan stats + "Show all senders found" (local only, never sent anywhere) ----
  function senderLog() { return (state.gmailLog || []).concat(state.mailLog || []); }
  function renderStats() {
    var box = $('#scan-stats'); if (!box) return;
    var log = senderLog(), r = state.result;
    if (!log.length) { box.hidden = true; return; }
    var msgs = (state.gmailStats ? state.gmailStats.messages : 0) + (state.mailStats ? state.mailStats.messages : 0);
    var used = log.filter(function (x) { return x.status === 'used'; }).length;
    box.hidden = false;
    box.textContent = msgs.toLocaleString() + ' emails scanned · ' + log.length.toLocaleString() + ' unique senders · ' + used.toLocaleString() +
      ' looked like shops · ' + r.rows.length.toLocaleString() + ' shops on your list (' + r.matched.length + ' known, ' + (r.rows.length - r.matched.length) + ' to search)';
    $('#senders-wrap').hidden = false;
  }
  function shopFor(rec) {
    var r = state.result; if (!r) return '';
    var keys = [rec.email].concat(rec.merchants || []).map(function (k) { return String(k).toLowerCase(); });
    var out = [];
    for (var i = 0; i < r.rows.length; i++) {
      var inp = r.rows[i].inputs.join('\n').toLowerCase();
      for (var j = 0; j < keys.length; j++) if (keys[j] && inp.indexOf(keys[j]) !== -1) { out.push(r.rows[i].shop.name + (r.rows[i].shop.guessed ? ' (search)' : '')); break; }
    }
    return out.join(', ');
  }
  function senderRows() {
    return senderLog().slice().sort(function (a, b) { return b.count - a.count; }).map(function (x) {
      return { domain: x.domain, email: x.email, name: x.display || '', count: x.count, receipts: x.receipts, via: x.via || '',
        merchants: (x.merchants || []).join('; '), status: x.status, reason: x.reason || '', shop: x.status === 'used' ? shopFor(x) : '' };
    });
  }
  function renderSenders() {
    var tb = $('#senders-body'); if (!tb) return;
    tb.innerHTML = '';
    if (!$('#senders-toggle').checked) { $('#senders-table').hidden = true; return; }
    $('#senders-table').hidden = false;
    var f = ($('#senders-filter').value || 'all');
    senderRows().forEach(function (x) {
      if (f === 'used' && x.status !== 'used') return;
      if (f === 'skipped' && x.status === 'used') return;
      if (f === 'nomatch' && !(x.status === 'used' && /\(search\)/.test(x.shop))) return;
      tb.appendChild(el('tr', { class: x.status }, [
        el('td', { text: x.domain, title: x.email }), el('td', { text: x.name }), el('td', { class: 'num', text: String(x.count) }),
        el('td', { class: 'num', text: String(x.receipts) }),
        el('td', { text: (x.via ? 'via ' + x.via + (x.merchants ? ': ' : '') : '') + x.merchants }),
        el('td', { text: x.status === 'used' ? (x.shop || 'used') : 'skipped: ' + x.reason })
      ]));
    });
  }
  function sendersCsv() {
    var q = function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var out = ['domain,sender,display_name,emails,receipt_like,via,merchants,status,reason,matched_to'];
    senderRows().forEach(function (x) { out.push([x.domain, x.email, x.name, x.count, x.receipts, x.via, x.merchants, x.status, x.reason, x.shop].map(q).join(',')); });
    return out.join('\n');
  }

  function updateProgress() {
    var r = state.result; if (!r) return;
    var total = r.rows.length, n = r.rows.filter(function (m) { return done[m.shop.id]; }).length;
    $('#progress-text').textContent = total ? n + ' of ' + total + ' done' : 'No known shops matched yet';
    $('#progress-bar').style.width = total ? (100 * n / total) + '%' : '0';
  }

  function run(scroll) {
    var text = $('#input').value;
    store(LS.input, text);
    var items = M.tokenize(text);
    if (state.mailItems) items = items.concat(state.mailItems);
    if (state.gmailItems) items = items.concat(state.gmailItems);
    if (!items.length) { toast('Connect Gmail to scan your receipts first'); return; }
    state.result = M.matchAll(idx, items, { sortByCount: !!(state.mailItems || state.gmailItems) });
    render();
    if (scroll) $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- Copy / print ----
  function copyText(t) {
    function legacy() {
      var ta = el('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) {} finally { ta.remove(); }
    }
    // writeText can reject (page not focused, permission denied): fall back instead of throwing.
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t).catch(legacy);
    legacy(); return Promise.resolve();
  }
  function listAsText() {
    var r = state.result, unlocked = isUnlocked(), free = CFG.FREE_RESULTS || 3, out = ['Saved Card Finder checklist', ''];
    var items = checklist(r);
    items.forEach(function (m, i) {
      if (!unlocked && i >= free) return;
      out.push('[' + (done[m.shop.id] ? 'x' : ' ') + '] ' + m.shop.name + ' - ' + m.shop.url + (m.shop.steps ? '  (' + m.shop.steps + ')' : ''));
    });
    if (!unlocked && items.length > free) out.push('', '+' + (items.length - free) + ' more (locked)');
    return out.join('\n');
  }

  // ---- Mailbox files ----
  function handleFiles(files) {
    if (!files || !files.length) return;
    var bar = $('#file-progress'), status = $('#file-status');
    bar.hidden = false; status.textContent = 'Reading ' + files.length + ' file(s) on your device…';
    window.SCFMbox.parseFiles(files, function (f) { bar.firstElementChild.style.width = Math.round(f * 100) + '%'; })
      .then(function (res) {
        var an = res.analysis;
        state.mailItems = an ? an.items : res.senders.map(function (s) { return { raw: s.email, kind: 'email', display: s.display, count: s.count }; });
        state.mailLog = an ? an.senders : null; state.mailStats = { messages: res.messages };
        status.textContent = 'Read ' + res.messages.toLocaleString() + ' emails from ' + res.senders.length.toLocaleString() + ' senders' +
          (an ? ' (' + an.stats.used + ' look like shops; newsletters and personal mail ignored)' : '') + '. Nothing left your device.';
        run(true);
      }).catch(function (e) { status.textContent = 'Could not read that file: ' + e.message; });
  }

  // ---- Gmail (Google Identity Services token model; token kept in memory only) ----
  var G = window.SCFGmail, gmail = { client: null, token: null, abort: null, busy: false, deep: false, wantDeep: false };
  function gSet(msg, isErr) { var st = $('#gmail-status'); st.textContent = msg || ''; st.classList.toggle('err', !!isErr); }
  function gBar(frac) { var b = $('#gmail-progress'); b.hidden = frac == null; if (frac != null) b.firstElementChild.style.width = Math.round(frac * 100) + '%'; }
  // Errors that usually mean "this Google account isn't on the access list": point at the wrong-account help.
  var WRONG_ACCOUNT = { access_denied: 1, popup_closed: 1, popup_failed_to_open: 1 };
  function gErr(e) {
    var t = (e && (e.type || e.error || e.code)) || '';
    gSet(G.friendlyError(e || {}), true);
    $('#gmail-help').classList.toggle('alert', !!WRONG_ACCOUNT[t]);
  }
  function gButtons() {
    $('#gmail-connect').disabled = !gmail.client || gmail.busy || !$('#gmail-consent').checked;
    $('#gmail-disconnect').hidden = !(gmail.busy || gmail.token || state.gmailItems);
    $('#gmail-deeper').hidden = !(state.gmailStats && state.gmailStats.truncated) || gmail.busy || gmail.deep;
  }
  function revokeToken() {
    var t = gmail.token; gmail.token = null;
    if (t && window.google && google.accounts && google.accounts.oauth2) { try { google.accounts.oauth2.revoke(t, function () {}); } catch (e) {} }
  }
  function initGis() {
    if (!(window.google && google.accounts && google.accounts.oauth2)) return false;
    gmail.client = google.accounts.oauth2.initTokenClient({
      client_id: CFG.GOOGLE_CLIENT_ID,
      scope: G.SCOPE,
      callback: onToken,
      error_callback: function (err) { gmail.busy = false; gBar(null); gErr(err); gButtons(); }
    });
    $('#gmail-hint').hidden = true; gButtons(); return true;
  }
  function loadGis() {
    if (initGis()) return;
    // Loaded at page load (not on click) so requestAccessToken() runs inside the click and isn't popup-blocked.
    var sc = document.createElement('script');
    sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
    sc.onload = function () { if (!initGis()) { $('#gmail-hint').hidden = false; $('#gmail-hint').textContent = G.friendlyError({ type: 'gis_unavailable' }); } };
    sc.onerror = function () { $('#gmail-hint').hidden = false; $('#gmail-hint').textContent = G.friendlyError({ type: 'gis_unavailable' }); };
    document.head.appendChild(sc);
  }
  function onToken(resp) {
    if (!resp || resp.error) { gmail.busy = false; gBar(null); gErr(resp || {}); gButtons(); return; }
    if (google.accounts.oauth2.hasGrantedAllScopes && !google.accounts.oauth2.hasGrantedAllScopes(resp, G.SCOPE)) {
      gmail.token = resp.access_token; revokeToken(); gmail.busy = false; gSet(G.friendlyError({ type: 'scope_missing' }), true); gButtons(); return;
    }
    $('#gmail-help').classList.remove('alert');
    gmail.token = resp.access_token; gmail.abort = new AbortController();
    gSet('Connected. Searching your receipts…'); gBar(0); gButtons();
    var prog = { text: 'Connected. Searching your receipts…' }, pauseUntil = 0, lastLive = 0, myAbort = gmail.abort;
    function showStatus() { // re-run every second so the "resuming in Ns" countdown really counts down
      var left = Math.ceil((pauseUntil - Date.now()) / 1000);
      gSet(prog.text + (left > 0 ? ' · Gmail asked us to slow down, resuming in ' + left + 's…' : ''));
    }
    var ticker = setInterval(showStatus, 1000);
    function live(headers) { // show shops as they're found, at most every 2.5s
      if (myAbort.signal.aborted || !headers.length || Date.now() - lastLive < 2500) return;
      lastLive = Date.now();
      try { var an = X.analyze(headers); state.gmailItems = an.items; state.gmailLog = an.senders; run(false); } catch (e) {}
    }
    G.scan({
      token: gmail.token, signal: gmail.abort.signal,
      max: gmail.wantDeep ? (CFG.GMAIL_DEEP_MAX || G.DEEP_MAX) : (CFG.GMAIL_MAX_MESSAGES || G.DEFAULT_MAX),
      stallMs: CFG.GMAIL_STALL_MS, // optional override of the 2-minute "Gmail is busy" watchdog (tests)
      onProgress: function (p) {
        if (p.phase === 'list') { prog.text = 'Searching your mail: ' + p.found.toLocaleString() + ' possible receipt emails so far…'; gBar(0.02); }
        else {
          prog.text = 'Reading sender + subject lines: ' + p.done.toLocaleString() + ' of ' + p.total.toLocaleString() + (p.skipped ? ' (' + p.skipped + ' skipped)' : '');
          gBar(p.done / p.total);
          if (p.headers) live(p.headers);
        }
        showStatus();
      },
      onRetry: function (ms) { pauseUntil = Math.max(pauseUntil, Date.now() + ms); showStatus(); }
    }).then(function (res) {
      clearInterval(ticker);
      var an = X.analyze(res.headers);
      state.gmailItems = an.items; state.gmailLog = an.senders;
      state.gmailStats = { messages: res.messages, truncated: res.truncated, failed: res.failed, skipped: res.skipped, partial: res.partial };
      gmail.deep = gmail.wantDeep; gmail.wantDeep = false;
      var shops = an.stats.used.toLocaleString() + ' look like shops';
      if (res.partial) {
        gSet('Showed results from ' + res.read.toLocaleString() + ' of ' + res.messages.toLocaleString() + ' emails — Gmail was busy; try Scan again later to fill in the rest. ' +
          '(' + an.stats.senders.toLocaleString() + ' senders, ' + shops + (res.skipped ? '; ' + res.skipped + ' skipped' : '') + '.) Google access revoked; nothing was stored.');
      } else {
        gSet('Scanned ' + res.messages.toLocaleString() + ' emails from ' + an.stats.senders.toLocaleString() + ' senders; ' + shops +
          (res.truncated ? ' (stopped at ' + res.messages.toLocaleString() + ': use "Scan deeper" to go further back)' : '') +
          (res.failed ? '. ' + res.failed + ' emails could not be read' : '') + '. Google access revoked; nothing was stored.');
      }
      if (!res.messages) gSet('No receipt-like emails found in this Gmail account. Google access revoked.');
      run(!lastLive);
    }).catch(function (e) {
      clearInterval(ticker);
      if (e.code !== 'aborted') gSet(G.friendlyError(e), true);
    }).then(function () { revokeToken(); gmail.busy = false; gmail.abort = null; gBar(null); gButtons(); });
  }
  function gmailConnect() {
    if (!gmail.client || gmail.busy) return;
    gmail.busy = true; gSet('Waiting for Google… (a pop-up will open)'); gButtons();
    gmail.client.requestAccessToken(); // must be called synchronously inside the click handler
  }
  function gmailDeeper() {
    if (!gmail.client || gmail.busy) return;
    gmail.wantDeep = true; gmail.busy = true;
    gSet('Waiting for Google… (a pop-up will open) Deeper scans read up to ' + (CFG.GMAIL_DEEP_MAX || G.DEEP_MAX).toLocaleString() + ' emails and take a few minutes.'); gButtons();
    gmail.client.requestAccessToken();
  }
  function gmailDisconnect() {
    if (gmail.abort) gmail.abort.abort();
    revokeToken(); gmail.busy = false; gmail.deep = false; gmail.wantDeep = false; state.gmailItems = null; state.gmailLog = null; state.gmailStats = null; gBar(null);
    gSet('Disconnected. Google access revoked and the scanned senders were cleared from this tab.');
    gButtons();
    if (state.result) { if ($('#input').value.trim() || state.mailItems) run(false); else { state.result = null; $('#results').hidden = true; } }
  }
  function setupGmail() {
    if (!G) return;
    $('#gmail-consent').addEventListener('change', gButtons);
    $('#gmail-connect').addEventListener('click', gmailConnect);
    $('#gmail-disconnect').addEventListener('click', gmailDisconnect);
    $('#gmail-deeper').addEventListener('click', gmailDeeper);
    window.addEventListener('pagehide', revokeToken);
    if (!CFG.GOOGLE_CLIENT_ID) {
      var h = $('#gmail-hint'); h.hidden = false;
      h.textContent = 'Gmail connect isn\'t switched on for this copy yet. (Site owner: add GOOGLE_CLIENT_ID in js/config.js, see docs/GMAIL_SETUP.md.)';
      $('#gmail-box').classList.add('off'); $('#gmail-consent').disabled = true; gButtons(); return;
    }
    $('#gmail-hint').hidden = false; $('#gmail-hint').textContent = 'Loading Google sign-in…';
    loadGis();
  }

  // ---- Wire up ----
  var EXAMPLE = ['auto-confirm@amazon.co.uk', 'From: Uber Receipts <noreply@uber.com>', 'Deliveroo, Just Eat, Netflix',
    'service@paypal.co.uk', 'no_reply@email.apple.com', "Sainsbury's", 'orders@asos.com', 'Trainline', 'steam',
    'Disney Plus', 'vinted.co.uk', 'tesco', 'Grumpy Mule Coffee Roasters', 'hello@smallbatchcandles.co.uk'].join('\n');
  var HUBS = ['PayPal', 'Google Pay', 'Apple', 'Amazon UK', 'Link by Stripe', 'Shop Pay', 'Klarna', 'Clearpay'].join('\n');

  $('#find').addEventListener('click', function () { run(true); });
  $('#example').addEventListener('click', function () { $('#input').value = EXAMPLE; state.mailItems = null; state.mailLog = null; run(true); });
  $('#hubs').addEventListener('click', function () { var v = $('#input').value.trim(); $('#input').value = (v ? v + '\n' : '') + HUBS; run(true); });
  $('#clear').addEventListener('click', function () { $('#input').value = ''; state.mailItems = null; state.mailLog = null; state.mailStats = null; if (state.gmailItems) gmailDisconnect(); gSet(''); state.result = null; store(LS.input, ''); $('#results').hidden = true; $('#file-status').textContent = ''; $('#file-progress').hidden = true; });
  $('#copy').addEventListener('click', function () { copyText(listAsText()).then(function () { toast('Checklist copied'); }); });
  $('#print').addEventListener('click', function () { window.print(); });
  $('#senders-toggle').addEventListener('change', renderSenders);
  $('#senders-filter').addEventListener('change', renderSenders);
  $('#senders-copy').addEventListener('click', function () { copyText(sendersCsv()).then(function () { toast('Sender list copied as CSV'); }); });
  $('#senders-download').addEventListener('click', function () {
    var a = el('a', { href: URL.createObjectURL(new Blob([sendersCsv()], { type: 'text/csv' })), download: 'senders-found.csv' });
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  });
  $('#reset-done').addEventListener('click', function () { done = {}; store(LS.done, done); render(); });
  document.querySelectorAll('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () { copyText($(b.getAttribute('data-copy')).textContent).then(function () { toast('Copied'); }); });
  });
  // ---- Pay first: "Get access" goes to the Stripe Payment Link ----
  function setupBuy() {
    var price = CFG.PRICE_LABEL || '£3';
    document.querySelectorAll('.price').forEach(function (e) { e.textContent = price; });
    ['#buy', '#unlock'].forEach(function (sel) {
      var a = $(sel);
      if (paymentLive()) { a.href = CFG.PAYMENT_URL; return; }
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var m = $('#buy-msg'); m.hidden = false; m.textContent = 'Payments aren\'t switched on yet. Please check back soon.';
        if (sel === '#unlock') toast('Payments aren\'t switched on yet');
      });
    });
  }
  function showMode() {
    var on = hasAccess();
    $('#buy-card').hidden = on;
    $('#input-card').hidden = !on;
  }

  var drop = $('#drop');
  ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  drop.addEventListener('drop', function (e) { handleFiles(e.dataTransfer.files); });
  $('#file').addEventListener('change', function (e) { handleFiles(e.target.files); });

  $('#wipe').addEventListener('click', function () {
    Object.keys(LS).forEach(function (k) { try { localStorage.removeItem(LS[k]); } catch (e) {} });
    done = {}; $('#input').value = ''; state.mailItems = null; state.mailLog = null; state.mailStats = null; if (state.gmailItems || gmail.token) gmailDisconnect();
    state.result = null; $('#results').hidden = true; toast('Deleted everything saved on this device');
  });

  var params = new URLSearchParams(location.search);
  if (params.get('access') === '1' || location.hash === '#access') store(LS.access, true);
  setupBuy(); showMode();
  if (hasAccess()) setupGmail(); // Google sign-in only loads for people with access

  var counts = DB.shops.reduce(function (a, s) { a[s.confidence] = (a[s.confidence] || 0) + 1; return a; }, {});
  $('#db-info').textContent = DB.shops.length + ' shops (' + ((counts.high || 0) + (counts.medium || 0)) + ' with direct links), updated ' + DB.updated;
  if (CFG.SUPPORT_EMAIL) {
    var mail = 'mailto:' + CFG.SUPPORT_EMAIL;
    document.querySelectorAll('.support-mail').forEach(function (a) { a.href = mail; a.textContent = CFG.SUPPORT_EMAIL; });
    document.querySelectorAll('.support-line').forEach(function (e) { e.hidden = false; });
    $('#support').appendChild(document.createTextNode('Help: '));
    $('#support').appendChild(el('a', { href: mail, text: CFG.SUPPORT_EMAIL }));
  }

  // The paste box is hidden now, so don't bring back old pasted text; ?demo=1 still fills the example.
  if (params.get('demo') === '1') $('#input').value = EXAMPLE;
  if ($('#input').value.trim()) run(false);
})();
