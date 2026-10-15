// Rulesets: rules on the refs whose names match, checked at a push's commit
// point (and every other change of a ref goes through it), naming the
// ruleset in the refusal.

import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { gzipSync } from "node:zlib";
import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { createFakeDataset } from "@fyrden/adapters-cloudflare/obs/testing";
import type { Ruleset } from "@fyrden/domain";
import { type Oid, oidFromHex, oidToHex, WalkLimitError } from "@fyrden/git-core";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import {
  checkPushRules,
  MAX_REFUSAL_BYTES,
  MAX_SIGNED_WALK,
  refusalOf,
  sharedSignatures,
} from "../src/do/repo/push-rules.js";
import { MAX_RULE_SUITES } from "../src/do/repo/rulesets.js";
import { ACCESS_LOST } from "../src/git/push/reauthorize.js";
import { ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE } from "../src/oauth/exchange.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { principalWithToken, scopedToken } from "./helpers/principals.js";
import { holdAfterRunPush, type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

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

/**
 * A git token of an agent of the owner's, acting for the owner under a grant
 * to write the repository: through public entry points only (the agent, its
 * token, the grant, the RFC 8693 exchange, then the git token).
 */
async function delegatedGitToken(): Promise<string> {
  const agent = await json<{ handle: string }>(
    api("POST", "/agents", owner.token, { handle: uniqueId("pr-bot").slice(0, 39) }),
  );
  const own = await json<{ token: string }>(
    api("POST", `/agents/${agent.body.handle}/tokens`, owner.token, {}),
  );
  const granted = await json<{ id: string }>(
    api("POST", "/grants", owner.token, {
      agent: agent.body.handle,
      scopes: ["contents:write"],
      repositories: [`${owner.handle}/${repo.name}`],
    }),
  );
  expect(granted.status).toBe(201);
  const exchanged = await exports.default.fetch("https://fyrden.test/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE,
      subject_token: own.body.token,
      subject_token_type: ACCESS_TOKEN_TYPE,
      grant_id: granted.body.id,
    }).toString(),
  });
  const delegated = (await exchanged.json<{ access_token: string }>()).access_token;
  const gitToken = await json<{ token: string }>(api("POST", "/user/git-tokens", delegated, {}));
  expect(gitToken.status).toBe(201);
  return gitToken.body.token;
}

