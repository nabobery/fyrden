import { MemoryWaitTimeoutError, type RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  type BlockCache,
  type Commit,
  GitObjectError,
  type Ident,
  isTreeMode,
  logPage,
  type MemoryReservation,
  MissingCommitError,
  mergeBases,
  type ObjectReader,
  type Oid,
  oidFromHex,
  oidToHex,
  type PathEntryLookup,
  parseCommit,
  reachableCommits,
  treeEntries,
  WalkLimitError,
} from "@fyrden/git-core";
import { HEX_OID } from "../../git/cache/object-access.js";
import { pathSegments } from "../../git/cache/object-check.js";
import { openLiveReader, ReadBudgetError } from "../../git/live-reader.js";
import { peelOid } from "../../git/peel.js";
import { checkSignature, type SignatureCheck } from "./signature.js";

/*
 * Browsing a repository's history, inside its object: branches, tags,
 * commits, the log (optionally of one path) and comparisons. Every answer
 * starts from a commit context: a branch, a tag peeled to a commit, or a
 * full commit id in this repository's verified commit graph. Nothing is
 * read by a bare object id, so objects of other repositories in the same
 * network stay out of reach.
 */

/** Delta-base cache of one browse request. Proposed; tuned under load. */
const BROWSE_DELTA_CACHE_BYTES = 8 * 1024 * 1024;

export interface BrowsePolicy {
  /**
   * R2 reads (index and pack ranges) a history walk may make before it
   * ends its page; showing the page's commits reads more. Free allows
   * 1,000 calls to R2, D1 and Durable Objects per invocation.
   */
  readonly walkReads: number;
  /** R2 reads a tag listing may spend peeling annotated tags before it ends its page. */
  readonly peelReads: number;
  /**
   * R2 reads one request makes at most, whatever it does; past it, the
   * request ends with what it has (a history page) or fails.
   */
  readonly maxReads: number;
  /** Cache API calls one request may make for pack blocks (Free allows 50). */
  readonly cacheCalls: number;
  /**
   * Bytes of commit text one answer carries at most (Workers RPC carries
   * 32 MiB); a history page past it ends early, anything else fails.
   */
  readonly maxResponseBytes: number;
  /** Commits a log page examines at most (a path that rarely changes ends the page early). */
  readonly logMaxExamined: number;
  /** Commits a log page's frontier holds at most (the cursor carries them). */
  readonly logMaxFrontier: number;
  /** Commits a comparison counts on each side at most. */
  readonly compareMaxCommits: number;
  /** Commits a comparison lists (the newest ones); each costs a few R2 reads. */
  readonly compareListed: number;
}

/** Limits of the history operations. Proposed. */
export const BROWSE_POLICY: BrowsePolicy = {
  walkReads: 400,
  peelReads: 400,
  maxReads: 800,
  cacheCalls: 40,
  maxResponseBytes: 8 * 1024 * 1024,
  logMaxExamined: 2_000,
  logMaxFrontier: 256,
  compareMaxCommits: 10_000,
  compareListed: 100,
};

export type BrowseFailure = {
  readonly ok: false;
  readonly status: 403 | 404 | 409 | 422;
  readonly code: string;
  readonly error: string;
};
export type Browsed<T> = { readonly ok: true; readonly value: T } | BrowseFailure;

export interface PersonView {
  readonly name: string;
  readonly email: string;
  /** ISO 8601, UTC. */
  readonly date: string;
}

/** A commit as GitHub's commits API shows it (without its URLs). */
export interface CommitView {
  readonly sha: string;
  readonly commit: {
    readonly message: string;
    readonly author: PersonView;
    readonly committer: PersonView;
    readonly tree: { readonly sha: string };
    /** The signature on its own; the Worker resolves it into GitHub's `verification`. */
    readonly verification: SignatureCheck;
  };
  readonly parents: { readonly sha: string }[];
}

export interface RefView {
  readonly name: string;
  readonly commit: { readonly sha: string };
}

export interface LogInput {
  readonly ref?: string;
  /** A previous page's `next`. */
  readonly cursor?: readonly string[];
  readonly path?: string;
  readonly limit: number;
}

