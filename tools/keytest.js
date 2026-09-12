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
// It has already caught four things that were invisible from reading the code:
// the strafe buttons swapped, the mouse turning the wrong way and by almost
// nothing, a drag gesture the browser was cancelling halfway, and a pointer lock
// asked for one gesture too late.
//
// Each section opens its own page and closes it again. Driving one page through
// six states left pointer locks, touch emulation and a previous match's globals
// lying around, and the failures that produced had nothing to do with the game.

import { launch, open, sleep } from './browser.js';

const PORT = Number(process.env.PORT) || 5173;
const SITE = `http://localhost:${PORT}/`;
const PLAY = `${SITE}?play=foundry&mode=dm&bots=1&ticks=200&sound=0`;

let failures = 0;
const check = (what, ok) => {
  console.log(`  ${ok ? ' ' : '✗'} ${what}`);
  if (!ok) failures++;
};

const KEYS = {
  w: ['KeyW', 87, 'w'],
  a: ['KeyA', 65, 'a'],
  s: ['KeyS', 83, 's'],
  d: ['KeyD', 68, 'd'],
  space: ['Space', 32, ' '],
  three: ['Digit3', 51, '3'],
};

const degrees = (units) => {
  let d = ((units % 65536) + 65536) % 65536;
  if (d > 32768) d -= 65536;
  return (d / 65536) * 360;
};

const touchPoint = (x, y) => [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }];

/** A page with a match already running on it, and the things worth doing to one. */
async function match(url = PLAY, { touch = false } = {}) {
  const page = await open(url);
  if (touch) {
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  page.look = async () => page.evaluate(`(() => {
    const b = window.__state.bodies[0];
    return { x: b.x, y: b.y, z: b.z, yaw: b.yaw, pitch: b.pitch, ground: b.onGround, weapon: b.weapon };
  })()`);
  page.hold = async (name, ms) => {
    const [code, vk, key] = KEYS[name];
    await page.key('keyDown', code, vk, key);
    await sleep(ms);
    await page.key('keyUp', code, vk, key);
    await sleep(140);
  };
  /**
   * Stand somewhere with room in every direction.
   *
   * Without this a check measures wherever the spawn happened to put the body,
   * and a strafe into a wall is nought metres of strafe - which reads exactly
   * like a strafe button that does nothing. The Foundry's north strip is forty
   * metres of clear floor.
   */
  page.place = async (x, z, yaw) => page.evaluate(`(() => {
    const b = window.__state.bodies[0];
    b.x = ${x}; b.y = 0.2; b.z = ${z};
    b.vx = 0; b.vy = 0; b.vz = 0; b.yaw = ${yaw}; b.pitch = 0;
    b.alive = true; b.health = 100;
    return true;
  })()`);
  page.mouse = async (dx, dy, steps = 10) => page.evaluate(`(() => {
    for (let i = 0; i < ${steps}; i++) {
      window.dispatchEvent(new MouseEvent('mousemove', { movementX: ${dx}, movementY: ${dy} }));
    }
    return true;
  })()`);
  page.click = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
  };
  page.tap = async (x, y) => {
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touchPoint(x, y) });
    await sleep(60);
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  /** A thumb dragged slowly: dispatched faster than the browser turns touches
   *  into pointer events, a whole swipe arrives as a single move. */
  page.drag = async (dx, dy) => {
    const size = await page.evaluate('({ w: window.innerWidth, h: window.innerHeight })');
    const x = size.w * 0.75;
    const y = size.h * 0.5;
    const before = await page.look();
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touchPoint(x, y) });
    for (let i = 1; i <= 8; i++) {
      await page.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: touchPoint(x + (dx * i) / 8, y + (dy * i) / 8),
      });
      await sleep(40);
    }
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(250);
    const after = await page.look();
    return { yaw: degrees(after.yaw - before.yaw), pitch: degrees(after.pitch - before.pitch) };
  };
  page.locked = async () => page.evaluate('document.pointerLockElement !== null');
  page.thumbs = async () => page.evaluate(
    "!document.getElementById('touch').classList.contains('hidden')");
  return page;
}

