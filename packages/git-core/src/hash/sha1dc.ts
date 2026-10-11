/*
 * Ported from sha1collisiondetection (SHA-1DC) by Marc Stevens and Dan Shumow,
 * https://github.com/cr-marcstevens/sha1collisiondetection, lib/sha1.c at
 * commit a06f1adbe5522f3c939cd6a3f13d5ec7f4c1a988 (stable-v1.0.3-38-ga06f1ad):
 * sha1_compression_states (keeping the states before steps 58 and 65, as
 * ubc_check.h selects), sha1recompress_fast_58/65 and the collision check of
 * sha1_process, rewritten as loops over the 80 steps instead of the reference's
 * unrolled macros. The pure-Go port github.com/pjbgf/sha1cd was not used.
 * The original's copyright and licence notice follows.
 *
 * MIT License
 *
 * Copyright (c) 2017:
 *     Marc Stevens
 *     Cryptology Group
 *     Centrum Wiskunde & Informatica
 *     P.O. Box 94079, 1090 GB Amsterdam, Netherlands
 *     marc@marc-stevens.nl
 *
 *     Dan Shumow
 *     Microsoft Research
 *     danshu@microsoft.com
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { type DisturbanceVector, SHA1_DVS, ubcCheck } from "./ubc-check.js";

/*
 * How SHA-1DC works (Stevens and Shumow, "Speeding up detection of SHA-1
 * collision attacks using unavoidable attack conditions", USENIX Security
 * 2017): every known SHA-1 collision attack uses one of 32 disturbance
 * vectors (DVs), each fixing the XOR difference between the two colliding
 * message blocks. For each block, apply a DV's difference to the expanded
 * message and recompute the compression from an internal state at which the
 * attack path has no state difference (the state before step 58 or 65).
 * If the result reproduces the same output chaining value, this block is one
 * half of a collision. `ubcCheck` rules out most DVs cheaply first.
 */

const K1 = 0x5a827999;
const K2 = 0x6ed9eba1;
const K3 = 0x8f1bbcdc;
const K4 = 0xca62c1d6;

/** Words in the states record `compress` fills: the state before step 58, then before step 65. */
export const STATES_WORDS = 10;
const STATE_58 = 0;
const STATE_65 = 5;

/**
 * `sha1_compression_states`: the SHA-1 compression of the 64-byte block at
 * `data[offset]`, which adds into `h` and also leaves the expanded message
 * in `w` (80 words) and the states (a, b, c, d, e) before steps 58 and 65 in
 * `states` (`STATES_WORDS` words), for `detectCollision`.
 */
export function compress(
  h: Uint32Array,
  w: Int32Array,
  states: Int32Array,
  data: Uint8Array,
  offset: number,
): void {
  for (let i = 0; i < 16; i++) {
    const j = offset + i * 4;
    w[i] =
      ((data[j] as number) << 24) |
      ((data[j + 1] as number) << 16) |
      ((data[j + 2] as number) << 8) |
      (data[j + 3] as number);
  }
  for (let i = 16; i < 80; i++) {
    const x =
      (w[i - 3] as number) ^ (w[i - 8] as number) ^ (w[i - 14] as number) ^ (w[i - 16] as number);
    w[i] = (x << 1) | (x >>> 31);
  }
  let a = h[0] as number;
  let b = h[1] as number;
  let c = h[2] as number;
  let d = h[3] as number;
  let e = h[4] as number;
  let t: number;
  for (let i = 0; i < 20; i++) {
    t = (((a << 5) | (a >>> 27)) + (d ^ (b & (c ^ d))) + e + K1 + (w[i] as number)) | 0;
    e = d;
    d = c;
    c = (b << 30) | (b >>> 2);
    b = a;
    a = t;
  }
  for (let i = 20; i < 40; i++) {
    t = (((a << 5) | (a >>> 27)) + (b ^ c ^ d) + e + K2 + (w[i] as number)) | 0;
    e = d;
    d = c;
    c = (b << 30) | (b >>> 2);
    b = a;
    a = t;
  }
  for (let i = 40; i < 60; i++) {
    if (i === 58) saveState(states, STATE_58, a, b, c, d, e);
    t = (((a << 5) | (a >>> 27)) + ((b & c) | (d & (b ^ c))) + e + K3 + (w[i] as number)) | 0;
    e = d;
    d = c;
    c = (b << 30) | (b >>> 2);
    b = a;
    a = t;
  }
  for (let i = 60; i < 80; i++) {
    if (i === 65) saveState(states, STATE_65, a, b, c, d, e);
    t = (((a << 5) | (a >>> 27)) + (b ^ c ^ d) + e + K4 + (w[i] as number)) | 0;
    e = d;
    d = c;
    c = (b << 30) | (b >>> 2);
    b = a;
    a = t;
  }
  h[0] = (h[0] as number) + a;
  h[1] = (h[1] as number) + b;
  h[2] = (h[2] as number) + c;
  h[3] = (h[3] as number) + d;
  h[4] = (h[4] as number) + e;
}

