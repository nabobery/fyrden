// Teams and code owners, end to end, as the slice's acceptance matrix asks:
// a merge prepared on an object reset before its commit, and a rebase
// finished by its alarm on a fresh object after a member left the owner
// team; an organization restored to before a membership; a member removed
// from the owner team keeping write through another grant; an owner's
// approval made stale by a push; a base-only CODEOWNERS change; and two
// team requests, a comment's mentions and a thread's participants reaching
// each recipient once per item, deliveries repeated. (A lost invalidation
// is "refuses at the commit a member removed from the owner team who keeps
// write elsewhere" in merges.code-owners.test.ts.)

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { DomainEvent } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { OrgDO } from "../src/do/OrgDO.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { deliverEffects, invocationBudget } from "../src/effects/dispatcher.js";
import { allocateEpoch } from "../src/events/epochs.js";
import { feedSink } from "../src/feed/sink.js";
import { applyEnvelope } from "../src/queues/events-consumer.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { recordingPublish } from "./helpers/effects.js";
import { FROM_START } from "./helpers/feed.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { admitted } from "./helpers/read-model.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

type Merged = { sha?: string; code?: string; detail?: string };

let admin: Who;
let owner: Who;
let alice: Who;
let bob: Who;
let carol: Who;
let org: { login: string; id: string };
let repo: { id: string; name: string };
let path: string;
let core: { id: string; slug: string };

const stub = () => env.REPO.getByName(repo.id);
const orgStub = () => env.ORG.getByName(org.id);

async function ok<T = Record<string, unknown>>(res: Promise<Response>): Promise<T> {
  const answer = await res;
  if (answer.status >= 300) throw new Error(`${answer.status}: ${await answer.text()}`);
  return (answer.status === 204 ? {} : await answer.json()) as T;
}

async function commit(branch: string, files: Record<string, string | null>): Promise<string> {
  return (
    await ok<{ commit: { sha: string } }>(
      api("POST", `${path}/file-commits`, owner.token, {
        branch,
        message: "change",
        changes: Object.entries(files).map(([p, content]) =>
          content === null ? { path: p, delete: true } : { path: p, content },
        ),
      }),
    )
  ).commit.sha;
}

