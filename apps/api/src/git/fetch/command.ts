import { currentInvocation, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import { parseFetchArgs } from "@fyrden/git-core";
import type { RepoEntry } from "../../repos/directory.js";
import { type GitContext, gitError } from "../http.js";
import { contentType, NO_CACHE_HEADERS } from "../protocol.js";
import { workersPlan } from "./mode.js";
import { FETCH_LEASE_TTL_MS } from "./plan.js";
import { type ServeResult, streamFetchResponse } from "./serve.js";
import type { FetchPlanReply } from "./wire.js";

const SERVICE = "git-upload-pack";

/** Leases are renewed this often while a response streams. Proposed. */
const LEASE_RENEW_MS = Math.floor(FETCH_LEASE_TTL_MS / 3);

type Stub = ReturnType<Env["REPO"]["getByName"]>;

/**
 * The protocol v2 `fetch` command: the repository object plans the
 * response and leases what it names; the Worker streams it and releases
 * the lease when the body is complete or the client has gone (in
 * `waitUntil`, after the response has been returned).
 */
export async function fetchCommand(
  c: GitContext,
  repo: RepoEntry,
  rawArgs: readonly Uint8Array[],
): Promise<Response> {
  const args = parseFetchArgs(rawArgs);
  const plan = workersPlan(c.env);
  const mode = plan === "paid" ? "transport" : "stored";
  const metrics = c.get("metrics");
  const stub = c.env.REPO.getByName(repo.id);
  metrics.count("do.request", { class: "RepoDO", method: "planFetch" });
  const reply = (await stub.planFetch({
    repoId: repo.id,
    args,
    plan,
    holder: c.get("requestId") ?? "unknown",
  })) as FetchPlanReply;

  metrics.count("git.fetch.calls", { where: "do", kind: "r2" }, reply.calls.r2);
  metrics.count("git.fetch.calls", { where: "do", kind: "cache_api" }, reply.calls.cacheApi);
  if (reply.blocks) {
    metrics.count("git.fetch.blocks", { tier: "memory" }, reply.blocks.memoryHits);
    metrics.count("git.fetch.blocks", { tier: "cache_api" }, reply.blocks.sharedHits);
    metrics.count("git.fetch.blocks", { tier: "miss" }, reply.blocks.misses);
  }
  if (!reply.ok) {
    metrics.count("git.fetch", { request: "refused", plan: "none", mode, cached: "false" });
    return gitError(SERVICE, reply.message);
  }
  metrics.count("git.fetch", {
    request: reply.kind,
    plan: reply.pack,
    mode,
    cached: String(reply.cached),
  });

  const stream = streamFetchResponse(reply.parts, c.env.GIT);
  // The request's subrequests are written once the body has been sent.
  const release = currentInvocation()?.hold();
  c.executionCtx.waitUntil(
    settle(stream.done, stub, reply.lease?.leaseId, metrics, mode, c.get("log")).finally(release),
  );
  return new Response(stream.body, {
    headers: { "Content-Type": contentType.result(SERVICE), ...NO_CACHE_HEADERS },
  });
}

/** Renews the lease while the body streams, then releases it and records the response. */
async function settle(
  done: Promise<ServeResult>,
  stub: Stub,
  leaseId: string | undefined,
  metrics: Metrics,
  mode: string,
  log: { warn(message: string, fields?: Record<string, unknown>): void },
): Promise<void> {
  const renew =
    leaseId === undefined
      ? undefined
      : setInterval(() => {
          metrics.count("do.request", { class: "RepoDO", method: "renewFetchLease" });
          stub.renewFetchLease(leaseId).catch((error: unknown) => {
            log.warn("fetch lease renewal failed", { error });
          });
        }, LEASE_RENEW_MS);
  let result: ServeResult | undefined;
  try {
    result = await done;
  } finally {
    if (renew !== undefined) clearInterval(renew);
    if (leaseId !== undefined) {
      // Expiry covers a release that never arrives.
      metrics.count("do.request", { class: "RepoDO", method: "releaseFetchLease" });
      await stub.releaseFetchLease(leaseId).catch((error: unknown) => {
        log.warn("fetch lease release failed", { error });
      });
    }
  }
  metrics.count("git.fetch.bytes_out", { mode }, result.bytes);
  metrics.count("git.fetch.calls", { where: "worker", kind: "r2" }, result.r2Calls);
  if (result.r2Calls > 0) {
    metrics.count("r2.class_b", { bucket: "fyrden-git", op: "get" }, result.r2Calls);
  }
  if (result.error !== undefined) {
    log.warn("fetch response ended early", { error: result.error, bytes: result.bytes });
  }
}
