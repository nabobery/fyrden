// What failing checks mean for activity feeds: a pull request's author (and
// the user its agent acted for, and whoever triggered a failing run) holds
// one `ci_failed` item while a counted check on its current head fails; a
// re-run keeps it until it ends, a new head replaces it, closing settles it.
import { env } from "cloudflare:workers";
import type { DomainEvent, FeedBlock } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

let owner: Who;
let writer: Who;
let other: Who;
let repo: { id: string; name: string };
let path: string;
let head: string;

const stub = () => env.REPO.getByName(repo.id);
const commitOn = async (branch: string, content: string) => {
  const made = await json<{ commit: { sha: string } }>(
    api("POST", `${path}/file-commits`, owner.token, {
      branch,
      message: "change",
      changes: [{ path: "a.txt", content }],
    }),
  );
  expect(made.status).toBe(201);
  return made.body.commit.sha;
};
async function moveBranch(name: string, from: string, to: string) {
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: stub() },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
  const pushed = await postPush(
    target,
    pushBody([{ old: from, new: to, ref: `refs/heads/${name}` }], { pack: fx.packEmpty }),
  );
  expect(pushed.report).toContain(`ok refs/heads/${name}\n`);
}
async function collaborator(): Promise<Who> {
  const who = await user();
  const set = await api("PUT", `${path}/collaborators/${who.handle}`, owner.token, {
    permission: "push",
  });
  expect(set.status).toBe(200);
  return who;
}
const openPull = async (headBranch: string, draft = false) => {
  const opened = await json<{ number: number }>(
    api("POST", `${path}/pulls`, owner.token, {
      title: "A change",
      head: headBranch,
      base: "main",
      draft,
    }),
  );
  expect(opened.status).toBe(201);
  return opened.body.number;
};
const status = async (state: string, context = "build", who = writer, at = head) => {
  const made = await api("POST", `${path}/statuses/${at}`, who.token, { state, context });
  expect(made.status).toBe(201);
};

/** The outbox's `pull_request.checks` blocks since `from`, with their data. */
const checkBlocks = async (from: number) =>
  (
    await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ event: string }>(
          "SELECT event FROM outbox WHERE source_seq > ? ORDER BY source_seq",
          from,
        )
        .toArray()
        .map((row) => JSON.parse(row.event) as DomainEvent),
    )
  )
    .filter((e) => e.type === "pull_request.checks")
    .map((e) => ({
      data: e.data as { number: number; sha: string; failing: { name: string }[] },
      ...(e.feed as FeedBlock),
    }));
const seq = () =>
  inRepo(
    stub(),
    (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ s: number | null }>("SELECT max(source_seq) AS s FROM outbox")
        .one().s ?? 0,
  );
/** Who a block tells, as `principal:state`. */
const told = (block: FeedBlock | undefined) =>
  (block?.audience ?? [])
    .filter((a) => a.kind === "ci_failed")
    .map((a) => `${a.principal}:${a.state}`)
    .sort();

beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  writer = await collaborator();
  other = await collaborator();
  const base = await commitOn("main", "one\n");
  await moveBranch("feature", ZERO, base);
  head = await commitOn("feature", "one\ntwo\n");
  expect(await openPull("feature")).toBe(1);
});

