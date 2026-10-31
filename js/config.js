/* Saved Card Finder — config. Edit this file to change price, payment link and support email. */
window.SCF_CONFIG = {
  PRICE_LABEL: '£3',               // shown on the "Get access" button
  // Your Stripe Payment Link (see OWNER-SETUP.txt). Until you paste a real one, the button says payments aren't live yet.
  PAYMENT_URL: 'https://buy.stripe.com/7sY4gy9ol1lhghIfxCd7q00',
  // Buyers who got it wrong reply here (shown as a mailto link in the "wrong account" help and the footer).
  SUPPORT_EMAIL: 'k.krisztian.zoltan@gmail.com',
  // Only used by the ?demo=1 preview on the landing page: rows shown before the "Get access" box.
  // People with access (index.html?access=1) always see everything.
  FREE_RESULTS: 3,

  // "Connect Gmail": paste your OAuth 2.0 *Web* client ID here (see docs/GMAIL_SETUP.md), e.g.
  //   '1234567890-abc123def456.apps.googleusercontent.com'
  // Leave '' and the Gmail button is disabled. A client ID is public, not a secret.
  GOOGLE_CLIENT_ID: '379652638277-domcfbpulr26jeaipp171j7sp6h85fb9.apps.googleusercontent.com',
  GMAIL_MAX_MESSAGES: 5000,        // cap on emails scanned per run
  GMAIL_DEEP_MAX: 20000            // cap for "Scan deeper"
};
