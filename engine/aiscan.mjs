/**
 * Optional AI policy review — provider-neutral.
 *
 * Off by default and only reachable with an API key the operator pastes in.
 * The deterministic audit already scores the file; this pass covers what
 * pattern matching cannot see — the art (violence, sexual content, brands,
 * fake system UI drawn as pixels) and copy that reads as misleading in context.
 *
 * What is sent, for every provider: the ad's visible strings and ONE
 * downscaled JPEG contact sheet of its largest images, plus the policy rubric.
 * Never the file itself, never full-resolution art. The model never edits
 * anything; its findings are advisory, labelled AI, and do not move the
 * readiness percentage.
 *
 * The key goes straight from the browser to the provider the operator chose
 * and nowhere else. Raw HTTP on purpose: the tool is a single dependency-free
 * page, and each provider's request shape is a dozen lines.
 */

import { inventoryImages } from './inspect.mjs';
import { ART_CHECKS } from './rules.mjs';
import { POLICY_TEXT, POLICY_SOURCE } from './policy-rubric.mjs';

export { POLICY_SOURCE };

/* ------------------------------------------------------------------ *
 * Providers
 * ------------------------------------------------------------------ */

/**
 * Only services whose models READ IMAGES are offered. The whole point of this
 * pass is to judge the art — fake system dialogs drawn as pixels, borrowed
 * logos, imagery that misrepresents the game. A text-only model cannot do
 * that, and copy is already covered by the deterministic rules in rules.mjs,
 * so a text-only option would only look like coverage without being any.
 *
 * `api` names the request shape, not the company: everything except Gemini and
 * Anthropic speaks the OpenAI chat-completions dialect, which is why Kimi,
 * Qwen and GLM need no adapter of their own, only a base URL.
 */
export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini', api: 'gemini', keyHint: 'AIza…',
    models: [
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (fast, cheap)' },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (stricter)' },
    ],
    defaultModel: 'gemini-3.5-flash',
  },
  anthropic: {
    label: 'Anthropic Claude', api: 'anthropic', keyHint: 'sk-ant-…',
    models: [
      { id: 'claude-opus-5', label: 'Claude Opus 5 (strictest)' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fast, cheap)' },
    ],
    defaultModel: 'claude-opus-5',
  },
  openai: {
    label: 'OpenAI', api: 'openai', keyHint: 'sk-…',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o' },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini (fast, cheap)' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
    ],
    defaultModel: 'gpt-4o',
  },
  moonshot: {
    label: 'Kimi · Moonshot AI', api: 'openai', keyHint: 'sk-…',
    endpoint: 'https://api.moonshot.cn/v1',
    endpointNote: 'Mainland China endpoint. Outside China use https://api.moonshot.ai/v1',
    models: [
      { id: 'kimi-latest', label: 'kimi-latest' },
      { id: 'moonshot-v1-32k-vision-preview', label: 'moonshot-v1-32k-vision-preview' },
    ],
    defaultModel: 'kimi-latest',
  },
  qwen: {
    label: 'Qwen · Alibaba DashScope', api: 'openai', keyHint: 'sk-…',
    endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    endpointNote: 'International endpoint. Inside China use https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen-vl-max', label: 'qwen-vl-max' },
      { id: 'qwen-vl-plus', label: 'qwen-vl-plus (cheaper)' },
    ],
    defaultModel: 'qwen-vl-max',
  },
  zhipu: {
    label: 'GLM · Zhipu AI', api: 'openai', keyHint: 'your GLM key',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { id: 'glm-4v-plus', label: 'glm-4v-plus' },
      { id: 'glm-4v-flash', label: 'glm-4v-flash (cheaper)' },
    ],
    defaultModel: 'glm-4v-plus',
  },
  compatible: {
    label: 'Any other OpenAI-compatible endpoint', api: 'compatible', keyHint: 'key for that endpoint',
    endpointNote: 'OpenRouter, Azure, SiliconFlow, a company proxy, or a local server. Pick a model that reads images.',
    models: [],
    defaultModel: '',
    needsEndpoint: true,
  },
};

export const DEFAULT_PROVIDER = 'gemini';

/**
 * Model families known to reject images. No preset uses one, but the custom
 * model field accepts anything, so a typed id is checked against this and the
 * page warns before the call rather than after the API refuses it.
 */
