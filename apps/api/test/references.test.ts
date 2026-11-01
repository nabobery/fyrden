// References between issues and pull requests: written with the text that
// makes them, here at once and in another repository by an effect applied
// in order; listed only to a caller that reads both ends; and closing
// keywords in a merged pull request's description close what they name,
// in another repository only while the merger's credential holds there.
import { env } from "cloudflare:workers";
import type { DomainEvent } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { REFERENCE_POLICY } from "../src/do/repo/references.js";
import type { Effect } from "../src/effects/journal.js";
import { referenceSink } from "../src/references/sink.js";
import { agentFor } from "./helpers/agents.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

type Listed = {
  references: {
    source: { repository: string; number: number; kind: string; comment_id: number | null };
  }[];
  next_cursor: string | null;
  code?: string;
};
type Repo = { id: string; name: string; path: string };

let owner: Who;
let here: Repo;

async function newRepo(who: Who): Promise<Repo> {
  const made = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", who.token, { name: uniqueId("r") }),
    )
  ).body;
  return { ...made, path: `/repos/${who.handle}/${made.name}` };
}

const commitOn = async (repo: Repo, branch: string, changes: Record<string, unknown>[]) => {
  const made = await json<{ commit: { sha: string } }>(
    api("POST", `${repo.path}/file-commits`, owner.token, { branch, message: "change", changes }),
  );
  expect(made.status).toBe(201);
  return made.body.commit.sha;
};

const fx = inject("pushFixtures");

/** `repo` with `main`, a `release` branch at the same commit, and `feature` one commit ahead. */
async function withBranches(repo: Repo): Promise<void> {
  const base = await commitOn(repo, "main", [{ path: "a.txt", content: "one\n" }]);
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
  const pushed = await postPush(
    target,
    pushBody(
      [
        { old: ZERO, new: base, ref: "refs/heads/feature" },
        { old: ZERO, new: base, ref: "refs/heads/release" },
      ],
      { pack: fx.packEmpty },
    ),
  );
  expect(pushed.report).toContain("ok refs/heads/feature\n");
  await commitOn(repo, "feature", [{ path: "a.txt", content: "one\ntwo\n" }]);
}

const issue = async (repo: Repo, body?: string, who = owner) =>
  (
    await json<{ number: number }>(
      api("POST", `${repo.path}/issues`, who.token, { title: "Issue", ...(body && { body }) }),
    )
  ).body.number;
const references = (repo: Repo, number: number, who = owner, query = "") =>
  json<Listed>(api("GET", `${repo.path}/issues/${number}/references${query}`, who.token));
const named = (listed: Listed) =>
  listed.references.map((r) => [r.source.repository, r.source.number, r.source.comment_id]);

/** The outbox's events of `type` in `repo`. */
const events = async (repo: Repo, type: string) =>
  (
    await inRepo(env.REPO.getByName(repo.id), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
        .toArray()
        .map((row) => JSON.parse(row.event) as DomainEvent),
    )
  ).filter((e) => e.type === type);

/** Delivers what `events` require of the references sink, as the dispatcher would. */
async function deliver(list: readonly DomainEvent[]): Promise<void> {
  for (const event of list)
    for (const planned of referenceSink.plan(event)) {
      const effect: Effect = {
        id: `${event.id.sourceId}:${planned.target}`,
        sink: referenceSink.name,
        target: planned.target,
        payload: planned.payload,
        attempts: 0,
      };
      await referenceSink.deliver(effect, env, env.DIRECTORY);
    }
}

beforeEach(async () => {
  owner = await user();
  here = await newRepo(owner);
});

