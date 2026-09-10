/**
 * Compliance audit for a playable, against the Google Ads target.
 *
 * Answers "what is wrong with this file?" before and after conversion. Every
 * finding is derived from the file itself — no model, no network — which is
 * what makes the result reproducible and arguable, and what makes the
 * readiness percentage mean something.
 *
 * Two areas:
 *   technical  the upload/validator and the ad slot: size, structure, exit,
 *              prohibited constructs, self-containment.
 *   policy     what a policy reviewer disapproves: system-UI mimicry, data
 *              collection, sound on load, and the copy patterns behind the
 *              most common disapprovals (see rules.mjs).
 *
 * Severity is consequence, not confidence:
 *   blocker  rejected at upload, cannot click through, or a certain policy
 *            disapproval.
 *   warn     accepted but frequently disapproved, or measurably worse.
 *   advice   fine as-is; there is a better version.
 *
 * `fix` names the converter fixer that resolves the finding (see convert.mjs),
 * or null with `manual` describing what a human has to do instead.
 */

import {
  GOOGLE_ADS_LIMITS, PROHIBITED, POLICY_TEXT_RULES, CTA_RE, STORAGE_RE, DIALOG_RE, AUTOPLAY_RE, SUSPECT_NAV, ENABLER_CALL_RE,
} from './rules.mjs';
import { inspect, extractText, markupOnly, inventoryImages } from './inspect.mjs';
import { stripShim, shimParts, isSafeName, inlineScripts, parseError } from './convert.mjs';

const f = (id, severity, area, title, detail, extra = {}) => ({
  id, severity, area, title, detail, fix: null, manual: null, measured: null,
  // quote: Google's own words backing this finding, where we have them.
  // sourced: false means the rule rests on something the captured policy page
  // does not state, and the finding says so instead of implying Google did.
  quote: '', sourced: false, ...extra,
});

const MB = (n) => `${(n / 1048576).toFixed(2)} MB`;

/**
 * @param {string} html   entry HTML of the playable (converted or not)
 * @param {object} pkg    { zipBytes, entries: [{ name, size, stored }], entryName }
 *                        zipBytes is the DEFLATED size the file would upload at.
 * @param {object} opts   { orientation } — reserved for target options
 * @returns {{ findings, info, text, shim }}
 */
