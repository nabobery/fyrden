import type { GitStorageContext } from "@fyrden/adapters-cloudflare/git";
import type { ViewPack } from "./types.js";

/*
 * The network object's state: members, the packs the network
 * shares and which members claim them, the collection's fence, and the
 * deletions in progress. Every method is synchronous, so a caller can run
 * several in one `transactionSync`.
 *
 * A pack becomes shared (this object its lifetime authority) when a second
 * member first borrows it. From then on no member deletes its bytes: a
 * member whose view no longer holds it releases its claim, and once no
 * member claims it, it is condemned here and deleted after every member has
 * acknowledged, every lease from before has ended and the retention has
 * passed (two-phase deletion).
 */

export type MemberState = "joining" | "active" | "detaching" | "detached";

export interface Member {
  readonly repoId: string;
  readonly parentRepoId: string | null;
  readonly state: MemberState;
  readonly joinedAt: number;
}

export interface GcState {
  readonly epoch: number;
  readonly phase: "idle" | "mark" | "sweep";
  readonly fence: boolean;
  readonly fenceSince: number | null;
}

export interface Deletion {
  readonly packId: string;
  readonly condemnedAt: number;
  readonly acksPending: readonly string[];
  readonly leasesUntil: number;
  readonly notBefore: number;
  /** When the deletion fence was set (the bytes are being deleted; no claim reprieves the pack), or null. */
  readonly deletingSince: number | null;
}

type Sql = GitStorageContext["storage"];

/** Durable Object SQLite binds at most 100 parameters per query (as the git adapters chunk). */
const CHUNK = 90;
function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}
const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/**
 * Claim sequences per millisecond of the network object's clock. A
 * sequence is the larger of the last one stored plus one and the clock in
 * milliseconds times this. A point-in-time recovery takes the stored one
 * back (https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
 * not the clock, so a sequence answered after a recovery is still larger
 * than any answered before it, while:
 * - the clock of the instance answering after the recovery is behind the
 *   one that answered before it by less than the recovery took (clock
 *   skew between instances is far smaller than that; unverified);
 * - the object answers fewer than this many sequences a millisecond on
 *   average (each goes with a call between objects).
 * Sequences stay exact: below `Number.MAX_SAFE_INTEGER` (2^53 - 1) until the
 * clock reaches 2^43 ms (the year 2248), and SQLite integers hold 64 bits.
 */
const CLAIM_SEQS_PER_MS = 1024;

const exec = (sql: Sql, query: string, ...bindings: unknown[]) => {
  const cursor = sql.sql.exec(query, ...bindings);
  cursor.toArray();
  return cursor.rowsWritten;
};
const all = <T extends Record<string, SqlStorageValue>>(
  sql: Sql,
  query: string,
  ...bindings: unknown[]
): T[] => sql.sql.exec<T>(query, ...bindings).toArray();

type MemberRow = {
  repo_id: string;
  parent_repo_id: string | null;
  state: string;
  joined_at: number;
};
const MEMBER_COLUMNS = "repo_id, parent_repo_id, state, joined_at";
const toMember = (r: MemberRow): Member => ({
  repoId: r.repo_id,
  parentRepoId: r.parent_repo_id,
  state: r.state as MemberState,
  joinedAt: r.joined_at,
});

export class NetworkRegistry {
  constructor(private readonly context: Pick<GitStorageContext, "storage" | "now">) {}

