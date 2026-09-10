/**
 * Engine tests. No framework, no network.
 *
 *   node engine/test.mjs
 *
 * Covers: a synthesised AppLovin/MRAID export end to end (inspect → audit →
 * fixAll → audit again), the injected runtime executing in a fake window, the
 * rewriters never producing code that fails to parse, and every policy rule
 * either quoting Google's captured page or admitting that it cannot.
 *
 * Drop a real playable .zip into fixtures/ and it is put through the pipeline
 * too. None ships with the repo; a vendor's creative is not ours to publish.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { inspect, extractText } from './inspect.mjs';
import { audit } from './audit.mjs';
import { fixAll, applyFixes, shimParts, sanitizeName, reroot, pickEntry, inlineScripts, parseError, stripShim, canParse } from './convert.mjs';
import { score } from './score.mjs';
import { readZip, writeZip } from './zip.mjs';
import { buildPrompt, normalizeFindings, review, parseJsonLoose, supportsVision, detectProvider, PROVIDERS, POLICY_TEXT, POLICY_SOURCE, networkFailureHelp } from './aiscan.mjs';
import { POLICY_TEXT_RULES, GOOGLE_ADS_LIMITS, EXITAPI_SRC, CTA_RE, PROHIBITED, NETWORKS, SOURCE_REFS, SOURCE_FAMILIES, CHECK_SOURCES, sourceFor } from './rules.mjs';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; return; }
  failed++;
  console.error('  ✗ ' + msg);
}
const eq = (a, b, msg) => ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const has = (list, id) => list.some((x) => x.id === id);
const ids = (list) => list.map((x) => x.id).sort().join(' ');

/* ------------------------------------------------------------------ *
 * Fixture: what an AppLovin export typically looks like
 * ------------------------------------------------------------------ */

const APPLOVIN = `<html>
<head>
<script src="mraid.js"></script>
<title>Mahjong Cash!!!</title>
<style>body{margin:0;background:#123}</style>
</head>
<body>
<div id="cta" class="btn">INSTALL NOW</div>
<div class="close-btn">×</div>
<audio id="bgm" src="data:audio/mpeg;base64,AAAA" autoplay loop></audio>
<a href="https://play.google.com/store/apps/details?id=com.x" target="_blank">Get it</a>
<script>
var best = localStorage.getItem('best') || 0;
sessionStorage.setItem('seen', '1');
function boot(){ document.body.setAttribute('data-booted', '1'); }
if (mraid.getState() === 'loading') { mraid.addEventListener('ready', boot); } else { boot(); }
document.getElementById('cta').addEventListener('click', function(){ mraid.open('https://play.google.com/store/apps/details?id=com.x'); });
function fallback(){ window.open('https://example.com', '_blank'); }
function fallback2(){ location.href = 'https://example.com/x'; }
function fallback3(){ top.location.replace(getUrl('a', (1+2)) ); }
function sfx(){ new Audio('data:audio/mpeg;base64,AAAA').play(); }
alert('Update available!');
var msg = 'Hurry! Limited time offer';
</script>
</body>
</html>`;

console.log('inspect');
{
  const i = inspect(APPLOVIN);
  eq(i.primary && i.primary.id, 'mraid', 'primary network is MRAID');
  eq(i.exits.network.length, 1, 'one mraid.open() call');
  eq(i.exits.custom.length, 3, 'three custom exits (window.open, location.href=, location.replace)');
  ok(i.localRefs.some((r) => r.ref === 'mraid.js'), 'mraid.js is a local ref');
  eq(i.hasDoctype, false, 'no doctype');
  eq(i.exits.google, false, 'no ExitApi.exit yet');
  eq(i.exitApiScript.present, false, 'no exitapi.js yet');
  ok(i.hasAudio, 'audio detected');

  const t = extractText(APPLOVIN);
  ok(t.some((x) => x.text === 'INSTALL NOW' && x.where === 'markup'), 'markup copy extracted');
  ok(t.some((x) => x.text === 'Update available!' && x.where === 'script'), 'script string copy extracted');
  ok(!t.some((x) => /^data-booted$/.test(x.text)), 'identifiers are not copy');
}

