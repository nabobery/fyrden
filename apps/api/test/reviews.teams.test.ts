// Reviews requested of teams: a team of the repository's organization is
// asked through the members it has when asked (kept with the request), one
// of whom completes it by reviewing; withdrawing, completing or merging
// settles the members no other request still asks, in entries that stand
// across a transfer; a transfer drops the former organization's requests,
// and a restored organization's requests of teams it no longer has are
// settled too.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type DomainEvent,
  eventKey,
  type FeedBlock,
  MAX_FEED_AUDIENCE,
  MAX_REQUESTED_REVIEWERS,
} from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { OrgDO } from "../src/do/OrgDO.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { type EffectSink, planEffects } from "../src/effects/journal.js";
import { allocateEpoch } from "../src/events/epochs.js";
import { feedSink } from "../src/feed/sink.js";
import { entityBody } from "../src/webhooks/events.js";
import { agentFor } from "./helpers/agents.js";
import { api, user, type Who } from "./helpers/api.js";
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
let org: { login: string; id: string };
let repo: { id: string; name: string };
let path: string;

type Team = { id: string; slug: string; name: string };

const stub = () => env.REPO.getByName(repo.id);
const orgStub = () => env.ORG.getByName(org.id);

async function ok<T = Record<string, unknown>>(res: Promise<Response>): Promise<T> {
  const answer = await res;
  if (answer.status >= 300) throw new Error(`${answer.status}: ${await answer.text()}`);
  return (answer.status === 204 ? {} : await answer.json()) as T;
}

const outcome = async (res: Promise<Response>) => {
  const answer = await res;
  const body = await answer.json<{ code?: string }>();
  return { status: answer.status, code: body.code };
};

async function team(name: string, members: readonly Who[]): Promise<Team> {
  const created = await ok<{ slug: string }>(
    api("POST", `/orgs/${org.login}/teams`, owner.token, { name }),
  );
  for (const m of members)
    await ok(
      api("PUT", `/orgs/${org.login}/teams/${created.slug}/memberships/${m.handle}`, owner.token),
    );
  const id = await runInDurableObject(
    orgStub(),
    (_: OrgDO, state) =>
      state.storage.sql
        .exec<{ team_id: string }>("SELECT team_id FROM teams WHERE slug = ?", created.slug)
        .one().team_id,
  );
  return { id, slug: created.slug, name };
}

const request = (body: Record<string, unknown>, who: Who = owner, number = 1) =>
  api("POST", `${path}/pulls/${number}/requested_reviewers`, who.token, body);
const withdraw = (body: Record<string, unknown>, who: Who = owner, number = 1) =>
  api("DELETE", `${path}/pulls/${number}/requested_reviewers`, who.token, body);