const TEXT_ONLY = /^(?:deepseek|o1-mini|text-|gpt-3)|^qwen-(?:plus|turbo|max|long)|^glm-4-|^moonshot-v1-\d+k$/i;

/** Can this model read the contact sheet? Unknown ids are assumed capable. */
export function supportsVision(providerId, modelId) {
  return !TEXT_ONLY.test(String(modelId || '').trim());
}

/**
 * Which service a pasted key belongs to, when the key itself says so.
 *
 * Google and Anthropic use distinctive prefixes, and Zhipu issues an
 * `id.secret` pair, so those three need no choosing. A bare `sk-…` is used by
 * OpenAI, Moonshot and DashScope alike and cannot be told apart, so it returns
 * null and the operator's current choice stands.
 */
export function detectProvider(key) {
  const k = String(key || '').trim();
  if (/^sk-ant-/.test(k)) return 'anthropic';
  if (/^AIza[\w-]{20,}$/.test(k)) return 'gemini';
  if (/^[0-9a-zA-Z]{16,}\.[0-9a-zA-Z]{8,}$/.test(k)) return 'zhipu';
  return null;
}

/**
 * The rubric is Google's captured page, not a summary of it.
 *
 * It used to be prose I wrote from memory, which asserted sub-policies the
 * source page does not contain. Now the model is handed the source text and
 * told to judge against that alone and quote the sentence it relies on, so a
 * finding can be checked against Google rather than taken on trust.
 */
export { POLICY_TEXT };

/**
 * Guard on how much copy rides along in one prompt. Characters, not strings,
 * because one 160-character line costs what eighty short labels do. Set high
 * enough that no real creative is trimmed; it exists so a localisation table
 * cannot silently blow the context window.
 */
export const PROMPT_TEXT_BUDGET = 120_000;

/**
 * The one prompt every provider gets. Asks for a JSON object so strict JSON
 * modes are happy.
 *
 * A creative with more art than fits one legible contact sheet is reviewed in
 * several passes. `imageFrom` keeps the numbering continuous across them, so
 * "image 47" means the 47th image of the creative and not the 5th of batch 2 —
 * evidence stays meaningful once the findings are merged back together.
 */
export function buildPrompt({ texts, appName = '', network = '', imageCount = 0, imageFrom = 1, batch = null, textBudget = PROMPT_TEXT_BUDGET }) {
  const lines = [];
  let spent = 0, shown = 0;
  for (const t of texts) {
    const line = `${shown + 1}. ${JSON.stringify(t.text)}${t.where === 'script' ? '  [script string]' : ''}`;
    if (spent + line.length > textBudget) break;
    lines.push(line); spent += line.length; shown++;
  }
  const trimmed = texts.length - shown;
  const copy = lines.join('\n');
  const last = imageFrom + imageCount - 1;
  const art = imageCount
    ? `one contact sheet with ${imageCount} of the creative's images, numbered ${imageFrom} to ${last}`
    : 'no images (the creative has no raster art)';
  return `You are reviewing ONE HTML5 playable ad creative against Google's advertising policies, before it is uploaded to Google Ads.

${appName ? `The promoted app is: ${JSON.stringify(appName)}.` : 'The promoted app is not stated.'}
${network ? `The creative was originally built for: ${network}.` : ''}
${batch ? `This is pass ${batch.index} of ${batch.total}. The creative has ${batch.totalImages} images in all, too many to stay legible on one sheet, so they are split across passes. Judge only the images on THIS sheet; the other passes cover the rest. Number them exactly as labelled — the passes are merged afterwards.` : ''}

=== BEGIN GOOGLE ADS POLICIES (captured ${POLICY_SOURCE.captured} from ${POLICY_SOURCE.url}) ===
${POLICY_TEXT}
=== END GOOGLE ADS POLICIES ===

RULES FOR THIS REVIEW — follow them exactly:
1. Judge the copy ONLY against the policy text above. Do not apply copy rules you
   remember from elsewhere, and do not infer rules the text does not state.
2. That text is Google's OVERVIEW page. Each policy has its own detail page which
   is NOT included. So you do not have the detailed rules for any sub-policy. If a
   concern would depend on a detail page you have not been given, you may still
   raise it, but you MUST set "sourced" to false and leave "quote" empty.
3. For every finding that IS supported by the text above, set "sourced" to true and
   put the exact sentence or example you are relying on in "quote", copied verbatim.
4. Report only what you can point at in this creative. Do not invent. If nothing in
   the creative conflicts with the policy text, return an empty list.
5. Judge the copy on what a player SEES. Ignore anything that is plainly a filename,
   an asset path, a build id or developer shorthand rather than words written for a
   user. A string like "PLA 1" or "scene_02" is not ad copy and is not a finding.
${imageCount ? `6. The artwork is judged differently, and rule 1 does not restrain it. Most playables
   draw their words into images, so the copy rules cannot reach them. Examine the
   sheet for each of the following and report what you find, with "sourced" false
   since none of it is stated in the text above:
${ART_CHECKS.map((c, i) => `   ${String.fromCharCode(97 + i)}. ${c}`).join('\n')}
   Judge the screen these images compose, not only each tile alone: a panel, a bar
   and a row of labels may be innocuous separately and a fake settings screen
   together. Where a still cannot settle it, say so and raise it as "advice".` : ''}

You are given (1) every visible text string found in the creative and (2) ${art}.

Respond with JSON only, in this exact shape: {"findings": [ ... ]} where each finding has:
- "policy": the policy heading from the text above, copied as written, e.g. "Editorial" or "Data collection and use"
- "sourced": true if the policy text above states this rule, false if you are relying on knowledge not present in it
- "quote": the verbatim sentence from the policy text that supports this finding, or "" when sourced is false
- "severity": "blocker", "warn" or "advice"
- "evidence": the exact string or image number in THIS creative you are reacting to, e.g. "string 12" or "image ${imageCount ? imageFrom : 3}"
- "why": one sentence on what a reviewer would object to
- "suggestion": one sentence on the smallest change that fixes it

Visible text strings:
${copy || '(none found)'}${trimmed > 0 ? `\n… and ${trimmed} more, omitted to stay within the prompt budget.` : ''}`;
}

