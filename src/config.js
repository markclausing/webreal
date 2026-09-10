/**
 * The one thing you have to fill in yourself.
 *
 * Playing against other people needs a server: two browsers cannot find each
 * other on their own. Everything else in this game runs off static files, and
 * this is the single line that changes that.
 *
 * It must be a relay of this game's own rather than websoccer's, webtennis's,
 * webracing's or webtrack's - not because the protocol differs, it does not, but
 * because a room in one game finding a room in another is four people sitting in
 * an arena waiting for somebody who is playing tennis. A relay of your own is
 * two commands. See worker/README.md.
 *
 * Leave it empty and the game still plays: the arenas, the bots and every mode
 * work with nothing behind them at all. Only the four-player half goes quiet.
 *
 *   export const DEFAULT_RELAY = 'https://webreal.your-name.workers.dev';
 */
export const DEFAULT_RELAY = 'https://webreal.vibecoach.workers.dev';

/**
 * Which relay this page should talk to. A `?relay=` in the address always wins,
 * so you can point a tab at a different one without editing anything. On
 * localhost the page assumes the server that served it, because that is what
 * `npm start` gives you.
 */
export function relayFor(location) {
  const override = new URLSearchParams(location.search || '').get('relay');
  if (override) return socketUrl(override);
  if (isLocal(location)) {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${location.host}`;
  }
  if (!DEFAULT_RELAY) return null;
  return socketUrl(DEFAULT_RELAY);
}

/** http:// and https:// are what a Worker prints; ws:// is what a socket wants. */
function socketUrl(address) {
  return address.replace(/\/+$/, '').replace(/^http/, 'ws');
}

/**
 * Are we being served by something on this machine? Read from the host rather
 * than only from hostname: they should agree, and quietly deciding a page is
 * remote because one field was missing would send a local test to the internet.
 */
function isLocal(location) {
  const name = location.hostname || String(location.host || '').split(':')[0];
  return /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(name);
}
