import { MemoryWaitTimeoutError } from "@fyrden/adapters-cloudflare/git";
import {
  type CodeOwnersError,
  codeOwnersTooLarge,
  MAX_CODEOWNERS_BYTES,
  parseCodeOwners,
  quoteExcerpt,
} from "@fyrden/domain";
import type { MemoryBudget } from "@fyrden/git-core";
import { ReaderWorkSpent } from "@fyrden/git-core";
import { ReadBudgetError } from "../../git/live-reader.js";
import { type Browsed, BUSY, fail, type RepoBrowse, TOO_EXPENSIVE } from "./browse.js";
import { locateCodeOwners } from "./code-owners.js";
import { ReadsMemoryBusy, ReadsTooLargeError, withHeldReads } from "./held-reads.js";

/*
 * GitHub's `codeowners/errors`: the CODEOWNERS file a pull request onto a
 * ref would read, parsed on its own (no pull request's evaluation), and
 * its errors. Syntax only: owners that do not resolve or cannot write are
 * judged where they matter (a merge needing code owners' review). The ref
 * resolved, the file located (one tree at a time) and read through one
 * reader, its reads and the bytes it builds bounded; the answer bounded in
 * bytes, each quoted line cut.
 */

/** Proposed values. */
export const CODEOWNERS_ERRORS_POLICY = {
  /** The largest tree read on the way to the file, and the bytes those trees take in all. */
  maxTreeBytes: 1024 * 1024,
  maxLocateBytes: 4 * 1024 * 1024,
  /** Bytes the reader may build: inflated objects, delta programs, their intermediates. */
  maxBuiltBytes: 64 * 1024 * 1024,
  /** Memory a parsed file is held as, per byte of the file (as an evaluation holds it). */
  fileMemoryPerByte: 8,
  /** The answer's JSON, in UTF-8 bytes, at most (`truncated` past it). */
  maxAnswerBytes: 1024 * 1024,
  /** Characters of a line an error quotes as its `source`. */
  maxSourceCharacters: 1_024,
};

export type CodeOwnersErrorsPolicy = typeof CODEOWNERS_ERRORS_POLICY;

/** An error as the API answers it: the parser's, and the file it is in. */
export type CodeOwnersErrorView = CodeOwnersError & { readonly path: string };

export interface CodeOwnersErrors {
  readonly errors: readonly CodeOwnersErrorView[];
  /** More errors than one answer carries (Fyrden's). */
  readonly truncated: boolean;
}

const NOT_FOUND = fail(404, "not_found", "No CODEOWNERS file was found at that ref.");

const encoder = new TextEncoder();

/**
 * The errors of the CODEOWNERS file at `ref` (the default branch when
 * absent), read through `browse` (opened with `policy.maxBuiltBytes`), the
 * parse's memory held from `memory`.
 */
export async function codeOwnersErrors(
  browse: RepoBrowse,
  memory: Pick<MemoryBudget, "tryReserve">,
  ref: string | undefined,
  policy: CodeOwnersErrorsPolicy,
): Promise<Browsed<CodeOwnersErrors>> {
  try {
    // Peeling an annotated tag reads too: within the same budgets.
    const resolved = await browse.resolveTree(ref);
    // No such ref, or an empty repository: no file there (GitHub's 404).
    if (!resolved.ok)
      return resolved.status === 404 || resolved.code === "repo_empty" ? NOT_FOUND : resolved;
    const reader = await browse.reader();
    const spent = { readBytes: 0 };
    const located = await locateCodeOwners(reader, memory, resolved.value.tree, {
      maxTreeBytes: policy.maxTreeBytes,
      maxReadBytes: policy.maxLocateBytes,
      spent,
    });
    if (!located) return NOT_FOUND;
    const header = await reader.readHeader(located.blob);
    if (header?.type !== "blob") throw new Error("the CODEOWNERS entry names no blob");
    // Too large to read: its whole-file error, its body never read.
    if (header.size >= MAX_CODEOWNERS_BYTES)
      return {
        ok: true,
        value: bounded(codeOwnersTooLarge(header.size).errors, located.path, policy),
      };
    // The parse's memory, held until the answer is built from it.
    const parsing = reserve(memory, header.size * policy.fileMemoryPerByte);
    if (parsing === "never") return TOO_EXPENSIVE;
    if (!parsing) return BUSY;
    try {
      // The body's memory held while it is parsed.
      const answer = await withHeldReads(
        reader,
        memory,
        { maxTreeBytes: policy.maxTreeBytes, maxReadBytes: MAX_CODEOWNERS_BYTES },
        async (reads) => {
          const bytes = await reads.readBlob(located.blob, MAX_CODEOWNERS_BYTES - 1);
          const file = bytes ? parseCodeOwners(bytes) : codeOwnersTooLarge(header.size);
          return bounded(file.errors, located.path, policy);
        },
      );
      return { ok: true, value: answer };
    } finally {
      parsing.release();
    }
  } catch (error) {
    if (error instanceof ReadsMemoryBusy || error instanceof MemoryWaitTimeoutError) return BUSY;
    if (
      error instanceof ReadBudgetError ||
      error instanceof ReaderWorkSpent ||
      error instanceof ReadsTooLargeError
    )
      return TOO_EXPENSIVE;
    throw error;
  }
}

/**
 * `errors` in line order, each with `path` and its source cut, as many as
 * keep the answer's JSON (with `"truncated":true`) within its bytes.
 */
function bounded(
  errors: readonly CodeOwnersError[],
  path: string,
  policy: CodeOwnersErrorsPolicy,
): CodeOwnersErrors {
  // `{"errors":[` … `],"truncated":true}`: the most the frame may take.
  let bytes = encoder.encode('{"errors":[],"truncated":true}').length;
  const kept: CodeOwnersErrorView[] = [];
  for (const error of errors) {
    const view = { ...error, source: quoteExcerpt(error.source, policy.maxSourceCharacters), path };
    const size = encoder.encode(JSON.stringify(view)).length + (kept.length > 0 ? 1 : 0);
    if (bytes + size > policy.maxAnswerBytes) return { errors: kept, truncated: true };
    bytes += size;
    kept.push(view);
  }
  return { errors: kept, truncated: false };
}

/** `bytes` held from `memory`: undefined while not free now, `never` past its whole budget. */
function reserve(
  memory: Pick<MemoryBudget, "tryReserve">,
  bytes: number,
): { release(): void } | undefined | "never" {
  try {
    return memory.tryReserve(Math.max(1, bytes));
  } catch (error) {
    if (error instanceof RangeError) return "never";
    throw error;
  }
}
