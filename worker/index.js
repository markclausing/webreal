/**
 * The relay, as a Cloudflare Worker.
 *
 * One deployment does the only job the game cannot do from static files: it puts
 * two to four browsers in the same room and passes their buttons along. It
 * speaks exactly the protocol server/relay.js speaks, so the browser cannot tell
 * the difference and neither can tools/netcheck.js.
 *
 * It never sees a position, a score or a hit. Every machine runs the whole
 * simulation and only inputs cross the wire, so there is nothing here that could
 * decide who got shot even if it wanted to. The one thing it does decide is
 * which seat a message came from, and it stamps that on rather than trusting the
 * sender: a client that could name its own seat could aim somebody else's rifle.
 *
 * Everything lives in a single Durable Object, because a Worker on its own is
 * stateless and cannot hold four sockets together, and one object for the whole
 * game is plenty - this is an arena shooter for friends, not a service.
 *
 * See README.md next door for the two commands that put it live.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const SEATS = 4;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export class Arena {
  constructor(state, env = {}) {
    this.state = state;
    this.env = env;
    /** @type {Map<string, {seats: Array<object|null>}>} */
    this.rooms = new Map();
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') === 'websocket') return this.open();
    return new Response(
      'WebReal relay. Point the game at this address with ?relay=wss://…, or set it as DEFAULT_RELAY in src/config.js.',
      { headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } },
    );
  }

  // --- Putting players in a room --------------------------------------------

  open() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const conn = { socket: server, room: null, seat: -1 };
    server.addEventListener('message', (ev) => {
      this.receive(conn, typeof ev.data === 'string' ? ev.data : '');
    });
    server.addEventListener('close', () => this.leave(conn));
    server.addEventListener('error', () => this.leave(conn));

    return new Response(null, { status: 101, webSocket: client });
  }

  code() {
    let code;
    do {
      code = '';
      for (let i = 0; i < 4; i++) {
        code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
      }
    } while (this.rooms.has(code));
    return code;
  }

  static send(conn, obj) {
    try {
      conn.socket.send(JSON.stringify(obj));
    } catch { /* the socket has gone; the close handler will tidy up */ }
  }

  static roster(room) {
    return room.seats.map((c) => !!c);
  }

  others(conn) {
    const room = conn.room && this.rooms.get(conn.room);
    if (!room) return [];
    return room.seats.filter((c) => c && c !== conn);
  }

  leave(conn) {
    if (!conn.room) return;
    const room = this.rooms.get(conn.room);
    if (!room) return;
    const { seat } = conn;
    if (seat >= 0 && room.seats[seat] === conn) room.seats[seat] = null;

    const left = room.seats.filter(Boolean);
    if (left.length) {
      // The match carries on without them: their body is handed nothing but
      // zeroes from here on, identically on every machine, so three people do
      // not lose their game because a fourth closed the tab.
      for (const other of left) {
        Arena.send(other, { t: 'peerleft', seat, seats: Arena.roster(room) });
      }
    } else {
      this.rooms.delete(conn.room);
    }
    conn.room = null;
    conn.seat = -1;
  }

  receive(conn, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.t) {
      case 'create': {
        this.leave(conn);
        const code = this.code();
        const room = { seats: new Array(SEATS).fill(null) };
        room.seats[0] = conn;
        this.rooms.set(code, room);
        conn.room = code;
        conn.seat = 0;
        Arena.send(conn, {
          t: 'room', code, role: 'host', seat: 0, seats: Arena.roster(room),
        });
        break;
      }

      case 'join': {
        const code = String(msg.code || '').toUpperCase().trim();
        const room = this.rooms.get(code);
        if (!room) {
          Arena.send(conn, { t: 'error', msg: `Room ${code} does not exist` });
          return;
        }
        const seat = room.seats.indexOf(null);
        if (seat < 0) {
          Arena.send(conn, { t: 'error', msg: `Room ${code} is full` });
          return;
        }
        this.leave(conn);
        room.seats[seat] = conn;
        conn.room = code;
        conn.seat = seat;
        Arena.send(conn, {
          t: 'room', code, role: 'guest', seat, seats: Arena.roster(room),
        });
        // Everybody is told who is in the room now, including the new arrival:
        // the menu shows four slots filling up, and whoever opened it decides
        // when there are enough of them.
        for (const other of room.seats.filter(Boolean)) {
          Arena.send(other, { t: 'peer', seats: Arena.roster(room), seat });
        }
        break;
      }

      default: {
        // Input, start, hashes, pings: passed on untouched, except for the seat
        // they came from.
        for (const other of this.others(conn)) Arena.send(other, { ...msg, seat: conn.seat });
        break;
      }
    }
  }
}

export default {
  fetch(request, env) {
    // Everything goes to the one object. Rooms have to share it to find each
    // other, and four sockets are not worth sharding.
    const id = env.ARENA.idFromName('global');
    return env.ARENA.get(id).fetch(request);
  },
};
