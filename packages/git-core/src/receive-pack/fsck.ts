import { OidTable } from "../graph/oid-table.js";
import { parseCommit } from "../object/commit.js";
import {
  FSCK_SEVERITY,
  type FsckMessageId,
  type FsckSeverity,
  GitObjectError,
} from "../object/fsck.js";
import type { ObjectType } from "../object/object.js";
import { type Oid, oidToHex } from "../object/oid.js";
import { parseTag } from "../object/tag.js";
import { FILE_MODES, parseTree, type TreeEntry } from "../object/tree.js";
import { excerpt } from "../protocol/errors.js";
import type { PendingBlob } from "./cursor.js";
import { checkGitmodules } from "./gitmodules.js";
import { isNtfsDot, isSpecialName, type SpecialFile } from "./special-names.js";

/*
 * The object checks of a push. They run git's fsck.c checks (git v2.53.0,
 * verified) with git's own severities, and differ from git's receive path
 * in one place, on purpose.
 *
 * git's receive-pack checks nothing unless `receive.fsckObjects` (or
 * `transfer.fsckObjects`) is set; both are off by default. When it is set,
 * receive-pack passes `--strict` to index-pack and unpack-objects
 * (builtin/receive-pack.c), whose fsck options have `strict` set (fsck.h
 * FSCK_OPTIONS_STRICT and FSCK_OPTIONS_MISSING_GITMODULES), which turns
 * every warning into an error (fsck.c `fsck_msg_type`); hosts then relax
 * single ids with `receive.fsck.<id>`. That strict mode refuses real,
 * long-lived histories (zero-padded tree modes in lodash and redis, for
 * example).
 *
 * So the default here is git's checks with error-level findings refusing
 * and warnings accepted (sent to the client as warnings), except the
 * warnings that protect people who clone or check out the repository:
 * `.git`, `.` and `..` in a tree, names with a slash, empty names and
 * entries naming the null object id still refuse, as does every
 * `.gitmodules` / `.gitattributes` error (a `.gitmodules` symbolic link,
 * dangerous submodule names, paths and URLs). Info-level findings are
 * reported and accepted, as git does. `strict: true` restores git's
 * `--strict` behaviour.
 */

/** Warnings that refuse a push: each protects clients that clone or check out the repository. */
export const PUSH_REFUSED_WARNINGS = [
  "hasDotgit",
  "hasDotdot",
  "hasDot",
  "fullPathname",
  "nullSha1",
  "emptyName",
] as const satisfies readonly PushFsckIdOf<"warn">[];

/**
 * Warnings that are reported and accepted: legacy encodings found in real
 * histories, harmless to clients (zero-padded modes, very long names, a NUL
 * in a commit message).
 */
export const PUSH_ACCEPTED_WARNINGS = [
  "zeroPaddedFilemode",
  "largePathname",
  "nulInCommit",
] as const satisfies readonly PushFsckIdOf<"warn">[];

const REFUSED_WARNINGS: ReadonlySet<string> = new Set(PUSH_REFUSED_WARNINGS);

/** Ids the push checks add to the object model's (`FSCK_SEVERITY`), with git's default levels. */
export const PUSH_FSCK_SEVERITY = {
  ...FSCK_SEVERITY,
  emptyName: "warn",
  gitmodulesBlob: "error",
  gitmodulesLarge: "error",
  gitmodulesMissing: "error",
  gitmodulesName: "error",
  gitmodulesPath: "error",
  gitmodulesSymlink: "error",
  gitmodulesUpdate: "error",
  gitmodulesUrl: "error",
  gitmodulesParse: "info",
  gitattributesBlob: "error",
  gitattributesLarge: "error",
  gitattributesLineLength: "error",
  gitattributesMissing: "error",
  gitattributesSymlink: "info",
  gitignoreSymlink: "info",
  mailmapSymlink: "info",
} as const satisfies Record<string, FsckSeverity>;

export type PushFsckId = keyof typeof PUSH_FSCK_SEVERITY;

/** The push check ids git gives `severity` by default. */
type PushFsckIdOf<S extends FsckSeverity> = {
  [K in PushFsckId]: (typeof PUSH_FSCK_SEVERITY)[K] extends S ? K : never;
}[PushFsckId];

/** What a level means for a push: refuse it, report it, or say nothing. */
export type PushFsckLevel = "error" | "warn" | "ignore";

