import type { RefActor, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  atLeast,
  MAX_RELEASES,
  type ReleaseEvent,
  releaseEventsOfCreate,
  releaseEventsOfPublish,
} from "@fyrden/domain";
import { type Oid, oidFromHex, oidToHex } from "@fyrden/git-core";
import { releaseOutput } from "../../repos/shapes.js";
import { capturable } from "../../webhooks/captures.js";
import type { RepoEvents } from "./events.js";
import type { PullCaller } from "./pulls.js";
import type { AssetRecord, RepoReleaseAssets } from "./release-assets.js";

/** What publishing was prepared with: a tag's object and commit, as read before the change. */
export interface TagTarget {
  readonly tag: string;
  readonly tagOid: string;
  readonly commitOid: string;
}

export type TagRefusal = "tag_not_found" | "tag_not_a_commit";

/** What a peel found: the target, or why there is none. */
export type PreparedTag = TagTarget | { readonly refused: TagRefusal };

export interface ReleaseRecord {
  readonly id: number;
  readonly tagName: string;
  readonly name: string | null;
  readonly body: string | null;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly author: string;
  readonly tagOid: string | null;
  readonly commitOid: string | null;
  readonly publishedAt: number | null;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** What became of the tag, worked out at read; null on a draft. */
  readonly tagState: "current" | "moved" | "deleted" | null;
  readonly currentTagOid: string | null;
  /** Its assets, in name order: at most 100. */
  readonly assets: readonly AssetRecord[];
}

export type ReleaseFailure =
  | "forbidden"
  | "release_not_found"
  | "release_exists"
  | "release_published"
  | "too_many_releases"
  | "tag_moving"
  | TagRefusal;

export type ReleaseAnswer =
  | { ok: true; release: ReleaseRecord }
  | { ok: false; code: ReleaseFailure }
  | { ok: false; code: "stale"; version: number };

export interface ReleaseCursor {
  readonly draft: boolean;
  readonly publishedAt: number | null;
  readonly id: number;
}

type Row = {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: number;
  prerelease: number;
  author: string;
  tag_oid: ArrayBuffer | null;
  commit_oid: ArrayBuffer | null;
  published_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
};

const hexOf = (value: ArrayBuffer | null) =>
  value === null ? null : oidToHex(new Uint8Array(value) as Oid);
const tagRef = (tag: string) => `refs/tags/${tag}`;

/**
 * A repository's releases. A draft has no git state. Publishing records the
 * tag object and its peeled commit once and for good, in the transaction
 * that rechecks the tag; those two ids are roots of collection and detach.
 */
export class RepoReleases {
  constructor(
    private readonly deps: {
      readonly git: RepoGitStorage;
      readonly events: RepoEvents;
      /** In a deleting transaction: asks for a collection, since no ref moved. */
      readonly collect: () => void;
      readonly assets: Pick<RepoReleaseAssets, "ofReleases" | "retainRelease">;
    },
  ) {}

