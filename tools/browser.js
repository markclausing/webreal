// A headless browser, driven over the DevTools protocol, with no dependencies.
//
// The other games in this series photograph and test themselves in Node,
// because their renderers write into a Uint32Array and will run anywhere the
// arithmetic runs. This one needs a graphics card, so the two tools that have to
// see the real thing - the screenshots and the key test - drive a real Chrome
// instead. That is a WebSocket and some JSON, and Node has had both built in for
// years.

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const DEBUG_PORT = Number(process.env.CHROME_PORT) || 9333;

const CHROMES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Start a browser, or use one that is already listening on the port. */
export async function launch({ width = 1600, height = 900 } = {}) {
  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    if (res.ok) return { kill() {} };
  } catch { /* nothing there, start our own */ }

  const profile = path.join(tmpdir(), `webreal-${process.pid}`);
  let last = null;
  for (const bin of CHROMES) {
    try {
      const proc = spawn(bin, [
        '--headless=new',
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${profile}`,
        // SwiftShader, because a headless machine has no graphics card and this
        // game will not run without one.
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--hide-scrollbars',
        '--mute-audio',
        '--no-first-run',
        '--disable-extensions',
        `--window-size=${width},${height}`,
        'about:blank',
      ], { stdio: 'ignore' });
      proc.on('error', () => {});
      for (let i = 0; i < 100; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
          if (res.ok) return proc;
        } catch { /* not up yet */ }
        await sleep(100);
      }
      proc.kill();
      last = new Error('it started and never answered');
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`No Chrome would start (${last ? last.message : 'none found'}). Set CHROME to the path of one.`);
}

/** One page, and the handful of things worth doing to it. */
export async function open(url, { width = 1600, height = 900, mobile = false } = {}) {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' });
  const target = await res.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const waiting = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('could not open a page'));
  });
  socket.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const pending = waiting.get(msg.id);
    if (pending) {
      waiting.delete(msg.id);
      pending(msg.result);
    }
  };

  const send = (method, params = {}) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });

  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: mobile ? 2 : 1, mobile,
  });
  if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  const page = {
    send,
    async evaluate(expression) {
      // awaitPromise, because half the things worth asking a page - "did that
      // socket open?" - are promises, and without it you get back the promise.
      const out = await send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      });
      return out?.result?.value;
    },
    /** Wait for src/main.js to say the arena is built and the match wound on. */
    async ready(seconds = 60) {
      for (let i = 0; i < seconds * 7; i++) {
        if (await page.evaluate('window.__ready === true')) return true;
        await sleep(150);
      }
      return false;
    },
    async key(type, code, virtualKey, key) {
      await send('Input.dispatchKeyEvent', {
        type, code, key, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey,
      });
    },
    async screenshot() {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      return Buffer.from(shot.data, 'base64');
    },
    async close() {
      socket.close();
      await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${target.id}`);
    },
  };
  return page;
}
