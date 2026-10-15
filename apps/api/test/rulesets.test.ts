// Rulesets: rules on the refs whose names match, checked at a push's commit
// point (and every other change of a ref goes through it), naming the
// ruleset in the refusal.

import { env, exports } from "cloudflare:workers";
import { gzipSync } from "node:zlib";
import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { createFakeDataset } from "@fyrden/adapters-cloudflare/obs/testing";
import type { Ruleset } from "@fyrden/domain";
import { type Oid, oidFromHex, oidToHex } from "@fyrden/git-core";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import {
  checkPushRules,
  MAX_REFUSAL_BYTES,
  refusalOf,
  sharedSignatures,
} from "../src/do/repo/push-rules.js";
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
