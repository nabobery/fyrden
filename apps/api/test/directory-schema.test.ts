import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const now = 1_760_000_000_000;

async function insertPrincipal(
  id: string,
  type: string,
  handle: string | null,
  ownerId: string | null = null,
) {
  await env.DIRECTORY.prepare(
    "INSERT INTO principals (id, type, handle, owner_id, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, type, handle, ownerId, now)
    .run();
}

describe("D1 directory schema", () => {
  it("has the identity, token, repo directory and audit tables", async () => {
    const { results } = await env.DIRECTORY.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "audit_log",
      "audit_segments",
      "deployment_settings",
      "dpop_proofs",
      "grants",
      "handle_reservations",
      "idempotency_keys",
      "memberships",
      "oauth_clients",
      "oauth_requests",
      "passkeys",
      "principal_lifecycle",
      "principals",
      "refresh_tokens",
      "repo_deletion_cleanups",
      "repo_deletions",
      "repo_redirects",
      "repo_transfers",
      "repos",
      "sessions",
      "source_epochs",
      "ssh_signing_keys",
      "stars",
      "tokens",
      "user_deletions",
      "user_retirements",
      "watch_preferences",
      "webauthn_challenges",
    ]);
  });

  it("records the token a token was minted from, none for the tokens before", async () => {
    const { results } = await env.DIRECTORY.prepare(
      "SELECT name, \"notnull\" AS required FROM pragma_table_info('tokens') WHERE name = 'source_id'",
    ).all<{ name: string; required: number }>();
    expect(results).toEqual([{ name: "source_id", required: 0 }]);
  });

  it("keeps handles unique regardless of case", async () => {
    await insertPrincipal("usr_A1", "user", "Alice");
    await expect(insertPrincipal("org_A2", "org", "alice")).rejects.toThrow(/UNIQUE/);
  });

  it("requires an owner for agents and forbids one for users", async () => {
    await insertPrincipal("usr_B1", "user", "bob");
    await expect(insertPrincipal("agt_B2", "agent", "bob-bot")).rejects.toThrow(/CHECK/);
    await insertPrincipal("agt_B3", "agent", "bob-bot", "usr_B1");
    await expect(insertPrincipal("usr_B4", "user", "carol", "usr_B1")).rejects.toThrow(/CHECK/);
  });

  it("frees a repo name once the old repo is a deleted tombstone", async () => {
    await insertPrincipal("org_C1", "org", "acme");
    const insertRepo = (id: string, state: string) =>
      env.DIRECTORY.prepare(
        "INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, state, created_at, updated_at) VALUES (?, 'org_C1', 'Widgets', ?, 'org_C1', 'private', ?, ?, ?)",
      )
        .bind(id, `net_${id}`, state, now, now)
        .run();
    await insertRepo("rep_C1", "active");
    await expect(insertRepo("rep_C2", "active")).rejects.toThrow(/UNIQUE/);
    await env.DIRECTORY.prepare("UPDATE repos SET state = 'deleted' WHERE id = 'rep_C1'").run();
    await insertRepo("rep_C3", "active");
  });

  it("stores only 64-character token hashes", async () => {
    await insertPrincipal("usr_D1", "user", "dave");
    const insertToken = (hash: string) =>
      env.DIRECTORY.prepare(
        "INSERT INTO tokens (id, token_hash, type, principal_id, expires_at, created_at) VALUES (?, ?, 'pat', 'usr_D1', ?, ?)",
      )
        .bind(`tok_${hash.slice(0, 8)}`, hash, now + 1, now)
        .run();
    await expect(insertToken("fyrden_pat_plaintext")).rejects.toThrow(/CHECK/);
    await insertToken("a".repeat(64));
  });
});
