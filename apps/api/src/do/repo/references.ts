import type { RefActor, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { MAX_REFERENCES, referencesIn } from "@fyrden/domain";
import type { RepoEvents } from "./events.js";
import type { SubjectKind } from "./issues.js";

/*
 * References between issues and pull requests (schema v36). A source is an
 * issue's or pull request's body (comment 0) or a conversation comment;
 * what it names is written with the source's change: in this repository
 * at once (`incoming_references`), in another as a `reference.sync` event
 * whose effect hands that repository the source's whole set for it (an
 * empty one when no longer named), applied in the order of the source's
 * events. Names of other repositories are resolved to ids before a change
 * (`prepare`, with the texts it writes) and kept here; a name not resolved
 * then is not recorded. When a pull request merges into the default branch, what its
 * description closes is closed: here in the merge's transaction, elsewhere
 * by a `reference.close` event carrying the merger's credential, checked
 * where it applies.
 */

/** A source of references: an issue's or pull request's body (comment 0), or a comment. */
export interface ReferenceSource {
  readonly kind: SubjectKind;
  readonly number: number;
  readonly comment: number;
}

/** A source's references into one repository, as another repository applies them. */
export interface IncomingReferences {
  readonly sourceRepo: string;
  readonly sourceNumber: number;
  readonly sourceComment: number;
  readonly sourceKind: SubjectKind;
  readonly numbers: readonly number[];
  /** The source's event that sent them: a set from an earlier one changes nothing. */
  readonly epochGen: number;
  readonly sourceSeq: number;
}

/** A reference to one of this repository's issues or pull requests, as it is listed. */
export interface ReferenceRecord {
  readonly sourceRepo: string;
  readonly sourceNumber: number;
  /** 0 for the issue's or pull request's body. */
  readonly sourceComment: number;
  readonly sourceKind: SubjectKind;
  readonly createdAt: number;
}

/** Where a listing of references starts after. */
export type ReferenceCursor = Pick<
  ReferenceRecord,
  "sourceRepo" | "sourceKind" | "sourceNumber" | "sourceComment"
>;

/** How long a resolved repository name is used. Proposed. */
const RESOLVED_TTL_MS = 60_000;
/** Resolved names kept at most. */
const RESOLVED_MAX = 1_000;

type Outgoing = { repo_id: string; number: number; closes: number; name: string };

export class RepoReferences {
  /** The listing cursors' key, once read. */
  #key: Promise<CryptoKey> | undefined;

  constructor(
    private readonly deps: {
      readonly git: RepoGitStorage;
      readonly events: RepoEvents;
      readonly repoId: () => string;
      /** Whether `number` is an issue or a pull request here now. */
      readonly kindOf: (number: number) => SubjectKind | undefined;
      /** Resolves `owner/name` to an active repository's id. */
      readonly resolve: (owner: string, name: string) => Promise<string | null>;
    },
  ) {}

  /**
   * Before a change: resolves the other repositories `texts` name (each at
   * most once a minute), keeping the answers with the repository: the
   * change, and a merge however long after, read them from there.
   */
  async prepare(texts: readonly (string | null | undefined)[]): Promise<void> {
    const now = this.deps.git.context.now();
    const wanted = new Set<string>();
    for (const text of texts)
      for (const ref of referencesIn(text))
        if (ref.repo) {
          const key = `${ref.repo.owner}/${ref.repo.name}`;
          const [known] = this.#exec<{ resolved_at: number }>(
            "SELECT resolved_at FROM resolved_repos WHERE name = ?",
            key,
          );
          if (!known || now - known.resolved_at > RESOLVED_TTL_MS) wanted.add(key);
        }
    for (const key of [...wanted].slice(0, MAX_REFERENCES)) {
      const [owner, name] = key.split("/") as [string, string];
      const id = await this.deps.resolve(owner, name);
      this.#exec(
        `INSERT INTO resolved_repos (name, repo_id, resolved_at) VALUES (?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET repo_id = excluded.repo_id, resolved_at = excluded.resolved_at`,
        key,
        id,
        this.deps.git.context.now(),
      );
    }
    // The oldest go past the bound.
    this.#exec(
      `DELETE FROM resolved_repos WHERE name IN (
         SELECT name FROM resolved_repos ORDER BY resolved_at DESC LIMIT -1 OFFSET ?)`,
      RESOLVED_MAX,
    );
  }

  /** The repository `owner/name` names, as last resolved here; undefined when never resolved, or none. */
  #repoOf(repo: { readonly owner: string; readonly name: string }): string | undefined {
    return (
      this.#exec<{ repo_id: string | null }>(
        "SELECT repo_id FROM resolved_repos WHERE name = ?",
        `${repo.owner}/${repo.name}`,
      )[0]?.repo_id ?? undefined
    );
  }

  /**
   * In a source's change: what it names now (`text`; null when it is gone)
   * replaces what it named. Numbers here that are issues or pull requests
   * are recorded at once (not the source itself); other repositories that
   * gained or lost references are told by one `reference.sync` event.
   */
  sync(source: ReferenceSource, text: string | null, actor: RefActor | null): void {
    const own = this.deps.repoId();
    const now = this.deps.git.context.now();
    const next = new Map<
      string,
      { repoId: string; number: number; closes: boolean; name: string }
    >();
    for (const ref of referencesIn(text)) {
      const repoId = ref.repo ? this.#repoOf(ref.repo) : own;
      if (!repoId) continue;
      // Kept whether the number exists yet or not (a merge reads it later), the source itself too:
      // its name keeps where it pointed, though it refers to nothing and closes nothing.
      // Each name it is written with keeps where it points (one target may be named twice).
      const name = ref.repo ? `${ref.repo.owner}/${ref.repo.name}` : "";
      next.set(`${repoId}#${ref.number}#${name}`, {
        repoId,
        number: ref.number,
        closes: ref.closes,
        name,
      });
    }
    const before = this.#exec<Outgoing>(
      "SELECT repo_id, number, closes, name FROM outgoing_references WHERE source_number = ? AND source_comment = ?",
      source.number,
      source.comment,
    );
    const unchanged =
      before.length === next.size &&
      before.every(
        (r) => next.get(`${r.repo_id}#${r.number}#${r.name}`)?.closes === (r.closes === 1),
      );
    if (unchanged) return;
    this.#exec(
      "DELETE FROM outgoing_references WHERE source_number = ? AND source_comment = ?",
      source.number,
      source.comment,
    );
    for (const ref of next.values())
      this.#exec(
        `INSERT INTO outgoing_references (source_number, source_comment, repo_id, number, closes, name)
         VALUES (?, ?, ?, ?, ?, ?)`,
        source.number,
        source.comment,
        ref.repoId,
        ref.number,
        ref.closes ? 1 : 0,
        ref.name,
      );
    // Here: the source's references replaced, keeping when each was first made.
    const ownNext = [
      ...new Set(
        [...next.values()]
          .filter(
            (r) =>
              r.repoId === own &&
              r.number !== source.number &&
              this.deps.kindOf(r.number) !== undefined,
          )
          .map((r) => r.number),
      ),
    ];
    this.#exec(
      `DELETE FROM incoming_references WHERE source_repo = ? AND source_number = ?
         AND source_comment = ? AND target NOT IN (SELECT value FROM json_each(?))`,
      own,
      source.number,
      source.comment,
      JSON.stringify(ownNext),
    );
    for (const target of ownNext)
      this.#exec(
        `INSERT OR IGNORE INTO incoming_references
           (target, source_repo, source_number, source_comment, source_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        target,
        own,
        source.number,
        source.comment,
        source.kind,
        now,
      );
    // Elsewhere: each repository named before or now gets the source's set for it.
    const repos = new Map<string, Set<number>>();
    for (const r of before) if (r.repo_id !== own) repos.set(r.repo_id, new Set());
    for (const r of next.values())
      if (r.repoId !== own) repos.set(r.repoId, (repos.get(r.repoId) ?? new Set()).add(r.number));
    if (repos.size > 0)
      this.deps.events.emitActivity("reference.sync", actor, {
        source_number: source.number,
        source_comment: source.comment,
        source_kind: source.kind,
        repos: [...repos].map(([repo_id, numbers]) => ({ repo_id, numbers: [...numbers] })),
      });
  }

  /**
   * In an issue's deletion: what it and its comments named goes (other
   * repositories told), and so does what named it.
   */
  forgetSubject(number: number, actor: RefActor | null): void {
    for (const { source_comment } of this.#exec<{ source_comment: number }>(
      "SELECT DISTINCT source_comment FROM outgoing_references WHERE source_number = ?",
      number,
    ))
      this.sync({ kind: "issue", number, comment: source_comment }, null, actor);
    this.#exec("DELETE FROM incoming_references WHERE target = ?", number);
  }

  /** From another repository: a source's set of references here, unless an earlier event's. */
  apply(input: IncomingReferences): void {
    const [last] = this.#exec<{ epoch_gen: number; source_seq: number }>(
      `SELECT epoch_gen, source_seq FROM reference_sources
       WHERE source_repo = ? AND source_number = ? AND source_comment = ?`,
      input.sourceRepo,
      input.sourceNumber,
      input.sourceComment,
    );
    if (
      last &&
      (last.epoch_gen > input.epochGen ||
        (last.epoch_gen === input.epochGen && last.source_seq >= input.sourceSeq))
    )
      return;
    const now = this.deps.git.context.now();
    const targets = [...new Set(input.numbers)]
      .slice(0, MAX_REFERENCES)
      .filter((n) => this.deps.kindOf(n) !== undefined);
    this.deps.git.context.storage.transactionSync(() => {
      this.#exec(
        `INSERT INTO reference_sources (source_repo, source_number, source_comment, epoch_gen, source_seq)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (source_repo, source_number, source_comment)
         DO UPDATE SET epoch_gen = excluded.epoch_gen, source_seq = excluded.source_seq`,
        input.sourceRepo,
        input.sourceNumber,
        input.sourceComment,
        input.epochGen,
        input.sourceSeq,
      );
      this.#exec(
        `DELETE FROM incoming_references WHERE source_repo = ? AND source_number = ?
           AND source_comment = ? AND target NOT IN (SELECT value FROM json_each(?))`,
        input.sourceRepo,
        input.sourceNumber,
        input.sourceComment,
        JSON.stringify(targets),
      );
      for (const target of targets)
        this.#exec(
          `INSERT OR IGNORE INTO incoming_references
             (target, source_repo, source_number, source_comment, source_kind, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          target,
          input.sourceRepo,
          input.sourceNumber,
          input.sourceComment,
          input.sourceKind,
          now,
        );
    });
  }

  /**
   * A page of what refers to `target` (see `list`), each with two cursors,
   * sealed with this repository's key and bound to `target`: `cursor`
   * after it, `groupEnd` after every reference of its source repository and
   * kind (to pass over those a reader may not see). A cursor tells nothing
   * of the reference it names (each is the same length); one for another
   * target, or not made here, is refused (`invalid_cursor`).
   */
  async page(
    target: number,
    cursor: string | null,
    limit: number,
  ): Promise<
    (ReferenceRecord & { readonly cursor: string; readonly groupEnd: string })[] | "invalid_cursor"
  > {
    const key = await this.#cursorKey();
    let after: ReferenceCursor | null = null;
    if (cursor !== null) {
      const opened = await openCursor(key, target, cursor);
      if (!opened) return "invalid_cursor";
      after = opened;
    }
    const rows = this.list(target, after, limit);
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        cursor: await sealCursor(key, target, row),
        groupEnd: await sealCursor(key, target, {
          ...row,
          sourceNumber: Number.MAX_SAFE_INTEGER,
          sourceComment: Number.MAX_SAFE_INTEGER,
        }),
      })),
    );
  }

  /** The key listing cursors are sealed with: made once, kept with the repository. */
  async #cursorKey(): Promise<CryptoKey> {
    if (!this.#key) {
      let [row] = this.#exec<{ key: ArrayBuffer }>("SELECT key FROM cursor_keys WHERE id = 1");
      if (!row) {
        this.#exec(
          "INSERT OR IGNORE INTO cursor_keys (id, key) VALUES (1, ?)",
          crypto.getRandomValues(new Uint8Array(32)),
        );
        [row] = this.#exec<{ key: ArrayBuffer }>("SELECT key FROM cursor_keys WHERE id = 1");
      }
      this.#key = crypto.subtle.importKey(
        "raw",
        (row as { key: ArrayBuffer }).key,
        "AES-GCM",
        false,
        ["encrypt", "decrypt"],
      );
    }
    return this.#key;
  }

  /** A page of what refers to `target`, by source repository, kind, number and comment, after `after`. */
  list(target: number, after: ReferenceCursor | null, limit: number): ReferenceRecord[] {
    return this.#exec<{
      source_repo: string;
      source_number: number;
      source_comment: number;
      source_kind: SubjectKind;
      created_at: number;
    }>(
      `SELECT source_repo, source_number, source_comment, source_kind, created_at
       FROM incoming_references WHERE target = ?1
         AND (source_repo, source_kind, source_number, source_comment) > (?2, ?3, ?4, ?5)
       ORDER BY source_repo, source_kind, source_number, source_comment LIMIT ?6`,
      target,
      after?.sourceRepo ?? "",
      after?.sourceKind ?? "",
      after?.sourceNumber ?? 0,
      after?.sourceComment ?? -1,
      limit,
    ).map((row) => ({
      sourceRepo: row.source_repo,
      sourceNumber: row.source_number,
      sourceComment: row.source_comment,
      sourceKind: row.source_kind,
      createdAt: row.created_at,
    }));
  }

  /**
   * In a merge's transaction: what pull request `number`'s description
   * (`body`, as it is now) closes: what it names after a closing keyword,
   * each in one repository: `#N` here; `owner/repo#N` where it pointed
   * when the description was written (kept with it), else where the name
   * resolves now.
   */
  closing(
    number: number,
    body: string | null,
  ): { here: number[]; elsewhere: { repoId: string; number: number }[] } {
    const own = this.deps.repoId();
    const here = new Set<number>();
    const elsewhere = new Map<string, { repoId: string; number: number }>();
    const bound = new Map(
      this.#exec<Outgoing>(
        `SELECT repo_id, number, closes, name FROM outgoing_references
         WHERE source_number = ? AND source_comment = 0 AND name <> ''`,
        number,
      ).map((row) => [`${row.name}#${row.number}`, row.repo_id]),
    );
    for (const ref of referencesIn(body)) {
      if (!ref.closes) continue;
      const repoId = ref.repo
        ? (bound.get(`${ref.repo.owner}/${ref.repo.name}#${ref.number}`) ?? this.#repoOf(ref.repo))
        : own;
      if (repoId === own) {
        if (ref.number !== number) here.add(ref.number);
      } else if (repoId) elsewhere.set(`${repoId}#${ref.number}`, { repoId, number: ref.number });
    }
    return { here: [...here], elsewhere: [...elsewhere.values()] };
  }

  /** What came of a close another repository's effect asked for, if it was applied already. */
  closeOutcome(effectId: string): "closed" | "unchanged" | "refused" | undefined {
    return this.#exec<{ outcome: "closed" | "unchanged" | "refused" }>(
      "SELECT outcome FROM reference_closes WHERE effect_id = ?",
      effectId,
    )[0]?.outcome;
  }

  /** In the close's transaction: what came of it, so that a repeat of the effect answers the same. */
  recordClose(effectId: string, outcome: "closed" | "unchanged" | "refused"): void {
    this.#exec(
      "INSERT INTO reference_closes (effect_id, outcome, at) VALUES (?, ?, ?)",
      effectId,
      outcome,
      this.deps.git.context.now(),
    );
  }

  #exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    const cursor = this.deps.git.context.storage.sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    if (cursor.rowsWritten > 0)
      this.deps.git.context.metrics.count(
        "do.rows_written",
        { class: this.deps.git.context.doClass, op: "references.write" },
        cursor.rowsWritten,
      );
    return rows;
  }
}