export interface TagPage {
  readonly tags: RefView[];
  /** The last tag looked at, where the next page starts; null when none is left. */
  readonly next: string | null;
}

export interface LogView {
  readonly commits: CommitView[];
  /** The next page's start (commit ids, hex); empty on the last page. */
  readonly next: readonly string[];
}

export interface CompareView {
  readonly status: "identical" | "ahead" | "behind" | "diverged";
  readonly aheadBy: number;
  readonly behindBy: number;
  readonly baseCommit: CommitView;
  readonly mergeBaseCommit: CommitView | null;
  /** Commits in head and not in base, oldest first; the newest `compareListed` of them. */
  readonly commits: CommitView[];
}

export interface BrowseDeps {
  readonly git: RepoGitStorage;
  readonly memoryBlocks: BlockCache;
  /** Replaces limits of `BROWSE_POLICY` (tests). */
  readonly policy?: Partial<BrowsePolicy>;
}

const utf8 = new TextDecoder("utf-8");

export function fail(status: 403 | 404 | 409 | 422, code: string, error: string): BrowseFailure {
  return { ok: false, status, code, error };
}

const EMPTY = fail(409, "repo_empty", "The repository is empty.");
const refNotFound = (ref: string) => fail(404, "ref_not_found", `No commit ${ref} was found.`);

/**
 * One browse request. It opens at most one object reader, on first need,
 * and counts the R2 reads made through it; `close` releases it.
 */
export class RepoBrowse {
  #reader: Promise<ObjectReader | undefined> | undefined;
  readonly #counts = { reads: 0 };
  /** Bytes of commit text this answer carries so far (estimated). */
  #bytes = 0;
  readonly #policy: BrowsePolicy;

  constructor(private readonly deps: BrowseDeps) {
    this.#policy = { ...BROWSE_POLICY, ...deps.policy };
  }

