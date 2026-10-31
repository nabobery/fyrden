/*
 * Calling a deployment's API as an instance administrator: its origin from
 * `--url` (https, or http on localhost), the token from `FYRDEN_TOKEN`
 * only, never repeated by an error.
 */

/** Where the API is and the token it is called with. */
export interface ApiTarget {
  /** The API's origin (its workers.dev URL or custom domain). */
  readonly url: string;
  /** An instance administrator's token (`FYRDEN_TOKEN`). */
  readonly token: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** What a bearer token may hold. */
const TOKEN_SHAPE = /^[\x21-\x7e]{1,4096}$/;

/** The API's origin from `url` and the token from the environment, or why not. */
export function apiTarget(
  url: string | undefined,
  env: Record<string, string | undefined>,
  usage: string,
): ApiTarget | { error: string } {
  let origin: URL | undefined;
  try {
    origin = url === undefined ? undefined : new URL(url);
  } catch {}
  const secure =
    origin?.protocol === "https:" ||
    (origin?.protocol === "http:" && LOCAL_HOSTS.has(origin.hostname));
  if (!origin || !secure)
    return { error: `--url must be the API's https URL (http only on localhost)\nusage: ${usage}` };
  const token = env.FYRDEN_TOKEN;
  if (!token) return { error: "set FYRDEN_TOKEN to an instance administrator's token" };
  // Checked here, so no header error ever repeats it.
  if (!TOKEN_SHAPE.test(token))
    return { error: "FYRDEN_TOKEN is not a token (printable characters, no spaces)" };
  return { url: origin.origin, token };
}

/** An answer the API refused with, as its problem says. */
export class ApiError extends Error {
  // Fields, not parameter properties: the CLI runs under Node's type stripping, which has none.
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, detail: string | undefined) {
    super(`the API answered ${status}${code ? ` ${code}` : ""}${detail ? `: ${detail}` : ""}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Calls `path` (under `/api`) with `body` as JSON (none for a GET); its
 * JSON answer, or an `ApiError`. A failure to reach it names the origin and
 * what went wrong, never the token.
 */
export async function callApi<T>(
  fetcher: typeof fetch,
  target: ApiTarget,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const origin = new URL(target.url).origin;
  let response: Response;
  try {
    response = await fetcher(`${origin}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${target.token}`,
        ...(method !== "GET" && { "Content-Type": "application/json" }),
      },
      ...(method !== "GET" && { body: JSON.stringify(body ?? {}) }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new Error(
      `could not reach ${origin} (${String(error).replaceAll(target.token, "<token>")})`,
    );
  }
  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as {
      code?: string;
      detail?: string;
    };
    throw new ApiError(response.status, problem.code, problem.detail);
  }
  return (await response.json()) as T;
}
