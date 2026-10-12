import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createIdFactory, secureRandomBytes } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import type { GitStoreProbeDO } from "./probe-do.js";

export const newNetworkId = (): string => createIdFactory(Date.now, secureRandomBytes)("net");

type Outcome<R> = { ok: true; value: R } | { ok: false; name: string; message: string };

/**
 * Runs `fn` inside the probe object and rethrows its error here. The error
 * crosses as a value: one thrown out of the object would also be reported
 * by workerd as uncaught.
 */
export async function inProbe<R>(
  stub: DurableObjectStub<GitStoreProbeDO>,
  fn: (probe: GitStoreProbeDO) => R | Promise<R>,
): Promise<R> {
  const outcome = await runInDurableObject(
    stub,
    async (probe: GitStoreProbeDO): Promise<Outcome<R>> => {
      try {
        return { ok: true, value: await fn(probe) };
      } catch (error) {
        const e = error instanceof Error ? error : new Error(String(error));
        return { ok: false, name: e.name, message: e.message };
      }
    },
  );
  if (outcome.ok) return outcome.value;
  const ErrorClass =
    outcome.name === "RangeError" ? RangeError : outcome.name === "TypeError" ? TypeError : Error;
  const error = new ErrorClass(outcome.message);
  if (ErrorClass === Error) error.name = outcome.name;
  throw error;
}

/** A fresh probe object with initialized git storage. */
export async function newProbe(): Promise<{
  stub: DurableObjectStub<GitStoreProbeDO>;
  networkId: string;
}> {
  const stub = env.GIT_STORE_PROBE.getByName(uniqueId("git"));
  const networkId = newNetworkId();
  await inProbe(stub, (probe) => probe.git.initialize(networkId));
  return { stub, networkId };
}
