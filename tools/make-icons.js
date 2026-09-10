// Draws the app icons and writes them as PNGs.
//
//   node tools/make-icons.js
//
// Hand rolled rather than pulled from a library, the same way the other three
// games do it: a PNG is a header, one zlib stream of filtered scanlines and a
// trailer, and node has zlib built in. That keeps the project at zero
// dependencies, and the icons stay reproducible - run this again and you get the
// same bytes.
//
// The picture is what the game is: a dark room, a lit doorway at the end of it,
// and a crosshair over the middle. At thirty-two pixels there is room for
// exactly those three things, and nothing else about an arena shooter survives
// being made that small anyway.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const body = out.subarray(4, 8 + data.length);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** @param {Uint8Array} rgba length size*size*4 */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  // 10, 11, 12 stay zero: deflate, adaptive filtering, no interlacing

  // Each scanline is prefixed with its filter type; 0 means "store as is".
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const at = y * (size * 4 + 1);
    raw[at] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, at + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** '#58e6ff' -> [88, 230, 255]. */
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * The track, going away from you, under a sunset, with one car on it.
 *
 * Everything in here is a shape rather than a drawing: a band for the sky, a
 * disc for the sun, a triangle for the tarmac and a wide red slab with a wing on
 * it. At thirty-two pixels anything more careful is mud, and the three things
 * that survive being that small - the orange, the converging lines and the low
 * wide shape sitting between two black wheels - are exactly what the game is.
 */
function draw(size) {
  const px = new Uint8Array(size * size * 4);
  const set = (x, y, [r, g, b], a = 255) => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= size || iy >= size) return;
    const i = (iy * size + ix) * 4;
    const was = [px[i], px[i + 1], px[i + 2]];
    const now = a >= 255 ? [r, g, b] : mix(was, [r, g, b], a / 255);
    px[i] = now[0];
    px[i + 1] = now[1];
    px[i + 2] = now[2];
    px[i + 3] = 255;
  };

  const wall = rgb('#171a1f');
  const floor = rgb('#0d0f12');
  const lit = rgb('#3a3327');
  const door = rgb('#ffb347');
  const glow = rgb('#c07a24');
  const cross = rgb('#ffd166');

  const mid = size / 2;
  // The room, in perspective: floor below the middle, walls either side, and a
  // doorway at the vanishing point with the light coming out of it.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = Math.abs(y - mid) / mid;
      const base = y > mid ? mix(floor, lit, Math.max(0, 0.5 - t) * 0.5) : mix(wall, lit, Math.max(0, 0.5 - t) * 0.7);
      set(x, y, base);
    }
  }
  const doorW = size * 0.17;
  const doorH = size * 0.3;
  for (let y = mid - doorH; y <= mid + doorH * 0.55; y += 0.4) {
    for (let x = mid - doorW; x <= mid + doorW; x += 0.4) {
      const fade = 1 - Math.abs(y - mid) / (doorH * 1.3);
      set(x, y, mix(glow, door, Math.max(0, fade)));
    }
  }
  // The two lines of the floor running to it, which is the whole of the
  // perspective.
  for (let i = 0; i < size; i += 0.5) {
    const t = i / size;
    const spread = size * 0.5 * t;
    set(mid - doorW - spread, mid + doorH * 0.55 + spread * 0.9, mix(floor, door, 0.35 * (1 - t)));
    set(mid + doorW + spread, mid + doorH * 0.55 + spread * 0.9, mix(floor, door, 0.35 * (1 - t)));
  }

  // The crosshair, dead centre, with a hole in the middle of it.
  const gap = Math.max(1.5, size * 0.055);
  const arm = Math.max(2.5, size * 0.11);
  const thick = Math.max(1, size * 0.026);
  for (let d = gap; d <= gap + arm; d += 0.4) {
    for (let w = -thick / 2; w <= thick / 2; w += 0.4) {
      set(mid + d, mid + w, cross);
      set(mid - d, mid + w, cross);
      set(mid + w, mid + d, cross);
      set(mid + w, mid - d, cross);
    }
  }

  return px;
}

mkdirSync(path.join(ROOT, 'icons'), { recursive: true });
for (const size of [32, 180, 192, 512]) {
  const file = path.join('icons', `icon-${size}.png`);
  writeFileSync(path.join(ROOT, file), encodePng(size, draw(size)));
  console.log(`wrote ${file}`);
}
