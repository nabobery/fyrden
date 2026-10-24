// Code owners asked to review: once a ready pull request's code owners are
// worked out, the owners of the rules deciding its changed paths are asked
// (users, agents, teams), by the pull request's author, unless they wrote
// it, are asked already, were asked once before on it, or a rule's owner
// approved; requests made this way carry their own reason, so a person's
// requests are never taken back, and are taken back when their owner no
// longer owns a changed path. Bounded slices, an invocation's directory
// queries, and fences against what changed while the owners were read.
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { currentInvocation, measureInvocation } from "@fyrden/adapters-cloudflare/obs";
import { type DomainEvent, eventKey, MAX_REQUESTED_REVIEWERS } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createApp } from "../src/app.js";
import type { OrgDO } from "../src/do/OrgDO.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { CODE_OWNER_REQUEST_POLICY, sliceQueries } from "../src/do/repo/code-owner-requests.js";
import { D1_QUERIES_PER_INVOCATION } from "../src/do/repo/directory-budget.js";
import { allocateEpoch } from "../src/events/epochs.js";
import { agentFor } from "./helpers/agents.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { countingD1 } from "./helpers/d1.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

let admin: Who;
let owner: Who;
let alice: Who;
let bob: Who;
let carol: Who;
let dave: Who;
let org: { login: string; id: string };
let repo: { id: string; name: string };
let path: string;
let core: { id: string; slug: string };

const OWNERS = 2;
const MANUAL = 1;

const stub = () => env.REPO.getByName(repo.id);
const orgStub = () => env.ORG.getByName(org.id);

async function ok<T = Record<string, unknown>>(res: Promise<Response>): Promise<T> {
  const answer = await res;
  if (answer.status >= 300) throw new Error(`${answer.status}: ${await answer.text()}`);
  return (answer.status === 204 ? {} : await answer.json()) as T;
}

/** Writes `files` (null deletes) on `branch` as one commit; its sha. */
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

/** Makes everything queued due now. */
const dueNow = (r: RepoDO) => {
  const sql = r.git.context.storage.sql;
  const now = r.git.context.now();
  sql.exec("UPDATE jobs SET next_run_at = ? WHERE state = 'queued'", now);
  sql.exec("UPDATE code_owner_jobs SET requested_at = ?", now);
  sql.exec("UPDATE code_owner_request_jobs SET requested_at = ?", now);
};

/** Runs the repository's due jobs, a few rounds, everything due now. */
async function runJobs(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++)
    await inRepo(stub(), async (r: RepoDO) => {
      dueNow(r);
      await r.alarm();
    });
}

/**
 * Runs alarms until no code-owner work is left (at most `rounds`), each
 * alarm's directory queries counted; the most one alarm made.
 */
async function drained(rounds = 60): Promise<{ alarms: number; most: number }> {
  let most = 0;
  for (let i = 0; i < rounds; i++) {
    const left = await inRepo(stub(), async (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      const work = () =>
        sql
          .exec<{ n: number }>(
            `SELECT (SELECT count(*) FROM code_owner_jobs) + (SELECT count(*) FROM code_owner_request_jobs)
               + (SELECT count(*) FROM jobs WHERE state = 'queued'
                    AND kind IN ('code_owners', 'code_owner_requests', 'review_teams')) AS n`,
          )
          .one().n;
      if (work() === 0) return 0;
      dueNow(r);
      const count = { queries: 0 };
      const self = r as unknown as { env: Env };
      const real = self.env;
      self.env = { ...real, DIRECTORY: countingD1(real.DIRECTORY, count) };
      try {
        await r.alarm();
      } finally {
        self.env = real;
      }
      most = Math.max(most, count.queries);
      return work() + 1;
    });
    if (left === 0) return { alarms: i, most };
  }
  throw new Error("code owners' work did not end");
}

/** The default CODEOWNERS of these tests. */
const codeowners = () =>
  [
    `/src/ @${alice.handle}`,
    `/docs/ @${org.login}/${core.slug}`,
    `/lib/ @${bob.handle}`,
    `/ro/ @${dave.handle}`,
    "/free/",
  ].join("\n");

/**
 * `main` with CODEOWNERS (`file`, or none when null) and one file in each
 * place, a pull request by `author` from `feature` changing `changes`;
 * its jobs run unless `settle` is false.
 */
async function pullChanging(
  changes: Record<string, string>,
  options: {
    readonly file?: string | null;
    readonly settle?: boolean;
    readonly draft?: boolean;
    readonly author?: Who;
    readonly base?: Record<string, string>;
  } = {},
): Promise<void> {
  const file = options.file === undefined ? codeowners() : options.file;
  const base: Record<string, string | null> = {
    "src/a.ts": "a\n",
    "docs/a.md": "a\n",
    "lib/a.c": "a\n",
    "ro/a.txt": "a\n",
    "free/a.txt": "a\n",
    "other.txt": "a\n",
    ...options.base,
  };
  if (file !== null) base[".github/CODEOWNERS"] = `${file}\n`;
  await branchAt("feature", await commit("main", base));
  await commit("feature", changes);
  await ok(
    api("POST", `${path}/pulls`, (options.author ?? owner).token, {
      title: "Change",
      head: "feature",
      base: "main",
      draft: options.draft ?? false,
    }),
  );
  if (options.settle !== false) await runJobs();
}

const head = async () =>
  (await ok<{ head: { sha: string } }>(api("GET", `${path}/pulls/1`, owner.token))).head.sha;
const review = async (event: "APPROVE" | "REQUEST_CHANGES", token: string) =>
  ok(
    api("POST", `${path}/pulls/1/reviews`, token, {
      commit_id: await head(),
      event,
      ...(event === "REQUEST_CHANGES" && { body: "no" }),
    }),
  );
const approve = (who: Who, token = who.token) => review("APPROVE", token);
const requested = async () => {
  const got = await ok<{ users: { id: string }[]; teams: { id: string; slug: string }[] }>(
    api("GET", `${path}/pulls/1/requested_reviewers`, owner.token),
  );
  return { users: got.users.map((u) => u.id).sort(), teams: got.teams.map((t) => t.id).sort() };
};
const ask = (body: Record<string, unknown>, who: Who = owner) =>
  ok(api("POST", `${path}/pulls/1/requested_reviewers`, who.token, body));
const unask = (body: Record<string, unknown>, who: Who = owner) =>
  ok(api("DELETE", `${path}/pulls/1/requested_reviewers`, who.token, body));
const ids = (...who: Who[]) => who.map((w) => w.principalId).sort();

/** Each standing request's reasons, `id:reasons` (teams by team id), sorted. */
const reasons = () =>
  inRepo(stub(), (r: RepoDO) => {
    const sql = r.git.context.storage.sql;
    return [
      ...sql
        .exec<{ id: string; reasons: number }>(
          "SELECT reviewer_id AS id, reasons FROM review_requests",
        )
        .toArray(),
      ...sql
        .exec<{ id: string; reasons: number }>(
          "SELECT team_id AS id, reasons FROM review_team_requests",
        )
        .toArray(),
    ]
      .map((row) => `${row.id}:${row.reasons}`)
      .sort();
  });