/* ------------------------------------------------------------------ *
 * Request/response adapters — one per API shape
 * ------------------------------------------------------------------ */

const ADAPTERS = {
  gemini: {
    request({ key, model, prompt, imageB64 }) {
      const parts = [{ text: prompt }];
      if (imageB64) parts.push({ inline_data: { mime_type: 'image/jpeg', data: imageB64 } });
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
        headers: { 'Content-Type': 'application/json' },
        body: { contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 4096 } },
      };
    },
    parse(json) {
      const cand = json.candidates && json.candidates[0];
      if (!cand || !cand.content) throw new Error('Empty response' + (cand ? ` (${cand.finishReason})` : ''));
      if (cand.finishReason === 'MAX_TOKENS') throw new Error('Response truncated — try again');
      const u = json.usageMetadata || {};
      return { text: (cand.content.parts || []).map((p) => p.text || '').join(''), usage: { in: u.promptTokenCount || 0, out: u.candidatesTokenCount || 0 } };
    },
  },

  anthropic: {
    request({ key, model, prompt, imageB64 }) {
      const content = [];
      if (imageB64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageB64 } });
      content.push({ type: 'text', text: prompt });
      const headers = {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        // Required for a browser to call the API directly with its own key.
        'anthropic-dangerous-direct-browser-access': 'true',
      };
      const body = { model, max_tokens: 8192, messages: [{ role: 'user', content }] };
      // Opus 5 / Fable can decline a request on safety grounds; let the API
      // re-run it on a fallback model inside the same call.
      if (/^claude-(opus-5|fable)/.test(model)) {
        headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
        body.fallbacks = 'default';
      }
      return { url: 'https://api.anthropic.com/v1/messages', headers, body };
    },
    parse(json) {
      if (json.stop_reason === 'refusal') {
        const cat = json.stop_details && json.stop_details.category;
        throw new Error('The model declined to review this creative' + (cat ? ` (${cat})` : ''));
      }
      if (json.stop_reason === 'max_tokens') throw new Error('Response truncated — try again');
      const u = json.usage || {};
      return { text: (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), usage: { in: u.input_tokens || 0, out: u.output_tokens || 0 } };
    },
  },

  openai: {
    request({ key, model, prompt, imageB64, endpoint, strictJson = true }) {
      const content = [{ type: 'text', text: prompt }];
      if (imageB64) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}`, detail: 'high' } });
      const base = (endpoint || 'https://api.openai.com/v1').replace(/\/+$/, '');
      const body = { model, messages: [{ role: 'user', content }], temperature: 0.1, max_tokens: 4096 };
      if (strictJson) body.response_format = { type: 'json_object' };
      return { url: `${base}/chat/completions`, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body };
    },
    parse(json) {
      const msg = json.choices && json.choices[0] && json.choices[0].message;
      if (!msg) throw new Error('Empty response');
      const text = typeof msg.content === 'string' ? msg.content : (msg.content || []).map((p) => p.text || '').join('');
      const u = json.usage || {};
      return { text, usage: { in: u.prompt_tokens || 0, out: u.completion_tokens || 0 } };
    },
  },
};
// Third-party OpenAI-compatible endpoints do not all honour response_format; the prompt asks for JSON anyway.
ADAPTERS.compatible = {
  request: (o) => ADAPTERS.openai.request({ ...o, strictJson: false }),
  parse: ADAPTERS.openai.parse,
};

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/** JSON from a model reply: fenced, bare, or buried in prose. */
export function parseJsonLoose(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.search(/[[{]/);
  const b = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (a > -1 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ } }
  throw new Error('Model did not return JSON');
}

const SEVERITIES = new Set(['blocker', 'warn', 'advice']);

/**
 * Coerce whatever the model returned into a clean list.
 *
 * `quote` only survives when it is genuinely present in the source text. A
 * model that paraphrases Google, or invents a sentence, gets its claim of being
 * sourced revoked rather than passed on as if Google had written it.
 */
export function normalizeFindings(raw, sourceText = POLICY_TEXT) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.findings) ? raw.findings : [];
  const norm = (s) => String(s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
  const haystack = norm(sourceText).toLowerCase();
  return list.filter((x) => x && typeof x === 'object').map((x) => {
    const quote = norm(x.quote).slice(0, 400);
    // A quote counts only if it really appears in what we sent.
    const verified = quote.length > 20 && haystack.includes(quote.toLowerCase());
    return {
      id: 'ai',
      source: 'ai',
      severity: SEVERITIES.has(String(x.severity).toLowerCase()) ? String(x.severity).toLowerCase() : 'warn',
      area: String(x.policy || 'Policy').slice(0, 120),
      title: String(x.why || x.policy || 'Policy concern').slice(0, 200),
      detail: String(x.suggestion || '').slice(0, 400),
      measured: String(x.evidence || '').slice(0, 200),
      quote: verified ? quote : '',
      sourced: verified,
      fix: null,
      manual: String(x.suggestion || 'Review by hand.').slice(0, 400),
    };
  });
}

/* ------------------------------------------------------------------ *
 * The call
 * ------------------------------------------------------------------ */

/**
 * Turn a bare "Failed to fetch" into something the operator can act on.
 *
 * A browser reports every blocked request identically and withholds the reason
 * from JavaScript, so the message has to enumerate the causes rather than
 * identify one. It names the host, because a firewall rule needs the host.
 */
export function networkFailureHelp(url, err) {
  let host = url;
  try { host = new URL(url).host; } catch { /* keep the raw string */ }
  const inViewer = typeof window !== 'undefined' && !!(window.claude && typeof window.claude.use === 'function');
  const fromDisk = typeof location !== 'undefined' && location.protocol === 'file:';
  const why = [];
  if (inViewer) {
    why.push('this page is running inside the claude.ai viewer, which blocks calls to outside services — download the single-file build and open that instead');
  }
  if (fromDisk) {
    why.push(`the page was opened from a file, so the request carries no origin and ${host} may refuse it — serving the page over http (node engine/serve.mjs 8099) avoids that`);
  }
  why.push(`a network rule, VPN or extension is blocking ${host}`);
  why.push('the key is fine either way: the request never reached the service, so it was never checked');
  return `Could not reach ${host}. The browser blocked or refused the request before it was sent, and does not say which. Likely: ${why.join('; ')}. The browser console holds the real reason.`;
}

/**
 * Run one review. `fetchImpl` is injectable so tests run without a network.
 * @returns {{ findings: Array, usage: { in, out }, provider, model }}
 */
export async function review({ provider = DEFAULT_PROVIDER, key, model, endpoint = '', texts = [], sheetB64 = null, imageCount = 0, imageFrom = 1, batch = null, appName = '', network = '', sendImages = true, fetchImpl = globalThis.fetch }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown provider "${provider}"`);
  const ad = ADAPTERS[p.api];
  if (!ad) throw new Error(`No adapter for API "${p.api}"`);
  if (!key) throw new Error('No API key. Paste one to run the AI review.');
  if (!model) throw new Error('Pick a model, or type a model id.');
  const base = endpoint || p.endpoint || '';
  if (p.api !== 'gemini' && p.api !== 'anthropic' && p.needsEndpoint && !base) {
    throw new Error('This service needs an endpoint base URL.');
  }
  // A text-only model is sent the copy alone rather than an image it will reject.
  const withImages = sendImages && !!sheetB64 && supportsVision(provider, model);
  const prompt = buildPrompt({
    texts, appName, network,
    imageCount: withImages ? imageCount : 0,
    imageFrom, batch: withImages ? batch : null,
  });
  const req = ad.request({ key, model, prompt, imageB64: withImages ? sheetB64 : null, endpoint: base });
  let res;
  try {
    res = await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
  } catch (err) {
    // fetch rejects only when the request never completed: blocked, refused or
    // offline. The browser deliberately hides which, so "Failed to fetch" on
    // its own tells the operator nothing. Name the causes instead.
    throw new Error(networkFailureHelp(req.url, err));
  }
  if (!res.ok) throw new Error(`${p.label} ${res.status}: ${(await res.text()).slice(0, 240)}`);
  const { text, usage } = ad.parse(await res.json());
  const findings = normalizeFindings(parseJsonLoose(text));
  return {
    findings, usage, provider, model, sawImages: withImages,
    sourced: findings.filter((f) => f.sourced).length,
    unsourced: findings.filter((f) => !f.sourced).length,
  };
}

