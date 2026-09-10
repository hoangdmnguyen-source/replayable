/**
 * The converter: deterministic fixes that turn a playable exported for another
 * network (mostly AppLovin / MRAID) into one Google Ads will accept and run.
 *
 * Every fixer is
 *   - pure string surgery (no DOM parse — see inspect.mjs for why),
 *   - idempotent: running it twice changes nothing the second time,
 *   - conditional: it no-ops when the document does not need it,
 * so `fixAll` can simply run them all, in a safe order, on every file.
 *
 * Runtime code the converter injects is collected in ONE <script> block in
 * <head>, stamped `id="rp-google-shim" data-rp="<parts>"`, so the audit can
 * see exactly what was added and the operator can find it in the output.
 */

import {
  EXITAPI_SRC, NETWORKS, CUSTOM_EXITS, STORAGE_RE, DIALOG_RE, MARKERS, SAFE_NAME_RE, ENABLER_CALL_RE,
} from './rules.mjs';
import { offsets, exitApiScript } from './inspect.mjs';

/* ------------------------------------------------------------------ *
 * Head surgery helpers
 * ------------------------------------------------------------------ */

/** Guarantee a <head> exists; returns html unchanged when it already does. */
export function ensureHead(html) {
  if (offsets(html).headOpenEnd > -1) return html;
  const o = offsets(html);
  if (o.htmlOpenEnd > -1) return html.slice(0, o.htmlOpenEnd) + '\n<head></head>' + html.slice(o.htmlOpenEnd);
  const body = html.search(/<body\b/i);
  if (body > -1) return html.slice(0, body) + '<head></head>\n' + html.slice(body);
  const doc = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = doc ? doc[0].length : 0;
  return html.slice(0, at) + '\n<head></head>\n' + html.slice(at);
}

/**
 * Insert right after the run of <meta> tags that opens <head>, so metas we add
 * stay in front and scripts we add come after them, in insertion order.
 */
function insertInHead(html, snippet, { afterMetas = true } = {}) {
  html = ensureHead(html);
  let at = offsets(html).headOpenEnd;
  if (afterMetas) {
    const re = /\s*<meta\b[^>]*>/gy;
    re.lastIndex = at;
    let m;
    while ((m = re.exec(html))) at = m.index + m[0].length;
  }
  return html.slice(0, at) + '\n' + snippet + html.slice(at);
}

/* ------------------------------------------------------------------ *
 * Balanced-call replacement
 * ------------------------------------------------------------------ */

/** Index of the `)` matching the `(` at `open`, string-literal aware; -1 if none within reach. */
function matchParen(s, open) {
  let depth = 0, quote = null;
  for (let i = open; i < s.length && i - open < 4000; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Replace every `head(` match plus its balanced argument list with `replacement`. */
function replaceCalls(html, re, replacement) {
  let out = '', last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(html))) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(html, open);
    if (close < 0) continue;
    out += html.slice(last, m.index) + replacement;
    last = close + 1;
    re.lastIndex = last;
  }
  return out + html.slice(last);
}

/* ------------------------------------------------------------------ *
 * Injected runtime
 * ------------------------------------------------------------------ */

