// Server-side import: `imports.create` checks the source URL with the
// shared outbound guard and starts the import in the repository object,
// whose alarm fetches (smart HTTP, protocol v2), indexes and commits it as
// a push. The source here replays git's own upload-pack answers, recorded
// by test/setup/chunked-import-fixtures.ts; workerd cannot reach a local
// git server.
import {
  createExecutionContext,
  runDurableObjectAlarm,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { checkOutboundUrl, type Resolver } from "@fyrden/adapters-cloudflare/net";
import {
  type ClientResponse,
  encodePktLine,
  encodeSideband,
  type HttpTransport,
  oidToHex,
  SIDEBAND_DATA,
  SIDEBAND_PROGRESS,
} from "@fyrden/git-core";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { CHUNKED_TUNING_DEFAULTS } from "../src/git/chunked/tuning.js";
import type { ImportNetwork } from "../src/git/import/network.js";
import { guardedTransport } from "../src/git/import/network.js";
import type { WatchClock } from "../src/git/import/watch.js";
import { RepoPush } from "../src/git/push/repo-push.js";
import { api } from "./helpers/api.js";
import type { RecordedExchange } from "./helpers/chunked-fixtures.js";
import { ORIGIN } from "./helpers/git-http.js";
import { fromHex } from "./helpers/git-oracle.js";
import { type PushTarget, pushTarget } from "./helpers/push.js";
import { inRepo } from "./helpers/repo-git.js";

const cx = inject("chunkedFixtures");
/** A public address literal: the guard needs no name lookup for it. */
const SOURCE = "https://93.184.215.14/source.git";
const OWN = { FYRDEN_OWN_HOSTS: "fyrden.test, api.fyrden.test" };

afterEach(() => {
  vi.useRealTimers();
});

async function call(target: PushTarget, method: string, body?: unknown, vars = OWN) {
  const [, owner, repo] = target.path.split("/");
  const ctx = createExecutionContext();
  const response = await createApp().fetch(
    new Request(`${ORIGIN}/api/repos/${owner}/${(repo as string).replace(/\.git$/, "")}/import`, {
      method,
      headers: {
        Authorization: `Bearer ${target.owner.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...env, ...vars },
    ctx,
  );
  // biome-ignore lint/suspicious/noExplicitAny: test assertions over JSON
  const json: any = await response.json();
  await waitOnExecutionContext(ctx);
  return { status: response.status, json, requestId: response.headers.get("X-Request-Id") };
}

const decoder = new TextDecoder();

/**
 * A source that answers with the recorded exchange, in order, after the
 * same URL check the guarded transport makes; requests must match the
 * recorded ones byte for byte.
 */
function replay(exchanges: readonly RecordedExchange[], seen: string[]): ImportNetwork {
  const resolve: Resolver = async () => ["93.184.215.14"];
  return {
    resolver: () => resolve,
    transport: (policy): HttpTransport => {
      let next = 0;
      return async (request) => {
        const check = await checkOutboundUrl(request.url, policy);
        if (!check.ok) throw new Error(`guard refused ${request.url}: ${check.reason}`);
        seen.push(`${request.method} ${request.url}`);
        const exchange = exchanges[next++];
        if (!exchange || exchange.method !== request.method)
          throw new Error(`unexpected ${request.method} ${request.url}`);
        expect(decoder.decode(request.body ?? new Uint8Array())).toBe(
          decoder.decode(fromHex(exchange.request)),
        );
        const body = fromHex(exchange.response);
        return {
          status: 200,
          contentType:
            request.method === "GET"
              ? "application/x-git-upload-pack-advertisement"
              : "application/x-git-upload-pack-result",
          body: (async function* () {
            for (let at = 0; at < body.length; at += 4096) yield body.subarray(at, at + 4096);
          })(),
          cancel: async () => {},
        };
      };
    },
  };
}

function useNetwork(target: PushTarget, network: ImportNetwork) {
  return inRepo(target.repo.stub, (repo) => {
    repo.importNetwork = network;
  });
}

/** Runs the object's alarm until the import is over, moving the clock past each retry delay. */
async function untilImported(target: PushTarget) {
  let now = Date.now();
  for (let i = 0; i < 60; i++) {
    await runDurableObjectAlarm(target.repo.stub);
    const record = await target.repo.stub.importRecord();
    if (record?.state === "committed" || record?.state === "failed") return record;
    now += 2_000;
    vi.setSystemTime(now);
  }
  const stuck = await target.repo.stub.importRecord();
  const memory = await inRepo(target.repo.stub, ({ git }) => git.memory.stats());
  throw new Error(
    `the import never finished: ${stuck?.state}, ${stuck?.bytes} bytes; memory ${JSON.stringify(memory)}`,
  );
}

async function repoState(target: PushTarget) {
  return inRepo(target.repo.stub, async ({ git }) => {
    const snapshot = git.refStore.readRefsSync();
    const scratch = await env.GIT.list({ prefix: `net/${git.networkId()}/scratch/` });
    return {
      refs: Object.fromEntries([...snapshot.refs].map(([n, oid]) => [n, oidToHex(oid)])),
      head: snapshot.head,
      scratch: scratch.objects.length,
    };
  });
}

describe("server-side import", () => {
  it("imports every branch and tag in one commit, skipping a name that is not UTF-8", async () => {
    const target = await pushTarget();
    const seen: string[] = [];
    await useNetwork(target, replay(cx.source.exchanges, seen));
    const started = await call(target, "POST", { url: `${SOURCE}/` });
    expect(started.status).toBe(201);
    expect(started.json).toMatchObject({ state: "fetching", source_url: SOURCE });

    const record = await untilImported(target);
    expect(record.error).toBeUndefined();
    expect(Object.keys(cx.source.refs).sort()).toEqual([
      "refs/heads/feature",
      "refs/heads/trunk",
      "refs/tags/v1.0",
    ]);
    const status = await call(target, "GET");
    expect(status.json).toMatchObject({
      state: "committed",
      refs_imported: Object.keys(cx.source.refs).sort(),
      refs_skipped: [{ ref: "refs/heads/caf\\xe9", reason: "ref name must be valid UTF-8" }],
      default_branch: cx.source.head,
    });
    expect(status.json.bytes_received).toBeGreaterThan(0);
    expect(await repoState(target)).toEqual({
      refs: cx.source.refs,
      head: cx.source.head,
      scratch: 0,
    });
    // The job keeps the request that started it, which its commit's
    // re-check hands to the commit (as a file write's does).
    expect(started.requestId).toBeTruthy();
    expect((await target.repo.stub.importRecord())?.requestId).toBe(started.requestId);
    // Every request went to the source URL (through the guard).
    expect(seen).toEqual([
      `GET ${SOURCE}/info/refs?service=git-upload-pack`,
      `POST ${SOURCE}/git-upload-pack`,
      `POST ${SOURCE}/git-upload-pack`,
    ]);
  });

  it("fails, fetching nothing, when a ruleset refuses the refs it would create", async () => {
    const target = await pushTarget();
    const seen: string[] = [];
    await useNetwork(target, replay(cx.source.exchanges, seen));
    const [, owner, repo] = target.path.split("/");
    const made = await api(
      "POST",
      `/repos/${owner}/${(repo as string).replace(/\.git$/, "")}/rulesets`,
      target.owner.token,
      {
        name: "closed",
        enforcement: "active",
        target: "branch",
        conditions: { ref_name: { include: ["~ALL"] } },
        rules: [{ type: "creation" }],
      },
    );
    expect(made.status).toBe(201);
    expect((await call(target, "POST", { url: `${SOURCE}/` })).status).toBe(201);
    const record = await untilImported(target);
    expect(record.state).toBe("failed");
    expect(record.error).toContain('cannot create this ref (ruleset "closed")');
    // The refs were listed; no pack was fetched, and nothing was stored.
    expect(seen).toEqual([
      `GET ${SOURCE}/info/refs?service=git-upload-pack`,
      `POST ${SOURCE}/git-upload-pack`,
    ]);
    expect(await repoState(target)).toMatchObject({ refs: {}, scratch: 0 });
  });

  it("checks the default branch rules against the branch the import makes the default", async () => {
    const target = await pushTarget();
    const seen: string[] = [];
    await useNetwork(target, replay(cx.source.exchanges, seen));
    const [, owner, repo] = target.path.split("/");
    expect(cx.source.head).not.toBe("refs/heads/main");
    const made = await api(
      "POST",
      `/repos/${owner}/${(repo as string).replace(/\.git$/, "")}/rulesets`,
      target.owner.token,
      {
        name: "default",
        enforcement: "active",
        target: "branch",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
        rules: [{ type: "creation" }],
      },
    );
    expect(made.status).toBe(201);
    expect((await call(target, "POST", { url: `${SOURCE}/` })).status).toBe(201);
    const record = await untilImported(target);
    expect(record.state).toBe("failed");
    expect(record.error).toContain('cannot create this ref (ruleset "default")');
    expect(seen).toHaveLength(2);
    expect(await repoState(target)).toMatchObject({ refs: {}, scratch: 0 });
  });

  it("sets the default branch in its commit, so no push in between can delete that branch", async () => {
    const target = await pushTarget();
    await useNetwork(target, replay(cx.source.exchanges, []));
    // Right after the import's commit: a push deleting the branch the import makes the
    // default, refused (as git refuses deleting the current branch) only once HEAD names it.
    const finalize = RepoPush.prototype.finalize;
    const spy = vi.spyOn(RepoPush.prototype, "finalize").mockImplementation(async function (
      this: RepoPush,
      ...args: Parameters<RepoPush["finalize"]>
    ) {
      const response = await finalize.apply(this, args);
      const { git } = this as unknown as { git: RepoGitStorage };
      if (git.refStore.readRefsSync().head !== cx.source.head)
        git.context.storage.sql.exec("DELETE FROM refs WHERE name = ?", cx.source.head);
      return response;
    });
    try {
      expect((await call(target, "POST", { url: `${SOURCE}/` })).status).toBe(201);
      expect((await untilImported(target)).state).toBe("committed");
    } finally {
      spy.mockRestore();
    }
    const state = await repoState(target);
    expect(state.head).toBe(cx.source.head);
    expect(Object.keys(state.refs)).toContain(cx.source.head);
  });

  it.each([
    ["a private address", "https://10.0.0.1/x.git", "private_address"],
    ["loopback", "https://127.0.0.1/x.git", "private_address"],
    ["the deployment's own host", "https://fyrden.test/o/r.git", "own_host"],
    ["a subdomain of it", "https://x.api.fyrden.test/o/r.git", "own_host"],
    ["plain http", "http://93.184.215.14/x.git", "scheme"],
    ["credentials", "https://u:p@93.184.215.14/x.git", "credentials"],
    ["a query", "https://93.184.215.14/x.git?a=1", "query"],
  ])("refuses %s before anything starts", async (_what, url, reason) => {
    const target = await pushTarget();
    const refused = await call(target, "POST", { url });
    expect(refused.status).toBe(422);
    expect(refused.json.code).toBe("url_refused");
    expect(refused.json.detail).toContain(`(${reason})`);
    expect(await target.repo.stub.importRecord()).toBeUndefined();
  });

  it("refuses the deployment's own host, the request's host, with no configuration", async () => {
    const target = await pushTarget();
    const own = new URL(ORIGIN).hostname;
    const refused = await call(target, "POST", { url: `https://${own}/o/r.git` }, {} as typeof OWN);
    expect(refused.status).toBe(422);
    expect(refused.json.code).toBe("url_refused");
    expect(await target.repo.stub.importRecord()).toBeUndefined();
  });

  it("refuses a request that resolves to a private address at fetch time (guarded fetch)", async () => {
    const target = await pushTarget();
    // The default transport (guardedFetch) with a name that now resolves privately.
    await useNetwork(target, {
      resolver: () => async () => ["10.0.0.5"],
      transport: guardedTransport,
    });
    const begun = await target.repo.stub.beginImport({
      principal: target.owner.principalId,
      tokenId: "tok_unused",
      repoId: target.repo.id,
      url: "https://rebind.example/source.git",
      ownHosts: ["fyrden.test"],
      limits: { maxBytes: 1024 * 1024, maxMs: 10_000, partBytes: 5 * 1024 * 1024 },
    });
    expect(begun.ok).toBe(true);
    const record = await untilImported(target);
    expect(record).toMatchObject({ state: "failed" });
    expect(record.error).toContain("private_address");
    expect(await repoState(target)).toMatchObject({ refs: {}, scratch: 0 });
  });

  it("stops a pack above the import limit and leaves nothing behind", async () => {
    const target = await pushTarget();
    await useNetwork(target, replay(cx.source.exchanges, []));
    const started = await call(target, "POST", { url: SOURCE }, {
      ...OWN,
      GIT_IMPORT_MAX_BYTES: "100",
    } as typeof OWN);
    expect(started.status).toBe(201);
    const record = await untilImported(target);
    expect(record).toMatchObject({ state: "failed" });
    expect(record.error).toMatch(/larger than 100 bytes/);
    expect(await repoState(target)).toMatchObject({ refs: {}, scratch: 0 });
    const uploads = await inRepo(target.repo.stub, ({ git }) =>
      git.context.storage.sql
        .exec<{ state: string; multipart_id: string | null }>(
          "SELECT state, multipart_id FROM uploads",
        )
        .toArray(),
    );
    expect(uploads).toEqual([{ state: "rejected", multipart_id: null }]);
  });

  it("imports a pack that needs the indexing memory pool, with the production pool and part size", async () => {
    // The fetch holds two part buffers (2 x 16 MiB) of the object's 72 MiB
    // operation pool; indexing the pack (a 6 MiB object and a delta on it)
    // reserves from the same pool. Nothing the import holds may make its
    // own indexing wait.
    const target = await pushTarget();
    await useNetwork(target, replay(cx.largeSource.exchanges, []));
    const pool = await inRepo(target.repo.stub, ({ git }) => git.memory.stats().totalBytes);
    expect(pool).toBe(72 * 1024 * 1024);
    // Started as an operator would, with the default part size (16 MiB).
    expect((await call(target, "POST", { url: SOURCE })).status).toBe(201);
    const record = await untilImported(target);
    expect(record.error).toBeUndefined();
    expect(record.state).toBe("committed");
    expect((await repoState(target)).refs).toEqual({ "refs/heads/main": cx.largeSource.main });
    const after = await inRepo(target.repo.stub, ({ git }) => git.memory.stats());
    expect(after.reservedBytes).toBe(0);
  }, 20_000);

  it("says so when the upload ends while the pack is being fetched", async () => {
    const target = await pushTarget();
    await inRepo(target.repo.stub, (repo) => {
      const replayed = replay(cx.source.exchanges, []);
      repo.importNetwork = {
        resolver: replayed.resolver,
        transport: (policy, signal) => {
          const inner = replayed.transport(policy, signal);
          return async (request) => {
            // The upload expires (the reaper) just before the pack arrives.
            if (request.method === "POST" && /command=fetch/.test(decoder.decode(request.body)))
              for (const row of repo.git.context.storage.sql
                .exec<{ upload_id: string }>("SELECT upload_id FROM uploads")
                .toArray())
                repo.git.uploads.abort(row.upload_id, "expired");
            return inner(request);
          };
        },
      };
    });
    expect((await call(target, "POST", { url: SOURCE })).status).toBe(201);
    const record = await untilImported(target);
    expect(record).toMatchObject({ state: "failed" });
    expect(record.error).toBe(
      "the import's upload expired or was cancelled during the fetch; start it again",
    );
  });

  it("continues with indexing when an earlier attempt stored the pack but stopped before saying so", async () => {
    const target = await pushTarget();
    await useNetwork(target, replay(cx.source.exchanges, []));
    expect((await call(target, "POST", { url: SOURCE })).status).toBe(201);
    expect(await runDurableObjectAlarm(target.repo.stub)).toBe(true);
    // As if the alarm had been stopped right after the pack was stored:
    // the record still says fetching, the upload is past it.
    await inRepo(target.repo.stub, async (repo) => {
      const stored = await repo.importRecord();
      expect(stored?.state).toBe("indexing");
      const { ctx } = repo as unknown as { ctx: DurableObjectState };
      await ctx.storage.put("git-import", { ...stored, state: "fetching" });
      // A second fetch would fail: the source is not asked again.
      repo.importNetwork = replay([], []);
    });
    const record = await untilImported(target);
    expect(record.error).toBeUndefined();
    expect(record.state).toBe("committed");
    expect((await repoState(target)).refs).toEqual(cx.source.refs);
  });

  it("imports only into an empty repository, one import at a time", async () => {
    const target = await pushTarget();
    await useNetwork(target, replay(cx.source.exchanges, []));
    expect((await call(target, "POST", { url: SOURCE })).status).toBe(201);
    const second = await call(target, "POST", { url: SOURCE });
    expect(second.json.code).toBe("import_running");
    await untilImported(target);
    const again = await call(target, "POST", { url: SOURCE });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("repo_not_empty");
  });
});

/** A clock the test moves by hand: each timer due on the way runs as it passes. */
function manualClock() {
  let now = 0;
  const timers = new Set<{ readonly ms: number; due: number; readonly tick: () => void }>();
  const clock: WatchClock = {
    now: () => now,
    every(ms, tick) {
      const timer = { ms, due: now + ms, tick };
      timers.add(timer);
      return () => void timers.delete(timer);
    },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter((t) => t.due <= end).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      now = next.due;
      next.due += next.ms;
      next.tick();
    }
    now = end;
  };
  return { clock, advance };
}

/** Never settles; rejects with the signal's reason once it is aborted. */
function stalled(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** The pack request: the third of the import's requests (advertisement, ls-refs, fetch). */
const FETCH = 2;

type Pace = (
  n: number,
  body: Uint8Array,
  signal: AbortSignal,
) => AsyncIterable<Uint8Array> | "stall";

/**
 * The recorded source, answering request `n` (counted from 0) as `pace`
 * decides: with a body that arrives on the test's clock, or not at all. The
 * clock moves inside the import's own requests, so nothing waits on time.
 */
function pacedSource(
  exchanges: readonly RecordedExchange[],
  seen: string[],
  pace: Pace,
): ImportNetwork {
  const replayed = replay(exchanges, seen);
  return {
    resolver: replayed.resolver,
    transport: (policy, signal) => {
      const inner = replayed.transport(policy, signal);
      let n = 0;
      return async (request): Promise<ClientResponse> => {
        const response = await inner(request);
        const paced = pace(n++, await collect(response.body), signal);
        if (paced === "stall") return stalled(signal);
        return { ...response, body: paced };
      };
    },
  };
}

/** `body` in chunks of `chunk` bytes, the clock moving `everyMs` before each. */
async function* trickle(
  body: Uint8Array,
  chunk: number,
  everyMs: number,
  advance: (ms: number) => void,
) {
  for (let at = 0; at < body.length; at += chunk) {
    advance(everyMs);
    yield body.subarray(at, at + chunk);
  }
}

describe("a slow or stalled source", () => {
  const { importDiscoveryMs, importIdleMs, minImportBytesPerSecond } = CHUNKED_TUNING_DEFAULTS;

  async function start(
    target: PushTarget,
    exchanges: readonly RecordedExchange[],
    pace: Pace,
    vars: Record<string, string> = {},
  ) {
    const seen: string[] = [];
    await inRepo(target.repo.stub, (repo) => {
      repo.importNetwork = pacedSource(exchanges, seen, pace);
    });
    const started = await call(target, "POST", { url: SOURCE }, { ...OWN, ...vars });
    expect(started.status).toBe(201);
    return seen;
  }

  async function useClock(target: PushTarget) {
    const manual = manualClock();
    await inRepo(target.repo.stub, (repo) => {
      repo.importClock = manual.clock;
    });
    return manual.advance;
  }

  /** As recorded, all at once. */
  const asRecorded = (body: Uint8Array) => trickle(body, body.length, 0, () => {});

  /** The import failed in its first slice, holding and leaving nothing; its error. */
  async function failedAtOnce(target: PushTarget) {
    expect(await runDurableObjectAlarm(target.repo.stub)).toBe(true);
    const record = await target.repo.stub.importRecord();
    expect(record?.state).toBe("failed");
    expect(await repoState(target)).toMatchObject({ refs: {}, scratch: 0 });
    const left = await inRepo(target.repo.stub, ({ git }) => ({
      uploads: git.context.storage.sql
        .exec<{ state: string; multipart_id: string | null }>(
          "SELECT state, multipart_id FROM uploads",
        )
        .toArray(),
      reserved: git.memory.stats().reservedBytes,
    }));
    expect(left).toEqual({ uploads: [{ state: "rejected", multipart_id: null }], reserved: 0 });
    return record?.error;
  }

  it("fails when the source does not list its refs in time, asking for no pack", async () => {
    const target = await pushTarget();
    const advance = await useClock(target);
    const seen = await start(target, cx.source.exchanges, (n, body) => {
      if (n !== 0) return asRecorded(body);
      advance(importDiscoveryMs);
      return "stall";
    });
    expect(await failedAtOnce(target)).toBe(
      `the source took too long: it did not list its branches and tags within ${importDiscoveryMs / 1000} s`,
    );
    expect(seen).toHaveLength(1);
    // Over at once: the job does not ask the source again.
    await runDurableObjectAlarm(target.repo.stub);
    expect(seen).toHaveLength(1);
  });

  it("fails when the source goes quiet in the middle of the pack, aborting the stored parts", async () => {
    const target = await pushTarget();
    const advance = await useClock(target);
    const partBytes = 5 * 1024 * 1024;
    let quiet = false;
    await start(
      target,
      cx.largeSource.exchanges,
      (n, body, signal) => {
        if (n !== FETCH) return asRecorded(body);
        return (async function* () {
          // Past the first part, so a multipart upload exists when the source goes quiet.
          yield body.subarray(0, partBytes + 64 * 1024);
          quiet = true;
          advance(importIdleMs);
          await stalled(signal);
        })();
      },
      { GIT_UPLOAD_PART_BYTES: String(partBytes) },
    );
    expect(await failedAtOnce(target)).toBe(
      `the source took too long: it sent nothing for ${importIdleMs / 1000} s`,
    );
    expect(quiet).toBe(true);
  });

  it("fails when the source trickles below the floor, though it never goes quiet", async () => {
    const target = await pushTarget();
    const advance = await useClock(target);
    // The pack over 1,000 s, a chunk a second: far below the floor.
    await start(target, cx.source.exchanges, (n, body) =>
      n === FETCH ? trickle(body, Math.ceil(body.length / 1000), 1000, advance) : asRecorded(body),
    );
    expect(await failedAtOnce(target)).toBe(
      `the source took too long: it sent less than ${minImportBytesPerSecond / 1024} KiB/s for a minute`,
    );
  });

  it("imports from a slow source that stays above the floor", async () => {
    const target = await pushTarget();
    const advance = await useClock(target);
    let transferMs = 0;
    await start(target, cx.largeSource.exchanges, (n, body) => {
      if (n !== FETCH) return asRecorded(body);
      // Twice the floor, a chunk a second.
      const chunk = 2 * minImportBytesPerSecond;
      transferMs = Math.ceil(body.length / chunk) * 1000;
      return trickle(body, chunk, 1000, advance);
    });
    const record = await untilImported(target);
    expect(record.error).toBeUndefined();
    expect(record.state).toBe("committed");
    // Minutes of transfer: the floor was checked many times.
    expect(transferMs).toBeGreaterThan(3 * 60_000);
    expect((await repoState(target)).refs).toEqual({ "refs/heads/main": cx.largeSource.main });
  }, 20_000);

  it("still stops a steady source at the overall limit", async () => {
    const target = await pushTarget();
    const advance = await useClock(target);
    await start(
      target,
      cx.largeSource.exchanges,
      (n, body) =>
        n === FETCH ? trickle(body, 2 * minImportBytesPerSecond, 1000, advance) : asRecorded(body),
      { GIT_IMPORT_MAX_MS: "60000" },
    );
    expect(await failedAtOnce(target)).toBe("the source took too long");
  });

  it.each([
    ["progress", encodeSideband(SIDEBAND_PROGRESS, "x".repeat(20 * 1024))],
    ["empty pack frames", repeated(encodeSideband(SIDEBAND_DATA, ""), 4 * 1024)],
  ])("fails a source that sends only %s once the floor's grace is over", async (_what, frames) => {
    const target = await pushTarget();
    const advance = await useClock(target);
    // About 20 KiB a second, none of it pack: above the floor counted in
    // bytes received, far below it counted in pack bytes.
    expect(frames.length).toBeGreaterThan(minImportBytesPerSecond);
    await start(target, cx.source.exchanges, (n, body) => {
      if (n !== FETCH) return asRecorded(body);
      return (async function* () {
        yield encodePktLine("packfile\n");
        for (;;) {
          advance(1000);
          yield frames;
        }
      })();
    });
    expect(await failedAtOnce(target)).toBe(
      `the source took too long: it sent less than ${minImportBytesPerSecond / 1024} KiB/s for a minute`,
    );
  });

  it("releases the source's responses once the fetch is over, though they stay open after git's flush", async () => {
    const target = await pushTarget();
    const signals = new Set<AbortSignal>();
    // Every answer as recorded (each ends with a flush), then no end.
    await start(target, cx.source.exchanges, (_n, body, signal) => {
      signals.add(signal);
      return (async function* () {
        yield body;
        await stalled(signal);
      })();
    });
    expect(await runDurableObjectAlarm(target.repo.stub)).toBe(true);
    expect((await target.repo.stub.importRecord())?.state).toBe("indexing");
    // Their signal, which cancels a `fetch` and its body, is aborted.
    expect([...signals].map((s) => s.aborted)).toEqual([true]);
    expect((await untilImported(target)).state).toBe("committed");
  });

  it.each([
    ["its answer", false],
    ["its answer's body", true],
  ])("fails within the discovery limit when a name lookup stalls on %s", async (_what, inBody) => {
    const target = await pushTarget();
    const advance = await useClock(target);
    // The default network: the guarded fetch, names resolved over DNS-over-HTTPS.
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://cloudflare-dns.com/")) return realFetch(input, init);
      const signal = init?.signal;
      if (!signal) throw new Error("a lookup the import cannot stop");
      advance(importDiscoveryMs);
      if (!inBody) return stalled(signal);
      // A body that ends only by failing once the lookup's signal aborts, as `fetch` makes it.
      const never = new ReadableStream({
        start: (controller) => void stalled(signal).catch((reason) => controller.error(reason)),
      });
      return Promise.resolve(
        new Response(never, { headers: { "Content-Type": "application/dns-json" } }),
      );
    });
    try {
      const begun = await target.repo.stub.beginImport({
        principal: target.owner.principalId,
        tokenId: "tok_unused",
        repoId: target.repo.id,
        url: "https://source.example/source.git",
        ownHosts: ["fyrden.test"],
        limits: { maxBytes: 1024 * 1024, maxMs: 10 * 60_000, partBytes: 5 * 1024 * 1024 },
      });
      expect(begun.ok).toBe(true);
      expect(await failedAtOnce(target)).toBe(
        `the source took too long: it did not list its branches and tags within ${importDiscoveryMs / 1000} s`,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

/** `bytes`, `times` times over. */
function repeated(bytes: Uint8Array, times: number): Uint8Array {
  const out = new Uint8Array(bytes.length * times);
  for (let i = 0; i < times; i++) out.set(bytes, i * bytes.length);
  return out;
}