/**
 * Collapse findings that several passes each reported.
 *
 * Every pass is given the same copy, so a concern about the text comes back
 * once per pass. Art findings are naturally distinct because each pass sees
 * different images. Two findings are the same when they name the same policy,
 * say the same thing, and point at the same evidence — evidence is part of the
 * key so "fake close button, image 12" and "fake close button, image 40" both
 * survive, which is what a reviewer needs to see.
 */
export function mergeFindings(lists) {
  const seen = new Map();
  for (const list of lists) {
    for (const f of list) {
      const key = [f.area, f.title, f.measured].join('|').toLowerCase();
      const prior = seen.get(key);
      // Keep the better-evidenced copy: a sourced finding beats an unsourced one.
      if (!prior || (!prior.sourced && f.sourced)) seen.set(key, f);
    }
  }
  return [...seen.values()];
}

/**
 * Review a creative in full, across as many passes as its art requires.
 *
 * One call per contact sheet. The copy goes with every pass, because a policy
 * judgement about an image usually depends on the words beside it; the passes
 * are then merged and de-duplicated. A pass that fails does not lose the ones
 * that succeeded — its error is returned alongside the findings, so a review of
 * six sheets where the fourth times out still reports the other five.
 *
 * @param {object} o
 * @param {Array} o.sheets      from `contactSheets`; empty runs a single copy-only pass
 * @param {function} [o.onProgress] called as ({ index, total, sheet }) before each pass
 * @returns {{ findings, usage, passes, images, failed, sawImages, provider, model }}
 */