describe("rulesets", () => {
  it("name each actor type once, at most every type", async () => {
    for (const actor_types of [["agent", "agent"], Array(400).fill("user")])
      expect(
        await ruleset({ rules: [{ type: "deletion" }], actor_types }),
        JSON.stringify(actor_types).slice(0, 40),
      ).toMatchObject({ status: 422, body: { code: "invalid_input" } });
    const made = await ruleset({ rules: [{ type: "deletion" }], actor_types: ["agent", "user"] });
    expect(made.status).toBe(201);
    const update = (actor_types: string[]) =>
      api("PUT", `${path}/rulesets/${made.body.id}`, owner.token, {
        name: uniqueId("rs"),
        enforcement: "active",
        conditions: { ref_name: { include: ["refs/heads/stable"] } },
        rules: [{ type: "deletion" }],
        actor_types,
      });
    expect((await update(["user", "user"])).status).toBe(422);
    expect((await update(["user"])).status).toBe(200);
  });

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

  it("record what evaluated rules would have blocked, signatures included, and block nothing", async () => {
    const watching = await ruleset({
      name: "watching",
      enforcement: "evaluate",
      rules: [{ type: "update" }, { type: "required_signatures" }],
    });
    expect(watching.status).toBe(201);
    const pushed = await postPush(
      await target(owner),
      pushBody([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }], { pack: fx.packC3ThinOnC2 }),
    );
    expect(pushed.report).toContain("ok refs/heads/main\n");
    const suites = await json<{
      rule_suites: {
        ref: string;
        before_sha: string;
        after_sha: string;
        actor_id: string;
        result: string;
        evaluation_result: string;
        rule_evaluations: {
          rule_source: { type: string; id: number; name: string };
          enforcement: string;
          result: string;
          rule_type: string;
          details: string;
        }[];
      }[];
      next_cursor: string | null;
    }>(api("GET", `${path}/rulesets/rule-suites`, owner.token));
    expect(suites.status).toBe(200);
    expect(suites.body.rule_suites).toHaveLength(1);
    const [suite] = suites.body.rule_suites;
    expect(suite).toMatchObject({
      ref: "refs/heads/main",
      before_sha: fx.c2,
      after_sha: fx.c3,
      actor_id: owner.principalId,
      result: "pass",
      evaluation_result: "fail",
    });
    expect(suite?.rule_evaluations.map((e) => e.rule_type).sort()).toEqual([
      "required_signatures",
      "update",
    ]);
    for (const evaluation of suite?.rule_evaluations ?? [])
      expect(evaluation).toMatchObject({
        rule_source: { type: "ruleset", id: watching.body.id, name: "watching" },
        enforcement: "evaluate",
        result: "fail",
      });
    // A push no evaluated rule objects to records nothing.
    await postPush(
      await target(owner),
      pushBody([{ old: ZERO, new: fx.c2, ref: "refs/heads/other" }], { pack: fx.packEmpty }),
    );
    expect(
      (
        await json<{ rule_suites: unknown[] }>(
          api("GET", `${path}/rulesets/rule-suites`, owner.token),
        )
      ).body.rule_suites,
    ).toHaveLength(1);
  });

  it("make agents use pull requests while their human pushes", async () => {
    await ruleset({
      name: "agents use PRs",
      actor_types: ["agent"],
      rules: [{ type: "pull_request" }],
    });
    const gitToken = await delegatedGitToken();
    const byAgent = await postPush(
      await target(owner, gitToken),
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

  it("hold an agent acting for its user to them at the commit, though they came after its upload", async () => {
    const gitToken = await delegatedGitToken();
    const held = holdAfterRunPush();
    const pending = postPush(
      await target(owner, gitToken),
      pushBody([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }], { pack: fx.packC3ThinOnC2 }),
      { bindings: { REPO: held.REPO } },
    );
    await held.accepted();
    await ruleset({
      name: "agents use PRs",
      actor_types: ["agent"],
      rules: [{ type: "pull_request" }],
    });
    held.resume();
    expect((await pending).report).toContain(
      'ng refs/heads/main changes must be made through a pull request (ruleset "agents use PRs")\n',
    );
    expect(await refs()).toContain(`main:${fx.c2}`);
  });

  it("refuse an agent whose owner lost access after the last check, at the commit", async () => {
    const alice = await user();
    await api("PUT", `${path}/collaborators/${alice.handle}`, owner.token, { permission: "push" });
    // Alice's agent, a writer of the repository itself (agents are granted in the account's object).
    const agent = await principalWithToken("agent", "pat", { owner: alice.principalId });
    const granted = await env.ORG.getByName(owner.principalId).setCollaborator(
      { principalId: owner.principalId },
      repo.id,
      { id: agent.principalId, handle: agent.principalId.toLowerCase().replace("_", "-") },
      "write",
    );
    if (!granted.ok) throw new Error(granted.error);
    await env.REPO.getByName(repo.id).invalidateAcl(
      owner.principalId,
      granted.epochGen,
      granted.version,
    );
    // Alice is removed after the Worker's last check, just before the object commits.
    let removed = 0;
    const hold = (stub: DurableObjectStub<RepoDO>) =>
      new Proxy(stub, {
        get(target, property) {
          if (property === "finalizePush")
            return async (...args: Parameters<RepoDO["finalizePush"]>) => {
              removed = (await api("DELETE", `${path}/collaborators/${alice.handle}`, owner.token))
                .status;
              return target.finalizePush(...args);
            };
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function"
            ? (...args: unknown[]) => Reflect.apply(value, target, args)
            : value;
        },
      });
    const REPO = new Proxy(env.REPO, {
      get(target, property) {
        if (property === "getByName") return (name: string) => hold(target.getByName(name));
        const value = (target as unknown as Record<PropertyKey, unknown>)[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const before = await refs();
    const reply = await postPush(
      await target(agent, await scopedToken(agent.principalId, [], "git")),
      pushBody([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }], { pack: fx.packC3ThinOnC2 }),
      { bindings: { REPO } },
    );
    expect(removed).toBeLessThan(300);
    expect(reply.report).toContain(`ng refs/heads/main ${ACCESS_LOST}\n`);
    expect(await refs()).toEqual(before);
  });

  it("show the branches they protect as protected, whoever asks", async () => {
    const branches = async () =>
      (
        await json<{ branches: { name: string; protected: boolean }[] }>(
          api("GET", `${path}/branches`, owner.token),
        )
      ).body.branches;
    expect((await branches()).some((b) => b.protected)).toBe(false);
    // Only reported, not enforced: still not protected.
    await ruleset({ name: "watch", enforcement: "evaluate", rules: [{ type: "deletion" }] });
    expect((await branches()).some((b) => b.protected)).toBe(false);
    await ruleset({
      name: "keep",
      conditions: { ref_name: { include: ["refs/heads/stable"] } },
      rules: [{ type: "deletion" }],
      bypass_actors: [{ actor_type: "RepositoryRole", actor_id: "admin", bypass_mode: "always" }],
    });
    // stable only; an administrator who bypasses it sees it protected too.
    expect(Object.fromEntries((await branches()).map((b) => [b.name, b.protected]))).toEqual({
      main: false,
      stable: true,
    });
    const detail = async (branch: string) =>
      (await json<{ protected: boolean }>(api("GET", `${path}/branches/${branch}`, owner.token)))
        .body.protected;
    expect(await detail("stable")).toBe(true);
    expect(await detail("main")).toBe(false);
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

  it("read the signatures of a push's commits once, however many refs share them", async () => {
    await ruleset({
      name: "signed",
      conditions: { ref_name: { include: ["~ALL"] } },
      rules: [{ type: "required_signatures" }],
    });
    // The repository object's index reads (R2) for a push of `count` refs to one tip.
    const indexReads = async (count: number) => {
      const object = createFakeDataset();
      await inRepo(env.REPO.getByName(repo.id), (r) => {
        r.metricsDataset = object.dataset;
      });
      const pushed = await postPush(
        await target(owner),
        pushBody(
          Array.from({ length: count }, (_, i) => ({
            old: ZERO,
            new: fx.c3,
            ref: `refs/heads/signed-${count}-${i}`,
          })),
          { pack: fx.packC3ThinOnC2 },
        ),
      );
      expect(pushed.report.filter((l) => l.startsWith("ok"))).toEqual([]);
      expect(pushed.report.filter((l) => /is unsigned/.test(l))).toHaveLength(count);
      return object.points
        .filter((p) => p.name === "r2.class_b" && p.blobs.includes("get_idx"))
        .reduce((sum, p) => sum + p.value, 0);
    };
    const one = await indexReads(1);
    // One reader for the whole check: its indexes are read once, not once per ref.
    expect(await indexReads(60)).toBe(one);
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

  it("refuse before anything is stored a gzip push and one with a long command section", async () => {
    await ruleset({
      name: "closed",
      conditions: { ref_name: { include: ["~ALL"] } },
      rules: [{ type: "creation" }, { type: "update" }],
    });
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
    // As JGit sends every push: gzip.
    const gzipped = await postPush(
      await target(owner),
      gzipSync(
        pushBody([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }], { pack: fx.packC3ThinOnC2 }),
      ),
      { bindings: { GIT }, headers: { "Content-Encoding": "gzip" } },
    );
    expect(gzipped.report).toContain(
      'ng refs/heads/main cannot update this ref (ruleset "closed")\n',
    );
    // A larger one: commands past 4 KiB, then 2 MiB that do not compress.
    const commands = pushBody(
      Array.from({ length: 100 }, (_, i) => ({
        old: ZERO,
        new: fx.c3,
        ref: `refs/heads/gz-${String(i).padStart(3, "0")}-${"y".repeat(60)}`,
      })),
      { pack: fx.packC3ThinOnC2 },
    );
    const body = new Uint8Array(commands.length + 2 * 1024 * 1024);
    body.set(commands);
    for (let at = commands.length; at < body.length; at += 65_536)
      crypto.getRandomValues(body.subarray(at, Math.min(at + 65_536, body.length)));
    const large = await postPush(await target(owner), gzipSync(body), {
      bindings: { GIT },
      headers: { "Content-Encoding": "gzip" },
    });
    expect(large.report.filter((l) => l.startsWith("ok"))).toEqual([]);
    expect(large.report.some((l) => l.includes('cannot create this ref (ruleset "closed")'))).toBe(
      true,
    );
    // A command section longer than the first 64 KiB of the body.
    const many = Array.from({ length: 800 }, (_, i) => ({
      old: ZERO,
      new: fx.c3,
      ref: `refs/heads/topic-${String(i).padStart(4, "0")}-${"x".repeat(40)}`,
    }));
    const long = await postPush(await target(owner), pushBody(many, { pack: fx.packC3ThinOnC2 }), {
      bindings: { GIT },
    });
    expect(long.report.filter((l) => l.startsWith("ok"))).toEqual([]);
    expect(long.report.some((l) => l.includes('cannot create this ref (ruleset "closed")'))).toBe(
      true,
    );
    expect(puts).toEqual([]);
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

describe("pull request rule parameters", () => {
  type Rules = { rules: { type: string; parameters?: Record<string, unknown> }[]; code?: string };

  it("are kept as given, defaults filled in, and read back in GitHub's shape", async () => {
    const created = await ruleset({
      rules: [
        {
          type: "pull_request",
          parameters: { required_approving_review_count: 2, allow_agent_approvals: true },
        },
        { type: "require_up_to_date" },
      ],
    });
    expect(created.status).toBe(201);
    const read = await json<Rules>(api("GET", `${path}/rulesets/${created.body.id}`, owner.token));
    expect(read.body.rules).toEqual([
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 2,
          dismiss_stale_reviews_on_push: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          require_code_owner_review: false,
          allowed_merge_methods: ["merge", "squash", "rebase"],
          allow_agent_approvals: true,
        },
      },
      { type: "require_up_to_date" },
    ]);
  });

  it("accept an empty required_reviewers, as GitHub clients send it", async () => {
    const created = await ruleset({
      rules: [{ type: "pull_request", parameters: { required_reviewers: [] } }],
    });
    expect(created.status).toBe(201);
  });

  it("take their defaults for a ruleset stored before they existed", async () => {
    const created = await ruleset({ rules: [{ type: "pull_request" }] });
    // As an earlier build stored it: the rule without parameters.
    await inRepo(env.REPO.getByName(repo.id), (r) => {
      r.git.context.storage.sql.exec(
        "UPDATE rulesets SET body = json_set(body, '$.rules', json('[{\"type\":\"pull_request\"}]')) WHERE id = ?",
        created.body.id,
      );
    });
    const read = await json<Rules>(api("GET", `${path}/rulesets/${created.body.id}`, owner.token));
    expect(read.body.rules[0]?.parameters).toMatchObject({
      required_approving_review_count: 0,
      allowed_merge_methods: ["merge", "squash", "rebase"],
      allow_agent_approvals: false,
    });
  });

  it("refuse code owners, parameters on another rule, and a method twice", async () => {
    for (const rules of [
      [{ type: "pull_request", parameters: { require_code_owner_review: true } }],
      [{ type: "deletion", parameters: { required_approving_review_count: 1 } }],
      [{ type: "pull_request", parameters: { allowed_merge_methods: ["squash", "squash"] } }],
      [{ type: "pull_request", parameters: { required_approving_review_count: 11 } }],
      // A requirement Fyrden does not enforce is refused, not dropped.
      [{ type: "pull_request", parameters: { required_reviewers: [{ reviewer: { id: 1 } }] } }],
      [{ type: "pull_request", parameters: { automatic_copilot_code_review_enabled: true } }],
    ])
      expect((await ruleset({ rules })).status).toBe(422);
  });

  it("leave direct pushes to a branch that only must be up to date alone", async () => {
    expect((await ruleset({ rules: [{ type: "require_up_to_date" }] })).status).toBe(201);
    const pushed = await postPush(
      await target(owner),
      pushBody([{ old: fx.c2, new: ZERO, ref: "refs/heads/stable" }]),
    );
    expect(pushed.report).toContain("ok refs/heads/stable\n");
  });
});

describe("rule checks", () => {
  it("ask for each commit's signature and each signature's verdict once a push", async () => {
    const asked: string[][] = [];
    const judged: string[][] = [];
    const fact = (key: string) => ({ reason: "signed" as const, key, committerEmail: "a@b" });
    const shared = sharedSignatures({
      git: {} as RepoGitStorage,
      signatures: async (oids) => {
        const hexes = oids.map((oid) => oidToHex(oid));
        asked.push(hexes);
        // The last commit cannot be read.
        return new Map(hexes.filter((h) => h !== "3".repeat(40)).map((h) => [h, fact(h[0] ?? "")]));
      },
      verdicts: async (facts) => {
        judged.push(facts.map((f) => f.key ?? ""));
        return facts.map((f) => ({ verified: f.key === "1", reason: "valid" }));
      },
    });
    const [a, b, c] = ["1", "2", "3"].map((d) => oidFromHex(d.repeat(40))) as [Oid, Oid, Oid];
    expect([...(await shared.signatures([a, b], [])).keys()]).toHaveLength(2);
    const second = await shared.signatures([b, c], []);
    expect([...second.keys()]).toEqual(["2".repeat(40)]);
    await shared.signatures([c], []);
    // Commits read are not asked for again; one that could not be read is.
    expect(asked).toEqual([["1".repeat(40), "2".repeat(40)], ["3".repeat(40)], ["3".repeat(40)]]);
    expect(await shared.verdicts([fact("1"), fact("2"), fact("1")])).toEqual([
      { verified: true, reason: "valid" },
      { verified: false, reason: "valid" },
      { verified: true, reason: "valid" },
    ]);
    await shared.verdicts([fact("2")]);
    expect(judged).toEqual([["1", "2"]]);
  });

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
    expect((await check(undefined)).refusals.size).toBe(0);
    expect([...(await check("refs/heads/master")).refusals.values()]).toEqual([
      'changes must be made through a pull request (ruleset "agents use PRs")',
    ]);
  });

  const rule = (
    id: number,
    enforcement: Ruleset["enforcement"],
    include: string,
    type: Ruleset["rules"][number]["type"],
  ): Ruleset => ({
    id,
    name: `${enforcement} ${id}`,
    target: "branch",
    enforcement,
    conditions: { ref_name: { include: [include], exclude: [] } },
    rules: [{ type }],
    bypass_actors: [],
  });
  const create = (index: number, name: string) => ({
    index,
    name,
    kind: "create" as const,
    oldOid: null,
    newOid: oidFromHex("1".repeat(40)),
    fastForward: false,
  });
  const noReads = {
    git: {} as RepoGitStorage,
    signatures: async () => new Map(),
    verdicts: async () => [],
  };

  it("record an evaluated finding as refused when an atomic push fails as a whole", async () => {
    const snapshot = {
      rulesets: [
        rule(1, "active", "refs/heads/locked", "creation"),
        rule(2, "evaluate", "refs/heads/watched", "creation"),
      ],
      head: "refs/heads/main",
      role: "write" as const,
    };
    const check = (atomic: boolean) =>
      checkPushRules(noReads, snapshot, {
        principal: "usr_01ABCDEFGHJKMNPQRSTVWXYZ01",
        uploadId: "u",
        packs: [],
        head: undefined,
        commands: [create(0, "refs/heads/locked"), create(1, "refs/heads/watched")],
        atomic,
      });
    const atomic = await check(true);
    expect([...atomic.refusals.keys()]).toEqual([0]);
    expect(atomic.evaluated).toMatchObject([{ ref: "refs/heads/watched", refused: true }]);
    expect((await check(false)).evaluated).toMatchObject([
      { ref: "refs/heads/watched", refused: false },
    ]);
  });

  it("keep evaluated findings for an update whose signatures an active rule refuses unchecked", async () => {
    const tip = oidFromHex("1".repeat(40));
    let reads = 0;
    const deps = {
      ...noReads,
      git: {
        commitGraph: {
          // The tip, then a history too long to walk.
          read: async () => {
            if (reads++ === 0)
              return [{ oid: tip, tree: tip, parents: [], generation: 1, level: 1, date: 0 }];
            throw new WalkLimitError(MAX_SIGNED_WALK);
          },
        },
      } as unknown as RepoGitStorage,
    };
    const snapshot = {
      rulesets: [
        rule(1, "active", "refs/heads/main", "required_signatures"),
        rule(2, "evaluate", "refs/heads/main", "required_signatures"),
        rule(3, "evaluate", "refs/heads/main", "creation"),
      ],
      head: "refs/heads/main",
      role: "write" as const,
    };
    const checked = await checkPushRules(deps, snapshot, {
      principal: "usr_01ABCDEFGHJKMNPQRSTVWXYZ01",
      uploadId: "u",
      packs: [],
      head: undefined,
      commands: [create(0, "refs/heads/main")],
    });
    expect([...checked.refusals.values()][0]).toContain("too long");
    expect(checked.evaluated[0]?.violations.map((v) => `${v.rulesetId} ${v.rule}`).sort()).toEqual([
      "2 required_signatures",
      "3 creation",
    ]);
  });

  it("keep the newest rule suites by their rows, though retried ones skip ids", async () => {
    const kept = await runInDurableObject(env.REPO.getByName(repo.id), (r: RepoDO) => {
      const store = r.rulesetStore;
      const update = (ref: string) => ({
        ref,
        before: null,
        after: "1".repeat(40),
        refused: false,
        violations: [{ rulesetId: 1, ruleset: "w", rule: "creation", message: "m" }],
      });
      for (let i = 0; i < MAX_RULE_SUITES; i++)
        store.recordEvaluated(`u${i}`, "usr_x", [update("refs/heads/a")]);
      // Retried commits record nothing new, but take ids.
      for (let i = 0; i < 5; i++) store.recordEvaluated("u0", "usr_x", [update("refs/heads/a")]);
      store.recordEvaluated("new", "usr_x", [update("refs/heads/a")]);
      return store.ruleSuites(MAX_RULE_SUITES + 10).length;
    });
    expect(kept).toBe(MAX_RULE_SUITES);
  });

  it("keep a refusal within one line of git's report", () => {
    const long = Array.from({ length: 50 }, (_, i) => `${"é".repeat(100)} ${i}`);
    const reason = refusalOf(long);
    expect(new TextEncoder().encode(reason).length).toBeLessThanOrEqual(MAX_REFUSAL_BYTES);
    expect(reason.endsWith("...")).toBe(true);
    expect(refusalOf(["short"])).toBe("short");
  });
});
