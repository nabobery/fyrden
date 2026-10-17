import {
  BASE64_RUN,
  base64RunHasToken,
  decodeAsciiPercent,
  TOKEN_IN_TEXT,
  WEBHOOK_SECRET_IN_TEXT,
} from "@fyrden/domain";

/**
 * Log redaction. Applied to every structured log line, so a token
 * that reaches a log call by mistake is still never written.
 */
export const REDACTED = "[REDACTED]";

const AUTH_SCHEME = /\b(Bearer|Basic|DPoP|token)(\s+|%20|\+)([A-Za-z0-9._~+/=-]+)/gi;

const SENSITIVE_KEY =
  /(authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key|credential|signature)/i;
// Keys that name a sensitive thing without holding it.
const SAFE_KEY = /(_id|Id|_ids|Ids|_prefix|Prefix|_type|Type|_count|Count|_at|At)$/;

const SECRET = Symbol("fyrden.secret");

export interface Secret {
  readonly [SECRET]: true;
  toJSON(): string;
  toString(): string;
}

/** Marks a value as secret: it renders as [REDACTED] in logs and JSON, whatever its key. */
export function secret(_value: unknown): Secret {
  return { [SECRET]: true, toJSON: () => REDACTED, toString: () => REDACTED };
}

function isSecret(value: unknown): value is Secret {
  return typeof value === "object" && value !== null && SECRET in value;
}

export function redactString(input: string): string {
  // Percent-escapes are decoded first (leniently), so an encoded token is
  // caught by the same patterns as a plain one.
  let out = decodeAsciiPercent(input);
  out = out.replace(TOKEN_IN_TEXT, (_, type: string) => `fyrden_${type}_${REDACTED}`);
  out = out.replace(WEBHOOK_SECRET_IN_TEXT, `whsec_${REDACTED}`);
  out = out.replace(
    AUTH_SCHEME,
    (_, scheme: string, space: string) => `${scheme}${space}${REDACTED}`,
  );
  out = out.replace(BASE64_RUN, (run) => (base64RunHasToken(run) ? REDACTED : run));
  return out;
}

export function redact(value: unknown): unknown {
  return walk(value, new WeakSet());
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object" || value === null) return value;
  if (isSecret(value)) return REDACTED;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (value instanceof Error) {
    return {
      name: redactString(value.name),
      message: redactString(value.message),
      stack: value.stack && redactString(value.stack),
    };
  }
  if (Array.isArray(value)) return value.map((item) => walk(item, seen));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    // Keys are text too: a token used as a key must not survive.
    out[redactString(key)] =
      SENSITIVE_KEY.test(key) && !SAFE_KEY.test(key) ? REDACTED : walk(inner, seen);
  }
  return out;
}
