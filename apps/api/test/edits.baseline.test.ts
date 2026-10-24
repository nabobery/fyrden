// Changes made from what a reader saw: each answer carries its `version`,
// and an update given it as `expected_version` (a label's also its
// `expected_id`) applies only while it is still so, else 409 `stale` and
// nothing changes. While a deploy rolls out, an earlier object, which
// cannot check it, fails the change rather than apply it unchecked.
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

let owner: Who;
let path: string;
let repoId: string;

beforeEach(async () => {
  owner = await user();
  const made = await json<{ id: string; name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
  );
  path = `/repos/${owner.handle}/${made.body.name}`;
  repoId = made.body.id;
});

type Versioned = {
  version: number;
  code?: string;
  current_version?: number;
  title?: string;
  body?: string | null;
};

/** `PATCH`es `at` twice from the same version: the first applies, the second is stale. */
async function raced(at: string, read: string, first: object, second: object) {
  const before = await json<Versioned>(api("GET", read, owner.token));
  const v = before.body.version;
  const one = await json<Versioned>(
    api("PATCH", at, owner.token, { ...first, expected_version: v }),
  );
  expect(one.status, JSON.stringify(one.body)).toBe(200);
  expect(one.body.version).toBeGreaterThan(v);
  const two = await json<Versioned>(
    api("PATCH", at, owner.token, { ...second, expected_version: v }),
  );
  // The refusal says where it is now: the first change's version.
  expect(two).toMatchObject({
    status: 409,
    body: { code: "stale", current_version: one.body.version },
  });
  return (await json<Versioned>(api("GET", read, owner.token))).body;
}

describe("updates from a version", () => {
  it("of an issue: the later edit from an old version is refused, the first stands", async () => {
    const issue = await json<{ number: number }>(
      api("POST", `${path}/issues`, owner.token, { title: "T", body: "b" }),
    );
    const at = `${path}/issues/${issue.body.number}`;
    const after = await raced(at, at, { title: "Bob's title" }, { body: "Alice's old copy" });
    expect(after).toMatchObject({ title: "Bob's title", body: "b" });
    // Without a version, as GitHub's: applied whatever changed.
    expect((await api("PATCH", at, owner.token, { body: "plain" })).status).toBe(200);
  });

  it("of a comment and of a milestone", async () => {
    const issue = await json<{ number: number }>(
      api("POST", `${path}/issues`, owner.token, { title: "T" }),
    );
    const comment = await json<{ id: number }>(
      api("POST", `${path}/issues/${issue.body.number}/comments`, owner.token, { body: "c" }),
    );
    const c = `${path}/issues/comments/${comment.body.id}`;
    expect((await raced(c, c, { body: "first" }, { body: "second" })).body).toBe("first");
    const milestone = await json<{ number: number }>(
      api("POST", `${path}/milestones`, owner.token, { title: "v1" }),
    );
    const m = `${path}/milestones/${milestone.body.number}`;
    expect((await raced(m, m, { title: "v1.0" }, { title: "v1-old" })).title).toBe("v1.0");
  });

  it("of a pull request", async () => {
    await inRepo(env.REPO.getByName(repoId), (r: RepoDO) => {
      r.git.context.storage.sql.exec(
        `INSERT INTO pull_requests (number, title, state, draft, author_id, author_root, base_ref,
           base_sha, head_ref, head_sha, created_at, updated_at)
         VALUES (1, 'pull', 'open', 0, ?1, ?1, 'main', ?2, 'b', ?2, 1, 1)`,
        owner.principalId,
        "0".repeat(40),
      );
      r.git.context.storage.sql.exec("UPDATE repo_meta SET next_number = 2 WHERE id = 1");
    });
    const p = `${path}/pulls/1`;
    expect((await raced(p, p, { title: "first" }, { title: "second" })).title).toBe("first");
  });

  it("of a label: by its id too, so a name another label took since is refused", async () => {
    const made = await json<{ id: number; version: number }>(
      api("POST", `${path}/labels`, owner.token, { name: "bug-x", color: "ff0000" }),
    );
    // Renamed, and its old name taken by a new label.
    await api("PATCH", `${path}/labels/bug-x`, owner.token, { new_name: "defect-x" });
    await api("POST", `${path}/labels`, owner.token, { name: "bug-x", color: "00ff00" });
    const stale = await json<{ code: string }>(
      api("PATCH", `${path}/labels/bug-x`, owner.token, {
        color: "0000ff",
        expected_id: made.body.id,
      }),
    );
    // The version of the label the name names now.
    expect(stale).toMatchObject({ status: 409, body: { code: "stale", current_version: 1 } });
    const gone = await json<{ code: string }>(
      api("DELETE", `${path}/labels/bug-x`, owner.token, { expected_id: made.body.id }),
    );
    expect(gone).toMatchObject({ status: 409, body: { code: "stale" } });
    expect(
      (await json<{ color: string }>(api("GET", `${path}/labels/bug-x`, owner.token))).body.color,
    ).toBe("00ff00");
    // The renamed one, by its id and version: applied once, then stale.
    const renamed = await json<{ id: number; version: number }>(
      api("GET", `${path}/labels/defect-x`, owner.token),
    );
    const at = `${path}/labels/defect-x`;
    const expected = { expected_id: renamed.body.id, expected_version: renamed.body.version };
    expect((await api("PATCH", at, owner.token, { color: "111111", ...expected })).status).toBe(
      200,
    );
    expect(
      (
        await json<{ code: string }>(
          api("PATCH", at, owner.token, { color: "222222", ...expected }),
        )
      ).body.code,
    ).toBe("stale");
    expect(
      (await api("PATCH", at, owner.token, { color: "333333", expected_version: 1 })).status,
    ).toBe(422);
  });
});

