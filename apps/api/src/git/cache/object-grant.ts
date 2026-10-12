import type { ResponseObject } from "@fyrden/adapters-cloudflare";
import { assertGrant, type RepoAccessGrant } from "./grant.js";
import type { ObjectAccessAnswer, ObjectAccessRequest, ObjectAuthority } from "./object-access.js";

/** Where the object check is asked: the repository objects, by repository id (`env.REPO`). */
export interface ObjectAuthorities {
  getByName(repoId: string): ObjectAuthority;
}

/**
 * Proof that one object (or one diff) passed the object check of the
 * repository a grant is for. Made only by `ObjectGrant.authorize`, which asks
 * the repository object of the grant's own repository; response caches
 * accept nothing else, so a cache is consulted only for an object the
 * repository may show. Valid for the request its grant belongs to.
 */
export class ObjectGrant {
  readonly #issued = true;

  private constructor(
    readonly grant: RepoAccessGrant,
    readonly object: ResponseObject,
  ) {
    Object.freeze(this);
  }

  /** Whether `value` was issued by `authorize`. */
  static isObjectGrant(value: unknown): value is ObjectGrant {
    return typeof value === "object" && value !== null && #issued in value;
  }

  /**
   * Runs the object check for `request` in the grant's repository and
   * returns the proof, or undefined when the repository may not show it
   * (missing and forbidden look the same). The authority is looked up by
   * the grant's repository id here, so a check can never be answered by
   * another repository.
   */
  static async authorize(
    grant: RepoAccessGrant,
    authorities: ObjectAuthorities,
    request: ObjectAccessRequest,
  ): Promise<ObjectGrant | undefined> {
    assertGrant(grant);
    const answer = await authorities.getByName(grant.repoId).objectAccess(request);
    const object = answered(request, answer);
    return object && new ObjectGrant(grant, object);
  }
}

/** The object the answer allows, when it answers this request. */
function answered(
  request: ObjectAccessRequest,
  answer: ObjectAccessAnswer,
): ResponseObject | undefined {
  if (!answer.ok) return undefined;
  switch (request.kind) {
    case "commit":
      return answer.kind === "commit" && answer.oid === request.commit
        ? { kind: "commit", oid: answer.oid }
        : undefined;
    case "path":
      if (answer.kind !== "tree" && answer.kind !== "blob") return undefined;
      if (request.expect !== undefined && answer.oid !== request.expect) return undefined;
      return { kind: answer.kind, oid: answer.oid };
    case "diff":
      return answer.kind === "diff" && answer.base === request.base && answer.head === request.head
        ? { kind: "diff", base: answer.base, head: answer.head }
        : undefined;
    default:
      return undefined;
  }
}
