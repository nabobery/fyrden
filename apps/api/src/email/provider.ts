import { countSubrequests } from "@fyrden/adapters-cloudflare/obs";
import { emailLimits } from "./spending.js";
import { type Lookup, suppressionOf } from "./suppressions.js";
import { webhookSecretBytes } from "./webhook-signature.js";

/*
 * The email provider port: one message sent, its outcome classified so
 * that nothing is sent twice. `accepted` only when the provider answered
 * that it took the message (with its id); `refused` only when it answered
 * that it did not (`permanent`: the request itself is at fault, never
 * tried again; otherwise it may be tried again later, as the caller's
 * policy allows, with the same idempotency key and payload); `unknown`
 * whenever the message may have reached it without a clear answer (a
 * server error, a timeout, a broken or unexpected answer), which nobody
 * tries again.
 *
 * Configured by the deployment: `FYRDEN_EMAIL_PROVIDER` (`resend`; any
 * other value: none), `FYRDEN_EMAIL_FROM` (the sending address) and, for
 * Resend, the secret `RESEND_API_KEY`; all or none. Sending anything at all
 * also needs `FYRDEN_EMAIL_SENDING=on` and its safeguards (see `emailSending`).
 */

/** One message. */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Provider tags (Resend's), for reading its logs. */
  readonly tags?: Readonly<Record<string, string>>;
  /** The same for every attempt of one message (with the same payload). */
  readonly idempotencyKey: string;
}

export type SendOutcome =
  | { readonly status: "accepted"; readonly id: string }
  | {
      readonly status: "refused";
      readonly permanent: boolean;
      readonly reason: string;
      /** When a transient refusal may be tried again (milliseconds), when the provider said. */
      readonly retryAfterMs?: number;
    }
  | { readonly status: "unknown"; readonly reason: string };

export interface EmailProvider {
  readonly name: string;
  /** The sending address every message goes from. */
  readonly from: string;
  send(message: EmailMessage): Promise<SendOutcome>;
  /** The provider's suppression of an address (as it gave it), when it keeps a list. */
  lookupSuppression?(email: string): Promise<Lookup>;
}

/** Hooks for tests: a provider of their own, in place of the deployment's. */
export const emailHooks: { provider?: EmailProvider | null; sending?: boolean } = {};

type EmailEnv = {
  FYRDEN_EMAIL_PROVIDER?: unknown;
  FYRDEN_EMAIL_FROM?: unknown;
  FYRDEN_EMAIL_SENDING?: unknown;
  RESEND_API_KEY?: unknown;
  RESEND_WEBHOOK_SECRET?: unknown;
};

/** The deployment's provider, or null when it has none (or one configured only in part). */
export function emailProvider(env: object): EmailProvider | null {
  if (emailHooks.provider !== undefined) return emailHooks.provider;
  const { FYRDEN_EMAIL_PROVIDER, FYRDEN_EMAIL_FROM, RESEND_API_KEY } = env as EmailEnv;
  if (
    FYRDEN_EMAIL_PROVIDER !== "resend" ||
    typeof FYRDEN_EMAIL_FROM !== "string" ||
    FYRDEN_EMAIL_FROM === "" ||
    typeof RESEND_API_KEY !== "string" ||
    RESEND_API_KEY === ""
  )
    return null;
  return resendProvider(RESEND_API_KEY, FYRDEN_EMAIL_FROM);
}

/**
 * Whether the deployment sends email at all: `FYRDEN_EMAIL_SENDING=on`, a
 * provider, its callbacks' usable secret (`RESEND_WEBHOOK_SECRET`, so its
 * suppressions reach Fyrden) and usable limits (`emailLimits`).
 */
export function emailSending(env: object): boolean {
  if (emailHooks.sending !== undefined)
    return emailHooks.sending && emailProvider(env) !== null && emailLimits(env) !== null;
  const { FYRDEN_EMAIL_SENDING, RESEND_WEBHOOK_SECRET } = env as EmailEnv;
  return (
    FYRDEN_EMAIL_SENDING === "on" &&
    webhookSecretBytes(RESEND_WEBHOOK_SECRET) !== undefined &&
    emailProvider(env) !== null &&
    emailLimits(env) !== null
  );
}