  close(): void {
    // A reader that failed to open (its memory wait timed out) has nothing to release.
    void this.#reader?.then(
      (reader) => reader?.release(),
      () => {},
    );
    this.#reader = undefined;
  }

  /** The repository's branches after `after` (by name), at most `limit`. */
  branches(after: string, limit: number): RefView[] {
    return this.#refsUnder("refs/heads/", after, limit).map(([name, oid]) => ({
      name,
      commit: { sha: oidToHex(oid) },
    }));
  }

  /** One branch, or 404. */
  branch(name: string): Browsed<RefView> {
    const oid = this.deps.git.refStore.readRefsSync().refs.get(`refs/heads/${name}`);
    if (!oid) return fail(404, "branch_not_found", `No branch ${name} was found.`);
    return { ok: true, value: { name, commit: { sha: oidToHex(oid) } } };
  }

  /**
   * The repository's tags after `after`, at most `limit`, each with the
   * commit it peels to; a tag of something other than a commit is left
   * out. `next` is where the following page starts (the last tag looked
   * at), null when none is left: a page can be short, or even empty, and
   * still have one (tags left out, or the peel budget spent).
   */
  tags(after: string, limit: number): Promise<Browsed<TagPage>> {
    return guarded(() => this.#tags(after, limit));
  }

  async #tags(after: string, limit: number): Promise<Browsed<TagPage>> {
    const all = this.#refsUnder("refs/tags/", after, Number.POSITIVE_INFINITY);
    const tags: RefView[] = [];
    let at = 0;
    for (; at < all.length && tags.length < limit; at++) {
      if (at > 0 && this.#counts.reads >= this.#policy.peelReads) break;
      const [name, oid] = all[at] as [string, Oid];
      let commit: Oid | undefined;
      try {
        commit = await this.#commitOf(oid);
      } catch (error) {
        // One tag's peeling took the rest of the budget: the next page starts at it.
        if (error instanceof ReadBudgetError && at > 0) break;
        throw error;
      }
      if (commit) tags.push({ name, commit: { sha: oidToHex(commit) } });
    }
    const next = at < all.length && at > 0 ? (all[at - 1] as [string, Oid])[0] : null;
    return { ok: true, value: { tags, next } };
  }

  /** The commit `ref` names (see `#resolve`). */
  commit(ref: string | undefined): Promise<Browsed<CommitView>> {
    return guarded(async () => {
      const resolved = await this.#resolve(ref);
      if (!resolved.ok) return resolved;
      return this.#withReader(async (reader) => ({
        ok: true,
        value: (await this.#views(reader, [resolved.value], true))[0] as CommitView,
      }));
    });
  }

  /**
   * One page of history: from `ref` (or a previous page's `cursor`, commit
   * ids), only commits that change `path` when it is given.
   */
  log(input: LogInput): Promise<Browsed<LogView>> {
    return guarded(() => this.#log(input));
  }

  async #log(input: LogInput): Promise<Browsed<LogView>> {
    let from: Oid[];
    if (input.cursor) {
      if (
        input.cursor.length === 0 ||
        input.cursor.length > this.#policy.logMaxFrontier ||
        new Set(input.cursor).size !== input.cursor.length ||
        !input.cursor.every((hex) => HEX_OID.test(hex))
      )
        return INVALID_CURSOR;
      from = input.cursor.map((hex) => oidFromHex(hex));
    } else {
      const resolved = await this.#resolve(input.ref);
      if (!resolved.ok) return resolved;
      from = [resolved.value];
    }
    const segments = input.path ? pathSegments(input.path) : [];
    if (!segments) return fail(422, "invalid_path", `${input.path} is not a valid path.`);
    return this.#withReader(async (reader) => {
      let page: Awaited<ReturnType<typeof logPage>>;
      try {
        page = await logPage(this.deps.git.commitGraph, "verified", {
          from,
          limit: input.limit,
          maxExamined: this.#policy.logMaxExamined,
          maxFrontier: this.#policy.logMaxFrontier,
          stop: () => this.#counts.reads >= this.#policy.walkReads,
          ...(segments.length > 0 && { path: pathEntry(reader, segments) }),
        });
      } catch (error) {
        // A cursor naming a commit this repository does not have.
        if (error instanceof MissingCommitError) return INVALID_CURSOR;
        if (error instanceof WalkLimitError)
          return fail(422, "history_too_wide", "The history is too wide to page through.");
        throw error;
      }
      // Commits not shown for lack of reads or room lead the next page:
      // their generations are at least every frontier commit's.
      const shown = await this.#views(reader, page.commits);
      const next = [...page.commits.slice(shown.length), ...page.frontier];
      if (next.length > this.#policy.logMaxFrontier)
        return fail(422, "history_too_wide", "The history is too wide to page through.");
      return { ok: true, value: { commits: shown, next: next.map(oidToHex) } };
    });
  }

  /** Compares `base` with `head` as GitHub's `base...head`. */
  compare(base: string, head: string): Promise<Browsed<CompareView>> {
    return guarded(() => this.#compare(base, head));
  }

  async #compare(base: string, head: string): Promise<Browsed<CompareView>> {
    const from = await this.#resolve(base);
    if (!from.ok) return from;
    const to = await this.#resolve(head);
    if (!to.ok) return to;
    const graph = this.deps.git.commitGraph;
    // Commit-graph rows a walk may load: both sides' own commits and the
    // shared ones the walk meets at their boundary.
    const options = { maxCommits: 3 * this.#policy.compareMaxCommits };
    let ahead: Oid[];
    let behindBy: number;
    let bases: Oid[];
    try {
      ahead = [...(await reachableCommits(graph, "verified", [to.value], [from.value], options))];
      behindBy = (await reachableCommits(graph, "verified", [from.value], [to.value], options))
        .size;
      bases = await mergeBases(graph, "verified", from.value, [to.value], options);
    } catch (error) {
      if (error instanceof WalkLimitError) return tooLarge();
      throw error;
    }
    if (ahead.length > this.#policy.compareMaxCommits) return tooLarge();
    if (behindBy > this.#policy.compareMaxCommits) return tooLarge();
    const rows = graph.readSync(ahead, "verified");
    const listed = ahead
      .map((oid, i) => ({ oid, row: rows[i] }))
      .sort(
        (a, b) =>
          (a.row?.generation ?? 0) - (b.row?.generation ?? 0) ||
          (a.row?.commitTime ?? 0) - (b.row?.commitTime ?? 0),
      )
      .slice(-this.#policy.compareListed);
    return this.#withReader(async (reader) => {
      const mergeBase = bases[0];
      const first = mergeBase ? [from.value, mergeBase] : [from.value];
      const views = await this.#views(reader, [...first, ...listed.map((l) => l.oid)], true);
      const commits = views.slice(first.length);
      return {
        ok: true,
        value: {
          status:
            ahead.length === 0
              ? behindBy === 0
                ? "identical"
                : "behind"
              : behindBy === 0
                ? "ahead"
                : "diverged",
          aheadBy: ahead.length,
          behindBy,
          baseCommit: views[0] as CommitView,
          mergeBaseCommit: mergeBase ? (views[1] as CommitView) : null,
          commits,
        },
      };
    });
  }

  /** The commit `ref` names (see `#resolve`) and its tree. */
  async resolveTree(ref: string | undefined): Promise<Browsed<{ commit: Oid; tree: Oid }>> {
    const resolved = await this.#resolve(ref);
    if (!resolved.ok) return resolved;
    const [row] = this.deps.git.commitGraph.readSync([resolved.value], "verified");
    if (!row) return refNotFound(ref ?? "");
    return { ok: true, value: { commit: resolved.value, tree: row.tree } };
  }

  /** Runs `use` with this request's reader (see `#withReader`). */
  reading<T>(use: (reader: ObjectReader) => Promise<Browsed<T>>): Promise<Browsed<T>> {
    return this.#withReader(use);
  }

  /** Views of commits `oids`, in order: as many as the read and response budgets allow (at least one, or it throws). */
  async commitViews(oids: readonly Oid[]): Promise<CommitView[]> {
    return this.#views(await this.reader(), oids);
  }

  /** R2 reads this request has made. */
  get reads(): number {
    return this.#counts.reads;
  }

  get policy(): BrowsePolicy {
    return this.#policy;
  }

  /**
   * Reserves `bytes` (at least one) from the object's memory budget, or
   * undefined when they are not free now; the caller releases them.
   */
  hold(bytes: number): MemoryReservation | undefined {
    return this.deps.git.memory.tryReserve(Math.max(1, bytes));
  }

  /** This request's reader (opened on first use). */
  async reader(): Promise<ObjectReader> {
    const reader = await this.#open();
    // Verified commits but no pack: the repository's objects are gone.
    if (!reader) throw new Error("the repository has commits but no packs");
    return reader;
  }

  /** Counts `bytes` against the response budget; throws when the answer would pass it. */
  take(bytes: number): void {
    if (this.#bytes + bytes > this.#policy.maxResponseBytes) throw new ResponseTooLargeError();
    this.#bytes += bytes;
  }

  /**
   * The commit `ref` names: the default branch when absent; a full commit
   * id this repository has; else a branch, then a tag (peeled), then a full
   * ref name, as GitHub resolves them.
   */
  async #resolve(ref: string | undefined): Promise<Browsed<Oid>> {
    const snapshot = this.deps.git.refStore.readRefsSync();
    if (ref === undefined || ref === "") {
      const head = snapshot.head ? snapshot.refs.get(snapshot.head) : undefined;
      return head ? { ok: true, value: head } : EMPTY;
    }
    if (HEX_OID.test(ref)) {
      const oid = oidFromHex(ref);
      // A branch or tag may be named like a commit id this repository lacks.
      if (this.#verified([oid])[0]) return { ok: true, value: oid };
    }
    const names = [`refs/heads/${ref}`, `refs/tags/${ref}`];
    if (ref.startsWith("refs/")) names.push(ref);
    for (const name of names) {
      const oid = snapshot.refs.get(name);
      if (!oid) continue;
      const commit = await this.#commitOf(oid);
      return commit ? { ok: true, value: commit } : refNotFound(ref);
    }
    return refNotFound(ref);
  }

  /** The commit a ref's object is or peels to (an annotated tag), if this repository has it. */
  async #commitOf(oid: Oid): Promise<Oid | undefined> {
    if (this.#verified([oid])[0]) return oid;
    const reader = await this.#open();
    const peeled = reader && (await peelOid(reader, oid));
    return peeled && this.#verified([peeled])[0] ? peeled : undefined;
  }

  #refsUnder(prefix: string, after: string, limit: number): [string, Oid][] {
    const refs: [string, Oid][] = [];
    for (const [name, oid] of this.deps.git.refStore.readRefsSync().refs)
      if (name.startsWith(prefix) && name.slice(prefix.length) > after)
        refs.push([name.slice(prefix.length), oid]);
    refs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return refs.slice(0, limit);
  }

  #verified(oids: readonly Oid[]): boolean[] {
    return this.deps.git.commitGraph
      .readSync(oids, "verified")
      .map((row) => row?.state === "verified");
  }

  #open(): Promise<ObjectReader | undefined> {
    this.#reader ??= openLiveReader(this.deps, {
      deltaBaseCacheBytes: BROWSE_DELTA_CACHE_BYTES,
      maxCacheCalls: this.#policy.cacheCalls,
      maxReads: this.#policy.maxReads,
      counts: this.#counts,
    });
    return this.#reader;
  }

  /**
   * The views of `oids`, located together first, in order: as many as the
   * read and response budgets allow, or, with `all`, every one (running out
   * throws).
   */
  async #views(reader: ObjectReader, oids: readonly Oid[], all = false): Promise<CommitView[]> {
    const views: CommitView[] = [];
    try {
      await reader.prefetch(oids);
      for (const oid of oids) {
        // A view holds the commit's text about twice (its message and, when
        // signed, the signed payload), at two bytes a character, and a fixed
        // part (`viewBytes`): refused before it is built, so a huge commit is
        // never read into memory.
        const header = await reader.readHeader(oid);
        if (header && this.#bytes + 4 * header.size + 256 > this.#policy.maxResponseBytes)
          throw new ResponseTooLargeError();
        const view = await commitView(reader, oid);
        this.take(viewBytes(view));
        views.push(view);
      }
    } catch (error) {
      const outOfBudget =
        error instanceof ReadBudgetError || error instanceof ResponseTooLargeError;
      if (all || views.length === 0 || !outOfBudget) throw error;
    }
    return views;
  }

  async #withReader<T>(use: (reader: ObjectReader) => Promise<Browsed<T>>): Promise<Browsed<T>> {
    const reader = await this.#open();
    // Verified commits but no pack: the repository's objects are gone.
    if (!reader) throw new Error("the repository has commits but no packs");
    return use(reader);
  }
}

