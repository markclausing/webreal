# The relay

Two commands put it live:

```bash
npx wrangler login
npx wrangler deploy
```

That is the whole deployment. It prints an address like
`https://webreal.your-name.workers.dev`; put it in `src/config.js` as
`DEFAULT_RELAY` and the hosted game will use it. A `?relay=wss://…` in the
address bar always wins over that, which is how you point one tab at a different
one without editing anything.

## What it does, and what it deliberately does not

It puts two to four browsers in a room and passes their buttons along. That is
all. It never sees a position, a score, a hit or a name: every machine runs the
whole simulation and only inputs cross the wire, so there is nothing on this
server that could decide who got shot even if somebody wanted it to.

The one thing it decides is which seat a message came from. That is stamped on
rather than trusted, because a client that could name its own seat could aim
somebody else's rifle.

## Why a Durable Object

A Worker on its own is stateless: two requests do not necessarily reach the same
instance, so a Worker cannot hold two sockets in the same room. A Durable Object
is one instance with one address, which is exactly what a room needs. Everything
runs in a single object called `global` — four sockets are not worth sharding,
and rooms have to be able to find each other.

It stores nothing. A room exists while its sockets are open and is forgotten when
the last one closes, so there is no storage to pay for, no data to leak and
nothing to clear out.

## Running it locally instead

`npm start` in the project root does the same job — it serves the files and
relays between tabs, in about two hundred lines and with no dependencies. The
Worker exists so that the version on GitHub Pages has something to talk to; the
protocol is identical, and `npm run test:net` is pointed at the local one.

## Costs

On the free plan: nothing, unless a great many people play it at once. A match
between four people is a few kilobytes a second of very small JSON messages, and
the object sleeps as soon as the last socket closes.
