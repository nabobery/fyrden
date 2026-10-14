import { env } from "cloudflare:workers";
import type { TokenRecord } from "@fyrden/adapters-cloudflare/auth";
import { uniqueId } from "@fyrden/testing";
import type { ObjectAuthorities } from "../../src/git/cache/object-grant.js";
import { type RepoEntry, resolveRepo } from "../../src/repos/directory.js";
import type { TestRepo } from "./git-http.js";

/** A verified git token of `principalId`, as the authenticator hands it to the access check. */
export function tokenRecord(principalId: string, repoIds: string[] | null = null): TokenRecord {
  return {
    id: uniqueId("tok"),
    type: "git",
    principalId,
    principalType: "user",
    principalHandle: handleOf(principalId),
    isInstanceAdmin: false,
    scopes: [],
    repoIds,
    expiresAt: Date.now() + 60 * 60 * 1000,
    lastUsedAt: null,
    act: [],
    grantId: null,
    ceilingIds: [],
  };
}

/** The handle `principalWithToken` gives a principal. */
export const handleOf = (principalId: string) => principalId.toLowerCase().replace("_", "-");

/** The directory entry of a test repository, read from the primary. */
export async function entryOf(ownerId: string, repo: TestRepo): Promise<RepoEntry> {
  const entry = await resolveRepo(env, handleOf(ownerId), repo.name, { consistency: "primary" });
  if (!entry) throw new Error(`repository ${repo.name} is not in the directory`);
  return entry;
}

const keyOf = (request: RequestInfo | URL) =>
  typeof request === "string" ? request : request instanceof URL ? request.href : request.url;

/**
 * Every Cache API call made through `open`'s caches, in order, as
 * `match <url>` / `put <url>`, plus `open <name>`.
 */
export function spyCaches(log: string[]) {
  const name = uniqueId("responses");
  const open = async (): Promise<Cache> => {
    log.push(`open ${name}`);
    const cache = await caches.open(name);
    return {
      match: async (request, options) => {
        log.push(`match ${keyOf(request)}`);
        return cache.match(request, options);
      },
      put: async (request, response) => {
        log.push(`put ${keyOf(request)}`);
        return cache.put(request, response);
      },
      delete: (request, options) => cache.delete(request, options),
    } as Cache;
  };
  return { open };
}

/** The repository objects, logging each object check as `check <repo id>`. */
export function loggingAuthorities(log: string[]): ObjectAuthorities {
  return {
    getByName(repoId) {
      return {
        objectAccess(request) {
          log.push(`check ${repoId}`);
          return env.REPO.getByName(repoId).objectAccess(request);
        },
      };
    },
  };
}
