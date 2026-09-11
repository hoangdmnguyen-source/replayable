/**
 * Read-only inspection of a playable's HTML.
 *
 * Everything downstream — the audit, the converter, the AI review — keys off
 * what is found here, so nothing in this module throws: an unknown framework
 * still yields usable offsets and an empty inventory.
 *
 * Deliberately pure string work. Real files are 3-5 MB with the game usually
 * base64'd into a JS string, so a DOM parse would be slow and would risk
 * re-encoding a payload the loader reads back verbatim.
 *
 * Runs unchanged under Node (tests) and in the browser (the tool page).
 */

import { NETWORKS, CUSTOM_EXITS, ALLOWED_HOSTS, EXITAPI_SRC } from './rules.mjs';

/* ------------------------------------------------------------------ *
 * Structure
 * ------------------------------------------------------------------ */

/** Index just past the opening tag `<name ...>`, or -1. */
function afterOpenTag(html, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>`, 'i').exec(html);
  return m ? m.index + m[0].length : -1;
}

export function offsets(html) {
  const lower = html.toLowerCase();
  return {
    headOpenEnd: afterOpenTag(html, 'head'),
    headClose: lower.indexOf('</head>'),
    bodyOpenEnd: afterOpenTag(html, 'body'),
    bodyClose: lower.lastIndexOf('</body>'),
    htmlOpenEnd: afterOpenTag(html, 'html'),
    htmlClose: lower.lastIndexOf('</html>'),
  };
}

/** Networks whose SDK surface appears in the document, most specific first. */
export function detectNetworks(html) {
  return NETWORKS.filter((n) => n.test.test(html)).map(({ id, label, shim }) => ({ id, label, shim }));
}

/** Custom navigations Google forbids, with a short excerpt of each for the report. */
export function customExits(html) {
  const out = [];
  for (const rule of CUSTOM_EXITS) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(html))) {
      out.push({ id: rule.id, label: rule.label, at: m.index, excerpt: html.slice(m.index, m.index + 60).replace(/\s+/g, ' ') });
      if (out.length > 50) break;
    }
  }
  return out;
}

/** Network click-through calls the converter knows how to rewrite. */
export function networkExits(html) {
  const out = [];
  for (const n of NETWORKS) {
    if (!n.exit) continue;
    n.exit.lastIndex = 0;
    let m;
    while ((m = n.exit.exec(html))) out.push({ network: n.id, at: m.index, excerpt: html.slice(m.index, m.index + 50).replace(/\s+/g, ' ') });
  }
  return out;
}

/**
 * The document with script and style BODIES removed (tags kept). Element
 * checks run on this so that minified JS like `i<input.length` cannot pass
 * for an <input> tag.
 */
export function markupOnly(html) {
  return html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2')
    .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, '$1$2')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Resources referenced by relative path. In a single-file playable every one
 * of these is a broken reference — the file was exported for a network that
 * injects its SDK (mraid.js) at serve time, or assets were never inlined.
 */
export function localRefs(html) {
  const out = [];
  const re = /<(script|link|img|audio|video|source)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  html = markupOnly(html);
  while ((m = re.exec(html))) {
    const ref = m[2].trim();
    if (/^(https?:)?\/\//i.test(ref) || /^(data|blob|javascript|about|mailto|tel):/i.test(ref) || ref.startsWith('#')) continue;
    out.push({ tag: m[1].toLowerCase(), ref });
  }
  return out;
}

/**
 * Hosts the creative LOADS from at runtime that are not on Google's allow-list.
 * Resource tags only — an <a href> is a navigation, reported as a custom exit.
 */
export function externalHosts(html) {
  const hosts = new Set();
  for (const m of markupOnly(html).matchAll(/<(?:script|link|img|audio|video|source|iframe|embed|object)\b[^>]*\b(?:src|href|data)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
    try {
      const host = new URL(m[1]).hostname;
      if (!ALLOWED_HOSTS.includes(host)) hosts.add(host);
    } catch { /* malformed URL — reported elsewhere if it matters */ }
  }
  return [...hosts];
}

/** The literal <script src=…exitapi.js> tag, and whether it sits in <head>. */
export function exitApiScript(html) {
  const m = /<script[^>]+src\s*=\s*["']([^"']*exitapi\.js[^"']*)["'][^>]*>\s*<\/script>/i.exec(html);
  if (!m) return { present: false, inHead: false, official: false, at: -1 };
  const { headClose } = offsets(html);
  return {
    present: true,
    at: m.index,
    inHead: headClose > -1 ? m.index < headClose : m.index < (html.toLowerCase().indexOf('<body') >>> 0),
    official: m[1] === EXITAPI_SRC,
  };
}

/**
 * One call, everything the audit and converter need to know about structure.
 */
export function inspect(html) {
  const networks = detectNetworks(html);
  const hasGoogleExit = /\bExitApi\s*\.\s*exit\s*\(/.test(html);
  return {
    bytes: html.length,
    hasDoctype: /^\s*<!doctype html/i.test(html.slice(0, 200)),
    terminated: html.toLowerCase().includes('</html>', Math.max(0, html.length - 500)),
    offsets: offsets(html),
    networks,
    primary: networks.find((n) => n.id !== 'google') || networks[0] || null,
    exits: {
      google: hasGoogleExit,
      superHtml: /window\.super_html\s*=/.test(html),
      network: networkExits(html),
      custom: customExits(html),
    },
    exitApiScript: exitApiScript(html),
    localRefs: localRefs(html),
    externalHosts: externalHosts(html),
    hasAudio: /<audio\b|new\s+Audio\s*\(|AudioContext\b|\.play\s*\(/.test(html),
  };
}

/* ------------------------------------------------------------------ *
 * Copy extraction
 * ------------------------------------------------------------------ */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s) => s.replace(/&(#?\w+);/g, (m, k) => ENTITIES[k] ?? (k[0] === '#' ? String.fromCharCode(parseInt(k.slice(1), 10)) || m : m));

/** Does a string literal read like something a user could see? */
function looksLikeCopy(s) {
  if (s.length < 2 || s.length > 160) return false;
  if (/data:|base64|https?:\/\/|\\u[0-9a-f]{4}|[{}<>;=]|\.(?:png|jpe?g|webp|gif|mp3|ogg|wav|json|js|css|ttf|woff2?|atlas|plist|bin)\b/i.test(s)) return false;
  const letters = (s.match(/[A-Za-zÀ-ỹ]/g) || []).length;
  if (letters < 2 || letters / s.length < 0.5) return false;
  if (/\s/.test(s.trim())) return true;                     // multi-word: copy
  // single token: accept Capitalised or ALLCAPS words (Install, PLAY), reject
  // identifiers (touchstart, gameOver, my_var, foo.bar)
  return /^[A-ZÀ-Ỹ][a-zà-ỹ]{2,}$|^[A-ZÀ-Ỹ]{3,}!?$/.test(s.trim());
}

/**
 * Visible copy: markup text and attribute labels, plus string literals in
 * inline scripts that look like UI text. Each entry carries where it came
 * from so a finding can say "in a script string" vs "in the page".
 *
 * `max` is a runaway guard, not a review budget. It sits far above any real
 * creative — a localisation table is the only thing that approaches it — so in
 * practice every distinct string is returned. Strings are deduplicated
 * case-insensitively, so the count is of distinct copy, not occurrences.
 */
export function extractText(html, { max = 5000 } = {}) {
  const seen = new Set();
  const out = [];
  const push = (text, where) => {
    const t = decode(text).replace(/\s+/g, ' ').trim();
    if (!t) return;
    const k = t.toLowerCase();
    if (seen.has(k) || out.length >= max) return;
    seen.add(k);
    out.push({ text: t, where });
  };

  // Markup: strip code, style and the head, then read text nodes and labelling
  // attributes. The head is dropped because nothing in it reaches the screen:
  // <title> is a filename more often than copy ("PLA 1", "index_4_google"), and
  // judging an ad on its filename produces findings no reviewer would ever make.
  const markup = html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  for (const m of markup.matchAll(/\b(?:alt|title|aria-label|placeholder|value)\s*=\s*["']([^"']{2,160})["']/gi)) push(m[1], 'markup');
  for (const m of markup.matchAll(/>([^<>]{2,400})</g)) {
    const t = m[1].trim();
    if (t && /[A-Za-zÀ-ỹ]{2}/.test(t)) push(t, 'markup');
  }

  // Inline scripts: string literals that read like copy.
  for (const s of html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = s[1];
    // Skip the pathological literal — a base64'd game bundle — before the
    // literal regex has to walk it.
    if (body.length > 2_000_000 && !/[\n;]/.test(body.slice(0, 5000))) continue;
    for (const m of body.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*?)\1/g)) {
      const lit = m[2];
      if (lit.length > 160) continue;
      if (looksLikeCopy(lit)) push(lit, 'script');
      if (out.length >= max) break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Art inventory (for the optional AI review's contact sheet)
 * ------------------------------------------------------------------ */

/**
 * Inlined images, in every shape an exporter actually emits.
 *
 * Each allowance here is a creative that was previously invisible to the AI
 * review, and invisible in a way that looked like a clean bill of health:
 *
 *   `i` flag       — `data:image/PNG;base64` is legal and some tools emit it.
 *   svg+xml, avif  — an SVG can carry a logo or drawn wording; avif is now
 *                    common in size-squeezed bundles.
 *   `\s` in the payload — prettified HTML wraps base64 across lines. Without
 *                    this the match stopped at the first newline and produced a
 *                    truncated payload, which decodes to nothing and was then
 *                    skipped silently as an "undecodable image".
 */
const DATA_IMG_RE = /data:image\/(png|jpe?g|webp|gif|avif|bmp|svg\+xml);base64,([A-Za-z0-9+/=\s]{200,})/gi;

/**
 * Every raster image inlined as a data: URI, largest first. Only offsets and
 * sizes — decoding is browser work and only the AI review needs pixels.
 *
 * Returns all of them by default. The review batches them across several
 * contact sheets rather than discarding the tail, so the caller decides how
 * many to draw, not this function.
 */
export function inventoryImages(html, { max = Infinity } = {}) {
  const out = [];
  let m;
  DATA_IMG_RE.lastIndex = 0;
  while ((m = DATA_IMG_RE.exec(html))) {
    const fmt = m[1].toLowerCase();
    // Size the payload on its real characters: wrapped base64 carries newlines
    // that are not data, and counting them overstates a sprite into first place.
    const payload = m[2].replace(/\s+/g, '');
    out.push({
      mime: `image/${fmt === 'jpg' ? 'jpeg' : fmt}`,
      start: m.index, length: m[0].length,
      bytes: Math.floor(payload.length * 0.75),
    });
  }
  out.sort((a, b) => b.bytes - a.bytes);
  return Number.isFinite(max) ? out.slice(0, max) : out;
}
