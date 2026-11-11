// The continuation a blame client holds: which run it reads and how far.
// Opaque to clients, base64url JSON. It grants nothing: every field must
// equal the run's row and the object's current values, and the request is
// authorized before it reaches the object. A forged one can only name state
// the caller can already read in this repository, so it isn't signed.

export interface BlameToken {
  readonly v: 1;
  readonly repo: string;
  readonly epoch: number;
  /** The blamed commit, in hex. */
  readonly commit: string;
  /** SHA-256 of the path, in hex: the path itself stays out of the token. */
  readonly path: string;
  readonly engine: number;
  readonly run: string;
  /** How many ranges the client has read. */
  readonly offset: number;
}

const MAX_TOKEN = 1024;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const REPO = /^rep_[0-9A-HJKMNP-TV-Z]{26}$/;

const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

export function encodeBlameToken(token: BlameToken): string {
  const bytes = new TextEncoder().encode(JSON.stringify(token));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The token's fields when it has a token's shape, else undefined. Nothing is read. */
export function decodeBlameToken(text: string): BlameToken | undefined {
  if (text.length === 0 || text.length > MAX_TOKEN || !/^[A-Za-z0-9_-]+$/.test(text))
    return undefined;
  let value: unknown;
  try {
    const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        Uint8Array.from(binary, (c) => c.charCodeAt(0)),
      ),
    );
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const t = value as Record<string, unknown>;
  const keys = Object.keys(t).sort().join(",");
  if (keys !== "commit,engine,epoch,offset,path,repo,run,v") return undefined;
  if (
    t.v !== 1 ||
    typeof t.repo !== "string" ||
    !REPO.test(t.repo) ||
    !isCount(t.epoch) ||
    typeof t.commit !== "string" ||
    !HEX40.test(t.commit) ||
    typeof t.path !== "string" ||
    !HEX64.test(t.path) ||
    !isCount(t.engine) ||
    typeof t.run !== "string" ||
    !ULID.test(t.run) ||
    !isCount(t.offset)
  )
    return undefined;
  return t as unknown as BlameToken;
}

/** The SHA-256 of a path, in hex, as a token names it. */
export async function pathDigest(path: string): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path)),
  );
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}