  /** The ids a published release keeps alive; each once. */
  roots(): Oid[] {
    const seen = new Map<string, Oid>();
    for (const row of this.#exec<{ tag_oid: ArrayBuffer; commit_oid: ArrayBuffer }>(
      "SELECT tag_oid, commit_oid FROM releases WHERE draft = 0",
    )) {
      for (const value of [row.tag_oid, row.commit_oid]) {
        const oid = new Uint8Array(value) as Oid;
        seen.set(oidToHex(oid), oid);
      }
    }
    return [...seen.values()];
  }

  get(id: number): ReleaseRecord | undefined {
    return this.#one("SELECT * FROM releases WHERE id = ?", id);
  }

  byTag(tag: string): ReleaseRecord | undefined {
    return this.#one("SELECT * FROM releases WHERE tag_name = ?", tag);
  }

  latest(): ReleaseRecord | undefined {
    return this.#one(
      `SELECT * FROM releases WHERE draft = 0 AND prerelease = 0
       ORDER BY published_at DESC, id DESC LIMIT 1`,
    );
  }

  /** A page: drafts by id, if the caller sees them, then published releases by publication. */
  list(query: {
    readonly drafts: boolean;
    readonly after: ReleaseCursor | null;
    readonly limit: number;
  }): ReleaseRecord[] {
    const { drafts, after, limit } = query;
    const rows: Row[] = [];
    if (drafts && (after === null || after.draft))
      rows.push(
        ...this.#exec<Row>(
          `SELECT * FROM releases WHERE draft = 1 AND id < ? ORDER BY id DESC LIMIT ?`,
          after?.id ?? Number.MAX_SAFE_INTEGER,
          limit,
        ),
      );
    if (rows.length < limit) {
      const at = after && !after.draft ? after : null;
      rows.push(
        ...this.#exec<Row>(
          `SELECT * FROM releases
           WHERE draft = 0 AND (published_at, id) < (?, ?)
           ORDER BY published_at DESC, id DESC LIMIT ?`,
          at?.publishedAt ?? Number.MAX_SAFE_INTEGER,
          at?.id ?? Number.MAX_SAFE_INTEGER,
          limit - rows.length,
        ),
      );
    }
    return this.#records(rows);
  }

  /**
   * Creates a release in one transaction; `prepared` is how a published one
   * was peeled, so nothing is written before the recheck: a tag that moved
   * leaves no draft and no event.
   */
  create(
    input: {
      readonly tagName: string;
      readonly name: string | null;
      readonly body: string | null;
      readonly draft: boolean;
      readonly prerelease: boolean;
    },
    caller: PullCaller,
    prepared: PreparedTag | undefined,
  ): ReleaseAnswer {
    if (!atLeast(caller.role, "write")) return { ok: false, code: "forbidden" };
    if (this.#tagTaken(input.tagName)) return { ok: false, code: "release_exists" };
    if (this.#count() >= MAX_RELEASES) return { ok: false, code: "too_many_releases" };
    const target = input.draft ? undefined : this.#recheck(input.tagName, prepared);
    if (target && "code" in target) return { ok: false, code: target.code };
    const release = this.#storage().transactionSync(() => {
      const now = this.#now();
      const [row] = this.#exec<Row>(
        `INSERT INTO releases (tag_name, name, body, draft, prerelease, author, tag_oid, commit_oid,
           published_at, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING *`,
        input.tagName,
        input.name,
        input.body,
        input.draft ? 1 : 0,
        input.prerelease ? 1 : 0,
        caller.actor.principal,
        target ? oidFromHex(target.tagOid) : null,
        target ? oidFromHex(target.commitOid) : null,
        target ? now : null,
        now,
        now,
      );
      const made = this.#record(row as Row);
      for (const event of releaseEventsOfCreate(input)) this.#emit(event, made, caller.actor);
      this.deps.events.auditChange("release.create", caller.actor, {
        release: made.id,
        tag: made.tagName,
      });
      return made;
    });
    return { ok: true, release };
  }

  /** Changes a release; publishes a draft given `draft: false` and how its tag was peeled. */
  update(
    id: number,
    patch: {
      readonly tagName?: string;
      readonly name?: string | null;
      readonly body?: string | null;
      readonly draft?: boolean;
      readonly prerelease?: boolean;
    },
    caller: PullCaller,
    prepared: PreparedTag | undefined,
    expected?: number,
  ): ReleaseAnswer {
    if (!atLeast(caller.role, "write")) return { ok: false, code: "forbidden" };
    const current = this.get(id);
    if (!current) return { ok: false, code: "release_not_found" };
    if (expected !== undefined && current.version !== expected)
      return { ok: false, code: "stale", version: current.version };
    const tagName = patch.tagName ?? current.tagName;
    if (!current.draft && (patch.draft === true || tagName !== current.tagName))
      return { ok: false, code: "release_published" };
    if (tagName !== current.tagName && this.#tagTaken(tagName))
      return { ok: false, code: "release_exists" };
    const next = {
      name: patch.name === undefined ? current.name : patch.name,
      body: patch.body === undefined ? current.body : patch.body,
      prerelease: patch.prerelease ?? current.prerelease,
    };
    const publishing = current.draft && patch.draft === false;
    const target = publishing ? this.#recheck(tagName, prepared) : undefined;
    if (target && "code" in target) return { ok: false, code: target.code };
    const changes = {
      ...(tagName !== current.tagName && { tag_name: { from: current.tagName } }),
      ...(next.name !== current.name && { name: { from: current.name } }),
      ...(next.body !== current.body && { body: { from: current.body } }),
      ...(next.prerelease !== current.prerelease && { prerelease: { from: current.prerelease } }),
    };
    const edited = Object.keys(changes).length > 0;
    if (!edited && !publishing) return { ok: true, release: current };
    const release = this.#storage().transactionSync(() => {
      const now = this.#now();
      const [row] = this.#exec<Row>(
        `UPDATE releases SET tag_name = ?, name = ?, body = ?, prerelease = ?,
           draft = ?, tag_oid = coalesce(?, tag_oid), commit_oid = coalesce(?, commit_oid),
           published_at = coalesce(?, published_at), version = version + 1, updated_at = ?
         WHERE id = ? RETURNING *`,
        tagName,
        next.name,
        next.body,
        next.prerelease ? 1 : 0,
        publishing || !current.draft ? 0 : 1,
        target ? oidFromHex(target.tagOid) : null,
        target ? oidFromHex(target.commitOid) : null,
        target ? now : null,
        now,
        id,
      );
      const updated = this.#record(row as Row);
      if (edited) this.#emit("release.edited", updated, caller.actor, changes);
      if (publishing)
        for (const event of releaseEventsOfPublish(updated.prerelease))
          this.#emit(event, updated, caller.actor);
      else if (!updated.draft && current.prerelease && !updated.prerelease)
        this.#emit("release.released", updated, caller.actor);
      this.deps.events.auditChange(publishing ? "release.publish" : "release.edit", caller.actor, {
        release: id,
        tag: updated.tagName,
      });
      return updated;
    });
    return { ok: true, release };
  }

  /** Deletes a release; its tag stays. Only a published one held anything for collection to free. */
  delete(id: number, caller: PullCaller): { ok: true } | { ok: false; code: ReleaseFailure } {
    if (!atLeast(caller.role, "write")) return { ok: false, code: "forbidden" };
    const current = this.get(id);
    if (!current) return { ok: false, code: "release_not_found" };
    this.#storage().transactionSync(() => {
      this.#exec("DELETE FROM releases WHERE id = ?", id);
      // Its assets' objects stay for 30 days, still counted, as a deleted asset's do.
      this.deps.assets.retainRelease(id);
      this.#emit("release.deleted", current, caller.actor);
      this.deps.events.auditChange("release.delete", caller.actor, {
        release: id,
        tag: current.tagName,
      });
      if (!current.draft) this.deps.collect();
    });
    return { ok: true };
  }

  #tagTaken(tag: string): boolean {
    return this.#exec("SELECT 1 FROM releases WHERE tag_name = ?", tag).length > 0;
  }

  /** The tag's object as a ref names it now, one row, never the whole ref table. */
  tagOid(tag: string): string | undefined {
    const [row] = this.#exec<{ oid: ArrayBuffer }>(
      "SELECT oid FROM refs WHERE name = ? AND kind = 'direct'",
      tagRef(tag),
    );
    return row ? oidToHex(new Uint8Array(row.oid) as Oid) : undefined;
  }

  /**
   * With no await since `#pullChange` began its change: the tag is still
   * where the peel read it, and its commit still known. A commit row can
   * only go if its pack was condemned during the peel.
   */
  #recheck(tag: string, prepared: PreparedTag | undefined): TagTarget | { code: ReleaseFailure } {
    if (prepared === undefined) return { code: "tag_moving" };
    if ("refused" in prepared) return { code: prepared.refused };
    if (prepared.tag !== tag) return { code: "tag_moving" };
    const now = this.tagOid(tag);
    if (now === undefined) return { code: "tag_not_found" };
    if (now !== prepared.tagOid) return { code: "tag_moving" };
    const [row] = this.deps.git.commitGraph.readSync([oidFromHex(prepared.commitOid)], "verified");
    if (row?.state !== "verified") return { code: "tag_not_found" };
    return prepared;
  }

  #emit(
    type: ReleaseEvent,
    release: ReleaseRecord,
    actor: RefActor,
    changes?: Record<string, unknown>,
  ): void {
    this.deps.events.emitActivity(
      type,
      actor,
      { release_id: release.id, tag: release.tagName },
      () => ({
        release: capturable(releaseOutput(release)),
        ...(changes && { changes: capturable(changes) }),
      }),
    );
  }

  #count(): number {
    return this.#exec<{ n: number }>("SELECT count(*) AS n FROM releases")[0]?.n ?? 0;
  }

  #one(query: string, ...bindings: unknown[]): ReleaseRecord | undefined {
    const rows = this.#exec<Row>(query, ...bindings);
    return this.#records(rows)[0];
  }

  /** Records with their tags' states: one read of a page's ref rows, no scan of the refs. */
  #records(rows: readonly Row[]): ReleaseRecord[] {
    const published = rows.filter((row) => row.draft === 0);
    // One bound value, as JSON: a page of 100 and its lookahead is past SQLite's 100 per query here.
    const names = JSON.stringify(published.map((row) => tagRef(row.tag_name)));
    const refs = new Map<string, string>();
    if (published.length > 0)
      for (const row of this.#exec<{ name: string; oid: ArrayBuffer }>(
        `SELECT name, oid FROM refs WHERE kind = 'direct'
         AND name IN (SELECT value FROM json_each(?))`,
        names,
      ))
        refs.set(row.name, oidToHex(new Uint8Array(row.oid) as Oid));
    const assets = this.deps.assets.ofReleases(rows.map((row) => row.id));
    return rows.map((row) => this.#record(row, refs, assets));
  }

  #record(
    row: Row,
    refs?: ReadonlyMap<string, string>,
    assets?: ReadonlyMap<number, readonly AssetRecord[]>,
  ): ReleaseRecord {
    const tagOid = hexOf(row.tag_oid);
    const now =
      tagOid === null
        ? undefined
        : refs
          ? refs.get(tagRef(row.tag_name))
          : this.tagOid(row.tag_name);
    const tagState =
      tagOid === null ? null : now === undefined ? "deleted" : now === tagOid ? "current" : "moved";
    return {
      id: row.id,
      tagName: row.tag_name,
      name: row.name,
      body: row.body,
      draft: row.draft === 1,
      prerelease: row.prerelease === 1,
      author: row.author,
      tagOid,
      commitOid: hexOf(row.commit_oid),
      publishedAt: row.published_at,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      tagState,
      currentTagOid: tagState === "moved" ? (now as string) : null,
      assets: (assets ?? this.deps.assets.ofReleases([row.id])).get(row.id) ?? [],
    };
  }

  #storage() {
    return this.deps.git.context.storage;
  }

  #now() {
    return this.deps.git.context.now();
  }

  #exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    const cursor = this.#storage().sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    if (cursor.rowsWritten > 0)
      this.deps.git.context.metrics.count(
        "do.rows_written",
        { class: this.deps.git.context.doClass, op: "releases.write" },
        cursor.rowsWritten,
      );
    return rows;
  }
}