const INVALID_CURSOR = fail(422, "invalid_cursor", "The cursor is not one this API returned.");

/** The answer would carry more commit text than one response may. */
class ResponseTooLargeError extends Error {
  override name = "ResponseTooLargeError";
}

/** An operation whose running out of a budget is answered, not thrown. */
export async function guarded<T>(run: () => Promise<Browsed<T>>): Promise<Browsed<T>> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ReadBudgetError) return TOO_EXPENSIVE;
    if (error instanceof ResponseTooLargeError) return TOO_LARGE;
    // The object's working memory stayed taken by other work.
    if (error instanceof MemoryWaitTimeoutError) return BUSY;
    throw error;
  }
}

/** A commit view's size in a response, at two bytes per character (an upper bound). */
function viewBytes(view: CommitView): number {
  const { commit } = view;
  const people = [commit.author, commit.committer];
  const signed =
    (commit.verification.signature?.length ?? 0) + (commit.verification.payload?.length ?? 0);
  const text = people.reduce(
    (n, p) => n + p.name.length + p.email.length,
    commit.message.length + signed,
  );
  return 2 * text + 256 + 48 * view.parents.length;
}
export const BUSY = fail(409, "busy", "The repository is busy; try again shortly.");
const TOO_LARGE = fail(422, "too_large", "The answer would be larger than one response may be.");
const TOO_EXPENSIVE = fail(
  422,
  "too_expensive",
  "Answering needs more storage reads than one request may make.",
);

