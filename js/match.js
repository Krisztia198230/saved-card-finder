/* Saved Card Finder — matching engine. Pure functions, no DOM. Works in the browser (window.SCFMatch) and Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SCFMatch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Personal mailbox providers: a sender at these is a person, not a shop.
  var PERSONAL_DOMAINS = ['gmail.com','googlemail.com','outlook.com','hotmail.com','hotmail.co.uk','live.com','live.co.uk',
    'msn.com','yahoo.com','yahoo.co.uk','ymail.com','icloud.com','me.com','mac.com','aol.com','aol.co.uk','btinternet.com',
    'sky.com','virginmedia.com','talktalk.net','protonmail.com','proton.me','gmx.com','gmx.co.uk','mail.com','zoho.com'];
  // Multi-part public suffixes we care about (UK-heavy). Used to find the "registrable" domain.
  var MULTI_SUFFIXES = ['co.uk','org.uk','ac.uk','gov.uk','me.uk','ltd.uk','plc.uk','com.au','co.nz','co.jp','com.br','co.in'];
  var EMAIL_RE = /[a-z0-9._%+\-]+@([a-z0-9\-]+(?:\.[a-z0-9\-]+)+)/gi;
  var DOMAIN_RE = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9\-]+(?:\.[a-z0-9\-]+)*\.[a-z]{2,})(?:[\/:?#].*)?$/i;
  var STOPWORDS = ['ltd','limited','plc','inc','llc','uk','gb','the','store','shop','online','official','com','co','www',
    'order','orders','receipt','receipts','confirmation','your','from','noreply','no','reply','team','customer','service','services'];

  function normName(s) {
    return String(s || '').toLowerCase()
      .replace(/['’`]/g, '')            // sainsbury's -> sainsburys
      .replace(/&/g, ' and ')
      .replace(/\+/g, ' plus ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim().replace(/\s+/g, ' ');
  }
  function compact(s) { return normName(s).replace(/ /g, ''); }

  function registrable(domain) {
    domain = String(domain).toLowerCase().replace(/^\.+|\.+$/g, '');
    var parts = domain.split('.');
    if (parts.length <= 2) return domain;
    var last2 = parts.slice(-2).join('.');
    if (MULTI_SUFFIXES.indexOf(last2) !== -1) return parts.slice(-3).join('.');
    return last2;
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    var m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    var prev = new Array(n + 1), cur = new Array(n + 1), i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1));
      }
      var t = prev; prev = cur; cur = t;
    }
    return prev[n];
  }

  /** Build lookup indexes from the shops DB once. */
  function buildIndex(db) {
    var shops = db.shops || db;
    var byDomain = {}, byAlias = {}, aliasList = [];
    shops.forEach(function (s) {
      (s.domains || []).forEach(function (d) { d = d.toLowerCase(); if (!byDomain[d]) byDomain[d] = s; });
      var names = [s.name, s.id.replace(/-/g, ' ')].concat(s.aliases || []);
      names.forEach(function (a) {
        var n = normName(a), c = n.replace(/ /g, '');
        if (!n) return;
        if (!byAlias[n]) byAlias[n] = s;
        if (!byAlias[c]) byAlias[c] = s;
        if (!s.exact) aliasList.push({ norm: n, compact: c, shop: s });
      });
    });
    // Longest aliases first so "uber eats" wins over "uber" in free text.
    aliasList.sort(function (x, y) { return y.compact.length - x.compact.length; });
    return { shops: shops, byDomain: byDomain, byAlias: byAlias, aliasList: aliasList };
  }

  /** Look up a domain: exact host, then each parent (email.tesco.com -> tesco.com), then registrable. */
  function matchDomain(idx, domain) {
    domain = domain.toLowerCase();
    var parts = domain.split('.');
    for (var i = 0; i < parts.length - 1; i++) {
      var d = parts.slice(i).join('.');
      if (idx.byDomain[d]) return { shop: idx.byDomain[d], how: 'domain' };
    }
    // Brand label fallback: amazon.de -> "amazon"
    var reg = registrable(domain), label = reg.split('.')[0];
    if (label.length >= 4 && idx.byAlias[label]) return { shop: idx.byAlias[label], how: 'domain-brand' };
    return null;
  }

  function matchName(idx, text) {
    var n = normName(text);
    if (!n) return null;
    var c = n.replace(/ /g, '');
    if (idx.byAlias[n]) return { shop: idx.byAlias[n], how: 'name' };
    if (idx.byAlias[c]) return { shop: idx.byAlias[c], how: 'name' };
    // Strip filler words ("Tesco Groceries Ltd" -> "tesco groceries")
    var stripped = n.split(' ').filter(function (w) { return STOPWORDS.indexOf(w) === -1; }).join(' ');
    if (stripped && idx.byAlias[stripped]) return { shop: idx.byAlias[stripped], how: 'name' };
    // Whole-word alias inside a longer phrase ("Your Deliveroo order" -> Deliveroo). Short aliases (<4) need exact match.
    var padded = ' ' + n + ' ';
    for (var i = 0; i < idx.aliasList.length; i++) {
      var a = idx.aliasList[i];
      if (a.compact.length < 4) continue;
      if (padded.indexOf(' ' + a.norm + ' ') !== -1) return { shop: a.shop, how: 'phrase' };
    }
    // Typo tolerance on the whole (compact) input: 1 edit for 5-7 chars, 2 for 8+.
    var target = stripped ? stripped.replace(/ /g, '') : c;
    if (target.length >= 5) {
      var best = null, bestD = 99;
      for (var j = 0; j < idx.aliasList.length; j++) {
        var al = idx.aliasList[j].compact;
        if (al.length < 5 || Math.abs(al.length - target.length) > 2) continue;
        var d = levenshtein(target, al);
        var max = target.length >= 8 ? 2 : 1;
        if (d <= max && d < bestD) { best = idx.aliasList[j].shop; bestD = d; }
      }
      if (best) return { shop: best, how: 'fuzzy' };
    }
    return null;
  }

  /** Split raw pasted text into candidate items. Handles newline / comma / semicolon lists and raw "From:" header lines. */
  function tokenize(text) {
    var items = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      line = line.trim();
      if (!line) return;
      var emails = [], m;
      EMAIL_RE.lastIndex = 0;
      while ((m = EMAIL_RE.exec(line))) emails.push(m[0]);
      if (emails.length) {
        // A From: line or a line with addresses: use the display name too (helps when the domain is a mailing provider).
        var display = line.replace(/^\s*(from|sender|reply-to)\s*:\s*/i, '').replace(EMAIL_RE, ' ').replace(/[<>"(),;]/g, ' ').trim();
        emails.forEach(function (e) { items.push({ raw: e, kind: 'email', display: display }); });
        return;
      }
      line.replace(/^\s*(from|sender)\s*:\s*/i, '').split(/[,;|\t]+/).forEach(function (p) {
        p = p.trim().replace(/^["'<]+|["'>]+$/g, '');
        if (!p) return;
        var dm = DOMAIN_RE.exec(p);
        if (dm && /\./.test(p) && !/\s/.test(p)) items.push({ raw: p, kind: 'domain', domain: dm[1].toLowerCase() });
        else items.push({ raw: p, kind: 'name' });
      });
    });
    return items;
  }

  function titleCase(str) {
    return str.split(/[\s\-_]+/).filter(Boolean).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  }
  /** Readable shop name for something not in the DB: 'gymshark.com' -> 'Gymshark', 'grumpy-mule.co.uk' -> 'Grumpy Mule'.
      Uses the sender's display name when it clearly is the brand ("Grumpy Mule <hi@grumpymule.co.uk>"). */
  function prettyName(domain, display) {
    var label = registrable(domain).split('.')[0];
    if (display) {
      var d = display.replace(/\s+(via|from|at)\s+.*$/i, '').replace(/\b(ltd|limited|plc|inc|uk|team|store|shop|orders?|receipts?)\b\.?/gi, '').trim();
      var cd = compact(d), cl = compact(label);
      if (d && cd.length >= 3 && (cd === cl || (cl.length >= 4 && cd.indexOf(cl) === 0 && d.length <= 40))) return d;
    }
    return titleCase(label);
  }
  function prettyGuess(item) {
    if (item.kind === 'name') return item.raw;
    var dom = item.kind === 'email' ? item.raw.split('@')[1] : item.domain;
    return prettyName(dom, item.display);
  }
  var GUESS_STEPS = 'Sign in, open Account > Payment methods / Wallet, remove the card';
  function googleSearch(q) { return 'https://www.google.com/search?q=' + encodeURIComponent(q).replace(/%20/g, '+'); }
  /** Search links for an unknown shop: site-restricted search if we know its domain, plus a general one. */
  function searchLinks(name, domain) {
    var general = googleSearch(name + ' remove saved card');
    return { url: domain ? googleSearch('site:' + domain + ' saved cards OR payment methods') : general, general: general };
  }
  /** Turn an unmatched entry into a checklist row shaped like a DB shop (confidence 'search'). */
  function guessShop(u) {
    var links = searchLinks(u.label, u.domain);
    return { id: 'guess:' + u.key, name: u.label, category: 'guess', guessed: true, confidence: 'search',
      domains: u.domain ? [u.domain] : [], url: links.url, altUrl: u.domain ? links.general : null, steps: GUESS_STEPS,
      notes: u.domain ? 'Not in our list yet: the button searches ' + u.domain + ' for its saved cards page.' : 'Not in our list yet: the button searches Google for this shop\'s saved cards page.' };
  }

  /**
   * Main entry. Returns { matched: [{shop, how, inputs:[...], count}], unmatched: [{key, label, domain, inputs, count, searchUrl, generalSearchUrl}],
   *   rows: matched + unmatched-as-search-rows (the single checklist the UI shows), ignored: [...] }
   * `counts` (optional) maps raw item -> occurrences (from mailbox parsing).
   */
  function matchAll(idx, text, opts) {
    opts = opts || {};
    var items = Array.isArray(text) ? text : tokenize(text);
    var matched = {}, order = [], unmatched = {}, uorder = [], ignored = [];
    items.forEach(function (it) {
      var count = it.count || 1, res = null, dom = null;
      if (it.kind === 'email') dom = it.raw.split('@')[1].toLowerCase();
      if (it.kind === 'domain') dom = it.domain;
      if (dom) {
        if (PERSONAL_DOMAINS.indexOf(dom) !== -1) {
          // Personal address — try the display name (e.g. "Etsy via Gmail"), else ignore.
          res = it.display ? matchName(idx, it.display) : null;
          if (!res) { ignored.push(it.raw); return; }
        } else {
          res = matchDomain(idx, dom) || (it.display ? matchName(idx, it.display) : null);
        }
      } else {
        res = matchName(idx, it.raw);
      }
      var label = it.via ? it.raw + ' (via ' + it.via + ')' : it.raw;
      if (res) {
        var id = res.shop.id;
        if (!matched[id]) { matched[id] = { shop: res.shop, how: res.how, inputs: [], count: 0 }; order.push(id); }
        if (matched[id].inputs.indexOf(label) === -1) matched[id].inputs.push(label);
        matched[id].count += count;
      } else {
        // One row per brand: replit.com, replit.co.uk and a "Replit" name from a Stripe receipt all collapse together.
        var reg = dom ? registrable(dom) : null, brand = reg ? reg.split('.')[0] : null;
        var key = brand && brand.length >= 4 ? compact(brand) : (reg || compact(it.raw));
        if (!key) return;
        if (!unmatched[key]) {
          var nm = dom ? prettyGuess(it) : it.raw;
          unmatched[key] = { key: key, label: nm, domain: reg, inputs: [], count: 0 };
          uorder.push(key);
        } else {
          if (reg && !unmatched[key].domain) unmatched[key].domain = reg;   // prefer a known domain for the site: search
          // Prefer a spaced brand name ("Green Man Gaming") over a squashed domain label ("Greenmangaming").
          if (!dom && / /.test(it.raw) && !/ /.test(unmatched[key].label) && compact(it.raw) === compact(unmatched[key].label)) unmatched[key].label = it.raw;
        }
        if (unmatched[key].inputs.indexOf(label) === -1) unmatched[key].inputs.push(label);
        unmatched[key].count += count;
      }
    });
    uorder.forEach(function (k) {
      var u = unmatched[k], links = searchLinks(u.label, u.domain);
      u.searchUrl = links.url; u.generalSearchUrl = links.general;
    });
    var m = order.map(function (k) { return matched[k]; });
    var u = uorder.map(function (k) { return unmatched[k]; });
    if (opts.sortByCount) {
      m.sort(function (a, b) { return b.count - a.count; });
      u.sort(function (a, b) { return b.count - a.count; });
    }
    // rows: one checklist — known shops first, then unknown ones as 'search' rows (each sorted by count if asked).
    var rows = m.concat(u.map(function (x) { return { shop: guessShop(x), how: 'search', inputs: x.inputs, count: x.count }; }));
    return { matched: m, unmatched: u, rows: rows, ignored: ignored };
  }

  return { normName: normName, compact: compact, registrable: registrable, levenshtein: levenshtein, buildIndex: buildIndex, prettyName: prettyName, searchLinks: searchLinks, guessShop: guessShop, GUESS_STEPS: GUESS_STEPS,
    matchDomain: matchDomain, matchName: matchName, tokenize: tokenize, matchAll: matchAll, PERSONAL_DOMAINS: PERSONAL_DOMAINS };
});
