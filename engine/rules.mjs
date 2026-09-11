/**
 * The rulebook. Every constant the audit and the converter share lives here,
 * so a rule is changed in one place and both sides agree.
 *
 * Two families of rules:
 *
 *   technical  — will the Google Ads upload/validator accept the file, and
 *                will it actually run and register a click in the ad slot.
 *                Sourced from the App campaign HTML5 spec.
 *   policy     — will a policy reviewer disapprove it. Sourced from the Google
 *                Ads policies (support.google.com/adspolicy/answer/6008942):
 *                Prohibited content, Prohibited practices, Restricted content,
 *                Editorial & technical.
 *
 * Text rules are deterministic pattern matches against the ad's visible copy.
 * They cannot see art or judge intent — that is what the optional AI review
 * is for — but they catch the phrases that get playables disapproved over and
 * over: fake system UI, cash promises, urgency bait, shouting punctuation.
 */

export const GOOGLE_ADS_LIMITS = {
  // App campaign HTML5/playable assets. Display campaign limits are far tighter
  // (600 KB / 40 files) and do not apply here.
  // https://support.google.com/google-ads/answer/9981650
  maxZipBytes: 5 * 1024 * 1024,
  maxFiles: 512,
};

/**
 * The one script Google expects a playable to load from outside the ZIP.
 * Must be a literal <script> tag in <head>; injected via JS and Google makes
 * the whole ad area clickable at serve time.
 */
export const EXITAPI_SRC = 'https://tpc.googlesyndication.com/pagead/gadgets/html5/api/exitapi.js';

/**
 * Hosts a Google Ads playable may reach. Everything else is a "fourth-party
 * call" and gets the asset disapproved. Google explicitly permits Google Fonts,
 * Google-hosted jQuery, GSAP and CreateJS.
 */
export const ALLOWED_HOSTS = [
  'tpc.googlesyndication.com',
  'googleads.g.doubleclick.net',
  'www.googletagservices.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'ajax.googleapis.com',
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
];

/** Constructs Google prohibits outright in HTML5 assets. Each is a disapproval. */
export const PROHIBITED = [
  { id: 'iframe', re: /<\s*(iframe|frame|frameset)\b/i, label: '<iframe>/<frame>/<frameset>',
    why: 'Frames of any kind are prohibited in Google Ads HTML5 assets.' },
  // `fix` names the converter fixer that removes it; absent, a person has to
  // change the creative. The Enabler fix only applies when the file merely
  // references the script rather than calling into the API, which the audit checks.
  { id: 'enabler', re: /Enabler\.js|studio\.doubleclick/i, label: 'Enabler.js',
    why: 'DoubleClick Studio Enabler.js references are prohibited in Google Ads HTML5 assets.', fix: 'remove-enabler-script' },
  { id: 'amp', re: /cdn\.ampproject\.org|<\s*amp-/i, label: 'AMP',
    why: 'AMP tags and cdn.ampproject.org are prohibited.' },
  { id: 'producttype', re: /<meta[^>]+name=["']?productType["']?[^>]*content=["']?dynamic/i, label: 'productType=dynamic',
    why: '`<meta name="productType" content="dynamic">` is prohibited.', fix: 'remove-producttype' },
];

/**
 * Ad-network SDKs a playable may have been built for. Detection is by the
 * call surface the creative uses, which is also what has to be rewritten or
 * shimmed for the Google build.
 *
 *   exit   the network's click-through call; rewritten to ExitApi.exit()
 *   shim   whether the converter can stand in for the SDK at runtime
 */