export interface PushFsckPolicy {
  /**
   * Every warning refuses the push, as git's `receive.fsckObjects=true`
   * (`--strict`) does. Default false: only `PUSH_REFUSED_WARNINGS` do.
   */
  readonly strict?: boolean;
  /** Per-id levels, as `receive.fsck.<id>` sets them. */
  readonly levels?: Partial<Record<PushFsckId, PushFsckLevel>>;
}

export interface PushFsckFinding {
  readonly oid: Oid;
  readonly id: PushFsckId;
  readonly level: Exclude<PushFsckLevel, "ignore">;
  /** git's text: `<msgId>: <message>`. */
  readonly message: string;
}

/** An object the policy refuses; the push fails as git's index-pack does. */
export class PushFsckError extends Error {
  override readonly name = "PushFsckError";
  readonly findings: readonly PushFsckFinding[];
  constructor(findings: readonly PushFsckFinding[]) {
    const first = findings.find((f) => f.level === "error") ?? findings[0];
    super(first ? `object ${oidToHex(first.oid)}: ${first.message}` : "fsck error");
    this.findings = findings;
  }
}

/**
 * `.gitmodules` findings reported per blob; the rest are counted in one
 * "and N more" finding. git reports every one; one per entry of a large
 * blob would be a message per entry to the client. Proposed: 10.
 */
const MAX_GITMODULES_FINDINGS = 10;

/** git's limits for `.gitattributes` (attr.h ATTR_MAX_FILE_SIZE, ATTR_MAX_LINE_LENGTH). */
const ATTR_MAX_FILE_SIZE = 100 * 1024 * 1024;
const ATTR_MAX_LINE_LENGTH = 2048;

const TREE_MESSAGES: Partial<Record<FsckMessageId, string>> = {
  nullSha1: "contains entries pointing to null sha1",
  fullPathname: "contains full pathnames",
  hasDot: "contains '.'",
  hasDotdot: "contains '..'",
  hasDotgit: "contains '.git'",
  zeroPaddedFilemode: "contains zero-padded file modes",
  badFilemode: "contains bad file modes",
  duplicateEntries: "contains duplicate file entries",
  treeNotSorted: "not properly sorted",
  largePathname: "contains excessively large pathname",
};

const SYMLINK_MESSAGES: Record<SpecialFile, [PushFsckId, string]> = {
  gitmodules: ["gitmodulesSymlink", ".gitmodules is a symbolic link"],
  gitattributes: ["gitattributesSymlink", ".gitattributes is a symlink"],
  gitignore: ["gitignoreSymlink", ".gitignore is a symlink"],
  mailmap: ["mailmapSymlink", ".mailmap is a symlink"],
};

const LEGACY_GROUP_WRITABLE = 0o100664;
const BACKSLASH = 0x5c;

/** A parsed object's outgoing links, for the connectivity check. */
export interface ObjectLinks {
  readonly commit?: {
    readonly tree: Oid;
    readonly parents: readonly Oid[];
    readonly commitTime: number;
  };
  /** (oid, the type the link requires), gitlinks left out. */
  readonly links: readonly (readonly [Oid, ObjectType])[];
  /** A tree entry whose mode names no object type: git's link walk refuses the tree. */
  readonly badMode?: { readonly name: Uint8Array; readonly mode: number };
}

/**
 * Checks each object of a push as it is indexed and remembers which blobs
 * are named `.gitmodules` or `.gitattributes`, so their contents are
 * checked when they arrive, or at `finish` for blobs that came first or
 * were already in the repository (git's `fsck_finish`).
 */
export class PushFsck {
  readonly #strict: boolean;
  readonly #levels: Partial<Record<PushFsckId, PushFsckLevel>>;
  readonly #gitmodules = new OidTable();
  readonly #gitmodulesDone = new OidTable();
  readonly #gitattributes = new OidTable();
  readonly #gitattributesDone = new OidTable();
  /** Non-refusing findings, for the client's progress channel. */
  readonly warnings: PushFsckFinding[] = [];

  constructor(policy: PushFsckPolicy = {}) {
    this.#strict = policy.strict ?? false;
    this.#levels = policy.levels ?? {};
  }

