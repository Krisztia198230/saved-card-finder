/* Saved Card Finder — turn raw email headers (From + Subject) into shop candidates. Pure, local, no DOM.
   Used by both the Gmail scan and the .mbox/.eml parser.
   - Precision: a sender only counts if at least one of its emails looks like a receipt/order/billing email.
   - Recall: payment processors (PayPal, Stripe, Paddle, Shopify, Klarna…) hide the real merchant, so we pull the merchant
     name from the From display name ("Replit via Stripe") or the Subject ("Your receipt from Replit #1234").
   - Bulk-mail services (SendGrid, Mailchimp, Klaviyo, Amazon SES…) are replaced by the brand in the display name. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SCFExtract = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var EMAIL_RE = /[a-z0-9._%+\-=]+@[a-z0-9\-]+(?:\.[a-z0-9\-]+)+/i;
  var MULTI = ['co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'ac.uk', 'gov.uk', 'com.au', 'co.nz', 'co.jp', 'com.br', 'co.in', 'com.pl', 'com.tr', 'co.za'];
  function registrable(d) {
    var p = String(d).toLowerCase().split('.');
    if (p.length <= 2) return p.join('.');
    return MULTI.indexOf(p.slice(-2).join('.')) !== -1 ? p.slice(-3).join('.') : p.slice(-2).join('.');
  }

  var PERSONAL = ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'live.co.uk', 'msn.com',
    'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'aol.co.uk', 'btinternet.com', 'sky.com',
    'virginmedia.com', 'talktalk.net', 'protonmail.com', 'proton.me', 'pm.me', 'gmx.com', 'gmx.co.uk', 'gmx.de', 'mail.com', 'zoho.com',
    'wp.pl', 'o2.pl', 'onet.pl', 'interia.pl', 'yandex.com', 'yandex.ru', 'tutanota.com', 'fastmail.com', 'hey.com'];

  // Bulk email services: the domain says nothing about the shop, the display name does.
  var ESP = ['sendgrid.net', 'sendgrid.com', 'mcsv.net', 'mcdlv.net', 'rsgsv.net', 'mailchimpapp.net', 'mailchimp.com', 'mandrillapp.com',
    'klaviyomail.com', 'klaviyo.com', 'kmail-lists.com', 'amazonses.com', 'sparkpostmail.com', 'mailgun.org', 'mailgun.net', 'mg.net',
    'exacttarget.com', 'createsend.com', 'cmail19.com', 'cmail20.com', 'hubspotemail.net', 'hs-email.net', 'intercom-mail.com',
    'customeriomail.com', 'postmarkapp.com', 'mtasv.net', 'sendinblue.com', 'brevo.com', 'mailjet.com', 'mailerlite.com', 'mlsend.com',
    'convertkit-mail.com', 'convertkit-mail2.com', 'ckespa.com', 'activehosted.com', 'acems1.com', 'emarsys.net', 'bmetrack.com',
    'responsys.net', 'rsys2.com', 'rsys5.com', 'msgfocus.com', 'dotdigital-email.com', 'dmtrk.com', 'omnisend.com', 'omnisendlink.com',
    'shopifyemail.com', 'myshopify.com', 'squarespace-mail.com', 'wixemails.com', 'wix.com', 'e.wix.com', 'zendesk.com', 'freshdesk.com',
    'helpscout.net', 'gorgias.io', 'returnly.com', 'aftership.com', 'narvar.com', 'transactional.mailer', 'ecsend.co', 'sailthru.com',
    'bigcommerce.com', 'woocommerce.com', 'mailpoet.com'];

  // Payment processors / platforms. holds: the processor itself keeps a card on file (its own row stays).
  // shop: shops.json id for that row (matched by domain anyway).
  var PROCESSORS = [
    { name: 'PayPal', domains: ['paypal.com', 'paypal.co.uk', 'paypal.de', 'paypal.fr', 'paypal.pl', 'paypal.ie', 'paypal.es', 'paypal.it', 'paypal.nl'], holds: true },
    { name: 'Stripe', domains: ['stripe.com'], holds: false },
    { name: 'Link', domains: ['link.com'], holds: true },
    { name: 'Paddle', domains: ['paddle.com', 'paddle.net'], holds: true },
    { name: 'FastSpring', domains: ['fastspring.com', 'onfastspring.com'], holds: false },
    { name: 'Apple', domains: ['apple.com', 'itunes.com'], holds: true },
    { name: 'Shopify', domains: ['shopify.com', 'shopifyemail.com', 'myshopify.com', 'shop.app'], holds: false },
    { name: 'Klarna', domains: ['klarna.com', 'klarna.co.uk'], holds: true },
    { name: 'Clearpay', domains: ['clearpay.co.uk', 'afterpay.com'], holds: true },
    { name: 'Square', domains: ['squareup.com', 'square.com', 'squareupmessaging.com'], holds: false },
    { name: 'SumUp', domains: ['sumup.com', 'sumup.co.uk'], holds: false },
    { name: 'Gumroad', domains: ['gumroad.com'], holds: true },
    { name: 'Lemon Squeezy', domains: ['lemonsqueezy.com', 'lemonsqueezy-mail.com', 'lmsqueezy.com'], holds: true },
    { name: 'Patreon', domains: ['patreon.com'], holds: true },
    { name: 'Chargebee', domains: ['chargebee.com'], holds: false },
    { name: 'Recurly', domains: ['recurly.com'], holds: false },
    { name: 'Xsolla', domains: ['xsolla.com'], holds: false },
    { name: '2Checkout', domains: ['2checkout.com', '2co.com', 'verifone.com'], holds: false },
    { name: 'Cleverbridge', domains: ['cleverbridge.com'], holds: false },
    { name: 'Digital River', domains: ['digitalriver.com'], holds: false },
    { name: 'Ko-fi', domains: ['ko-fi.com'], holds: false },
    { name: 'Buy Me a Coffee', domains: ['buymeacoffee.com'], holds: false },
    { name: 'Payhip', domains: ['payhip.com'], holds: false },
    { name: 'Revolut Pay', domains: [], holds: false }
  ];
  var PROC_BY_DOMAIN = {};
  PROCESSORS.forEach(function (p) { p.domains.forEach(function (d) { PROC_BY_DOMAIN[d] = p; }); });
  var PROC_NAMES = PROCESSORS.map(function (p) { return p.name.toLowerCase(); }).concat(['google', 'google play', 'google payments', 'app store', 'itunes', 'afterpay', 'shop pay', 'shop']);

  // Google sends Play receipts and Payments mail from google.com; route them to the right row.
  var GOOGLE_LOCALS = { 'googleplay-noreply': 'Google Play', 'payments-noreply': 'Google Pay', 'google-play-noreply': 'Google Play' };

  // Subject lines that look like money changed hands (or a card/subscription exists).
  var RECEIPT_SUBJ = new RegExp('\\b(' + [
    'receipts?', 'invoices?', 'your order', 'your (?:[^ ]+ ){1,3}(?:order|receipt|invoice|booking|subscription|purchase|tickets?|payment|bill|statement|trip|ride|delivery|rental|reservation)s?',
    'orders? (?:confirmed|accepted|complete\\w*|cancel\\w*|ready)', 'booking confirmed', 'reservation', 'trip with', 'ride with', 'order (?:confirm\\w*|number|no\\.?|#|placed|received|update|details|has|is|was|shipped|dispatched)',
    'orders? #?\\d', 'thank(?:s| you) for (?:your )?(?:order|purchase|payment|subscrib\\w*|shopping|booking|buying|support)',
    'payment (?:received|confirm\\w*|successful|success|failed|declined|method|receipt|due|reminder|processed|to|for|of|scheduled)',
    'you(?:\'ve| have)? (?:sent|paid|made|authori[sz]ed|bought|purchased)', 'paid', 'purchase', 'subscription', 'subscribed', 'renew\\w*',
    'billing', 'billed', 'charged?', 'refund\\w*', 'trial', 'card (?:expir\\w*|declined|update\\w*|added|ending|saved|on file)',
    'booking (?:confirm\\w*|reference|ref)', 'e-?tickets?', 'your tickets?', 'membership', 'top[- ]?up', 'dispatched', 'shipped', 'delivered',
    'out for delivery', 'on its way', 'tracking', 'welcome to (?:[^ ]+ ){0,3}(?:premium|plus|pro|nitro|super|gold)', '(?:plan|premium|plus|pro) (?:is active|activated|confirmed|renewal)',
    'auto-?renew\\w*', 'direct debit', 'statement', 'transaction', 'deposit', 'tokens purchased', 'purchased', 'donation', 'pledge',
    'potwierdzenie', 'zam[oó]wienie', 'rachunek', 'faktura', 'paragon', 'płatno\\S*', 'rechnung', 'bestellung', 'commande', 'factura', 'pedido'
  ].join('|') + ')\\b', 'i');
  // Local parts that only send transactional mail.
  var RECEIPT_LOCAL = /(^|[._+\-])(billing|receipts?|orders?|order-?update|payments?|invoices?|invoicing|purchases?|transactions?|bookings?|tickets?|subscriptions?|renewals?|auto-?confirm|confirmations?|sales|accounts-?payable|noreply-payments|digital-no-reply|googleplay-noreply|payments-noreply|do_not_reply@itunes|shipment-tracking|shipping|dispatch)([._+\-]|$)/i;

  var GENERIC_NAMES = /^(no-?reply|do-?not-?reply|noreply|info|hello|hi|support|help|team|billing|receipts?|orders?|payments?|invoices?|accounts?|notifications?|notification|service|customer (?:service|care|support)s?|sales|admin|mailer|news|newsletter|updates?|alerts?|store|shop|the team|your|us|you|me|it|this|that|online|order|payment|purchase|subscription|account|accounts team|system|mail|email)$/i;

  function clean(s) {
    return String(s || '').replace(/[“”"«»]/g, '').replace(/\s+/g, ' ').trim();
  }
  /** Tidy a merchant/brand candidate; returns null if it isn't a usable name. */
  function cleanMerchant(s) {
    s = clean(s);
    s = s.replace(/\s*(?:#|no\.?\s|nr\.?\s|order\s|ref\.?\s|invoice\s)?#?\s*[A-Z0-9\-]*\d[A-Z0-9\-]{2,}\s*$/i, '');   // trailing order numbers
    s = s.replace(/\s+(?:on|for|of)\s+(?:\d{1,2}\s+\w+|\w+\s+\d{1,2})(?:,?\s+\d{4})?.*$/i, '');                     // "... on 3 May 2026"
    s = s.replace(/\s+(?:for|of)\s+[£$€]\s?\d.*$/i, '').replace(/[£$€]\s?\d[\d.,]*/g, '');                            // amounts
    s = s.replace(/\s*[\[(].*?[\])]\s*/g, ' ');
    s = s.replace(/[\s(\[]+$/, '');
    s = s.replace(/\s+(?:ltd|limited|plc|inc|llc|gmbh|s\.?a\.?|sp\.? z o\.?o\.?|b\.?v\.?|pty|co|uab|ab|ag|sas|sarl|srl|oy|as|aps|se|nv|bv|pte|corp|corporation|company)\.?$/i, '').trim();
    s = s.replace(/[.,:;!\-–—|]+$/g, '').replace(/^[.,:;!\-–—|]+/g, '').trim();
    if (s.length < 2 || s.length > 50) return null;
    if (GENERIC_NAMES.test(s)) return null;
    if (/^\d|^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d/i.test(s)) return null;               // dates
    if (PROC_NAMES.indexOf(s.toLowerCase()) !== -1) return null;
    if (s.split(' ').length > 6) return null;
    return s;
  }

  /** Strip "via Stripe", "| PayPal", "(Paddle)" etc. from a display name; returns the merchant part or null. */
  function merchantFromDisplay(display, proc) {
    var d = clean(display);
    if (!d) return null;
    var pn = proc ? proc.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '[A-Za-z .]+';
    var m = new RegExp('^(.+?)\\s*(?:via|through|by|with|on behalf of|using|from|[|\\-–—@(])\\s*\\(?' + pn + '\\)?(?:\\.com)?\\s*$', 'i').exec(d);
    if (m) return cleanMerchant(m[1]);
    if (proc && new RegExp('^' + pn + '\\b', 'i').test(d)) return null;          // "PayPal", "Stripe Receipts"
    if (/\b(receipts?|billing|payments?|notifications?|service|support|team)$/i.test(d) && proc) return cleanMerchant(d.replace(/\b(receipts?|billing|payments?|notifications?|service|support|team)$/i, ''));
    return cleanMerchant(d);
  }

  // Subject patterns that name the merchant. Order matters (most specific first).
  var SUBJ_PATTERNS = [
    /receipt for (?:your )?payment to (.+)/i,
    /you(?:'ve| have)? (?:sent|made) (?:a )?(?:payment|[£$€][\d.,]+(?: \w+)?) to (.+)/i,
    /you(?:'ve| have)? paid (?:[£$€][\d.,]+(?: \w+)? )?to (.+)/i,
    /you(?:'ve| have)? authori[sz]ed (?:a )?(?:payment|[£$€][\d.,]+(?: \w+)?) to (.+)/i,
    /(?:your )?(?:automatic|recurring|pre-?approved) payment (?:to|for) (.+)/i,
    /you(?:'ve| have)? (?:set up|cancelled|canceled) (?:an? )?(?:automatic|recurring) payments? (?:to|for|with) (.+)/i,
    /payment (?:to|for) (.+?) (?:was|is|has|completed|successful|failed|declined)/i,
    /(?:your )?(?:receipt|invoice|order|purchase|subscription|payment|refund) (?:receipt )?(?:from|with|at|to) (.+)/i,
    /(?:receipt|invoice|order confirmation|payment confirmation|purchase confirmation)\s*[:\-–—|]\s*(.+)/i,
    /your purchase (?:at|from|with) (.+)/i,
    /you made a purchase (?:at|from|with) (.+)/i,
    /(?:new )?(?:order|plan|purchase) (?:with|at) (.+)/i,
    /thank(?:s| you) for (?:your )?(?:order|purchase|payment|shopping|subscribing|supporting)(?: \w+)? (?:with|at|from|to) (.+)/i,
    /subscription to (.+?)(?: on google play| has| is| was|$)/i,
    /your (.+?) (?:receipt|invoice|order|subscription|payment)(?:\b|$)/i
  ];
  function merchantFromSubject(subject) {
    var s = clean(subject).replace(/^(?:re|fwd?|fw):\s*/i, '');
    for (var i = 0; i < SUBJ_PATTERNS.length; i++) {
      var m = SUBJ_PATTERNS[i].exec(s);
      if (m) {
        var name = m[1].replace(/\s+(?:has|is|was|for|on|from)\s+.*$/i, '').replace(/['’]s$/i, '');
        var c = cleanMerchant(name);
        if (c && !/^(?:your|our|the|a|an)\b/i.test(c)) return c;
      }
    }
    return null;
  }

  function parseFrom(value) {
    if (!value) return null;
    var m = EMAIL_RE.exec(value);
    if (!m) return null;
    var email = m[0].toLowerCase();
    return { email: email, local: email.split('@')[0], domain: email.split('@')[1], display: clean(value.replace(m[0], '').replace(/[<>]/g, '')) };
  }

  // Clearly-marketing subjects: these never make a sender count on their own (even in Gmail's Purchases category).
  var MARKETING_SUBJ = /(new arrivals?|newsletter|\bsale\b|\d+\s?% off|\bdeals?\b|special offer|exclusive offer|just dropped|back in stock|last chance|ends (tonight|soon|today|midnight)|don'?t miss|\bwin\b|competition|you might (also )?like|recommended for you|webinar|survey|verification code|security (alert|code)|password|\btry\b.*\bfree\b)/i;
  function isReceiptish(msg, f) {
    var subj = msg.subject || '';
    if (subj && RECEIPT_SUBJ.test(subj)) return true;
    if (subj && MARKETING_SUBJ.test(subj)) return false;
    if ((msg.tags || []).indexOf('purchases') !== -1) return true;
    return RECEIPT_LOCAL.test(f.local);
  }

  /**
   * Accumulator: add({from, subject, tags}) per email, then result().
   * result(): { items: [{raw, kind:'email'|'name', display, count, via}], senders: [...per-address log], stats }
   */
  function createAccumulator(opts) {
    opts = opts || {};
    var senders = {}, total = 0, noFrom = 0;
    function add(msg) {
      total++;
      var f = parseFrom(msg.from);
      if (!f) { noFrom++; return; }
      var s = senders[f.email];
      if (!s) {
        var reg = registrable(f.domain);
        s = senders[f.email] = { email: f.email, domain: f.domain, registrable: reg, display: f.display, count: 0, receipts: 0,
          proc: PROC_BY_DOMAIN[reg] || PROC_BY_DOMAIN[f.domain] || null, esp: ESP.indexOf(reg) !== -1 || ESP.indexOf(f.domain) !== -1,
          personal: PERSONAL.indexOf(f.domain) !== -1, merchants: {}, displays: {}, google: null };
        if (reg === 'google.com' && GOOGLE_LOCALS[f.local]) { s.google = GOOGLE_LOCALS[f.local]; s.proc = { name: s.google, holds: true }; }
      }
      s.count++;
      if (f.display) s.displays[f.display] = (s.displays[f.display] || 0) + 1;
      var rc = opts.noFilter || isReceiptish(msg, f);
      if (rc) s.receipts++;
      if (s.proc && rc) {
        var name = merchantFromDisplay(f.display, s.proc) || merchantFromSubject(msg.subject || '');
        if (name) s.merchants[name] = (s.merchants[name] || 0) + 1;
      } else if (s.esp && rc) {
        var b = merchantFromDisplay(f.display, null);
        if (b) s.merchants[b] = (s.merchants[b] || 0) + 1;
      }
    }
    function topDisplay(s) {
      var best = s.display, n = 0;
      Object.keys(s.displays).forEach(function (d) { if (s.displays[d] > n) { n = s.displays[d]; best = d; } });
      return best;
    }
    function result() {
      var items = {}, log = [];
      function push(kind, raw, display, count, via) {
        var k = kind + ':' + raw.toLowerCase() + ':' + (via || '');
        if (!items[k]) items[k] = { raw: raw, kind: kind, display: display || '', count: 0, via: via || null };
        items[k].count += count;
      }
      Object.keys(senders).forEach(function (e) {
        var s = senders[e], display = topDisplay(s), names = Object.keys(s.merchants);
        var row = { email: s.email, domain: s.domain, display: display, count: s.count, receipts: s.receipts, via: null, merchants: names, status: 'used', reason: '' };
        if (s.personal) { row.status = 'skipped'; row.reason = 'personal mailbox (a person, not a shop)'; }
        else if (!s.receipts) { row.status = 'skipped'; row.reason = 'no receipt-like emails (newsletter or account mail)'; }
        else if (s.proc) {
          row.via = s.proc.name;
          names.forEach(function (n) { push('name', n, '', s.merchants[n], s.proc.name); });
          if (s.google) push('name', s.google, display, s.receipts);
          else if (s.proc.holds) push('email', s.email, display, s.receipts);
          else if (!names.length) { row.status = 'skipped'; row.reason = 'sent via ' + s.proc.name + ' but no merchant name in sender/subject'; }
        } else if (s.esp) {
          row.via = 'bulk-mail service';
          if (names.length) names.forEach(function (n) { push('name', n, '', s.merchants[n]); });
          else { row.status = 'skipped'; row.reason = 'bulk-mail service with no brand in the sender name'; }
        } else {
          push('email', s.email, display, s.receipts);
        }
        log.push(row);
      });
      log.sort(function (a, b) { return b.count - a.count; });
      var list = Object.keys(items).map(function (k) { return items[k]; }).sort(function (a, b) { return b.count - a.count; });
      return { items: list, senders: log, stats: { messages: total, senders: log.length, used: log.filter(function (r) { return r.status === 'used'; }).length, noFrom: noFrom } };
    }
    return { add: add, result: result };
  }

  function analyze(messages, opts) { var a = createAccumulator(opts); messages.forEach(a.add); return a.result(); }

  return { analyze: analyze, createAccumulator: createAccumulator, merchantFromSubject: merchantFromSubject, merchantFromDisplay: merchantFromDisplay,
    cleanMerchant: cleanMerchant, isReceiptSubject: function (s) { return RECEIPT_SUBJ.test(s || ''); }, parseFrom: parseFrom,
    PROCESSORS: PROCESSORS, ESP: ESP, PERSONAL: PERSONAL, registrable: registrable };
});
