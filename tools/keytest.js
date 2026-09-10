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
//
// The thumbs get the same treatment. Which way a drag turns the view and how far
// it turns it are two things you cannot tell from reading the code - the signs
// pass through three files - and they are the two things somebody holding a
// phone notices in the first ten seconds.

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

    // Back is the opposite of forward, and that is what is checked - not how
    // far it got. How far anything gets in eight hundred milliseconds depends on
    // how fast the browser is drawing, and under a software renderer that is not
    // a number worth asserting on.
    await hold('s', 800);
    const back = await probe();
    const wentBack = Math.hypot(back.x - forward.x, back.z - forward.z);
    const along = ((forward.x - start.x) * (back.x - forward.x)
      + (forward.z - start.z) * (back.z - forward.z)) / Math.max(0.01, wentForward * wentBack);
    check(`and holding back goes the other way (${(Math.acos(Math.max(-1, Math.min(1, along))) * 57.3).toFixed(0)} deg from the way out)`,
      along < -0.8);

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
    await touchCheck(page);
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

/**
 * A thumb on the right half of the screen, dragged.
 *
 * Dispatched as real touch events through the browser, so it goes through the
 * same pointer handlers a phone does. What it is checking is direction and
 * amount: pulling the scene left turns you right, pulling it down looks up, and
 * a two centimetre swipe is worth something like a quarter turn.
 */
async function touchCheck(page) {
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await page.evaluate("window.__touchOn = true; location.search;");
  // The thumbs are only attached when the game thinks it is on a phone, so the
  // page is reloaded with the override that says so.
  await page.send('Page.navigate', {
    url: `${base}&touch=1`,
  });
  if (!await page.ready()) {
    console.log('   ✗ the page did not come back with the thumbs on');
    failures++;
    return;
  }
  const size = await page.evaluate('({ w: window.innerWidth, h: window.innerHeight })');
  const x = size.w * 0.75;
  const y = size.h * 0.5;

  const drag = async (dx, dy) => {
    const point = (px, py) => [{ x: px, y: py, radiusX: 8, radiusY: 8, force: 1, id: 1 }];
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(x, y) });
    // Slowly, one step per frame or so. A drag dispatched faster than the
    // browser turns touches into pointer events is a drag that arrives as one
    // move, and then this measures the sensitivity of a single step.
    for (let i = 1; i <= 8; i++) {
      await page.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: point(x + (dx * i) / 8, y + (dy * i) / 8),
      });
      await sleep(40);
    }
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(250);
  };

  const look = async () => page.evaluate(
    '({ yaw: window.__state.bodies[0].yaw, pitch: window.__state.bodies[0].pitch })');
  const degrees = (units) => {
    let d = ((units % 65536) + 65536) % 65536;
    if (d > 32768) d -= 65536;
    return (d / 65536) * 360;
  };

  const before = await look();
  await drag(140, 0);
  const afterYaw = await look();
  const turned = degrees(afterYaw.yaw - before.yaw);
  // Yaw counts the other way round from the view: turning to the left is yaw
  // going up. A drag to the right is meant to pull the room right and take you
  // left with it.
  // Both halves of this matter. The sign is the convention; the size is whether
  // the browser let the whole swipe through, and it did not until the playing
  // surface was given touch-action: none.
  check(`dragging the thumb right turns the view left (${turned.toFixed(0)} deg over 140 px)`,
    turned > 35 && turned < 75);

  await drag(0, 90);
  const afterPitch = await look();
  const lifted = degrees(afterPitch.pitch - afterYaw.pitch);
  check(`dragging the thumb down looks up (${lifted.toFixed(0)} deg over 90 px)`,
    lifted > 22 && lifted < 48);
}

main().catch((err) => {
  console.error(`  ${err.message}`);
  console.error('  (this test needs `npm start` running in another terminal, and a Chrome)');
  process.exit(1);
});