export function audit(html, pkg = {}, opts = {}) {
  const info = inspect(html);
  const code = stripShim(html);
  const markup = markupOnly(code);   // element checks: tags only, never script bodies
  const shim = shimParts(html);
  const text = extractText(code);
  const findings = [];
  const entries = pkg.entries ?? [];

  /* ---------------- packaging ---------------- */

  if (pkg.zipBytes != null) {
    if (pkg.zipBytes > GOOGLE_ADS_LIMITS.maxZipBytes) {
      const stored = entries.some((e) => e.stored);
      findings.push(f('zip-size', 'blocker', 'technical', 'Over the 5 MB cap',
        'Google Ads rejects App campaign playables above 5 MB.',
        stored
          ? { fix: 'repack', measured: `${MB(pkg.zipBytes)} stored — recompressing usually recovers enough` }
          : { manual: 'Re-encode the largest images as WebP or drop unused assets; nothing automatic gets a deflated file under the cap.', measured: `${MB(pkg.zipBytes)} of 5 MB` }));
    } else if (pkg.zipBytes > GOOGLE_ADS_LIMITS.maxZipBytes * 0.95) {
      findings.push(f('zip-headroom', 'advice', 'technical', 'Almost no room under the cap',
        'Under 5% headroom. Any later edit can push the ZIP over.',
        { measured: `${MB(pkg.zipBytes)} — ${((1 - pkg.zipBytes / GOOGLE_ADS_LIMITS.maxZipBytes) * 100).toFixed(1)}% free` }));
    }
  }

  if (entries.length > GOOGLE_ADS_LIMITS.maxFiles) {
    findings.push(f('zip-files', 'blocker', 'technical', 'Too many files in the ZIP',
      `The cap is ${GOOGLE_ADS_LIMITS.maxFiles} files.`, { measured: `${entries.length} files`, manual: 'Merge or drop assets.' }));
  }

  const badNames = entries.filter((e) => !isSafeName(e.name));
  if (badNames.length) {
    findings.push(f('filenames', 'blocker', 'technical', 'Filenames contain disallowed characters',
      'Google allows only letters, numbers, dot, dash and underscore in file and folder names — spaces and parentheses are rejected.',
      { fix: 'sanitize-names', measured: badNames.slice(0, 3).map((e) => e.name).join(', ') + (badNames.length > 3 ? ` +${badNames.length - 3} more` : '') }));
  }

  const htmls = entries.filter((e) => /\.html?$/i.test(e.name));
  if (htmls.length && !htmls.some((e) => !e.name.includes('/'))) {
    const tops = new Set(entries.map((e) => e.name.split('/')[0]));
    findings.push(f('entry-not-root', 'warn', 'technical', 'Entry HTML is not at the ZIP root',
      'Google looks for the HTML at the root of the archive. Vendor exports often wrap everything in a folder.',
      tops.size === 1 ? { fix: 'reroot', measured: htmls[0].name } : { manual: 'Move the entry HTML and its assets to the root.', measured: htmls[0].name }));
  }

  /* ---------------- document integrity ---------------- */

  if (!info.hasDoctype) {
    findings.push(f('doctype', 'warn', 'technical', 'Missing <!DOCTYPE html>',
      'Without it browsers fall back to quirks mode, which changes layout maths the game may rely on.', { fix: 'doctype' }));
  }
  if (!info.terminated) {
    findings.push(f('truncated', 'blocker', 'technical', 'HTML is not terminated',
      'No closing </html> near the end — the file is likely truncated and will not run.', { manual: 'Re-export the playable.' }));
  }

  // Last line of defence. A script that does not parse takes its whole block
  // with it and the ad renders blank, which every other check here would miss.
  for (const script of inlineScripts(code)) {
    const err = parseError(script);
    if (!err) continue;
    findings.push(f('script-syntax', 'blocker', 'technical', 'An inline script is not valid JavaScript',
      'The browser runs none of that block, so the ad renders blank. Do not upload this file.',
      { manual: 'Re-export the playable. If conversion caused this, report the file so the converter can be corrected.', measured: err.slice(0, 160) }));
    break;
  }
  if (!/<meta[^>]+charset/i.test(html.slice(0, 4000))) {
    findings.push(f('charset', 'warn', 'technical', 'No charset declared',
      'Non-ASCII copy renders as mojibake without an explicit charset.', { fix: 'charset' }));
  }
  if (!/<meta[^>]+name=["']?viewport/i.test(html)) {
    findings.push(f('viewport', 'warn', 'technical', 'No viewport meta tag',
      'Mobile browsers assume a desktop width and scale the canvas down — the ad renders small and blurry.', { fix: 'viewport' }));
  }

  const orient = html.match(/<meta[^>]+name=["']?ad\.orientation["']?[^>]*content=["']?([^"'>]+)/i);
  if (!orient) {
    findings.push(f('ad-orientation', 'warn', 'technical', 'No ad.orientation meta',
      'Google does not reject this — the asset silently renders portrait-only. Declare the orientations the game supports.',
      { fix: 'orientation', measured: 'expected <meta name="ad.orientation" content="portrait|landscape|portrait,landscape">' }));
  } else if (!/^\s*(portrait|landscape|portrait\s*,\s*landscape|landscape\s*,\s*portrait)\s*$/i.test(orient[1])) {
    findings.push(f('ad-orientation-bad', 'warn', 'technical', 'Malformed ad.orientation value',
      'Anything Google cannot parse falls back to portrait-only, silently.', { fix: 'orientation', measured: orient[1].trim() }));
  }

  /* ---------------- other networks' SDKs ---------------- */

  const sdkRefs = info.localRefs.filter((r) => /\b(?:mraid|dapi)\.js$/i.test(r.ref));
  if (sdkRefs.length) {
    findings.push(f('sdk-script', 'blocker', 'technical', `Loads ${sdkRefs.map((r) => r.ref).join(', ')}`,
      'The old network injected this file at serve time. On Google it does not exist: the request 404s and the creative usually never boots.',
      { fix: 'remove-sdk-script', measured: sdkRefs.map((r) => `<${r.tag} src="${r.ref}">`).join(' ') }));
  }

  const missing = info.localRefs.filter((r) => !sdkRefs.includes(r) && !entries.some((e) => e.name === r.ref || e.name.endsWith('/' + r.ref)));
  if (missing.length) {
    findings.push(f('missing-local-ref', missing.some((r) => r.tag === 'script') ? 'blocker' : 'warn', 'technical',
      'References files that are not in the package',
      'A single-file playable must inline everything. These paths will 404 in the ad slot.',
      { manual: 'Inline the asset as a data: URI or add it to the ZIP.', measured: missing.slice(0, 4).map((r) => r.ref).join(', ') + (missing.length > 4 ? ` +${missing.length - 4} more` : '') }));
  }

  /**
   * Does the creative carry a Google exit of its own? Universal SDKs bundle
   * every network into one file and pick at runtime, so MRAID code proves
   * nothing on its own. The exitapi.js tag is NOT required here: a missing tag
   * is its own finding and the converter always adds it, so a file with an
   * ExitApi.exit() call is one tag away from running its own Google path.
   */
  const nativeGoogle = /\bExitApi\s*\.\s*exit\s*\(/.test(code);

  /**
   * One finding for all of them, not one per network.
   *
   * A multi-network export carrying MRAID, DAPI and FbPlayableAd is not three
   * times worse than one carrying MRAID alone: it is a single fact about how
   * the file was built, and a single fixer resolves all of them together.
   * Charging it three times drove real files straight past the floor to 0%.
   */
  const sdk = [
    { part: 'mraid', re: /\bmraid\b/, label: 'MRAID', boot: 'MRAID creatives wait for the `ready` event or poll getState() before starting; with no SDK they sit on a black screen.' },
    { part: 'dapi', re: /\bdapi\s*\./, label: 'ironSource DAPI', boot: 'DAPI creatives wait for isReady() or the `ready` event before starting.' },
    { part: 'facebook', re: /\bFbPlayableAd\b/, label: 'FbPlayableAd', boot: 'The CTA calls FbPlayableAd.onCTAClick(), which throws when the object is absent.' },
  ];
  const present = sdk.filter((s) => s.re.test(code) && !shim.includes(s.part));
  if (present.length) {
    const names = present.map((s) => s.label).join(', ');
    findings.push(nativeGoogle
      ? f('sdk-also', 'warn', 'technical', `One bundle built for several networks (${names})`,
        'It already calls ExitApi.exit(), so the Google path is present and the other networks\' code should be unreachable here. The converter installs stand-ins anyway, because a creative can wait on another network\'s SDK before it will start.',
        { fix: 'sdk-shim', measured: names })
      : f('sdk-calls', 'blocker', 'technical', `Talks to ${names}, which Google does not provide`,
        `${present[0].boot} The converter installs stand-ins that report ready immediately and route the click to ExitApi.exit().`,
        { fix: 'sdk-shim', measured: names }));
  }
  // Same rule as above: a file with its own ExitApi.exit() call is a
  // multi-network build. Its unsupported networks are branches that the Google
  // path makes unreachable, not a broken exit — so this drops to advice and
  // says what to look for instead of implying the click may be lost.
  for (const n of info.networks) {
    if (n.id === 'google' || n.shim) continue;
    findings.push(nativeGoogle
      ? f(`sdk-also-${n.id}`, 'advice', 'technical', `Also carries ${n.label} code`,
        'This SDK cannot be stood in for, but the file already calls ExitApi.exit(), so its Google path should win and this branch never run. Worth one look in the preview: tap the CTA and check the green badge appears.',
        { manual: 'Tap the CTA in the preview; the badge confirms the click reached ExitApi.exit().' })
      : f(`sdk-unsupported-${n.id}`, 'warn', 'technical', `Built for ${n.label}`,
        'This SDK cannot be shimmed automatically, and the file has no Google exit of its own. Confirm in the preview that the creative boots and that its CTA reaches ExitApi.exit().',
        { manual: 'Preview it; wire the CTA to ExitApi.exit() by hand if it does not fire.' }));
  }

  /* ---------------- exit ---------------- */

  // `window.__rpExitTo = url` is what the converter leaves behind when it
  // rewrites a navigation: the shim installs a setter on it that calls
  // ExitApi.exit(). It counts as a Google exit. Missing it made correctly
  // converted files report a "no exit" blocker and read as "Will be rejected".
  const hasGoogleExit = /\bExitApi\s*\.\s*exit\s*\(/.test(code)
    || (/\b__rpExitTo\s*=(?!=)/.test(code) && shim.includes('nav'))
    || info.exits.superHtml;
  const outboundLinks = (code.match(/<a\b[^>]*\bhref\s*=\s*["']https?:\/\//gi) || []).length;
  const rewritable = info.exits.network.length + info.exits.custom.length + outboundLinks;
  if (!hasGoogleExit) {
    findings.push(f('no-google-exit', 'blocker', 'technical', 'Nothing calls ExitApi.exit()',
      'Google registers the click-through only via ExitApi.exit(). Without it the ad cannot convert, and custom exits are disapproved.',
      rewritable
        ? { fix: 'exit-rewrite', measured: [...info.exits.network.map((x) => x.excerpt), ...info.exits.custom.map((x) => x.excerpt)].slice(0, 3).join(' · ') || `${outboundLinks} outbound link(s)` }
        : { manual: 'Find the CTA handler and call ExitApi.exit() from it.' }));
  }
  // With a working Google exit already present, a window.open() or location
  // change is almost always a fallback branch for another network that Google
  // never reaches. Still worth a look, but it is not why an upload fails.
  if (info.exits.custom.length) {
    findings.push(nativeGoogle
      ? f('custom-exit-fallback', 'warn', 'technical', 'Also navigates on its own in places',
        'The file already exits through ExitApi.exit(), so these are most likely fallback branches for another network. Google rejects custom exits it actually reaches, so confirm these are unreachable, or let the converter route them through ExitApi.exit() too.',
        { fix: 'exit-rewrite', measured: info.exits.custom.slice(0, 3).map((x) => x.excerpt).join(' · ') })
      : f('custom-exit', 'blocker', 'technical', 'Navigates on its own instead of calling ExitApi.exit()',
        'window.open() and location changes are custom exits — Google rejects them (CUSTOM_EXIT_NOT_ALLOWED) and they lose the click.',
        { fix: 'exit-rewrite', measured: info.exits.custom.slice(0, 3).map((x) => x.excerpt).join(' · ') }));
  }
  if (outboundLinks) {
    findings.push(f('custom-exit-link', nativeGoogle ? 'warn' : 'blocker', 'technical', 'Outbound <a href> links',
      'A plain link to the store is a custom exit. The click has to go through ExitApi.exit().',
      { fix: 'exit-rewrite', measured: `${outboundLinks} link(s)` }));
  }

  SUSPECT_NAV.lastIndex = 0;
  const suspect = [...code.matchAll(SUSPECT_NAV)];
  if (suspect.length) {
    findings.push(f('suspect-nav', 'warn', 'technical', 'Navigates through a reference the converter cannot identify',
      'Something like `frame.location.href = url`. If that object is a window, this is a custom exit Google rejects. The converter will not rewrite it, because the object may not be a window at all.',
      { manual: 'Check by hand; if it is an exit, call ExitApi.exit() instead.',
        measured: suspect.slice(0, 3).map((m) => code.slice(Math.max(0, m.index - 12), m.index + 30).replace(/\s+/g, ' ').trim()).join(' · ') }));
  }

  const tag = info.exitApiScript;
  if (!tag.present) {
    findings.push(f('exitapi-script', 'blocker', 'technical', 'exitapi.js is not loaded',
      'App campaign playables must load exitapi.js from tpc.googlesyndication.com as a literal <script> in <head>. Without it ExitApi is undefined at click time.',
      { fix: 'exitapi-script' }));
  } else if (!tag.inHead || !tag.official) {
    findings.push(f('exitapi-placement', 'warn', 'technical', tag.inHead ? 'exitapi.js loaded from a non-official URL' : 'exitapi.js is not in <head>',
      'The literal tag belongs in <head> and must point at Google\'s own URL. Anywhere else, Google makes the whole ad area clickable at serve time — a flood of accidental clicks.',
      { fix: 'exitapi-script' }));
  }
  if (/exitapi\.js/i.test(code.replace(/<script[^>]+src\s*=\s*["'][^"']*exitapi\.js[^"']*["'][^>]*>\s*<\/script>/gi, ''))) {
    findings.push(f('exitapi-dynamic', 'warn', 'technical', 'exitapi.js is also injected from JavaScript',
      'When exitapi.js is added by script, Google treats the entire ad as the click target.',
      { manual: 'Remove the dynamic injection; the literal tag in <head> is enough.' }));
  }

  /* ---------------- prohibited constructs ---------------- */

  STORAGE_RE.lastIndex = 0;
  if (STORAGE_RE.test(code)) {
    findings.push(f('prohibited-storage', 'blocker', 'technical', 'Uses browser storage',
      'localStorage, sessionStorage and IndexedDB are prohibited in HTML5 ad assets. The converter swaps them for in-memory stand-ins.',
      { fix: 'storage-shim', measured: [...new Set(code.match(STORAGE_RE) || [])].join(', ') }));
  }
  for (const p of PROHIBITED) {
    // Enabler is a JS API; the rest are tags.
    if (!p.re.test(p.id === 'enabler' ? code : markup)) continue;
    // The fixer, where the table names one. Enabler is the exception: removing
    // the script tag only helps a file that never calls into the API.
    const fixable = p.fix && !(p.id === 'enabler' && ENABLER_CALL_RE.test(code));
    const extra = fixable ? { fix: p.fix } : { manual: 'Needs a change in the creative itself.' };
    findings.push(f(`prohibited-${p.id}`, 'blocker', 'technical', `Prohibited: ${p.label}`, p.why, { measured: p.label, ...extra }));
  }
  if (/<video(?![^>]*\bsrc=)[^>]*>/i.test(markup)) {
    findings.push(f('prohibited-video-nosrc', 'blocker', 'technical', 'Prohibited: <video> without src',
      'A <video> element with no src attribute is disallowed in Google Ads HTML5 assets.', { manual: 'Give the element a src or remove it.' }));
  }
  if (info.externalHosts.length) {
    findings.push(f('external-refs', 'blocker', 'technical', 'Loads resources from outside the package',
      'Playables must be self-contained. Anything fetched at runtime is a "fourth-party call" and fails in the ad slot; only Google\'s own hosts are permitted.',
      { manual: 'Inline the resources as data: URIs.', measured: info.externalHosts.join(', ') }));
  }

  /* ---------------- policy: behaviour ---------------- */

  DIALOG_RE.lastIndex = 0;
  if (DIALOG_RE.test(code) && !shim.includes('dialog')) {
    findings.push(f('dialogs', 'warn', 'Misrepresentation · Misleading ad design', 'Opens native alert/confirm/prompt dialogs',
      'System-style dialogs read as mimicking device UI and interrupt the ad. The converter overrides them with no-ops from the shim, leaving the creative\'s own code untouched.',
      { fix: 'dialog-shim' }));
  }
  if (AUTOPLAY_RE.test(markup)) {
    findings.push(f('autoplay-media', 'warn', 'Technical · Sound before interaction', 'Media is set to autoplay',
      'Sound may not play before the user interacts with the ad. The converter removes the autoplay attribute.',
      { fix: 'strip-autoplay' }));
  }
  if (info.hasAudio && !shim.includes('audio')) {
    findings.push(f('audio-ungated', 'advice', 'Technical · Sound before interaction', 'Audio present without an interaction gate',
      'Google requires all sound to be user-initiated and to stop on the exit click. The converter holds play()/resume() until the first touch and pauses everything on exit.',
      { fix: 'audio-gate' }));
  }
  if (/<form(?=[\s>])|<textarea(?=[\s>])|<input(?=[\s>/])(?![^>]*\btype\s*=\s*["']?(?:hidden|checkbox|radio|range|file|button|submit|image|color)\b)/i.test(markup)) {
    findings.push(f('data-collection', 'blocker', 'Data collection and use', 'Contains text-entry fields',
      'An ad may not collect personal information. Any form or text input in the creative is a disapproval.',
      { manual: 'Remove the input fields; collect nothing inside the ad.' }));
  }
  if (/(?:id|class)\s*=\s*["'][^"']*\b(?:close|skip|dismiss)(?:-?btn|-?button)?\b[^"']*["']|>\s*[×✕✖]\s*</i.test(markup)) {
    findings.push(f('close-control', 'advice', 'Misrepresentation · Misleading ad design', 'Has a close/skip-style control',
      'Non-functional close buttons are a named disapproval. If this control is part of gameplay, make sure it visibly does something; if it imitates the ad\'s own close button, remove it.',
      { manual: 'Verify in the preview.' }));
  }

  /* ---------------- policy: copy ---------------- */

  /**
   * Canvas playables draw their words instead of writing them. A PixiJS or
   * Cocos creative renders every headline and button label into a WebP, so the
   * document holds engine error strings and nothing a reviewer would read.
   *
   * That has to be said out loud. Every copy rule below matches against text,
   * so on such a file they all pass while checking nothing at all — a silent
   * clean bill of health on wording no one has looked at. The AI review is the
   * only pass here that can read the art.
   */
  const images = inventoryImages(code, { max: 200 });
  const artBytes = images.reduce((n, i) => n + i.bytes, 0);
  const markupProse = text.filter((t) => t.where === 'markup' && /\s/.test(t.text)).length;
  const copyIsArt = images.length >= 6 && artBytes > 50_000 && markupProse === 0;
  if (copyIsArt) {
    findings.push(f('copy-in-images', 'warn', 'Policy · coverage', 'The ad\'s wording is drawn into its images',
      'Nothing readable was found in the document, so none of the copy checks below could examine this creative. They did not pass; they had nothing to read. Use the AI review, which is given a contact sheet of the artwork, or read the preview yourself.',
      { manual: 'Run the AI policy review, or check the wording by eye in the preview.',
        measured: `${images.length} inlined images, ${(artBytes / 1024).toFixed(0)} KB of artwork, ${text.length} readable strings and none of them ad copy` }));
  }

  for (const rule of POLICY_TEXT_RULES) {
    const hits = [];
    for (const t of text) {
      const m = rule.re.exec(t.text);
      if (m) hits.push({ match: m[0].trim(), text: t.text, where: t.where });
      if (hits.length >= 3) break;
    }
    if (!hits.length) continue;
    findings.push(f(`copy-${rule.id}`, rule.severity, rule.area, rule.label, rule.why, {
      manual: 'Change the copy.',
      // Google's own sentence where the captured page states the rule, so a
      // finding can be checked rather than taken on trust.
      quote: rule.source || '',
      sourced: !!rule.source,
      measured: hits.map((h) => `“${h.text.length > 60 ? h.text.slice(0, 57) + '…' : h.text}”${h.where === 'script' ? ' (script string)' : ''}`).join(' · '),
    }));
  }
  // Pointless to report on a creative whose every word is a picture: the
  // copy-in-images finding above already says the text cannot be read.
  if (!copyIsArt && text.length && !text.some((t) => CTA_RE.test(t.text))) {
    findings.push(f('no-cta-copy', 'advice', 'Editorial · Clear call to action', 'No recognisable CTA copy',
      'No "Install", "Download", "Play now" or similar text was found. Fine if the CTA is drawn art; a reviewer still wants an unmistakable exit action.',
      { manual: 'Ignore if the CTA is an image.' }));
  }

  return { findings, info, text, shim };
}

/** One-line verdict for a headline. */
export function verdict(findings) {
  const counts = { blocker: 0, warn: 0, advice: 0 };
  for (const x of findings) counts[x.severity]++;
  if (counts.blocker) return { label: 'Will be rejected', tone: 'bad' };
  if (counts.warn) return { label: 'Accepted, but weaker than it should be', tone: 'warn' };
  return { label: 'Meets the checks we can verify', tone: 'ok' };
}
