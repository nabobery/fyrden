import { env } from "cloudflare:workers";
import {
  D1TokenStore,
  LAST_USED_INTERVAL_MS,
  TokenCache,
  TokenExpiredError,
  type TokenRecord,
  TouchLedger,
} from "@fyrden/adapters-cloudflare/auth";
import { createIdFactory, hashToken, secureRandomBytes } from "@fyrden/domain";
import { beforeAll, describe, expect, it } from "vitest";

const HOUR = 60 * 60 * 1000;

/**
 * Wraps a D1 binding and records every SQL statement prepared through it.
 * `onLookupAnswered` runs when a token lookup's row arrives, so a test can
 * move the clock as if D1 had been slow.
 */
function countingDb(db: D1Database, onLookupAnswered: () => void = () => {}) {
  const sql: string[] = [];
  const delayed = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(s, prop) {
        if (prop === "bind") return (...args: unknown[]) => delayed(s.bind(...args));
        if (prop === "first")
          return async (...args: []) => {
            const row = await s.first(...args);
            onLookupAnswered();
            return row;
          };
        const value = Reflect.get(s, prop);
        return typeof value === "function" ? value.bind(s) : value;
      },
    });
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            sql.push(query);
            const statement = (t as D1Database).prepare(query);
            return query.includes("FROM tokens t") ? delayed(statement) : statement;
          };
        }
        if (prop === "withSession")
          return (...args: [string?]) => wrap((t as D1Database).withSession(...args));
        const value = Reflect.get(t, prop);
        return typeof value === "function" ? value.bind(t) : value;
      },
    });
  return { db: wrap(db), sql };
}

/** A store on a controllable clock; `lookupMs` makes every token lookup take that long. */
function setup({ lookupMs = 0 }: { lookupMs?: number } = {}) {
  const queries: string[] = [];
  let now = 1_760_000_000_000;
  const clock = () => now;
  const counting = countingDb(env.DIRECTORY, () => {
    now += lookupMs;
  });
  const deferred: Promise<unknown>[] = [];
  const cache = new TokenCache<TokenRecord>(clock);
  const store = new D1TokenStore(counting.db, {
    clock,
    newId: createIdFactory(clock, secureRandomBytes),
    randomBytes: secureRandomBytes,
    cache,
    ledger: new TouchLedger(),
    defer: (p) => deferred.push(p),
    metrics: {
      count: (name, dims, value = 1) =>
        queries.push(`${name} ${Object.values(dims).at(-1)} x${value}`),
    },
  });
  return {
    store,
    cache,
    queries,
    sql: counting.sql,
    advance: (ms: number) => {
      now += ms;
    },
    settle: () => Promise.all(deferred.splice(0)),
  };
}

const audit = { actorId: "usr_owner", requestId: "req-test" };

beforeAll(async () => {
  await env.DIRECTORY.prepare(
    "INSERT INTO principals (id, type, handle, created_at) VALUES ('usr_owner', 'user', 'owner', 0)",
  ).run();
});

