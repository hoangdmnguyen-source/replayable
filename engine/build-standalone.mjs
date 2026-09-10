/**
 * Bundle the tool into ONE self-contained HTML file.
 *
 *   node engine/build-standalone.mjs        → dist/re-playable.html
 *
 * The result opens by double-clicking — no server, no Node, no network — and
 * is what a client receives. Each engine module becomes an IIFE registered on
 * a private `__rp` table; the page's imports become lookups on that table.
 * Nothing else changes, so the bundled page behaves exactly like the served one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'dist', 're-playable.html');

const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*['"]\.\/(?:engine\/)?([\w-]+)\.mjs['"];?[ \t]*$/gm;

const modules = new Map();
function load(name) {
  if (modules.has(name)) return;
  let code = fs.readFileSync(path.join(root, 'engine', `${name}.mjs`), 'utf8');
  const deps = [];
  code = code.replace(IMPORT_RE, (m, names, dep) => { deps.push(dep); return `const {${names}} = __rp['${dep}'];`; });
  const exports = [];
  code = code.replace(/^export\s+(async\s+function|function)\s+([\w$]+)/gm, (m, kw, n) => { exports.push(n); return `${kw} ${n}`; });
  code = code.replace(/^export\s+const\s+([\w$]+)/gm, (m, n) => { exports.push(n); return `const ${n}`; });
  // `export { A, B };` — a re-export of names already bound in this module,
  // which is how a module passes a dependency's value straight through.
  code = code.replace(/^export\s*\{([^}]*)\}\s*;?[ \t]*$/gm, (m, names) => {
    for (const n of names.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (/\bas\b/.test(n)) throw new Error(`${name}.mjs: renamed export "${n}" is not supported`);
      exports.push(n);
    }
    return '';
  });
  if (/^export\b/m.test(code)) throw new Error(`${name}.mjs uses an export form the bundler does not handle`);
  const dupes = exports.filter((n, i) => exports.indexOf(n) !== i);
  if (dupes.length) throw new Error(`${name}.mjs exports ${dupes.join(', ')} more than once`);
  modules.set(name, { code, deps, exports });
  deps.forEach(load);
}

const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const m = /<script type="module">([\s\S]*?)<\/script>\s*<\/body>/.exec(page);
if (!m) throw new Error('page module script not found');
let app = m[1];
app = app.replace(IMPORT_RE, (mm, names, dep) => { load(dep); return `const {${names}} = __rp['${dep}'];`; });

// Emit in dependency order.
const order = [], seen = new Set();
function visit(name) {
  if (seen.has(name)) return;
  seen.add(name);
  modules.get(name).deps.forEach(visit);
  order.push(name);
}
[...modules.keys()].forEach(visit);

const bundle = order.map((name) => {
  const mod = modules.get(name);
  return `/* ---- engine/${name}.mjs ---- */\n__rp['${name}'] = (() => {\n${mod.code}\nreturn { ${mod.exports.join(', ')} };\n})();`;
}).join('\n\n');

// Inline JS may not contain a literal "</script": the HTML parser would end the
// element there. Inside a string or template literal "<\/script" is the same
// text, and regex literals are already written that way.
const js = `const __rp = {};\n${bundle}\n\n/* ---- index.html ---- */\n${app}`.replace(/<\/script/g, '<\\/script');

let html = page.slice(0, m.index)
  + `<script type="module">\n${js}</script>\n</body>`
  + page.slice(m.index + m[0].length);

// The "opened from disk" banner is about module loading, which no longer applies.
html = html.replace(/<div id="fileBanner">[\s\S]*?<\/div>\s*<script>if \(location\.protocol === 'file:'\)[^<]*<\/script>\s*/, '');
html = html.replace('<title>Re-Playable · Google Ads converter</title>', '<title>Re-Playable</title>');

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`wrote ${path.relative(root, outFile)} — ${(html.length / 1024).toFixed(0)} KB, modules: ${order.join(', ')}`);