  /** The level a finding has under this policy. */
  level(id: PushFsckId): PushFsckLevel {
    const configured = this.#levels[id];
    if (configured) return configured;
    const severity: FsckSeverity = PUSH_FSCK_SEVERITY[id];
    if (severity === "error") return "error";
    if (severity === "warn") return this.#strict || REFUSED_WARNINGS.has(id) ? "error" : "warn";
    // git prints info findings as warnings and ignores them otherwise.
    return "warn";
  }

  /**
   * Checks one object. Throws `PushFsckError` when the policy refuses it;
   * returns its links otherwise.
   */
  check(oid: Oid, type: ObjectType, data: Uint8Array): ObjectLinks {
    const findings: PushFsckFinding[] = [];
    const add = (id: PushFsckId, message: string) => {
      const level = this.level(id);
      if (level !== "ignore") findings.push({ oid, id, level, message: `${id}: ${message}` });
    };
    let links: ObjectLinks = { links: [] };
    try {
      switch (type) {
        case "commit": {
          const { value, issues } = parseCommit(data);
          for (const finding of issues) add(finding.id, "NUL byte in the commit object body");
          links = {
            commit: {
              tree: value.tree,
              parents: value.parents,
              commitTime: value.committer.timestamp,
            },
            links: [[value.tree, "tree"], ...value.parents.map((p) => [p, "commit"] as const)],
          };
          break;
        }
        case "tag": {
          const { value, issues } = parseTag(data);
          for (const finding of issues) {
            add(
              finding.id,
              finding.id === "badTagName"
                ? `invalid 'tag' name: ${excerpt(value.name)}`
                : "invalid format - expected 'tagger' line",
            );
          }
          links = { links: [[value.object, value.type]] };
          break;
        }
        case "tree":
          links = this.#checkTree(data, add);
          break;
        case "blob":
          this.#checkBlob(oid, data, add);
          break;
      }
    } catch (error) {
      if (!(error instanceof GitObjectError)) throw error;
      add(error.id, error.message.slice(error.id.length + 2));
    }
    this.#settle(findings);
    return links;
  }