export const NETWORKS = [
  { id: 'google', label: 'Google Ads', test: /\bExitApi\b|window\.super_html\s*=/, shim: false },
  { id: 'mraid', label: 'MRAID (AppLovin, Unity, Moloco, Chartboost…)', test: /\bmraid\b/, shim: true,
    exit: /\bmraid\s*\.\s*open\s*\(/g },
  { id: 'dapi', label: 'ironSource / Unity LevelPlay (DAPI)', test: /\bdapi\s*\./, shim: true,
    exit: /\bdapi\s*\.\s*openStoreUrl\s*\(/g },
  { id: 'facebook', label: 'Meta (FbPlayableAd)', test: /\bFbPlayableAd\b/, shim: true,
    exit: /\bFbPlayableAd\s*\.\s*onCTAClick\s*\(/g },
  { id: 'mintegral', label: 'Mintegral', test: /\bgameReady\s*\(/, shim: false },
  { id: 'tiktok', label: 'TikTok / Pangle', test: /\bopenAppStore\s*\(|\bplayableSDK\b/, shim: false },
  { id: 'vungle', label: 'Vungle / Liftoff', test: /postMessage\s*\(\s*["']download["']/, shim: false },
];

/**
 * Exits Google forbids in App campaign HTML5 ("CUSTOM_EXIT_NOT_ALLOWED"): any
 * navigation the creative performs itself instead of calling ExitApi.exit().
 *
 * Every pattern opens with `(?<![\w$.])` so it can never match the tail of a
 * longer member expression. Without it `e.location = 5` matched at `location`
 * and became `e.ExitApi.exit()`, and `var x=1,location=null` became
 * `var x=1,ExitApi.exit()` — a syntax error that killed the whole script.
 * A bare `location = …` is deliberately NOT matched: in minified code that is
 * far more often a local variable than a navigation.
 *
 *   kind 'call'   the match ends at `(`; the balanced call is replaced.
 *   kind 'assign' the match ends at `=`; only the assignment TARGET is
 *                 replaced, so the right-hand side is never consumed.
 */
export const CUSTOM_EXITS = [
  { id: 'window-open', label: 'window.open()', kind: 'call',
    re: /(?<![\w$.])(?:window|top|parent|self)\s*\.\s*open\s*\(/g },
  { id: 'location-call', label: 'location.assign() / location.replace()', kind: 'call',
    re: /(?<![\w$.])(?:(?:window|top|parent|self|document)\s*\.\s*)?location\s*\.\s*(?:assign|replace)\s*\(/g },
  { id: 'location-set', label: 'location.href = …', kind: 'assign',
    re: /(?<![\w$.])(?:(?:window|top|parent|self|document)\s*\.\s*location(?:\s*\.\s*href)?|location\s*\.\s*href)\s*=(?!=)/g },
];

/**
 * Navigation through a reference the converter cannot identify, such as
 * `frame.location.href = url`. Reported so a human can look, never rewritten:
 * the object may not be a window at all.
 */
export const SUSPECT_NAV = /(?<=[\w$])\s*\.\s*location\s*(?:\.\s*href\s*)?=(?!=)|(?<=[\w$])\s*\.\s*open\s*\(\s*["']https?:/g;

/**
 * Browser storage is prohibited in HTML5 ad assets. The converter rewrites the
 * identifiers to an in-memory stand-in, so after conversion nothing matches.
 */
export const STORAGE_RE = /\b(localStorage|sessionStorage|indexedDB)\b/g;

/**
 * Native dialogs mimic system UI (Misleading ad design) and are disruptive.
 *
 * Detection only. These are NEVER rewritten in the source: `function confirm(m)`
 * and the shorthand method in `{prompt(t){…}}` both look exactly like calls, and
 * rewriting them produced `function rpDialog.confirm(m)` — a syntax error. The
 * converter overrides the globals from the shim instead, which needs no source
 * edit and catches every call form, aliased ones included.
 */
export const DIALOG_RE = /(?<![\w$.])(?:window\s*\.\s*)?(alert|confirm|prompt)\s*\(/g;

/** Media that starts by itself. Google: no sound before the user interacts. */
/**
 * A creative that actually CALLS the DoubleClick Studio Enabler, as opposed to
 * one that merely loads Enabler.js and never uses it. The negative lookahead
 * for `js` is the whole point: without it the script's own filename matched,
 * so a file that only referenced the script looked like one that depended on
 * it and the tag was never removed.
 */
export const ENABLER_CALL_RE = /\bEnabler\s*\.\s*(?!js\b)[A-Za-z_$]/;

export const AUTOPLAY_RE = /<(audio|video)\b[^>]*\bautoplay\b/i;

/** Google's filename rule: letters, numbers, dot, dash, underscore, slash. */
export const SAFE_NAME_RE = /^[A-Za-z0-9._\-\/]+$/;

/* ------------------------------------------------------------------ *
 * Where each check comes from
 * ------------------------------------------------------------------ */

/**
 * The basis for every check the tool makes, keyed by finding id.
 *
 * This exists so the answer to "says who?" is in the codebase rather than in
 * someone's memory. docs/validation-sources.md is generated from it, and a test
 * asserts every finding the audit can produce has an entry here, so a new rule
 * cannot be added without declaring what it rests on.
 *
 * basis:
 *   captured   the source text is in this repo and the rule quotes it, so a
 *              reader can verify the wording themselves
 *   documented a public Google page states it; cited by URL, text not captured
 *   vendor     another ad network's SDK specification, not Google's
 *   measured   established by running real playables, not from documentation
 */
export const SOURCE_REFS = {
  policies:  { family: 'google',  short: 'Ads policies',   label: 'Google Ads policies', url: 'https://support.google.com/adspolicy/answer/6008942', captured: 'docs/google-ads-policies.md' },
  html5spec: { family: 'google',  short: 'HTML5 spec',     label: 'About HTML5/Playable ads for App campaigns', url: 'https://support.google.com/google-ads/answer/9981650' },
  html5fix:  { family: 'google',  short: 'HTML5 issues',   label: 'Fix issues with HTML5 assets for App campaigns', url: 'https://support.google.com/google-ads/answer/12771973' },
  mraid:     { family: 'network', short: 'MRAID',          label: 'IAB MRAID specification', url: 'https://www.iab.com/guidelines/mobile-rich-media-ad-interface-definitions-mraid/' },
  dapi:      { family: 'network', short: 'DAPI',           label: 'ironSource / Unity LevelPlay playable (DAPI)', url: 'https://developers.is.com/ironsource-mobile/general/playable-ads/' },
  meta:      { family: 'network', short: 'Meta',           label: 'Meta playable ads specification', url: 'https://developers.facebook.com/docs/app-ads/formats/playable-ads' },
  mintegral: { family: 'network', short: 'Mintegral',      label: 'Mintegral playable specification', url: 'https://www.mintegral.com/en/advertiser/playable' },
  tiktok:    { family: 'network', short: 'TikTok/Pangle',  label: 'TikTok / Pangle playable specification', url: 'https://ads.tiktok.com/help/article/playable-ads' },
  vungle:    { family: 'network', short: 'Vungle',         label: 'Vungle / Liftoff playable specification', url: 'https://support.vungle.com/hc/en-us/articles/360048622551' },
  web:       { family: 'web',     short: 'Web standards',  label: 'Browser behaviour (HTML and JavaScript standards)', url: 'https://developer.mozilla.org/' },
};

/** The three kinds of source, in the order a reader wants them. */
export const SOURCE_FAMILIES = [
  { id: 'google', label: "Google's own documentation", why: 'What Google requires of an App campaign HTML5 asset, and what its policies forbid.' },
  { id: 'network', label: "Other ad networks' playable specifications", why: 'What the file was built against. These say what has to be replaced, not what Google wants.' },
  { id: 'web', label: 'Web standards', why: 'How a browser behaves when the document is incomplete. Not an ad rule — a rendering one.' },
];

export const CHECK_SOURCES = {
  /* ---- packaging ---- */
  'zip-size':        { basis: 'documented', ref: 'html5spec', states: 'App campaign playables upload as a .ZIP of at most 5 MB.' },
  'zip-headroom':    { basis: 'documented', ref: 'html5spec', states: 'Same 5 MB cap; this warns before an edit crosses it.' },
  'zip-files':       { basis: 'documented', ref: 'html5spec', states: 'No more than 512 files inside the .ZIP.' },
  'filenames':       { basis: 'documented', ref: 'html5fix', states: 'File and folder names may use only letters, numbers, dot, dash and underscore.' },
  'entry-not-root':  { basis: 'documented', ref: 'html5spec', states: 'Google looks for the entry HTML at the root of the archive.' },

  /* ---- document integrity ---- */
  'doctype':         { basis: 'documented', ref: 'web', states: 'Without a doctype the browser uses quirks mode, changing the layout maths a game relies on.' },
  'charset':         { basis: 'documented', ref: 'web', states: 'Undeclared encoding renders non-ASCII copy as mojibake.' },
  'viewport':        { basis: 'documented', ref: 'web', states: 'Without a viewport a mobile browser assumes desktop width and scales the ad down.' },
  'ad-orientation':  { basis: 'documented', ref: 'html5spec', states: 'Orientation is declared with `<meta name="ad.orientation">`; absent, the asset renders portrait-only with no error.' },
  'ad-orientation-bad': { basis: 'documented', ref: 'html5spec', states: 'An unparseable value falls back to portrait-only, silently.' },
  'truncated':       { basis: 'documented', ref: 'web', states: 'A document with no closing `</html>` is incomplete and will not run.' },
  'script-syntax':   { basis: 'captured', ref: 'policies', states: 'Technical requirements name "HTML5 ads that don\u2019t function properly or appear blank".' },

  /* ---- the exit ---- */
  'no-google-exit':  { basis: 'documented', ref: 'html5spec', states: 'The click-through is registered by calling ExitApi.exit(); nothing else counts.' },
  'exitapi-script':  { basis: 'documented', ref: 'html5spec', states: 'exitapi.js loads from tpc.googlesyndication.com as a literal `<script>` in `<head>`.' },
  'exitapi-placement': { basis: 'documented', ref: 'html5fix', states: 'Injected by other JavaScript instead of a literal tag, the whole ad area becomes clickable at serve time.' },
  'exitapi-dynamic': { basis: 'documented', ref: 'html5fix', states: 'Same consequence: the entire ad becomes the click target.' },
  'custom-exit':     { basis: 'documented', ref: 'html5fix', states: 'Custom exits are not allowed in App campaign HTML5 (CUSTOM_EXIT_NOT_ALLOWED).' },
  'custom-exit-fallback': { basis: 'documented', ref: 'html5fix', states: 'Same rule; downgraded because a Google exit is already present, so the branch is likely unreachable.' },
  'custom-exit-link':{ basis: 'documented', ref: 'html5fix', states: 'An outbound link is a custom exit and loses the click.' },
  'suspect-nav':     { basis: 'documented', ref: 'html5fix', states: 'Same rule, through a reference the tool cannot identify, so it is reported rather than rewritten.' },

  /* ---- other networks' SDKs ---- */
  'sdk-script':      { basis: 'vendor', ref: ['mraid', 'dapi', 'meta'], states: 'The host injects mraid.js at serve time; on Google it does not exist and the request fails.' },
  'sdk-calls':       { basis: 'vendor', ref: ['mraid', 'dapi', 'meta'], states: 'A creative waits for the SDK\u2019s ready signal before starting, so with no SDK it never boots.' },
  'sdk-also':        { basis: 'vendor', ref: ['mraid', 'dapi', 'meta'], states: 'Same, softened because the file already carries a Google exit.' },
  'sdk-unsupported': { basis: 'vendor', ref: 'mintegral', states: 'A network whose call surface the tool has no stand-in for. Reported for a person to check in the preview rather than rewritten.' },
  'sdk-also-network': { basis: 'vendor', ref: 'mintegral', states: 'Same, downgraded to advice: the file already calls ExitApi.exit(), so its Google path should win and this branch never run.' },
  'missing-local-ref': { basis: 'documented', ref: 'html5spec', states: 'A playable must be self-contained; paths not in the package fail in the ad slot.' },
  'external-refs':   { basis: 'documented', ref: 'html5fix', states: 'Fetching from outside the package is a fourth-party call and is disapproved.' },

  /* ---- prohibited constructs ---- */
  'prohibited-storage':   { basis: 'documented', ref: 'html5fix', states: 'Browser storage is prohibited in HTML5 ad assets.' },
  'prohibited-iframe':    { basis: 'documented', ref: 'html5fix', states: 'Frames of any kind are prohibited.' },
  'prohibited-enabler':   { basis: 'documented', ref: 'html5fix', states: 'DoubleClick Studio Enabler.js is prohibited.' },
  'prohibited-amp':       { basis: 'documented', ref: 'html5fix', states: 'AMP tags and cdn.ampproject.org are prohibited.' },
  'prohibited-producttype': { basis: 'documented', ref: 'html5fix', states: '`<meta name="productType" content="dynamic">` is prohibited.' },
  'prohibited-video-nosrc': { basis: 'documented', ref: 'html5fix', states: 'A `<video>` with no src attribute is disallowed.' },

  /* ---- behaviour a reviewer sees ---- */
  'dialogs':         { basis: 'captured', ref: 'policies', states: 'Misrepresentation covers ads that deceive users; system-style dialogs read as imitating device UI. The detail page is not captured.' },
  'autoplay-media':  { basis: 'documented', ref: 'html5spec', states: 'Sound must not be enabled before the user interacts with the ad.' },
  'audio-ungated':   { basis: 'documented', ref: 'html5spec', states: 'Same rule, plus: all sound stops on the exit click.' },
  'data-collection': { basis: 'captured', ref: 'policies', states: 'Data collection and use: advertising partners should not collect user information for unclear purposes or without disclosure.' },
  'close-control':   { basis: 'captured', ref: 'policies', states: 'Misrepresentation. Non-functional controls are named on the Misleading ad design detail page, which is not captured.' },
  'copy-in-images':  { basis: 'measured', ref: 'policies', states: 'Says the copy checks below could not read this creative — every word is drawn into artwork — so their silence proves nothing and only the AI scan can see it.' },
  'no-cta-copy':     { basis: 'captured', ref: 'policies', states: 'Editorial: ads must be clear and easy to interact with.' },
};

/* ------------------------------------------------------------------ *
 * Policy text rules
 * ------------------------------------------------------------------ */

/**
 * Deterministic copy checks. `re` runs against each extracted text string
 * (markup text and UI-looking string literals), never against raw code, so a
 * variable called `casino` does not trip a gambling flag but a button that
 * says "WIN REAL CASH" does.
 *
 * Severity is consequence, not confidence:
 *   blocker  a reviewer will disapprove this
 *   warn     frequently disapproved; needs a human decision
 *   advice   a known irritant; fix if it is cheap
 */
/**
 * `source` carries the sentence from docs/google-ads-policies.md that backs the
 * rule, or null when the captured page does not state it. The captured page is
 * Google's overview; several real sub-policies (Misleading ad design, Clickbait)
 * live on detail pages that were not captured, so rules resting on those are
 * marked null and shown as unsourced rather than presented as Google's words.
 */
export const POLICY_TEXT_RULES = [
  {
    id: 'fake-system-ui', area: 'Misrepresentation · Misleading ad design', severity: 'warn',
    source: null,
    label: 'Copy that imitates system UI or notifications',
    why: 'Ads may not mimic system warnings, dialogs, notifications, or device UI. "Update available", "Your phone…", "Virus detected" style copy is a standard disapproval.',
    re: /\b(update (?:available|required)|your (?:phone|device|battery|storage)|virus|malware|battery (?:low|is)|storage (?:full|almost)|system (?:alert|warning|update|error)|security (?:alert|warning)|new message|missed call|download complete|(?:1|one) new notification|allow notifications?|accept cookies?)\b/i,
  },
  {
    id: 'urgency-bait', area: 'Misrepresentation · Clickbait', severity: 'warn',
    source: null,
    label: 'Manufactured urgency',
    why: 'Copy that pressures the user with false scarcity or deadlines is treated as clickbait.',
    re: /\b(limited time|hurry|last chance|only today|today only|offer ends|ends (?:soon|tonight|today)|act now|don'?t miss|before it'?s gone|expires? (?:soon|today))\b/i,
  },
  {
    id: 'cash-promise', area: 'Misrepresentation / Gambling & games', severity: 'warn',
    source: "making misleading or unrealistic claims regarding weight loss or financial gain",
    label: 'Promises money or cash rewards',
    why: 'Real-money language needs a gambling certification and a matching app; for a casual game it is misrepresentation. This is the single most common playable disapproval for "cash" games.',
    re: /\b(real (?:money|cash|prizes?)|cash (?:prizes?|rewards?|out|app)|win (?:money|cash|\$)|earn (?:money|cash|real)|get paid|withdraw(?:al)?|payout|paypal|gift ?cards?|free money|make money|\$\s?\d{2,})\b/i,
  },
  {
    id: 'gambling-terms', area: 'Restricted content · Gambling & games', severity: 'advice',
    source: "Gambling-related ads are allowed if they comply with the policies below and the advertiser has received the proper Google Ads certification.",
    label: 'Gambling vocabulary',
    why: 'Casino terms are fine for a certified gambling advertiser and a problem for everyone else. Confirm the account holds the certification the vocabulary implies.',
    re: /\b(casino|slots?\s?machine|jackpot|roulette|blackjack|poker|betting|place your bets?|sportsbook|lottery)\b/i,
  },
  {
    id: 'superlative-claims', area: 'Misrepresentation · Misleading representation', severity: 'advice',
    source: "making offers that aren't actually available",
    label: 'Unverifiable superlatives',
    why: 'Claims like "#1", "best", "guaranteed" need substantiation. Reviewers read them as misleading when the store listing cannot back them.',
    re: /(?:^|\s)(#\s?1|no\.?\s?1|number one|the best (?:game|app)|best (?:game|app) (?:ever|of)|guaranteed|100\s?% (?:free|safe|win)|risk[- ]free|doctors? recommend)/i,
  },
  {
    id: 'shouting-punctuation', area: 'Editorial · Punctuation & symbols', severity: 'warn',
    source: "gimmicky use of words, numbers, letters, punctuation, or symbols such as FREE, f-r-e-e, and F₹€€!!",
    label: 'Repeated punctuation or symbols as emphasis',
    why: 'Google\'s editorial policy rejects repeated punctuation (!!!, ???), symbols used for emphasis ($$$, ★★★) and letters replaced by symbols.',
    re: /(!{2,}|\?{2,}|\${2,}|[★☆✨🔥]{2,}|\b[A-Z](?:[.\-\s][A-Z]){3,}\b)/,
  },
  {
    id: 'gimmick-copy', area: 'Editorial · Style requirements', severity: 'advice',
    source: "overly generic ads that contain vague phrases such as \"Buy products here\"",
    label: 'Gimmicky call-to-action copy',
    why: '"Click here", "FREE!!!", "Download now!!!" style copy is called out as gimmicky in the editorial policy.',
    re: /\b(click here|tap here|free!+|download now!+|install now!+)/i,
  },
  {
    id: 'adult-terms', area: 'Restricted content · Adult content', severity: 'warn',
    source: "Google Ads restricts certain kinds of sexual content in ads and destinations, which will only show in limited scenarios based on user search queries, user age and local laws where the ad is being served.",
    label: 'Adult or sexual vocabulary',
    why: 'Sexual content is restricted and disallowed entirely for app installs targeting a general audience.',
    re: /\b(sexy|nude|naked|xxx|porn|erotic|hentai|18\s?\+|strip(?:ping|tease)|hot (?:girls?|wives?|singles?)|dating)\b/i,
  },
  {
    id: 'restricted-vertical', area: 'Restricted content', severity: 'warn',
    source: "The policies below cover content that is sometimes legally or culturally sensitive.",
    label: 'Restricted-vertical vocabulary',
    why: 'Alcohol, tobacco/vaping, cannabis, weight loss, crypto/forex, loans and pharmaceuticals are restricted categories with eligibility requirements. Confirm the account is certified before shipping this copy.',
    re: /\b(beer|vodka|whisk(?:e)?y|wine|alcohol|cigarettes?|vap(?:e|ing)|e-?cig|cbd|cannabis|marijuana|weed|weight loss|lose weight|diet pills?|fat burn(?:er|ing)|bitcoin|crypto|nft|forex|binary options?|payday loan|personal loans?|viagra|prescription|pharmacy)\b/i,
  },
  {
    id: 'store-badge-copy', area: 'Trademarks · Store badges', severity: 'advice',
    source: null,
    label: 'Mentions a store by name',
    why: 'Store names and badges are fine only as the official, unmodified assets. Hand-drawn "Google Play" or "App Store" buttons get flagged.',
    re: /\b(google play|play store|app store|apple store)\b/i,
  },
];

/** CTA copy we recognise; absence is only advice, because the CTA is often art. */
export const CTA_RE = /\b(install(?: now| free| today)?|download(?: now| free| today)?|play (?:now|free|for free|today|here)|get (?:it|the app|the game|started|now|free|it now)|try (?:it|now|free|for free|today)|start (?:now|free|for free|today|here|learning|playing|trial)|join (?:now|free|for free|today|us)|open (?:app|now)|continue|sign up|claim (?:now|free|reward)|free trial)\b/i;

/**
 * What to look for in the artwork.
 *
 * Every check above reads text. A playable that renders its words into a PNG —
 * which most do — defeats all of them at once: the regex has nothing to match,
 * so a creative can draw "PHONE STORAGE FULL?" over a fake iOS storage panel
 * and pass every copy rule in this file.
 *
 * The AI pass is the only one that can see those pixels, and it will not go
 * looking unprompted: it is told to judge strictly against the captured policy
 * text, and the sub-policies this catches — Misleading ad design, Clickbait —
 * live on detail pages that were not captured. Left to itself it therefore
 * stays quiet about exactly the category it is best placed to catch.
 *
 * So the model is handed this list explicitly. None of it is in the captured
 * text, so a finding raised from it is reported unsourced, the same as any
 * other rule resting on a page we do not hold.
 */
export const ART_CHECKS = [
  'Imitation of system or device UI: a storage panel, settings screen, notification, permission prompt, battery or virus warning, update dialog, or anything else drawn to look like the phone speaking rather than the ad.',
  'A close, skip or X control drawn into the artwork. If it does not close the ad it is a named disapproval, and a reviewer cannot tell that it does not from a still.',
  'Gameplay the ad does not deliver: art depicting a game, mechanic or difficulty that the playable itself never shows.',
  'Borrowed identity: another company\'s logo, icon, app screenshot, or a store badge that is not the official unmodified asset.',
  'Drawn copy that would fail a copy rule if it were text — manufactured urgency, cash or reward promises, unverifiable superlatives, shouting punctuation, adult or gambling imagery.',
  'A progress bar, timer, loading state or reward counter that is decorative rather than real.',
];

/** Marker ids the converter stamps into the document so the audit can see what has been done. */
export const MARKERS = {
  shim: 'rp-google-shim',
  audioGate: 'rp-audio-gate',
};

/**
 * The basis behind one finding, by id — the answer to "says who?".
 *
 * Most ids are in CHECK_SOURCES directly. Three families are named after the
 * thing they found, so `sdk-unsupported-mintegral` rests on whatever
 * `sdk-unsupported` rests on, and a `copy-…` finding rests on the sentence its
 * own rule carries. Returns null for an id with no declared basis, which the
 * test suite treats as a failure.
 */
export function sourceFor(id) {
  if (CHECK_SOURCES[id]) return { id, ...CHECK_SOURCES[id] };
  if (id.startsWith('copy-')) {
    const rule = POLICY_TEXT_RULES.find((r) => `copy-${r.id}` === id);
    if (!rule) return null;
    // A rule with no captured sentence is declared as such rather than
    // presented as Google's wording — the same honesty the interface shows.
    return { id, basis: rule.source ? 'captured' : 'unsourced', ref: 'policies', states: rule.source || rule.why };
  }
  const m = /^(sdk-unsupported|sdk-also)-([a-z0-9]+)$/.exec(id);
  if (m) {
    const base = CHECK_SOURCES[m[1] === 'sdk-also' ? 'sdk-also-network' : m[1]];
    return { id, ...base, ref: SOURCE_REFS[m[2]] ? m[2] : base.ref };
  }
  return null;
}