function tooLarge(): BrowseFailure {
  return fail(422, "comparison_too_large", "The comparison has too many commits to count.");
}

async function commitBody(reader: ObjectReader, oid: Oid): Promise<Uint8Array> {
  const object = await reader.readObject(oid);
  if (object?.type !== "commit") throw new Error(`commit ${oidToHex(oid)} is missing`);
  return object.bytes;
}

export async function commitView(reader: ObjectReader, oid: Oid): Promise<CommitView> {
  const body = await commitBody(reader, oid);
  const commit = parseCommit(body).value;
  const text = decoderFor(commit);
  return {
    sha: oidToHex(oid),
    commit: {
      message: text.decode(commit.message),
      author: person(commit.author, text),
      committer: person(commit.committer, text),
      tree: { sha: oidToHex(commit.tree) },
      verification: await checkSignature(body),
    },
    parents: commit.parents.map((p) => ({ sha: oidToHex(p) })),
  };
}

/** Largest timestamp a JavaScript date can show, in seconds. */
const MAX_DATE_SECONDS = 8_640_000_000_000;

/**
 * How a commit's text is decoded: as its `encoding` header says (git
 * re-encodes the whole commit, people included), else, or when the
 * encoding is unknown, as UTF-8.
 */
function decoderFor(commit: Commit): Decoder {
  const header = commit.headers.find((h) => h.key === "encoding");
  return header ? decoderForLabel(utf8.decode(header.value)) : utf8;
}