  /**
   * Blobs named `.gitmodules` or `.gitattributes` that `check` has not seen
   * (they came before their tree, or were already stored).
   */
  pending(): PendingBlob[] {
    const out = new Map<string, PendingBlob>();
    const note = (oid: Oid, kind: "gitmodules" | "gitattributes") => {
      const key = oidToHex(oid);
      const known = out.get(key) ?? { oid, gitmodules: false, gitattributes: false };
      out.set(key, { ...known, [kind]: true });
    };
    for (const oid of this.#gitmodules) if (!this.#gitmodulesDone.has(oid)) note(oid, "gitmodules");
    for (const oid of this.#gitattributes) {
      if (!this.#gitattributesDone.has(oid)) note(oid, "gitattributes");
    }
    return [...out.values()];
  }

  /** Continues with blobs another instance left pending (after a resume). */
  restorePending(blobs: readonly PendingBlob[]): void {
    for (const blob of blobs) {
      if (blob.gitmodules) this.#gitmodules.add(blob.oid);
      if (blob.gitattributes) this.#gitattributes.add(blob.oid);
    }
  }

  /** git's `fsck_finish` for one pending blob: its contents, or undefined when it is missing. */
  finishBlob(oid: Oid, object: { type: ObjectType; data: Uint8Array } | undefined): void {
    const findings: PushFsckFinding[] = [];
    const add = (id: PushFsckId, message: string) => {
      const level = this.level(id);
      if (level !== "ignore") findings.push({ oid, id, level, message: `${id}: ${message}` });
    };
    const kinds: [OidTable, PushFsckId, PushFsckId, string][] = [
      [this.#gitmodules, "gitmodulesMissing", "gitmodulesBlob", ".gitmodules"],
      [this.#gitattributes, "gitattributesMissing", "gitattributesBlob", ".gitattributes"],
    ];
    for (const [found, missing, notBlob, name] of kinds) {
      if (!found.has(oid)) continue;
      if (!object) add(missing, `unable to read ${name} blob`);
      else if (object.type !== "blob") add(notBlob, `non-blob found at ${name}`);
    }
    if (object?.type === "blob") this.#checkBlob(oid, object.data, add);
    this.#settle(findings);
  }

  #settle(findings: PushFsckFinding[]): void {
    if (findings.some((f) => f.level === "error")) throw new PushFsckError(findings);
    for (const finding of findings) this.warnings.push(finding);
  }

  #checkTree(data: Uint8Array, add: (id: PushFsckId, message: string) => void): ObjectLinks {
    const { value: entries, issues } = parseTree(data);
    const links: (readonly [Oid, ObjectType])[] = [];
    let badMode: ObjectLinks["badMode"];
    for (const entry of entries) {
      this.#specialNames(entry, add);
      const target = linkType(entry.mode);
      if (target === "bad") badMode ??= { name: entry.name, mode: entry.mode };
      else if (target) links.push([entry.oid, target]);
    }
    const found = new Set(issues.map((i) => i.id));
    // Only under --strict does git count the legacy 100664 mode as bad
    // (fsck.c fsck_tree); badFilemode is info-level, so it never refuses.
    if (this.#strict && entries.some((e) => e.mode === LEGACY_GROUP_WRITABLE)) {
      found.add("badFilemode");
    }
    for (const id of TREE_ORDER) {
      if (found.has(id)) add(id, TREE_MESSAGES[id] as string);
    }
    return badMode ? { links, badMode } : { links };
  }

  /** The per-entry name checks of `fsck_tree`. */
  #specialNames(entry: TreeEntry, add: (id: PushFsckId, message: string) => void): void {
    const symlink = (entry.mode & 0o170000) === FILE_MODES.symlink;
    const report = (file: SpecialFile) => {
      const [id, message] = SYMLINK_MESSAGES[file];
      add(id, message);
    };
    if (isSpecialName(entry.name, "gitmodules")) {
      if (symlink) report("gitmodules");
      else this.#gitmodules.add(entry.oid);
    }
    if (isSpecialName(entry.name, "gitattributes")) {
      if (symlink) report("gitattributes");
      else this.#gitattributes.add(entry.oid);
    }
    if (symlink) {
      if (isSpecialName(entry.name, "gitignore")) report("gitignore");
      if (isSpecialName(entry.name, "mailmap")) report("mailmap");
    }
    for (let i = entry.name.indexOf(BACKSLASH); i >= 0; i = entry.name.indexOf(BACKSLASH, i + 1)) {
      if (isNtfsDot(entry.name, i + 1, "gitmodules")) {
        if (symlink) report("gitmodules");
        else this.#gitmodules.add(entry.oid);
      }
    }
  }

  #checkBlob(oid: Oid, data: Uint8Array, add: (id: PushFsckId, message: string) => void): void {
    if (this.#gitmodules.has(oid) && !this.#gitmodulesDone.has(oid)) {
      this.#gitmodulesDone.add(oid);
      for (const finding of checkGitmodules(data, MAX_GITMODULES_FINDINGS)) {
        add(finding.id, finding.message);
      }
    }
    if (this.#gitattributes.has(oid) && !this.#gitattributesDone.has(oid)) {
      this.#gitattributesDone.add(oid);
      if (data.length > ATTR_MAX_FILE_SIZE) {
        add("gitattributesLarge", ".gitattributes too large to parse");
      } else if (hasLongLine(data)) {
        add("gitattributesLineLength", ".gitattributes has too long lines to parse");
      }
    }
  }
}

/** The order git's fsck_tree reports its summary findings in. */
const TREE_ORDER: readonly FsckMessageId[] = [
  "nullSha1",
  "fullPathname",
  "hasDot",
  "hasDotdot",
  "hasDotgit",
  "zeroPaddedFilemode",
  "badFilemode",
  "duplicateEntries",
  "treeNotSorted",
  "largePathname",
];

/**
 * The type a tree entry's mode requires of its object (fsck.c
 * `fsck_walk_tree`): undefined for a gitlink, "bad" for a mode that is
 * neither a directory, a regular file nor a symbolic link.
 */
export function linkType(mode: number): ObjectType | "bad" | undefined {
  switch (mode & 0o170000) {
    case 0o040000:
      return "tree";
    case 0o160000:
      return undefined;
    case 0o100000:
    case 0o120000:
      return "blob";
    default:
      return "bad";
  }
}

/** Whether a line (up to LF or the first NUL, as git reads the C string) reaches 2048 bytes. */
function hasLongLine(data: Uint8Array): boolean {
  let start = 0;
  for (let i = 0; i <= data.length; i++) {
    const c = data[i];
    if (c === undefined || c === 0 || c === 0x0a) {
      if (i - start >= ATTR_MAX_LINE_LENGTH) return true;
      if (c === undefined || c === 0) return false;
      start = i + 1;
    }
  }
  return false;
}
