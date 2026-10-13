import { z } from "zod";
import { isId } from "../ids.js";

/** Entity rows that travel in events, one schema per entity type. */

export const REPO_ENTITY = "repo";

export const RepoRowSchema = z.strictObject({
  /** Repositories belong to users and organizations. */
  ownerId: z.string().refine((s) => isId(s, "usr") || isId(s, "org"), "not an owner id"),
  name: z.string().min(1),
  visibility: z.enum(["public", "internal", "private"]),
  /** The branch HEAD names, or null when it is not set. */
  // At most as long as the longest ref name an import accepts.
  defaultBranch: z.string().max(1024).refine(isBranchRef, "not a branch ref").nullable(),
  /** When a ref last moved, or null before the first push. */
  pushedAt: z.number().int().min(0).nullable(),
  createdAt: z.number().int().min(0),
});
export type RepoRow = z.infer<typeof RepoRowSchema>;

const FORBIDDEN_IN_REFS = new Set(["~", "^", ":", "?", "*", "[", "\\"]);

/** `refs/heads/<name>`, roughly as git allows names (the ref store checks fully). */
function isBranchRef(ref: string): boolean {
  const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
  if (name === "" || name.startsWith("/") || name.endsWith("/") || name.includes("//"))
    return false;
  for (const char of name) {
    const code = char.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || FORBIDDEN_IN_REFS.has(char)) return false;
  }
  return true;
}

export function parseRepoRow(value: unknown): RepoRow | undefined {
  const parsed = RepoRowSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