/** The request job's queued pull requests, and why pull request 1 waits. */
const waiting = () =>
  inRepo(stub(), (r: RepoDO) => {
    const sql = r.git.context.storage.sql;
    return {
      jobs: sql.exec<{ n: number }>("SELECT count(*) AS n FROM code_owner_request_jobs").one().n,
      waiting: sql
        .exec<{ reason: string }>("SELECT reason FROM code_owner_waiting WHERE pr_number = 1")
        .toArray()
        .map((row) => row.reason),
    };
  });

/** Who the pull request's owners were asked of once, `kind:id`, sorted. */
const ledger = () =>
  inRepo(stub(), (r: RepoDO) =>
    r.git.context.storage.sql
      .exec<{ kind: string; id: string }>("SELECT kind, id FROM code_owner_asked")
      .toArray()
      .map((row) => `${row.kind}:${row.id}`)
      .sort(),
  );

/** The outbox's events after `from`, each with its stored data put back. */
async function events(from = 0): Promise<DomainEvent[]> {
  return inRepo(stub(), (r: RepoDO) => {
    const sql = r.git.context.storage.sql;
    return sql
      .exec<{ event: string }>(
        "SELECT event FROM outbox WHERE source_seq > ? ORDER BY source_seq",
        from,
      )
      .toArray()
      .map((row) => {
        const event = JSON.parse(row.event) as DomainEvent;
        if (!event.stored) return event;
        const [payload] = sql
          .exec<{ payload: string }>(
            "SELECT payload FROM event_payloads WHERE event_key = ?",
            eventKey(event.id),
          )
          .toArray();
        const stored = JSON.parse(payload?.payload ?? "{}") as { data?: unknown };
        return { ...event, stored: false, data: stored.data } as DomainEvent;
      });
  });
}
const seq = () =>
  inRepo(
    stub(),
    (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ s: number | null }>("SELECT max(source_seq) AS s FROM outbox")
        .one().s ?? 0,
  );
/** Of `all`, who each review request event asked (`reviewer` or `team:id`), by its actor. */
const asks = (all: DomainEvent[], type = "pull_request.review_requested") =>
  all
    .filter((e) => e.type === type)
    .map((e) => {
      const data = e.data as { reviewer?: string; team?: { id: string } };
      return `${data.reviewer ?? `team:${data.team?.id}`} by ${e.actor}`;
    })
    .sort();

/** The organization's records changed as `change` does, a new ACL version; the repository told when `tell`. */
async function inOrg(change: (sql: SqlStorage) => void, tell = true): Promise<void> {
  const { epoch, version } = await runInDurableObject(orgStub(), (_: OrgDO, state) => {
    change(state.storage.sql);
    return state.storage.sql
      .exec<{ epoch: number; version: number }>(
        `UPDATE org_meta SET acl_version = acl_version + 1
         RETURNING epoch_gen AS epoch, acl_version AS version`,
      )
      .one();
  });
  if (tell) await stub().invalidateAcl(org.id, epoch, version);
}

/** An agent of `of`, given `role` on the repository of its own (a collaborator grant put in directly). */
async function agentWith(of: Who, role: "write" | "read" = "write") {
  const agent = await agentFor(of, ["pull_requests:write", "contents:read"]);
  await inOrg((sql) => {
    sql.exec(
      "INSERT INTO members (principal_id, handle, role, added_at) VALUES (?, ?, 'member', 0)",
      agent.id,
      agent.handle,
    );
    sql.exec(
      "INSERT INTO collaborators (repo_id, principal_id, handle, role, added_at) VALUES (?, ?, ?, ?, 0)",
      repo.id,
      agent.id,
      agent.handle,
      role,
    );
  });
  return agent;
}

/** A team of the organization with `members`, given `permission` on the repository. */
async function team(name: string, members: readonly Who[], permission = "push") {
  const made = await ok<{ slug: string }>(
    api("POST", `/orgs/${org.login}/teams`, owner.token, { name }),
  );
  for (const m of members)
    await ok(
      api("PUT", `/orgs/${org.login}/teams/${made.slug}/memberships/${m.handle}`, owner.token),
    );
  await ok(
    api(
      "PUT",
      `/orgs/${org.login}/teams/${made.slug}/repos/${org.login}/${repo.name}`,
      owner.token,
      {
        permission,
      },
    ),
  );
  const id = await runInDurableObject(
    orgStub(),
    (_: OrgDO, state) =>
      state.storage.sql
        .exec<{ team_id: string }>("SELECT team_id FROM teams WHERE slug = ?", made.slug)
        .one().team_id,
  );
  return { id, slug: made.slug };
}

/** Teams put in the organization's records directly (many, quickly), each with write, the repository told. */
async function teamsInOrg(
  prefix: string,
  members: readonly (readonly Who[])[],
): Promise<{ id: string; slug: string }[]> {
  const made = members.map((_, i) => ({ id: `team_${prefix}${i}`, slug: `${prefix}-${i}` }));
  await inOrg((sql) => {
    for (const [i, team] of made.entries()) {
      sql.exec(
        "INSERT INTO teams (team_id, slug, name, created_at) VALUES (?, ?, ?, 0)",
        team.id,
        team.slug,
        team.slug,
      );
      sql.exec(
        "INSERT INTO team_repos (team_id, repo_id, role, added_at) VALUES (?, ?, 'write', 0)",
        team.id,
        repo.id,
      );
      for (const who of members[i] ?? [])
        sql.exec(
          "INSERT INTO team_members (team_id, principal_id, added_at) VALUES (?, ?, 0)",
          team.id,
          who.principalId,
        );
    }
  });
  return made;
}

/** People in the organization who can read the repository. */
async function readers(n: number): Promise<Who[]> {
  const made: Who[] = [];
  for (let i = 0; i < n; i++) {
    const who = await user();
    await ok(api("PUT", `/orgs/${org.login}/memberships/${who.handle}`, owner.token, {}));
    made.push(who);
  }
  return made;
}

beforeAll(async () => {
  admin = await user(true);
});

beforeEach(async () => {
  owner = await user();
  [alice, bob, carol, dave] = [await user(), await user(), await user(), await user()];
  const login = uniqueId("org").slice(0, 39);
  const made = await ok<{ id: string }>(
    api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle }),
  );
  org = { login, id: made.id };
  for (const m of [alice, bob, carol, dave])
    await ok(api("PUT", `/orgs/${login}/memberships/${m.handle}`, owner.token, {}));
  repo = await ok<{ id: string; name: string }>(
    api("POST", `/orgs/${login}/repos`, owner.token, { name: uniqueId("r") }),
  );
  path = `/repos/${login}/${repo.name}`;
  core = await team("Core", [alice, carol]);
  await ok(api("PUT", `${path}/collaborators/${bob.handle}`, owner.token, { permission: "push" }));
});