describe("an earlier object, while a deploy rolls out", () => {
  it("fails a change with a precondition rather than apply it unchecked", async () => {
    const issue = await json<{ number: number; version: number }>(
      api("POST", `${path}/issues`, owner.token, { title: "T" }),
    );
    const earlier = new Proxy(env.REPO, {
      get(target, prop) {
        if (prop === "getByName")
          return (name: string) =>
            new Proxy(target.getByName(name), {
              get(inner, key) {
                if (typeof key === "string" && key.endsWith("At")) return undefined;
                // The stub's own RPC methods, unbound (binding one loses its call).
                return Reflect.get(inner, key);
              },
            });
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const res = await createApp().fetch(
      new Request(`https://fyrden.test/api${path}/issues/${issue.body.number}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${owner.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ title: "unchecked", expected_version: issue.body.version }),
      }),
      new Proxy(env, { get: (t, key) => (key === "REPO" ? earlier : Reflect.get(t, key)) }),
      createExecutionContext(),
    );
    expect(res.status).toBeGreaterThanOrEqual(500);
    const now = await json<{ title: string }>(
      api("GET", `${path}/issues/${issue.body.number}`, owner.token),
    );
    expect(now.body.title).toBe("T");
  });
});

describe("preconditions that must not tell", () => {
  it("compare a comment's version only where the caller may see it", async () => {
    await inRepo(env.REPO.getByName(repoId), (r: RepoDO) => {
      r.git.context.storage.sql.exec(
        `INSERT INTO pull_requests (number, title, state, draft, author_id, author_root, base_ref,
           base_sha, head_ref, head_sha, created_at, updated_at)
         VALUES (1, 'pull', 'open', 0, ?1, ?1, 'main', ?2, 'b', ?2, 1, 1)`,
        owner.principalId,
        "0".repeat(40),
      );
      r.git.context.storage.sql.exec("UPDATE repo_meta SET next_number = 2 WHERE id = 1");
    });
    const onPull = await json<{ id: number; version: number }>(
      api("POST", `${path}/issues/1/comments`, owner.token, { body: "on the pull request" }),
    );
    expect(onPull.status).toBe(201);
    const issuesOnly = await scopedToken(owner.principalId, ["issues:write", "issues:read"], "pat");
    const at = `${path}/issues/comments/${onPull.body.id}`;
    // Not found, whatever version is given, as for a comment that does not exist; nothing changed.
    for (const [id, v] of [
      [onPull.body.id, onPull.body.version],
      [onPull.body.id, onPull.body.version + 1],
      [999_999, 1],
    ] as const)
      expect(
        await json<{ code: string }>(
          api("PATCH", `${path}/issues/comments/${id}`, issuesOnly, {
            body: "x",
            expected_version: v,
          }),
        ),
      ).toMatchObject({ status: 404, body: { code: "comment_not_found" } });
    const still = await json<{ body: string }>(api("GET", at, owner.token));
    expect(still.body.body).toBe("on the pull request");
  });

  it("refuse adding or removing a label whose name another label took since", async () => {
    const issue = await json<{ number: number }>(
      api("POST", `${path}/issues`, owner.token, { title: "T" }),
    );
    const shown = await json<{ id: number }>(
      api("POST", `${path}/labels`, owner.token, { name: "pick-x", color: "ff0000" }),
    );
    await api("PATCH", `${path}/labels/pick-x`, owner.token, { new_name: "picked-x" });
    const taken = await json<{ id: number }>(
      api("POST", `${path}/labels`, owner.token, { name: "pick-x", color: "00ff00" }),
    );
    const labels = `${path}/issues/${issue.body.number}/labels`;
    const add = await json<{ code: string }>(
      api("POST", labels, owner.token, { labels: ["pick-x"], expected_ids: [shown.body.id] }),
    );
    expect(add).toMatchObject({ status: 409, body: { code: "stale" } });
    // With the label it names now: added; then a removal for the old one is refused.
    expect(
      (
        await api("POST", labels, owner.token, {
          labels: ["pick-x"],
          expected_ids: [taken.body.id],
        })
      ).status,
    ).toBe(200);
    const remove = await json<{ code: string }>(
      api("DELETE", `${labels}/pick-x`, owner.token, { expected_id: shown.body.id }),
    );
    expect(remove).toMatchObject({ status: 409, body: { code: "stale" } });
    const now = await json<{ labels: { name: string }[] }>(api("GET", labels, owner.token));
    expect(now.body.labels.map((l) => l.name)).toEqual(["pick-x"]);
    expect(
      (await api("POST", labels, owner.token, { labels: ["pick-x"], expected_ids: [] })).status,
    ).toBe(422);
  });
});
