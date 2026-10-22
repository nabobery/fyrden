import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { GHOST_LOGIN } from "../accounts/handles.js";
import { refsOf, resolveTree } from "./capture.js";

/*
 * A webhook body made from its event's capture: the capture's tree with
 * its blobs read back and each user (`{ $user: id }`) shown as
 * `{ id, login }`, marked `fyrden_payload: 1`. Logins are the one field
 * not as of the event: they are read when the body is made (seconds after
 * the event, usually), a principal being deleted, deleted or unknown
 * shown as `ghost`, as GitHub shows one.
 */

/** The capture format this version makes bodies from. */
export const CAPTURE_VERSION = 1;

/** What an event's `data.webhook` holds when the event was captured. */
export interface WebhookCapture {
  readonly v: number;
  /** The body as of the event: blob references for long text, `{ $user: id }` for users. */
  readonly tree: Record<string, unknown>;
  /** The bytes of the JSON encodings of its blobs, all told. */
  readonly blobBytes: number;
}

/** A user as a capture names one. */
interface UserRef {
  readonly $user: string;
}

function isUserRef(value: unknown): value is UserRef {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, "$user") &&
    typeof (value as UserRef).$user === "string"
  );
}

/** The distinct user ids `tree` names. */
export function usersOf(tree: unknown): string[] {
  const ids = new Set<string>();
  const walk = (value: unknown): void => {
    if (isUserRef(value)) ids.add(value.$user);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null) Object.values(value).forEach(walk);
  };
  walk(tree);
  return [...ids];
}

/** `capture` as an event's `data.webhook` holds it, or why it cannot make a body. */
export function captureOf(
  data: Record<string, unknown> | null,
): WebhookCapture | "absent" | "invalid" {
  const capture = data?.webhook;
  if (capture === undefined) return "absent";
  if (typeof capture !== "object" || capture === null) return "invalid";
  const { v, tree, blobBytes } = capture as Record<string, unknown>;
  if (v !== CAPTURE_VERSION) return "invalid";
  if (typeof tree !== "object" || tree === null || Array.isArray(tree)) return "invalid";
  // The body's own marker is the composer's to set.
  if (Object.hasOwn(tree, "fyrden_payload")) return "invalid";
  if (typeof blobBytes !== "number" || !Number.isSafeInteger(blobBytes) || blobBytes < 0)
    return "invalid";
  return { v, tree: tree as Record<string, unknown>, blobBytes };
}

/** The hashes of the blobs `tree` names. */
export const blobsOf = (tree: unknown): string[] => refsOf(tree).map((ref) => ref.$blob);

/** Principals one directory query reads (D1 binds at most 100 parameters). */
export const LOGIN_BATCH = 90;

/**
 * The logins of `ids` as a body shows them, from the directory's primary:
 * `ghost` for one being deleted, deleted or unknown. Throws when the
 * directory cannot answer (the body is made later, never with everyone a
 * ghost).
 */
export async function loginsOf(
  env: Env,
  ids: readonly string[],
  metrics?: Metrics,
): Promise<Map<string, string>> {
  const logins = new Map<string, string>();
  if (ids.length === 0) return logins;
  const db = env.DIRECTORY.withSession("first-primary");
  for (let at = 0; at < ids.length; at += LOGIN_BATCH) {
    const batch = ids.slice(at, at + LOGIN_BATCH);
    metrics?.count("d1.query", { db: "directory", op: "webhook_logins" });
    const { results } = await db
      .prepare(
        `SELECT id, handle FROM principals WHERE id IN (${batch.map(() => "?").join(", ")})
           AND lifecycle NOT IN ('deleting', 'deleted')`,
      )
      .bind(...batch)
      .all<{ id: string; handle: string }>();
    for (const row of results) logins.set(row.id, row.handle);
  }
  return logins;
}

/**
 * The body `capture` makes: its blobs (`texts`, hash to JSON encoding)
 * read back, its users shown with `logins`, `fyrden_payload: 1` first.
 * Throws when a blob is missing or not its recorded size.
 */
export function composeBody(
  capture: WebhookCapture,
  texts: ReadonlyMap<string, string>,
  logins: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const users = (value: unknown): unknown => {
    if (isUserRef(value)) return { id: value.$user, login: logins.get(value.$user) ?? GHOST_LOGIN };
    if (Array.isArray(value)) return value.map(users);
    if (typeof value === "object" && value !== null)
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, users(item)]));
    return value;
  };
  const resolved = users(resolveTree(capture.tree, texts)) as Record<string, unknown>;
  return { fyrden_payload: CAPTURE_VERSION, ...resolved };
}