export async function reviewAll({ sheets = [], onProgress = null, ...opts }) {
  const withImages = opts.sendImages !== false && sheets.length > 0
    && supportsVision(opts.provider || DEFAULT_PROVIDER, opts.model);
  // Nothing to look at, or a text-only model: one pass with the copy alone.
  const passes = withImages ? sheets : [null];
  const totalImages = sheets.reduce((n, s) => n + s.count, 0);
  const lists = [], failed = [];
  const usage = { in: 0, out: 0 };
  let sawImages = false;

  for (let i = 0; i < passes.length; i++) {
    const sheet = passes[i];
    if (onProgress) onProgress({ index: i + 1, total: passes.length, sheet });
    try {
      const r = await review({
        ...opts,
        sheetB64: sheet ? sheet.b64 : null,
        imageCount: sheet ? sheet.count : 0,
        imageFrom: sheet ? sheet.from : 1,
        batch: passes.length > 1 ? { index: i + 1, total: passes.length, totalImages } : null,
      });
      lists.push(r.findings);
      usage.in += r.usage.in; usage.out += r.usage.out;
      sawImages = sawImages || r.sawImages;
    } catch (err) {
      failed.push({ pass: i + 1, images: sheet ? `${sheet.from}–${sheet.from + sheet.count - 1}` : 'copy', message: err.message });
    }
  }
  // Every pass failing is a failure, not an all-clear.
  if (!lists.length) throw new Error(failed.map((f) => f.message).join(' · '));

  const findings = mergeFindings(lists);
  return {
    findings, usage, failed,
    passes: passes.length,
    images: withImages ? totalImages : 0,
    sawImages,
    provider: opts.provider || DEFAULT_PROVIDER,
    model: opts.model,
    sourced: findings.filter((f) => f.sourced).length,
    unsourced: findings.filter((f) => !f.sourced).length,
  };
}