const requested = async (number = 1) =>
  ok<{ users: { id: string }[]; teams: Team[] }>(
    api("GET", `${path}/pulls/${number}/requested_reviewers`, owner.token),
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
const ofType = (all: DomainEvent[], type: string) => all.filter((e) => e.type === type);

/** The settlement entries an event carries, as `principal:state[:silent]`, sorted. */
const settled = (event: DomainEvent | undefined) =>
  ((event?.data?.resolutions ?? []) as FeedBlock[])
    .flatMap((block) => block.audience)
    .map((a) => `${a.principal}:${a.kind}:${a.state}${a.silent ? ":silent" : ""}`)
    .sort();
/** Who an event's own feed block (the recipients it carries) tells, as `principal:kind:state`. */
const told = (event: DomainEvent | undefined) =>
  (event?.feed?.audience ?? []).map((a) => `${a.principal}:${a.kind}:${a.state}`).sort();
const entry = (who: Who, state: "open" | "resolved", silent = false) =>
  `${who.principalId}:review_requested:${state}${silent ? ":silent" : ""}`;

/** The rows a pull request's team requests keep: the requests, and their members' pages. */
const kept = () =>
  inRepo(stub(), (r: RepoDO) => {
    const sql = r.git.context.storage.sql;
    return {
      requests: sql.exec("SELECT request_id FROM review_team_requests").toArray().length,
      pages: sql.exec("SELECT request_id FROM review_request_audiences").toArray().length,
    };
  });

/** The organization restored to before `gone` was made: its new restore generation and ACL version. */
async function restoredWithout(gone: Team): Promise<{ epoch: number; version: number }> {
  const epoch = await allocateEpoch(env.DIRECTORY, org.id);
  const version = await runInDurableObject(orgStub(), (_: OrgDO, state) => {
    const sql = state.storage.sql;
    sql.exec("DELETE FROM team_members WHERE team_id = ?", gone.id);
    sql.exec("DELETE FROM teams WHERE team_id = ?", gone.id);
    return sql
      .exec<{ version: number }>(
        "UPDATE org_meta SET epoch_gen = ? RETURNING acl_version AS version",
        epoch,
      )
      .one().version;
  });
  return { epoch, version };
}

/** The repository's job settling team requests, as its queue keeps it. */
const reviewTeamsJob = () =>
  inRepo(
    stub(),
    (r: RepoDO) =>
      r.git.context.storage.sql
        .exec("SELECT state, attempts FROM jobs WHERE job_id = 'review_teams'")
        .toArray()[0],
  );
/** Makes every queued job of the repository due now. */
const dueNow = () =>
  inRepo(stub(), (r: RepoDO) => {
    r.git.context.storage.sql.exec(
      "UPDATE jobs SET next_run_at = ? WHERE state = 'queued'",
      r.git.context.now(),
    );
  });

/** Runs the repository's due jobs, a few rounds. */
const runJobs = async () => {
  for (let i = 0; i < 3; i++) await inRepo(stub(), (r: RepoDO) => r.alarm());
};

async function commitOn(branch: string, content: string): Promise<string> {
  return (
    await ok<{ commit: { sha: string } }>(
      api("POST", `${path}/file-commits`, owner.token, {
        branch,
        message: "change",
        changes: [{ path: "a.txt", content }],
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
    path: `/${org.login}/${repo.name}.git`,
  };
  const pushed = await postPush(
    target,
    pushBody([{ old: ZERO, new: sha, ref: `refs/heads/${name}` }], { pack: fx.packEmpty }),
  );
  expect(pushed.report).toContain(`ok refs/heads/${name}\n`);
}

/** Members added straight to the organization's tables (no one to sign in as), and to `slug`. */
async function manyMembers(slug: string, count: number): Promise<string[]> {
  return runInDurableObject(orgStub(), (_: OrgDO, state) => {
    const sql = state.storage.sql;
    const teamId = sql
      .exec<{ team_id: string }>("SELECT team_id FROM teams WHERE slug = ?", slug)
      .one().team_id;
    const ids = Array.from({ length: count }, (_, i) => `usr_${uniqueId("m")}${i}`);
    for (const id of ids) {
      sql.exec(
        "INSERT INTO members (principal_id, handle, role, added_at) VALUES (?, ?, 'member', 0)",
        id,
        id.toLowerCase().replace("_", "-"),
      );
      sql.exec(
        "INSERT INTO team_members (team_id, principal_id, added_at) VALUES (?, ?, 0)",
        teamId,
        id,
      );
    }
    // A new ACL version, as a membership change makes, but no repository told of it.
    sql.exec("UPDATE org_meta SET acl_version = acl_version + 1");
    return ids;
  });
}

type TeamAudienceOf = OrgDO["teamAudience"];

/**
 * Runs `body` while every organization object answers `teamAudience` with
 * `answer` (given the real method), as RPC calls reach it: through its class.
 */
async function withTeamAudience(
  answer: (
    this: OrgDO,
    read: TeamAudienceOf,
    ...args: Parameters<TeamAudienceOf>
  ) => ReturnType<TeamAudienceOf>,
  body: () => Promise<void>,
): Promise<void> {
  const proto = await runInDurableObject(orgStub(), (org: OrgDO) => Object.getPrototypeOf(org));
  const read = proto.teamAudience as TeamAudienceOf;
  proto.teamAudience = function (this: OrgDO, ...args: Parameters<TeamAudienceOf>) {
    return answer.call(this, read, ...args);
  };
  try {
    await body();
  } finally {
    proto.teamAudience = read;
  }
}

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
  await branchAt("feature", await commitOn("main", "one\n"));
  await commitOn("feature", "one\ntwo\n");
  await ok(
    api("POST", `${path}/pulls`, owner.token, { title: "A change", head: "feature", base: "main" }),
  );
});

describe("team review requests", () => {
  it("ask each member a team has when asked, list the team, and name it in the webhook", async () => {
    const core = await team("Core", [alice, bob]);
    await ok(
      api("POST", `${path}/hooks`, owner.token, {
        events: ["pull_request"],
        config: { url: "https://93.184.216.34/h" },
      }),
    );
    const from = await seq();
    expect((await request({ team_reviewers: [core.slug] })).status).toBe(201);
    expect(await requested()).toEqual({ users: [], teams: [core] });

    const [asked] = ofType(await events(from), "pull_request.review_requested");
    expect(asked?.data).toMatchObject({ number: 1, team: core });
    expect(typeof asked?.data?.request_id).toBe("number");
    expect(told(asked)).toEqual([entry(alice, "open"), entry(bob, "open")].sort());
    expect(asked?.feed?.audience.every((a) => a.reasons.includes("requested_team"))).toBe(true);
    const tree = (asked?.data?.webhook as { tree?: Record<string, unknown> } | undefined)?.tree;
    if (!tree) throw new Error("the request carries no webhook capture");
    expect(tree.requested_team).toEqual(core);
    expect("requested_reviewer" in tree).toBe(false);
  });

  it("refuse an unknown team, a team of a user's repository and more than the requests a pull request may have, leaving nothing", async () => {
    const core = await team("Core", [alice]);
    const from = await seq();
    expect(await outcome(request({ team_reviewers: ["nope"] }))).toEqual({
      status: 422,
      code: "team_not_found",
    });
    // Fourteen people and one team fill the places; one more team is past them.
    const people = await Promise.all(
      Array.from({ length: MAX_REQUESTED_REVIEWERS - 1 }, () => user()),
    );
    for (const p of people)
      await ok(api("PUT", `/orgs/${org.login}/memberships/${p.handle}`, owner.token, {}));
    await ok(request({ reviewers: people.map((p) => p.handle), team_reviewers: [core.slug] }));
    const other = await team("Other", [bob]);
    const at = await seq();
    expect(await outcome(request({ team_reviewers: [other.slug] }))).toEqual({
      status: 422,
      code: "too_many_reviewers",
    });
    expect(await events(at)).toEqual([]);
    expect((await requested()).teams).toEqual([core]);
    expect(ofType(await events(from), "pull_request.review_requested")).toHaveLength(
      MAX_REQUESTED_REVIEWERS,
    );

    // A user's account has no teams to ask.
    const answer = await env.ORG.getByName(owner.principalId).teamAudience(repo.id, [core.slug]);
    expect(answer.teams).toEqual([]);
    expect(answer.missing).toEqual([core.slug]);
  });

  it("need someone to ask, and refuse a team larger than a request may reach", async () => {
    expect(await outcome(request({}))).toEqual({ status: 422, code: "invalid_input" });
    // People and teams share the 15 places: more together is refused before anything is read.
    expect(
      await outcome(
        request({
          reviewers: Array.from({ length: 8 }, (_, i) => `someone-${i}`),
          team_reviewers: Array.from({ length: 8 }, (_, i) => `team-${i}`),
        }),
      ),
    ).toEqual({ status: 422, code: "invalid_input" });
    const big = await team("Big", []);
    await manyMembers(big.slug, 2_001);
    expect(await outcome(request({ team_reviewers: [big.slug] }))).toEqual({
      status: 422,
      code: "team_too_large",
    });
    expect(await kept()).toEqual({ requests: 0, pages: 0 });
  });

  it("keep the members a team had when asked: asking again changes nothing, and a later member cannot complete it", async () => {
    const core = await team("Core", [alice]);
    await ok(request({ team_reviewers: [core.slug] }));
    await ok(
      api("PUT", `/orgs/${org.login}/teams/${core.slug}/memberships/${bob.handle}`, owner.token),
    );
    const from = await seq();
    await ok(request({ team_reviewers: [core.slug] }));
    expect(await events(from)).toEqual([]);
    const head = await ok<{ head: { sha: string } }>(api("GET", `${path}/pulls/1`, owner.token));
    await ok(
      api("POST", `${path}/pulls/1/reviews`, bob.token, {
        commit_id: head.head.sha,
        event: "COMMENT",
        body: "late",
      }),
    );
    expect((await requested()).teams).toEqual([core]);
    await ok(
      api("POST", `${path}/pulls/1/reviews`, alice.token, {
        commit_id: head.head.sha,
        event: "COMMENT",
        body: "mine",
      }),
    );
    expect((await requested()).teams).toEqual([]);
    expect(await kept()).toEqual({ requests: 0, pages: 0 });
  });

  it("settle a withdrawn team's members unless another request still asks them, in entries that stand across a transfer", async () => {
    const one = await team("One", [alice, bob, carol]);
    const two = await team("Two", [carol]);
    await ok(request({ reviewers: [bob.handle], team_reviewers: [one.slug, two.slug] }));
    let from = await seq();
    await ok(withdraw({ team_reviewers: [one.slug] }));
    const [removed] = ofType(await events(from), "pull_request.review_request_removed");
    expect(removed?.data).toMatchObject({ number: 1, team: one });
    // Bob is still asked himself, Carol through the other team.
    expect(settled(removed)).toEqual([entry(alice, "resolved")]);
    expect(told(removed)).toEqual([]);
    const planned = feedSink.plan(removed as DomainEvent);
    expect(planned.map((p) => p.target)).toEqual(["res:1"]);
    expect(planned.every((p) => p.acrossTransfers === true)).toBe(true);
    const rows = planEffects([feedSink], [removed as DomainEvent]);
    expect(rows.map((r) => r.anyOwner)).toEqual([1]);

    // Withdrawing a person still asked through a team settles nothing of theirs; the last does.
    from = await seq();
    await ok(withdraw({ team_reviewers: [two.slug], reviewers: [bob.handle] }));
    const after = await events(from);
    expect(
      ofType(after, "pull_request.review_request_removed")
        .flatMap((e) => settled(e))
        .sort(),
    ).toEqual([entry(bob, "resolved"), entry(carol, "resolved")].sort());
    expect(after.flatMap((e) => told(e))).toEqual([]);
    expect(await requested()).toEqual({ users: [], teams: [] });
    expect(await kept()).toEqual({ requests: 0, pages: 0 });

    // A team not asked is no one to withdraw.
    from = await seq();
    expect((await withdraw({ team_reviewers: [one.slug] })).status).toBe(200);
    expect(await events(from)).toEqual([]);
  });

  it("complete a team's request when a member reviews, settling the members no one else asks", async () => {
    const core = await team("Core", [alice, bob, carol]);
    const solo = await team("Solo", [carol]);
    await ok(request({ team_reviewers: [core.slug, solo.slug] }));
    const head = await ok<{ head: { sha: string } }>(api("GET", `${path}/pulls/1`, owner.token));
    const from = await seq();
    await ok(
      api("POST", `${path}/pulls/1/reviews`, alice.token, {
        commit_id: head.head.sha,
        event: "APPROVE",
      }),
    );
    const [submitted] = ofType(await events(from), "pull_request_review.submitted");
    expect(settled(submitted)).toEqual(
      [entry(alice, "resolved", true), entry(bob, "resolved")].sort(),
    );
    expect(told(submitted).filter((t) => t.includes("review_requested"))).toEqual([]);
    expect((await requested()).teams).toEqual([solo]);
  });

  it("keep team requests through a close, settling even members who no longer read the repository, and ask the readers again when reopened", async () => {
    const core = await team("Core", [alice, bob]);
    await ok(request({ team_reviewers: [core.slug] }));
    // Bob leaves the organization: he no longer reads the repository.
    await ok(api("DELETE", `/orgs/${org.login}/memberships/${bob.handle}`, owner.token));
    let from = await seq();
    await ok(api("PATCH", `${path}/pulls/1`, owner.token, { state: "closed" }));
    const [closed] = ofType(await events(from), "pull_request.closed");
    expect(told(closed).filter((t) => t.includes("review_requested"))).toEqual(
      [entry(alice, "resolved"), entry(bob, "resolved")].sort(),
    );
    expect((await requested()).teams).toEqual([core]);
    expect(await kept()).toMatchObject({ requests: 1 });

    from = await seq();
    await ok(api("PATCH", `${path}/pulls/1`, owner.token, { state: "open" }));
    const [reopened] = ofType(await events(from), "pull_request.reopened");
    // Bob is asked again too, though he cannot read it now: should he read it again, his item
    // is as the request stands (feeds check access when read).
    expect(told(reopened).filter((t) => t.includes("review_requested"))).toEqual(
      [entry(alice, "open"), entry(bob, "open")].sort(),
    );
  });

  it("settle a merged pull request's team members, still listing the team", async () => {
    const core = await team("Core", [alice, bob]);
    await ok(request({ team_reviewers: [core.slug] }));
    const from = await seq();
    expect((await api("PUT", `${path}/pulls/1/merge`, owner.token, {})).status).toBe(200);
    const all = await events(from);
    expect(
      ofType(all, "pull_request.review_requests_settled")
        .flatMap((e) => settled(e))
        .sort(),
    ).toEqual([entry(alice, "resolved"), entry(bob, "resolved")].sort());
    expect((await requested()).teams).toEqual([core]);
    expect(await kept()).toEqual({ requests: 1, pages: 0 });
  });

  it("drop the former organization's team requests when the repository moves, settling their members after", async () => {
    const core = await team("Core", [alice, bob]);
    await ok(request({ team_reviewers: [core.slug], reviewers: [alice.handle] }));
    const moved = await ok<{ state: string; repo: { name: string } }>(
      api("POST", `${path}/transfer`, owner.token, {
        new_owner: owner.handle,
        new_name: uniqueId("mine"),
      }),
    );
    expect(moved.state).toBe("transferred");
    path = `/repos/${owner.handle}/${moved.repo.name}`;
    // Gone from the pull request at once; the members' items are settled by a job.
    expect((await requested()).teams).toEqual([]);
    const from = await seq();
    await runJobs();
    const settling = ofType(await events(from), "pull_request.review_requests_settled");
    // Alice is still asked herself.
    expect(settling.flatMap((e) => settled(e))).toEqual([entry(bob, "resolved")]);
    expect(
      planEffects([feedSink], settling).every((row) => row.anyOwner === 1 && row.sink === "feed"),
    ).toBe(true);
    expect(await kept()).toEqual({ requests: 0, pages: 0 });
    expect((await requested()).users.map((u) => u.id)).toEqual([alice.principalId]);
  });

  it("settle the requests of teams a restored organization no longer has", async () => {
    const core = await team("Core", [alice]);
    const kept_ = await team("Kept", [bob]);
    await ok(request({ team_reviewers: [core.slug, kept_.slug] }));
    // The organization goes back to before the team: a new restore generation, without it.
    const epoch = await allocateEpoch(env.DIRECTORY, org.id);
    const version = await runInDurableObject(orgStub(), (_: OrgDO, state) => {
      const sql = state.storage.sql;
      sql.exec("DELETE FROM team_members WHERE team_id = ?", core.id);
      sql.exec("DELETE FROM teams WHERE team_id = ?", core.id);
      return sql
        .exec<{ version: number }>(
          "UPDATE org_meta SET epoch_gen = ? RETURNING acl_version AS version",
          epoch,
        )
        .one().version;
    });
    // The repository hears of the newer generation (an ACL notice).
    await stub().invalidateAcl(org.id, epoch, version);
    const from = await seq();
    await runJobs();
    const settling = ofType(await events(from), "pull_request.review_requests_settled");
    expect(settling.flatMap((e) => settled(e))).toEqual([entry(alice, "resolved")]);
    expect((await requested()).teams).toEqual([kept_]);
  });

  it("accept a team against the access its members were read with, pulling it again when older", async () => {
    const big = await team("Many", [alice]);
    // The members join with a new ACL version the repository was not told of.
    const ids = await manyMembers(big.slug, 2_000 - 1);
    const from = await seq();
    await ok(request({ team_reviewers: [big.slug] }));
    const [asked] = ofType(await events(from), "pull_request.review_requested");
    const pages = asked?.feed?.pages ?? [];
    expect(asked?.feed?.audience).toHaveLength(MAX_FEED_AUDIENCE);
    expect(pages.reduce((n, p) => n + p.count, MAX_FEED_AUDIENCE)).toBe(2_000);
    const version = await runInDurableObject(
      orgStub(),
      (_: OrgDO, state) =>
        state.storage.sql.exec<{ v: number }>("SELECT acl_version AS v FROM org_meta").one().v,
    );
    const basis = await inRepo(stub(), (r: RepoDO) => r.acl.basis());
    expect(basis).toMatchObject({ accountId: org.id, version });

    // Withdrawn: 2,000 settlements travel in the event's stored data, a page of entries an effect.
    const at = await seq();
    await ok(withdraw({ team_reviewers: [big.slug] }));
    const [removed] = ofType(await events(at), "pull_request.review_request_removed");
    expect(settled(removed)).toHaveLength(2_000);
    expect(new Set(settled(removed).map((s) => s.split(":")[0]))).toEqual(
      new Set([alice.principalId, ...ids]),
    );
    const stored = await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ bytes: number; event: string }>(
          "SELECT bytes, event FROM outbox WHERE source_seq > ? ORDER BY source_seq",
          at,
        )
        .toArray(),
    );
    expect(
      stored.every(
        (row) => (JSON.parse(row.event) as DomainEvent).stored === true || row.bytes < 64 * 1024,
      ),
    ).toBe(true);
    const planned = feedSink.plan(removed as DomainEvent);
    expect(planned).toHaveLength(20);
    expect(planned.every((p) => p.acrossTransfers === true)).toBe(true);
    expect(planned.reduce((n, p) => n + (p.payload.feed as FeedBlock).audience.length, 0)).toBe(
      2_000,
    );
  });
});

