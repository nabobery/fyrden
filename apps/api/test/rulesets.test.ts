// Rulesets: rules on the refs whose names match, checked at a push's commit
// point (and every other change of a ref goes through it), naming the
// ruleset in the refusal.

import { env } from "cloudflare:workers";
import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { Ruleset } from "@fyrden/domain";
import { oidFromHex } from "@fyrden/git-core";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { checkPushRules, MAX_REFUSAL_BYTES, refusalOf } from "../src/do/repo/push-rules.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { principalWithToken, scopedToken } from "./helpers/principals.js";
import { holdAfterRunPush, type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";

const fx = inject("pushFixtures");

let owner: Who;
let repo: { id: string; name: string };
let path: string;

async function target(who: { principalId: string }, token?: string): Promise<PushTarget> {
  return {
    repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
    owner: {
      principalId: who.principalId,
      token: token ?? (await scopedToken(who.principalId, [], "git")),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
}

const ruleset = (body: Record<string, unknown>) =>
  json<{ id: number; code?: string }>(
    api("POST", `${path}/rulesets`, owner.token, {
      name: uniqueId("rs"),
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH", "refs/heads/stable"] } },
      ...body,
    }),
  );

const refs = async () =>
  (
    await json<{ branches: { name: string; commit: { sha: string } }[] }>(
      api("GET", `${path}/branches`, owner.token),
    )
  ).body.branches.map((b) => `${b.name}:${b.commit.sha}`);

beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  const first = await postPush(
    await target(owner),
    pushBody([{ old: ZERO, new: fx.c2, ref: "refs/heads/main" }], { pack: fx.packC2 }),
  );
  expect(first.report).toContain("ok refs/heads/main\n");
  // A second branch to delete: git refuses to delete the current one.
  const stable = await postPush(
    await target(owner),
    pushBody([{ old: ZERO, new: fx.c2, ref: "refs/heads/stable" }], { pack: fx.packEmpty }),
  );
  expect(stable.report).toContain("ok refs/heads/stable\n");
});

describe("rulesets", () => {
  it("are created, read, renamed and deleted by administrators; readers see them", async () => {
    const made = await ruleset({ name: "protect", rules: [{ type: "deletion" }] });
    expect(made.status).toBe(201);
    expect(await ruleset({ name: "protect", rules: [{ type: "update" }] })).toMatchObject({
      status: 422,
      body: { code: "name_taken" },
    });
    const reader = await user();
    await api("PUT", `${path}/collaborators/${reader.handle}`, owner.token, { permission: "pull" });
    const listed = await json<{ rulesets: { name: string }[] }>(
      api("GET", `${path}/rulesets`, reader.token),
    );
    expect(listed.body.rulesets.map((r) => r.name)).toEqual(["protect"]);
    expect((await api("DELETE", `${path}/rulesets/${made.body.id}`, reader.token)).status).toBe(
      404,
    );
    const renamed = await json<{ name: string; target: string }>(
      api("PUT", `${path}/rulesets/${made.body.id}`, owner.token, {
        name: "renamed",
        enforcement: "active",
        conditions: { ref_name: { include: ["~ALL"] } },
        rules: [{ type: "deletion" }],
      }),
    );
    expect(renamed.body).toMatchObject({ name: "renamed", target: "branch" });
    expect((await api("DELETE", `${path}/rulesets/${made.body.id}`, owner.token)).status).toBe(200);
    expect((await api("GET", `${path}/rulesets/${made.body.id}`, owner.token)).status).toBe(404);
  });

  it("refuse a deletion or a force push, naming the ruleset; a fast-forward goes through", async () => {
    await ruleset({
      name: "keep main",
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
    });
    const before = await refs();
    const deletion = await postPush(
      await target(owner),
      pushBody([{ old: fx.c2, new: ZERO, ref: "refs/heads/stable" }]),
    );
    expect(deletion.report).toContain(
      'ng refs/heads/stable cannot delete this ref (ruleset "keep main")\n',
    );
    const forced = await postPush(
      await target(owner),
      pushBody([{ old: fx.c2, new: fx.c4, ref: "refs/heads/main" }], { pack: fx.packC4OnC1 }),
    );
    expect(forced.report).toContain(
      'ng refs/heads/main cannot force-push to this ref (ruleset "keep main")\n',
    );
    expect(await refs()).toEqual(before);
    const forward = await postPush(
      await target(owner),
      pushBody([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }], { pack: fx.packC3ThinOnC2 }),
    );
    expect(forward.report).toContain("ok refs/heads/main\n");
  });

  it("spare the roles that bypass them, and only report in evaluate mode", async () => {
    await ruleset({
      rules: [{ type: "deletion" }],
      bypass_actors: [{ actor_type: "RepositoryRole", actor_id: "admin" }],
    });
    await ruleset({ name: "watching", enforcement: "evaluate", rules: [{ type: "update" }] });
    const deleted = await postPush(
      await target(owner),
      pushBody([{ old: fx.c2, new: ZERO, ref: "refs/heads/stable" }]),
    );
    expect(deleted.report).toContain("ok refs/heads/stable\n");
  });

  it("make agents use pull requests while their human pushes", async () => {
    await ruleset({
      name: "agents use PRs",
      actor_types: ["agent"],
      rules: [{ type: "pull_request" }],
    });
    const agent = await principalWithToken("agent", "pat");
    const handle = agent.principalId.toLowerCase().replace("_", "-");
    // Agents are not collaborators through the API yet: granted in the account's object.
    const reader = await user();
    await api("PUT", `${path}/collaborators/${reader.handle}`, owner.token, { permission: "pull" });
    const account = env.ORG.getByName(owner.principalId);
    const granted = await account.setCollaborator(
      { principalId: owner.principalId },
      repo.id,
      { id: agent.principalId, handle },
      "write",
    );
    if (!granted.ok) throw new Error(granted.error);
    await env.REPO.getByName(repo.id).invalidateAcl(
      owner.principalId,
      granted.epochGen,
      granted.version,
    );
    const byAgent = await postPush(
      await target(agent, await scopedToken(agent.principalId, [], "git")),
      pushBody([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }], { pack: fx.packC3ThinOnC2 }),
    );
    expect(byAgent.report).toContain(
      'ng refs/heads/main changes must be made through a pull request (ruleset "agents use PRs")\n',
    );
    const byHuman = await postPush(
      await target(owner),
      pushBody([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }], { pack: fx.packC3ThinOnC2 }),
    );
    expect(byHuman.report).toContain("ok refs/heads/main\n");
  });

  it("fail a whole atomic push when one ref is refused", async () => {
    await ruleset({
      name: "no tags",
      target: "tag",
      conditions: { ref_name: { include: ["~ALL"] } },
      rules: [{ type: "creation" }],
    });
    const before = await refs();
    const reply = await postPush(
      await target(owner),
      pushBody(
        [
          { old: fx.c2, new: fx.c3, ref: "refs/heads/main" },
          { old: ZERO, new: fx.c2, ref: "refs/tags/v1" },
        ],
        { pack: fx.packC3ThinOnC2, caps: ["report-status", "atomic", "object-format=sha1"] },
      ),
    );
    expect(reply.report.filter((l) => l.startsWith("ok"))).toEqual([]);
    expect(reply.report).toContain('ng refs/tags/v1 cannot create this ref (ruleset "no tags")\n');
    expect(await refs()).toEqual(before);
  });

  it("are checked as they are at the commit, not as they were when the push began", async () => {
    const held = holdAfterRunPush();
    const pending = postPush(
      await target(owner),
      pushBody([{ old: fx.c2, new: ZERO, ref: "refs/heads/stable" }]),
      { bindings: { REPO: held.REPO } },
    );
    await held.accepted();
    await ruleset({ name: "late", rules: [{ type: "deletion" }] });
    held.resume();
    expect((await pending).report).toContain(
      'ng refs/heads/stable cannot delete this ref (ruleset "late")\n',
    );
  });

  it("require verified signatures on every new commit, its ancestors included", async () => {
    await ruleset({ name: "signed", rules: [{ type: "required_signatures" }] });
    // The fixture's commits are unsigned.
    const unsigned = await postPush(
      await target(owner),
      pushBody([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }], { pack: fx.packC3ThinOnC2 }),
    );
    expect(unsigned.report.find((l) => l.startsWith("ng refs/heads/main"))).toMatch(
      /commits must have verified signatures \([0-9a-f]{12} is unsigned\) \(ruleset "signed"\)/,
    );
    // A file write is signed by the platform: allowed.
    const write = await api("PUT", `${path}/contents/signed.txt`, owner.token, {
      message: "signed",
      content: btoa("s"),
    });
    expect(write.status).toBe(200);
    // An unsigned commit pushed to an unprotected branch, under a signed tip,
    // cannot reach main.
    const dev = await postPush(
      await target(owner),
      pushBody([{ old: ZERO, new: fx.c3, ref: "refs/heads/dev" }], { pack: fx.packC3ThinOnC2 }),
    );
    expect(dev.report).toContain("ok refs/heads/dev\n");
    const signedOnDev = await json<{ commit: { sha: string } }>(
      api("PUT", `${path}/contents/more.txt`, owner.token, {
        message: "signed on dev",
        content: btoa("m"),
        branch: "dev",
      }),
    );
    expect(signedOnDev.status).toBe(200);
    const head = (
      await json<{ commit: { sha: string } }>(api("GET", `${path}/branches/main`, owner.token))
    ).body.commit.sha;
    const promote = await postPush(
      await target(owner),
      pushBody([{ old: head, new: signedOnDev.body.commit.sha, ref: "refs/heads/main" }], {
        pack: fx.packEmpty,
      }),
    );
    expect(promote.report.find((l) => l.startsWith("ng refs/heads/main"))).toMatch(
      /commits must have verified signatures/,
    );
  });

  it("refuse before anything is stored: a push's body, an upload session, a file write", async () => {
    await ruleset({ name: "frozen", rules: [{ type: "update" }, { type: "deletion" }] });
    // The Worker's R2 writes, watched: the refused push stores no body.
    const puts: string[] = [];
    const GIT = new Proxy(env.GIT, {
      get(bucket, property) {
        if (property === "put")
          return (key: string, ...rest: unknown[]) => {
            puts.push(key);
            return (bucket.put as (...a: unknown[]) => unknown)(key, ...rest);
          };
        const value = Reflect.get(bucket, property);
        return typeof value === "function" ? value.bind(bucket) : value;
      },
    });
    const refused = await postPush(
      await target(owner),
      pushBody([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }], { pack: fx.packC3ThinOnC2 }),
      { bindings: { GIT } },
    );
    expect(refused.report).toContain(
      'ng refs/heads/main cannot update this ref (ruleset "frozen")\n',
    );
    expect(puts).toEqual([]);
    const session = await json<{ code: string }>(
      api("POST", `${path}/uploads`, owner.token, {
        size: 64,
        ref_updates: [{ ref: "refs/heads/main", old: fx.c2, new: fx.c3 }],
      }),
    );
    expect(session).toMatchObject({ status: 409, body: { code: "ruleset_violation" } });
    const write = await json<{ code: string }>(
      api("PUT", `${path}/contents/x.txt`, owner.token, { message: "x", content: btoa("x") }),
    );
    expect(write).toMatchObject({ status: 409, body: { code: "ruleset_violation" } });
    // A branch no ruleset names is not held up.
    const other = await postPush(
      await target(owner),
      pushBody([{ old: ZERO, new: fx.c3, ref: "refs/heads/topic" }], { pack: fx.packC3ThinOnC2 }),
      { bindings: { GIT } },
    );
    expect(other.report).toContain("ok refs/heads/topic\n");
    expect(puts).toHaveLength(1);
  });

  it("refuse required signatures on tag rulesets", async () => {
    const tag = await ruleset({
      target: "tag",
      conditions: { ref_name: { include: ["~ALL"] } },
      rules: [{ type: "required_signatures" }],
    });
    expect(tag).toMatchObject({ status: 422, body: { code: "invalid_input" } });
  });
});

