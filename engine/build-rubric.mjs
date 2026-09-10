/**
 * Generate engine/policy-rubric.mjs from docs/google-ads-policies.md.
 *
 *   node engine/build-rubric.mjs
 *
 * The rubric the AI review is given must be Google's own words, not a
 * paraphrase written from memory. So the prompt text is derived mechanically
 * from the captured page and never edited by hand. To update it when Google
 * changes the page: save the page again, re-extract into docs/google-ads-policies.md,
 * and re-run this.
 *
 * The generated module is committed so the browser build needs no build step.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const md = fs.readFileSync(path.join(dir, '..', 'docs', 'google-ads-policies.md'), 'utf8');

const meta = {
  url: (/- Source: <([^>]+)>/.exec(md) || [, ''])[1],
  title: (/- Title: (.+)/.exec(md) || [, ''])[1].trim(),
  captured: (/- Captured: ([0-9-]+)/.exec(md) || [, ''])[1],
};
if (!meta.url || !meta.captured) throw new Error('docs/google-ads-policies.md is missing its provenance header');

// Everything after the provenance block is the captured page.
const body = md.slice(md.indexOf('\n---\n') + 5).trim();
if (body.length < 5000) throw new Error(`policy source looks truncated (${body.length} chars)`);

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

fs.writeFileSync(path.join(dir, 'policy-rubric.mjs'), `/**
 * GENERATED — do not edit. Run \`node engine/build-rubric.mjs\` to regenerate.
 *
 * Google's advertising policies, captured verbatim. The AI review is given
 * this text and told to judge against it alone, so that a finding can be
 * traced back to a sentence Google actually wrote.
 *
 * Source:   ${meta.url}
 * Title:    ${meta.title}
 * Captured: ${meta.captured}
 */

export const POLICY_SOURCE = {
  url: ${JSON.stringify(meta.url)},
  title: ${JSON.stringify(meta.title)},
  captured: ${JSON.stringify(meta.captured)},
};

/**
 * NOTE ON SCOPE: this is Google's overview page. Each policy links to its own
 * detail page, and those are not captured here. Sub-policies such as
 * "Misleading ad design" and "Clickbait" therefore have no source text in this
 * file, and nothing may be asserted about them from it.
 */
export const POLICY_TEXT = \`${esc(body)}\`;
`);
console.log(`wrote engine/policy-rubric.mjs — ${(body.length / 1024).toFixed(1)} KB of source text, captured ${meta.captured}`);
