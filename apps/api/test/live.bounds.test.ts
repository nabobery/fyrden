// What one run of live work reads and deletes is bounded whatever has built up: the lease
// reaper, the pump's dirty streams and their causes, and the object's pruning. Each test
// builds more than a run may take and counts what a run took.
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { LIVE_TEAM_GRANTS, type OrgDO } from "../src/do/OrgDO.js";
import type { UserDO } from "../src/do/UserDO.js";
import { LIVE_POLICY, LIVE_TICKET_PRUNE, Live } from "../src/do/user/live.js";
import { LIVE_ADMISSION, reaping } from "../src/live/directory.js";
import { LIVE_PRICES, type LiveManifestEntry } from "../src/live/manifest.js";
import { api, json, user } from "./helpers/api.js";
import { countingExec } from "./helpers/feed.js";

/** A feed object's live state, with `fn` run against it. */
const inLive = <T>(fn: (live: Live, sql: SqlStorage) => T) =>
  runInDurableObject(env.USER.getByName(uniqueId("usr")), (_: UserDO, state) =>
    fn(new Live(state.storage.sql), state.storage.sql),
  );

/** Leases (with two dependency rows each) for a feed of the test's own. */
async function leases(
  feed: string,
  rows: { id: string; state: "pending" | "open"; pendingUntil: number; expiresAt: number }[],
) {
  for (let at = 0; at < rows.length; at += 100) {
    const page = rows.slice(at, at + 100);
    await env.DIRECTORY.batch(
      page.flatMap((r) => [
        env.DIRECTORY.prepare(
          `INSERT INTO live_sockets (socket_id, ticket_id, feed, credential_id, state, pending_until, expires_at)
           VALUES (?, ?, ?, 'ses_x', ?, ?, ?)`,
        ).bind(r.id, `t-${r.id}`, feed, r.state, r.pendingUntil, r.expiresAt),
        env.DIRECTORY.prepare(
          "INSERT INTO live_socket_deps (dependency, socket_id) VALUES (?, ?), (?, ?)",
        ).bind(`credential:${r.id}`, r.id, `principal:${feed}:0`, r.id),
      ]),
    );
  }
}
const left = async (feed: string) =>
  (
    await env.DIRECTORY.prepare("SELECT count(*) AS n FROM live_sockets WHERE feed = ?")
      .bind(feed)
      .first<{ n: number }>()
  )?.n ?? 0;
const depsLeft = async (feed: string) =>
  (
    await env.DIRECTORY.prepare("SELECT count(*) AS n FROM live_socket_deps WHERE dependency = ?")
      .bind(`principal:${feed}:0`)
      .first<{ n: number }>()
  )?.n ?? 0;