describe("rule checks", () => {
  const agentsUsePrs: Ruleset = {
    id: 1,
    name: "agents use PRs",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "pull_request" }],
    bypass_actors: [],
    actor_types: ["agent"],
  };

  it("hold an import's new default branch to the default branch's rules", async () => {
    const deps = {
      git: {} as RepoGitStorage,
      signatures: async () => new Map(),
      verdicts: async () => [],
    };
    const snapshot = { rulesets: [agentsUsePrs], head: "refs/heads/main", role: "write" as const };
    const command = {
      index: 0,
      name: "refs/heads/master",
      kind: "create" as const,
      oldOid: null,
      newOid: oidFromHex("1".repeat(40)),
      fastForward: false,
    };
    const check = (head: string | undefined) =>
      checkPushRules(deps, snapshot, {
        principal: "agt_01ABCDEFGHJKMNPQRSTVWXYZ01",
        uploadId: "u",
        packs: [],
        head,
        commands: [command],
      });
    expect((await check(undefined)).size).toBe(0);
    expect([...(await check("refs/heads/master")).values()]).toEqual([
      'changes must be made through a pull request (ruleset "agents use PRs")',
    ]);
  });

  it("keep a refusal within one line of git's report", () => {
    const long = Array.from({ length: 50 }, (_, i) => `${"é".repeat(100)} ${i}`);
    const reason = refusalOf(long);
    expect(new TextEncoder().encode(reason).length).toBeLessThanOrEqual(MAX_REFUSAL_BYTES);
    expect(reason.endsWith("...")).toBe(true);
    expect(refusalOf(["short"])).toBe("short");
  });
});