/* ------------------------------------------------------------------ *
 * Browser-only: the contact sheet
 * ------------------------------------------------------------------ */

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * How many images go on one sheet.
 *
 * Not a taste decision. Every vision API scales an oversized image down before
 * the model sees it — Claude to 1568px on the longest edge — and the sheet is
 * `cols * cell` wide by `rows * cell` tall. At 6 columns of 200px, 42 images is
 * 7 rows, so the sheet is 1200x1400 and arrives unscaled. Push past that and
 * every cell shrinks: at 100 images the sheet is 3400px tall, comes back scaled
 * to 46%, and the drawn text this pass exists to read stops being legible.
 *
 * So more images per sheet buys nothing and costs sight. Batch instead.
 */
export const SHEET_MAX = 42;

function drawSheet(bitmaps, firstNumber, cols, cell) {
  const rows = Math.ceil(bitmaps.length / cols);
  const canvas = document.createElement('canvas');
  canvas.width = cols * cell; canvas.height = rows * cell;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#404040'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  bitmaps.forEach((bm, i) => {
    const x = (i % cols) * cell, y = Math.floor(i / cols) * cell;
    const k = Math.min((cell - 16) / bm.width, (cell - 16) / bm.height, 1);
    ctx.drawImage(bm, x + (cell - bm.width * k) / 2, y + (cell - bm.height * k) / 2 + 6, bm.width * k, bm.height * k);
    bm.close();
    // Numbered continuously across sheets, so evidence like "image 47" survives the merge.
    const label = String(firstNumber + i);
    ctx.fillStyle = '#000'; ctx.fillRect(x, y, 12 + label.length * 8, 18);
    ctx.fillStyle = '#ffeb3b'; ctx.font = 'bold 13px monospace'; ctx.fillText(label, x + 4, y + 14);
    ctx.strokeStyle = '#555'; ctx.strokeRect(x + .5, y + .5, cell - 1, cell - 1);
  });
  const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
  return { b64: dataUrl.slice(dataUrl.indexOf(',') + 1), dataUrl, count: bitmaps.length, from: firstNumber };
}

/**
 * Draw every one of the creative's images into numbered cells, across as many
 * sheets as it takes. Largest first, so if anything ever is dropped it is the
 * particles rather than the artwork.
 *
 * Decodes from the document's own bytes — no fetch, so it works offline and
 * inside sandboxes that block network access.
 *
 * @returns {Array<{b64, dataUrl, count, from}>} one entry per sheet, empty when
 *   the creative has no decodable raster art.
 */
export async function contactSheets(html, { perSheet = SHEET_MAX, cols = 6, cell = 200, max = Infinity } = {}) {
  if (typeof document === 'undefined') throw new Error('contactSheets needs a browser');
  const imgs = inventoryImages(html, { max });
  if (!imgs.length) return [];
  const sheets = [];
  let batch = [], firstNumber = 1, drawn = 0;
  for (const im of imgs) {
    try {
      const uri = html.substr(im.start, im.length);
      const bytes = b64ToBytes(uri.slice(uri.indexOf(',') + 1));
      batch.push(await createImageBitmap(new Blob([bytes], { type: im.mime })));
    } catch { continue; /* undecodable image — skip it, and do not spend a number on it */ }
    if (batch.length === perSheet) {
      sheets.push(drawSheet(batch, firstNumber, cols, cell));
      drawn += batch.length; firstNumber = drawn + 1; batch = [];
    }
  }
  if (batch.length) sheets.push(drawSheet(batch, firstNumber, cols, cell));
  return sheets;
}

/**
 * The first sheet only. Kept for callers that want a single image and accept
 * that a large creative will not fit on it.
 */
export async function contactSheet(html, { max = SHEET_MAX, cols = 6, cell = 200 } = {}) {
  const [first] = await contactSheets(html, { perSheet: max, cols, cell, max });
  return first || null;
}
