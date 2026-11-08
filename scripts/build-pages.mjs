// npm run build:pages [-- outDir] : the public demo as plain files, for GitHub Pages. Only what the page needs: web/ (no
// gallery), the three.js files it imports and their license, the README's clip for browsers with no WebGL. Nothing comes
// from server/ or data/. Exits 1, naming it, if the result mentions a local address, or a word on the private list (a file
// that exists only in the private repo).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(ROOT, process.argv[2] || 'dist-pages');
const PUBLIC_URL = 'https://dicksonkam.github.io/ai-office/';
const PUBLIC_ADDRESSES = ['github.com/dicksonkam/ai-office', 'dicksonkam.github.io/ai-office'];
if (fs.existsSync(out) && fs.readdirSync(out).length) { console.error(`${out} is not empty: move it away first.`); process.exit(1); }
fs.mkdirSync(out, { recursive: true });

const skip = name => name === 'gallery' || name.startsWith('._') || name === '.DS_Store';
fs.cpSync(path.join(ROOT, 'web'), out, { recursive: true, filter: src => !skip(path.basename(src)) });

const three = path.join(ROOT, 'node_modules', 'three'), put = (rel, to = rel) => { const d = path.join(out, 'vendor', 'three', to); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(path.join(three, rel), d); };
put('LICENSE');
const files = fs.readdirSync(out).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(out, f), 'utf8')).join('\n');
const coreImports = fs.readFileSync(path.join(three, 'build', 'three.module.js'), 'utf8').match(/from '\.\/([\w.]+\.js)'/g)?.map(m => m.slice(8, -1)) ?? [];
for (const f of new Set(['three.module.js', ...coreImports])) put(path.join('build', f));
for (const m of new Set([...files.matchAll(/three\/addons\/([\w/.-]+\.js)/g)].map(x => x[1]))) put(path.join('examples', 'jsm', m));

fs.copyFileSync(path.join(ROOT, 'docs', 'office.webp'), path.join(out, 'office.webp'));
fs.copyFileSync(path.join(ROOT, 'docs', 'office.png'), path.join(out, 'office.png'));

const indexFile = path.join(out, 'index.html');
const meta = `<meta name="ai-office-hosted" content="1">
<meta property="og:title" content="AI Office">
<meta property="og:description" content="A cozy 3D office where AI coding agents are the workers. This is a demo with made-up work.">
<meta property="og:image" content="${PUBLIC_URL}office.png">
<meta property="og:url" content="${PUBLIC_URL}">
`;
fs.writeFileSync(indexFile, fs.readFileSync(indexFile, 'utf8').replace('<title>', `${meta}<title>`));

const texts = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); } else if (/\.(js|html|css|webmanifest)$/.test(e.name)) texts.push(p); } }; walk(out);
const listFile = path.join(ROOT, 'scripts', 'public-denylist.txt');
const words = fs.existsSync(listFile) ? fs.readFileSync(listFile, 'utf8').split('\n').map(w => w.trim().toLowerCase()).filter(Boolean) : [];
const problems = [];
for (const f of texts) {
  const t = fs.readFileSync(f, 'utf8'), low = t.toLowerCase().split(PUBLIC_ADDRESSES[0]).join('').split(PUBLIC_ADDRESSES[1]).join(''), rel = path.relative(out, f); // the project's public addresses are meant to be public
  if (/\b(localhost|127\.0\.0\.1)\b/.test(t)) problems.push(`${rel}: a local address`);
  for (const w of words) if (low.includes(w)) problems.push(`${rel}: "${w}"`);
}
if (problems.length) { console.error('REFUSED:\n  ' + problems.join('\n  ')); process.exit(1); }
const size = (function sum(d) { return fs.readdirSync(d, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? sum(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0); })(out);
console.log(`built ${path.relative(ROOT, out) || out}: ${(size / 1e6).toFixed(1)} MB`);