describe("asking code owners to review", () => {
  it("asks the owners of the changed paths, by the author, and none of unchanged paths", async () => {
    const from = await seq();
    await pullChanging({ "src/a.ts": "b\n", "docs/a.md": "b\n", "free/a.txt": "b\n" });
    expect(await requested()).toEqual({ users: ids(alice), teams: [core.id] });
    expect(await reasons()).toEqual(
      [`${alice.principalId}:${OWNERS}`, `${core.id}:${OWNERS}`].sort(),
    );
    expect(await ledger()).toEqual([`principal:${alice.principalId}`, `team:${core.id}`].sort());
    const all = await events(from);
    expect(asks(all)).toEqual(
      [
        `${alice.principalId} by ${owner.principalId}`,
        `team:${core.id} by ${owner.principalId}`,
      ].sort(),
    );
    // Told as a person's request tells them: the team's members too.
    const told = all
      .filter((e) => e.type === "pull_request.review_requested")
      .flatMap((e) => (e.feed?.audience ?? []).map((a) => a.principal));
    expect(told).toEqual(expect.arrayContaining(ids(alice, carol)));
  });

  it("never asks the author, nor an owner without write access", async () => {
    await pullChanging(
      { "src/a.ts": "b\n", "ro/a.txt": "b\n" },
      { file: `/src/ @${alice.handle} @${bob.handle}\n/ro/ @${dave.handle}`, author: bob },
    );
    expect(await requested()).toEqual({ users: ids(alice), teams: [] });
  });

  it("asks an agent owner that can write", async () => {
    const agent = await agentWith(alice);
    await pullChanging({ "src/a.ts": "b\n" }, { file: `/src/ @${agent.handle}` });
    expect((await requested()).users).toEqual([agent.id]);
  });

  it("asks no one while a draft, then on being marked ready", async () => {
    await pullChanging({ "src/a.ts": "b\n" }, { draft: true });
    // Its code owners read while a draft: worked out, asking no one.
    await ok(api("GET", `${path}/pulls/1/code-owners`, owner.token));
    await runJobs();
    expect(
      (await ok<{ state: string }>(api("GET", `${path}/pulls/1/code-owners`, owner.token))).state,
    ).toBe("complete");
    expect(await requested()).toEqual({ users: [], teams: [] });
    await ok(api("PATCH", `${path}/pulls/1`, owner.token, { draft: false }));
    await runJobs();
    expect((await requested()).users).toEqual(ids(alice));
    // Back to a draft: nothing is taken back.
    await ok(api("PATCH", `${path}/pulls/1`, owner.token, { draft: true }));
    await runJobs();
    expect((await requested()).users).toEqual(ids(alice));
  });

  it("asks only a new owner a push brings, and no one asked once before", async () => {
    await pullChanging({ "src/a.ts": "b\n" });
    await approve(alice);
    // Her review completed her request; a push changing her paths again does not ask her again.
    const from = await seq();
    await commit("feature", { "src/a.ts": "c\n", "lib/a.c": "b\n" });
    await runJobs();
    expect(asks(await events(from))).toEqual([`${bob.principalId} by ${owner.principalId}`]);
    expect((await requested()).users).toEqual(ids(bob));
  });

  it("takes back an automatic request whose owner no longer owns a changed path, not a person's", async () => {
    await pullChanging({ "src/a.ts": "b\n", "lib/a.c": "b\n" });
    expect((await requested()).users).toEqual(ids(alice, bob));
    // A person asks bob too: his request carries both reasons.
    await ask({ reviewers: [bob.handle] });
    expect(await reasons()).toEqual(
      [`${alice.principalId}:${OWNERS}`, `${bob.principalId}:${OWNERS | MANUAL}`].sort(),
    );
    const from = await seq();
    await commit("feature", { "src/a.ts": "a\n", "lib/a.c": "a\n", "other.txt": "b\n" });
    await runJobs();
    expect((await requested()).users).toEqual(ids(bob));
    expect(await reasons()).toEqual([`${bob.principalId}:${MANUAL}`]);
    expect(asks(await events(from), "pull_request.review_request_removed")).toEqual([
      `${alice.principalId} by ${owner.principalId}`,
    ]);
  });

  it("asks no one again whose automatic request a person withdrew", async () => {
    await pullChanging({ "src/a.ts": "b\n" });
    await unask({ reviewers: [alice.handle] });
    expect(await reasons()).toEqual([]);
    await commit("feature", { "src/a.ts": "c\n" });
    await runJobs();
    expect((await requested()).users).toEqual([]);
  });

  it("marks a person's request of an owner already asked automatically, with no new event", async () => {
    await pullChanging({ "src/a.ts": "b\n" });
    const from = await seq();
    await ask({ reviewers: [alice.handle] });
    expect(await reasons()).toEqual([`${alice.principalId}:${OWNERS | MANUAL}`]);
    expect(asks(await events(from))).toEqual([]);
  });

  it("makes a code owners' team request a person's too after the team grew past what a request asks", async () => {
    await pullChanging({ "docs/a.md": "b\n" });
    expect((await requested()).teams).toEqual([core.id]);
    await inOrg((sql) => {
      for (let i = 0; i < 2_001; i++)
        sql.exec(
          "INSERT INTO team_members (team_id, principal_id, added_at) VALUES (?, ?, 0)",
          core.id,
          `usr_grown${i}`,
        );
    });
    await ask({ team_reviewers: [core.slug] });
    expect(await reasons()).toEqual([`${core.id}:${OWNERS | MANUAL}`]);
    // Its paths no longer changed: the person's request stays.
    await commit("feature", { "docs/a.md": "a\n", "other.txt": "b\n" });
    await runJobs();
    expect(await reasons()).toEqual([`${core.id}:${MANUAL}`]);
  });

  it("asks owners a person asked already only by marking them", async () => {
    await pullChanging({ "src/a.ts": "b\n", "docs/a.md": "b\n" }, { settle: false });
    await ask({ reviewers: [alice.handle], team_reviewers: [core.slug] });
    const from = await seq();
    await runJobs();
    expect(asks(await events(from))).toEqual([]);
    expect(await reasons()).toEqual(
      [`${alice.principalId}:${OWNERS | MANUAL}`, `${core.id}:${OWNERS | MANUAL}`].sort(),
    );
  });

  it("asks owners of an author who can only read", async () => {
    const [reader] = await readers(1);
    await pullChanging({ "src/a.ts": "b\n" }, { author: reader as Who });
    const from = 0;
    expect(asks(await events(from))).toEqual([`${alice.principalId} by ${reader?.principalId}`]);
  });

  it("asks owners once places free, within the pull request's fifteen", async () => {
    const others = await readers(MAX_REQUESTED_REVIEWERS - 1);
    await pullChanging(
      { "src/a.ts": "b\n" },
      { file: `/src/ @${alice.handle} @${bob.handle}`, settle: false },
    );
    await ask({ reviewers: others.map((o) => o.handle) });
    await runJobs();
    // One place: the first owner written; the other waits, unasked.
    expect((await requested()).users).toEqual([...ids(alice, ...others)].sort());
    expect(await ledger()).toEqual([`principal:${alice.principalId}`]);
    await unask({ reviewers: [others[0]?.handle] });
    await runJobs();
    expect((await requested()).users).toContain(bob.principalId);
    expect(await ledger()).toEqual(
      ids(alice, bob)
        .map((id) => `principal:${id}`)
        .sort(),
    );
  });

  it("asks a waiting owner once a place frees between the slices of one pass", async () => {
    const others = await readers(MAX_REQUESTED_REVIEWERS - 1);
    const made = await teamsInOrg(uniqueId("t").toLowerCase(), [[], []]);
    await pullChanging(
      { "src/a.ts": "b\n", "lib/a.c": "b\n" },
      {
        file: `/src/ @${alice.handle} @${bob.handle}\n/lib/ ${made.map((t) => `@${org.login}/${t.slug}`).join(" ")}`,
        settle: false,
      },
    );
    await ask({ reviewers: others.map((o) => o.handle) });
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnerRequestPolicy = { ...r.codeOwnerRequestPolicy, maxTeams: 1 };
      let slices = 0;
      r.codeOwnerRequestHooks = {
        afterSlice: async () => {
          if (++slices === 1) await unask({ reviewers: [others[0]?.handle, others[1]?.handle] });
        },
      };
    });
    await drained();
    expect((await requested()).users).toEqual(expect.arrayContaining(ids(alice, bob)));
  });

  it("asks a team fitting the place a team too large to ask left free", async () => {
    const others = await readers(MAX_REQUESTED_REVIEWERS - 1);
    const [big, small] = await teamsInOrg(uniqueId("t").toLowerCase(), [[], [carol]]);
    await inOrg((sql) => {
      for (let i = 0; i < 2_001; i++)
        sql.exec(
          "INSERT INTO team_members (team_id, principal_id, added_at) VALUES (?, ?, 0)",
          big?.id,
          `usr_big${i}`,
        );
    });
    await pullChanging(
      { "src/a.ts": "b\n" },
      { file: `/src/ @${org.login}/${big?.slug} @${org.login}/${small?.slug}`, settle: false },
    );
    await ask({ reviewers: others.map((o) => o.handle) });
    await drained();
    expect((await requested()).teams).toEqual([small?.id]);
  });

  it("asks no owner again whose request a person made, the repository marked, and a person withdrew", async () => {
    await pullChanging({ "src/a.ts": "b\n", "docs/a.md": "b\n" }, { settle: false });
    await ask({ reviewers: [alice.handle], team_reviewers: [core.slug] });
    await runJobs();
    expect(await reasons()).toEqual(
      [`${alice.principalId}:${OWNERS | MANUAL}`, `${core.id}:${OWNERS | MANUAL}`].sort(),
    );
    await unask({ reviewers: [alice.handle], team_reviewers: [core.slug] });
    await commit("feature", { "src/a.ts": "c\n", "docs/a.md": "c\n" });
    await runJobs();
    expect(await requested()).toEqual({ users: [], teams: [] });
  });

  it("asks a smaller owner team while a larger one waits for members room", async () => {
    const [large, small] = await teamsInOrg(uniqueId("t").toLowerCase(), [
      [alice, carol, dave],
      [bob],
    ]);
    const others = await readers(MAX_REQUESTED_REVIEWERS - 2);
    await pullChanging(
      { "src/a.ts": "b\n" },
      { file: `/src/ @${org.login}/${large?.slug} @${org.login}/${small?.slug}`, settle: false },
    );
    // Two places: the larger team is read first and waits.
    await ask({ reviewers: others.map((o) => o.handle) });
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnerRequestPolicy = { ...r.codeOwnerRequestPolicy, maxAssociations: 2 };
    });
    await drained();
    expect((await requested()).teams).toEqual([small?.id]);
    expect(await waiting()).toEqual({ jobs: 0, waiting: ["room"] });
  });

  it("asks a waiting owner once a new request gives up the places of reviewers being deleted", async () => {
    const others = await readers(MAX_REQUESTED_REVIEWERS);
    await pullChanging({ "src/a.ts": "b\n" }, { settle: false });
    await ask({ reviewers: others.map((o) => o.handle) });
    await runJobs();
    expect(await waiting()).toEqual({ jobs: 0, waiting: ["room"] });
    for (const who of others.slice(0, 2))
      await env.DIRECTORY.prepare(
        "UPDATE principals SET lifecycle = 'deleting', disabled_at = 1 WHERE id = ?",
      )
        .bind(who.principalId)
        .run();
    await ask({ reviewers: [bob.handle] });
    await runJobs();
    expect((await requested()).users).toContain(alice.principalId);
  });

  it("asks owners again when the repository object is restored", async () => {
    await pullChanging({ "src/a.ts": "b\n" });
    await allocateEpoch(env.DIRECTORY, repo.id);
    await runInDurableObject(stub(), (_: RepoDO, state) => state.abort("restore")).catch(() => {});
    await stub().checkEpoch();
    expect((await waiting()).jobs).toBe(1);
  });

  it("lets owner teams wait for the pull request's members allowance apart from its places", async () => {
    await pullChanging({ "docs/a.md": "b\n" }, { settle: false });
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnerRequestPolicy = { ...r.codeOwnerRequestPolicy, maxAssociations: 1 };
    });
    await runJobs();
    // Core's two members do not fit one: it waits, until a request ends (none runs meanwhile).
    expect((await requested()).teams).toEqual([]);
    expect(await ledger()).toEqual([]);
    expect(await waiting()).toEqual({ jobs: 0, waiting: ["room"] });
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnerRequestPolicy = { ...r.codeOwnerRequestPolicy, maxAssociations: 10_000 };
    });
    await ask({ reviewers: [bob.handle] });
    await unask({ reviewers: [bob.handle] });
    await runJobs();
    expect((await requested()).teams).toEqual([core.id]);
  });

  it("skips an owner team with more members than one request asks, for good", async () => {
    const big = await team("Big", []);
    await inOrg((sql) => {
      for (let i = 0; i < 2_001; i++)
        sql.exec(
          "INSERT INTO team_members (team_id, principal_id, added_at) VALUES (?, ?, 0)",
          big.id,
          `usr_big${i}`,
        );
    });
    await pullChanging(
      { "src/a.ts": "b\n" },
      { file: `/src/ @${org.login}/${big.slug} @${alice.handle}` },
    );
    expect(await requested()).toEqual({ users: ids(alice), teams: [] });
    expect(await ledger()).toEqual([`principal:${alice.principalId}`, `team:${big.id}`].sort());
  });

  it("withdraws only the automatic request of a renamed team whose old slug another took", async () => {
    await pullChanging({ "docs/a.md": "b\n" });
    expect((await requested()).teams).toEqual([core.id]);
    // Core is renamed; a new team takes its old slug, and a person asks it.
    const other = await team("Other", [bob]);
    await inOrg((sql) => {
      sql.exec("UPDATE teams SET slug = 'renamed-core' WHERE team_id = ?", core.id);
      sql.exec("UPDATE teams SET slug = ? WHERE team_id = ?", core.slug, other.id);
    });
    await ask({ team_reviewers: [core.slug] });
    expect((await requested()).teams).toEqual([core.id, other.id].sort());
    await commit("feature", { "docs/a.md": "c\n" });
    await runJobs();
    // Core no longer owns docs/ (its slug moved): only its automatic request goes.
    expect((await requested()).teams).toEqual([other.id]);
    expect(await reasons()).toEqual([`${other.id}:${OWNERS | MANUAL}`]);
  });

  it("withdraws one of two requests carrying one team slug by its team's id", async () => {
    await pullChanging({ "docs/a.md": "b\n" });
    const other = await team("Other", [bob]);
    await inOrg((sql) => {
      sql.exec("UPDATE teams SET slug = 'renamed-core' WHERE team_id = ?", core.id);
      sql.exec("UPDATE teams SET slug = ? WHERE team_id = ?", core.slug, other.id);
    });
    await ask({ team_reviewers: [core.slug] });
    expect((await requested()).teams).toEqual([core.id, other.id].sort());
    // Both requests carry the slug they were asked by; the id names one.
    await unask({ team_ids: [other.id] });
    expect((await requested()).teams).toEqual([core.id]);
  });

  it("fails, never answers success, when an earlier object meets teams named by id", async () => {
    await pullChanging({ "docs/a.md": "b\n" });
    expect((await requested()).teams).toEqual([core.id]);
    // An earlier object (while a deploy rolls out) has no method taking team ids.
    const earlier = new Proxy(env.REPO, {
      get(target, prop) {
        if (prop === "getByName")
          return (name: string) =>
            new Proxy(target.getByName(name), {
              get(inner, key) {
                if (key === "removeRequestedReviewersById") return undefined;
                // The stub's own RPC methods, unbound (binding one loses its call).
                return Reflect.get(inner, key);
              },
            });
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const res = await createApp().fetch(
      new Request(`https://fyrden.test/api${path}/pulls/1/requested_reviewers`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${owner.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ team_ids: [core.id] }),
      }),
      // Every binding as it is (some are not own properties a spread would copy), REPO swapped.
      new Proxy(env, {
        get: (target, key) => (key === "REPO" ? earlier : Reflect.get(target, key)),
      }),
      createExecutionContext(),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect((await requested()).teams).toEqual([core.id]);
  });

  it("withdraws a principal's request by its id, whatever its handle says now", async () => {
    await pullChanging({ "src/a.ts": "b\n" });
    await ask({ reviewers: [bob.handle] });
    expect((await requested()).users).toContain(bob.principalId);
    // As a deleted user's: the handle becomes the id, the old one names no one.
    await env.DIRECTORY.prepare("UPDATE principals SET handle = id WHERE id = ?")
      .bind(bob.principalId)
      .run();
    await unask({ reviewers: [bob.handle] });
    expect((await requested()).users).toContain(bob.principalId);
    await unask({ reviewer_ids: [bob.principalId] });
    expect((await requested()).users).not.toContain(bob.principalId);
  });

  for (const next of ["no CODEOWNERS", "only unmatched paths", "only ownerless paths"] as const)
    it(`takes automatic requests back for ${next}, keeping a person's`, async () => {
      await pullChanging({ "src/a.ts": "b\n", "lib/a.c": "b\n" });
      await ask({ reviewers: [bob.handle] });
      if (next === "no CODEOWNERS") {
        await commit("main", { ".github/CODEOWNERS": null });
      } else {
        await commit("feature", {
          "src/a.ts": "a\n",
          "lib/a.c": "a\n",
          ...(next === "only unmatched paths" ? { "other.txt": "b\n" } : { "free/a.txt": "b\n" }),
        });
      }
      await runJobs();
      expect(await reasons()).toEqual([`${bob.principalId}:${MANUAL}`]);
    });

  it("finishes in a user's repository whose CODEOWNERS names a team under the user's handle", async () => {
    repo = await ok<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    );
    path = `/repos/${owner.handle}/${repo.name}`;
    // No collaborator: the user's account object has recorded nothing.
    await pullChanging({ "src/a.ts": "b\n" }, { file: `* @${owner.handle}/missing-team` });
    expect(await requested()).toEqual({ users: [], teams: [] });
    expect((await waiting()).jobs).toBe(0);
  });

  it("changes nothing for a result that cannot be judged", async () => {
    await pullChanging({ "src/a.ts": "b\n" });
    await commit("main", { ".github/CODEOWNERS": `/src/ @${alice.handle}\n/x/ not-an-owner\n` });
    await runJobs();
    expect(await reasons()).toEqual([`${alice.principalId}:${OWNERS}`]);
  });

  it("takes back an automatic request when the repository moves to an account without the team", async () => {
    await pullChanging({ "src/a.ts": "b\n", "docs/a.md": "b\n" });
    expect((await requested()).users).toEqual(ids(alice));
    const moved = await ok<{ state: string; repo: { name: string } }>(
      api("POST", `${path}/transfer`, owner.token, {
        new_owner: owner.handle,
        new_name: uniqueId("mine"),
      }),
    );
    expect(moved.state).toBe("transferred");
    path = `/repos/${owner.handle}/${moved.repo.name}`;
    await runJobs();
    // Alice wrote through Core, which the new owner does not have.
    expect(await reasons()).toEqual([]);
  });
});

