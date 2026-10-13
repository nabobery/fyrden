import type { TokenRecord } from "@fyrden/adapters-cloudflare/auth";
import { authenticate } from "../middleware/auth.js";
import {
  canAccess,
  GIT_PERMISSION,
  type RepoAccess,
  type RepoEntry,
  resolveRepo,
} from "../repos/directory.js";
import { type GitContext, gitText } from "./http.js";

/** Token types a git client may use: git tokens and personal access tokens. */
const GIT_TOKEN_TYPES: ReadonlySet<string> = new Set(["git", "pat"]);

export const REPO_NOT_FOUND = "Repository not found.";

export type GitAccess =
  | { ok: true; auth: TokenRecord; repo: RepoEntry }
  | { ok: false; response: Response };

/**
 * Authenticates a git request and authorizes it on `owner/name`.
 *
 * - No token, or a bad one: 401 with a Basic challenge, so git asks its
 *   credential helper or prompts. Any user name works; the password is a
 *   git token or a personal access token (Bearer works too).
 * - A repository that does not exist and one the caller may not see get
 *   the same 404, so a private repository's existence never leaks (as on
 *   GitHub). Every repository is private for now.
 * - Writes verify the token on the D1 primary, so a revoked token cannot
 *   push from a stale cache, and read the directory from the primary.
 */
export async function authorizeGit(
  c: GitContext,
  owner: string,
  name: string,
  access: RepoAccess,
): Promise<GitAccess> {
  const fail = (response: Response): GitAccess => ({ ok: false, response });
  const challenge = { "WWW-Authenticate": 'Basic realm="Fyrden"' };

  const authn = await authenticate(c, access === "write" ? "write" : "read");
  if (!authn.ok) {
    if (authn.reason === "rate_limited")
      return fail(
        gitText(c, 429, "Too many authentication attempts. Try again later.", {
          "Retry-After": "60",
        }),
      );
    if (authn.reason === "missing")
      return fail(gitText(c, 401, "Authentication required.", challenge));
    return fail(gitText(c, 401, "Invalid username or token.", challenge));
  }
  const auth = authn.state.record;
  if (!GIT_TOKEN_TYPES.has(auth.type)) {
    return fail(
      gitText(
        c,
        403,
        "This token cannot be used with git. Use a git token or a personal access token.",
      ),
    );
  }

  const limiter = access === "write" ? c.env.RATE_LIMIT_WRITE : c.env.RATE_LIMIT_READ;
  if (!(await limiter.limit({ key: auth.id })).success) {
    return fail(gitText(c, 429, "Too many requests for this token.", { "Retry-After": "60" }));
  }

  const repo = await resolveRepo(c.env, owner, name, {
    consistency: access === "write" ? "primary" : "cached",
    metrics: c.get("metrics"),
  });
  if (!repo || !canAccess(auth, repo, GIT_PERMISSION[access]))
    return fail(gitText(c, 404, REPO_NOT_FOUND));

  c.set("auth", auth);
  c.set("authState", authn.state);
  return { ok: true, auth, repo };
}
