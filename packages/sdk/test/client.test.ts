import { describe, expect, it, vi } from "vitest";
import { FyrdenClient, FyrdenError } from "../src/index.js";

type Sent = { url: string; method: string; headers: Record<string, string>; body?: string };

function fake(responses: { status?: number; body: unknown }[]) {
  const sent: Sent[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      ...(init?.body !== undefined && { body: String(init.body) }),
    });
    const next = responses.shift() ?? { body: {} };
    // A 204 or 205 has no body.
    if (next.status === 204 || next.status === 205)
      return new Response(null, { status: next.status });
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  return { sent, fetchFn };
}

describe("FyrdenClient", () => {
  // A regex trim of the base URL's trailing slashes is quadratic on this shape
  // (tens of seconds); the deadline is far below that.
  it("takes its base URL in linear time, whatever the caller passes", { timeout: 5_000 }, () => {
    const { fetchFn } = fake([]);
    expect(
      () => new FyrdenClient({ baseUrl: `https://f.test/${"/".repeat(200_000)}x`, fetch: fetchFn }),
    ).not.toThrow();
  });

  it("gives null for an operation that answers nothing", async () => {
    const { sent, fetchFn } = fake([{ status: 204, body: null }]);
    const client = new FyrdenClient({ baseUrl: "https://f.test/api", token: "t", fetch: fetchFn });
    expect(await client.call("admin.users.suspend", { username: "someone" })).toBeNull();
    expect(sent[0]).toMatchObject({
      method: "PUT",
      url: "https://f.test/api/users/someone/suspended",
    });
  });

  it("gives null for an operation that answers 205 (Reset Content)", async () => {
    const { sent, fetchFn } = fake([{ status: 205, body: null }]);
    const client = new FyrdenClient({ baseUrl: "https://f.test/api", token: "t", fetch: fetchFn });
    expect(await client.call("notifications.thread_read", { thread_id: "abc" })).toBeNull();
    expect(sent[0]).toMatchObject({
      method: "PATCH",
      url: "https://f.test/api/notifications/threads/abc",
    });
  });

  it("sends path parameters in the path, the rest in the body, with a token and an idempotency key", async () => {
    const { sent, fetchFn } = fake([{ status: 201, body: { id: "rep_1", name: "x" } }]);
    const client = new FyrdenClient({
      baseUrl: "https://f.test/api/",
      token: "fyrden_pat_x",
      fetch: fetchFn,
    });
    const repo = await client.call("repos.update", {
      owner: "me",
      repo: "my repo",
      description: "d",
    });
    expect(repo).toMatchObject({ id: "rep_1" });
    expect(sent[0]).toMatchObject({
      url: "https://f.test/api/repos/me/my%20repo",
      method: "PATCH",
      body: JSON.stringify({ description: "d" }),
      headers: {
        Authorization: "Bearer fyrden_pat_x",
        "Content-Type": "application/json",
        "Idempotency-Key": expect.stringMatching(/^[0-9a-f-]{36}$/),
      },
    });
  });

  it("keeps a greedy parameter's slashes and puts a GET's fields in the query", async () => {
    const { sent, fetchFn } = fake([{ body: { type: "file" } }]);
    const client = new FyrdenClient({
      baseUrl: "https://f.test/api",
      fetch: fetchFn,
      token: () => "t",
    });
    await client.call("repos.contents.get", {
      owner: "me",
      repo: "r",
      path: "docs/a b.md",
      ref: "main",
    });
    expect(sent[0]?.url).toBe("https://f.test/api/repos/me/r/contents/docs/a%20b.md?ref=main");
    expect(sent[0]?.headers["Idempotency-Key"]).toBeUndefined();
  });

  it("reuses a given idempotency key, so a retry gets the first answer", async () => {
    const { sent, fetchFn } = fake([
      { status: 201, body: {} },
      { status: 201, body: {} },
    ]);
    const client = new FyrdenClient({ baseUrl: "https://f.test/api", fetch: fetchFn });
    for (let i = 0; i < 2; i++)
      await client.call("repos.create", { name: "x" }, { idempotencyKey: "k-1" });
    expect(sent.map((s) => s.headers["Idempotency-Key"])).toEqual(["k-1", "k-1"]);
  });

  it("throws a typed error with the problem's code and request id", async () => {
    const { fetchFn } = fake([
      {
        status: 403,
        body: {
          type: "about:blank",
          title: "Forbidden",
          status: 403,
          code: "missing_permission",
          detail: "repos.create needs repos:create",
          request_id: "req-1",
          missing_permission: "repos:create",
        },
      },
    ]);
    const client = new FyrdenClient({ baseUrl: "https://f.test/api", fetch: fetchFn });
    const error = await client.call("repos.create", { name: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FyrdenError);
    expect(error).toMatchObject({
      status: 403,
      code: "missing_permission",
      requestId: "req-1",
      missingPermission: "repos:create",
    });
  });

  it("keeps where to start over when a cursor expired", async () => {
    const { fetchFn } = fake([
      {
        status: 410,
        body: {
          type: "about:blank",
          status: 410,
          code: "cursor_expired",
          detail: "start over",
          resync: "/api/feed/sync",
        },
      },
    ]);
    const client = new FyrdenClient({ baseUrl: "https://f.test/api", fetch: fetchFn });
    const error = await client.call("feed.list", { since: "c" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 410, code: "cursor_expired", resync: "/api/feed/sync" });
  });

  it("carries a stale refusal's current version, and none when it has none", async () => {
    const { fetchFn } = fake([
      { status: 409, body: { status: 409, code: "stale", detail: "d", current_version: 7 } },
      { status: 409, body: { status: 409, code: "stale", detail: "d" } },
    ]);
    const client = new FyrdenClient({ baseUrl: "https://f.test/api", fetch: fetchFn });
    const input = { owner: "me", repo: "r", issue_number: 1, body: "x", expected_version: 1 };
    const first = await client.call("issues.update", input).catch((e: unknown) => e);
    expect(first).toMatchObject({ status: 409, code: "stale", currentVersion: 7 });
    const second = await client.call("issues.update", input).catch((e: unknown) => e);
    expect(second).toMatchObject({ code: "stale", currentVersion: undefined });
  });

  it("iterates every item of a paginated operation, following next_cursor", async () => {
    const { sent, fetchFn } = fake([
      { body: { repos: [{ name: "a" }, { name: "b" }], next_cursor: "c1" } },
      { body: { repos: [{ name: "c" }], next_cursor: null } },
    ]);
    const client = new FyrdenClient({ baseUrl: "https://f.test/api", fetch: fetchFn });
    const names: string[] = [];
    for await (const repo of client.paginate("repos.list", { per_page: 2 })) names.push(repo.name);
    expect(names).toEqual(["a", "b", "c"]);
    expect(sent.map((s) => new URL(s.url).search)).toEqual([
      "?per_page=2",
      "?per_page=2&cursor=c1",
    ]);
  });

  it("starts a paginated stream after an id, then follows next_cursor alone", async () => {
    const { sent, fetchFn } = fake([
      { body: { comments: [{ id: 3 }], next_cursor: "c1" } },
      { body: { comments: [{ id: 4 }], next_cursor: null } },
    ]);
    const client = new FyrdenClient({ baseUrl: "https://f.test/api", fetch: fetchFn });
    const ids: number[] = [];
    for await (const c of client.paginate("issues.comments.list", {
      owner: "me",
      repo: "r",
      issue_number: 1,
      after: 2,
      per_page: 1,
    }))
      ids.push(c.id);
    expect(ids).toEqual([3, 4]);
    expect(sent.map((s) => new URL(s.url).search)).toEqual([
      "?after=2&per_page=1",
      "?per_page=1&cursor=c1",
    ]);
  });

  it("refuses dot segments in path parameters before sending anything", async () => {
    const { sent, fetchFn } = fake([]);
    const client = new FyrdenClient({ baseUrl: "https://f.test/api", fetch: fetchFn });
    for (const path of ["../../other", "a/../b", ".", "a/./b"])
      await expect(
        client.call("repos.contents.delete", {
          owner: "me",
          repo: "r",
          path,
          message: "m",
          sha: "a".repeat(40),
        }),
      ).rejects.toThrow(TypeError);
    await expect(client.call("repos.get", { owner: "me", repo: ".." })).rejects.toThrow(TypeError);
    expect(sent).toEqual([]);
  });

  it("follows no redirect: a write's body and proof never go elsewhere", async () => {
    const followed: string[] = [];
    // As fetch behaves: it follows a redirect unless told not to.
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.redirect !== "manual") {
        followed.push(String(init?.body));
        return new Response("{}", { status: 200 });
      }
      return new Response(null, { status: 307, headers: { Location: "https://evil.test/x" } });
    }) as unknown as typeof fetch;
    const client = new FyrdenClient({
      baseUrl: "https://f.test/api",
      token: "fyrden_pat_x",
      fetch: fetchFn,
    });
    const error = await client
      .call("repos.update", { owner: "me", repo: "r", description: "secret" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FyrdenError);
    expect(error).toMatchObject({ status: 307, code: "redirected" });
    expect(followed).toEqual([]);
    // A browser's manual redirect is opaque, with status 0.
    const opaque = new FyrdenClient({
      baseUrl: "https://f.test/api",
      fetch: (async () =>
        Object.defineProperty(new Response(null, { status: 200 }), "type", {
          value: "opaqueredirect",
        })) as unknown as typeof fetch,
    });
    expect(await opaque.call("meta.whoami", {}).catch((e: unknown) => e)).toMatchObject({
      code: "redirected",
    });
  });

  it("keeps the status of an error whatever its body", async () => {
    for (const body of ["<html>502</html>", "{not json", "null", ""]) {
      const fetchFn = (async () =>
        new Response(body, { status: 502, statusText: "Bad Gateway" })) as unknown as typeof fetch;
      const client = new FyrdenClient({ baseUrl: "https://f.test/api", fetch: fetchFn });
      const error = await client.call("meta.whoami", {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FyrdenError);
      expect(error).toMatchObject({ status: 502, code: "http_error", detail: "502 Bad Gateway" });
    }
  });

  it("pages a directory's entries, and a file has none", async () => {
    const { fetchFn } = fake([
      { body: { type: "dir", path: "", sha: "s", entries: [{ name: "a" }], next_cursor: "d1" } },
      { body: { type: "dir", path: "", sha: "s", entries: [{ name: "b" }], next_cursor: null } },
      {
        body: {
          type: "file",
          path: "f",
          name: "f",
          sha: "s",
          mode: "100644",
          size: 1,
          content: null,
        },
      },
    ]);
    const client = new FyrdenClient({ baseUrl: "https://f.test/api", fetch: fetchFn });
    const names: string[] = [];
    for await (const entry of client.paginate("repos.contents.root", { owner: "me", repo: "r" }))
      names.push(entry.name);
    expect(names).toEqual(["a", "b"]);
    const none: unknown[] = [];
    for await (const entry of client.paginate("repos.contents.get", {
      owner: "me",
      repo: "r",
      path: "f",
    }))
      none.push(entry);
    expect(none).toEqual([]);
  });

  it("types the items of a union of paginated operations", async () => {
    const { fetchFn } = fake([{ body: { branches: [{ name: "main" }], next_cursor: null } }]);
    const client = new FyrdenClient({ baseUrl: "https://f.test/api", fetch: fetchFn });
    const id = "repos.branches.list" as "repos.branches.list" | "repos.tags.list";
    for await (const item of client.paginate(id, { owner: "me", repo: "r" }))
      expect(item.name).toBe("main");
  });

  it("asks a union of operations for every field any of them needs", async () => {
    const { fetchFn } = fake([
      { body: { type: "dir", path: "", sha: "s", entries: [], next_cursor: null } },
    ]);
    const client = new FyrdenClient({ baseUrl: "https://f.test/api", fetch: fetchFn });
    const id = "repos.contents.root" as "repos.contents.get" | "repos.contents.root";
    // @ts-expect-error `path` is needed when the operation is repos.contents.get
    expect(() => client.paginate(id, { owner: "me", repo: "r" })).not.toThrow();
    for await (const _ of client.paginate(id, { owner: "me", repo: "r", path: "docs" })) break;
  });
});
