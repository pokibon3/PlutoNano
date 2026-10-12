// Renders pwa/icon.svg to pwa/icon-192.png and pwa/icon-512.png with
// headless Chrome (via browser-check.mjs). Run after editing the SVG:
//   node tools/make-icons.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'icons-'));
const svg = readFileSync('pwa/icon.svg', 'utf8');
for (const size of [192, 512]) {
  // Screenshots are taken at 2x, so draw at half size.
  const css = size / 2;
  const page = join(tmp, `icon${size}.html`);
  writeFileSync(page, `<style>html,body{margin:0;background:#03111a}svg{display:block;width:${css}px;height:${css}px}</style>${svg}`);
  execFileSync('node', ['tools/browser-check.mjs', resolve(`pwa/icon-${size}.png`)], {
    env: { ...process.env, PAGE: 'file://' + page, CLIP: `0,0,${css},${css}` }, stdio: 'ignore',
  });
  console.log(`wrote pwa/icon-${size}.png`);
}
