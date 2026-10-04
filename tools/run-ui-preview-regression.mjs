#!/usr/bin/env node
/**
 * Headless runner for the UI preview regression checks.
 *
 * `ui-preview-regression.js` is a devtools-paste script: it defines `run(label)`
 * and asserts the UI invariants against whatever page it is loaded into. Nothing
 * ran it, so 1,700 lines of assertions were verified only when someone
 * remembered to paste them by hand — which is the same as not being verified.
 * This runs it for real, at the window sizes the app actually uses.
 *
 *   node tools/run-ui-preview-regression.mjs            # all viewports
 *   node tools/run-ui-preview-regression.mjs 1400x900   # just one
 *
 * Deliberately dependency-free. It drives the browser over the Chrome DevTools
 * Protocol with Node's built-in WebSocket (Node 22+), so CI needs nothing
 * installed beyond the browser that is already on the runner image.
 *
 * Exit status is the contract: 0 when every viewport passes, 1 on any failing
 * assertion or setup error. The checks themselves are untouched — this file
 * serves the page, launches the browser, calls `run()`, and reports what came
 * back.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// The sizes the checks are written for: the wide desktop case down to the
// smallest window the app allows (NORMAL_MIN in paprika_app.py is 320x380).
const VIEWPORTS = ['1400x900', '900x700', '800x600', '360x420', '330x380'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
};

function findBrowser() {
  const candidates = [
    process.env.UI_PREVIEW_BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  throw new Error(
    'No Chromium-based browser found. Set UI_PREVIEW_BROWSER to one, or install '
    + 'Chrome / Edge. Tried:\n  ' + candidates.join('\n  '));
}

/** Serves the repo so the page loads app.js, style.css and the checks. */
function serveRepo() {
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const target = normalize(join(REPO_ROOT, rel));
    // Never serve outside the repo, whatever the request asks for.
    if (!target.startsWith(REPO_ROOT) || !existsSync(target)) {
      res.writeHead(404).end('not found');
      return;
    }
    try {
      res.writeHead(200, { 'Content-Type': MIME[extname(target)] || 'application/octet-stream' })
        .end(readFileSync(target));
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

async function waitForTarget(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) { /* browser still starting */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('the browser never exposed a page target');
}

/** A minimal CDP client: one socket, one in-flight command at a time. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', () => fail(new Error(`cannot open ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description
        || res.exceptionDetails.text || 'evaluation failed');
    }
    return res.result?.value;
  }
}

async function main() {
  const only = process.argv.slice(2).filter((a) => /^\d+x\d+$/.test(a));
  const viewports = only.length ? only : VIEWPORTS;
  const browserPath = findBrowser();
  const server = await serveRepo();
  const port = server.address().port;
  const profile = mkdtempSync(join(tmpdir(), 'ui-preview-'));
  const debugPort = 9222 + (process.pid % 500);

  const child = spawn(browserPath, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1400,900',
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp = null;
  let failures = 0;
  try {
    const target = await waitForTarget(debugPort);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // Pin prefers-reduced-motion: no-preference. The checks assert the beat,
    // moments, air and tilt are LIVE, and the app honors reduced motion by
    // leaving every one of them stock — which is exactly what a host with
    // "show animations" disabled reports (Windows Server defaults, plus any
    // accessibility setting). Without this pin the suite is green on a dev
    // laptop and red on CI for reasons that have nothing to do with the code.
    // The reduced-motion RULES are still asserted on their own, statically, from
    // the stylesheets (dustReducedHidden / tiltReducedNeutral), so nothing about
    // the opt-out goes untested. Animations themselves are suspended by the
    // checks' own stylesheet, not by the media state.
    await cdp.send('Emulation.setEmulatedMedia', {
      media: '',
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    });

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/ui/index.html` });
    await new Promise((r) => setTimeout(r, 1500));

    // Load the checks the way the devtools paste does, then confirm they are in.
    const checks = readFileSync(join(REPO_ROOT, 'tools/ui-preview-regression.js'), 'utf8');
    await cdp.evaluate(`${checks}\n;typeof run`);
    const ready = await cdp.evaluate('typeof run');
    if (ready !== 'function') throw new Error('the checks did not define run()');

    for (const size of viewports) {
      const [width, height] = size.split('x').map(Number);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
      });
      await new Promise((r) => setTimeout(r, 250));

      const res = await cdp.evaluate(
        `(async () => {
           try {
             const r = await run(${JSON.stringify(size)});
             return { ok: true, problems: (r && r.problems) || [], keys: Object.keys(r || {}).length };
           } catch (e) {
             return { ok: false, problems: [String((e && e.stack) || e)] };
           }
         })()`);

      if (!res || res.ok !== true || (res.problems || []).length) {
        failures++;
        console.error(`FAIL ${size}`);
        for (const problem of (res && res.problems) || ['no result']) {
          console.error(`  - ${problem}`);
        }
      } else {
        console.log(`PASS ${size}  (${res.keys} checks recorded)`);
      }
    }
  } finally {
    try { cdp?.ws.close(); } catch (e) { /* already gone */ }
    child.kill();
    // Wait for the browser to actually exit before touching its profile: on
    // Windows the directory stays locked for a moment after the kill, and a
    // leftover temp folder must never be able to fail the run.
    await new Promise((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done();
      child.once('exit', done);
      setTimeout(done, 5000);
    });
    server.close();
    for (let attempt = 0; attempt < 5; attempt++) {
      try { rmSync(profile, { recursive: true, force: true }); break; }
      catch (e) { await new Promise((r) => setTimeout(r, 200)); }
    }
  }

  if (failures) {
    console.error(`\n${failures} viewport(s) failed the UI regression checks.`);
    process.exit(1);
  }
  console.log(`\nAll ${viewports.length} viewport(s) passed the UI regression checks.`);
}

main().catch((err) => {
  console.error('UI preview regression runner failed:', err.message);
  process.exit(1);
});