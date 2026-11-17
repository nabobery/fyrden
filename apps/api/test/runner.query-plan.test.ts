// FetchTask authenticates with one read of the directory's primary on every
// poll (about 17,280 a day per idle runner), so that read must look up a
// runner's open task rows through their partial index and never scan the
// runner's whole task history.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { LAPSED_OFFERS_SQL, runnerAuthQuery } from "../src/runner/registry.js";

async function plan(sql: string, ...binds: (string | number)[]): Promise<string[]> {
  const { results } = await env.DIRECTORY.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...binds)
    .all<{ detail: string }>();
  return results.map((r) => r.detail);
}

describe("the runner authentication read", () => {
  it("finds FetchTask's open task rows through their partial index", async () => {
    const details = await plan(runnerAuthQuery("fetch"), crypto.randomUUID(), Date.now(), 3);
    expect(details.filter((d) => /USING INDEX ci_tasks_runner_open/.test(d))).toHaveLength(2);
    // No scan of a task table, and none of the runners table.
    expect(
      details.filter((d) => /^SCAN (o|t|r)\b/.test(d)),
      details.join("\n"),
    ).toEqual([]);
  });

  it("reads a named task by its key", async () => {
    const details = await plan(runnerAuthQuery("task"), crypto.randomUUID(), 1);
    expect(
      details.filter((d) => /^SCAN /.test(d)),
      details.join("\n"),
    ).toEqual([]);
  });
});

describe("clearing an account's lapsed claims", () => {
  it("finds their unassigned offers through the open-task index, never scanning task history", async () => {
    const details = await plan(LAPSED_OFFERS_SQL, crypto.randomUUID(), Date.now());
    expect(
      details.some((d) => /USING INDEX ci_tasks_runner_open/.test(d)),
      details.join("\n"),
    ).toBe(true);
    expect(
      details.filter((d) => /^SCAN (o|p|ci_tasks)\b/.test(d)),
      details.join("\n"),
    ).toEqual([]);
  });
});

describe("claim nonce lookup", () => {
  it.each(["present", "absent"])("uses an index for a %s nonce", async (kind) => {
    const nonce = crypto.randomUUID();
    if (kind === "present") {
      await env.DIRECTORY.prepare(
        `INSERT INTO ci_pending_jobs (account_id, run_id, job_id, attempt, labels, queued_at, claim_nonce)
         VALUES (?, ?, 1, 1, '["ubuntu-latest"]', 0, ?)`,
      )
        .bind(crypto.randomUUID(), crypto.randomUUID(), nonce)
        .run();
    }
    const details = await plan(
      "SELECT run_id, job_id, claimed_by FROM ci_pending_jobs WHERE claim_nonce = ?",
      nonce,
    );
    expect(
      details.some((d) => /USING INDEX ci_pending_nonce/.test(d)),
      details.join("\n"),
    ).toBe(true);
    expect(details.filter((d) => /^SCAN ci_pending_jobs\b/.test(d))).toEqual([]);
  });
});