describe("owners already satisfied, judged with fixed settings", () => {
  it("asks no owner who approved the head, and one owner for every rule it satisfies", async () => {
    await pullChanging(
      { "src/a.ts": "b\n", "lib/a.c": "b\n" },
      { file: `/src/ @${alice.handle}\n/lib/ @${alice.handle} @${bob.handle}`, settle: false },
    );
    await approve(alice);
    await runJobs();
    expect(await requested()).toEqual({ users: [], teams: [] });
    expect(await ledger()).toEqual([]);
  });

  it("tells a named agent from its user's other agents", async () => {
    const named = await agentWith(alice);
    const sibling = await agentWith(alice);
    await pullChanging({ "src/a.ts": "b\n" }, { file: `/src/ @${named.handle}`, settle: false });
    await approve(alice, sibling.own);
    await runJobs();
    expect((await requested()).users).toEqual([named.id]);
  });

  it("counts a delegated approval for its user, not once its agent is disabled", async () => {
    for (const disabled of [false, true]) {
      if (disabled) {
        repo = await ok<{ id: string; name: string }>(
          api("POST", `/orgs/${org.login}/repos`, owner.token, { name: uniqueId("r") }),
        );
        path = `/repos/${org.login}/${repo.name}`;
        await ok(
          api(
            "PUT",
            `/orgs/${org.login}/teams/${core.slug}/repos/${org.login}/${repo.name}`,
            owner.token,
            { permission: "push" },
          ),
        );
      }
      const agent = await agentFor(alice, ["pull_requests:write", "contents:read"]);
      await pullChanging({ "src/a.ts": "b\n" }, { settle: false });
      await approve(alice, agent.delegated);
      if (disabled) await ok(api("DELETE", `/agents/${agent.handle}`, alice.token));
      await runJobs();
      expect((await requested()).users).toEqual(disabled ? ids(alice) : []);
    }
  });

  it("asks no team one of whose members approved, and asks a user beside a read-only owner team", async () => {
    const readersTeam = await team("Readers", [carol], "pull");
    await ok(
      api("PUT", `${path}/collaborators/${carol.handle}`, owner.token, { permission: "push" }),
    );
    await pullChanging(
      { "docs/a.md": "b\n", "lib/a.c": "b\n" },
      {
        file: `/docs/ @${org.login}/${core.slug}\n/lib/ @${org.login}/${readersTeam.slug} @${bob.handle}`,
        settle: false,
      },
    );
    await approve(carol);
    await runJobs();
    expect(await requested()).toEqual({ users: ids(bob), teams: [] });
  });

  it("asks an owner whose approval is stale or whose latest review requests changes, whatever the rulesets", async () => {
    await ok(
      api("POST", `${path}/rulesets`, owner.token, {
        name: uniqueId("keep"),
        enforcement: "active",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
        rules: [
          {
            type: "pull_request",
            parameters: { dismiss_stale_reviews_on_push: false, require_code_owner_review: true },
          },
        ],
        bypass_actors: [{ actor_type: "RepositoryRole", actor_id: "admin" }],
      }),
    );
    await pullChanging(
      { "src/a.ts": "b\n", "lib/a.c": "b\n" },
      { file: `/src/ @${alice.handle}\n/lib/ @${bob.handle}`, settle: false },
    );
    await approve(alice);
    await approve(bob);
    await review("REQUEST_CHANGES", bob.token);
    await commit("feature", { "src/a.ts": "c\n" });
    await runJobs();
    expect((await requested()).users).toEqual(ids(alice, bob));
  });
});

