// Presses the keys, in a real browser, and checks the body moves.
//
//   npm start            # in one terminal
//   npm run test:keys    # in another
//
// Everything between a key going down and a body moving - the listener, the
// bindings, the bitmask, the transport, the simulation - is covered by nothing
// else here: simtest calls step() with inputs it made up, and netcheck uses a
// stub for the hands. This is the only test that touches the real chain, and it
// needs a browser, which is why it is not part of `npm test`.

import { launch, open, sleep } from './browser.js';

const PORT = Number(process.env.PORT) || 5173;
const base = `http://localhost:${PORT}/?play=foundry&mode=dm&bots=1&ticks=200&sound=0`;

let failures = 0;
const check = (what, got) => {
  console.log(`  ${got ? ' ' : '✗'} ${what}`);
  if (!got) failures++;
};

const KEYS = {
  w: ['KeyW', 87], s: ['KeyS', 83], a: ['KeyA', 65], d: ['KeyD', 68], space: ['Space', 32],
};

async function main() {
  const chrome = await launch();
  const page = await open(base);
  try {
    if (!await page.ready()) throw new Error('the page never finished building the arena');

    const probe = async () => page.evaluate(`(() => {
      const b = window.__state.bodies[0];
      return { x: b.x, y: b.y, z: b.z, yaw: b.yaw, ground: b.onGround, weapon: b.weapon };
    })()`);

    const hold = async (name, ms) => {
      const [code, vk] = KEYS[name];
      await page.key('keyDown', code, vk, name === 'space' ? ' ' : name);
      await sleep(ms);
      await page.key('keyUp', code, vk, name === 'space' ? ' ' : name);
      await sleep(120);
    };

    // Forward, and then the same distance back.
    const start = await probe();
    await hold('w', 800);
    const forward = await probe();
    const wentForward = Math.hypot(forward.x - start.x, forward.z - start.z);
    check(`holding forward covers ground (${wentForward.toFixed(1)} m in 0.8 s)`, wentForward > 3);

    await hold('s', 800);
    const back = await probe();
    const returned = Math.hypot(back.x - start.x, back.z - start.z);
    check(`and holding back brings you home (${returned.toFixed(1)} m from where you began)`,
      returned < wentForward * 0.6);

    // Sideways, which had better be sideways: the strafe buttons have been the
    // wrong way round in this game once already, and nothing else would notice.
    const beforeStrafe = await probe();
    await hold('d', 600);
    const right = await probe();
    const yaw = (beforeStrafe.yaw / 65536) * Math.PI * 2;
    // Right of where you are looking is (sin yaw, -cos yaw) on the floor plan.
    const alongRight = (right.x - beforeStrafe.x) * Math.sin(yaw)
      + (right.z - beforeStrafe.z) * -Math.cos(yaw);
    check(`strafing right goes right (${alongRight.toFixed(1)} m along it)`, alongRight > 1.5);

    const beforeJump = await probe();
    await page.key('keyDown', 'Space', 32, ' ');
    await sleep(160);
    const mid = await probe();
    await page.key('keyUp', 'Space', 32, ' ');
    check(`jumping leaves the floor (${(mid.y - beforeJump.y).toFixed(2)} m up)`,
      mid.y > beforeJump.y + 0.2 && !mid.ground);
    await sleep(700);

    // And the weapon keys, which go through a different path again.
    await page.evaluate('window.__state.bodies[0].have[2] = true; window.__state.bodies[0].ammo[2] = 5;');
    await page.key('keyDown', 'Digit3', 51, '3');
    await sleep(120);
    await page.key('keyUp', 'Digit3', 51, '3');
    await sleep(200);
    const armed = await probe();
    check(`pressing 3 puts the rockets in your hands (weapon ${armed.weapon})`, armed.weapon === 2);
  } finally {
    await page.close();
    chrome.kill();
  }

  if (failures) {
    console.error(`\n${failures} of the controls do not work.`);
    process.exit(1);
  }
  console.log('\nThe keyboard reaches the simulation.');
}

main().catch((err) => {
  console.error(`  ${err.message}`);
  console.error('  (this test needs `npm start` running in another terminal, and a Chrome)');
  process.exit(1);
});