/** Where a button is, once it is really there and not still coming up. */
async function buttonAt(page, id) {
  for (let i = 0; i < 120; i++) {
    const box = await page.evaluate(`(() => {
      const el = document.getElementById('${id}');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width < 10 ? null : { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (box) return box;
    await sleep(500);
  }
  return null;
}

async function started(page, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await page.evaluate('!!window.__state')) return true;
    await sleep(500);
  }
  return false;
}

// --- the way a person starts a match ------------------------------------------

/**
 * Open the page, press FIGHT.
 *
 * Every other section uses ?play=, which skips the menu - and skipping the menu
 * skipped the one thing that was broken. Pointer lock needs a user gesture in
 * the task that asks for it; begin() asked for it two animation frames and a
 * light bake later, the browser refused, and the only symptom was a mouse that
 * did nothing whatsoever.
 */
async function menuCheck() {
  const page = await match(SITE);
  try {
    const box = await buttonAt(page, 'start');
    if (!box) return check('the menu comes up', false);
    await page.click(box.x, box.y);
    if (!await started(page)) return check('pressing FIGHT starts a match', false);
    await sleep(1200);
    check('pressing FIGHT starts a match', true);
    check('and takes the pointer with it, because the click was a mouse', await page.locked());

    const before = await page.look();
    await page.mouse(20, 0);
    await sleep(400);
    const turned = degrees((await page.look()).yaw - before.yaw);
    check(`so the mouse works without clicking anything else (${turned.toFixed(0)} deg)`,
      turned > 10);
    return undefined;
  } finally {
    await page.close();
  }
}

// --- the keyboard ---------------------------------------------------------------

async function movementCheck() {
  const page = await match();
  try {
    if (!await page.ready()) return check('the arena builds', false);
    // Nobody else in it. A bot killing the player halfway through resets the
    // weapons it had just been given, which reads as a weapon key that does not
    // work.
    await page.evaluate(`(() => {
      for (const b of window.__state.bodies.slice(1)) { b.alive = false; b.respawnIn = 1e9; }
      return true;
    })()`);

    await page.place(-18, 14, 0);
    await sleep(250);
    const start = await page.look();
    await page.hold('w', 800);
    const forward = await page.look();
    const wentForward = Math.hypot(forward.x - start.x, forward.z - start.z);
    // A low bar on purpose: how far anything gets in eight hundred milliseconds
    // depends on how fast the browser is drawing, and under a software renderer
    // that is not a number worth asserting on. Only that it went, and that back
    // goes the other way.
    check(`holding forward covers ground (${wentForward.toFixed(1)} m in 0.8 s)`, wentForward > 1.2);

    await page.hold('s', 800);
    const back = await page.look();
    const wentBack = Math.hypot(back.x - forward.x, back.z - forward.z);
    const along = ((forward.x - start.x) * (back.x - forward.x)
      + (forward.z - start.z) * (back.z - forward.z)) / Math.max(0.01, wentForward * wentBack);
    check(`and holding back goes the other way (${(Math.acos(Math.max(-1, Math.min(1, along))) * 57.3).toFixed(0)} deg from the way out)`,
      along < -0.8);

    // Sideways, which had better be sideways. These were swapped for a week, and
    // the reason nothing caught it is that this check used to be written from
    // the same idea the simulation had rather than from the camera. Right is
    // forward crossed with up - (-sin yaw, cos yaw) - and that is the direction
    // the renderer puts on the right of the screen.
    const rightOf = (from, to, yawUnits) => {
      const yaw = (yawUnits / 65536) * Math.PI * 2;
      return (to.x - from.x) * -Math.sin(yaw) + (to.z - from.z) * Math.cos(yaw);
    };
    await page.place(0, 14, 16384);
    await sleep(250);
    const beforeRight = await page.look();
    await page.hold('d', 600);
    check(`strafing right goes right (${rightOf(beforeRight, await page.look(), beforeRight.yaw).toFixed(1)} m along it)`,
      rightOf(beforeRight, await page.look(), beforeRight.yaw) > 1.5);

    await page.place(0, 14, 16384);
    await sleep(250);
    const beforeLeft = await page.look();
    await page.hold('a', 600);
    check(`and strafing left goes left (${rightOf(beforeLeft, await page.look(), beforeLeft.yaw).toFixed(1)} m along it)`,
      rightOf(beforeLeft, await page.look(), beforeLeft.yaw) < -1.5);

    await page.place(0, 14, 0);
    await sleep(300);
    const beforeJump = await page.look();
    await page.key('keyDown', ...KEYS.space);
    await sleep(170);
    const mid = await page.look();
    await page.key('keyUp', ...KEYS.space);
    check(`jumping leaves the floor (${(mid.y - beforeJump.y).toFixed(2)} m up)`,
      mid.y > beforeJump.y + 0.2 && !mid.ground);
    await sleep(800);

    // The weapon keys, which go through a different path again.
    let armed = null;
    for (let attempt = 0; attempt < 3 && (!armed || armed.weapon !== 2); attempt++) {
      await page.evaluate(`(() => {
        const b = window.__state.bodies[0];
        b.alive = true; b.health = 100; b.have[2] = true; b.ammo[2] = 5;
        return true;
      })()`);
      await page.hold('three', 150);
      await sleep(200);
      armed = await page.look();
    }
    check(`pressing 3 puts the rockets in your hands (weapon ${armed.weapon})`, armed.weapon === 2);
    return undefined;
  } finally {
    await page.close();
  }
}

// --- the mouse ------------------------------------------------------------------

/**
 * Yaw counts clockwise - raising it turns you right, which is what the camera
 * does with it - so moving the mouse right has to raise it. It did not, and a
 * touchpad user found out first: a control that is both backwards and worth four
 * degrees for two hundred pixels reads as a control that is not working.
 */
async function mouseCheck() {
  const page = await match();
  try {
    if (!await page.ready()) return check('the arena builds', false);
    await page.click(400, 300);
    await sleep(600);
    check('clicking the picture takes the pointer', await page.locked());

    const before = await page.look();
    await page.mouse(20, 0);
    await sleep(400);
    const turned = degrees((await page.look()).yaw - before.yaw);
    check(`the mouse to the right turns the view right (${turned.toFixed(0)} deg over 200 px)`,
      turned > 20 && turned < 50);

    const beforePitch = await page.look();
    await page.mouse(0, 20, 6);
    await sleep(400);
    const dipped = degrees((await page.look()).pitch - beforePitch.pitch);
    check(`and the mouse down looks down (${dipped.toFixed(0)} deg over 120 px)`, dipped < -8);
    return undefined;
  } finally {
    await page.close();
  }
}

// --- the thumbs -----------------------------------------------------------------

/** A match with particular control settings already stored. */
async function withSettings(settings) {
  const page = await match(`${SITE}?nostart=1`, { touch: true });
  await page.evaluate(`localStorage.setItem('webreal.controls.v1', ${JSON.stringify(
    JSON.stringify(settings))}); true`);
  await page.close();
  // ?touch=1 pins the thumb controls up. Ordinarily they appear because
  // somebody touched the screen, and dispatching a touch to make the controls
  // appear so that a touch can be dispatched at them is a circle.
  const playing = await match(`${PLAY}&touch=1`, { touch: true });
  return playing;
}

async function touchCheck() {
  let page = await withSettings({ touchInvertX: false, touchInvertY: true, touchSensitivity: 1 });
  let normal;
  try {
    if (!await page.ready()) return check('the arena builds with the thumbs on', false);
    check('the thumb controls are up', await page.thumbs());

    normal = await page.drag(140, 0);
    check(`the thumb to the right turns the view right (${normal.yaw.toFixed(0)} deg over 140 px)`,
      normal.yaw > 35 && normal.yaw < 75);
    const down = await page.drag(0, 90);
    check(`the thumb down looks up, which is the inverted vertical (${down.pitch.toFixed(0)} deg over 90 px)`,
      down.pitch > 22 && down.pitch < 48);
  } finally {
    await page.close();
  }

  page = await withSettings({ touchInvertX: true, touchInvertY: false, touchSensitivity: 1 });
  try {
    if (!await page.ready()) return check('the arena builds the other way round', false);
    const flipped = await page.drag(140, 0);
    check(`inverted X: the thumb to the right turns left (${flipped.yaw.toFixed(0)} deg)`,
      flipped.yaw < -35 && flipped.yaw > -75);
    const flippedDown = await page.drag(0, 90);
    check(`normal Y: the thumb down looks down (${flippedDown.pitch.toFixed(0)} deg)`,
      flippedDown.pitch < -22);
  } finally {
    await page.close();
  }

  page = await withSettings({ touchInvertX: false, touchInvertY: true, touchSensitivity: 2 });
  try {
    if (!await page.ready()) return check('the arena builds at twice the sensitivity', false);
    const fast = await page.drag(140, 0);
    const ratio = fast.yaw / Math.max(1, normal.yaw);
    check(`twice the sensitivity turns twice as far (${fast.yaw.toFixed(0)} deg, ${ratio.toFixed(2)}x)`,
      ratio > 1.7 && ratio < 2.3);
    return undefined;
  } finally {
    await page.close();
  }
}

// --- a machine with both --------------------------------------------------------

/**
 * There used to be a setting for this, with three positions, and it was the
 * wrong shape of answer: a touchscreen laptop answers one thing and its owner
 * does another. Whatever was last pressed decides instead, so the only way to
 * check it is to press both, one after the other, and watch the game follow.
 */
async function switchCheck() {
  const page = await match(SITE, { touch: true });
  try {
    const box = await buttonAt(page, 'start');
    if (!box) return check('the menu comes up', false);

    await page.tap(box.x, box.y);
    if (!await started(page, 20)) {
      // A synthetic touch is not always turned into a click, and whether it is
      // is the browser's business rather than this game's. The tap has already
      // done the part that matters - it said a finger is in use - so the button
      // is pressed from script and the check carries on.
      await page.evaluate("document.getElementById('start').click(); true");
      if (!await started(page)) return check('a match starts after a finger has been used', false);
    }
    await sleep(1200);
    check('a match starts after a finger has been used', true);
    check('and puts the thumb controls up', await page.thumbs());
    check('and leaves the pointer alone', !await page.locked());

    await page.click(600, 400);
    await sleep(900);
    check('pressing a mouse puts them away', !await page.thumbs());
    check('and takes the pointer instead', await page.locked());

    await page.tap(300, 400);
    await sleep(900);
    check('touching the screen again brings them back', await page.thumbs());
    check('and gives the pointer back', !await page.locked());
    return undefined;
  } finally {
    await page.close();
  }
}

async function main() {
  const chrome = await launch();
  try {
    await menuCheck();
    await movementCheck();
    await mouseCheck();
    await touchCheck();
    await switchCheck();
  } finally {
    chrome.kill();
  }

  if (failures) {
    console.error(`\n${failures} of the controls do not work.`);
    process.exit(1);
  }
  console.log('\nThe controls reach the simulation.');
}

main().catch((err) => {
  console.error(`  ${err.message}`);
  console.error('  (this test needs `npm start` running in another terminal, and a Chrome)');
  process.exit(1);
});
