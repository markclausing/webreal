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
    // Nobody else in the arena. The bot was killing the player halfway through,
    // which resets the weapons it had just been given and reads as a weapon key
    // that does not work.
    await page.evaluate(`(() => {
      for (const b of window.__state.bodies.slice(1)) { b.alive = false; b.respawnIn = 1e9; }
      return true;
    })()`);

    /**
     * Stand somewhere with room in every direction.
     *
     * Without this the test measures wherever the spawn happened to put the
     * body, and a strafe into a wall is nought metres of strafe - which reads
     * exactly like a strafe button that does nothing. The Foundry's north strip
     * is forty metres of clear floor, so both of these have room on all sides.
     */
    const place = async (x, z, yaw) => page.evaluate(`(() => {
      const b = window.__state.bodies[0];
      b.x = ${x}; b.y = 0.2; b.z = ${z};
      b.vx = 0; b.vy = 0; b.vz = 0; b.yaw = ${yaw}; b.pitch = 0;
      return true;
    })()`);

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
    await place(-18, 14, 0);
    await sleep(200);
    const start = await probe();
    await hold('w', 800);
    const forward = await probe();
    const wentForward = Math.hypot(forward.x - start.x, forward.z - start.z);
    // A low bar on purpose. How far anything gets in eight hundred milliseconds
    // depends on how fast the browser is drawing, and under a software renderer
    // that is not a number worth asserting on - only that the body went
    // somewhere, and the check below that it went back.
    check(`holding forward covers ground (${wentForward.toFixed(1)} m in 0.8 s)`, wentForward > 1.5);

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

    // Sideways, which had better be sideways. The strafe buttons were the wrong
    // way round for the whole of this game's first week, and the reason nothing
    // caught it is that this check used to be written from the same idea the
    // simulation had rather than from the camera. So: right is forward crossed
    // with up, which with X east, Y up and Z north is (-sin yaw, cos yaw), and
    // that is the direction the renderer puts on the right of the screen.
    // Facing +z, so right is -x and left is +x, with twenty metres of each.
    await place(0, 14, 16384);
    await sleep(200);
    const beforeStrafe = await probe();
    await hold('d', 600);
    const right = await probe();
    const yaw = (beforeStrafe.yaw / 65536) * Math.PI * 2;
    const alongRight = (right.x - beforeStrafe.x) * -Math.sin(yaw)
      + (right.z - beforeStrafe.z) * Math.cos(yaw);
    check(`strafing right goes right (${alongRight.toFixed(1)} m along it)`, alongRight > 1.5);
    await place(0, 14, 16384);
    await sleep(200);
    const beforeLeft = await probe();
    await hold('a', 600);
    const left = await probe();
    const alongLeft = (left.x - beforeLeft.x) * -Math.sin(yaw)
      + (left.z - beforeLeft.z) * Math.cos(yaw);
    check(`and strafing left goes left (${alongLeft.toFixed(1)} m along it)`, alongLeft < -1.5);

    await place(0, 14, 0);
    await sleep(250);
    const beforeJump = await probe();
    await page.key('keyDown', 'Space', 32, ' ');
    await sleep(160);
    const mid = await probe();
    await page.key('keyUp', 'Space', 32, ' ');
    check(`jumping leaves the floor (${(mid.y - beforeJump.y).toFixed(2)} m up)`,
      mid.y > beforeJump.y + 0.2 && !mid.ground);
    await sleep(700);

    // And the weapon keys, which go through a different path again.
    await page.evaluate(`(() => {
      const b = window.__state.bodies[0];
      b.health = 100; b.have[2] = true; b.ammo[2] = 5;
      return true;
    })()`);
    await page.key('keyDown', 'Digit3', 51, '3');
    await sleep(120);
    await page.key('keyUp', 'Digit3', 51, '3');
    await sleep(200);
    const armed = await probe();
    check(`pressing 3 puts the rockets in your hands (weapon ${armed.weapon})`, armed.weapon === 2);
    await mouseCheck(page);
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
/**
 * The mouse, under a locked pointer.
 *
 * Yaw counts clockwise - raising it turns you right, which is what the camera
 * does with it - so moving the mouse right has to raise it. It did not, and a
 * touchpad user found out first: a control that is both backwards and worth four
 * degrees for two hundred pixels reads as a control that is not working.
 */