type Decoder = { decode(bytes: Uint8Array): string };

/**
 * The decoder for a commit's `encoding` label, UTF-8 for one the runtime
 * does not know. The web maps ISO-8859 labels (latin1, iso-8859-9, ...) to
 * Windows code pages, which put printable characters where ISO-8859 has
 * the C1 controls (bytes 0x80 to 0x9F); git means ISO-8859, so those bytes
 * decode as U+0080 to U+009F.
 */
export function decoderForLabel(label: string): Decoder {
  const name = label.trim().toLowerCase();
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(name);
  } catch {
    return utf8;
  }
  if (!decoder.encoding.startsWith("windows-") || /^(windows-|x-cp125|cp125|dos-)/.test(name))
    return decoder;
  return {
    decode: (bytes) => {
      const text = decoder.decode(bytes);
      // Single-byte code pages give one character per byte.
      if (text.length !== bytes.length) return text;
      let out = "";
      for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i] as number;
        out += byte >= 0x80 && byte <= 0x9f ? String.fromCharCode(byte) : text[i];
      }
      return out;
    },
  };
}

function person(ident: Ident, text: Decoder): PersonView {
  const seconds = Math.abs(ident.timestamp) <= MAX_DATE_SECONDS ? ident.timestamp : 0;
  return {
    name: text.decode(ident.name),
    email: text.decode(ident.email),
    date: new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}

/**
 * The entry at a path (mode and object id) in a commit's tree, for a
 * path-limited log; subtrees are read once per request.
 */
function pathEntry(reader: ObjectReader, segments: readonly Uint8Array[]): PathEntryLookup {
  const memo = new Map<string, Promise<string | null>>();
  const at = (tree: Oid, depth: number): Promise<string | null> => {
    const key = `${depth}:${oidToHex(tree)}`;
    let found = memo.get(key);
    if (!found) {
      found = lookup(tree, depth);
      memo.set(key, found);
    }
    return found;
  };
  const lookup = async (tree: Oid, depth: number): Promise<string | null> => {
    const object = await reader.readObject(tree);
    if (object?.type !== "tree") return null;
    // Scanned in place: a wide tree's entries are not collected to find one.
    const name = segments[depth] as Uint8Array;
    let entry: { mode: number; oid: Oid } | undefined;
    try {
      for (const e of treeEntries(object.bytes)) {
        if (e.name.length === name.length && e.name.every((b, i) => b === name[i])) {
          entry = { mode: e.mode, oid: e.oid.slice() as Oid };
          break;
        }
      }
    } catch (error) {
      if (error instanceof GitObjectError) return null;
      throw error;
    }
    if (!entry) return null;
    if (depth === segments.length - 1) return `${entry.mode.toString(8)} ${oidToHex(entry.oid)}`;
    return isTreeMode(entry.mode) ? at(entry.oid, depth + 1) : null;
  };
  return (tree) => at(tree, 0);
}