describe("ci_failed", () => {
  it("opens for the author when a check on the head fails, as a P0 action with its member", async () => {
    const from = await seq();
    await status("failure");
    const [block] = await checkBlocks(from);
    expect(block).toMatchObject({
      threadKey: "pull/1",
      action: "checks_failed",
      member: "checks/1",
      data: { number: 1, sha: head, failing: [{ name: "build" }] },
    });
    expect(told(block)).toEqual([`${owner.principalId}:open`]);
    expect(block?.audience[0]).toMatchObject({ priority: "P0", kind: "ci_failed" });
  });

  it("says nothing of successes, pending states, or a change that leaves the failure as it was", async () => {
    const from = await seq();
    await status("pending");
    await status("success", "lint");
    expect(await checkBlocks(from)).toEqual([]);
    await status("failure");
    const after = await seq();
    await status("success", "lint");
    await status("pending", "deploy");
    expect(await checkBlocks(after)).toEqual([]);
  });

  it("stays open while any check fails, and resolves when the last one passes", async () => {
    await status("failure", "a");
    await status("failure", "b");
    const from = await seq();
    await status("success", "a");
    const [still] = await checkBlocks(from);
    expect(still?.action).toBe("checks_failed");
    expect(still?.data.failing.map((f) => f.name)).toEqual(["b"]);
    expect(told(still)).toEqual([`${owner.principalId}:open`]);
    const later = await seq();
    await status("success", "b");
    const [resolved] = await checkBlocks(later);
    expect(resolved?.action).toBe("checks_passed");
    expect(told(resolved)).toEqual([`${owner.principalId}:resolved`]);
  });

  it("follows the latest status of a context, whoever posted it", async () => {
    await status("failure", "build", writer);
    const from = await seq();
    await status("success", "BUILD", other);
    expect(told((await checkBlocks(from))[0])).toEqual([`${owner.principalId}:resolved`]);
    await status("failure", "build", writer);
    const pending = await seq();
    // Another publisher's newer pending status decides the context: the failure no longer stands.
    await status("pending", "build", other);
    expect(told((await checkBlocks(pending))[0])).toEqual([`${owner.principalId}:resolved`]);
  });

  it("keeps a failure through a pending re-run, until it ends", async () => {
    await status("failure");
    const from = await seq();
    await status("pending");
    expect(await checkBlocks(from)).toEqual([]);
    await status("success");
    expect(told((await checkBlocks(from))[0])).toEqual([`${owner.principalId}:resolved`]);
  });

  it("is superseded by a new head that passes, and opens again on a new head that fails the same way", async () => {
    await status("failure");
    const from = await seq();
    const green = await commitOn("feature", "one\ntwo\nthree\n");
    const [superseded] = await checkBlocks(from);
    expect(superseded?.data.sha).toBe(green);
    expect(told(superseded)).toEqual([`${owner.principalId}:resolved`]);

    // The next head fails with the same check from the same publisher as the first did, posted
    // before the push: the item opens again, on the new head, with a new version.
    await moveBranch("staging", ZERO, green);
    const red = await commitOn("staging", "one\ntwo\nthree\nfour\n");
    await status("failure", "build", writer, red);
    const version = (await checkBlocks(0)).at(-1)?.subject.version ?? 0;
    const moved = await seq();
    await moveBranch("feature", green, red);
    const blocks = await checkBlocks(moved);
    expect(blocks.at(-1)?.data.sha).toBe(red);
    expect(told(blocks.at(-1))).toEqual([`${owner.principalId}:open`]);
    expect(blocks.at(-1)?.subject.version).toBeGreaterThan(version);
  });

  it("opens with a pull request whose head already fails, a draft too", async () => {
    await status("failure", "build", writer, head);
    for (const draft of [false, true]) {
      const branch = `again-${draft}`;
      await moveBranch(branch, ZERO, head);
      const from = await seq();
      const number = await openPull(branch, draft);
      const [block] = await checkBlocks(from);
      expect(block?.data.number).toBe(number);
      expect(told(block)).toEqual([`${owner.principalId}:open`]);
    }
  });

  it("tells each open pull request whose head is the commit", async () => {
    await moveBranch("twin", ZERO, head);
    await openPull("twin");
    const from = await seq();
    await status("failure");
    expect((await checkBlocks(from)).map((b) => b.data.number).sort()).toEqual([1, 2]);
  });

  it("is resolved for every holder when the pull request closes, and back when it reopens", async () => {
    await stub().startCheckAttempts(head, [
      { name: "ci", startKey: "r1", actor: other.principalId },
    ]);
    await stub().recordCheckUpdates([
      { sha: head, name: "ci", attempt: 1, status: "completed", conclusion: "failure" },
    ]);
    const closing = await seq();
    expect((await api("PATCH", `${path}/pulls/1`, owner.token, { state: "closed" })).status).toBe(
      200,
    );
    expect(told((await checkBlocks(closing))[0])).toEqual(
      [`${owner.principalId}:resolved`, `${other.principalId}:resolved`].sort(),
    );
    const reopening = await seq();
    await api("PATCH", `${path}/pulls/1`, owner.token, { state: "open" });
    expect(told((await checkBlocks(reopening))[0])).toEqual(
      [`${owner.principalId}:open`, `${other.principalId}:open`].sort(),
    );
  });
});