describe("references in one repository", () => {
  it("follow the text that makes them: opened, edited, commented, deleted", async () => {
    const target = await issue(here);
    const source = await issue(here, `See #${target}, and #999 (none), and #1`);
    expect(named((await references(here, target)).body)).toEqual([
      [`${owner.handle}/${here.name}`, source, null],
    ]);
    // Naming itself is no reference.
    expect((await references(here, source)).body.references).toEqual([]);
    const comment = (
      await json<{ id: number }>(
        api("POST", `${here.path}/issues/${source}/comments`, owner.token, {
          body: `Also #${target}`,
        }),
      )
    ).body.id;
    expect(named((await references(here, target)).body)).toEqual([
      [`${owner.handle}/${here.name}`, source, null],
      [`${owner.handle}/${here.name}`, source, comment],
    ]);
    await api("PATCH", `${here.path}/issues/${source}`, owner.token, { body: "Nothing now" });
    await api("DELETE", `${here.path}/issues/comments/${comment}`, owner.token);
    expect((await references(here, target)).body.references).toEqual([]);
    // A deleted issue takes what it named, and what named it, with it.
    const again = await issue(here, `See #${target}`);
    await api("DELETE", `${here.path}/issues/${again}`, owner.token);
    expect((await references(here, target)).body.references).toEqual([]);
    expect((await references(here, again)).status).toBe(404);
  });

  it("show only to a caller that reads both ends", async () => {
    await withBranches(here);
    const target = await issue(here);
    const pr = (
      await json<{ number: number }>(
        api("POST", `${here.path}/pulls`, owner.token, {
          title: "Change",
          head: "feature",
          base: "main",
          body: `Touches #${target}`,
        }),
      )
    ).body.number;
    expect(named((await references(here, target)).body)).toEqual([
      [`${owner.handle}/${here.name}`, pr, null],
    ]);
    const issuesOnly = {
      ...owner,
      token: await scopedToken(owner.principalId, ["issues:read"], "pat"),
    };
    expect((await references(here, target, issuesOnly)).body.references).toEqual([]);
  });
});

describe("references across repositories", () => {
  it("reach the other repository in order, and show where the reader reads the source", async () => {
    const there = await newRepo(owner);
    const target = await issue(there);
    const source = await issue(here, `Related: ${owner.handle}/${there.name}#${target}`);
    expect((await references(there, target)).body.references).toEqual([]);
    const first = await events(here, "reference.sync");
    await deliver(first);
    expect(named((await references(there, target)).body)).toEqual([
      [`${owner.handle}/${here.name}`, source, null],
    ]);
    // A collaborator of the target's repository who cannot read the source sees none of it.
    const outsider = await user();
    await api("PUT", `${there.path}/collaborators/${outsider.handle}`, owner.token, {
      permission: "pull",
    });
    expect((await references(there, target, outsider)).body.references).toEqual([]);
    // Unnamed by an edit: the other repository is told so; an older set coming late changes nothing.
    await api("PATCH", `${here.path}/issues/${source}`, owner.token, { body: "Unrelated" });
    const later = (await events(here, "reference.sync")).slice(first.length);
    await deliver(later);
    expect((await references(there, target)).body.references).toEqual([]);
    await deliver(first);
    expect((await references(there, target)).body.references).toEqual([]);
  });
});

describe("references of a deleted issue, across repositories", () => {
  it("go with it in one event however many comments named them, and stale sets change nothing", async () => {
    const there = await newRepo(owner);
    const target = await issue(there);
    const name = `${owner.handle}/${there.name}#${target}`;
    const source = await issue(here, `Body: ${name}`);
    for (let i = 0; i < 5; i++)
      await api("POST", `${here.path}/issues/${source}/comments`, owner.token, {
        body: `Comment ${i}: ${name}`,
      });
    const made = await events(here, "reference.sync");
    expect(made).toHaveLength(6);
    await deliver(made);
    expect((await references(there, target)).body.references).toHaveLength(6);
    await api("DELETE", `${here.path}/issues/${source}`, owner.token);
    // One event for the whole issue, not one per comment.
    const gone = (await events(here, "reference.sync")).slice(made.length);
    expect(gone).toHaveLength(1);
    await deliver(gone);
    expect((await references(there, target)).body.references).toEqual([]);
    // The comments' earlier sets, delivered late, bring nothing back.
    await deliver(made);
    expect((await references(there, target)).body.references).toEqual([]);
  });

  it("leave what a restored source set since, when the deletion arrives late", async () => {
    const there = await newRepo(owner);
    const target = await issue(there);
    const source = await issue(here, `Body: ${owner.handle}/${there.name}#${target}`);
    const [set] = await events(here, "reference.sync");
    if (!set) throw new Error("no event");
    await api("DELETE", `${here.path}/issues/${source}`, owner.token);
    const gone = (await events(here, "reference.sync")).slice(1);
    // After a restore of the source repository (a newer generation), the same text names the
    // target again; that set arrives first, the deletion from before the restore after it.
    const restored = { ...set, id: { ...set.id, epochGen: set.id.epochGen + 1, sourceSeq: 1 } };
    await deliver([restored]);
    await deliver(gone);
    expect(named((await references(there, target)).body)).toEqual([
      [`${owner.handle}/${here.name}`, source, null],
    ]);
  });

  it("name at most a page of repositories an event", async () => {
    const was = REFERENCE_POLICY.forgetRepos;
    REFERENCE_POLICY.forgetRepos = 1;
    try {
      const [a, b] = [await newRepo(owner), await newRepo(owner)];
      const [ta, tb] = [await issue(a), await issue(b)];
      const source = await issue(
        here,
        `${owner.handle}/${a.name}#${ta} and ${owner.handle}/${b.name}#${tb}`,
      );
      await deliver(await events(here, "reference.sync"));
      const before = (await events(here, "reference.sync")).length;
      await api("DELETE", `${here.path}/issues/${source}`, owner.token);
      const gone = (await events(here, "reference.sync")).slice(before);
      expect(gone.map((e) => (e.data as { repos: unknown[] }).repos.length)).toEqual([1, 1]);
      await deliver(gone);
      expect((await references(a, ta)).body.references).toEqual([]);
      expect((await references(b, tb)).body.references).toEqual([]);
    } finally {
      REFERENCE_POLICY.forgetRepos = was;
    }
  });
});