function saveState(
  states: Int32Array,
  at: number,
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
): void {
  states[at] = a;
  states[at + 1] = b;
  states[at + 2] = c;
  states[at + 3] = d;
  states[at + 4] = e;
}

/** The SHA-1 round function and constant of step `i`. */
function f(i: number, b: number, c: number, d: number): number {
  if (i < 20) return d ^ (b & (c ^ d));
  if (i < 40 || i >= 60) return b ^ c ^ d;
  return (b & c) | (d & (b ^ c));
}

function k(i: number): number {
  return i < 20 ? K1 : i < 40 ? K2 : i < 60 ? K3 : K4;
}

/**
 * `sha1recompress_fast_t`: from the state before step `t` (58 or 65, taken
 * from a `compress` states record), runs the compression backwards over the
 * expanded message `me2` to the input chaining value `ihvIn`, and forwards
 * to the output chaining value `ihvOut`.
 */
export function recompress(
  t: number,
  me2: Int32Array,
  states: Int32Array,
  ihvIn: Int32Array,
  ihvOut: Int32Array,
): void {
  const at = t === 58 ? STATE_58 : t === 65 ? STATE_65 : -1;
  if (at < 0) throw new RangeError(`no saved SHA-1 state before step ${t}`);
  let a = states[at] as number;
  let b = states[at + 1] as number;
  let c = states[at + 2] as number;
  let d = states[at + 3] as number;
  let e = states[at + 4] as number;
  // Undo steps t-1 down to 0: (a, b, c, d, e) is the state after step i.
  for (let i = t - 1; i >= 0; i--) {
    const prevB = (c >>> 30) | (c << 2);
    const prevE =
      (a - (((b << 5) | (b >>> 27)) + f(i, prevB, d, e) + k(i) + (me2[i] as number))) | 0;
    a = b;
    b = prevB;
    c = d;
    d = e;
    e = prevE;
  }
  ihvIn[0] = a;
  ihvIn[1] = b;
  ihvIn[2] = c;
  ihvIn[3] = d;
  ihvIn[4] = e;
  a = states[at] as number;
  b = states[at + 1] as number;
  c = states[at + 2] as number;
  d = states[at + 3] as number;
  e = states[at + 4] as number;
  for (let i = t; i < 80; i++) {
    const next = (((a << 5) | (a >>> 27)) + f(i, b, c, d) + e + k(i) + (me2[i] as number)) | 0;
    e = d;
    d = c;
    c = (b << 30) | (b >>> 2);
    b = a;
    a = next;
  }
  ihvOut[0] = (ihvIn[0] as number) + a;
  ihvOut[1] = (ihvIn[1] as number) + b;
  ihvOut[2] = (ihvIn[2] as number) + c;
  ihvOut[3] = (ihvIn[3] as number) + d;
  ihvOut[4] = (ihvIn[4] as number) + e;
}

// Scratch space for `detectCollision`; it is synchronous, so one set is enough.
const me2 = new Int32Array(80);
const ihvIn = new Int32Array(5);
const ihvOut = new Int32Array(5);

/**
 * The collision check of `sha1_process`, for a block `compress` has just
 * processed: `ihv` is its output chaining value, `w` and `states` what
 * `compress` recorded. Returns the disturbance vector of the attack this
 * block is part of, or `undefined`. `useUbc: false` skips the unavoidable
 * bit-condition filter and recompresses for all 32 vectors, which only tests
 * use.
 *
 * Not ported: the reference's optional detection of reduced-round
 * collisions (off by default, and off in git) and its "safe hash", which
 * changes the digest of a detected collision (git turns it off; Fyrden
 * throws instead).
 */
export function detectCollision(
  ihv: Uint32Array,
  w: Int32Array,
  states: Int32Array,
  useUbc = true,
): DisturbanceVector | undefined {
  const mask = useUbc ? ubcCheck(w) : -1;
  if (mask === 0) return undefined;
  for (const dv of SHA1_DVS) {
    if ((mask & (1 << dv.maskb)) === 0) continue;
    for (let j = 0; j < 80; j++) me2[j] = (w[j] as number) ^ (dv.dm[j] as number);
    recompress(dv.testt, me2, states, ihvIn, ihvOut);
    if (
      (((ihvOut[0] as number) ^ (ihv[0] as number)) |
        ((ihvOut[1] as number) ^ (ihv[1] as number)) |
        ((ihvOut[2] as number) ^ (ihv[2] as number)) |
        ((ihvOut[3] as number) ^ (ihv[3] as number)) |
        ((ihvOut[4] as number) ^ (ihv[4] as number))) ===
      0
    ) {
      return dv;
    }
  }
  return undefined;
}