const SHIM_PARTS = {
  // MRAID v2/v3 surface. The important part is not open() — it is that the
  // creative's boot gate (`ready` event, getState() !== 'loading', isViewable)
  // resolves immediately. Without this an AppLovin export sits on a black
  // screen forever on Google and still passes every static check.
  mraid: `
  if (!W.mraid) {
    var L = {}, size = function(){ return { width: W.innerWidth, height: W.innerHeight }; };
    var soon = function(fn, a){ setTimeout(function(){ try { fn.apply(null, a || []); } catch (e) {} }, 0); };
    W.mraid = {
      getVersion: function(){ return '3.0'; },
      getState: function(){ return 'default'; },
      isViewable: function(){ return true; },
      addEventListener: function(ev, fn){
        (L[ev] = L[ev] || []).push(fn);
        if (ev === 'ready') soon(fn);
        if (ev === 'viewableChange') soon(fn, [true]);
        if (ev === 'stateChange') soon(fn, ['default']);
        if (ev === 'sizeChange') soon(fn, [W.innerWidth, W.innerHeight]);
        if (ev === 'exposureChange') soon(fn, [100, size(), null]);
      },
      removeEventListener: function(ev, fn){ L[ev] = (L[ev] || []).filter(function(f){ return f !== fn; }); },
      open: function(){ W.rpExit(); },
      close: function(){}, unload: function(){}, expand: function(){}, resize: function(){},
      useCustomClose: function(){}, setOrientationProperties: function(){},
      setExpandProperties: function(){}, setResizeProperties: function(){},
      playVideo: function(){}, storePicture: function(){}, createCalendarEvent: function(){},
      getExpandProperties: function(){ var s = size(); s.useCustomClose = false; s.isModal = true; return s; },
      getResizeProperties: function(){ return {}; },
      getOrientationProperties: function(){ return { allowOrientationChange: true, forceOrientation: 'none' }; },
      getCurrentAppOrientation: function(){ return { orientation: W.innerWidth > W.innerHeight ? 'landscape' : 'portrait', locked: false }; },
      getPlacementType: function(){ return 'interstitial'; },
      getScreenSize: size, getMaxSize: size,
      getDefaultPosition: function(){ var s = size(); s.x = 0; s.y = 0; return s; },
      getCurrentPosition: function(){ var s = size(); s.x = 0; s.y = 0; return s; },
      supports: function(){ return false; },
      getLocation: function(){ return {}; },
      getAudioVolume: function(){ return 100; }
    };
  }`,
  dapi: `
  if (!W.dapi) {
    var D = {}, dsize = function(){ return { width: W.innerWidth, height: W.innerHeight }; };
    W.dapi = {
      isReady: function(){ return true; },
      isViewable: function(){ return true; },
      isDemoApp: false,
      addEventListener: function(ev, fn){
        (D[ev] = D[ev] || []).push(fn);
        if (ev === 'ready') setTimeout(function(){ try { fn(); } catch (e) {} }, 0);
        if (ev === 'viewableChange') setTimeout(function(){ try { fn({ isViewable: true }); } catch (e) {} }, 0);
        if (ev === 'adResized') setTimeout(function(){ try { fn(dsize()); } catch (e) {} }, 0);
      },
      removeEventListener: function(ev, fn){ D[ev] = (D[ev] || []).filter(function(f){ return f !== fn; }); },
      openStoreUrl: function(){ W.rpExit(); },
      getScreenSize: dsize,
      getAudioVolume: function(){ return 100; }
    };
  }`,
  facebook: `
  if (!W.FbPlayableAd) {
    W.FbPlayableAd = { onCTAClick: function(){ W.rpExit(); }, initializeLastClick: function(){}, gameLoaded: function(){} };
  }`,
  // Browser storage is prohibited; the identifiers were rewritten to these.
  storage: `
  var mem = function(){
    var d = {};
    return {
      getItem: function(k){ return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null; },
      setItem: function(k, v){ d[k] = String(v); },
      removeItem: function(k){ delete d[k]; },
      clear: function(){ d = {}; },
      key: function(i){ return Object.keys(d)[i] || null; },
      get length(){ return Object.keys(d).length; }
    };
  };
  W.rpLocalStorage = mem(); W.rpSessionStorage = mem();
  W.rpIndexedDB = { open: function(){ var r = {}; setTimeout(function(){ if (r.onerror) r.onerror(new Error('unavailable')); }, 0); return r; },
                    deleteDatabase: function(){ return {}; } };`,
  // Native dialogs mimic system UI. Overriding the globals needs no source
  // edit, so it cannot break the creative's syntax, and it catches every call
  // form including aliases. A creative that declares its own
  // `function confirm(){}` overwrites these at parse time, which is correct.
  dialog: `
  try { W.alert = function(){}; W.confirm = function(){ return true; }; W.prompt = function(){ return null; }; } catch (e) {}`,
  // Target of an assignment rewritten from `window.location.href = url`.
  // Keeping the statement an assignment means the URL expression on the right
  // is left exactly as it was, so nothing can be swallowed or mis-parsed.
  nav: `
  try {
    Object.defineProperty(W, '__rpExitTo', {
      configurable: true, get: function(){ return ''; }, set: function(){ W.rpExit(); }
    });
  } catch (e) {}`,
  // No sound before the first interaction: hold play()/resume() until a touch,
  // then release what the game asked for so its music still starts.
  audio: `
  (function(){
    var armed = false, media = [], ctxs = [], evs = ['pointerdown', 'touchstart', 'mousedown', 'keydown'];
    function arm(){
      if (armed) return; armed = true;
      for (var i = 0; i < evs.length; i++) W.removeEventListener(evs[i], arm, true);
      var m = media.slice(); media = [];
      for (var j = 0; j < m.length; j++) { try { m[j].play(); } catch (e) {} }
      var c = ctxs.slice(); ctxs = [];
      for (var k = 0; k < c.length; k++) { try { c[k].resume(); } catch (e) {} }
    }
    for (var i = 0; i < evs.length; i++) W.addEventListener(evs[i], arm, true);
    if (W.HTMLMediaElement && !W.HTMLMediaElement.prototype.__rpGate) {
      var play = W.HTMLMediaElement.prototype.play;
      W.HTMLMediaElement.prototype.play = function(){
        if (!armed) { if (media.indexOf(this) < 0) media.push(this); return Promise.resolve(); }
        return play.apply(this, arguments);
      };
      W.HTMLMediaElement.prototype.__rpGate = 1;
    }
    if (AC && AC.prototype && !AC.prototype.__rpGate) {
      var res = AC.prototype.resume;
      AC.prototype.resume = function(){
        if (!armed) { if (ctxs.indexOf(this) < 0) ctxs.push(this); return Promise.resolve(); }
        return res.apply(this, arguments);
      };
      AC.prototype.__rpGate = 1;
    }
  })();`,
};

