/* Saved Card Finder — local .mbox / .eml parser. Streams the file in chunks with File.slice. Reads only From: and Subject: headers so multi-GB
   Google Takeout exports work without loading everything into memory. Nothing is uploaded. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SCFMbox = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9\-]+(?:\.[a-z0-9\-]+)+/i;

  /** Stateful line scanner: feed it lines, it collects From: and Subject: headers (with folded continuation lines).
      Bodies are skipped. Each message's {from, subject} goes to SCFExtract (receipt filter + processor merchants). */
  function createScanner() {
    var X = typeof module === 'object' && module.exports ? require('./extract.js') : (typeof self !== 'undefined' ? self.SCFExtract : null);
    var acc = X ? X.createAccumulator() : null;
    var senders = {}, messages = 0, inHeaders = true, pending = null, cur = null;
    function flushHeader() {
      if (!pending) return;
      var v = decodeMime(pending.value);
      if (pending.name === 'from' && cur.from === null) cur.from = v;
      if (pending.name === 'subject' && cur.subject === null) cur.subject = v;
      pending = null;
    }
    function endMessage() {
      flushHeader();
      if (!cur) return;
      if (cur.from) {
        var m = EMAIL_RE.exec(cur.from);
        if (m) {
          var email = m[0].toLowerCase();
          var display = cur.from.replace(m[0], '').replace(/[<>"]/g, '').trim();
          if (!senders[email]) senders[email] = { email: email, display: display, count: 0 };
          senders[email].count++;
          if (acc) acc.add({ from: cur.from, subject: cur.subject || '' });
        }
      }
      cur = null;
    }
    function startMessage() { endMessage(); inHeaders = true; messages++; cur = { from: null, subject: null }; }
    function line(l) {
      if (/^From \S+/.test(l) && !/^From:/i.test(l)) { startMessage(); return; }                       // mbox separator
      if (!inHeaders) return;
      if (!cur) cur = { from: null, subject: null };
      if (l === '' || l === '\r') { endMessage(); inHeaders = false; return; }                         // end of headers
      if (pending && /^[ \t]/.test(l)) { pending.value += ' ' + l.trim(); return; }                    // folded header
      flushHeader();
      var m = /^(From|Subject):\s*(.*)$/i.exec(l);
      if (m) pending = { name: m[1].toLowerCase(), value: m[2] };
    }
    function result() {
      endMessage();
      return { messages: Math.max(messages, 1), senders: Object.keys(senders).map(function (k) { return senders[k]; }),
        analysis: acc ? acc.result() : null };
    }
    return { line: line, result: result, startMessage: startMessage };
  }

  /** Minimal RFC 2047 decoder for display names like =?UTF-8?Q?Sainsbury=E2=80=99s?= */
  function decodeMime(s) {
    return s.replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, function (_, cs, enc, txt) {
      try {
        var bytes;
        if (enc.toUpperCase() === 'B') {
          var bin = typeof atob === 'function' ? atob(txt) : Buffer.from(txt, 'base64').toString('binary');
          bytes = Uint8Array.from(bin, function (c) { return c.charCodeAt(0); });
        } else {
          var t = txt.replace(/_/g, ' '), arr = [];
          for (var i = 0; i < t.length; i++) {
            if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.substr(i + 1, 2))) { arr.push(parseInt(t.substr(i + 1, 2), 16)); i += 2; }
            else arr.push(t.charCodeAt(i));
          }
          bytes = new Uint8Array(arr);
        }
        return new TextDecoder(cs.toLowerCase() === 'utf8' ? 'utf-8' : cs).decode(bytes);
      } catch (e) { return txt; }
    });
  }

  /** Parse a whole string (used by tests and small .eml files). */
  function parseText(text, isSingleEml) {
    var sc = createScanner();
    if (isSingleEml) sc.startMessage();
    String(text).split(/\n/).forEach(function (l) { sc.line(l.replace(/\r$/, '')); });
    return sc.result();
  }

  /** Browser: parse File objects (.mbox or .eml) in 4 MB chunks. onProgress(fraction). */
  function parseFiles(files, onProgress) {
    var sc = createScanner(), total = 0, done = 0, CHUNK = 4 * 1024 * 1024;
    files = Array.prototype.slice.call(files);
    files.forEach(function (f) { total += f.size; });
    return files.reduce(function (p, file) {
      return p.then(function () {
        var isEml = /\.eml$/i.test(file.name);
        if (isEml) sc.startMessage();
        var decoder = new TextDecoder('utf-8'), carry = '', offset = 0;
        function next() {
          if (offset >= file.size) {
            var tail = carry + decoder.decode();
            if (tail) sc.line(tail.replace(/\r$/, ''));
            if (isEml) sc.line('');
            return Promise.resolve();
          }
          var blob = file.slice(offset, offset + CHUNK);
          return blob.arrayBuffer().then(function (buf) {
            offset += buf.byteLength; done += buf.byteLength;
            var text = carry + decoder.decode(new Uint8Array(buf), { stream: true });
            var lines = text.split('\n');
            carry = lines.pop();
            for (var i = 0; i < lines.length; i++) sc.line(lines[i].replace(/\r$/, ''));
            if (onProgress) onProgress(total ? done / total : 1);
            return new Promise(function (r) { setTimeout(r, 0); }).then(next); // keep UI responsive
          });
        }
        return next();
      });
    }, Promise.resolve()).then(function () { return sc.result(); });
  }

  return { parseText: parseText, parseFiles: parseFiles, decodeMime: decodeMime, createScanner: createScanner };
});
