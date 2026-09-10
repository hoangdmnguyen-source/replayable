/**
 * Generate docs/validation-sources.md from the engine itself.
 *
 *   node engine/build-sources.mjs
 *
 * The question a client asks first is "says who?". This answers it from the
 * code rather than from memory: every check the audit can raise, what it rests
 * on, and whether the tool fixes it or hands it back. Nothing here is typed by
 * hand, so the document cannot drift from the tool — and engine/test.mjs fails
 * if a check is added without declaring its source.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SOURCE_REFS, SOURCE_FAMILIES, PROHIBITED, NETWORKS, POLICY_TEXT_RULES, sourceFor } from './rules.mjs';
import { POLICY_SOURCE, POLICY_TEXT } from './policy-rubric.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');
const audit = fs.readFileSync(path.join(dir, 'audit.mjs'), 'utf8');

/**
 * Read each `f(…)` call site in the audit whole, so a check's title, severity
 * and fixer come from the one place they are actually written down.
 */
function callSites(src) {
  const out = new Map();
  // Two shapes: f('zip-size', …) and f(`sdk-unsupported-${n.id}`, …). The
  // second is keyed by its stem, and expanded from the tables further down.
  const re = /\bf\(\s*(?:'([a-z0-9-]+)'|`([a-z0-9-]+)-\$\{)/g;
  for (let m; (m = re.exec(src)); ) {
    let depth = 1, i = re.lastIndex;
    while (i < src.length && depth) { const c = src[i++]; if (c === '(') depth++; else if (c === ')') depth--; }
    const body = src.slice(m.index, i);
    // Severity is the second argument and area the third, both plain string
    // literals, so the first recognised severity in the call site is it.
    const quoted = [...body.matchAll(/'([^'\\]*)'/g)].map((q) => q[1]);
    const at = quoted.findIndex((q) => q === 'blocker' || q === 'warn' || q === 'advice');
    // Stems are kept apart from literal ids: `f('sdk-also', …)` and
    // ``f(`sdk-also-${n.id}`, …)`` are two different checks, and the second
    // must not overwrite the first.
    out.set(m[1] ? m[1] : `${m[2]}-*`, {
      severity: at < 0 ? '' : quoted[at],
      area: at < 0 ? '' : quoted[at + 1] ?? '',
      fix: (body.match(/\bfix:\s*'([\w-]+)'/) || [, null])[1],
      // Some checks fix themselves only in one branch — an oversized ZIP is
      // repacked when it was stored uncompressed, and reported otherwise.
      manual: /\bmanual:\s*'/.test(body),
    });
  }
  return out;
}

const sites = callSites(audit);
if (sites.size < 30) throw new Error(`only ${sites.size} finding sites found in audit.mjs — the scan is broken`);

/**
 * Every id the audit can raise. The literal call sites give their own
 * severity and fixer; the three expanded families take theirs from the table
 * that drives them, which is where the audit reads it too.
 */
const emitted = [...sites].filter(([id]) => !id.endsWith('-*')).map(([id, v]) => ({ id, ...v }));
// The prohibited constructs share one call site, so their fixer comes from the
// table that names it — the same place the audit reads it from.
for (const p of PROHIBITED) emitted.push({ id: `prohibited-${p.id}`, severity: 'blocker', fix: p.fix ?? null, manual: p.id === 'enabler' });
for (const r of POLICY_TEXT_RULES) emitted.push({ id: `copy-${r.id}`, severity: r.severity, fix: null, manual: true });
for (const n of NETWORKS) {
  if (n.id === 'google' || n.shim) continue;
  emitted.push({ id: `sdk-unsupported-${n.id}`, severity: 'warn', fix: null, manual: true });
  emitted.push({ id: `sdk-also-${n.id}`, severity: 'advice', fix: null, manual: true });
}

const checks = emitted.map((c) => {
  const s = sourceFor(c.id);
  if (!s) throw new Error(`${c.id} has no declared source — run node engine/test.mjs`);
  if (!c.severity) throw new Error(`${c.id}: could not read its severity from audit.mjs`);
  return { ...c, ...s };
}).sort((a, b) => a.id.localeCompare(b.id));

const BASIS = {
  captured: 'The source text is in this repository. The finding quotes it, and the quote is checked against the file.',
  documented: 'Stated on the public page cited. The page is linked; its text is not copied here.',
  vendor: "The other ad network's own playable specification, not Google's.",
  measured: 'Established by running real playables, not taken from a document.',
  unsourced: "Not stated on the captured page. Shown as unsourced rather than presented as Google's words.",
};
const SEV = { blocker: 'Blocker', warn: 'Warning', advice: 'Advice' };

const refs = (c) => (Array.isArray(c.ref) ? c.ref : [c.ref]);
const esc = (s) => String(s).replace(/\|/g, '\\|');
const handling = (c) => (!c.fix ? 'Reported' : c.manual ? '**Fixed** where possible' : '**Fixed**');
const table = (list) => `| Check | Source | Severity | Handling | What the source states |
|---|---|---|---|---|
${list.map((c) => `| \`${c.id}\` | ${refs(c).map((r) => SOURCE_REFS[r].short).join(', ')} | ${SEV[c.severity] ?? c.severity} | ${handling(c)} | ${esc(c.states)} |`).join('\n')}`;

const policyRuleIds = new Set(POLICY_TEXT_RULES.map((r) => `copy-${r.id}`));
const copyRules = checks.filter((c) => policyRuleIds.has(c.id));
const structural = checks.filter((c) => !policyRuleIds.has(c.id));
const inFamily = (fam) => structural.filter((c) => refs(c).some((r) => SOURCE_REFS[r].family === fam));

const fixed = checks.filter((c) => c.fix).length;
const count = (b) => checks.filter((c) => c.basis === b).length;
const sourceList = (fam) => Object.entries(SOURCE_REFS)
  .filter(([key, r]) => r.family === fam && structural.some((c) => refs(c).includes(key)))
  .map(([key, r]) => `- **[${r.label}](${r.url})**${r.captured ? ` — captured in this repository as \`${r.captured}\`, so the wording can be checked without leaving it.` : ''}`)
  .join('\n');

const md = `# Where the validation rules come from

Generated by \`node engine/build-sources.mjs\` — do not edit by hand.

Re-Playable makes **${checks.length} checks** against a playable. It fixes ${fixed} of them automatically and hands
the rest back with an explanation of what a person has to decide.

Every check names the source it rests on. Nothing in this document is typed by hand: it is generated
from the same table the tool checks against, and \`node engine/test.mjs\` fails if a check is added
without declaring a source.

There are two kinds of checking, and they rest on different things.

| | What it is | What powers it |
|---|---|---|
| **1 · Rule-based** | Reads the file and decides from the code. Same file, same answer, every time. No network, no model. | ${SOURCE_FAMILIES.length} families of published specification, listed below |
| **2 · AI policy scan** | Optional, off until you paste your own API key. Looks at the artwork the way a reviewer would. | Google's advertising policies, captured verbatim in this repository |

The readiness score comes from part 1 only. The AI scan is advisory and never changes it.

---

## 1 · Rule-based — the tool detects and fixes from the code

${SOURCE_FAMILIES.map((fam) => {
  const list = inFamily(fam.id);
  if (!list.length) return '';
  return `### ${fam.label}

${fam.why}

${sourceList(fam.id)}

${list.length} check${list.length === 1 ? '' : 's'} rest on ${fam.id === 'web' ? 'this' : 'these'}.

${table(list)}`;
}).filter(Boolean).join('\n\n')}

### The copy patterns

The captured policy page also drives ${copyRules.length} pattern checks that read the ad's words and flag the phrasing
behind the most common disapprovals. These are still rule-based — plain patterns over the text, no
model — but their source is the policy page, which is why the same document appears in both halves
of this list.

Where the captured page states the rule, the finding quotes Google's sentence, shown below. Where it
does not, the finding says **unsourced** rather than putting words in Google's mouth: ${copyRules.filter((c) => c.basis === 'captured').length} of ${copyRules.length} are
quoted. The captured page is Google's overview; several sub-policies live on detail pages that were
not captured, which is what the remaining ${copyRules.filter((c) => c.basis !== 'captured').length} rest on.

${table(copyRules)}

---

## 2 · AI policy scan — the optional review

**Source:** [${POLICY_SOURCE.title}](${POLICY_SOURCE.url})
**Captured:** ${POLICY_SOURCE.captured} · **In this repository:** \`docs/google-ads-policies.md\` — ${(POLICY_TEXT.length / 1024).toFixed(0)} KB of Google's own text

The scan exists for one reason: **a playable usually draws its words instead of writing them.** A
canvas game renders every headline and button into an image, so the pattern checks above have
nothing to read. An AI that can see the artwork is the only pass that reaches them.

How it is kept honest:

1. The captured policy page goes into the prompt verbatim, generated by \`engine/build-rubric.mjs\`. Nothing is retyped or summarised.
2. The model is told to judge against that text alone, and to quote the sentence it relies on.
3. Every quote is checked against the captured text before it is shown. A paraphrased or invented one is marked **unsourced**, and Google's wording is not put on screen.
4. The result is advisory. It never moves the readiness score.

Works with Gemini, Claude, OpenAI, Kimi, Qwen, GLM, or any OpenAI-compatible endpoint. The key goes
from the browser to the service you chose, and is stored only in that browser.

---

## How each check is grounded

| Basis | Checks | What it means |
|---|---|---|
${Object.entries(BASIS).filter(([b]) => count(b)).map(([b, why]) => `| **${b}** | ${count(b)} | ${why} |`).join('\n')}

## What these sources do not settle

They say what Google requires. They do not say what Google will approve — that is decided by
Google's own validator and its policy reviewers, on the day, on the file you upload.

Re-Playable's job is to remove the failures that are knowable from the file itself, so that what
reaches a reviewer is the creative and not a packaging mistake. Before uploading for real, put the
converted \`.zip\` through Google's free
[HTML5 validator](https://h5validator.appspot.com/adwords/asset): it is instant, and it settles the
technical half with certainty.
`;

fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'validation-sources.md'), md);
console.log(`wrote docs/validation-sources.md — ${checks.length} checks, ${Object.keys(SOURCE_REFS).length} sources, ${fixed} auto-fixed`);
