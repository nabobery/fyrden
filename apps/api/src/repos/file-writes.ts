import { Buffer } from "node:buffer";
import type {
  createFileCommit,
  deleteContents,
  Input,
  Output,
  putContents,
} from "@fyrden/api-contract";
import type { Browsed } from "../do/repo/browse.js";
import {
  FILE_WRITE_POLICY,
  type FileWriteChange,
  type FileWriteInput,
  type FileWriteResult,
} from "../do/repo/file-writes.js";
import { repoFor } from "../git/chunked/operations.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { resolveOne } from "../signing/verification.js";

/*
 * File writes: one file (GitHub's contents API) or several (one commit).
 * The Worker checks `contents:write` on the repository; its object builds
 * the commit and finishes it through the push path, where the token is
 * checked again at the commit point.
 */

const encoder = new TextEncoder();

function written(result: Browsed<FileWriteResult>): FileWriteResult {
  if (!result.ok) throw new OperationError(result.status, result.code, result.error);
  return result.value;
}

/** Characters base64 may use before its padding (one class, so the check is linear). */
const NOT_BASE64 = /[^A-Za-z0-9+/]/;

/** Whether `text` is padded base64: a multiple of four, at most two `=`, only at the end. */
function isBase64(text: string): boolean {
  if (text.length % 4 !== 0) return false;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return !NOT_BASE64.test(text.slice(0, text.length - padding));
}

/**
 * Decodes content within the write's budget: strict base64 (RFC 4648;
 * line breaks and missing padding allowed, as GitHub's) or UTF-8 text. The
 * running total is checked before each decoding, so an oversized write is
 * refused before it is decoded or sent on.
 */
class ContentBudget {
  #bytes = 0;

  base64(text: string, what: string): Uint8Array {
    let compact = text.replace(/[\r\n]/g, "");
    if (!compact.includes("=") && compact.length % 4 > 1)
      compact += "=".repeat(4 - (compact.length % 4));
    if (!isBase64(compact))
      throw new OperationError(422, "invalid_input", `${what}: not valid base64.`);
    const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
    this.#spend((compact.length / 4) * 3 - padding);
    const decoded = Buffer.from(compact, "base64");
    return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  }

  text(text: string): Uint8Array {
    this.#spend(Buffer.byteLength(text, "utf8"));
    return encoder.encode(text);
  }

  #spend(bytes: number): void {
    this.#bytes += bytes;
    if (this.#bytes > FILE_WRITE_POLICY.maxContentBytes)
      throw new OperationError(
        422,
        "too_large",
        `A write carries ${FILE_WRITE_POLICY.maxContentBytes} bytes of content at most.`,
      );
  }
}

/** The committer: the caller, with a no-reply address on this host (as GitHub's). */
export function committerOf(ctx: OpContext) {
  return {
    name: ctx.auth.principalHandle ?? ctx.auth.principalId,
    email: `${ctx.auth.principalId}@users.noreply.${ctx.requestHost}`,
  };
}

async function write(
  ctx: OpContext,
  owner: string,
  repo: string,
  input: Omit<FileWriteInput, "principal" | "tokenId" | "repoId" | "committer">,
): Promise<FileWriteResult> {
  const entry = await repoFor(ctx, owner, repo, "contents:write");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "writeFiles" });
  return written(
    await ctx.env.REPO.getByName(entry.id).writeFiles({
      ...input,
      principal: ctx.auth.principalId,
      tokenId: ctx.auth.id,
      grantId: ctx.auth.grantId,
      repoId: entry.id,
      committer: committerOf(ctx),
    }),
  );
}

/** The `repos.contents.put` operation. */
export async function putContentsOperation(
  ctx: OpContext,
  input: Input<typeof putContents>,
): Promise<Output<typeof putContents>> {
  const content = new ContentBudget().base64(input.content, "content");
  const result = await write(ctx, input.owner, input.repo, {
    ...(input.branch !== undefined && { branch: input.branch }),
    ...(input.author !== undefined && { author: input.author }),
    message: input.message,
    // Without `sha` the file must not exist (GitHub asks for `sha` to update one).
    changes: [{ path: input.path, content, expectedSha: input.sha ?? null }],
  });
  return {
    content: {
      type: "file",
      name: input.path.split("/").at(-1) ?? input.path,
      path: input.path,
      sha: result.blobs[0] as string,
      size: content.length,
    },
    commit: await resolveOne(ctx, result.commit),
  };
}

/** The `repos.contents.delete` operation. */
export async function deleteContentsOperation(
  ctx: OpContext,
  input: Input<typeof deleteContents>,
): Promise<Output<typeof deleteContents>> {
  const result = await write(ctx, input.owner, input.repo, {
    ...(input.branch !== undefined && { branch: input.branch }),
    ...(input.author !== undefined && { author: input.author }),
    message: input.message,
    changes: [{ path: input.path, delete: true, expectedSha: input.sha }],
  });
  return { content: null, commit: await resolveOne(ctx, result.commit) };
}

/** The `repos.file_commits.create` operation. */
export async function createFileCommitOperation(
  ctx: OpContext,
  input: Input<typeof createFileCommit>,
): Promise<Output<typeof createFileCommit>> {
  const budget = new ContentBudget();
  const changes = input.changes.map((change, i): FileWriteChange => {
    const where = `changes[${i}]`;
    if (change.delete) {
      if (change.content !== undefined)
        throw new OperationError(
          422,
          "invalid_input",
          `${where}: give content or delete, not both.`,
        );
      return { path: change.path, delete: true };
    }
    if (change.content === undefined)
      throw new OperationError(422, "invalid_input", `${where}: content is required.`);
    const content =
      change.encoding === "base64"
        ? budget.base64(change.content, `${where}.content`)
        : budget.text(change.content);
    return { path: change.path, content, ...(change.mode && { mode: change.mode }) };
  });
  const result = await write(ctx, input.owner, input.repo, {
    ...(input.branch !== undefined && { branch: input.branch }),
    ...(input.expected_head !== undefined && { expectedHead: input.expected_head }),
    ...(input.author !== undefined && { author: input.author }),
    message: input.message,
    changes,
  });
  return {
    branch: result.branch,
    commit: await resolveOne(ctx, result.commit),
    files: input.changes.map((c, i) => ({ path: c.path, sha: result.blobs[i] ?? null })),
  };
}
