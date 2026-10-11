// Inlines src/* into a single self-contained dist/PlutoNano.html.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(root, 'src', f), 'utf8');

let html = src('index.html');
html = html.replace(/\/\*INLINE:([\w.-]+)\*\//g, (_, f) => {
  const code = src(f);
  if (/<\/script/i.test(code)) throw new Error(`${f} contains "</script"`);
  return code;
});

mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', 'PlutoNano.html');
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(1)} KB)`);