const CURSOR_IV_BYTES = 12;
/** What a cursor seals, padded: a repository id, a kind and two safe integers fit well within it. */
const CURSOR_PLAIN_BYTES = 160;

/** Base64url of `bytes`, unpadded. */
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** A listing cursor: the position, encrypted and authenticated, bound to `target`. */
async function sealCursor(key: CryptoKey, target: number, at: ReferenceCursor): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(CURSOR_IV_BYTES));
  // Padded to one length: a cursor's size tells nothing of the position it holds.
  const plain = new TextEncoder().encode(
    JSON.stringify([at.sourceRepo, at.sourceKind, at.sourceNumber, at.sourceComment]).padEnd(
      CURSOR_PLAIN_BYTES,
    ),
  );
  if (plain.length !== CURSOR_PLAIN_BYTES) throw new Error("a reference position is too long");
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`references:${target}`) },
      key,
      plain,
    ),
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return base64url(out);
}

/** The position a cursor `sealCursor` made for `target` holds; undefined for any other. */
async function openCursor(
  key: CryptoKey,
  target: number,
  cursor: string,
): Promise<ReferenceCursor | undefined> {
  try {
    const bytes = Uint8Array.from(atob(cursor.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
      c.charCodeAt(0),
    );
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.slice(0, CURSOR_IV_BYTES),
        additionalData: new TextEncoder().encode(`references:${target}`),
      },
      key,
      bytes.slice(CURSOR_IV_BYTES),
    );
    const [sourceRepo, sourceKind, sourceNumber, sourceComment] = JSON.parse(
      new TextDecoder().decode(plain),
    ) as [unknown, unknown, unknown, unknown];
    if (
      typeof sourceRepo !== "string" ||
      (sourceKind !== "issue" && sourceKind !== "pull") ||
      !Number.isSafeInteger(sourceNumber) ||
      !Number.isSafeInteger(sourceComment)
    )
      return undefined;
    return {
      sourceRepo,
      sourceKind,
      sourceNumber: sourceNumber as number,
      sourceComment: sourceComment as number,
    };
  } catch {
    return undefined;
  }
}