describe("listing references", () => {
  it("pages with sealed cursors that tell nothing of references left out", async () => {
    const target = await issue(here);
    const other = await issue(here);
    const visible = await issue(here, `#${target}`);
    // Two sources in repositories the reader cannot read (made after this one: listed after it).
    const third = await user();
    const hidden: Repo[] = [await newRepo(third), await newRepo(third)];
    for (const [i, theirs] of hidden.entries())
      await env.REPO.getByName(here.id).applyReferences({
        sourceRepo: theirs.id,
        sourceNumber: 1,
        sourceComment: 0,
        sourceKind: "issue",
        numbers: [target],
        epochGen: 1,
        sourceSeq: i + 1,
      });
    // Pages hold only what the reader sees: the hidden sources take no page and no continuation.
    const first = await references(here, target, owner, "?per_page=1");
    expect(first.body).toEqual({
      references: [
        {
          source: {
            repository: `${owner.handle}/${here.name}`,
            number: visible,
            kind: "issue",
            comment_id: null,
          },
          created_at: expect.any(Number),
        },
      ],
      next_cursor: null,
    });
    const all = await references(here, target, owner);
    expect(named(all.body)).toEqual([[`${owner.handle}/${here.name}`, visible, null]]);
    // A cursor is one length whatever position it holds.
    const another = await issue(here, `#${target}`);
    const paged = await references(here, target, owner, "?per_page=1");
    const cursor = paged.body.next_cursor as string;
    expect(cursor).not.toBeNull();
    const next = await references(here, target, owner, `?per_page=1&cursor=${cursor}`);
    expect(named(next.body)).toEqual([[`${owner.handle}/${here.name}`, another, null]]);
    const bytes = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
    for (const theirs of hidden) expect(bytes).not.toContain(theirs.id);
    const lengths = new Set<number>();
    await inRepo(env.REPO.getByName(here.id), async (r: RepoDO) => {
      for (const n of [1, 10, 100, 1_000_000_000])
        for (const comment of [0, 7, 123_456_789]) {
          r.git.context.storage.sql.exec(
            `INSERT OR IGNORE INTO incoming_references
               (target, source_repo, source_kind, source_number, source_comment, created_at)
             VALUES (?, ?, 'issue', ?, ?, 1)`,
            other,
            here.id,
            n,
            comment,
          );
        }
      const rows = await r.references.page(other, null, 100);
      if (rows === "invalid_cursor") throw new Error("refused");
      for (const row of rows) lengths.add(row.cursor.length).add(row.groupEnd.length);
    });
    expect(lengths.size).toBe(1);
    // A cursor altered, or one for another issue, is refused.
    const altered = `${cursor.slice(0, -2)}${cursor.endsWith("AA") ? "BB" : "AA"}`;
    expect((await references(here, target, owner, `?cursor=${altered}`)).body.code).toBe(
      "invalid_cursor",
    );
    expect((await references(here, other, owner, `?cursor=${cursor}`)).body.code).toBe(
      "invalid_cursor",
    );
  });
});