  get #sql(): Sql {
    return this.context.storage;
  }

  /** Records the network's id on first use; a different id is a wiring error. */
  ensure(networkId: string): void {
    const now = this.context.now();
    const row = all<{ network_id: string }>(this.#sql, "SELECT network_id FROM network_meta");
    if (row[0]) {
      if (row[0].network_id !== networkId)
        throw new Error("this network object belongs to another network");
      return;
    }
    exec(
      this.#sql,
      `INSERT INTO network_meta (id, network_id, membership_version, created_at, updated_at)
       VALUES (1, ?, 0, ?, ?)`,
      networkId,
      now,
      now,
    );
  }

  networkId(): string | undefined {
    return all<{ network_id: string }>(this.#sql, "SELECT network_id FROM network_meta")[0]
      ?.network_id;
  }

  membershipVersion(): number {
    return (
      all<{ v: number }>(this.#sql, "SELECT membership_version AS v FROM network_meta")[0]?.v ?? 0
    );
  }

  #bumpMembership(): void {
    exec(
      this.#sql,
      "UPDATE network_meta SET membership_version = membership_version + 1, updated_at = ?",
      this.context.now(),
    );
  }

  /** The members (of `states`, when given) in the order they joined; the first `limit` of them, when given. */
  members(states?: readonly MemberState[], limit?: number): Member[] {
    return all<MemberRow>(
      this.#sql,
      `SELECT ${MEMBER_COLUMNS} FROM members
       ${states ? `WHERE state IN (${placeholders(states.length)})` : ""} ORDER BY joined_at, repo_id
       ${limit === undefined ? "" : "LIMIT ?"}`,
      ...(states ?? []),
      ...(limit === undefined ? [] : [limit]),
    ).map(toMember);
  }

  member(repoId: string): Member | undefined {
    return all<MemberRow>(
      this.#sql,
      `SELECT ${MEMBER_COLUMNS} FROM members WHERE repo_id = ?`,
      repoId,
    ).map(toMember)[0];
  }

  /**
   * The first member (of `states`, when given) after `after`, a member's
   * `[joinedAt, repoId]` (or from the first), in the order members joined:
   * one seek, however many members there are.
   */
  memberAfter(
    after: readonly [number, string] | undefined,
    states?: readonly MemberState[],
  ): Member | undefined {
    return all<MemberRow>(
      this.#sql,
      `SELECT ${MEMBER_COLUMNS} FROM members WHERE (joined_at, repo_id) > (?, ?)
       ${states ? `AND state IN (${placeholders(states.length)})` : ""}
       ORDER BY joined_at, repo_id LIMIT 1`,
      ...(after ?? [Number.MIN_SAFE_INTEGER, ""]),
      ...(states ?? []),
    ).map(toMember)[0];
  }

  /** Adds a member (the first one, the network's root, joins `active`). */
  addMember(repoId: string, parentRepoId: string | null, state: MemberState): void {
    const now = this.context.now();
    exec(
      this.#sql,
      `INSERT INTO members (repo_id, parent_repo_id, state, joined_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      repoId,
      parentRepoId,
      state,
      now,
      now,
    );
    this.#bumpMembership();
  }

  setMemberState(repoId: string, from: readonly MemberState[], to: MemberState): boolean {
    const written = exec(
      this.#sql,
      `UPDATE members SET state = ?, updated_at = ?
       WHERE repo_id = ? AND state IN (${placeholders(from.length)})`,
      to,
      this.context.now(),
      repoId,
      ...from,
    );
    if (written > 0) this.#bumpMembership();
    return written > 0;
  }

  /** Removes a member that never finished joining, with its claims. Returns packs left unclaimed. */
  removeJoining(repoId: string): string[] {
    const written = exec(
      this.#sql,
      "DELETE FROM members WHERE repo_id = ? AND state = 'joining'",
      repoId,
    );
    if (written === 0) return [];
    this.#bumpMembership();
    const claimed = this.claimsOf(repoId);
    return this.release(repoId, claimed);
  }

  /** Removes a member in any state (a deleted repository), with its claims. Returns packs left unclaimed. */
  removeMember(repoId: string): string[] {
    const written = exec(this.#sql, "DELETE FROM members WHERE repo_id = ?", repoId);
    if (written > 0) this.#bumpMembership();
    return this.release(repoId, this.claimsOf(repoId));
  }

  /** Records `packs` as shared, claimed by every repository in `claimants`; cancels their deletion. */
  share(packs: readonly ViewPack[], writerOf: (pack: ViewPack) => string, claimants: string[]) {
    const now = this.context.now();
    for (const pack of packs) {
      exec(
        this.#sql,
        `INSERT INTO network_packs (pack_id, writer_repo_id, state, bytes, created_at, updated_at)
         VALUES (?, ?, 'shared', ?, ?, ?)
         ON CONFLICT (pack_id) DO UPDATE SET state = 'shared', updated_at = excluded.updated_at
         WHERE network_packs.state <> 'deleted' AND NOT EXISTS (
           SELECT 1 FROM deletions d WHERE d.pack_id = network_packs.pack_id
             AND d.deleting_since IS NOT NULL)`,
        pack.packId,
        writerOf(pack),
        pack.bytes,
        now,
        now,
      );
      exec(
        this.#sql,
        "DELETE FROM deletions WHERE pack_id = ? AND deleting_since IS NULL",
        pack.packId,
      );
    }
    this.claim(
      claimants,
      packs.map((p) => p.packId),
    );
  }

  /**
   * Claims `packIds` for every repository in `repoIds`, at sequence 0 (a
   * claim already made stays as it is): only claims no release of the
   * repository's can name yet (see claim-releases.ts).
   */
  claim(repoIds: readonly string[], packIds: readonly string[]): void {
    const now = this.context.now();
    for (const repoId of repoIds)
      for (const packId of packIds)
        exec(
          this.#sql,
          `INSERT INTO pack_claims (pack_id, repo_id, claimed_at) VALUES (?, ?, ?)
           ON CONFLICT (pack_id, repo_id) DO NOTHING`,
          packId,
          repoId,
          now,
        );
  }

  /**
   * The network's next claim sequence, larger than every one it answered
   * before, a recovery of this object to an earlier state included (see
   * `CLAIM_SEQS_PER_MS`).
   */
  nextClaimSeq(): number {
    const seq = all<{ seq: number }>(
      this.#sql,
      "UPDATE network_meta SET claim_seq = max(claim_seq + 1, ?) RETURNING claim_seq AS seq",
      Math.floor(this.context.now()) * CLAIM_SEQS_PER_MS,
    )[0]?.seq;
    if (seq === undefined) throw new Error("the network object has no id recorded");
    return seq;
  }

  /**
   * Claims `packIds` for `repoId` (a pull request's base sharing its head's
   * packs, a restored member claiming its packs again) at the network's
   * next claim sequence; returns it. A release the repository recorded
   * before it learnt this sequence names an earlier one, so it leaves these
   * claims (see `releaseUpTo`).
   */
  renewClaims(repoId: string, packIds: readonly string[]): number {
    const seq = this.nextClaimSeq();
    this.claimAt(repoId, packIds, seq);
    return seq;
  }

  /**
   * Claims `packIds` for `repoId` at sequence `seq` (from `nextClaimSeq`),
   * made at `at`: a claim already made keeps the later of each.
   */
  claimAt(
    repoId: string,
    packIds: readonly string[],
    seq: number,
    at: number = this.context.now(),
  ): void {
    for (const packId of packIds)
      exec(
        this.#sql,
        `INSERT INTO pack_claims (pack_id, repo_id, claimed_at, seq) VALUES (?, ?, ?, ?)
         ON CONFLICT (pack_id, repo_id) DO UPDATE SET seq = max(seq, excluded.seq),
           claimed_at = max(claimed_at, excluded.claimed_at)`,
        packId,
        repoId,
        at,
        seq,
      );
  }

  /**
   * Claims `packIds` for `repoId` as held at `since` (a collection's start)
   * or later, at `seq` (the sequence the member learnt as it reported its
   * view): new claims, and older ones renewed (see `releaseUnrenewed`).
   */
  hold(repoId: string, packIds: readonly string[], since: number, seq: number): void {
    this.claimAt(repoId, packIds, seq, Math.max(this.context.now(), since));
  }

  /**
   * Drops the claims recorded before `since` (a collection's start) and
   * not renewed since: once every member has said what its view holds,
   * claims on packs it no longer holds. Joining members were not asked:
   * their claims stay.
   */
  releaseUnrenewed(since: number): void {
    exec(
      this.#sql,
      `DELETE FROM pack_claims WHERE claimed_at < ?
         AND repo_id IN (SELECT repo_id FROM members WHERE state <> 'joining')`,
      since,
    );
  }

  claimsOf(repoId: string): string[] {
    return all<{ pack_id: string }>(
      this.#sql,
      "SELECT pack_id FROM pack_claims WHERE repo_id = ? ORDER BY pack_id",
      repoId,
    ).map((r) => r.pack_id);
  }

  claimants(packId: string): string[] {
    return all<{ repo_id: string }>(
      this.#sql,
      "SELECT repo_id FROM pack_claims WHERE pack_id = ? ORDER BY repo_id",
      packId,
    ).map((r) => r.repo_id);
  }

  /** Drops `repoId`'s claims on `packIds`. Returns the shared packs no member claims any more. */
  release(repoId: string, packIds: readonly string[]): string[] {
    for (const batch of chunks(packIds))
      exec(
        this.#sql,
        `DELETE FROM pack_claims WHERE repo_id = ? AND pack_id IN (${placeholders(batch.length)})`,
        repoId,
        ...batch,
      );
    return this.unclaimed(packIds);
  }

  /**
   * Drops `repoId`'s claims on the packs of `releases`, each only while its
   * sequence is at most the release's `upTo` (the latest the repository had
   * learnt when its view gave the pack up): a claim made again since, which
   * a release arriving late must not undo, stays. Returns the shared packs
   * no member claims any more.
   */
  releaseUpTo(
    repoId: string,
    releases: readonly { readonly packId: string; readonly upTo: number }[],
  ): string[] {
    for (const release of releases)
      exec(
        this.#sql,
        "DELETE FROM pack_claims WHERE pack_id = ? AND repo_id = ? AND seq <= ?",
        release.packId,
        repoId,
        release.upTo,
      );
    return this.unclaimed(releases.map((r) => r.packId));
  }

  /** Of `packIds`, the shared packs nobody claims. */
  unclaimed(packIds: readonly string[]): string[] {
    const out: string[] = [];
    for (const batch of chunks(packIds))
      for (const row of all<{ pack_id: string }>(
        this.#sql,
        `SELECT p.pack_id FROM network_packs p WHERE p.state = 'shared'
           AND p.pack_id IN (${placeholders(batch.length)})
           AND NOT EXISTS (SELECT 1 FROM pack_claims c WHERE c.pack_id = p.pack_id)`,
        ...batch,
      ))
        out.push(row.pack_id);
    return out;
  }

  /** Every shared pack nobody claims. */
  allUnclaimed(): string[] {
    return all<{ pack_id: string }>(
      this.#sql,
      `SELECT p.pack_id FROM network_packs p WHERE p.state = 'shared'
         AND NOT EXISTS (SELECT 1 FROM pack_claims c WHERE c.pack_id = p.pack_id)
       ORDER BY p.pack_id`,
    ).map((r) => r.pack_id);
  }

  /** Of `packIds`, those the network knows (shared, condemned or deleted). */
  known(packIds: readonly string[]): Set<string> {
    const out = new Set<string>();
    for (const batch of chunks(packIds))
      for (const row of all<{ pack_id: string }>(
        this.#sql,
        `SELECT pack_id FROM network_packs WHERE pack_id IN (${placeholders(batch.length)})`,
        ...batch,
      ))
        out.add(row.pack_id);
    return out;
  }

  /** Whether the network shares any pack whose bytes are not deleted yet. */
  hasLivePacks(): boolean {
    return (
      all(this.#sql, "SELECT 1 AS one FROM network_packs WHERE state <> 'deleted' LIMIT 1").length >
      0
    );
  }

  packState(packId: string): string | undefined {
    return all<{ state: string }>(
      this.#sql,
      "SELECT state FROM network_packs WHERE pack_id = ?",
      packId,
    )[0]?.state;
  }

  /**
   * Phase 1 of a shared pack's deletion: it is condemned here, and every
   * member still has to acknowledge it (refuse new leases on it, report
   * its leases). Deletion waits for the retention from now.
   */
  condemn(packIds: readonly string[], retentionMs: number): void {
    const now = this.context.now();
    const pending = JSON.stringify(
      this.members(["joining", "active", "detaching", "detached"]).map((m) => m.repoId),
    );
    for (const packId of packIds) {
      const moved = exec(
        this.#sql,
        `UPDATE network_packs SET state = 'condemned', updated_at = ?
         WHERE pack_id = ? AND state = 'shared'`,
        now,
        packId,
      );
      if (moved === 0) continue;
      exec(
        this.#sql,
        `INSERT INTO deletions (pack_id, condemned_at, acks_pending, leases_until, not_before)
         VALUES (?, ?, ?, 0, ?)`,
        packId,
        now,
        pending,
        now + retentionMs,
      );
    }
  }

  /**
   * Puts a condemned pack back to shared (a member still holds it). Returns
   * false, changing nothing, once its deletion has begun (the fence is set).
   */
  reprieve(packId: string): boolean {
    if (this.deleting(packId)) return false;
    exec(this.#sql, "DELETE FROM deletions WHERE pack_id = ?", packId);
    exec(
      this.#sql,
      "UPDATE network_packs SET state = 'shared', updated_at = ? WHERE pack_id = ? AND state = 'condemned'",
      this.context.now(),
      packId,
    );
    return true;
  }

  /** Whether the pack's deletion has begun: its bytes may be gone already. */
  deleting(packId: string): boolean {
    return (
      all(
        this.#sql,
        "SELECT 1 AS one FROM deletions WHERE pack_id = ? AND deleting_since IS NOT NULL",
        packId,
      ).length > 0
    );
  }

  /**
   * Sets the deletion fence of a condemned pack, durably and before any
   * byte is deleted: from now on no claim or share takes it back, and the
   * deletion is finished even across resets. False if it is not condemned.
   */
  fence(packId: string): boolean {
    return (
      exec(
        this.#sql,
        "UPDATE deletions SET deleting_since = coalesce(deleting_since, ?) WHERE pack_id = ?",
        this.context.now(),
        packId,
      ) > 0
    );
  }

  deletions(): Deletion[] {
    return all<{
      pack_id: string;
      condemned_at: number;
      acks_pending: string;
      leases_until: number;
      not_before: number;
      deleting_since: number | null;
    }>(this.#sql, "SELECT * FROM deletions ORDER BY not_before, pack_id").map((r) => ({
      packId: r.pack_id,
      condemnedAt: r.condemned_at,
      acksPending: JSON.parse(r.acks_pending) as string[],
      leasesUntil: r.leases_until,
      notBefore: r.not_before,
      deletingSince: r.deleting_since,
    }));
  }

  deletion(packId: string): Deletion | undefined {
    return this.deletions().find((d) => d.packId === packId);
  }

  /** Records `repoId`'s acknowledgement of a condemned pack and the end of its leases on it. */
  acknowledge(packId: string, repoId: string, leasesUntil: number): void {
    const current = this.deletion(packId);
    if (!current) return;
    exec(
      this.#sql,
      "UPDATE deletions SET acks_pending = ?, leases_until = max(leases_until, ?) WHERE pack_id = ?",
      JSON.stringify(current.acksPending.filter((id) => id !== repoId)),
      leasesUntil,
      packId,
    );
  }

  /** Phase 2 done: the bytes are gone. */
  markDeleted(packId: string): void {
    exec(this.#sql, "DELETE FROM deletions WHERE pack_id = ?", packId);
    exec(
      this.#sql,
      "UPDATE network_packs SET state = 'deleted', updated_at = ? WHERE pack_id = ?",
      this.context.now(),
      packId,
    );
  }

  gcState(): GcState {
    const row = all<{ epoch: number; phase: string; fence: number; fence_since: number | null }>(
      this.#sql,
      "SELECT epoch, phase, fence, fence_since FROM gc_state WHERE id = 1",
    )[0] as { epoch: number; phase: string; fence: number; fence_since: number | null };
    return {
      epoch: row.epoch,
      phase: row.phase as GcState["phase"],
      fence: row.fence === 1,
      fenceSince: row.fence_since,
    };
  }

  setGcState(state: { epoch?: number; phase: GcState["phase"]; fence: boolean }): void {
    const now = this.context.now();
    exec(
      this.#sql,
      `UPDATE gc_state SET epoch = coalesce(?, epoch), phase = ?, fence = ?,
         fence_since = CASE WHEN ? = 1 THEN coalesce(fence_since, ?) ELSE NULL END, updated_at = ?
       WHERE id = 1`,
      state.epoch ?? null,
      state.phase,
      state.fence ? 1 : 0,
      state.fence ? 1 : 0,
      now,
      now,
    );
  }
}