/**
 * Resend's errors that mean the request itself was refused (by its
 * documented `name`, https://resend.com/docs/api-reference/errors): never
 * tried again.
 */
const PERMANENT = new Set([
  "validation_error",
  "invalid_idempotency_key",
  "invalid_idempotent_request",
  "missing_api_key",
  "restricted_api_key",
  "suspended_api_key",
  "invalid_permission",
  "not_found",
  "method_not_allowed",
  "invalid_attachment",
  "invalid_parameter",
  "missing_required_field",
  "missing_required_parameter",
]);

/** Resend's errors that refused the request for now: it may be tried again later. */
const TRANSIENT = new Set([
  "rate_limit_exceeded",
  "daily_quota_exceeded",
  "monthly_quota_exceeded",
  "concurrent_idempotent_requests",
  "resource_locked",
]);

/** How long a request to Resend may take before its outcome is unknown. */
const RESEND_TIMEOUT_MS = 10_000;

/** When a transient refusal may be tried again, from `Retry-After` or `ratelimit-reset` (seconds). */
function retryAfterMs(headers: Headers): number | undefined {
  for (const name of ["retry-after", "ratelimit-reset"]) {
    const seconds = Number(headers.get(name));
    if (headers.has(name) && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  return undefined;
}

/** Resend, through its HTTP API (`fetch` given for tests). */
export function resendProvider(
  apiKey: string,
  from: string,
  fetcher: typeof fetch = fetch,
): EmailProvider {
  return {
    name: "resend",
    from,
    async send(message) {
      let response: Response;
      try {
        countSubrequests("external");
        response = await fetcher("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": message.idempotencyKey,
          },
          body: JSON.stringify({
            from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            ...(message.html !== undefined && { html: message.html }),
            ...(message.headers && { headers: message.headers }),
            ...(message.tags && {
              tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })),
            }),
          }),
          signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
        });
      } catch (error) {
        // Sent or not, the provider may have it: never again.
        return { status: "unknown", reason: `no answer: ${String(error)}` };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { status: "unknown", reason: `an answer without a body (${response.status})` };
      }
      const named = body as { id?: unknown; name?: unknown; message?: unknown } | null;
      if (response.ok)
        return typeof named?.id === "string" && named.id !== ""
          ? { status: "accepted", id: named.id }
          : { status: "unknown", reason: `accepted without an id (${response.status})` };
      const name = typeof named?.name === "string" ? named.name : "";
      const reason = `${response.status} ${name}${typeof named?.message === "string" ? `: ${named.message}` : ""}`;
      if (response.status >= 400 && response.status < 500 && PERMANENT.has(name))
        return { status: "refused", permanent: true, reason };
      if ((response.status === 429 || response.status === 409) && TRANSIENT.has(name)) {
        const after = retryAfterMs(response.headers);
        return {
          status: "refused",
          permanent: false,
          reason,
          ...(after !== undefined && { retryAfterMs: after }),
        };
      }
      return { status: "unknown", reason };
    },
    async lookupSuppression(email) {
      let response: Response;
      countSubrequests("external");
      try {
        // The address as one path segment: `/`, `#`, `?`, `%` and `+` stay in it.
        response = await fetcher(
          `https://api.resend.com/suppressions/${encodeURIComponent(email)}`,
          {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
          },
        );
      } catch {
        return { status: "failed" };
      }
      if (response.status === 404) return { status: "absent" };
      if (response.status === 401 || response.status === 403 || response.status === 429)
        return { status: "failed" };
      if (response.status >= 500) return { status: "failed" };
      if (!response.ok) return { status: "invalid" };
      // A body cut off is the provider's failure; a whole one that does not parse, the row's.
      let text: string;
      try {
        text = await response.text();
      } catch {
        return { status: "failed" };
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return { status: "invalid" };
      }
      const suppression = suppressionOf(body);
      return suppression ? { status: "found", suppression } : { status: "invalid" };
    },
  };
}
