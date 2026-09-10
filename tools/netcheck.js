// Four browsers' worth of client, without any browsers.
//
//   node tools/netcheck.js
//
// It starts the relay, opens four WebSockets to it, and runs four copies of the
// same match - each one holding its own buttons and being told about everybody
// else's, exactly as four tabs would be. Then it asks the only question that
// matters about lockstep: after ten seconds of shooting, do all four agree about
// the state of the world down to the last bit?
//
// The client code under test is the real one. Signal takes its WebSocket
// implementation as an argument for precisely this reason, and Node has had one
// built in for a while now, so nothing here is a stub except the hands on the
// keyboard.

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Signal } from '../src/net/signal.js';
import { OnlineTransport } from '../src/net/transport.js';
import { createMatch, hashState } from '../src/game/state.js';
import { step } from '../src/game/sim.js';
import { BTN, PITCH_LIMIT, TICK_RATE, YAW_UNITS } from '../src/constants.js';

const PORT = Number(process.env.NETCHECK_PORT) || 5199;
const PLAYERS = 4;
const SECONDS = 10;
const SEED = 90210;

let failures = 0;
const fail = (what) => {
  console.error(`  ✗ ${what}`);
  failures++;
};

/**
 * A person, simulated: walks in circles, looks around, and shoots. Each seat
 * gets its own pattern, and the pattern is a pure function of the tick, so the
 * whole test is reproducible.
 */
function hands(seat) {
  let yaw = seat * 9000;
  let pitch = 0;
  let tick = 0;
  return {
    read() {
      tick++;
      const phase = tick + seat * 37;
      let b = BTN.FWD;
      if (phase % 120 < 40) b |= BTN.LEFT;
      else if (phase % 120 < 80) b |= BTN.RIGHT;
      if (phase % 47 === 0) b |= BTN.JUMP;
      if (phase % 13 < 5) b |= BTN.FIRE;
      yaw = (yaw + (seat + 1) * 47) & (YAW_UNITS - 1);
      pitch = Math.round(Math.sin(phase / 90) * PITCH_LIMIT * 0.4);
      return { b, yaw, pitch };
    },
  };
}

async function main() {
  const relay = spawn(process.execPath, ['server/relay.js'], {
    env: { ...process.env, PORT: String(PORT), QUIET: '1' },
    stdio: 'ignore',
  });
  await waitFor(() => fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.ok).catch(() => false),
    'the relay to start');

  try {
    const clients = [];
    // The first one opens the room; the rest join it, and the relay hands out
    // the seats. Nobody chooses their own.
    const host = await connect(0, 'create');
    clients.push(host);
    for (let i = 1; i < PLAYERS; i++) {
      clients.push(await connect(i, 'join', host.code));
    }
    await waitFor(() => host.seats.filter(Boolean).length === PLAYERS, 'everybody to sit down');
    console.log(`  room ${host.code}, ${PLAYERS} seats taken`);

    for (const client of clients) {
      client.state = createMatch({
        seed: SEED, map: 'foundry', mode: 'dm', bots: 2, humans: new Array(PLAYERS).fill(true),
      });
      client.transport = new OnlineTransport({
        signal: client.signal, input: hands(client.seat), seats: PLAYERS, localSeat: client.seat,
      });
    }

    // Run them all together, a tick at a time, letting the sockets breathe.
    const ticks = TICK_RATE * SECONDS;
    let stalls = 0;
    for (let t = 0; t < ticks; t++) {
      for (const client of clients) {
        client.transport.sample(client.state.tick);
      }
      await delay(0);
      let advanced = 0;
      for (const client of clients) {
        if (!client.transport.ready(client.state.tick)) continue;
        step(client.state, client.transport.poll(client.state.tick));
        client.transport.afterStep(client.state);
        advanced++;
      }
      if (advanced < clients.length) stalls++;
      if (t % 30 === 0) await delay(2);
    }
    // Let the last few packets land, and let everybody catch up.
    for (let i = 0; i < 400; i++) {
      await delay(2);
      let waiting = 0;
      for (const client of clients) {
        for (const other of clients) client.transport.sample(other.state.tick);
      }
      for (const client of clients) {
        while (client.state.tick < ticks && client.transport.ready(client.state.tick)) {
          step(client.state, client.transport.poll(client.state.tick));
          client.transport.afterStep(client.state);
        }
        if (client.state.tick < ticks) waiting++;
      }
      if (!waiting) break;
    }

    const ticksReached = clients.map((c) => c.state.tick);
    const hashes = clients.map((c) => hashState(c.state));
    console.log(`  ticks reached  ${ticksReached.join('  ')}`);
    console.log(`  state hash     ${hashes.map((h) => h.toString(16)).join('  ')}`);
    console.log(`  input delay    ${clients.map((c) => c.transport.delay).join('  ')}`);
    console.log(`  stalled on     ${stalls} of ${ticks} ticks`);

    if (new Set(ticksReached).size !== 1) fail('the four copies did not reach the same tick');
    if (new Set(hashes).size !== 1) fail('the four copies disagree about the state of the match');
    for (const client of clients) {
      if (client.transport.desync) fail(`seat ${client.seat} noticed a desync of its own`);
    }
    const frags = clients[0].state.bodies.reduce((a, b) => a + b.kills, 0);
    console.log(`  and ${frags} frags happened while nobody was watching`);

    for (const client of clients) client.transport.dispose();
  } finally {
    relay.kill();
  }

  if (failures) {
    console.error(`\n${failures} problem${failures === 1 ? '' : 's'} with the netcode.`);
    process.exit(1);
  }
  console.log('\nFour machines, one match.');
}

function connect(index, what, code) {
  return new Promise((resolve, reject) => {
    const signal = new Signal(`ws://127.0.0.1:${PORT}`, globalThis.WebSocket);
    const client = { signal, seat: -1, code: null, seats: [] };
    signal.on('open', () => {
      if (what === 'create') signal.create();
      else signal.join(code);
    });
    signal.on('room', (m) => {
      client.seat = m.seat;
      client.code = m.code;
      client.seats = m.seats;
      resolve(client);
    });
    signal.on('peer', (m) => { client.seats = m.seats; });
    signal.on('error', (m) => reject(new Error(m.msg || 'relay error')));
    setTimeout(() => reject(new Error(`seat ${index} never got into the room`)), 5000);
  });
}

async function waitFor(test, what) {
  for (let i = 0; i < 200; i++) {
    if (await test()) return;
    await delay(50);
  }
  throw new Error(`waited too long for ${what}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