const SHIM_ORDER = ['nav', 'mraid', 'dapi', 'facebook', 'storage', 'dialog', 'audio'];
const SHIM_RE = /\n?<script id="rp-google-shim"[^>]*>[\s\S]*?<\/script>/;

/** The one injected block, rebuilt from its part list so it is always canonical. */
export function buildShim(parts) {
  const list = SHIM_ORDER.filter((p) => parts.includes(p));
  const body = list.map((p) => SHIM_PARTS[p]).join('\n');
  return `<script id="${MARKERS.shim}" data-rp="${list.join(',')}">/* Re-Playable: Google Ads runtime shim (${list.join(', ')}) */
(function(){
  var W = window, ctxAll = [];
  // Google: all sound stops on the exit click. Pause media, suspend audio contexts, then exit.
  function stopSound(){
    try { var els = document.querySelectorAll('audio,video'); for (var i = 0; i < els.length; i++) { try { els[i].pause(); } catch (e) {} } } catch (e) {}
    for (var j = 0; j < ctxAll.length; j++) { try { ctxAll[j].suspend(); } catch (e) {} }
  }
  W.rpExit = function(){ stopSound(); try { W.ExitApi.exit(); } catch (e) {} };
  try {
    if (W.ExitApi && typeof W.ExitApi.exit === 'function' && !W.ExitApi.__rp) {
      var real = W.ExitApi.exit;
      W.ExitApi.exit = function(){ stopSound(); return real.apply(W.ExitApi, arguments); };
      W.ExitApi.__rp = 1;
    }
  } catch (e) {}
  var AC = W.AudioContext || W.webkitAudioContext;
  if (AC && AC.prototype && !AC.prototype.__rpTrack) {
    var resume0 = AC.prototype.resume;
    AC.prototype.resume = function(){ if (ctxAll.indexOf(this) < 0) ctxAll.push(this); return resume0.apply(this, arguments); };
    AC.prototype.__rpTrack = 1;
  }
  if (!W.gameReady) W.gameReady = function(){};
  if (!W.gameEnd) W.gameEnd = function(){};
  if (!W.install) W.install = function(){ W.rpExit(); };
${body}
})();
</script>`;
}

/** Parts currently declared by the shim block, if any. */
export function shimParts(html) {
  const m = /<script id="rp-google-shim" data-rp="([^"]*)"/.exec(html);
  return m ? m[1].split(',').filter(Boolean) : [];
}

