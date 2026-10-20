// Loads dist/PlutoNano.html in headless Chrome over CDP, reports console
// errors and WebUSB availability, and saves a screenshot.
// Usage: node tools/browser-check.mjs [out.png] [--mock]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const out = process.argv[2] || 'shot.png';
const mock = process.argv.includes('--mock');
const page = process.env.PAGE || 'file://' + resolve('dist/PlutoNano.html');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const prof = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'cdp-'));
const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${prof}`,
  '--window-size=1400,850', '--autoplay-policy=no-user-gesture-required',
  // Fake microphone for the TX path.
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', 'about:blank'], { stdio: 'ignore' });
// Never leave headless Chrome running (and playing audio) when this script fails.
process.on('exit', () => proc.kill());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) {
  try { targets = await (await fetch('http://127.0.0.1:9333/json')).json(); if (targets.length) break; } catch (e) {}
  await sleep(200);
}
const t = targets.find((x) => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Log.entryAdded') logs.push(`[log ${m.params.entry.level}] ${m.params.entry.text}`);
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 850, deviceScaleFactor: 1, mobile: false });
if (mock) await send('Page.addScriptToEvaluateOnNewDocument', { source: readFileSync('tools/mock-usb.js', 'utf8') });
await send('Page.navigate', { url: page });
await sleep(1500);
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
console.log('secure:', await ev('isSecureContext'), 'usb:', await ev('typeof navigator.usb'));
if (mock) {
  await ev(`document.getElementById('introClose').click()`);
  await sleep(1500);
  // The app starts receiving on connect; only press play if it did not.
  await ev(`document.getElementById('btnPlay').classList.contains('on') || document.getElementById('btnPlay').click()`);
  await sleep(4000);
  console.log('state:', await ev(`window.__plutoNano.state`));
  console.log('meter:', await ev(`document.getElementById('meterText').textContent`));
}
if (process.env.INSTALL) {
  // PWA checks: manifest errors and installability as Chrome sees them.
  const m = (await send('Page.getAppManifest')).result;
  console.log('manifest errors:', JSON.stringify(m.errors || []));
  console.log('installability:', JSON.stringify((await send('Page.getInstallabilityErrors')).result.installabilityErrors));
  console.log('service worker:', await ev(`navigator.serviceWorker.ready.then((r) => r.active && r.active.state)`));
}
if (process.env.EVAL_FILE) console.log("eval:", await ev(readFileSync(process.env.EVAL_FILE, "utf8")));
// CLIP=x,y,w,h captures just that region at 2x.
const clip = process.env.CLIP && process.env.CLIP.split(',').map(Number);
const shot = await send('Page.captureScreenshot', clip
  ? { format: 'png', clip: { x: clip[0], y: clip[1], width: clip[2], height: clip[3], scale: 2 } }
  : { format: 'png' });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log(logs.length ? logs.join('\n') : 'no console output');
ws.close();
proc.kill();