async function branchAt(name: string, sha: string): Promise<void> {
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: stub() },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${path.split("/")[2]}/${repo.name}.git`,
  };
  const pushed = await postPush(
    target,
    pushBody([{ old: ZERO, new: sha, ref: `refs/heads/${name}` }], { pack: fx.packEmpty }),
  );
  expect(pushed.report).toContain(`ok refs/heads/${name}\n`);
}

async function runJobs(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++)
    await inRepo(stub(), async (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      const now = r.git.context.now();
      sql.exec("UPDATE jobs SET next_run_at = ? WHERE state = 'queued'", now);
      sql.exec("UPDATE code_owner_jobs SET requested_at = ?", now);
      sql.exec("UPDATE code_owner_request_jobs SET requested_at = ?", now);
      await r.alarm();
    });
}

/** `main` with CODEOWNERS `file` and a file in each place, a pull request from `feature` changing `changes`. */
async function pullChanging(changes: Record<string, string>, file: string): Promise<void> {
  await branchAt(
    "feature",
    await commit("main", {
      ".github/CODEOWNERS": `${file}\n`,
      "src/a.ts": "a\n",
      "docs/a.md": "a\n",
      "other.txt": "a\n",
    }),
  );
  await commit("feature", changes);
  await ok(
    api("POST", `${path}/pulls`, owner.token, { title: "Change", head: "feature", base: "main" }),
  );
  await runJobs();
}

const ruleset = (parameters: Record<string, unknown>) =>
  ok<{ id: number }>(
    api("POST", `${path}/rulesets`, owner.token, {
      name: uniqueId("rules"),
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
      rules: [{ type: "pull_request", parameters }],
    }),
  );
const head = async () =>
  (await ok<{ head: { sha: string } }>(api("GET", `${path}/pulls/1`, owner.token))).head.sha;
const approve = async (who: Who) =>
  ok(
    api("POST", `${path}/pulls/1/reviews`, who.token, {
      commit_id: await head(),
      event: "APPROVE",
    }),
  );
const merge = (method: "merge" | "squash" | "rebase" = "merge") =>
  json<Merged>(api("PUT", `${path}/pulls/1/merge`, owner.token, { merge_method: method }));
const mainTip = async () =>
  (await ok<{ sha: string }>(api("GET", `${path}/commits/main`, owner.token))).sha;
const requested = async () =>
  (
    await ok<{ users: { id: string }[] }>(
      api("GET", `${path}/pulls/1/requested_reviewers`, owner.token),
    )
  ).users
    .map((u) => u.id)
    .sort();

const outboxSeq = () =>
  inRepo(
    stub(),
    (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ s: number | null }>("SELECT max(source_seq) AS s FROM outbox")
        .one().s ?? 0,
  );

/** Carol leaves Core in the organization's records, a new ACL version; the repository not told. */
const leavesCore = (who: Who) =>
  runInDurableObject(orgStub(), (_: OrgDO, state) => {
    state.storage.sql.exec(
      "DELETE FROM team_members WHERE team_id = ? AND principal_id = ?",
      core.id,
      who.principalId,
    );
    state.storage.sql.exec("UPDATE org_meta SET acl_version = acl_version + 1");
  });

beforeAll(async () => {
  admin = await user(true);
});

beforeEach(async () => {
  owner = await user();
  [alice, bob, carol] = [await user(), await user(), await user()];
  const login = uniqueId("org").slice(0, 39);
  const made = await ok<{ id: string }>(
    api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle }),
  );
  org = { login, id: made.id };
  for (const m of [alice, bob, carol])
    await ok(api("PUT", `/orgs/${login}/memberships/${m.handle}`, owner.token, {}));
  repo = await ok<{ id: string; name: string }>(
    api("POST", `/orgs/${login}/repos`, owner.token, { name: uniqueId("r") }),
  );
  path = `/repos/${login}/${repo.name}`;
  const team = await ok<{ slug: string }>(
    api("POST", `/orgs/${login}/teams`, owner.token, { name: "Core" }),
  );
  for (const m of [alice, carol])
    await ok(api("PUT", `/orgs/${login}/teams/${team.slug}/memberships/${m.handle}`, owner.token));
  await ok(
    api("PUT", `/orgs/${login}/teams/${team.slug}/repos/${login}/${repo.name}`, owner.token, {
      permission: "push",
    }),
  );
  const id = await runInDurableObject(
    orgStub(),
    (_: OrgDO, state) =>
      state.storage.sql
        .exec<{ team_id: string }>("SELECT team_id FROM teams WHERE slug = ?", team.slug)
        .one().team_id,
  );
  core = { id, slug: team.slug };
  // Carol writes through a grant of her own too.
  await ok(
    api("PUT", `${path}/collaborators/${carol.handle}`, owner.token, { permission: "push" }),
  );
});

describe("teams and code owners, acceptance", () => {
  it("merges after its object was reset between a merge's preparation and its commit, the base unmoved by the first", async () => {
    await pullChanging({ "docs/a.md": "b\n" }, `/docs/ @${org.login}/${core.slug}`);
    await ruleset({ require_code_owner_review: true });
    await approve(carol);
    const before = await mainTip();
    await inRepo(stub(), (r: RepoDO) => {
      r.mergeHooks = {
        beforeFinish: async () => {
          r.mergeHooks = {};
          (r as unknown as { ctx: DurableObjectState }).ctx.abort("reset before the commit");
        },
      };
    });
    const reset = await merge();
    expect(reset.status).toBeGreaterThanOrEqual(500);
    expect(await mainTip()).toBe(before);
    expect((await merge()).status).toBe(200);
  });

  it("refuses a rebase its alarm finishes on a fresh object after the owner team's member left", async () => {
    await pullChanging({ "docs/a.md": "b\n" }, `/docs/ @${org.login}/${core.slug}`);
    await ruleset({ require_code_owner_review: true });
    await approve(carol);
    await inRepo(stub(), (r: RepoDO) => {
      r.rebaseHooks = {
        beforeFinalize: async () => {
          r.rebaseHooks = {};
          throw new Error("stopped before the commit");
        },
      };
    });
    expect((await merge("rebase")).body).toMatchObject({ code: "merge_in_progress" });
    const before = await mainTip();
    await runInDurableObject(stub(), (_: RepoDO, state) => state.abort("reset")).catch(() => {});
    await leavesCore(carol);
    await runJobs(10);
    // The alarm finished it on the fresh object: failed, with the code owners' refusal.
    const saga = await inRepo(
      stub(),
      (r: RepoDO) =>
        r.git.context.storage.sql
          .exec<{ state: string; error_json: string | null }>(
            "SELECT state, error_json FROM merge_sagas WHERE pr_number = 1",
          )
          .toArray()[0],
    );
    expect(saga?.state).toBe("failed");
    expect(saga?.error_json).toContain("line 1");
    expect(await mainTip()).toBe(before);
    const failed = await merge("rebase");
    expect(failed.body).toMatchObject({ code: "merge_refused" });
    expect(failed.body.detail).toContain("line 1");
    expect(await mainTip()).toBe(before);
  });

  it("refuses a merge counting a membership an organization restored to before it lacks", async () => {
    await pullChanging({ "docs/a.md": "b\n" }, `/docs/ @${org.login}/${core.slug}`);
    await ruleset({ require_code_owner_review: true });
    await approve(carol);
    const before = await mainTip();
    // The organization's object restored to a state without Carol in Core (team and grant kept,
    // her own grant kept): a new restore generation in the directory, a fresh instance adopting
    // it on its own; the repository not told.
    await runInDurableObject(orgStub(), (_: OrgDO, state) => {
      state.storage.sql.exec(
        "DELETE FROM team_members WHERE team_id = ? AND principal_id = ?",
        core.id,
        carol.principalId,
      );
    });
    await allocateEpoch(env.DIRECTORY, org.id);
    await runInDurableObject(orgStub(), (_: OrgDO, state) => state.abort("restored")).catch(
      () => {},
    );
    const refused = await merge();
    expect(refused.body).toMatchObject({ code: "merge_refused" });
    expect(refused.body.detail).toContain("line 1");
    expect(await mainTip()).toBe(before);
  });

  it("refuses for code owners a member removed from the owner team who keeps write, whose approval still counts", async () => {
    await pullChanging({ "docs/a.md": "b\n" }, `/docs/ @${org.login}/${core.slug}`);
    const owners = await ruleset({ require_code_owner_review: true });
    await approve(carol);
    await leavesCore(carol);
    expect((await merge()).body).toMatchObject({ code: "merge_refused" });
    await ok(api("DELETE", `${path}/rulesets/${owners.id}`, owner.token));
    await ruleset({ required_approving_review_count: 1 });
    expect((await merge()).status).toBe(200);
  });

  it("requires an owner again once a push changes their paths, asking no one again", async () => {
    await pullChanging({ "src/a.ts": "b\n" }, `/src/ @${alice.handle}`);
    expect(await requested()).toEqual([alice.principalId]);
    await ruleset({ require_code_owner_review: true, dismiss_stale_reviews_on_push: true });
    await approve(alice);
    expect(await requested()).toEqual([]);
    await commit("feature", { "src/a.ts": "c\n" });
    await runJobs();
    const refused = await merge();
    expect(refused.body.detail).toContain(
      `code owners must approve: line 1 (src/a.ts: @${alice.handle})`,
    );
    // Asked once on this pull request: not again.
    expect(await requested()).toEqual([]);
  });

  it("works a base-only CODEOWNERS change out again, asking its new owner and no one asked before", async () => {
    await ok(
      api("PUT", `${path}/collaborators/${bob.handle}`, owner.token, { permission: "push" }),
    );
    await pullChanging({ "src/a.ts": "b\n", "docs/a.md": "b\n" }, `/src/ @${alice.handle}`);
    expect(await requested()).toEqual([alice.principalId]);
    // A person withdraws Alice's request; she never reviews.
    await ok(
      api("DELETE", `${path}/pulls/1/requested_reviewers`, owner.token, {
        reviewers: [alice.handle],
      }),
    );
    const from = await outboxSeq();
    // Only the base changes: Alice still owns src/, Bob now owns docs/.
    await commit("main", {
      ".github/CODEOWNERS": `/src/ @${alice.handle}\n/docs/ @${bob.handle}\n`,
    });
    await runJobs();
    expect(await requested()).toEqual([bob.principalId]);
    const asked = await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ event: string }>(
          "SELECT event FROM outbox WHERE source_seq > ? ORDER BY source_seq",
          from,
        )
        .toArray()
        .map((row) => JSON.parse(row.event) as DomainEvent)
        .filter((e) => e.type === "pull_request.review_requested")
        .map((e) => (e.data as { reviewer?: string } | null)?.reviewer ?? null),
    );
    expect(asked).not.toContain(alice.principalId);
  });
});

describe("a busy thread's recipients, each once an item", () => {
  it("tells two teams' members, a comment's mentions and its participants once each, deliveries repeated", async () => {
    const fake = (tag: string, i: number) =>
      `usr_${tag}${uniqueId("x").slice(-6)}${String(i).padStart(3, "0")}`;
    // Participants P (200), mentioned M (40: 20 in P, 20 not), Core and Docs (40 each, 10 in both).
    const P = Array.from({ length: 200 }, (_, i) => fake("p", i));
    const mentioned = await Promise.all(Array.from({ length: 40 }, () => user()));
    const M = mentioned.map((m) => m.principalId);
    const coreMembers = Array.from({ length: 40 }, (_, i) => fake("c", i));
    const docsMembers = [
      ...coreMembers.slice(0, 10),
      ...Array.from({ length: 30 }, (_, i) => fake("d", i)),
    ];
    const docs = await ok<{ slug: string }>(
      api("POST", `/orgs/${org.login}/teams`, owner.token, { name: "Docs" }),
    );
    await ok(
      api(
        "PUT",
        `/orgs/${org.login}/teams/${docs.slug}/repos/${org.login}/${repo.name}`,
        owner.token,
        {
          permission: "pull",
        },
      ),
    );
    await runInDurableObject(orgStub(), (_: OrgDO, state) => {
      const sql = state.storage.sql;
      const docsId = sql
        .exec<{ team_id: string }>("SELECT team_id FROM teams WHERE slug = ?", docs.slug)
        .one().team_id;
      sql.exec("DELETE FROM team_members WHERE team_id = ?", core.id);
      for (const id of coreMembers)
        sql.exec(
          "INSERT INTO team_members (team_id, principal_id, added_at) VALUES (?, ?, 0)",
          core.id,
          id,
        );
      for (const id of docsMembers)
        sql.exec(
          "INSERT INTO team_members (team_id, principal_id, added_at) VALUES (?, ?, 0)",
          docsId,
          id,
        );
      sql.exec("UPDATE org_meta SET acl_version = acl_version + 1");
    });
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    await commit("feature", { "a.txt": "b\n" });
    await ok(
      api("POST", `${path}/pulls`, owner.token, { title: "Busy", head: "feature", base: "main" }),
    );
    const participants = [...P, ...M.slice(0, 20)];
    await inRepo(stub(), (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      // Everyone reads it (its object holds it public), fake principals included.
      sql.exec("UPDATE repo_meta SET visibility = 'public'");
      const { next_seq } = sql
        .exec<{ next_seq: number }>("SELECT next_seq FROM feed_participation WHERE number = 1")
        .one();
      for (const [i, id] of participants.entries())
        sql.exec(
          `INSERT OR IGNORE INTO feed_participants (number, principal, root, reason, joined_seq)
           VALUES (1, ?1, ?1, 'commenter', ?2)`,
          id,
          next_seq + i,
        );
      sql.exec(
        "UPDATE feed_participation SET participants = participants + ?1, next_seq = ?2 WHERE number = 1",
        participants.length,
        next_seq + participants.length,
      );
    });
    const seq = () =>
      inRepo(
        stub(),
        (r: RepoDO) =>
          r.git.context.storage.sql
            .exec<{ s: number | null }>("SELECT max(source_seq) AS s FROM outbox")
            .one().s ?? 0,
      );
    const from = await seq();
    await ok(
      api("POST", `${path}/pulls/1/requested_reviewers`, owner.token, {
        team_reviewers: [core.slug, docs.slug],
      }),
    );
    await ok(
      api("POST", `${path}/issues/1/comments`, owner.token, {
        body: `Please look: ${mentioned.map((m) => `@${m.handle}`).join(" ")}`,
      }),
    );
    const events = (
      await inRepo(stub(), (r: RepoDO) =>
        r.git.context.storage.sql
          .exec<{ event: string }>(
            "SELECT event FROM outbox WHERE source_seq > ? ORDER BY source_seq",
            from,
          )
          .toArray()
          .map((row) => JSON.parse(row.event) as DomainEvent),
      )
    ).filter((e) => e.feed);
    /** Journals the events' feed effects and delivers them; `again`: every one delivered once more. */
    const deliver = async (again = false) => {
      const now = Date.now();
      const { publish, sent } = recordingPublish();
      await applyEnvelope(
        env,
        { sourceId: repo.id, events },
        { sinks: [feedSink], publish, inline: { batched: 0 }, now: () => now },
      );
      const ids = (
        await admitted()
          .prepare("SELECT effect_id FROM effects WHERE effect_id LIKE ?")
          .bind(`${repo.id}:%`)
          .all<{ effect_id: string }>()
      ).results.map((row) => row.effect_id);
      if (again) {
        // As if every delivery's outcome were lost after its recipients took it: made again.
        await admitted()
          .prepare(
            `UPDATE effects SET state = 'pending', attempts = 0, lease_token = NULL,
             lease_until = NULL, done_at = NULL WHERE effect_id LIKE ?`,
          )
          .bind(`${repo.id}:%`)
          .run();
        sent.push({ sink: feedSink.name, ids });
      }
      for (let next = sent.shift(); next; next = sent.shift())
        await deliverEffects(
          { db: admitted(), env, sinks: [feedSink], now: () => now, publish },
          next.sink,
          next.ids,
          invocationBudget(now),
        );
      return ids.length;
    };
    const kindsOf = async (principal: string) => {
      const page = await env.USER.getByName(principal).listStreams(FROM_START, 100, {});
      if (page.expired) throw new Error("expired");
      return page.items
        .filter((i) => i.repoId === repo.id)
        .map((i) => `${i.kind}@${i.version}`)
        .sort();
    };
    const everyone = [...new Set([...P, ...M, ...coreMembers, ...docsMembers, owner.principalId])];
    const snapshot = async () => {
      const all = new Map<string, string[]>();
      for (const id of everyone) all.set(id, await kindsOf(id));
      return all;
    };
    expect(await deliver()).toBeGreaterThan(0);
    const first = await snapshot();
    await deliver(true);
    const states = (
      await admitted()
        .prepare("SELECT state FROM effects WHERE effect_id LIKE ?")
        .bind(`${repo.id}:%`)
        .all<{ state: string }>()
    ).results.map((row) => row.state);
    expect(new Set(states)).toEqual(new Set(["done"]));
    // Every effect delivered twice: nothing told again, no version moved.
    expect(await snapshot()).toEqual(first);
    const kinds = (id: string) => (first.get(id) ?? []).map((k) => k.split("@")[0]);
    const requestedSet = new Set([...coreMembers, ...docsMembers]);
    const mentionSet = new Set(M);
    const activitySet = new Set([...P, ...M]);
    for (const id of everyone) {
      const want = [
        ...(activitySet.has(id) && id !== owner.principalId ? ["activity"] : []),
        ...(mentionSet.has(id) ? ["mention"] : []),
        ...(requestedSet.has(id) ? ["review_requested"] : []),
      ].sort();
      expect({ id, kinds: kinds(id) }).toEqual({ id, kinds: want });
    }
  });
});