describe("what a request job is fenced by", () => {
  it("runs again when a person asks someone while the owners are read, with no event twice", async () => {
    await pullChanging({ "src/a.ts": "b\n" }, { settle: false });
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnerRequestHooks = {
        beforeApply: async () => {
          r.codeOwnerRequestHooks = {};
          await ask({ reviewers: [alice.handle] });
        },
      };
    });
    const from = await seq();
    await runJobs();
    expect(asks(await events(from))).toEqual([`${alice.principalId} by ${owner.principalId}`]);
    expect(await reasons()).toEqual([`${alice.principalId}:${OWNERS | MANUAL}`]);
  });

  it("applies nothing for a head moved while the owners are read", async () => {
    await pullChanging({ "src/a.ts": "b\n" }, { settle: false });
    let moved = false;
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnerRequestHooks = {
        beforeApply: async () => {
          if (moved) return;
          moved = true;
          await commit("feature", { "src/a.ts": "a\n", "lib/a.c": "b\n" });
        },
      };
    });
    await runJobs();
    // The second head's owners only.
    expect((await requested()).users).toEqual(ids(bob));
    expect(await ledger()).toEqual([`principal:${bob.principalId}`]);
  });

  it("applies nothing for a result no longer shown once the owners are read (its base moved)", async () => {
    await pullChanging({ "src/a.ts": "b\n" }, { settle: false });
    let moved = false;
    await inRepo(stub(), (r: RepoDO) => {
      const acl = r.acl as unknown as { pullForWrite: () => Promise<void> };
      const real = acl.pullForWrite.bind(r.acl);
      acl.pullForWrite = async () => {
        if (
          !moved &&
          r.git.context.storage.sql.exec("SELECT 1 FROM code_owner_request_jobs").toArray().length >
            0
        ) {
          moved = true;
          await commit("main", { ".github/CODEOWNERS": `/src/ @${bob.handle}\n` });
        }
        return real();
      };
    });
    await runJobs();
    expect(moved).toBe(true);
    expect((await requested()).users).toEqual(ids(bob));
    expect(await ledger()).toEqual([`principal:${bob.principalId}`]);
  });

  it("reads again when a reviewer left out for want of write gains it while the reviewers are read", async () => {
    await pullChanging({ "src/a.ts": "b\n" }, { file: `/src/ @${dave.handle}`, settle: false });
    // Dave reads only when he approves: left out of the reviewers that matter.
    await approve(dave);
    // Bob's approval is read: his roles are pulled while the reviewers are, after the filter.
    await approve(bob);
    await inRepo(stub(), (r: RepoDO) => {
      const real = r.acl.roleOf.bind(r.acl);
      let granted = false;
      r.acl.roleOf = async (...args) => {
        if (
          !granted &&
          r.git.context.storage.sql.exec("SELECT 1 FROM code_owner_request_jobs").toArray().length >
            0
        ) {
          granted = true;
          await ok(
            api("PUT", `${path}/collaborators/${dave.handle}`, owner.token, { permission: "push" }),
          );
          await real(dave.principalId, "write");
        }
        return real(...args);
      };
    });
    await runJobs();
    // His approval satisfies the rule he owns once read with his write access.
    expect(await requested()).toEqual({ users: [], teams: [] });
    expect(await ledger()).toEqual([]);
  });

  it("reads again, taking nothing back, when the access cannot be read for an owner", async () => {
    await pullChanging({ "src/a.ts": "b\n" }, { file: `/src/ @${alice.handle} @${bob.handle}` });
    expect((await requested()).users).toEqual(ids(alice, bob));
    // While alice is qualified, the snapshot expires and its pull fails once; bob's pulls it again.
    await inRepo(stub(), (r: RepoDO) => {
      const real = r.acl.roleOf.bind(r.acl);
      const pull = r.pullAcl;
      let failed = false;
      r.acl.roleOf = async (principal, ...rest) => {
        if (!failed && principal === alice.principalId) {
          failed = true;
          r.git.context.storage.sql.exec("UPDATE acl_snapshot SET pulled_at = 1");
          r.pullAcl = async () => {
            r.pullAcl = pull;
            throw new Error("unavailable");
          };
        }
        return real(principal, ...rest);
      };
    });
    await commit("feature", { "src/a.ts": "c\n" });
    await runJobs();
    expect(await reasons()).toEqual(
      [`${alice.principalId}:${OWNERS}`, `${bob.principalId}:${OWNERS}`].sort(),
    );
  });

  it("asks no owner whose write access went while the owners were read", async () => {
    await pullChanging({ "src/a.ts": "b\n" }, { settle: false });
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnerRequestHooks = {
        beforeApply: async () => {
          r.codeOwnerRequestHooks = {};
          await inOrg((sql) =>
            sql.exec(
              "DELETE FROM team_members WHERE team_id = ? AND principal_id = ?",
              core.id,
              alice.principalId,
            ),
          );
        },
      };
    });
    await runJobs();
    expect((await requested()).users).toEqual([]);
  });

  it("asks an owner whose approval became a request for changes while the owners were read", async () => {
    await pullChanging({ "src/a.ts": "b\n" }, { settle: false });
    await approve(alice);
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnerRequestHooks = {
        beforeApply: async () => {
          r.codeOwnerRequestHooks = {};
          await review("REQUEST_CHANGES", alice.token);
        },
      };
    });
    await runJobs();
    expect((await requested()).users).toEqual(ids(alice));
  });
});

