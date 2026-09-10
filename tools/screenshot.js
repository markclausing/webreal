// Photographs the game, without anybody having to sit and play it.
//
//   node tools/screenshot.js                       # the set the README uses
//   node tools/screenshot.js foundry 900 2         # arena, tick, which body
//   node tools/screenshot.js --keep                # leave the browser running
//
// The other games in this series draw their screenshots in Node, because their
// renderers write into a Uint32Array and will run anywhere the arithmetic runs.
// This one needs a graphics card, so instead it drives a headless Chrome over
// the DevTools protocol - which is a WebSocket and some JSON, and Node has had
// both built in for years. Still no dependencies.
//
// It waits for `window.__ready`, which src/main.js sets once the arena is built,
// the match has been wound forward and the camera has been handed to somebody
// who is alive. Photographing before that gets you a picture of a loading
// screen, which is how the first dozen of these came out.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, open, sleep } from './browser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 5173;
const WIDTH = Number(process.env.SHOT_WIDTH) || 1600;
const HEIGHT = Number(process.env.SHOT_HEIGHT) || 900;
const MOBILE = process.env.SHOT_MOBILE === '1';

/** The set the README uses: one of each arena, and one of each mode. */
const SHOTS = [
  { name: 'foundry', q: 'play=foundry&mode=dm&bots=5&ticks=900&watch=2&seed=5' },
  { name: 'pit', q: 'play=foundry&mode=dm&bots=5&ticks=1500&watch=4&seed=12' },
  { name: 'cistern', q: 'play=cistern&mode=dm&bots=5&ticks=800&watch=3&seed=9' },
  { name: 'overlook', q: 'play=overlook&mode=dm&bots=5&ticks=1200&watch=1&seed=3' },
  { name: 'bastion', q: 'play=bastion&mode=ctf&bots=5&ticks=1400&watch=2&seed=7' },
  { name: 'sluice', q: 'play=sluice&mode=ctf&bots=5&ticks=1100&watch=1&seed=4' },
  { name: 'instagib', q: 'play=cistern&mode=dm&bots=5&insta=1&ticks=700&watch=2&seed=11' },
  { name: 'announcer', q: 'play=cistern&mode=dm&bots=5&insta=1&ticks=400&watch=2&until=multi&seed=9' },
];

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const keep = process.argv.includes('--keep');
  // A name from the list above photographs that exact set-up, which is the only
  // way to ask for the ones that wait for something to happen.
  const named = args.length ? SHOTS.find((shot) => shot.name === args[0]) : null;
  const shots = named ? [named] : args.length
    ? [{
      name: `${args[0]}-${args[1] || 600}`,
      q: `play=${args[0]}&mode=${args[3] || 'dm'}&bots=5&ticks=${args[1] || 600}&watch=${args[2] || 2}&seed=5`,
    }]
    : SHOTS;

  const chrome = await launch({ width: WIDTH, height: HEIGHT });
  try {
    mkdirSync(path.join(ROOT, 'shots'), { recursive: true });
    for (const shot of shots) {
      const url = `http://localhost:${PORT}/?${shot.q}&sound=0&freeze=1`;
      const png = await capture(url);
      const file = path.join('shots', `${shot.name}.png`);
      writeFileSync(path.join(ROOT, file), png);
      console.log(`wrote ${file}`);
    }
  } finally {
    if (!keep) chrome.kill();
  }
}

/** One page, one photograph. */
async function capture(url) {
  const page = await open(url, { width: WIDTH, height: HEIGHT, mobile: MOBILE });
  if (!await page.ready()) console.warn('  (the page never became ready; photographing it anyway)');
  await sleep(600);
  const png = await page.screenshot();
  await page.close();
  return png;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