describe("team review requests, when things go wrong", () => {
  it("answer that the teams could not be read when the organization fails, keeping nothing", async () => {
    const core = await team("Core", [alice]);
    await withTeamAudience(
      async () => {
        throw new Error("unavailable");
      },
      async () => {
        const from = await seq();
        expect(await outcome(request({ team_reviewers: [core.slug] }))).toEqual({
          status: 409,
          code: "team_audience_unavailable",
        });
        expect(await events(from)).toEqual([]);
        expect(await kept()).toEqual({ requests: 0, pages: 0 });
      },
    );
  });

  it("answer a team that cannot read the repository as one not found", async () => {
    const core = await team("Core", [alice]);
    await withTeamAudience(
      async function (this: OrgDO, read, ...args) {
        const answer = await read.apply(this, args);
        return { ...answer, teams: answer.teams.map((t) => ({ ...t, role: null })) };
      },
      async () => {
        expect(await outcome(request({ team_reviewers: [core.slug] }))).toEqual({
          status: 422,
          code: "team_not_found",
        });
      },
    );
    expect(await kept()).toEqual({ requests: 0, pages: 0 });
  });

  it("give up after a few reads of teams that never match the access the repository decides by", async () => {
    const core = await team("Core", [alice]);
    let reads = 0;
    await withTeamAudience(
      async function (this: OrgDO, read, ...args) {
        reads++;
        // Always older than any version the repository decides by.
        const answer = await read.apply(this, args);
        return { ...answer, version: answer.version - 1_000 };
      },
      async () => {
        const from = await seq();
        expect(await outcome(request({ team_reviewers: [core.slug] }))).toEqual({
          status: 409,
          code: "team_audience_unavailable",
        });
        expect(reads).toBe(3);
        expect(await events(from)).toEqual([]);
        expect(await kept()).toEqual({ requests: 0, pages: 0 });
      },
    );
  });

  it("list no team request while the repository moves, and list it again when the move is called off", async () => {
    const core = await team("Core", [alice]);
    await ok(request({ team_reviewers: [core.slug] }));
    const transferId = uniqueId("transfer");
    expect(
      await stub().freezeForTransfer({ transferId, from: org.id, to: owner.principalId }),
    ).toEqual({ ok: true });
    expect((await requested()).teams).toEqual([]);
    await stub().unfreezeTransfer(transferId);
    expect((await requested()).teams).toEqual([core]);
  });

  it("check the requested teams of a restored organization once a move is called off", async () => {
    const core = await team("Core", [alice]);
    await ok(request({ team_reviewers: [core.slug] }));
    const transferId = uniqueId("transfer");
    expect(
      await stub().freezeForTransfer({ transferId, from: org.id, to: owner.principalId }),
    ).toEqual({ ok: true });
    // Restored without the team while the repository moves: the job finds nothing standing.
    const epoch = await allocateEpoch(env.DIRECTORY, org.id);
    const version = await runInDurableObject(orgStub(), (_: OrgDO, state) => {
      const sql = state.storage.sql;
      sql.exec("DELETE FROM team_members WHERE team_id = ?", core.id);
      sql.exec("DELETE FROM teams WHERE team_id = ?", core.id);
      return sql
        .exec<{ version: number }>(
          "UPDATE org_meta SET epoch_gen = ? RETURNING acl_version AS version",
          epoch,
        )
        .one().version;
    });
    await stub().invalidateAcl(org.id, epoch, version);
    await runJobs();
    await stub().unfreezeTransfer(transferId);
    const from = await seq();
    await runJobs();
    const settling = ofType(await events(from), "pull_request.review_requests_settled");
    expect(settling.flatMap((e) => settled(e))).toEqual([entry(alice, "resolved")]);
    expect((await requested()).teams).toEqual([]);
  });

  it("keep checking the requested teams while the organization cannot answer, however long", async () => {
    const core = await team("Core", [alice]);
    await ok(request({ team_reviewers: [core.slug] }));
    const epoch = await restoredWithout(core);
    const proto = await runInDurableObject(orgStub(), (o: OrgDO) => Object.getPrototypeOf(o));
    const present = proto.teamsPresent;
    proto.teamsPresent = async () => {
      throw new Error("unavailable");
    };
    try {
      await stub().invalidateAcl(org.id, epoch.epoch, epoch.version);
      // More failures than a job's attempts: it waits and tries again, never failing.
      for (let i = 0; i < 12; i++) {
        await dueNow();
        await runJobs();
      }
      expect(await reviewTeamsJob()).toMatchObject({ state: "queued" });
    } finally {
      proto.teamsPresent = present;
    }
    const from = await seq();
    await dueNow();
    await runJobs();
    const settling = ofType(await events(from), "pull_request.review_requests_settled");
    expect(settling.flatMap((e) => settled(e))).toEqual([entry(alice, "resolved")]);
  });

  it("settle what a move left behind while the requested teams were being checked", async () => {
    const core = await team("Core", [alice]);
    await ok(request({ team_reviewers: [core.slug] }));
    const epoch = await restoredWithout(core);
    const proto = await runInDurableObject(orgStub(), (o: OrgDO) => Object.getPrototypeOf(o));
    const present = proto.teamsPresent;
    const repoId = repo.id;
    proto.teamsPresent = async function (this: OrgDO, ...args: Parameters<OrgDO["teamsPresent"]>) {
      // The repository lands under a new owner while it waits for this answer.
      await runInDurableObject(env.REPO.getByName(repoId), (r: RepoDO) => {
        r.git.context.storage.sql.exec("UPDATE repo_meta SET owner_gen = owner_gen + 1");
      });
      return present.apply(this, args);
    };
    const from = await seq();
    try {
      await stub().invalidateAcl(org.id, epoch.epoch, epoch.version);
      await runJobs();
    } finally {
      proto.teamsPresent = present;
    }
    const settling = ofType(await events(from), "pull_request.review_requests_settled");
    expect(settling.flatMap((e) => settled(e))).toEqual([entry(alice, "resolved")]);
    expect(await kept()).toEqual({ requests: 0, pages: 0 });
  });

  it("complete a team's request when a member's agent reviews for them", async () => {
    const core = await team("Core", [alice, bob]);
    await ok(request({ team_reviewers: [core.slug] }));
    const agent = await agentFor(alice, ["pull_requests:write"]);
    const head = await ok<{ head: { sha: string } }>(api("GET", `${path}/pulls/1`, owner.token));
    const from = await seq();
    await ok(
      api("POST", `${path}/pulls/1/reviews`, agent.delegated, {
        commit_id: head.head.sha,
        event: "COMMENT",
        body: "for alice",
      }),
    );
    expect((await requested()).teams).toEqual([]);
    const [submitted] = ofType(await events(from), "pull_request_review.submitted");
    // The agent acted for Alice: hers settles silently; Bob's is settled for him.
    expect(submitted?.actChain).toEqual([agent.id]);
    expect(settled(submitted)).toEqual(
      [entry(alice, "resolved", true), entry(bob, "resolved")].sort(),
    );
  });

  it("name the team in a review request's webhook body made without a capture", () => {
    const team = { id: "t1", slug: "core", name: "Core" };
    const event = (data: Record<string, unknown>) =>
      ({
        type: "pull_request.review_requested",
        data,
        entity: null,
      }) as unknown as DomainEvent;
    expect(
      entityBody({ event: "pull_request", action: "review_requested" }, event({ number: 1, team })),
    ).toEqual({ number: 1, requested_team: team });
    expect(
      entityBody(
        { event: "pull_request", action: "review_requested" },
        event({ number: 1, reviewer: "usr_a" }),
      ),
    ).toEqual({ number: 1, requested_reviewer: { id: "usr_a" } });
  });
});

describe("effects that stand across a transfer", () => {
  it("are chosen by the effect, a sink's own effects keeping the sink's choice", () => {
    const sink: EffectSink = {
      name: "mixed",
      plan: () => [
        { target: "a", payload: {} },
        { target: "b", payload: {}, acrossTransfers: true },
      ],
      deliver: async () => {},
    };
    const event = {
      id: { sourceId: "repo", epochGen: 1, sourceSeq: 1 },
      type: "x.y",
      at: 1,
      actor: null,
      actChain: [],
      data: null,
      entity: null,
      ownerGen: 1,
    } as unknown as DomainEvent;
    expect(planEffects([sink], [event]).map((r) => r.anyOwner)).toEqual([0, 1]);
    expect(
      planEffects([{ ...sink, acrossTransfers: true }], [event]).map((r) => r.anyOwner),
    ).toEqual([1, 1]);
  });
});