/** Add `part` to the shim (creating the block right after exitapi.js, or at head start). */
function ensureShimPart(html, part) {
  const parts = shimParts(html);
  if (parts.includes(part)) return html;
  parts.push(part);
  const block = buildShim(parts);
  if (SHIM_RE.test(html)) return html.replace(SHIM_RE, '\n' + block);
  const tag = exitApiScript(html);
  if (tag.present && tag.inHead) {
    const end = html.indexOf('</script>', tag.at) + '</script>'.length;
    return html.slice(0, end) + '\n' + block + html.slice(end);
  }
  return insertInHead(html, block);
}

/* ------------------------------------------------------------------ *
 * Fixers
 * ------------------------------------------------------------------ */

const ORIENTATIONS = ['portrait', 'landscape', 'portrait,landscape'];

export const FIXERS = {
  doctype(html) {
    if (/^\s*<!doctype html/i.test(html.slice(0, 200))) return html;
    return '<!DOCTYPE html>\n' + html.replace(/^﻿?\s*(<!doctype[^>]*>\s*)?/i, '');
  },

  charset(html) {
    if (/<meta[^>]+charset/i.test(html.slice(0, 4000))) return html;
    return insertInHead(html, '<meta charset="utf-8">', { afterMetas: false });
  },

  viewport(html) {
    if (/<meta[^>]+name=["']?viewport/i.test(html)) return html;
    return insertInHead(html, '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">');
  },

  /**
   * ad.orientation is the quietest failure in the spec: a missing or malformed
   * tag is not rejected, the asset just renders portrait-only forever.
   */
  orientation(html, opts = {}) {
    const want = ORIENTATIONS.includes(opts.orientation) ? opts.orientation : 'portrait';
    const re = /<meta[^>]+name=["']?ad\.orientation["']?[^>]*>/i;
    const m = re.exec(html);
    if (m) {
      const val = /content=["']?([^"'>]+)/i.exec(m[0]);
      const ok = val && /^\s*(portrait|landscape|portrait\s*,\s*landscape|landscape\s*,\s*portrait)\s*$/i.test(val[1]);
      if (ok && !opts.forceOrientation) return html;
      return html.replace(re, `<meta name="ad.orientation" content="${want}">`);
    }
    return insertInHead(html, `<meta name="ad.orientation" content="${want}">`);
  },

  /** `<script src="mraid.js">` and friends: injected by the old host, 404 on Google. */
  'remove-sdk-script'(html) {
    return html.replace(/[ \t]*<script\b[^>]*\bsrc\s*=\s*["'][^"']*\b(?:mraid|dapi)\.js["'][^>]*>\s*<\/script>[ \t]*\n?/gi, '');
  },

  'remove-enabler-script'(html) {
    // Only when Enabler is merely loaded, never called — otherwise the creative needs it and a human must decide.
    if (ENABLER_CALL_RE.test(html)) return html;
    return html.replace(/[ \t]*<script\b[^>]*\bsrc\s*=\s*["'][^"']*(?:Enabler\.js|studio\.doubleclick)[^"']*["'][^>]*>\s*<\/script>[ \t]*\n?/gi, '');
  },

  'remove-producttype'(html) {
    return html.replace(/[ \t]*<meta[^>]+name=["']?productType["']?[^>]*>[ \t]*\n?/gi, '');
  },

  /**
   * Every click-through the creative knows becomes ExitApi.exit(): the old
   * network's CTA call, custom navigations Google forbids, and outbound links.
   */
  'exit-rewrite'(html) {
    for (const n of NETWORKS) if (n.exit) html = replaceCalls(html, n.exit, 'ExitApi.exit()');
    let usedNav = false;
    for (const c of CUSTOM_EXITS) {
      if (c.kind === 'call') { html = replaceCalls(html, c.re, 'ExitApi.exit()'); continue; }
      // Assignment: swap only the target, never the right-hand side.
      const next = html.replace(c.re, 'window.__rpExitTo =');
      if (next !== html) usedNav = true;
      html = next;
    }
    html = html.replace(/<a\b([^>]*?)\bhref\s*=\s*["']https?:\/\/[^"']*["']([^>]*)>/gi,
      (m, a, b) => `<a${a}href="#" onclick="ExitApi.exit();return false"${b.replace(/\s*\btarget\s*=\s*["'][^"']*["']/i, '')}>`);
    return usedNav ? ensureShimPart(html, 'nav') : html;
  },

  /** The official exitapi.js, as a literal tag in <head>, exactly once. */
  'exitapi-script'(html) {
    const tag = exitApiScript(html);
    if (tag.present && tag.inHead && tag.official) return html;
    html = html.replace(/[ \t]*<script[^>]+src\s*=\s*["'][^"']*exitapi\.js[^"']*["'][^>]*>\s*<\/script>[ \t]*\n?/gi, '');
    return insertInHead(html, `<script src="${EXITAPI_SRC}"></script>`);
  },

  /**
   * Stand in for whichever network SDK the creative still talks to.
   *
   * Skipped entirely for a file that already shipped its own Google build.
   * Universal SDKs bundle every network and branch at runtime, so defining
   * window.mraid there can steer the creative INTO a branch it would otherwise
   * have skipped. Nothing to gain: its Google path already works.
   */
  'sdk-shim'(html, opts = {}) {
    if (opts.nativeGoogleExit) return html;
    const code = stripShim(html);
    if (/\bmraid\b/.test(code)) html = ensureShimPart(html, 'mraid');
    if (/\bdapi\s*\./.test(code)) html = ensureShimPart(html, 'dapi');
    if (/\bFbPlayableAd\b/.test(code)) html = ensureShimPart(html, 'facebook');
    return html;
  },

  'storage-shim'(html) {
    if (!STORAGE_RE.test(stripShim(html))) return html;
    STORAGE_RE.lastIndex = 0;
    html = html.replace(STORAGE_RE, (m) => ({ localStorage: 'rpLocalStorage', sessionStorage: 'rpSessionStorage', indexedDB: 'rpIndexedDB' })[m]);
    return ensureShimPart(html, 'storage');
  },

  /** Source is never touched here; the shim overrides the globals instead. */
  'dialog-shim'(html) {
    DIALOG_RE.lastIndex = 0;
    if (!DIALOG_RE.test(stripShim(html))) return html;
    return ensureShimPart(html, 'dialog');
  },

  'strip-autoplay'(html) {
    return html.replace(/<(audio|video)\b([^>]*)>/gi, (m, t, attrs) => {
      const cleaned = attrs.replace(/\s+autoplay(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '');
      return cleaned === attrs ? m : `<${t}${cleaned}>`;
    });
  },

  'audio-gate'(html) {
    const code = stripShim(html);
    if (!/<audio\b|<video\b|new\s+Audio\s*\(|AudioContext\b|\.play\s*\(/.test(code)) return html;
    return ensureShimPart(html, 'audio');
  },
};

/** Safe order: structure → removals → rewrites → the literal exit script → shims. */
export const FIX_ORDER = [
  'doctype', 'charset', 'viewport', 'orientation',
  'remove-producttype', 'remove-enabler-script', 'remove-sdk-script',
  'exit-rewrite', 'exitapi-script',
  'sdk-shim', 'storage-shim', 'dialog-shim', 'strip-autoplay', 'audio-gate',
];

/** The creative's own code: the document minus anything the converter injected. */
export function stripShim(html) {
  return html.replace(SHIM_RE, '');
}

/* ------------------------------------------------------------------ *
 * Output verification
 *
 * The rewriters edit code as text, so a pattern that is even slightly too
 * broad can produce JavaScript that no longer parses. A syntax error takes the
 * whole script block with it and the ad renders blank, which no other check
 * here would notice. So every fixer that touches the creative's own code is
 * verified, and reverted if it breaks a script that parsed a moment ago.
 * ------------------------------------------------------------------ */

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

/** Inline scripts a browser will execute as classic JavaScript. */
export function inlineScripts(html) {
  const out = [];
  let m;
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(html))) {
    if (/\bsrc\s*=/i.test(m[1])) continue;                       // external
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(m[1]);
    // Anything but classic JS is data or a template: JSON-LD, x-tmpl, modules.
    if (type && !/^(?:text|application)\/(?:java|ecma)script$/i.test(type[1])) continue;
    out.push(m[2]);
  }
  return out;
}

/**
 * Parse without executing. Returns a message when the code is not valid
 * JavaScript, or null when it is.
 *
 * Only a SyntaxError counts. A Content-Security-Policy that forbids eval makes
 * the constructor itself throw an EvalError, which says nothing about the code
 * — reported as "parses" so a locked-down host never invents failures.
 */
export function parseError(code) {
  if (!code.trim()) return null;
  try { new Function(code); return null; }
  catch (e) { return e instanceof SyntaxError ? e.message : null; }
}

/** Whether this environment permits parse checking at all. */
export function canParse() {
  try { return new Function('') instanceof Function; } catch { return false; }
}

/** Fixers that edit the creative's own JavaScript, and so must be verified. */
const CODE_FIXERS = new Set(['exit-rewrite', 'storage-shim']);

/**
 * Run the named fixers.
 * @returns {{ html, applied, reverted, verified }}
 *   reverted  fixers whose output failed to parse and were dropped
 *   verified  false when the host forbids parse checking, so nothing was checked
 */
export function applyFixes(html, ids, opts = {}) {
  const applied = [], reverted = [];
  const verified = opts.verify === false ? false : canParse();
  // Scripts that were already broken on arrival are not the converter's doing.
  const baseline = verified ? inlineScripts(stripShim(html)).map((c) => parseError(c) !== null) : null;

  for (const id of ids) {
    const fn = FIXERS[id];
    if (!fn) continue;
    const next = fn(html, opts);
    if (next === html) continue;

    if (verified && CODE_FIXERS.has(id)) {
      const after = inlineScripts(stripShim(next));
      let broke = null;
      for (let i = 0; i < after.length; i++) {
        const err = parseError(after[i]);
        if (err && !baseline[i]) { broke = err; break; }
      }
      if (broke) { reverted.push({ id, error: broke }); continue; }
    }
    applied.push(id);
    html = next;
  }
  return { html, applied, reverted, verified };
}

/**
 * Fix everything that can be fixed without a human. Idempotent.
 *
 * Whether the file already had a Google exit of its own is decided HERE, on
 * the original document, and handed to the fixers. Deciding it later would be
 * wrong: exit-rewrite runs first and writes an ExitApi.exit() call, after
 * which every file looks like a native Google build.
 */
export function fixAll(html, opts = {}) {
  const nativeGoogleExit = /\bExitApi\s*\.\s*exit\s*\(/.test(stripShim(html)) && exitApiScript(html).present;
  return applyFixes(html, FIX_ORDER, { nativeGoogleExit, ...opts });
}

/* ------------------------------------------------------------------ *
 * Package-level helpers (ZIP entries, not HTML)
 * ------------------------------------------------------------------ */

/** Google's filename rule, applied per path segment; empty segments become "_". */
export function sanitizeName(name) {
  return name.split('/').map((seg) => seg
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+(?=\.)|(?<=\.)_+/g, '')
    .replace(/^_+|_+$/g, '') || '_').join('/');
}

export const isSafeName = (name) => SAFE_NAME_RE.test(name);

/**
 * Google wants the entry HTML at the ZIP root. Vendor archives routinely wrap
 * everything in one folder; when every entry shares that folder, strip it.
 */
export function reroot(entries) {
  const tops = new Set(entries.map((e) => e.name.split('/')[0]));
  const hasNested = entries.every((e) => e.name.includes('/'));
  if (tops.size !== 1 || !hasNested) return entries;
  const prefix = [...tops][0] + '/';
  return entries.map((e) => ({ ...e, name: e.name.slice(prefix.length) }));
}

/** The playable's entry document inside a ZIP: index.html first, then any root .html, then any .html. */
export function pickEntry(entries) {
  const htmls = entries.filter((e) => /\.html?$/i.test(e.name));
  return htmls.find((e) => /^index\.html?$/i.test(e.name))
    || htmls.find((e) => !e.name.includes('/'))
    || htmls[0] || null;
}