console.log('audit before');
let before;
{
  before = audit(APPLOVIN, { zipBytes: 4000, entries: [{ name: 'index.html', size: APPLOVIN.length }] });
  const F = before.findings;
  for (const id of ['sdk-script', 'sdk-calls', 'no-google-exit', 'custom-exit', 'custom-exit-link', 'exitapi-script', 'prohibited-storage']) {
    ok(has(F, id) && F.find((x) => x.id === id).severity === 'blocker', `blocker ${id}`);
  }
  for (const id of ['doctype', 'charset', 'viewport', 'ad-orientation', 'dialogs', 'autoplay-media']) ok(has(F, id), `finding ${id}`);
  // One finding for the whole multi-network fact, not one per network. Charging
  // it three times sent real files past the floor and showed them as 0%.
  {
    const multi = APPLOVIN.replace('var best =', 'dapi.openStoreUrl();FbPlayableAd.onCTAClick();var best =');
    const M = audit(multi, { zipBytes: 4000, entries: [{ name: 'index.html', size: multi.length }] }).findings;
    eq(M.filter((x) => /^sdk-calls/.test(x.id)).length, 1, 'three SDKs still produce one finding');
    ok(/MRAID.*DAPI.*FbPlayableAd/s.test(M.find((x) => x.id === 'sdk-calls').measured), 'and it names all three');
    // Compare unclamped cost, not the percentage: this fixture is bad enough to
    // floor at zero either way, which is exactly what hid the triple charge.
    eq(score(M).cost, score(before.findings).cost, 'and costs no more than a single-network export');
  }
  // A file carrying its own ExitApi.exit() call is a multi-network build, not a
  // broken one: the other networks drop to a warning even before the tag is added.
  {
    const uni = APPLOVIN.replace('mraid.open(', 'if(window.ExitApi)ExitApi.exit();else mraid.open(');
    const U = audit(uni, { zipBytes: 4000, entries: [{ name: 'index.html', size: uni.length }] }).findings;
    ok(has(U, 'sdk-also'), 'multi-network build reported as such');
    eq(U.find((x) => x.id === 'sdk-also').severity, 'warn', 'and only as a warning');
    ok(!has(U, 'sdk-calls'), 'not as a blocker');
    ok(score(U).cost < score(before.findings).cost, 'and costs less than a file with no Google path at all');
  }
  ok(has(F, 'copy-fake-system-ui'), 'policy: fake system UI copy ("Update available")');
  ok(has(F, 'copy-urgency-bait'), 'policy: urgency copy ("Hurry! Limited time")');
  ok(has(F, 'copy-shouting-punctuation'), 'policy: shouting punctuation ("!!!")');
  ok(has(F, 'close-control'), 'policy: close-style control');
  ok(has(F, 'audio-ungated'), 'audio without gate');
  const s = score(F);
  ok(s.pct < 40, `before score is low (${s.pct}%)`);
  // Every blocker on a raw AppLovin export is one the converter clears, so the
  // verdict says so rather than "Will be rejected" — a file one button away
  // from working is not the same as one needing a person.
  eq(s.mustFix, 0, 'no blocker here needs a human');
  ok(s.autoFix > 0, 'and several are auto-fixable');
  eq(s.verdict.tone, 'warn', 'verdict: not uploadable as-is, Fix all clears it');
  ok(/Fix all/.test(s.verdict.label), 'verdict names the remedy');
  // A blocker with no automatic fix is what actually means rejection.
  const hard = score([{ severity: 'blocker', fix: null }]);
  eq(hard.verdict.tone, 'bad', 'a blocker needing a human reads as rejected');
  eq(hard.mustFix, 1, 'and is counted as must-fix');
  // A clean file still reads as ready.
  eq(score([]).verdict.tone, 'ok', 'no findings: ready');
  eq(score([{ severity: 'warn' }]).verdict.tone, 'ok', 'one warning still reads ready');
  eq(score([{ severity: 'warn' }, { severity: 'warn' }, { severity: 'warn' }]).verdict.tone, 'warn', 'several warnings: worth a look');
  // every blocker we expect the converter to handle names a fixer
  for (const x of F.filter((y) => y.severity === 'blocker')) ok(x.fix, `blocker ${x.id} is auto-fixable`);
}