describe("closing keywords", () => {
  async function mergedPull(repo: Repo, body: string, title = "Change", base = "main") {
    const pr = (
      await json<{ number: number }>(
        api("POST", `${repo.path}/pulls`, owner.token, { title, head: "feature", base, body }),
      )
    ).body.number;
    const merged = await api("PUT", `${repo.path}/pulls/${pr}/merge`, owner.token, {
      merge_method: "merge",
    });
    expect(merged.status).toBe(200);
    return pr;
  }
  const stateOf = async (repo: Repo, number: number) =>
    (
      await json<{ state: string; state_reason: string | null; closed_by: { id: string } | null }>(
        api("GET", `${repo.path}/issues/${number}`, owner.token),
      )
    ).body;

  it("close issues here when the description names them and the pull request merges into the default branch", async () => {
    await withBranches(here);
    const closes = await issue(here);
    const mentioned = await issue(here);
    const byTitle = await issue(here);
    const byFullName = await issue(here);
    await mergedPull(
      here,
      `Fixes #${closes}. See #${mentioned}. Closes ${owner.handle}/${here.name}#${byFullName}.`,
      `Fixes #${byTitle}`,
    );
    expect((await stateOf(here, byFullName)).state).toBe("closed");
    expect(await stateOf(here, closes)).toMatchObject({
      state: "closed",
      state_reason: "completed",
      closed_by: { id: owner.principalId },
    });
    expect((await stateOf(here, mentioned)).state).toBe("open");
    expect((await stateOf(here, byTitle)).state).toBe("open");
  });

  it("read the description as it is at the merge, whatever existed when it was written", async () => {
    await withBranches(here);
    // Named before it exists (the pull request is #1, the issue will be #2), and by this
    // repository's full name too: one target, closing.
    const pr = (
      await json<{ number: number }>(
        api("POST", `${here.path}/pulls`, owner.token, {
          title: "Change",
          head: "feature",
          base: "main",
          body: `Fixes #2. See ${owner.handle}/${here.name}#2.`,
        }),
      )
    ).body.number;
    const later = await issue(here);
    expect([pr, later]).toEqual([1, 2]);
    expect(
      (await api("PUT", `${here.path}/pulls/${pr}/merge`, owner.token, { merge_method: "merge" }))
        .status,
    ).toBe(200);
    expect((await stateOf(here, later)).state).toBe("closed");
  });

  it("close where the description pointed when written, though the name now names another repository", async () => {
    await withBranches(here);
    const there = await newRepo(owner);
    const closes = await issue(there);
    const pr = (
      await json<{ number: number }>(
        api("POST", `${here.path}/pulls`, owner.token, {
          title: "Change",
          head: "feature",
          base: "main",
          body: `Fixes ${owner.handle}/${there.name}#${closes}`,
        }),
      )
    ).body.number;
    // The repository is renamed, and its old name taken by a new one with an issue of that number.
    expect(
      (await api("PATCH", there.path, owner.token, { name: `${there.name}-renamed` })).status,
    ).toBe(200);
    const taken = (
      await json<{ id: string; name: string }>(
        api("POST", "/user/repos", owner.token, { name: there.name }),
      )
    ).body;
    const newcomer: Repo = { ...taken, path: `/repos/${owner.handle}/${taken.name}` };
    expect(await issue(newcomer)).toBe(closes);
    // The name's resolution here is stale: the merge resolves it again, to the newcomer.
    await inRepo(env.REPO.getByName(here.id), (r: RepoDO) =>
      r.git.context.storage.sql.exec("UPDATE resolved_repos SET resolved_at = 0"),
    );
    expect(
      (await api("PUT", `${here.path}/pulls/${pr}/merge`, owner.token, { merge_method: "merge" }))
        .status,
    ).toBe(200);
    await deliver(await events(here, "reference.close"));
    const renamed: Repo = { ...there, path: `/repos/${owner.handle}/${there.name}-renamed` };
    expect((await stateOf(renamed, closes)).state).toBe("closed");
    expect((await stateOf(newcomer, closes)).state).toBe("open");
  });

  it("are decided again when an acting agent's owner loses triage between decision and close", async () => {
    // An agent's own token: the agent closes, capped by its owner's role there.
    const target = await user();
    const theirs = await newRepo(target);
    const number = await issue(theirs, undefined, target);
    const agent = await agentFor(owner, ["issues:write"]);
    const handle = (await json<{ handle: string }>(api("GET", "/user", agent.own))).body.handle;
    const minted = await json<{ token: string }>(
      api("POST", `/agents/${handle}/tokens`, owner.token, { scopes: ["issues:write"] }),
    );
    expect(minted.status).toBe(201);
    const tokenId = (
      await env.DIRECTORY.prepare(
        "SELECT id FROM tokens WHERE principal_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      )
        .bind(agent.id)
        .first<{ id: string }>()
    )?.id as string;
    await api("PUT", `${theirs.path}/collaborators/${owner.handle}`, target.token, {
      permission: "triage",
    });
    const stub = env.REPO.getByName(theirs.id);
    // The agent's own role there (agents take roles through organizations; set here directly).
    const setRole = (r: RepoDO, principal: string, role: string) =>
      r.git.context.storage.sql.exec(
        `UPDATE acl_snapshot SET roles = json_set(roles, '$."' || ? || '"', ?),
           pulled_at = pulled_at + 1`,
        principal,
        role,
      );
    await inRepo(stub, async (r: RepoDO) => {
      await r.acl.refresh();
      setRole(r, agent.id, "triage");
      r.changeHooks.beforeChange = async (method) => {
        if (method !== "closeFromReference") return;
        r.changeHooks = {};
        // The owner's role drops to read in the snapshot the close is checked against.
        setRole(r, owner.principalId, "read");
      };
    });
    const close = (effectId: string) =>
      stub.closeFromReference({ effectId, number, principal: agent.id, tokenId, actChain: [] });
    expect(await close("ceiling-1")).toBe("retry");
    expect(
      (await json<{ state: string }>(api("GET", `${theirs.path}/issues/${number}`, target.token)))
        .body.state,
    ).toBe("open");
    // With both roles standing, the same close goes through.
    await inRepo(stub, (r: RepoDO) => setRole(r, owner.principalId, "triage"));
    expect(await close("ceiling-2")).toBe("closed");
  });

  it("keep each name's binding when one target is named two ways", async () => {
    await withBranches(here);
    const closes = await issue(here);
    const pr = (
      await json<{ number: number }>(
        api("POST", `${here.path}/pulls`, owner.token, {
          title: "Change",
          head: "feature",
          base: "main",
          body: `See #${closes}. Fixes ${owner.handle}/${here.name}#${closes}`,
        }),
      )
    ).body.number;
    // This repository is renamed, and its old name taken by a new one with an issue of that number.
    const oldName = here.name;
    expect(
      (await api("PATCH", here.path, owner.token, { name: `${oldName}-renamed` })).status,
    ).toBe(200);
    const renamed: Repo = { ...here, path: `/repos/${owner.handle}/${oldName}-renamed` };
    const taken = (
      await json<{ id: string; name: string }>(
        api("POST", "/user/repos", owner.token, { name: oldName }),
      )
    ).body;
    const newcomer: Repo = { ...taken, path: `/repos/${owner.handle}/${taken.name}` };
    while ((await issue(newcomer)) < closes);
    // The old name resolves to the newcomer now.
    await inRepo(env.REPO.getByName(here.id), (r: RepoDO) =>
      r.git.context.storage.sql.exec(
        "UPDATE resolved_repos SET repo_id = ?, resolved_at = ? WHERE name = ?",
        newcomer.id,
        Date.now(),
        `${owner.handle}/${oldName}`.toLowerCase(),
      ),
    );
    expect(
      (
        await api("PUT", `${renamed.path}/pulls/${pr}/merge`, owner.token, {
          merge_method: "merge",
        })
      ).status,
    ).toBe(200);
    await deliver(await events(renamed, "reference.close"));
    expect((await stateOf(renamed, closes)).state).toBe("closed");
    expect((await stateOf(newcomer, closes)).state).toBe("open");
  });

  it("close nothing a description names as itself, however its name is used later", async () => {
    await withBranches(here);
    const pr = (
      await json<{ number: number }>(
        api("POST", `${here.path}/pulls`, owner.token, {
          title: "Change",
          head: "feature",
          base: "main",
          body: `Fixes ${owner.handle}/${here.name}#1`,
        }),
      )
    ).body.number;
    expect(pr).toBe(1);
    const oldName = here.name;
    await api("PATCH", here.path, owner.token, { name: `${oldName}-renamed` });
    const renamed: Repo = { ...here, path: `/repos/${owner.handle}/${oldName}-renamed` };
    const taken = (
      await json<{ id: string; name: string }>(
        api("POST", "/user/repos", owner.token, { name: oldName }),
      )
    ).body;
    const newcomer: Repo = { ...taken, path: `/repos/${owner.handle}/${taken.name}` };
    expect(await issue(newcomer)).toBe(1);
    await inRepo(env.REPO.getByName(here.id), (r: RepoDO) =>
      r.git.context.storage.sql.exec(
        "UPDATE resolved_repos SET repo_id = ?, resolved_at = ? WHERE name = ?",
        newcomer.id,
        Date.now(),
        `${owner.handle}/${oldName}`.toLowerCase(),
      ),
    );
    expect(
      (
        await api("PUT", `${renamed.path}/pulls/${pr}/merge`, owner.token, {
          merge_method: "merge",
        })
      ).status,
    ).toBe(200);
    expect(await events(renamed, "reference.close")).toEqual([]);
    expect((await stateOf(newcomer, 1)).state).toBe("open");
    // Nor is it listed as referring to itself.
    expect((await references(renamed, pr)).body.references).toEqual([]);
  });

  it("close nothing when the pull request merges into another branch", async () => {
    await withBranches(here);
    const closes = await issue(here);
    await mergedPull(here, `Closes #${closes}`, "Change", "release");
    expect((await stateOf(here, closes)).state).toBe("open");
  });

  it("close an issue in another repository only while the merger's credential holds there", async () => {
    await withBranches(here);
    const there = await newRepo(owner);
    const closes = await issue(there);
    const assignee = await user();
    await api("PUT", `${there.path}/collaborators/${assignee.handle}`, owner.token, {
      permission: "pull",
    });
    await api("POST", `${there.path}/issues/${closes}/assignees`, owner.token, {
      assignees: [assignee.handle],
    });
    await mergedPull(here, `Resolves ${owner.handle}/${there.name}#${closes}`);
    // The description's references reach there first, then the close.
    await deliver(await events(here, "reference.sync"));
    const close = await events(here, "reference.close");
    expect(close).toHaveLength(1);
    // Its access list there is gone (as after a transfer): the close pulls it again before telling.
    await inRepo(env.REPO.getByName(there.id), (r: RepoDO) => r.acl.reset());
    await deliver(close);
    expect(await stateOf(there, closes)).toMatchObject({
      state: "closed",
      closed_by: { id: owner.principalId },
    });

    // Its close told the issue's assignee, though the access list there had to be pulled again.
    const told = (await events(there, "issue.closed")).flatMap((e) =>
      (e.feed?.audience ?? []).map((a) => [a.principal, a.kind, a.state]),
    );
    expect(told).toContainEqual([assignee.principalId, "assigned", "resolved"]);

    // Decided, then transferred before it applies: tried again, not applied on the old decision.
    const raced = await issue(there);
    await inRepo(env.REPO.getByName(there.id), async (r: RepoDO) => {
      r.changeHooks.beforeChange = async (method) => {
        if (method !== "closeFromReference") return;
        r.changeHooks = {};
        r.git.context.storage.sql.exec("UPDATE repo_meta SET owner_gen = owner_gen + 1");
      };
    });
    expect(
      await env.REPO.getByName(there.id).closeFromReference({
        effectId: "raced",
        number: raced,
        principal: owner.principalId,
        tokenId: ((close[0] as DomainEvent).data as { token_id: string }).token_id,
        actChain: [],
      }),
    ).toBe("retry");
    expect((await stateOf(there, raced)).state).toBe("open");

    // A merger with read access only there: refused for good (not retried), and audited.
    const third = await user();
    const theirs = await newRepo(third);
    const target = await issue(theirs, undefined, third);
    await api("PUT", `${theirs.path}/collaborators/${owner.handle}`, third.token, {
      permission: "pull",
    });
    const before = (await events(here, "reference.close")).length;
    await commitOn(here, "feature", [{ path: "c.txt", content: "c\n" }]);
    await mergedPull(here, `Fixes ${third.handle}/${theirs.name}#${target}`);
    await deliver((await events(here, "reference.close")).slice(before));
    expect(
      (await json<{ state: string }>(api("GET", `${theirs.path}/issues/${target}`, third.token)))
        .body.state,
    ).toBe("open");
    const refused = await inRepo(
      env.REPO.getByName(theirs.id),
      (r: RepoDO) =>
        r.git.context.storage.sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM audit_log WHERE action = 'issue.close_refused'",
          )
          .one().n,
    );
    expect(refused).toBe(1);
    // The same effect again changes nothing: refused for good, though access came since.
    await api("PUT", `${theirs.path}/collaborators/${owner.handle}`, third.token, {
      permission: "triage",
    });
    await deliver((await events(here, "reference.close")).slice(before));
    expect(
      (await json<{ state: string }>(api("GET", `${theirs.path}/issues/${target}`, third.token)))
        .body.state,
    ).toBe("open");
    // A close applied once is not applied again after the issue is reopened.
    await api("PATCH", `${there.path}/issues/${closes}`, owner.token, { state: "open" });
    await deliver(close);
    expect((await stateOf(there, closes)).state).toBe("open");
  });
});
