/**
 * The mask sets a task can hold at its caps, generated the same way on every
 * run (a fixed seed), for the cache's retained-heap bench.
 */
import {
  checkSecretMasks,
  type LogMask,
  MASK_MAX_TEXT_BYTES,
  MASK_MAX_VALUES,
} from "../../../../packages/domain/src/ci/mask.ts";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function generator(seed: number): (n: number) => string {
  let state = seed;
  return (n) => {
    let out = "";
    for (let i = 0; i < n; i++) {
      state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
      out += ALPHABET.charAt(state % 62);
    }
    return out;
  };
}

/** Secrets of `length` chars, as many as the secret allowance takes. */
function secrets(random: (n: number) => string, length: number): LogMask[] {
  const values: string[] = [];
  for (;;) {
    const next = random(length);
    if (!checkSecretMasks(values, [{ name: "S", value: next }]).ok) break;
    values.push(next);
  }
  return values.map((value) => ({ value, fromIndex: 0, secret: true }));
}

/** `::add-mask::` values sharing a long prefix, as many as the caps take beside a token. */
function shared(random: (n: number) => string): LogMask[] {
  const masks: LogMask[] = [];
  let bytes = 0;
  while (masks.length < MASK_MAX_VALUES - 1) {
    const value = `build_cache_key_${random(24)}`;
    if (bytes + value.length > MASK_MAX_TEXT_BYTES - 64) break;
    bytes += value.length;
    masks.push({ value, fromIndex: 0 });
  }
  return masks;
}

export const SHAPES: Record<string, () => LogMask[]> = {
  // Small caches, where the fixed part dominates.
  "no masks": () => [],
  "one 2-char value": () => [{ value: "ab", fromIndex: 0 }],
  "token and three values of a later row": () => {
    const random = generator(5);
    return [
      { value: `fyrden_job_${random(40)}`, fromIndex: 0, reserved: true },
      ...Array.from({ length: 3 }, () => ({ value: random(12), fromIndex: 100 })),
    ];
  },
  "token and 1 KiB secrets": () => {
    const random = generator(1);
    return [
      { value: `fyrden_job_${random(40)}`, fromIndex: 0, reserved: true },
      ...secrets(random, 1024),
    ];
  },
  "token and 20-char secrets": () => {
    const random = generator(2);
    return [
      { value: `fyrden_job_${random(40)}`, fromIndex: 0, reserved: true },
      ...secrets(random, 20),
    ];
  },
  "token and shared-prefix values": () => {
    const random = generator(3);
    return [{ value: `fyrden_job_${random(40)}`, fromIndex: 0, reserved: true }, ...shared(random)];
  },
  // Masks of a later row than the call's (pending): their variants are kept, not in the tries.
  "200 short secrets of a later row": () =>
    Array.from({ length: 200 }, (_, i) => ({
      value: `${String.fromCharCode(0x100 + i)}%`,
      fromIndex: 100,
      secret: true,
    })),
  "255 short values of a later row": () =>
    Array.from({ length: 255 }, (_, i) => ({
      value: `${String.fromCharCode(0x100 + i)}%`,
      fromIndex: 100,
    })),
  "both allowances": () => {
    const random = generator(4);
    return [
      { value: `fyrden_job_${random(40)}`, fromIndex: 0, reserved: true },
      ...shared(random),
      ...secrets(random, 1024),
    ];
  },
};