describe("the lease reaper", () => {
  it("takes at most a run's leases in all, expired and lapsed together, earliest due first", async () => {
    const feed = `usr_reap${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now() + 365 * 86_400_000;
    const expired = Array.from({ length: 1_200 }, (_, i) => ({
      id: `lsk_e${String(i).padStart(5, "0")}${feed}`,
      state: "open" as const,
      pendingUntil: 0,
      expiresAt: now - 10_000 + i,
    }));
    const lapsed = Array.from({ length: 1_200 }, (_, i) => ({
      id: `lsk_p${String(i).padStart(5, "0")}${feed}`,
      state: "pending" as const,
      pendingUntil: now - 20_000 + i,
      expiresAt: now + 86_400_000,
    }));
    await leases(feed, [...expired, ...lapsed]);
    const run = () => env.DIRECTORY.batch(reaping(env.DIRECTORY, now));
    await run();
    expect(await left(feed)).toBe(2_400 - LIVE_ADMISSION.reapRows);
    expect(await depsLeft(feed)).toBe(2_400 - LIVE_ADMISSION.reapRows);
    // The earliest due went first: every lapsed lease (due 20 s back) before any expired one.
    const lapsedLeft = await env.DIRECTORY.prepare(
      "SELECT count(*) AS n FROM live_sockets WHERE feed = ? AND state = 'pending'",
    )
      .bind(feed)
      .first<{ n: number }>();
    expect(lapsedLeft?.n).toBe(200);
    await run();
    await run();
    expect(await left(feed)).toBe(0);
    expect(await depsLeft(feed)).toBe(0);
  });

  it("removes tickets' counts of days before yesterday, keeping yesterday's and today's", async () => {
    const principal = `usr_days${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const today = Math.floor(now / 86_400_000);
    for (const day of [today - 3, today - 2, today - 1, today])
      await env.DIRECTORY.prepare(
        "INSERT INTO live_ticket_days (principal_id, day, issued) VALUES (?, ?, 1)",
      )
        .bind(principal, day)
        .run();
    await env.DIRECTORY.batch(reaping(env.DIRECTORY, now));
    const kept = await env.DIRECTORY.prepare(
      "SELECT day FROM live_ticket_days WHERE principal_id = ? ORDER BY day",
    )
      .bind(principal)
      .all<{ day: number }>();
    expect(kept.results.map((r) => r.day)).toEqual([today - 1, today]);
  });
});

describe("a feed's live state", () => {
  it("gives the pump its dirty streams a page at a time, the page's end as its reach", async () => {
    await inLive((live) => {
      live.mark(
        Array.from({ length: 45 }, (_, i) => ({
          repoId: `rep_${String(i).padStart(3, "0")}`,
          subject: "issue" as const,
          conversation: `c${i}`,
          direct: false,
        })),
      );
      const upTo = live.seq();
      const first = live.dirtyAfter(0, upTo);
      expect(first.streams).toHaveLength(LIVE_POLICY.dirtyPage);
      expect(first.reach).toBe(first.streams.at(-1)?.seq);
      const second = live.dirtyAfter(first.reach, upTo);
      expect(second.streams).toHaveLength(LIVE_POLICY.dirtyPage);
      const third = live.dirtyAfter(second.reach, upTo);
      expect(third.streams).toHaveLength(5);
      // The last page: nothing past it up to the capture.
      expect(third.reach).toBe(upTo);
    });
  });

  it("prunes a page of each kind a call, saying whether more is left, its reads bounded", async () => {
    await inLive((live, sql) => {
      // No page's multiple: every kind's last page is short, so none needs an empty call.
      const many = 124;
      const now = Date.now();
      for (let i = 0; i < many; i++) {
        sql.exec(
          "INSERT INTO live_dirty (stream, repo_id, subject, seq, explicit_seq, many_seq) VALUES (?, ?, 'issue', ?, 0, 0)",
          `r${i}\nissue`,
          `r${i}`,
          i + 1,
        );
        sql.exec(
          "INSERT INTO live_candidates (stream, conversation, direct_seq, ordinary_seq) VALUES (?, 'c', 0, ?)",
          `r${i}\nissue`,
          i + 1,
        );
        sql.exec(
          "INSERT INTO live_tickets (ticket_hash, credential_id, expires_at) VALUES (?, 'ses_x', ?)",
          `h${i}`,
          now - 1,
        );
        sql.exec("INSERT INTO live_revoked (dependency, at) VALUES (?, 0)", `credential:x${i}`);
      }
      sql.exec("INSERT INTO live_meta (id, seq, gen) VALUES (1, ?, 0)", many);
      const counts = () =>
        ["live_dirty", "live_candidates", "live_tickets", "live_revoked"].map(
          (t) => sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${t}`).one().n,
        );
      // Expired tickets only, as ticket storage prunes: the other kinds stay.
      expect(live.prune(now, LIVE_TICKET_PRUNE)).toBe(true);
      expect(counts()).toEqual([many, many, many - LIVE_TICKET_PRUNE.tickets, many]);
      const pages = LIVE_POLICY.prunePage;
      const rows = pages.dirty + pages.candidates + pages.tickets + pages.revoked;
      let calls = 0;
      for (let more = true; more; calls++) {
        const counter = countingExec(sql);
        more = live.prune(now);
        const { read } = counter.stop();
        // Each kind's page through its index (SQLite counts about five rows read a row it
        // deletes: the lookup, the row and its index entries), and a few to find the progress.
        expect(read).toBeLessThanOrEqual(5 * rows + 16);
        if (more) expect(counts().some((n) => n > 0)).toBe(true);
      }
      expect(counts()).toEqual([0, 0, 0, 0]);
      // The smallest page sets the calls (each kind's own page a call, its last one short).
      const smallest = Math.min(pages.dirty, pages.candidates, pages.revoked);
      expect(calls).toBe(Math.ceil(many / smallest));
    });
  });

  it("keeps a change made after the progress pruned up to", async () => {
    await inLive((live, sql) => {
      live.mark([{ repoId: "rep_a", subject: "issue", conversation: "c1", direct: false }]);
      // A socket that heard of it, and a change after.
      sql.exec(
        `INSERT INTO live_local (socket_id, credential_id, phase, expires_at, deadline, sent, acked,
           refresh_pending, blocked_since, renew_failures, controls_used, minute_start, minute_count,
           delivered_seq, retry_at, scopes, repo_ids)
         VALUES ('lsk_1', 'ses_x', 'open', ?1, ?1, 0, 0, 0, NULL, 0, 0, 0, 0, ?2, 0, '[]', NULL)`,
        Date.now() + 60_000,
        live.seq(),
      );
      live.mark([{ repoId: "rep_a", subject: "issue", conversation: "c2", direct: false }]);
      live.prune(Date.now());
      expect(live.dirtyAfter(0, live.seq()).streams.map((d) => d.repo_id)).toEqual(["rep_a"]);
      expect(live.candidatesAfter("rep_a\nissue", 0).map((c) => c.conversation)).toEqual(["c2"]);
    });
  });

  it("finds whether the pump is due without reading every change, a socket blocked", async () => {
    await inLive((live, sql) => {
      for (let i = 0; i < 5_000; i++)
        sql.exec(
          "INSERT INTO live_dirty (stream, repo_id, subject, seq, explicit_seq, many_seq) VALUES (?, ?, 'issue', ?, 0, 0)",
          `r${i}\nissue`,
          `r${i}`,
          i + 1,
        );
      const now = Date.now();
      // Its window full: nothing is due for it, however much changed.
      sql.exec(
        `INSERT INTO live_local (socket_id, credential_id, phase, expires_at, deadline, sent, acked,
           refresh_pending, blocked_since, renew_failures, controls_used, minute_start, minute_count,
           delivered_seq, retry_at, scopes, repo_ids)
         VALUES ('lsk_1', 'ses_x', 'open', ?1, ?1, ?2, 0, 1, ?3, 0, 0, 0, 0, 0, 0, '[]', NULL)`,
        now + 600_000,
        LIVE_POLICY.window,
        now,
      );
      const counter = countingExec(sql);
      const due = live.nextDue(now, 60_000);
      expect(counter.stop().read).toBeLessThan(50);
      expect(due).toBe(now + LIVE_POLICY.slowMs);
    });
  });
});

describe("a retired feed", () => {
  it("drops live work an alarm finds due, rather than running it again and again", async () => {
    const stub = env.USER.getByName(uniqueId("usr"));
    await stub.retire();
    await runInDurableObject(stub, (_: UserDO, state) => {
      state.storage.sql.exec(
        "INSERT INTO user_schedule (kind, due_at) VALUES ('live', 0) ON CONFLICT (kind) DO UPDATE SET due_at = 0",
      );
    });
    await runDurableObjectAlarm(stub);
    const left = await runInDurableObject(stub, (_: UserDO, state) =>
      state.storage.sql.exec("SELECT kind FROM user_schedule WHERE kind = 'live'").toArray(),
    );
    expect(left).toEqual([]);
  });
});

describe("the live check of who reads an organization's repository", () => {
  it("answers as the full check within its team bound, and unknown past it", async () => {
    const [admin, owner, alice] = [await user(true), await user(), await user()];
    const login = uniqueId("org").slice(0, 39);
    const org = (
      await json<{ id: string }>(
        api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle }),
      )
    ).body;
    expect(
      (await api("PUT", `/orgs/${login}/memberships/${alice.handle}`, owner.token, {})).status,
    ).toBe(200);
    const repo = (
      await json<{ id: string; name: string }>(
        api("POST", `/orgs/${login}/repos`, owner.token, { name: uniqueId("r") }),
      )
    ).body;
    const team = (
      await json<{ slug: string }>(
        api("POST", `/orgs/${login}/teams`, owner.token, { name: "Core" }),
      )
    ).body;
    await api("PUT", `/orgs/${login}/teams/${team.slug}/memberships/${alice.handle}`, owner.token);
    await api("PUT", `/orgs/${login}/teams/${team.slug}/repos/${login}/${repo.name}`, owner.token, {
      permission: "push",
    });
    const stub = env.ORG.getByName(org.id);
    const full = await stub.confirmReaders([repo.id], [alice.principalId]);
    const within = await stub.confirmReadersLive([repo.id], [alice.principalId]);
    expect(within.repos[repo.id]).toEqual(full.repos[repo.id]);
    expect(within.repos[repo.id]?.roles[alice.principalId]).toBe("write");
    // A hundred more teams on the repository, alice in none of them: past the bound.
    await runInDurableObject(stub, (_: OrgDO, state) => {
      for (let i = 0; i < 100; i++) {
        state.storage.sql.exec(
          "INSERT INTO teams (team_id, slug, name, created_at) VALUES (?, ?, ?, 0)",
          `tm_bound${i}`,
          `bound-${i}`,
          `Bound ${i}`,
        );
        state.storage.sql.exec(
          "INSERT INTO team_repos (team_id, repo_id, role, added_at) VALUES (?, ?, 'read', 0)",
          `tm_bound${i}`,
          repo.id,
        );
      }
    });
    // Sixteen principals asked, past the bound: the repository's grants read once (not a time
    // each), and no membership probed.
    const readers = [alice.principalId, ...Array.from({ length: 15 }, (_, i) => `usr_none${i}`)];
    const reads = await runInDurableObject(stub, async (instance: OrgDO, state) => {
      const counter = countingExec(state.storage.sql);
      await instance.confirmReadersLive([repo.id], readers);
      return counter.stop().read;
    });
    // A hundred grants and a sentinel through their index, and the account's few rows.
    expect(reads).toBeLessThan(101 * 2 + 64);
    const past = await stub.confirmReadersLive([repo.id], [alice.principalId]);
    expect(past.repos[repo.id]?.roles[alice.principalId]).toBe("unknown");
    // The full check still answers (it is not the live one's to change).
    expect(
      (await stub.confirmReaders([repo.id], [alice.principalId])).repos[repo.id]?.roles[
        alice.principalId
      ],
    ).toBe("write");
  });
  it("reads, for a pump's full page, within what the pump pays for its account's object", async () => {
    const [admin, owner, alice] = [await user(true), await user(), await user()];
    const login = uniqueId("org").slice(0, 39);
    const org = (
      await json<{ id: string }>(
        api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle }),
      )
    ).body;
    expect(
      (await api("PUT", `/orgs/${login}/memberships/${alice.handle}`, owner.token, {})).status,
    ).toBe(200);
    // A page's repositories (one a stream), each granted to the most teams the check reads
    // through (every one probed), alice a member of each: its most rows.
    const repos = Array.from({ length: LIVE_POLICY.dirtyPage }, (_, i) => `rep_page${i}`);
    const stub = env.ORG.getByName(org.id);
    await runInDurableObject(stub, (_: OrgDO, state) => {
      for (let i = 0; i < LIVE_TEAM_GRANTS; i++) {
        state.storage.sql.exec(
          "INSERT INTO teams (team_id, slug, name, created_at) VALUES (?, ?, ?, 0)",
          `tm_page${i}`,
          `page-${i}`,
          `Page ${i}`,
        );
        state.storage.sql.exec(
          "INSERT INTO team_members (team_id, principal_id, added_at) VALUES (?, ?, 0)",
          `tm_page${i}`,
          alice.principalId,
        );
        for (const repo of repos)
          state.storage.sql.exec(
            "INSERT INTO team_repos (team_id, repo_id, role, added_at) VALUES (?, ?, 'read', 0)",
            `tm_page${i}`,
            repo,
          );
      }
    });
    // Its readers: the principal and, for an agent's credential, its owner.
    const counted = await runInDurableObject(stub, async (instance: OrgDO, state) => {
      const counter = countingExec(state.storage.sql);
      const answer = await instance.confirmReadersLive(repos, [
        alice.principalId,
        owner.principalId,
      ]);
      return {
        rows: counter.stop(),
        role: answer.repos[repos[0] as string]?.roles[alice.principalId],
      };
    });
    expect(counted.role).toBe("read");
    // Its first call in an instance of a restored account takes the directory's newer epoch
    // there (a write) before it confirms.
    await env.DIRECTORY.prepare(
      "UPDATE source_epochs SET epoch_gen = epoch_gen + 1 WHERE source_id = ?",
    )
      .bind(org.id)
      .run();
    await evictDurableObject(stub);
    const restored = await runInDurableObject(stub, async (instance: OrgDO, state) => {
      const counter = countingExec(state.storage.sql);
      await instance.confirmReadersLive(repos.slice(0, 1), [alice.principalId]);
      return counter.stop();
    });
    // Within what its grant was priced from (its fixture's most).
    const observed = Object.values((LIVE_PRICES.org_confirmation as LiveManifestEntry).observed);
    const most = (k: "do_rows_read" | "do_rows_written") => Math.max(...observed.map((o) => o[k]));
    expect(counted.rows.read).toBeLessThanOrEqual(most("do_rows_read"));
    expect(Math.max(counted.rows.written, restored.written)).toBeLessThanOrEqual(
      most("do_rows_written"),
    );
  });
});
