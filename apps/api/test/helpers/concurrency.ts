import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ConcurrencyDO } from "../../src/do/ConcurrencyDO.js";

export function inConcurrency<R>(
  repoId: string,
  fn: (coordinator: ConcurrencyDO) => R | Promise<R>,
): Promise<R> {
  return runInDurableObject(env.CONCURRENCY.getByName(repoId), fn);
}
