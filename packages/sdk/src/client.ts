import type { DpopKey } from "./dpop.js";
import { OPERATIONS, type Operations } from "./generated.js";

export type OperationId = keyof Operations;
export type InputOf<K extends OperationId> = Operations[K]["input"];
export type OutputOf<K extends OperationId> = Operations[K]["output"];

/** Operations whose answers come a page at a time. */
type Paged = {
  [K in OperationId]: (typeof OPERATIONS)[K] extends { readonly items: string } ? K : never;
}[OperationId];

/**
 * One item of a paginated operation's pages (for a union of operations,
 * any of theirs; for an answer that is a union, the variant that pages).
 */
export type ItemOf<K extends Paged> = K extends Paged
  ? (typeof OPERATIONS)[K] extends { readonly items: infer F extends string }
    ? Extract<OutputOf<K>, { readonly [P in F]: unknown }>[F] extends readonly (infer I)[]
      ? I
      : never
    : never
  : never;

/** Every member of a union at once: what an input must hold to suit any of the operations. */
type AllOf<U> = (U extends unknown ? (u: U) => void : never) extends (all: infer I) => void
  ? I
  : never;

/** A refusal from the API: its problem document (RFC 9457), typed. */
export class FyrdenError extends Error {
  override name = "FyrdenError";
  constructor(
    /** HTTP status. */
    readonly status: number,
    /** The problem's stable code (`repo_not_found`, `name_taken`, ...). */
    readonly code: string,
    readonly detail: string,
    readonly requestId: string | undefined,
    /** The permission the token lacked, for `missing_permission`. */
    readonly missingPermission: string | undefined,
    /** Where to start over, for `cursor_expired` (a REST path). */
    readonly resync?: string,
    /** For `stale` (Fyrden's): the version it is at now. */
    readonly currentVersion?: number,
  ) {
    super(`${code}: ${detail}`);
  }
}

export interface ClientOptions {
  /** The API's base URL, `https://<host>/api`. */
  readonly baseUrl: string;
  /** The token sent as `Authorization: Bearer`, or a function giving it (refreshed tokens). */
  readonly token?: string | (() => string | Promise<string>);
  /**
   * The key a DPoP-bound token is bound to: the token is then sent as
   * `Authorization: DPoP` with a fresh proof on every request.
   */
  readonly dpop?: DpopKey;
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

export interface CallOptions {
  /** For a write: the key a retry reuses to get the first answer (one is made when absent). */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

/**
 * A typed client: `call("repos.create", { name })` sends the operation as
 * its REST route (path parameters in the path, the rest in the query for
 * GET or the JSON body otherwise); writes carry an `Idempotency-Key`.
 */
export class FyrdenClient {
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    // A loop, not /\/+$/: that regex is quadratic on many slashes that do not
    // end the string, and the base URL is whatever the caller passes.
    let end = options.baseUrl.length;
    while (end > 0 && options.baseUrl.charCodeAt(end - 1) === 0x2f) end--;
    this.#base = options.baseUrl.slice(0, end);
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
  }

  async call<K extends OperationId>(
    id: K,
    input: InputOf<K>,
    options: CallOptions = {},
  ): Promise<OutputOf<K>> {
    const op = OPERATIONS[id];
    const fields = { ...(input as Record<string, unknown>) };
    let path: string = op.path;
    for (const name of op.pathParams) {
      const value = fields[name];
      delete fields[name];
      if (value === undefined || value === null) throw new TypeError(`${id} needs ${name}`);
      const text = String(value);
      // A URL resolves `.` and `..` segments: one could address another route.
      if (text.split("/").some((segment) => segment === "." || segment === ".."))
        throw new TypeError(`${id}: ${name} may not hold a "." or ".." segment`);
      // A greedy parameter (`{path+}`) keeps its slashes.
      path = path
        .replace(`{${name}+}`, text.split("/").map(encodeURIComponent).join("/"))
        .replace(`{${name}}`, encodeURIComponent(text));
    }
    const url = new URL(`${this.#base}${path}`);
    const headers: Record<string, string> = { Accept: "application/json" };
    const token =
      typeof this.options.token === "function" ? await this.options.token() : this.options.token;
    if (token && this.options.dpop) {
      headers.Authorization = `DPoP ${token}`;
      headers.DPoP = await this.options.dpop.proof(op.method, url, token);
    } else if (token) headers.Authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (op.method === "GET") {
      for (const [name, value] of Object.entries(fields))
        if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(fields);
      if (op.idempotent) headers["Idempotency-Key"] = options.idempotencyKey ?? crypto.randomUUID();
    }
    const response = await this.#fetch(url, {
      method: op.method,
      headers,
      ...(body !== undefined && { body }),
      // A redirect would carry the token's proof, and a write's body, elsewhere: never followed.
      redirect: "manual",
      ...(options.signal && { signal: options.signal }),
    });
    refuseRedirect(response);
    const text = await response.text();
    if (!response.ok) {
      // A problem document, or anything else (a proxy's HTML page): an error with its status.
      const problem = parseObject(text) ?? {};
      throw new FyrdenError(
        response.status,
        typeof problem.code === "string" ? problem.code : "http_error",
        typeof problem.detail === "string"
          ? problem.detail
          : `${response.status} ${response.statusText}`.trim(),
        typeof problem.request_id === "string" ? problem.request_id : undefined,
        typeof problem.missing_permission === "string" ? problem.missing_permission : undefined,
        typeof problem.resync === "string" ? problem.resync : undefined,
        typeof problem.current_version === "number" ? problem.current_version : undefined,
      );
    }
    // An operation that answers nothing (204, 205) gives null, as its output type says.
    if (response.status === 204 || response.status === 205) return null as unknown as OutputOf<K>;
    return (text ? JSON.parse(text) : {}) as OutputOf<K>;
  }

  /**
   * Every item of a paginated operation, page after page (following
   * `next_cursor`); an answer without the paged field (a path that is a
   * file, not a directory) has no items.
   */
  async *paginate<K extends Paged>(
    id: K,
    input: Omit<AllOf<InputOf<K>>, "cursor">,
    options: Omit<CallOptions, "idempotencyKey"> = {},
  ): AsyncGenerator<ItemOf<K>> {
    const field = (OPERATIONS[id] as { readonly items: string }).items;
    let cursor: string | null | undefined;
    do {
      // Once a page answered, its cursor carries on from where `after` (a start given by id)
      // began: the two are never sent together.
      const { after: _after, ...rest } = input as Record<string, unknown>;
      const page = (await this.call(
        id,
        (cursor ? { ...rest, cursor } : input) as InputOf<K>,
        options,
      )) as Record<string, unknown>;
      for (const item of (page[field] as ItemOf<K>[] | undefined) ?? []) yield item;
      cursor = page.next_cursor as string | null | undefined;
    } while (cursor);
  }
}

/**
 * Throws for a redirect a request with `redirect: "manual"` got back (a
 * browser shows it as an opaque one, with status 0): its request is not
 * sent on.
 */
export function refuseRedirect(response: Response): void {
  if (
    (response.type as string) === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  )
    throw new FyrdenError(
      response.status,
      "redirected",
      "The server redirected; the request was not sent on.",
      undefined,
      undefined,
    );
}

/** `text` as a JSON object, or undefined when it is not one. */
function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
