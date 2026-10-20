// Inlines src/* (and the decoders' wasm as base64) into a single self-contained dist/PlutoNano.html, and
// writes docs/ (GitHub Pages) with the same page as an installable PWA.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(root, 'src', f), 'utf8');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
let html = src('index.html').replaceAll('__APP_VERSION__', pkg.version);
html = html.replace(/\/\*INLINE:([\w./-]+)\*\//g, (_, f) => {
  const code = src(f);
  if (/<\/script/i.test(code)) throw new Error(`${f} contains "</script"`);
  return code;
});
// Binary files (the decoders' WebAssembly cores) as base64.
html = html.replace(/\/\*INLINE_B64:([\w./-]+)\*\//g, (_, f) => readFileSync(join(root, 'src', f)).toString('base64'));

mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', 'PlutoNano.html');
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(1)} KB)`);

// PWA: same page plus a manifest link; the service worker cache name
// follows the content so every build is picked up.
const docs = join(root, 'docs');
mkdirSync(docs, { recursive: true });
const page = html.replace('</head>', '<link rel="manifest" href="manifest.webmanifest">\n<link rel="icon" href="icon.svg">\n</head>');
writeFileSync(join(docs, 'index.html'), page);
for (const f of ['manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png']) {
  copyFileSync(join(root, 'pwa', f), join(docs, f));
}
const version = createHash('sha256').update(page).update(readFileSync(join(root, 'pwa', 'manifest.webmanifest')))
  .digest('hex').slice(0, 12);
writeFileSync(join(docs, 'sw.js'), readFileSync(join(root, 'pwa', 'sw.js'), 'utf8').replace('/*VERSION*/', version));
console.log(`wrote ${docs}/ (PWA ${version})`);
