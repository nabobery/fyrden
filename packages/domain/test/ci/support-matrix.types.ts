// Checked by `tsc` (pnpm typecheck), not run: the parser's reader tables are
// declared `satisfies Record<SupportedKeysOf<Context>, Reader>`, which must
// fail to compile when a supported key has no reader and when a reader is
// given for a key that is not supported. Each `@ts-expect-error` below
// fails the typecheck if that stops being true.
import type { SupportedKeysOf } from "../../src/ci/support-matrix.js";

type Reader = () => void;
type ConcurrencyReaders = Record<SupportedKeysOf<"concurrency">, Reader>;

const read: Reader = () => {};

export const exact = { group: read, "cancel-in-progress": read } satisfies ConcurrencyReaders;

// @ts-expect-error: `cancel-in-progress` is supported and has no reader.
export const missingOne = { group: read } satisfies ConcurrencyReaders;

export const extraOne = {
  group: read,
  "cancel-in-progress": read,
  // @ts-expect-error: `queue` is not a supported key, so it may not have a reader.
  queue: read,
} satisfies ConcurrencyReaders;

// The keys under a context are exactly its direct supported children.
export const jobKeys: SupportedKeysOf<"jobs.<job_id>.steps[*]">[] = [
  "id",
  "if",
  "name",
  "uses",
  "run",
  "working-directory",
  "shell",
  "with",
  "env",
  "continue-on-error",
  "timeout-minutes",
];
// @ts-expect-error: `background` is unsupported, so not a supported step key.
export const background: SupportedKeysOf<"jobs.<job_id>.steps[*]"> = "background";

// Contexts that share one reader table in the parser have the same keys; the
// tables are checked against each (`satisfies A & B`), and these pin that the
// key sets agree in both directions.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const sharedContexts: [
  Same<SupportedKeysOf<"defaults">, SupportedKeysOf<"jobs.<job_id>.defaults">>,
  Same<SupportedKeysOf<"defaults.run">, SupportedKeysOf<"jobs.<job_id>.defaults.run">>,
  Same<SupportedKeysOf<"concurrency">, SupportedKeysOf<"jobs.<job_id>.concurrency">>,
  Same<
    SupportedKeysOf<"jobs.<job_id>.container.credentials">,
    SupportedKeysOf<"jobs.<job_id>.services.<service_id>.credentials">
  >,
] = [true, true, true, true];
