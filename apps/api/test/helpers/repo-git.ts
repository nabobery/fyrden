import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Oid, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { createIdFactory, secureRandomBytes } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { expect } from "vitest";
import type { RepoDO } from "../../src/do/RepoDO.js";

export const newNetworkId = (): string => createIdFactory(Date.now, secureRandomBytes)("net");

/** A 20-byte object id filled with `n`. */
export const oid = (n: number): Oid => new Uint8Array(20).fill(n) as Oid;

export const sleep = (ms: number) =>
  // biome-ignore lint/style/noRestrictedGlobals: the one place a test waits on time: `signal` polls a flag set from another request's context, where no promise of this one can be resolved; other uses need a reason of their own.
  new Promise((resolve) => setTimeout(resolve, ms));

type Outcome<R> = { ok: true; value: R } | { ok: false; name: string; message: string };

/**
 * Runs `fn` inside the repository object, as one request, and rethrows its
 * error here (returned as a value: an error thrown out of the object is also
 * reported by workerd as uncaught). Concurrent calls are concurrent requests.
 */
export async function inRepo<R>(
  stub: DurableObjectStub<RepoDO>,
  fn: (repo: RepoDO) => R | Promise<R>,
): Promise<R> {
  const outcome = await runInDurableObject(stub, async (repo: RepoDO): Promise<Outcome<R>> => {
    try {
      return { ok: true, value: await fn(repo) };
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      return { ok: false, name: e.name, message: e.message };
    }
  });
  if (outcome.ok) return outcome.value;
  const error = new Error(outcome.message);
  error.name = outcome.name;
  throw error;
}

/** A new repository object with git storage initialized in a new network. */
export async function newRepo(): Promise<{ stub: DurableObjectStub<RepoDO>; networkId: string }> {
  const stub = env.REPO.getByName(uniqueId("repo"));
  const networkId = newNetworkId();
  expect(await stub.initGitStorage(networkId)).toEqual({ ok: true });
  return { stub, networkId };
}

/**
 * A flag one request sets and another waits for. The tests' runner and each
 * Durable Object have their own I/O context, and a promise resolved from
 * another context continues in that context (where this object's bindings
 * and stubs cannot be used), so waiting polls with a timer instead.
 */
export function signal(): { open: () => void; wait: (timeoutMs?: number) => Promise<void> } {
  let opened = false;
  return {
    open: () => {
      opened = true;
    },
    // Generous: under a fully parallel run a step between open and wait can
    // take seconds; still below the test timeout, so a lost signal is reported as such.
    async wait(timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (!opened) {
        if (Date.now() > deadline) throw new Error("signal never opened");
        await sleep(2);
      }
    },
  };
}

/**
 * `bucket` with `head` paused until `release` opens: a deterministic pause
 * inside an R2 await. Locally the input gate stays closed across real R2
 * awaits, so tests must not count on R2 latency to interleave requests.
 */
export function pausingHead(
  bucket: R2Bucket,
  release: ReturnType<typeof signal>,
  entered: ReturnType<typeof signal>,
): Pick<R2Bucket, "head"> {
  return {
    async head(key) {
      entered.open();
      await release.wait();
      return bucket.head(key);
    },
  };
}

/**
 * An upload as the push path leaves it before its commit: pack bytes in R2,
 * pending commit rows, indexed. Commits are `[n, ...parents]`.
 */
export async function indexedUpload(
  git: RepoGitStorage,
  bucket: R2Bucket,
  principal: string,
  commits: readonly number[][],
  deps: readonly string[] = [],
) {
  const upload = git.uploads.begin({
    networkId: git.networkId(),
    principal,
    grantId: `grant-${principal}`,
    tokenId: `token-${principal}`,
    commands: [],
    atomic: true,
    withPack: true,
    ttlMs: 60 * 60 * 1000,
    leaseTtlMs: 10 * 60 * 1000,
  });
  const bytes = new TextEncoder().encode(`PACK from ${principal}`);
  await bucket.put(upload.r2Key as string, bytes);
  git.uploads.markUploaded(upload.uploadId, { bytes: bytes.length });
  await git.commitGraph.insertPending(
    upload.uploadId,
    commits.map(([n, ...parents]) => ({
      oid: oid(n as number),
      tree: oid(200 + (n as number)),
      parents: parents.map(oid),
      commitTime: 1_000 + (n as number),
      generation: 1_000 + (n as number),
      level: 1 + parents.length,
    })),
  );
  git.uploads.markIndexed(upload.uploadId, { deps: deps as never[], objectCount: commits.length });
  return upload;
}