async function mouseCheck(page) {
  const look = async () => page.evaluate(
    '({ yaw: window.__state.bodies[0].yaw, pitch: window.__state.bodies[0].pitch })');
  const degrees = (units) => {
    let d = ((units % 65536) + 65536) % 65536;
    if (d > 32768) d -= 65536;
    return (d / 65536) * 360;
  };

  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type, x: 400, y: 300, button: 'left', clickCount: 1,
    });
  }
  await sleep(600);
  check('clicking the picture takes the pointer',
    await page.evaluate('document.pointerLockElement !== null'));

  const before = await look();
  await page.evaluate(`for (let i = 0; i < 10; i++) {
    window.dispatchEvent(new MouseEvent('mousemove', { movementX: 20, movementY: 0 }));
  } true`);
  await sleep(400);
  const turned = degrees((await look()).yaw - before.yaw);
  check(`the mouse to the right turns the view right (${turned.toFixed(0)} deg over 200 px)`,
    turned > 20 && turned < 50);

  const beforePitch = await look();
  await page.evaluate(`for (let i = 0; i < 6; i++) {
    window.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: 20 }));
  } true`);
  await sleep(400);
  const dipped = degrees((await look()).pitch - beforePitch.pitch);
  check(`and the mouse down looks down (${dipped.toFixed(0)} deg over 120 px)`, dipped < -8);
}

async function touchCheck(page) {
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  /** Load the game with a particular set of control settings already stored. */
  const withSettings = async (settings) => {
    await page.send('Page.navigate', { url: 'about:blank' });
    await sleep(200);
    await page.send('Page.navigate', { url: `${base}&nostart=1` });
    await sleep(400);
    await page.evaluate(`localStorage.setItem('webreal.controls.v1', ${JSON.stringify(
      JSON.stringify({ thumbs: 'on', ...settings }))}); true`);
    await page.send('Page.navigate', { url: base });
    return page.ready();
  };

  const size = () => page.evaluate('({ w: window.innerWidth, h: window.innerHeight })');
  const look = async () => page.evaluate(
    '({ yaw: window.__state.bodies[0].yaw, pitch: window.__state.bodies[0].pitch })');
  const degrees = (units) => {
    let d = ((units % 65536) + 65536) % 65536;
    if (d > 32768) d -= 65536;
    return (d / 65536) * 360;
  };

  /**
   * A thumb on the right half of the screen, dragged.
   *
   * Dispatched as real touch events, so it goes through the same pointer
   * handlers a phone does - and slowly, one step per frame or so: a drag sent
   * faster than the browser turns touches into pointer events arrives as a
   * single move, and then this measures one step instead of the whole swipe.
   */
  const drag = async (dx, dy) => {
    const { w, h } = await size();
    const x = w * 0.75;
    const y = h * 0.5;
    const point = (px, py) => [{ x: px, y: py, radiusX: 8, radiusY: 8, force: 1, id: 1 }];
    const before = await look();
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(x, y) });
    for (let i = 1; i <= 8; i++) {
      await page.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: point(x + (dx * i) / 8, y + (dy * i) / 8),
      });
      await sleep(40);
    }
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(250);
    const after = await look();
    return { yaw: degrees(after.yaw - before.yaw), pitch: degrees(after.pitch - before.pitch) };
  };

  // --- the way a phone is set up out of the box ---
  if (!await withSettings({ touchInvertX: false, touchInvertY: true, touchSensitivity: 1 })) {
    check('the page comes back with the thumbs on', false);
    return;
  }
  check('the thumb controls appear when the setting says so',
    await page.evaluate("!document.getElementById('touch').classList.contains('hidden')"));

  const normal = await drag(140, 0);
  check(`the thumb to the right turns the view right (${normal.yaw.toFixed(0)} deg over 140 px)`,
    normal.yaw > 35 && normal.yaw < 75);
  const down = await drag(0, 90);
  check(`the thumb down looks up, which is the inverted vertical (${down.pitch.toFixed(0)} deg over 90 px)`,
    down.pitch > 22 && down.pitch < 48);

  // --- and both axes flip when the menu says so ---
  if (!await withSettings({ touchInvertX: true, touchInvertY: false, touchSensitivity: 1 })) {
    check('the page comes back the other way round', false);
    return;
  }
  const flipped = await drag(140, 0);
  check(`inverted X: the thumb to the right turns left (${flipped.yaw.toFixed(0)} deg)`,
    flipped.yaw < -35 && flipped.yaw > -75);
  const flippedDown = await drag(0, 90);
  check(`normal Y: the thumb down looks down (${flippedDown.pitch.toFixed(0)} deg)`,
    flippedDown.pitch < -22);

  // --- and that the number in the menu is the number it uses ---
  if (!await withSettings({ touchInvertX: false, touchInvertY: true, touchSensitivity: 2 })) return;
  const fast = await drag(140, 0);
  const ratio = fast.yaw / Math.max(1, normal.yaw);
  check(`twice the sensitivity turns twice as far (${fast.yaw.toFixed(0)} deg, ${ratio.toFixed(2)}x)`,
    ratio > 1.7 && ratio < 2.3);
}

main().catch((err) => {
  console.error(`  ${err.message}`);
  console.error('  (this test needs `npm start` running in another terminal, and a Chrome)');
  process.exit(1);
});