describe("at the limits", () => {
  it("records and tells of every legal failing check on a head within a row and an event", async () => {
    // 1,000 failing status summaries and 1,000 failing checks, names of 255 four-byte characters.
    const name = (kind: string, i: number) =>
      `${"\u{1f600}".repeat(251)}${kind}${String(i).padStart(3, "0")}`;
    await inRepo(stub(), (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      for (let i = 0; i < 1_000; i++) {
        const status = name("s", i);
        sql.exec(
          `INSERT INTO check_summaries (sha, name_key, source, name, kind, status, conclusion, settled,
             status_id, updated_at)
           VALUES (?, ?, ?, ?, 'status', 'completed', 'failure', 'failure', ?, 0)`,
          head,
          status,
          writer.principalId,
          status,
          i + 1,
        );
        const check = name("c", i);
        sql.exec(
          `INSERT INTO check_summaries (sha, name_key, source, name, kind, attempt, status, conclusion,
             settled, settled_attempt, settled_actor_id, actor_id, updated_at)
           VALUES (?, ?, 'ci', ?, 'check', 1, 'completed', 'failure', 'failure', 1, ?, ?, 0)`,
          head,
          check,
          check,
          `usr_${String(i).padStart(26, "0")}`,
          `usr_${String(i).padStart(26, "0")}`,
        );
      }
    });
    await moveBranch("twin", ZERO, head);
    const from = await seq();
    const number = await openPull("twin");
    const [block] = await checkBlocks(from);
    const data = block?.data as unknown as {
      failing: unknown[];
      failingCount: number;
      holders: string[];
    };
    expect(data.failingCount).toBe(2_000);
    expect(data.failing).toHaveLength(20);
    // The author, and the first 50 trigger actors.
    expect(data.holders).toHaveLength(51);
    const [row] = await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ size: number }>(
          "SELECT length(failing) + length(holders) AS size FROM pull_checks WHERE pr_number = ?",
          number,
        )
        .toArray(),
    );
    expect(row?.size).toBeLessThan(32_000);
  });
});

describe("a run's trigger actor", () => {
  const run = (attempt: number, conclusion: "failure" | "success") =>
    stub().recordCheckUpdates([
      { sha: head, name: "ci", attempt, status: "completed", conclusion },
    ]);

  it("holds the failure of the attempt it triggered, through another's re-run, until that one ends", async () => {
    await stub().startCheckAttempts(head, [
      { name: "ci", startKey: "a1", actor: writer.principalId },
    ]);
    const failed = await seq();
    await run(1, "failure");
    expect(told((await checkBlocks(failed))[0])).toEqual(
      [`${owner.principalId}:open`, `${writer.principalId}:open`].sort(),
    );
    const rerun = await seq();
    await stub().startCheckAttempts(head, [
      { name: "ci", startKey: "a2", actor: other.principalId },
    ]);
    expect(await checkBlocks(rerun)).toEqual([]);
    await run(2, "failure");
    expect(told((await checkBlocks(rerun))[0])).toEqual(
      [
        `${owner.principalId}:open`,
        `${other.principalId}:open`,
        `${writer.principalId}:resolved`,
      ].sort(),
    );
  });

  it("is told its failure resolved after it lost read access", async () => {
    await stub().startCheckAttempts(head, [
      { name: "ci", startKey: "a1", actor: writer.principalId },
    ]);
    await run(1, "failure");
    expect(
      (await api("DELETE", `${path}/collaborators/${writer.handle}`, owner.token)).status,
    ).toBeLessThan(300);
    await stub().startCheckAttempts(head, [{ name: "ci", startKey: "a2" }]);
    const from = await seq();
    await run(2, "success");
    expect(told((await checkBlocks(from))[0])).toEqual(
      [`${owner.principalId}:resolved`, `${writer.principalId}:resolved`].sort(),
    );
  });

  it("is released when a new head passes", async () => {
    await stub().startCheckAttempts(head, [
      { name: "ci", startKey: "a1", actor: writer.principalId },
    ]);
    await run(1, "failure");
    const from = await seq();
    await commitOn("feature", "fixed\n");
    expect(told((await checkBlocks(from))[0])).toEqual(
      [`${owner.principalId}:resolved`, `${writer.principalId}:resolved`].sort(),
    );
  });
});

describe("the item's excerpt", () => {
  it("names the head and the failing checks as they stand, and nothing once resolved", async () => {
    const EPOCH = await inRepo(stub(), (r: RepoDO) => r.events.epochGen());
    const excerpt = async () =>
      (
        await stub().feedView(owner.principalId, null, [
          { epoch: EPOCH, thread: "pull/1", member: "checks/1" },
        ])
      ).excerpts[`${EPOCH} pull/1 checks/1`] ?? null;
    await status("failure", "build");
    await status("error", "lint");
    expect(await excerpt()).toBe(`2 failing on ${head.slice(0, 7)}: build, lint`);
    await status("success", "lint");
    expect(await excerpt()).toBe(`1 failing on ${head.slice(0, 7)}: build`);
    await status("success", "build");
    expect(await excerpt()).toBeNull();
  });
});