describe("a request job's bounds", () => {
  it("works through teams past a slice's, deciding a rule only once its last team is read", async () => {
    for (const teams of [17, 32]) {
      const made = await teamsInOrg(
        uniqueId("t").toLowerCase(),
        Array.from({ length: teams }, (_, i) => (i === teams - 1 ? [carol] : [])),
      );
      await ok(
        api("PUT", `${path}/collaborators/${carol.handle}`, owner.token, { permission: "push" }),
      );
      await pullChanging(
        { "src/a.ts": "b\n" },
        {
          // At most 32 owners a rule: alice beside 17 teams, the 32 teams alone.
          file: `/src/ ${made.map((t) => `@${org.login}/${t.slug}`).join(" ")}${teams < 32 ? ` @${alice.handle}` : ""}`,
          settle: false,
        },
      );
      await approve(carol);
      await drained();
      expect(
        (await ok<{ state: string }>(api("GET", `${path}/pulls/1/code-owners`, owner.token))).state,
      ).toBe("complete");
      expect(await requested()).toEqual({ users: [], teams: [] });
      // The next round in a repository of its own.
      repo = await ok<{ id: string; name: string }>(
        api("POST", `/orgs/${org.login}/repos`, owner.token, { name: uniqueId("r") }),
      );
      path = `/repos/${org.login}/${repo.name}`;
      core = await team(`Core${teams}`, [alice, carol]);
    }
  });

  it("never asks the author's agent in a rule read across slices", async () => {
    const agent = await agentWith(owner);
    const made = await teamsInOrg(uniqueId("t").toLowerCase(), [[carol], [carol], [carol]]);
    await pullChanging(
      { "src/a.ts": "b\n" },
      {
        file: `/src/ @${agent.handle} ${made.map((t) => `@${org.login}/${t.slug}`).join(" ")}`,
        settle: false,
      },
    );
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnerRequestPolicy = { ...r.codeOwnerRequestPolicy, maxTeams: 2 };
    });
    await drained();
    expect(await requested()).toEqual({ users: [], teams: made.map((t) => t.id).sort() });
  });

  it("asks no agent of a rule read across slices that was disabled between them", async () => {
    const agent = await agentWith(bob);
    const made = await teamsInOrg(uniqueId("t").toLowerCase(), [[], [], []]);
    await pullChanging(
      { "src/a.ts": "b\n" },
      {
        file: `/src/ @${agent.handle} ${made.map((t) => `@${org.login}/${t.slug}`).join(" ")}`,
        settle: false,
      },
    );
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnerRequestPolicy = { ...r.codeOwnerRequestPolicy, maxTeams: 2 };
      let slices = 0;
      r.codeOwnerRequestHooks = {
        afterSlice: async () => {
          if (++slices === 1)
            await env.DIRECTORY.prepare("UPDATE principals SET disabled_at = 1 WHERE id = ?")
              .bind(agent.id)
              .run();
        },
      };
    });
    await drained();
    expect(await requested()).toEqual({ users: [], teams: made.map((t) => t.id).sort() });
  });

  it("starts over when the user whose approval satisfied a rule read across slices no longer qualifies", async () => {
    // Carol, of the first team, approved too: the teams the first slice left unprobed satisfy it.
    const made = await teamsInOrg(uniqueId("t").toLowerCase(), [[carol], [], []]);
    await ok(
      api("PUT", `${path}/collaborators/${carol.handle}`, owner.token, { permission: "push" }),
    );
    await pullChanging(
      { "src/a.ts": "b\n" },
      {
        file: `/src/ @${alice.handle} @${bob.handle} ${made.map((t) => `@${org.login}/${t.slug}`).join(" ")}`,
        settle: false,
      },
    );
    await approve(alice);
    await approve(carol);
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnerRequestPolicy = { ...r.codeOwnerRequestPolicy, maxTeams: 2 };
      let resolving = 0;
      r.codeOwnerRequestHooks = {
        // The second slice: alice suspended after its reviewers were read, before her handle is.
        beforeResolve: async () => {
          if (++resolving === 2)
            await env.DIRECTORY.prepare(
              "UPDATE principals SET lifecycle = 'suspended', disabled_at = 1 WHERE id = ?",
            )
              .bind(alice.principalId)
              .run();
        },
      };
    });
    await drained();
    expect(await requested()).toEqual({ users: [], teams: [] });
  });

  it("starts over when a team's membership that satisfied a rule went, other organizations' teams left to read", async () => {
    // Carol, in Core, approved; the rest of the rule is another organization's teams.
    const foreign = Array.from({ length: 3 }, (_, i) => `@elsewhere/t${i}`);
    await pullChanging(
      { "src/a.ts": "b\n" },
      {
        file: `/src/ @${bob.handle} @${org.login}/${core.slug} ${foreign.join(" ")}`,
        settle: false,
      },
    );
    await ok(
      api("PUT", `${path}/collaborators/${carol.handle}`, owner.token, { permission: "push" }),
    );
    await approve(carol);
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnerRequestPolicy = { ...r.codeOwnerRequestPolicy, maxTeams: 1 };
      let slices = 0;
      r.codeOwnerRequestHooks = {
        afterSlice: async () => {
          // After the slice that found her in Core: she leaves it, the repository not told.
          if (++slices === 1)
            await inOrg(
              (sql) =>
                sql.exec(
                  "DELETE FROM team_members WHERE team_id = ? AND principal_id = ?",
                  core.id,
                  carol.principalId,
                ),
              false,
            );
        },
      };
    });
    await drained();
    expect(await requested()).toEqual({ users: ids(bob), teams: [core.id] });
  });

  it("probes a team's candidates across slices, finding its only member last", async () => {
    const extra = await readers(4);
    for (const who of extra)
      await ok(
        api("PUT", `${path}/collaborators/${who.handle}`, owner.token, { permission: "push" }),
      );
    await ok(
      api("PUT", `${path}/collaborators/${carol.handle}`, owner.token, { permission: "push" }),
    );
    await pullChanging(
      { "docs/a.md": "b\n" },
      { file: `/docs/ @${org.login}/${core.slug} @${bob.handle}`, settle: false },
    );
    for (const who of extra) await approve(who);
    await approve(carol);
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnerRequestPolicy = { ...r.codeOwnerRequestPolicy, maxProbes: 2 };
    });
    await drained();
    expect(await requested()).toEqual({ users: [], teams: [] });
  });

  it("asks a rule's owners after an entirely negative search across slices", async () => {
    const extra = await readers(4);
    for (const who of extra)
      await ok(
        api("PUT", `${path}/collaborators/${who.handle}`, owner.token, { permission: "push" }),
      );
    await pullChanging(
      { "docs/a.md": "b\n" },
      { file: `/docs/ @${org.login}/${core.slug} @${bob.handle}`, settle: false },
    );
    for (const who of extra) await approve(who);
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnerRequestPolicy = { ...r.codeOwnerRequestPolicy, maxProbes: 2 };
    });
    await drained();
    expect(await requested()).toEqual({ users: ids(bob), teams: [core.id] });
  });

  it("starts over when a candidate before its saved place goes, finding the member last", async () => {
    const agent = await agentWith(bob);
    const extra = await readers(1);
    for (const who of extra)
      await ok(
        api("PUT", `${path}/collaborators/${who.handle}`, owner.token, { permission: "push" }),
      );
    await ok(
      api("PUT", `${path}/collaborators/${carol.handle}`, owner.token, { permission: "push" }),
    );
    await pullChanging(
      { "docs/a.md": "b\n" },
      { file: `/docs/ @${org.login}/${core.slug}`, settle: false },
    );
    await approve(bob, agent.own);
    for (const who of extra) await approve(who);
    await approve(carol);
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnerRequestPolicy = { ...r.codeOwnerRequestPolicy, maxProbes: 2 };
      let slices = 0;
      r.codeOwnerRequestHooks = {
        afterSlice: async () => {
          // Disabled in the directory alone: its review, the repository's ACL and its reviews' stamp stay.
          if (++slices === 1)
            await env.DIRECTORY.prepare("UPDATE principals SET disabled_at = 1 WHERE id = ?")
              .bind(agent.id)
              .run();
        },
      };
    });
    await drained();
    expect(await requested()).toEqual({ users: [], teams: [] });
    expect(await ledger()).toEqual([]);
  });

  it("starts over when a membership before its saved place is added, its repository not told", async () => {
    const extra = await readers(3);
    for (const who of extra)
      await ok(
        api("PUT", `${path}/collaborators/${who.handle}`, owner.token, { permission: "push" }),
      );
    await pullChanging(
      { "docs/a.md": "b\n" },
      { file: `/docs/ @${org.login}/${core.slug} @${bob.handle}`, settle: false },
    );
    for (const who of extra) await approve(who);
    // Core is in the ledger already: asked once before (a person withdrew it since).
    await inRepo(stub(), (r: RepoDO) => {
      r.git.context.storage.sql.exec(
        "INSERT INTO code_owner_asked (pr_number, kind, id, asked_at) VALUES (1, 'team', ?, 0)",
        core.id,
      );
      r.codeOwnerRequestPolicy = { ...r.codeOwnerRequestPolicy, maxProbes: 2 };
      let slices = 0;
      r.codeOwnerRequestHooks = {
        afterSlice: async () => {
          if (++slices === 1)
            await inOrg(
              (sql) =>
                sql.exec(
                  "INSERT INTO team_members (team_id, principal_id, added_at) VALUES (?, ?, 0)",
                  core.id,
                  extra[0]?.principalId,
                ),
              false,
            );
        },
      };
    });
    await drained();
    expect(await requested()).toEqual({ users: [], teams: [] });
    expect(await ledger()).toEqual([`team:${core.id}`]);
  });

  it("starts a slice only in an invocation with room for all its directory queries", async () => {
    await pullChanging({ "src/a.ts": "b\n" }, { settle: false });
    // Alarms inside an invocation that ran other queries already: the request slice waits.
    const alarmsAfter = (spent: (r: RepoDO) => number) =>
      inRepo(stub(), async (r: RepoDO) => {
        for (let i = 0; i < 8; i++) {
          dueNow(r);
          await measureInvocation(r.git.context.metrics, { where: "do", op: "test" }, async () => {
            const invocation = currentInvocation();
            if (invocation) invocation.tally.d1 = spent(r);
            await r.alarm();
          });
        }
      });
    await alarmsAfter(
      (r) => D1_QUERIES_PER_INVOCATION - sliceQueries(r.codeOwnerRequestPolicy) + 1,
    );
    expect(await requested()).toEqual({ users: [], teams: [] });
    await alarmsAfter((r) => D1_QUERIES_PER_INVOCATION - sliceQueries(r.codeOwnerRequestPolicy));
    expect((await requested()).users).toEqual(ids(alice));
  });

  it("counts a cold alarm's epoch check against its slice's room", async () => {
    await pullChanging({ "src/a.ts": "b\n" }, { settle: false });
    /** Alarms in an invocation that ran `spent(r)` D1 statements before them. */
    const alarmsAfter = (rounds: number, spent: (r: RepoDO) => number) =>
      inRepo(stub(), async (r: RepoDO) => {
        for (let i = 0; i < rounds; i++) {
          dueNow(r);
          await measureInvocation(r.git.context.metrics, { where: "do", op: "test" }, async () => {
            const invocation = currentInvocation();
            if (invocation) invocation.tally.d1 = spent(r);
            await r.alarm();
          });
        }
      });
    // Its code owners worked out, the request job left with no room.
    await alarmsAfter(6, () => D1_QUERIES_PER_INVOCATION);
    expect(await requested()).toEqual({ users: [], teams: [] });
    // A new instance: its alarm checks its epoch in the directory first, which counts.
    await runInDurableObject(stub(), (_: RepoDO, state) => state.abort("cold")).catch(() => {});
    await alarmsAfter(1, (r) => D1_QUERIES_PER_INVOCATION - sliceQueries(r.codeOwnerRequestPolicy));
    expect(await requested()).toEqual({ users: [], teams: [] });
    await runJobs();
    expect((await requested()).users).toEqual(ids(alice));
    // Called by the platform with no invocation around it, the alarm counts its epoch check too.
    await runInDurableObject(stub(), (_: RepoDO, state) => state.abort("cold")).catch(() => {});
    const counted = await inRepo(stub(), async (r: RepoDO) => {
      const real = r.checkEpoch.bind(r);
      // The first check, the one that may read the directory.
      let inside: boolean | undefined;
      r.checkEpoch = async () => {
        inside ??= currentInvocation() !== undefined;
        return real();
      };
      await r.alarm();
      return inside;
    });
    expect(counted).toBe(true);
  });

  it("works a largest file through the queue within an invocation's directory queries", async () => {
    // 128 rules of 32 owners no one has (4,096 owner tokens, the parser's most), each deciding
    // a changed path, in two pull requests.
    const rules: string[] = [];
    const files: Record<string, string> = {};
    for (let i = 0; i < 128; i++) {
      const owners = Array.from({ length: 32 }, (_, j) => `@nobody-${i}-${j}`);
      rules.push(`/big/f${i}.txt ${owners.join(" ")}`);
      files[`big/f${i}.txt`] = "b\n";
    }
    // Changed in commits of at most a hundred files.
    const entries = Object.entries(files);
    await pullChanging(Object.fromEntries(entries.slice(0, 64)), {
      file: rules.join("\n"),
      settle: false,
    });
    await commit("feature", Object.fromEntries(entries.slice(64)));
    await commit("main", { "other.txt": "moved\n" });
    await branchAt("second", await commit("feature", { "src/a.ts": "c\n" }));
    await ok(
      api("POST", `${path}/pulls`, owner.token, { title: "Two", head: "second", base: "main" }),
    );
    const { most } = await drained(200);
    // One slice an invocation, within its own queries.
    expect(most).toBeLessThanOrEqual(sliceQueries(CODE_OWNER_REQUEST_POLICY));
    expect(await requested()).toEqual({ users: [], teams: [] });
  });

  it("reads activity only for reviewers who or whose root can write: many former reviewers cost nothing", async () => {
    await pullChanging({ "src/a.ts": "b\n", "lib/a.c": "b\n" }, { settle: false });
    const sha = await head();
    await inRepo(stub(), (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      for (let i = 0; i < 30_000; i++)
        sql.exec(
          `INSERT INTO reviews (pr_number, reviewer_id, reviewer_root, by_agent, state, commit_sha, submitted_at)
           VALUES (1, ?, ?, 0, 'APPROVED', ?, 0)`,
          `usr_gone${i}`,
          `usr_gone${i}`,
          sha,
        );
    });
    await approve(bob);
    // Each reviewer's own role from one read of the snapshot, not a read a reviewer.
    await inRepo(stub(), (r: RepoDO) => {
      const self = r as unknown as { allowsCalls: number };
      self.allowsCalls = 0;
      const real = r.acl.allows.bind(r.acl);
      r.acl.allows = (...args) => {
        self.allowsCalls++;
        return real(...args);
      };
    });
    const { most } = await drained();
    expect(most).toBeLessThanOrEqual(50);
    const allowsCalls = await inRepo(
      stub(),
      (r: RepoDO) => (r as unknown as { allowsCalls: number }).allowsCalls,
    );
    expect(allowsCalls).toBeLessThan(1_000);
    expect((await requested()).users).toEqual(ids(alice));
    // A merge of it asks the directory within an invocation's queries too.
    await ok(
      api("POST", `${path}/rulesets`, owner.token, {
        name: uniqueId("owners"),
        enforcement: "active",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
        rules: [{ type: "pull_request", parameters: { require_code_owner_review: true } }],
      }),
    );
    await approve(alice);
    const count = { queries: 0 };
    await inRepo(stub(), (r: RepoDO) => {
      const self = r as unknown as { env: Env };
      self.env = { ...self.env, DIRECTORY: countingD1(self.env.DIRECTORY, count) };
    });
    const merged = await json(api("PUT", `${path}/pulls/1/merge`, owner.token, {}));
    expect(merged.status).toBe(200);
    expect(count.queries).toBeLessThanOrEqual(50);
  });
});
