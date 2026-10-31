/* Saved Card Finder — Gmail scan (read-only, client-side).
   Reads ONLY the From: and Subject: headers of messages matching receipt searches. Never requests bodies, snippets,
   recipients or attachments (format=metadata + metadataHeaders=From,Subject + fields=payload/headers strips the rest).
   Token and results live in memory only. Pure logic is exported for Node tests; fetch/sleep are injectable. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SCFGmail = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var API = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
  var SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
  // Several searches, unioned by message ID. No date limit. Results are filtered again locally (js/extract.js).
  var QUERIES = [
    { tag: 'purchases', q: 'category:purchases' },
    { tag: 'subject', q: 'subject:(receipt OR order OR invoice OR payment OR subscription OR renewal OR billing OR "thank you for your purchase" OR "your order" OR confirmation OR refund OR trial OR "payment method" OR card OR booking OR tickets OR membership)' },
    { tag: 'from', q: 'from:(billing OR receipts OR receipt OR orders OR order OR payments OR payment OR invoice OR invoices OR noreply-payments OR paypal OR stripe OR paddle OR fastspring OR gumroad OR lemonsqueezy OR patreon OR klarna OR clearpay OR squareup OR sumup OR shopify OR googleplay-noreply OR itunes)' }
  ];
  var DEFAULT_QUERY = QUERIES.map(function (x) { return x.q; }).join(' | ');
  var BATCH_URL = 'https://gmail.googleapis.com/batch/gmail/v1';
  var DEFAULT_MAX = 5000, DEEP_MAX = 20000, PAGE_SIZE = 500;
  // Pacing. Gmail allows 250 quota units/s per user and messages.get costs 5, but bursts and parallel requests still
  // trip 429s well below that, so start gently and adapt (AIMD: halve on a rate-limit, creep back up on success).
  var CONCURRENCY = 5, RATE = 15, MAX_RATE = 25, MIN_RATE = 1; // RATE = messages.get per second
  var BATCH_SIZE = 20;            // sub-requests per batch call (Google recommends <= 50)
  var MAX_RETRIES = 6;            // per message; after that it is skipped and counted
  var BACKOFF_CAP = 60000;        // ms
  var STALL_MS = 120000;          // no progress for this long -> finish with partial results
  var REQUEST_TIMEOUT = 30000;    // a single HTTP call that hangs this long is retried
  var EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9\-]+(?:\.[a-z0-9\-]+)+/i;

  function GmailError(code, message, status) { var e = new Error(message); e.code = code; e.status = status; return e; }

  /** 'Amazon.co.uk <auto-confirm@amazon.co.uk>' -> {email, display}. Returns null if no address. */
  function parseFromHeader(value) {
    if (!value) return null;
    var m = EMAIL_RE.exec(value);
    if (!m) return null;
    var display = value.replace(m[0], '').replace(/[<>"]/g, '').trim();
    return { email: m[0].toLowerCase(), display: display };
  }

  /** Pull the From value out of a users.messages.get (format=metadata) response. */
  function headerOf(msg, name) {
    var hs = (msg && msg.payload && msg.payload.headers) || [];
    for (var i = 0; i < hs.length; i++) if (String(hs[i].name).toLowerCase() === name) return hs[i].value;
    return null;
  }
  function fromOfMessage(msg) { return headerOf(msg, 'from'); }

  /** Aggregate From values into [{email, display, count}] sorted by count desc. */
  function aggregate(fromValues) {
    var map = {};
    fromValues.forEach(function (v) {
      var p = parseFromHeader(v); if (!p) return;
      if (!map[p.email]) map[p.email] = { email: p.email, display: p.display, count: 0 };
      map[p.email].count++;
      if (!map[p.email].display && p.display) map[p.email].display = p.display;
    });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.count - a.count; });
  }

  function defaultSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function errorInfo(status, body) {
    var err = (body && body.error) || {}, reason = ((err.errors || [])[0] || {}).reason || err.status || '';
    var limited = status === 429 || status >= 500 || status === 0 ||
      (status === 403 && /rateLimit|RESOURCE_EXHAUSTED|quotaExceeded|concurrent/i.test(reason + ' ' + (err.message || '')));
    return { limited: limited, message: err.message || '' };
  }

  // ---- shared pacer: one gate + one token bucket for every worker (no thundering herd) ----
  function makePacer(ctx) {
    return { rate: Math.min(ctx.rateStart, ctx.maxRate), maxRate: ctx.maxRate, conc: ctx.concurrency, maxConc: ctx.concurrency,
      next: 0, pausedUntil: 0, strikes: 0, okSince: 0, events: 0 };
  }
  /** Wait for the global pause (if any), then for a slot for n messages at the current adaptive rate. */
  function pace(ctx, n) {
    var p = ctx.p, gateMs = p.pausedUntil - ctx.now();
    return (gateMs > 0 ? ctx.sleep(gateMs) : Promise.resolve()).then(function () {
      if (!ctx.rate) return;
      var now = ctx.now(), slot = Math.max(now, p.next, p.pausedUntil);
      p.next = slot + n * 1000 / p.rate;
      if (slot > now) return ctx.sleep(slot - now);
    });
  }
  /** A rate-limit happened: set ONE shared pause (Retry-After or exp. backoff + jitter, cap 60s) and halve rate + concurrency. */
  function limited(ctx, retryAfterMs) {
    var p = ctx.p, now = ctx.now();
    if (now < p.pausedUntil) { // already backing off because of another worker's 429: don't double-cut
      if (retryAfterMs > 0 && now + retryAfterMs > p.pausedUntil) p.pausedUntil = now + Math.min(retryAfterMs, BACKOFF_CAP);
      return;
    }
    p.strikes++; p.events++;
    var wait = retryAfterMs > 0 ? retryAfterMs : Math.min(BACKOFF_CAP, 1000 * Math.pow(2, p.strikes - 1)) + Math.floor(ctx.random() * 1000);
    wait = Math.min(wait, BACKOFF_CAP);
    p.pausedUntil = now + wait; p.next = Math.max(p.next, p.pausedUntil);
    p.rate = Math.max(MIN_RATE, p.rate / 2); p.conc = Math.max(1, Math.floor(p.conc / 2)); p.okSince = 0;
    if (ctx.onRetry) ctx.onRetry(wait, { until: p.pausedUntil, rate: p.rate, concurrency: p.conc, strikes: p.strikes });
  }
  function succeeded(ctx, n) {
    var p = ctx.p;
    if (!n) return;
    p.strikes = 0; p.okSince += n;
    p.rate = Math.min(p.maxRate, p.rate + 0.05 * n);           // +1 msg/s per ~20 successes
    if (p.okSince >= 50 && p.conc < p.maxConc) { p.conc++; p.okSince = 0; }
  }

  /** One HTTP call with a timeout; resolves {status, body, retryAfter, res}. Network errors/timeouts become status 0. */
  function call(ctx, url, init) {
    if (ctx.signal && ctx.signal.aborted) return Promise.reject(GmailError('aborted', 'Scan stopped.'));
    if (ctx.stopped) return Promise.reject(GmailError('stopped', 'Scan stopped.'));
    var ac = typeof AbortController === 'function' ? new AbortController() : null, timer = null;
    function kill() { if (ac) ac.abort(); }
    if (ac) {
      if (ctx.signal) ctx.signal.addEventListener('abort', kill);
      ctx.inflight.push(kill);
      timer = setTimeout(kill, ctx.timeout);
    }
    init = init || {};
    init.headers = init.headers || {}; init.headers.Authorization = 'Bearer ' + ctx.token;
    init.signal = ac ? ac.signal : ctx.signal;
    function cleanup() {
      if (timer) clearTimeout(timer);
      if (ac && ctx.signal) ctx.signal.removeEventListener('abort', kill);
      var i = ctx.inflight.indexOf(kill); if (i !== -1) ctx.inflight.splice(i, 1);
    }
    return Promise.resolve().then(function () { return ctx.fetch(url, init); }).then(function (res) {
      cleanup();
      if (ctx.stopped) throw GmailError('stopped', 'Scan stopped.');
      var ra = res.headers && res.headers.get && parseFloat(res.headers.get('Retry-After'));
      return { status: res.status, ok: res.ok, res: res, retryAfter: ra > 0 ? ra * 1000 : 0 };
    }, function (e) {
      cleanup();
      if (e && e.code === 'stopped') throw e;
      if (ctx.signal && ctx.signal.aborted) throw GmailError('aborted', 'Scan stopped.');
      if (ctx.stopped) throw GmailError('stopped', 'Scan stopped.');
      return { status: 0, ok: false, error: e, retryAfter: 0 };
    });
  }
  function readJson(r) {
    if (!r.res) return Promise.resolve({});
    return r.res.json().catch(function () { return {}; });
  }

  /** GET with retries (used for listing, which is sequential). Shares the pacer and watchdog with the readers. */
  function apiGet(url, ctx, attempt) {
    attempt = attempt || 0;
    if (!ctx.p) ctx.p = makePacer(ctx);
    return pace(ctx, 1).then(function () { return call(ctx, url); }).then(function (r) {
      return readJson(r).then(function (body) {
        if (r.ok) { ctx.p.strikes = 0; ctx.lastProgress = ctx.now(); return body; }
        var info = errorInfo(r.status, body);
        if (r.status === 401) throw GmailError('expired', 'Your Google session expired. Please connect again.', 401);
        if (info.limited) {
          if (attempt >= MAX_RETRIES || ctx.now() - ctx.lastProgress > ctx.stallMs)
            throw GmailError('rate_limited', 'Gmail is busy (rate limit). Wait a minute and press Scan again.', r.status);
          limited(ctx, r.retryAfter);
          return apiGet(url, ctx, attempt + 1);
        }
        if (r.status === 403) throw GmailError('forbidden', info.message || 'Google refused access to Gmail.', 403);
        throw GmailError('http', 'Gmail API error ' + r.status + (info.message ? ': ' + info.message : ''), r.status);
      });
    });
  }

  /** List IDs for one query (newest first), up to max. */
  function listOne(query, ctx) {
    var ids = [];
    function page(token) {
      var n = Math.min(PAGE_SIZE, ctx.max - ids.length);
      var url = API + '?q=' + encodeURIComponent(query) + '&maxResults=' + n + '&fields=' + encodeURIComponent('messages(id),nextPageToken,resultSizeEstimate') +
        (token ? '&pageToken=' + encodeURIComponent(token) : '');
      return apiGet(url, ctx).then(function (body) {
        (body.messages || []).forEach(function (m) { if (ids.length < ctx.max) ids.push(m.id); });
        if (ctx.onProgress) ctx.onProgress({ phase: 'list', found: ctx._listed + ids.length });
        if (body.nextPageToken && ids.length < ctx.max) return page(body.nextPageToken);
        return { ids: ids, more: !!body.nextPageToken };
      }, function (e) {
        // Out of retries mid-listing: keep what this query already found, mark the scan incomplete.
        if (e.code === 'rate_limited' && ids.length) { ctx.listIncomplete = true; ctx.listError = e; return { ids: ids, more: true }; }
        throw e;
      });
    }
    return page(null);
  }

  /** Run every query, then union: interleave so each query's newest mail survives the cap. */
  function listIds(ctx) {
    var per = [], more = false;
    ctx._listed = 0;
    return ctx.queries.reduce(function (p, q) {
      return p.then(function () {
        if (ctx.listError) return; // Gmail kept refusing: don't hammer it with the remaining searches
        return listOne(q.q, ctx).then(function (r) { per.push({ tag: q.tag, ids: r.ids }); ctx._listed += r.ids.length; more = more || r.more; }, function (e) {
          if (e.code === 'rate_limited') { ctx.listIncomplete = true; ctx.listError = e; return; } // try the other queries
          throw e;
        });
      });
    }, Promise.resolve()).then(function () {
      if (!per.length && ctx.listError) throw ctx.listError;
      var tags = {}, order = [], longest = Math.max.apply(null, per.map(function (x) { return x.ids.length; }).concat([0]));
      for (var i = 0; i < longest; i++) {
        per.forEach(function (x) {
          var id = x.ids[i]; if (id === undefined) return;
          if (!tags[id]) { tags[id] = []; order.push(id); }
          if (tags[id].indexOf(x.tag) === -1) tags[id].push(x.tag);
        });
      }
      var truncated = more || order.length > ctx.max;
      order = order.slice(0, ctx.max);
      return { ids: order, tags: tags, truncated: truncated, listed: ctx._listed };
    });
  }

  var GET_QS = '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&fields=' + encodeURIComponent('payload/headers');
  function getPath(id) { return '/gmail/v1/users/me/messages/' + encodeURIComponent(id) + GET_QS; }

  /** multipart/mixed body for the Gmail batch endpoint. */
  function buildBatch(ids, boundary) {
    return ids.map(function (id, i) {
      return '--' + boundary + '\r\nContent-Type: application/http\r\nContent-ID: <item-' + i + '>\r\n\r\nGET ' + getPath(id) + '\r\n\r\n';
    }).join('') + '--' + boundary + '--\r\n';
  }
  /** Parse a batch response into [{index, status, body, retryAfter}]. Throws if it isn't a multipart response. */
  function parseBatch(text, contentType) {
    var m = /boundary="?([^";\s]+)"?/i.exec(contentType || '');
    if (!m) throw new Error('not multipart');
    var out = [];
    String(text).split('--' + m[1]).forEach(function (part) {
      var st = /HTTP\/1\.[01] (\d{3})/.exec(part); if (!st) return;
      var cid = /Content-ID:\s*<?response-item-(\d+)>?/i.exec(part);
      var rest = part.slice(st.index), sep = rest.search(/\r?\n\r?\n/);
      var head = sep === -1 ? rest : rest.slice(0, sep), raw = sep === -1 ? '' : rest.slice(sep).trim();
      var ra = /Retry-After:\s*(\d+)/i.exec(head), body = {};
      if (raw) { try { body = JSON.parse(raw); } catch (e) { body = {}; } }
      out.push({ index: cid ? +cid[1] : out.length, status: +st[1], body: body, retryAfter: ra ? +ra[1] * 1000 : 0 });
    });
    if (!out.length) throw new Error('empty batch');
    return out;
  }

  /**
   * Fetch From + Subject for every ID. Never fails the whole scan because of rate limits: each message is retried up to
   * MAX_RETRIES times behind the shared pause, then skipped and counted. A watchdog finishes with partial results if
   * nothing completes for stallMs.
   */
  function fetchHeaders(ids, tags, ctx) {
    var out = [], done = 0, failed = 0, skipped = 0, ok = 0, busy = 0, fatal = null;
    var queue = ids.map(function (id) { return { id: id, tries: 0 }; });
    var lastPartial = 0;
    ctx.lastProgress = ctx.now();

    function progress() {
      if (ctx.onProgress) ctx.onProgress({ phase: 'read', done: done, total: ids.length, read: ok, skipped: skipped, failed: failed, headers: out });
      if (ctx.onPartial && (ok - lastPartial >= 100 || done === ids.length)) { lastPartial = ok; ctx.onPartial(out); }
    }
    function gotMessage(item, msg) {
      var f = fromOfMessage(msg); if (f) out.push({ from: f, subject: headerOf(msg, 'subject') || '', tags: tags[item.id] || [] });
      ok++; done++; ctx.lastProgress = ctx.now(); // only real answers count as progress for the watchdog (not skips)
    }
    function retryOrSkip(item) {
      item.tries++;
      if (item.tries > MAX_RETRIES) { skipped++; done++; return true; }
      queue.push(item); return false;
    }
    /** Apply one per-message result; returns 'ok' | 'limited' | 'done'. */
    function apply(item, status, body) {
      if (status >= 200 && status < 300) { gotMessage(item, body); return 'ok'; }
      if (status === 401) { fatal = GmailError('expired', 'Your Google session expired. Please connect again.', 401); return 'done'; }
      if (errorInfo(status, body).limited) { retryOrSkip(item); return 'limited'; }
      failed++; done++; ctx.lastProgress = ctx.now(); return 'done'; // deleted / odd message: skip it
    }

    function single(item) {
      return pace(ctx, 1).then(function () { return call(ctx, API + '/' + encodeURIComponent(item.id) + GET_QS); }).then(function (r) {
        return readJson(r).then(function (body) {
          var res = apply(item, r.status, body);
          if (res === 'limited') limited(ctx, r.retryAfter); else if (res === 'ok') succeeded(ctx, 1);
          progress();
        });
      });
    }

    function batch(items) {
      var boundary = 'scf_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      return pace(ctx, items.length).then(function () {
        return call(ctx, BATCH_URL, { method: 'POST', headers: { 'Content-Type': 'multipart/mixed; boundary=' + boundary }, body: buildBatch(items.map(function (x) { return x.id; }), boundary) });
      }).then(function (r) {
        if (r.status === 401) { fatal = GmailError('expired', 'Your Google session expired. Please connect again.', 401); return; }
        function fallback() { ctx.batch = false; items.forEach(function (x) { queue.unshift(x); }); } // batch unusable here -> plain GETs
        if (!r.ok) {
          return readJson(r).then(function (body) {
            if (ctx.batchWorks && errorInfo(r.status, body).limited) { items.forEach(retryOrSkip); limited(ctx, r.retryAfter); progress(); }
            else fallback();
          });
        }
        return r.res.text().then(function (text) {
          var parts;
          try { parts = parseBatch(text, r.res.headers && r.res.headers.get && r.res.headers.get('Content-Type')); } catch (e) { fallback(); return; }
          ctx.batchWorks = true;
          var seen = {}, anyLimited = false, ra = 0, okN = 0;
          parts.forEach(function (pt) {
            var item = items[pt.index]; if (!item || seen[pt.index]) return; seen[pt.index] = true;
            var res = apply(item, pt.status, pt.body);
            if (res === 'limited') { anyLimited = true; ra = Math.max(ra, pt.retryAfter); } else if (res === 'ok') okN++;
          });
          items.forEach(function (item, i) { if (!seen[i]) { anyLimited = true; retryOrSkip(item); } }); // missing parts: retry
          succeeded(ctx, okN);
          if (anyLimited) limited(ctx, ra);
          progress();
        }, function () { fallback(); });
      });
    }

    function worker(i) {
      if (fatal || ctx.stopped) return Promise.resolve();
      if (ctx.now() - ctx.lastProgress > ctx.stallMs) { ctx.stopped = true; ctx.stalled = true; return Promise.resolve(); }
      var limit = ctx.batch ? Math.min(ctx.p.conc, 2) : ctx.p.conc;
      if (!queue.length || i >= limit) {
        if (!queue.length && busy === 0) return Promise.resolve(); // all finished
        return ctx.sleep(ctx.idleMs).then(function () { return worker(i); });
      }
      var job, items;
      if (ctx.batch) { items = queue.splice(0, Math.max(1, Math.min(BATCH_SIZE, Math.round(ctx.p.rate)))); job = batch(items); }
      else { items = [queue.shift()]; job = single(items[0]); }
      busy++;
      return job.then(function () { busy--; }, function (e) {
        busy--;
        if (e.code === 'aborted') { fatal = e; return; }
        if (e.code === 'stopped') return;
        items.forEach(retryOrSkip); progress(); // unexpected: treat like a transient failure
      }).then(function () { return worker(i); });
    }

    var workers = [];
    for (var i = 0; i < Math.min(ctx.p.maxConc, ids.length); i++) workers.push(worker(i));
    // Real-time watchdog too, in case a request hangs past every timeout.
    var timerId = null;
    var watchdog = new Promise(function (resolve) {
      timerId = setInterval(function () {
        if (ctx.now() - ctx.lastProgress > ctx.stallMs) { ctx.stopped = true; ctx.stalled = true; }
        if (ctx.stopped || fatal) resolve();
      }, 1000);
    });
    return Promise.race([Promise.all(workers), watchdog]).then(function () {
      clearInterval(timerId);
      if (ctx.stopped) ctx.inflight.slice().forEach(function (k) { k(); });
      if (fatal) throw fatal;
      if (ctx.signal && ctx.signal.aborted) throw GmailError('aborted', 'Scan stopped.');
      return { messages: out, failed: failed, skipped: skipped, read: ok, unread: ids.length - done, stalled: !!ctx.stalled };
    });
  }

  /**
   * Full scan. opts: { token (required), fetch, sleep, now, random, queries|query, max, concurrency, rate, maxRate, batch,
   *   stallMs, onProgress, onRetry(waitMs, {until}), onPartial(headers), signal }
   * Resolves { messages: listed count, read, headers: [{from, subject, tags}], senders, truncated, failed, skipped, unread,
   *   stalled, partial }. headers live in memory only; the caller passes them to SCFExtract and drops them.
   */
  function scan(opts) {
    var ctx = {
      token: opts.token, fetch: opts.fetch || (typeof fetch === 'function' ? function (u, o) { return fetch(u, o); } : null),
      sleep: opts.sleep || defaultSleep, now: opts.now || function () { return Date.now(); }, random: opts.random || Math.random,
      queries: opts.queries || (opts.query ? [{ tag: 'custom', q: opts.query }] : QUERIES), max: opts.max || DEFAULT_MAX,
      concurrency: opts.concurrency || CONCURRENCY, rate: opts.rate === undefined ? RATE : opts.rate,
      rateStart: opts.rate || RATE, maxRate: opts.maxRate || Math.max(MAX_RATE, opts.rate || 0),
      batch: opts.batch === undefined ? true : !!opts.batch, stallMs: opts.stallMs || STALL_MS, timeout: opts.timeout || REQUEST_TIMEOUT,
      idleMs: opts.idleMs || 250, inflight: [],
      onProgress: opts.onProgress, onRetry: opts.onRetry, onPartial: opts.onPartial, signal: opts.signal
    };
    if (!ctx.token) return Promise.reject(GmailError('no_token', 'Not connected to Google.'));
    ctx.p = makePacer(ctx); ctx.lastProgress = ctx.now();
    return listIds(ctx).then(function (l) {
      return fetchHeaders(l.ids, l.tags, ctx).then(function (r) {
        return { messages: l.ids.length, read: r.read, headers: r.messages, senders: aggregate(r.messages.map(function (m) { return m.from; })),
          truncated: l.truncated, failed: r.failed, skipped: r.skipped, unread: r.unread, stalled: r.stalled,
          listIncomplete: !!ctx.listIncomplete, partial: !!(r.stalled || r.skipped || r.unread || ctx.listIncomplete),
          batch: !!ctx.batchWorks, rateEvents: ctx.p.events };
      });
    });
  }

  /** Map GIS / API errors to friendly copy. */
  function friendlyError(e) {
    var t = (e && (e.type || e.error || e.code)) || 'unknown';
    switch (t) {
      case 'popup_failed_to_open': return 'Your browser blocked the Google sign-in pop-up. Allow pop-ups for this site, then press Connect again.';
      case 'popup_closed': return 'The Google window closed before you finished. If it said "Access blocked" (Error 403: access_denied), that Gmail address isn\'t on your access list yet: see the note above.';
      case 'access_denied': return 'Google access wasn\'t granted. You pressed Cancel, or this Gmail address isn\'t on your access list yet: see the note above.';
      case 'scope_missing': return 'You need to tick "View your email messages and settings" on Google\'s screen. We only use it to read sender addresses. Please connect again.';
      case 'interaction_required': case 'consent_required': return 'Google needs you to confirm access. Press Connect again.';
      case 'gis_unavailable': return 'Couldn\'t load Google sign-in (offline, or blocked by an ad/privacy blocker). Try again, or turn the blocker off for this site.';
      default: return (e && e.message) || 'Something went wrong talking to Google. Please try again.';
    }
  }

  return { SCOPE: SCOPE, QUERIES: QUERIES, DEFAULT_QUERY: DEFAULT_QUERY, DEFAULT_MAX: DEFAULT_MAX, DEEP_MAX: DEEP_MAX, headerOf: headerOf, API: API, parseFromHeader: parseFromHeader,
    fromOfMessage: fromOfMessage, aggregate: aggregate, scan: scan, friendlyError: friendlyError, _apiGet: apiGet,
    BATCH_URL: BATCH_URL, buildBatch: buildBatch, parseBatch: parseBatch, MAX_RETRIES: MAX_RETRIES, STALL_MS: STALL_MS };
});