describe("D1TokenStore", () => {
  it("stores only the hash, never the plaintext token", async () => {
    const { store } = setup();
    const { token } = await store.mint({
      principalId: "usr_owner",
      type: "pat",
      scopes: ["repo"],
      ttlMs: HOUR,
      audit,
    });
    const tables = ["tokens", "audit_log", "principals"];
    for (const table of tables) {
      const { results } = await env.DIRECTORY.prepare(`SELECT * FROM ${table}`).all();
      expect(JSON.stringify(results)).not.toContain(token);
      expect(JSON.stringify(results)).not.toContain(token.slice(11));
    }
  });

  it("writes the audit row in the same batch as the token", async () => {
    const { store } = setup();
    const { id } = await store.mint({
      principalId: "usr_owner",
      type: "git",
      scopes: [],
      ttlMs: HOUR,
      audit,
    });
    const row = await env.DIRECTORY.prepare(
      "SELECT action, actor_id FROM audit_log WHERE target_id = ?",
    )
      .bind(id)
      .first();
    expect(row).toEqual({ action: "token.mint", actor_id: "usr_owner" });
  });

  it("rejects expired tokens on both paths", async () => {
    const { store, advance } = setup();
    const { token, id } = await store.mint({
      principalId: "usr_owner",
      type: "git",
      scopes: [],
      ttlMs: HOUR,
      audit,
    });
    expect((await store.verify(token, "read")).ok).toBe(true);
    advance(HOUR);
    expect(await store.verify(token, "read")).toEqual({ ok: false, reason: "expired" });
    expect(await store.verify(token, "write")).toEqual({
      ok: false,
      reason: "expired",
      expiredRecord: expect.objectContaining({ id }),
    });
  });

  it("refuses, as expired, a token whose minting token expired first; and stops one with its source", async () => {
    const { store } = setup();
    const source = await store.mint({
      principalId: "usr_owner",
      type: "pat",
      scopes: [],
      ttlMs: HOUR,
      audit,
    });
    await expect(
      store.mint({
        principalId: "usr_owner",
        type: "git",
        scopes: [],
        ttlMs: HOUR,
        notAfter: 1,
        audit,
      }),
    ).rejects.toBeInstanceOf(TokenExpiredError);
    const derived = await store.mint({
      principalId: "usr_owner",
      type: "git",
      scopes: [],
      ttlMs: HOUR,
      sourceId: source.id,
      audit,
    });
    expect(await store.verify(derived.token, "write")).toMatchObject({
      ok: true,
      record: { sourceId: source.id },
    });
    await store.revoke(source.id, audit);
    expect(await store.verify(derived.token, "write")).toEqual({ ok: false, reason: "revoked" });
  });

  it("stops a token two steps from a revoked one, and keys all three by the first", async () => {
    const { store } = setup();
    const mint = (sourceId?: string) =>
      store.mint({
        principalId: "usr_owner",
        type: sourceId ? "git" : "pat",
        scopes: [],
        ttlMs: HOUR,
        ...(sourceId && { sourceId }),
        audit,
      });
    // An agent's own token, the delegated token exchanged for it, a git token from that.
    const first = await mint();
    const second = await mint(first.id);
    const third = await mint(second.id);
    expect(await store.verify(third.token, "write")).toMatchObject({
      ok: true,
      record: { sourceId: first.id },
    });
    expect(await store.verify(second.token, "write")).toMatchObject({
      ok: true,
      record: { sourceId: first.id },
    });
    await store.revoke(first.id, audit);
    expect(await store.verify(second.token, "write")).toEqual({ ok: false, reason: "revoked" });
    expect(await store.verify(third.token, "write")).toEqual({ ok: false, reason: "revoked" });
  });

  it("reports what an expired token holds now on the primary", async () => {
    const { store, advance } = setup();
    const { token, id } = await store.mint({
      principalId: "usr_owner",
      type: "pat",
      scopes: ["contents:write"],
      ttlMs: HOUR,
      audit,
    });
    expect((await store.verify(token, "read")).ok).toBe(true);
    await env.DIRECTORY.prepare("UPDATE tokens SET scopes = '[\"contents:read\"]' WHERE id = ?")
      .bind(id)
      .run();
    advance(HOUR);
    const verified = await store.verify(token, "write");
    expect(verified.ok).toBe(false);
    expect(!verified.ok && verified.expiredRecord?.scopes).toEqual(["contents:read"]);
  });

  it.each([
    ["scopes not a list", '{"length":0}', null],
    ["scopes null", "null", null],
    ["a scope not a string", '[["contents:write"]]', null],
    ["repo list not a list", "[]", '"rep_a"'],
    ["a repo id not a string", "[]", "[1]"],
  ])("grants nothing for a stored token with %s", async (_, scopes, repoIds) => {
    const { store, advance } = setup();
    const { token, id } = await store.mint({
      principalId: "usr_owner",
      type: "pat",
      scopes: [],
      ttlMs: HOUR,
      audit,
    });
    await env.DIRECTORY.prepare("UPDATE tokens SET scopes = ?, repo_ids = ? WHERE id = ?")
      .bind(scopes, repoIds, id)
      .run();
    expect(await store.verify(token, "write")).toEqual({ ok: false, reason: "unknown" });
    advance(2 * HOUR);
    expect(await store.verify(token, "write")).toEqual({ ok: false, reason: "unknown" });
  });

  it("rejects a token revoked while cached on the next write, even with a warm cache", async () => {
    const { store } = setup();
    const { token, id } = await store.mint({
      principalId: "usr_owner",
      type: "pat",
      scopes: [],
      ttlMs: HOUR,
      audit,
    });
    expect((await store.verify(token, "read")).ok).toBe(true);
    // Revoked by another isolate: this store's cache is not told.
    await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = 1 WHERE id = ?").bind(id).run();
    expect((await store.verify(token, "read")).ok).toBe(true); // bounded staleness on reads (30 s)
    expect(await store.verify(token, "write")).toEqual({ ok: false, reason: "revoked" });
    expect(await store.verify(token, "read")).toEqual({ ok: false, reason: "revoked" });
  });

  it("serves read-path hits from the cache with zero D1 queries", async () => {
    const { store, sql } = setup();
    const { token } = await store.mint({
      principalId: "usr_owner",
      type: "pat",
      scopes: [],
      ttlMs: HOUR,
      audit,
    });
    await store.verify(token, "read");
    sql.length = 0;
    for (let i = 0; i < 50; i++) expect((await store.verify(token, "read")).ok).toBe(true);
    expect(sql).toEqual([]);
  });

  it("writes last_used_at at most once per 10 minutes under 1,000 requests", async () => {
    const { store, sql, advance, settle } = setup();
    const { token } = await store.mint({
      principalId: "usr_owner",
      type: "pat",
      scopes: [],
      ttlMs: 24 * HOUR,
      audit,
    });
    sql.length = 0;
    // 1,000 requests over 15 minutes, mixing read and write paths.
    for (let i = 0; i < 1000; i++) {
      expect((await store.verify(token, i % 10 === 0 ? "write" : "read")).ok).toBe(true);
      advance(900);
    }
    await settle();
    const updates = sql.filter((q) => q.startsWith("UPDATE tokens SET last_used_at"));
    // 15 minutes span two 10-minute windows.
    expect(updates.length).toBeLessThanOrEqual(2);
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(LAST_USED_INTERVAL_MS).toBe(600_000);
  });

  it("never lets a last-used update extend how long a revoked token stays cached", async () => {
    const { store, advance } = setup();
    const { token, id } = await store.mint({
      principalId: "usr_owner",
      type: "pat",
      scopes: [],
      ttlMs: HOUR,
      audit,
    });
    // last_used_at just under 10 minutes ago: the first read caches without touching.
    await env.DIRECTORY.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?")
      .bind(1_760_000_000_000 - LAST_USED_INTERVAL_MS + 10_000, id)
      .run();
    expect((await store.verify(token, "read")).ok).toBe(true);
    await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = 1 WHERE id = ?").bind(id).run();
    advance(20_000); // a cache hit that now schedules a last-used write
    expect((await store.verify(token, "read")).ok).toBe(true);
    advance(10_001); // 30 s after the authoritative check: the entry must be gone
    expect(await store.verify(token, "read")).toEqual({ ok: false, reason: "revoked" });
  });

  it("does not let a slow lookup restart the 30-second freshness window", async () => {
    const { store } = setup({ lookupMs: 40_000 });
    const { token, id } = await store.mint({
      principalId: "usr_owner",
      type: "pat",
      scopes: [],
      ttlMs: HOUR,
      audit,
    });
    expect((await store.verify(token, "read")).ok).toBe(true);
    // The answer arrived 40 s after the check began: too stale to cache.
    await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = 1 WHERE id = ?").bind(id).run();
    expect(await store.verify(token, "read")).toEqual({ ok: false, reason: "revoked" });
  });

  it.each(["read", "write"] as const)(
    "judges expiry when the answer arrives, not when the lookup began (%s)",
    async (mode) => {
      // Valid when the lookup starts; expired by the time D1 answers.
      const { store, cache } = setup({ lookupMs: 40_000 });
      const { token } = await store.mint({
        principalId: "usr_owner",
        type: "pat",
        scopes: [],
        ttlMs: 30_000,
        audit,
      });
      expect(await store.verify(token, mode)).toMatchObject({ ok: false, reason: "expired" });
      expect(cache.get(await hashToken(token))).toBeUndefined();
    },
  );

  it("counts each D1 statement for the cost dashboard, and none for a cache hit", async () => {
    const { store, queries, settle } = setup();
    const { token } = await store.mint({
      principalId: "usr_owner",
      type: "pat",
      scopes: [],
      ttlMs: HOUR,
      audit,
    });
    await store.verify(token, "read"); // lookup and the first last-used write
    await store.verify(token, "read"); // cache hit, write throttled
    await settle();
    expect(queries).toEqual([
      "d1.query token_mint x2",
      "d1.query token_lookup x1",
      "d1.query token_touch x1",
    ]);
  });

  it("schedules one last-used write for 100 concurrent cold reads", async () => {
    const { store, sql, settle } = setup();
    const { token } = await store.mint({
      principalId: "usr_owner",
      type: "pat",
      scopes: [],
      ttlMs: HOUR,
      audit,
    });
    sql.length = 0;
    const results = await Promise.all(
      Array.from({ length: 100 }, () => store.verify(token, "read")),
    );
    await settle();
    expect(results.every((r) => r.ok)).toBe(true);
    expect(sql.filter((q) => q.startsWith("UPDATE tokens SET last_used_at"))).toHaveLength(1);
  });

  it("rejects malformed and tampered tokens without touching D1", async () => {
    const { store, sql } = setup();
    const { token } = await store.mint({
      principalId: "usr_owner",
      type: "pat",
      scopes: [],
      ttlMs: HOUR,
      audit,
    });
    sql.length = 0;
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    expect(await store.verify(tampered, "write")).toEqual({ ok: false, reason: "bad_checksum" });
    expect(await store.verify("garbage", "write")).toEqual({ ok: false, reason: "malformed" });
    expect(sql).toEqual([]);
  });

  it("revokes with an audit row and reports whether anything changed", async () => {
    const { store } = setup();
    const { token, id } = await store.mint({
      principalId: "usr_owner",
      type: "pat",
      scopes: [],
      ttlMs: HOUR,
      audit,
    });
    expect(await store.revoke(id, audit)).toBe(true);
    expect(await store.revoke(id, audit)).toBe(false);
    expect(await store.verify(token, "write")).toEqual({ ok: false, reason: "revoked" });
  });

  it("rejects tokens of a disabled principal", async () => {
    const { store } = setup();
    await env.DIRECTORY.prepare(
      "INSERT INTO principals (id, type, handle, created_at, disabled_at) VALUES ('usr_gone', 'user', 'gone', 0, 1)",
    ).run();
    const { token } = await store.mint({
      principalId: "usr_gone",
      type: "pat",
      scopes: [],
      ttlMs: HOUR,
      audit,
    });
    expect(await store.verify(token, "write")).toEqual({ ok: false, reason: "disabled" });
  });
});