console.log('fixAll');
let fixed;
{
  const r = fixAll(APPLOVIN, { orientation: 'portrait' });
  fixed = r.html;
  for (const id of ['doctype', 'charset', 'viewport', 'orientation', 'remove-sdk-script', 'exit-rewrite', 'exitapi-script', 'sdk-shim', 'storage-shim', 'dialog-shim', 'strip-autoplay', 'audio-gate']) {
    ok(r.applied.includes(id), `applied ${id}`);
  }
  ok(/^<!DOCTYPE html>/.test(fixed), 'doctype first');
  const head = fixed.slice(0, fixed.indexOf('</head>'));
  ok(head.includes(`<script src="${EXITAPI_SRC}"></script>`), 'official exitapi.js tag in head');
  ok(head.indexOf('<meta charset') < head.indexOf('exitapi.js'), 'charset precedes exitapi.js');
  ok(head.indexOf('exitapi.js') < head.indexOf('rp-google-shim'), 'exitapi.js precedes the shim');
  ok(head.includes('<meta name="ad.orientation" content="portrait">'), 'ad.orientation meta');
  ok(!/mraid\.js/.test(fixed), 'mraid.js tag removed');
  ok(!/mraid\s*\.\s*open\s*\(/.test(fixed), 'mraid.open() rewritten');
  ok(!/window\.open\s*\(/.test(fixed), 'window.open() rewritten');
  ok(!/location\.href\s*=/.test(fixed), 'location.href= rewritten');
  ok(!/location\.replace\s*\(/.test(fixed), 'location.replace() with nested parens rewritten');
  ok(/window\.__rpExitTo =\s*'https:\/\/example\.com\/x'/.test(fixed), 'assignment keeps its right-hand side intact');
  ok(/onclick="ExitApi\.exit\(\);return false"/.test(fixed) && !/target="_blank"/.test(fixed), 'outbound anchor rewired');
  eq((fixed.match(/ExitApi\.exit\(\)/g) || []).length >= 4, true, 'ExitApi.exit() at every call site');
  ok(!/\b(localStorage|sessionStorage)\b/.test(fixed), 'storage identifiers rewritten');
  ok(/rpLocalStorage\.getItem/.test(fixed), 'localStorage → rpLocalStorage');
  ok(/alert\('Update available!'\)/.test(fixed), "alert() left in the source — the shim overrides the global instead");
  ok(!/rpDialog/.test(fixed), 'no rpDialog rewrite is emitted any more');
  ok(!/autoplay/.test(fixed), 'autoplay stripped');
  ok(/<audio id="bgm" src="[^"]+" loop>/.test(fixed), 'audio tag otherwise intact');
  eq(shimParts(fixed).join(','), 'nav,mraid,storage,dialog,audio', 'shim parts');
  eq(r.reverted.length, 0, 'nothing had to be reverted');
  eq(r.verified, true, 'output was parse-verified');
  for (const code of inlineScripts(stripShim(fixed))) eq(parseError(code), null, 'converted script parses');

  const again = fixAll(fixed, { orientation: 'portrait' });
  eq(again.applied.length, 0, 'fixAll is idempotent');
  eq(again.html, fixed, 'second pass leaves the document alone');

  // Non-exit location variables and properties must be untouched
  const gameScript = '<script>let location = 0; item.location = 5; var obj = { location: 1 };</script>';
  const fixedGame = fixAll(gameScript).html;
  ok(fixedGame.includes('let location = 0;'), 'let location untouched');
  ok(fixedGame.includes('item.location = 5;'), 'item.location untouched');
  ok(fixedGame.includes('{ location: 1 }'), 'object location property untouched');

  const forced = fixAll(fixed, { orientation: 'landscape', forceOrientation: true }).html;
  ok(forced.includes('content="landscape"') && !forced.includes('content="portrait"'), 'forced orientation replaces the meta');
}

console.log('audit after');
{
  const after = audit(fixed, { zipBytes: 6000, entries: [{ name: 'index.html', size: fixed.length }] });
  const F = after.findings;
  eq(F.filter((x) => x.severity === 'blocker').length, 0, `no blockers remain (${ids(F.filter((x) => x.severity === 'blocker'))})`);
  ok(!has(F, 'sdk-calls'), 'shimmed mraid no longer flagged');
  ok(!has(F, 'audio-ungated'), 'audio gate recognised');
  ok(!has(F, 'dialogs'), 'dialogs resolved');
  ok(!has(F, 'exitapi-script') && !has(F, 'exitapi-placement'), 'exitapi.js placement fine');
  ok(has(F, 'copy-fake-system-ui'), 'copy findings survive (they need a human)');
  ok(F.every((x) => x.fix === null), `everything left is manual (${ids(F.filter((x) => x.fix))})`);
  const s = score(F);
  ok(s.pct >= 60, `after score rises (${s.pct}%)`);
  ok(s.pct > score(before.findings).pct + 40, 'fix all moved the score substantially');
}

console.log('shim runtime');
{
  // Execute the injected block in a fake window: the boot gate must resolve
  // and the click must reach ExitApi.exit() with sound stopped first.
  const m = /<script id="rp-google-shim"[^>]*>([\s\S]*?)<\/script>/.exec(fixed);
  ok(m, 'shim block present');
  const log = [];
  const paused = [];
  const sandbox = {
    innerWidth: 390, innerHeight: 844,
    setTimeout: (fn) => { fn(); return 1; },
    document: { querySelectorAll: () => [{ pause: () => paused.push(1) }] },
    ExitApi: { exit: () => log.push('exit') },
    HTMLMediaElement: function () {},
    AudioContext: function () {},
    console,
  };
  sandbox.HTMLMediaElement.prototype.play = function () { log.push('play'); return Promise.resolve(); };
  sandbox.AudioContext.prototype.resume = function () { log.push('resume'); return Promise.resolve(); };
  const handlers = {};
  sandbox.addEventListener = (ev, fn) => { handlers[ev] = fn; };
  sandbox.removeEventListener = () => {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  let threw = null;
  try { vm.runInContext(m[1], sandbox); } catch (e) { threw = e; }
  ok(!threw, 'shim executes without throwing' + (threw ? ': ' + threw.message : ''));
  if (!threw) {
    eq(sandbox.mraid.getState(), 'default', 'mraid.getState() is not "loading"');
    let ready = false; sandbox.mraid.addEventListener('ready', () => { ready = true; });
    ok(ready, 'mraid ready fires');
    ok(sandbox.mraid.isViewable(), 'mraid.isViewable()');
    sandbox.rpLocalStorage.setItem('a', 1); eq(sandbox.rpLocalStorage.getItem('a'), '1', 'memory storage works');
    eq(sandbox.rpLocalStorage.getItem('zz'), null, 'missing key is null');
    eq(typeof sandbox.alert, 'function', 'alert overridden on the window');
    eq(sandbox.alert('x'), undefined, 'alert() is a no-op');
    eq(sandbox.confirm(), true, 'confirm() → true');
    eq(sandbox.prompt(), null, 'prompt() → null');
    sandbox.__rpExitTo = 'https://store.example';
    ok(log.includes('exit'), 'assigning __rpExitTo fires the exit');
    log.length = 0;
    // audio gate: play before touch is held, then released on touch
    const el = new sandbox.HTMLMediaElement();
    el.play();
    eq(log.includes('play'), false, 'play() held before interaction');
    handlers.pointerdown();
    eq(log.includes('play'), true, 'held play() released on first touch');
    // exit: stops sound then exits
    sandbox.mraid.open('https://x');
    ok(log.includes('exit'), 'mraid.open → ExitApi.exit');
    ok(paused.length > 0, 'media paused on exit');
    log.length = 0;
    sandbox.ExitApi.exit();
    ok(log.includes('exit'), 'wrapped ExitApi.exit still exits');
  }
}

/* The bug that shipped: rewriters matched text, not code, and produced
   JavaScript that no longer parsed. A syntax error takes the whole script
   block with it, so the ad rendered blank while the audit reported 98%. */
console.log('syntax safety (regression)');
{
  const wrap = (js) => `<html><head><script src="mraid.js"></script></head><body><script>${js}</script></body></html>`;
  const CASES = {
    'minified var list with `location`':  'var x=1,location=null,y=2;console.log(x,y);',
    'property named location':            'var e={};e.location=5;console.log(e.location);',
    'for-loop counter named location':    'for(var location=0;location<3;location++){}',
    'creative defines its own confirm()': "function confirm(m){return true}confirm('x');",
    'shorthand method named prompt':      "var ui={prompt(t){return t}};ui.prompt('a');",
    'window nested in a member chain':    "var e={window:window};e.window.open('https://x');",
    'navigation through an unknown ref':  "if(a){b.location.href='https://x';c()}",
    'real exit via document.location':    "document.location='https://store.example';",
    'real exit via location.href':        "location.href='https://store.example';",
    'real exit via top.location.replace': "top.location.replace(getUrl('a',(1+2)));",
  };
  for (const [name, js] of Object.entries(CASES)) {
    const out = fixAll(wrap(js), { orientation: 'portrait' });
    for (const code of inlineScripts(stripShim(out.html))) eq(parseError(code), null, `parses: ${name}`);
    eq(out.reverted.length, 0, `no fixer had to be reverted: ${name}`);
  }
  // The three unambiguous navigations are still converted…
  for (const js of ["document.location='https://s';", "location.href='https://s';", 'top.location.replace(u);']) {
    const out = fixAll(wrap(js), {}).html;
    ok(/window\.__rpExitTo =|ExitApi\.exit\(\)/.test(stripShim(out).split('<body>')[1]), `still converted: ${js}`);
  }
  // …and the ambiguous ones are left exactly as they were.
  for (const js of ['var x=1,location=null;', 'e.location=5;', "function confirm(m){return 1}"]) {
    const body = stripShim(fixAll(wrap(js), {}).html).split('<body>')[1];
    ok(body.includes(js), `left alone: ${js}`);
  }

  // A CTA that navigates is a real exit once rewritten. Counting only the
  // literal ExitApi.exit() call made these read "Will be rejected" at 73%
  // even though the converter had wired them correctly.
  for (const [label, js] of Object.entries({
    'location.href = store': "document.getElementById('c').onclick=function(){location.href='https://play.google.com/store/apps/details?id=x'};",
    'document.location = store': "document.getElementById('c').onclick=function(){document.location='https://play.google.com/store/apps/details?id=x'};",
    'top.location = store': "document.getElementById('c').onclick=function(){top.location='https://play.google.com/store/apps/details?id=x'};",
  })) {
    const src = `<html><head><script src="mraid.js"></script></head><body><div id="c">GO</div><script>${js}</script></body></html>`;
    const out = fixAll(src, { orientation: 'portrait' });
    ok(/__rpExitTo\s*=/.test(out.html), `${label}: rewritten to the nav setter`);
    ok(shimParts(out.html).includes('nav'), `${label}: nav shim shipped`);
    const F = audit(out.html, { zipBytes: 4000, entries: [{ name: 'index.html', size: out.html.length }] }).findings;
    ok(!has(F, 'no-google-exit'), `${label}: not reported as having no exit`);
    eq(score(F).counts.blocker, 0, `${label}: no blockers after conversion`);
  }
  // But the setter alone, with no shim to give it meaning, is not an exit.
  const bare = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>window.__rpExitTo="https://x";</script></body></html>';
  ok(has(audit(bare, {}).findings, 'no-google-exit'), 'the nav setter without its shim is not counted as an exit');

  const html = wrap('var a=1;function go(){return a}');
  eq(applyFixes(html, ['exit-rewrite'], {}).verified, canParse(), 'verification reflects what the host allows');
  eq(applyFixes(html, ['boom'], {}).applied.length, 0, 'unknown fixer ids are ignored');
  eq(applyFixes(html, ['charset'], { verify: false }).verified, false, 'verification can be turned off');

  // And the audit refuses a file whose script does not parse, whatever else is right.
  const bad = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="w"><meta name="ad.orientation" content="portrait">'
    + `<script src="${EXITAPI_SRC}"></script></head><body><script>function f({){}</script><div onclick="ExitApi.exit()">GO</div></body></html>`;
  const bf = audit(bad, { zipBytes: 4000, entries: [{ name: 'index.html', size: bad.length }] }).findings;
  ok(has(bf, 'script-syntax'), 'audit reports a script that does not parse');
  eq(bf.find((x) => x.id === 'script-syntax').severity, 'blocker', 'and treats it as a blocker');
  ok(score(bf).pct < 80 && score(bf).verdict.tone === 'bad', 'so the file cannot read as ready');
  ok(!has(audit(fixed, {}).findings, 'script-syntax'), 'a good file is not flagged');
}

console.log('helpers');
{
  eq(sanitizeName('15331754437207801677 (1).zip'), '15331754437207801677_1.zip', 'sanitizeName');
  eq(sanitizeName('thư mục/ảnh (2).png'), 'thu_muc/anh_2.png', 'sanitizeName strips accents per segment');
  const r = reroot([{ name: 'game/index.html' }, { name: 'game/a/b.png' }]);
  eq(r.map((e) => e.name).join(','), 'index.html,a/b.png', 'reroot strips the single top folder');
  const r2 = reroot([{ name: 'index.html' }, { name: 'a/b.png' }]);
  eq(r2.map((e) => e.name).join(','), 'index.html,a/b.png', 'reroot leaves a rooted package alone');
  eq(pickEntry([{ name: 'x/other.html' }, { name: 'index.html' }]).name, 'index.html', 'pickEntry prefers index.html');
  ok(CTA_RE.test('START FOR FREE'), 'CTA matches "START FOR FREE"');
  ok(CTA_RE.test('Start for free'), 'CTA matches "Start for free"');
  ok(CTA_RE.test('start free'), 'CTA matches "start free"');
  ok(CTA_RE.test('Get started'), 'CTA matches "Get started"');
  ok(CTA_RE.test('Try for free'), 'CTA matches "Try for free"');
  ok(CTA_RE.test('Play for free'), 'CTA matches "Play for free"');
  ok(CTA_RE.test('Join now'), 'CTA matches "Join now"');
  const ctaDoc = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="w"><meta name="ad.orientation" content="portrait">'
    + `<script src="${EXITAPI_SRC}"></script></head><body><button onclick="ExitApi.exit()">START FOR FREE</button></body></html>`;
  ok(!has(audit(ctaDoc, {}).findings, 'no-cta-copy'), 'START FOR FREE clears no-cta-copy check');
}

console.log('ai review (offline, every provider)');
{
  const texts = extractText(APPLOVIN);
  const prompt = buildPrompt({ texts, appName: 'Mahjong Cash', network: 'MRAID', imageCount: 3 });
  ok(prompt.includes('"INSTALL NOW"') && prompt.includes('Mahjong Cash') && prompt.includes('"findings"'), 'prompt carries copy, app name and the JSON shape');
  const norm = normalizeFindings({ findings: [{ policy: 'Misrepresentation', severity: 'BLOCKER', evidence: 'image 2', why: 'Fake close X', suggestion: 'Remove it' }, null, 'junk'] });
  eq(norm.length, 1, 'normalize drops junk');
  eq(norm[0].severity, 'blocker', 'normalize lowercases severity');
  eq(parseJsonLoose('Sure! ```json\n{"findings":[]}\n```').findings.length, 0, 'loose JSON parse handles fences and prose');

  const calls = [];
  const fake = (reply) => async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => reply, text: async () => '' }; };
  const one = { policy: 'Editorial', severity: 'advice', evidence: 'string 1', why: '!!!', suggestion: 'drop it' };

  let r = await review({ provider: 'gemini', key: 'K', model: 'gemini-3.5-flash', texts, sheetB64: 'AAAA', imageCount: 1,
    fetchImpl: fake({ candidates: [{ content: { parts: [{ text: JSON.stringify({ findings: [one] }) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }) });
  eq(r.findings.length, 1, 'gemini: parsed');
  eq(r.usage.in, 10, 'gemini: usage');
  ok(calls.at(-1).url.includes('key=K') && calls.at(-1).url.includes('gemini-3.5-flash'), 'gemini: key and model in the URL');
  eq(JSON.parse(calls.at(-1).init.body).contents[0].parts[1].inline_data.data, 'AAAA', 'gemini: image inline');

  r = await review({ provider: 'anthropic', key: 'K', model: 'claude-opus-5', texts, sheetB64: 'AAAA', imageCount: 1,
    fetchImpl: fake({ content: [{ type: 'text', text: JSON.stringify({ findings: [one] }) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }) });
  eq(r.findings.length, 1, 'anthropic: parsed');
  const ah = calls.at(-1).init.headers;
  eq(ah['x-api-key'], 'K', 'anthropic: key header');
  eq(ah['anthropic-version'], '2023-06-01', 'anthropic: version header');
  eq(ah['anthropic-dangerous-direct-browser-access'], 'true', 'anthropic: browser header');
  const ab = JSON.parse(calls.at(-1).init.body);
  eq(ab.fallbacks, 'default', 'anthropic: Opus 5 gets refusal fallbacks');
  eq(ah['anthropic-beta'], 'server-side-fallback-2026-07-01', 'anthropic: fallback beta header');
  eq(ab.messages[0].content[0].type, 'image', 'anthropic: image block first');
  let threw = null;
  try { await review({ provider: 'anthropic', key: 'K', model: 'claude-sonnet-5', texts, fetchImpl: fake({ content: [], stop_reason: 'refusal', stop_details: { category: 'x' } }) }); } catch (e) { threw = e; }
  ok(threw && /declined/.test(threw.message), 'anthropic: refusal surfaces as a message');
  eq(JSON.parse(calls.at(-1).init.body).fallbacks, undefined, 'anthropic: Sonnet has no fallbacks param');

  r = await review({ provider: 'openai', key: 'K', model: 'gpt-4o', texts, sheetB64: 'AAAA', imageCount: 1,
    fetchImpl: fake({ choices: [{ message: { content: JSON.stringify({ findings: [one] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) });
  eq(r.findings.length, 1, 'openai: parsed');
  eq(calls.at(-1).url, 'https://api.openai.com/v1/chat/completions', 'openai: url');
  eq(calls.at(-1).init.headers.Authorization, 'Bearer K', 'openai: bearer key');
  const ob = JSON.parse(calls.at(-1).init.body);
  eq(ob.response_format.type, 'json_object', 'openai: json mode');
  ok(ob.messages[0].content[1].image_url.url.startsWith('data:image/jpeg;base64,AAAA'), 'openai: image as data url');

  r = await review({ provider: 'compatible', key: 'K', model: 'meta/llama', endpoint: 'https://openrouter.ai/api/v1/', texts,
    fetchImpl: fake({ choices: [{ message: { content: 'Here you go: {"findings": []}' } }] }) });
  eq(r.findings.length, 0, 'compatible: prose-wrapped JSON parsed');
  eq(calls.at(-1).url, 'https://openrouter.ai/api/v1/chat/completions', 'compatible: endpoint joined');
  eq(JSON.parse(calls.at(-1).init.body).response_format, undefined, 'compatible: no strict json mode');

  threw = null;
  try { await review({ provider: 'compatible', key: 'K', model: 'x', texts, fetchImpl: fake({}) }); } catch (e) { threw = e; }
  ok(threw && /endpoint/.test(threw.message), 'compatible: endpoint required');

  // China-hosted services: OpenAI dialect, so only a base URL differs.
  const okReply = { choices: [{ message: { content: '{"findings":[]}' } }], usage: {} };
  r = await review({ provider: 'moonshot', key: 'K', model: 'kimi-latest', texts, sheetB64: 'AAAA', imageCount: 1, fetchImpl: fake(okReply) });
  eq(calls.at(-1).url, 'https://api.moonshot.cn/v1/chat/completions', 'kimi: preset endpoint used with no endpoint passed');
  eq(calls.at(-1).init.headers.Authorization, 'Bearer K', 'kimi: bearer key');
  eq(r.sawImages, true, 'kimi-latest is sent the contact sheet');
  eq(JSON.parse(calls.at(-1).init.body).messages[0].content.length, 2, 'kimi: text + image parts');

  await review({ provider: 'moonshot', key: 'K', model: 'kimi-latest', endpoint: 'https://api.moonshot.ai/v1', texts, fetchImpl: fake(okReply) });
  eq(calls.at(-1).url, 'https://api.moonshot.ai/v1/chat/completions', 'kimi: a typed endpoint overrides the preset');

  await review({ provider: 'qwen', key: 'K', model: 'qwen-vl-max', texts, sheetB64: 'AAAA', imageCount: 2, fetchImpl: fake(okReply) });
  eq(calls.at(-1).url, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', 'qwen: preset endpoint');
  await review({ provider: 'zhipu', key: 'K', model: 'glm-4v-plus', texts, sheetB64: 'AAAA', imageCount: 2, fetchImpl: fake(okReply) });
  eq(calls.at(-1).url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions', 'glm: preset endpoint');

  r = await review({ provider: 'moonshot', key: 'K', model: 'kimi-latest', texts, sheetB64: 'AAAA', imageCount: 1, sendImages: false, fetchImpl: fake(okReply) });
  eq(r.sawImages, false, 'the operator can turn images off');
  eq(JSON.parse(calls.at(-1).init.body).messages[0].content.length, 1, 'images off: text part only');
  ok(!JSON.parse(calls.at(-1).init.body).messages[0].content[0].text.includes('contact sheet with'), 'images off: prompt does not promise images');

  // Only image-reading services are offered.
  eq(PROVIDERS.deepseek, undefined, 'text-only DeepSeek is no longer offered');
  for (const [id, p] of Object.entries(PROVIDERS)) {
    if (!p.defaultModel) continue;
    ok(supportsVision(id, p.defaultModel), `${id}: default model reads images`);
    for (const m of p.models) ok(supportsVision(id, m.id), `${id}: ${m.id} reads images`);
  }
  // …but a typed custom id is still checked.
  eq(supportsVision('compatible', 'deepseek-chat'), false, 'supportsVision: a typed text-only id is caught');
  eq(supportsVision('compatible', 'qwen-plus'), false, 'supportsVision: qwen-plus is text only');
  eq(supportsVision('compatible', 'glm-4-plus'), false, 'supportsVision: glm-4-plus is text only');
  eq(supportsVision('moonshot', 'kimi-latest'), true, 'supportsVision: vision model');
  eq(supportsVision('compatible', 'llava-next'), true, 'supportsVision: unknown model assumed capable');

  // A pasted key names its own service, where the format allows it.
  // Shaped like the real thing, worded so no scanner mistakes them for one.
  eq(detectProvider('sk-ant-EXAMPLE-NOT-A-REAL-KEY'), 'anthropic', 'detect: Anthropic key');
  eq(detectProvider('AIzaEXAMPLE_NOT_A_REAL_KEY_0000'), 'gemini', 'detect: Gemini key');
  eq(detectProvider('EXAMPLENOTAREALKEY00.NOTREALEITHER'), 'zhipu', 'detect: Zhipu id.secret key');
  eq(detectProvider('sk-EXAMPLE-NOT-A-REAL-KEY'), null, 'detect: a bare sk- key is ambiguous');
  eq(detectProvider(''), null, 'detect: empty key');
  eq(detectProvider(null), null, 'detect: null key');
  threw = null;
  try { await review({ provider: 'openai', key: 'K', model: 'gpt-4o', texts, fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'bad key' }) }); } catch (e) { threw = e; }
  ok(threw && /401/.test(threw.message), 'http errors surface with the status');
  threw = null;
  try { await review({ provider: 'nope', key: 'K', model: 'x', texts }); } catch (e) { threw = e; }
  ok(threw && /Unknown provider/.test(threw.message), 'unknown provider rejected');
}

console.log('unsupported SDKs alongside a Google path');
{
  // A universal bundle whose exit table tries Google first: the Mintegral
  // branch is unreachable, so warning that the click may be lost is wrong.
  const base = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="w">
<meta name="ad.orientation" content="portrait"><script src="${EXITAPI_SRC}"></script></head><body><div id="c">GO</div>
<script>function g(){return !window.install?false:(window.install(),true)}
function goog(){return !(window.ExitApi&&window.ExitApi.exit)?false:(window.ExitApi.exit(),true)}
gameReady();for(const f of [goog,g]){if(f())break}</script></body></html>`;
  const F = audit(base, { zipBytes: 4000, entries: [{ name: 'index.html', size: base.length }] }).findings;
  ok(has(F, 'sdk-also-mintegral'), 'unsupported SDK reported alongside a Google path');
  eq(F.find((x) => x.id === 'sdk-also-mintegral').severity, 'advice', 'as advice, not a warning');
  ok(!has(F, 'sdk-unsupported-mintegral'), 'not as the alarming version');

  // With no Google exit of its own, the alarming version is right.
  const noGoogle = base.replace(/function goog[\s\S]*?\n/, '').replace('goog,', '');
  const N = audit(noGoogle, { zipBytes: 4000, entries: [{ name: 'index.html', size: noGoogle.length }] }).findings;
  ok(has(N, 'sdk-unsupported-mintegral'), 'no Google path: the warning stands');
  eq(N.find((x) => x.id === 'sdk-unsupported-mintegral').severity, 'warn', 'and stays a warning');
}

console.log('canvas creatives (copy drawn as art)');
{
  // A PixiJS/Cocos playable draws its words into WebPs. The document then holds
  // engine error strings and nothing a reviewer would read, so every copy rule
  // passes while checking nothing. That silence has to be reported.
  const img = (n) => Array.from({ length: n }, (_, i) =>
    `<img src="data:image/webp;base64,${'Q'.repeat(9000)}${i}">`).join('');
  const canvas = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="w"><meta name="ad.orientation" content="portrait">
<script src="${EXITAPI_SRC}"></script></head><body><canvas id="game"></canvas>${img(8)}
<script>var a="use strict";var b="[Assets] parser should have an id";
document.getElementById('game').onclick=function(){ExitApi.exit()};</script></body></html>`;
  const F = audit(canvas, { zipBytes: 400000, entries: [{ name: 'index.html', size: canvas.length }] }).findings;
  ok(has(F, 'copy-in-images'), 'a canvas creative is told its copy cannot be read');
  eq(F.find((x) => x.id === 'copy-in-images').severity, 'warn', 'and it is a warning, not silence');
  ok(!has(F, 'no-cta-copy'), 'the misleading "no CTA copy" advice is suppressed there');
  ok(/AI review/.test(F.find((x) => x.id === 'copy-in-images').detail), 'and it points at the pass that can read art');

  // A creative whose copy IS readable must not be flagged this way.
  const domCopy = canvas.replace('<canvas id="game"></canvas>', '<h1>Win real cash today</h1><div>INSTALL NOW</div>');
  const D = audit(domCopy, { zipBytes: 400000, entries: [{ name: 'index.html', size: domCopy.length }] }).findings;
  ok(!has(D, 'copy-in-images'), 'readable copy is not mistaken for art');
  ok(has(D, 'copy-cash-promise'), 'and the copy rules do their job on it');
  ok(!has(D, 'no-cta-copy'), '"INSTALL NOW" counts as a CTA');
}

console.log('unreachable service');
{
  // "Failed to fetch" is what a browser says for every blocked request, and it
  // withholds the reason from JS. The message has to enumerate the causes.
  let threw = null;
  const dead = async () => { throw new TypeError('Failed to fetch'); };
  try {
    await review({ provider: 'gemini', key: 'K', model: 'gemini-3.5-flash', texts: [], fetchImpl: dead });
  } catch (e) { threw = e; }
  ok(threw, 'a network failure still throws');
  ok(/generativelanguage\.googleapis\.com/.test(threw.message), 'names the host that could not be reached');
  ok(!/Failed to fetch$/.test(threw.message), 'does not stop at the browser wording');
  ok(/blocking/.test(threw.message), 'mentions a network rule as a cause');
  ok(/key is fine/.test(threw.message), 'says the key was never the problem');
  ok(/console/.test(threw.message), 'points at where the real reason is');

  // An HTTP error is a different thing and must keep saying so.
  threw = null;
  try {
    await review({ provider: 'gemini', key: 'BAD', model: 'gemini-3.5-flash', texts: [],
      fetchImpl: async () => ({ ok: false, status: 400, text: async () => 'API key not valid' }) });
  } catch (e) { threw = e; }
  ok(/400/.test(threw.message) && /API key not valid/.test(threw.message), 'a rejected key still reports the service\'s own words');
  ok(!/Could not reach/.test(threw.message), 'and is not confused with being unreachable');

  ok(/api\.moonshot\.cn/.test(networkFailureHelp('https://api.moonshot.cn/v1/chat/completions', new TypeError('x'))), 'host is taken from whichever service was called');
}

console.log('policy source (Google\'s own words)');
{
  const norm = (x) => String(x).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').toLowerCase();
  const hay = norm(POLICY_TEXT);
  ok(POLICY_TEXT.length > 15000, `captured page is present (${POLICY_TEXT.length} chars)`);
  eq(POLICY_SOURCE.url, 'https://support.google.com/adspolicy/answer/6008942?hl=en', 'provenance URL recorded');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(POLICY_SOURCE.captured), 'capture date recorded');
  for (const q of ["HTML5 ads that don", 'gimmicky use of words', 'weight loss or financial gain', 'Data collection and use'])
    ok(hay.includes(norm(q)), `source contains: ${q}`);

  // Every deterministic policy rule either quotes the page or admits it cannot.
  for (const r of POLICY_TEXT_RULES) {
    ok('source' in r, `${r.id}: declares whether it is sourced`);
    if (r.source) ok(hay.includes(norm(r.source)), `${r.id}: its quote really appears in the captured page`);
  }
  const sourced = POLICY_TEXT_RULES.filter((r) => r.source).length;
  ok(sourced >= 6, `most rules are sourced (${sourced}/${POLICY_TEXT_RULES.length})`);

  // The prompt hands over the source text and demands a verbatim quote.
  const prompt = buildPrompt({ texts: extractText(APPLOVIN), appName: 'X', imageCount: 2 });
  ok(prompt.includes(POLICY_TEXT), 'prompt carries the captured page verbatim');
  ok(/Judge ONLY against the policy text above/.test(prompt), 'prompt forbids outside rules');
  ok(/"sourced"/.test(prompt) && /"quote"/.test(prompt), 'prompt asks for sourced + quote');

  // A model quoting Google truthfully keeps its claim…
  const real = 'HTML5 ads that don’t function properly or appear blank';
  let n = normalizeFindings({ findings: [{ policy: 'Technical requirements', severity: 'blocker', sourced: true, quote: real, why: 'blank', suggestion: 'fix' }] });
  eq(n[0].sourced, true, 'a genuine quote is accepted');
  ok(n[0].quote.length > 20, 'and is kept');
  // …and one that invents or paraphrases loses it.
  n = normalizeFindings({ findings: [{ policy: 'Editorial', severity: 'warn', sourced: true, quote: 'Google forbids fake progress bars in playable ads.', why: 'x', suggestion: 'y' }] });
  eq(n[0].sourced, false, 'an invented quote is rejected');
  eq(n[0].quote, '', 'and is not shown as Google\'s words');
  n = normalizeFindings({ findings: [{ policy: 'Misrepresentation', severity: 'warn', sourced: false, quote: '', why: 'x', suggestion: 'y' }] });
  eq(n[0].sourced, false, 'an honestly unsourced finding stays unsourced');
}

console.log('Enabler: loaded vs called');
{
  // The script's own filename contains "Enabler.", so a test for "Enabler."
  // matched every file that merely referenced the script and the tag was never
  // removed. A call is `Enabler.<name>`, which `Enabler.js` is not.
  const loads = '<html><head><script src="https://s0.2mdn.net/ads/studio/Enabler.js"></scr' + 'ipt></head><body>x</body></html>';
  const calls = loads.replace('</head>', '<script>Enabler.exit("x")</scr' + 'ipt></head>');
  const find = (html) => audit(html).findings.find((x) => x.id === 'prohibited-enabler');
  eq(find(loads).fix, 'remove-enabler-script', 'a file that only loads Enabler.js can be fixed');
  eq(find(calls).fix, null, 'a file that calls the Enabler API cannot');
  ok(!fixAll(loads, { orientation: 'portrait' }).html.includes('Enabler.js'), 'and the tag is actually removed');
  ok(fixAll(calls, { orientation: 'portrait' }).html.includes('Enabler.js'), 'while a creative that needs it keeps it');
}

console.log('every check declares where it comes from');
{
  // Scan the audit for every finding it can raise. Static ids are read
  // straight from the `f('…')` call sites; the three families named after
  // what they found are expanded from the tables that drive them. Reading the
  // source is what makes this catch a rule added without a source, which
  // exercising the pipeline would not.
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'audit.mjs'), 'utf8');
  const emitted = new Set([...src.matchAll(/\bf\('([a-z0-9-]+)'/g)].map((m) => m[1]));
  ok(emitted.size > 30, `found the audit's finding ids (${emitted.size})`);
  for (const p of PROHIBITED) emitted.add(`prohibited-${p.id}`);
  for (const r of POLICY_TEXT_RULES) emitted.add(`copy-${r.id}`);
  for (const n of NETWORKS) {
    if (n.id === 'google' || n.shim) continue;
    emitted.add(`sdk-unsupported-${n.id}`);
    emitted.add(`sdk-also-${n.id}`);
  }

  const orphans = [...emitted].filter((id) => !sourceFor(id));
  eq(orphans.join(' '), '', 'every finding the audit can raise has a declared source');
  for (const id of emitted) {
    const s = sourceFor(id);
    if (!s) continue;
    // `ref` is one source key or several, when a check rests on more than one.
    for (const ref of [s.ref].flat()) ok(SOURCE_REFS[ref], `${id}: names a real source (${ref})`);
    ok(s.states && s.states.length > 20, `${id}: says what that source states`);
    ok(['captured', 'documented', 'vendor', 'measured', 'unsourced'].includes(s.basis), `${id}: declares a known basis (${s.basis})`);
  }

  // Nothing declared that the audit cannot actually raise: a stale entry is a
  // claim about a check that no longer exists.
  const declared = Object.keys(CHECK_SOURCES).filter((id) => !/^sdk-(unsupported|also-network)$/.test(id));
  const stale = declared.filter((id) => !emitted.has(id));
  eq(stale.join(' '), '', 'no source is declared for a check that was removed');

  // Every reference is usable by a reader: a label and a link.
  for (const [key, ref] of Object.entries(SOURCE_REFS)) {
    ok(ref.label && ref.label.length > 5, `${key}: has a readable label`);
    ok(ref.short && ref.short.length < 16, `${key}: has a short name for the table`);
    ok(/^https:\/\//.test(ref.url), `${key}: has a URL`);
    ok(SOURCE_FAMILIES.some((f) => f.id === ref.family), `${key}: belongs to a known family (${ref.family})`);
  }
  // A source nobody rests on is a claim about a check that does not exist.
  const cited = new Set([...emitted].flatMap((id) => [sourceFor(id)?.ref ?? []].flat()));
  eq(Object.keys(SOURCE_REFS).filter((k) => !cited.has(k)).join(' '), '', 'every source listed is one some check rests on');

  // The generated document is committed, so it must match what the engine says now.
  const doc = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'validation-sources.md');
  ok(fs.existsSync(doc), 'docs/validation-sources.md is committed');
  if (fs.existsSync(doc)) {
    const text = fs.readFileSync(doc, 'utf8');
    for (const id of emitted) ok(text.includes(`\`${id}\``), `${id}: appears in docs/validation-sources.md`);
    ok(text.includes(`**${emitted.size} checks**`), `the document counts ${emitted.size} checks — regenerate with node engine/build-sources.mjs`);
  }
  ok(fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', SOURCE_REFS.policies.captured)),
    'the captured policy page is where SOURCE_REFS says it is');
}

console.log('vendor sample zip');
{
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Optional: drop any real playable .zip into fixtures/ and it is put through
  // the whole pipeline. None ships with the repo, because a vendor's creative
  // is not ours to redistribute.
  const dir = path.join(here, '..', 'fixtures');
  const zips = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.zip')) : [];
  if (!zips.length) console.log('  (no .zip in fixtures/ — put one there to exercise the full pipeline)');
  for (const name of zips) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(dir, name)));
    const entries = await readZip(bytes);
    const entry = pickEntry(entries);
    ok(entry, `${name}: has an entry html`);
    const html = new TextDecoder().decode(entry.bytes);
    const b = audit(html, { zipBytes: bytes.length, entries });
    const r = fixAll(html, { orientation: 'portrait' });
    const outZip = await writeZip([{ name: entry.name, bytes: new TextEncoder().encode(r.html) }]);
    ok(outZip.length <= GOOGLE_ADS_LIMITS.maxZipBytes, `${name}: output under cap (${(outZip.length / 1048576).toFixed(2)} MB)`);
    ok(r.html.includes('window.super_html'), `${name}: wrapper intact`);
    const a = audit(r.html, { zipBytes: outZip.length, entries: [{ name: entry.name, size: r.html.length }] });
    ok(score(a.findings).pct >= score(b.findings).pct, `${name}: score does not drop (${score(b.findings).pct} → ${score(a.findings).pct})`);
    eq(a.findings.filter((x) => x.severity === 'blocker').length, 0, `${name}: no blockers after fix (${ids(a.findings.filter((x) => x.severity === 'blocker'))})`);
    console.log(`  ${name}: ${score(b.findings).pct}% → ${score(a.findings).pct}% · applied ${r.applied.join(', ') || 'nothing'} · left: ${ids(a.findings) || 'none'}`);
    const back = await readZip(outZip);
    eq(back.length, 1, `${name}: output zip reads back`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
