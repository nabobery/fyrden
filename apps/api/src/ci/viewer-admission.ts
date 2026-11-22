import type { Logger, Metrics } from "@fyrden/adapters-cloudflare/obs";
import { LOG_LATE_MS } from "../do/run/logs.js";
import { LOG_VIEWER_POLICY } from "../do/run/viewers.js";
import {
  type CiGrantResult,
  type CiLimits,
  type CiViewerBudget,
  ciAllowance,
  ciFleetCap,
  ciMaxJobMinutes,
  ciViewerPrice,
  grantCi,
} from "./budget.js";

/*
 * Whether a live log ticket may be answered, decided after the run stored
 * it (and sized its log). On Free each ticket is granted from the CI
 * ledger as a viewer, priced for its socket's reads and life, which the run
 * holds the socket to; a ticket not granted is deleted by the operation.
 * Paid admits every viewer and budgets nothing.
 */

/** Why a viewer is not admitted: what the operation answers. */
export interface LogViewerRefusal {
  readonly status: 429 | 503;
  readonly code: string;
  readonly message: string;
  readonly retryAfter?: number;
  /** When it may be admitted again (Unix ms). */
  readonly retryAt?: number;
}

/** A ticket the run stored: what its admission is decided on. */
export interface StoredTicket {
  readonly hash: string;
  readonly runId: string;
  /** The account the repository belongs to. */
  readonly accountId: string;
  /** When it expires, on the run's clock. */
  readonly expiresAt: number;
  /** What the run holds its socket to, sized from the job's log at issuance; null when unbudgeted. */
  readonly budget: CiViewerBudget | null;
}

export interface LogViewerAdmission {
  /**
   * Whether the run holds a ticket's socket to a budget sized from the log
   * at issuance, and the longest rows may flow to it (Free's longest job and
   * the late window); null when unbudgeted.
   */
  readonly budget: { readonly maxActiveMs: number } | null;
  onTicket(ticket: StoredTicket): Promise<"ok" | LogViewerRefusal>;
}

export const admitEveryViewer: LogViewerAdmission = {
  budget: null,
  onTicket: async () => "ok",
};

/** How long a ticket may cost: its redemption window, then its socket's life. */
export const VIEWER_SPAN_MS = LOG_VIEWER_POLICY.ticketMs + LOG_VIEWER_POLICY.lifeMs;

/**
 * Charged past the span: the ledger's clock is `unixepoch()`, whole seconds
 * (verified: https://sqlite.org/lang_datefunc.html), up to 999 ms behind the
 * ticket's issuance in milliseconds, so the span it charges may end before
 * the socket's latest end, and near midnight leave a day uncharged.
 */
const LEDGER_CLOCK_MARGIN_MS = 1000;

const unavailable = (message: string): LogViewerRefusal => ({
  status: 503,
  code: "log_viewers_unavailable",
  message,
});

/**
 * Free's admission: each ticket granted from the CI ledger as a viewer,
 * keyed by its hash, valid until the ticket expires, priced for the budget
 * the run holds its socket to (`ciViewerPrice`), charged on every UTC day
 * from issuance to the end of its socket's life.
 */
export function freeViewerAdmission(
  db: D1Database,
  limits: CiLimits & { readonly maxActiveMs: number },
  metrics: Metrics,
  log: Logger,
): LogViewerAdmission {
  return {
    budget: { maxActiveMs: limits.maxActiveMs },
    async onTicket(ticket) {
      if (!ticket.budget) {
        log.error("log viewer not granted: its ticket was stored with no budget");
        return unavailable("Log viewers cannot be accounted for right now. Try again.");
      }
      const price = ciViewerPrice(ticket.budget);
      let answer: CiGrantResult;
      try {
        metrics.count("d1.query", { db: "directory", op: "ci_grant_viewer" }, 3);
        answer = await grantCi(
          db,
          {
            key: `${ticket.runId}/viewer/${ticket.hash}`,
            kind: "viewer",
            accountId: ticket.accountId,
            validUntil: ticket.expiresAt,
            price,
            spanMs: VIEWER_SPAN_MS + LEDGER_CLOCK_MARGIN_MS,
          },
          limits,
        );
      } catch (error) {
        log.error("log viewer not granted: the CI ledger did not answer", { error });
        return unavailable("Log viewers cannot be accounted for right now. Try again.");
      }
      if (answer.status === "granted") return "ok";
      if (answer.status === "refused" && answer.reason === "fleet") {
        log.warn("log viewer not granted: more runners serve than the fleet's cap");
        return unavailable(
          "This deployment has more runners than its fleet's cap allows, so it admits no log viewers.",
        );
      }
      if (answer.status === "refused" && "retryAt" in answer) {
        const issuedAt = ticket.expiresAt - LOG_VIEWER_POLICY.ticketMs;
        const retryAfter = Math.max(1, Math.ceil((answer.retryAt - issuedAt) / 1000));
        return {
          status: 429,
          code: "log_viewers_spent",
          message: `This deployment's capacity for watching logs is spent for today. It resets at 00:00 UTC, in ${retryAfter} s.`,
          retryAfter,
          retryAt: answer.retryAt,
        };
      }
      if (answer.status === "refused" && answer.reason === "too_large")
        return unavailable(
          "Watching this log costs more than this deployment's daily capacity for log viewers.",
        );
      log.error("log viewer not granted", {
        status: answer.status,
        reason: answer.status === "refused" ? answer.reason : undefined,
      });
      return unavailable("Log viewers cannot be accounted for right now. Try again.");
    },
  };
}

/** The deployment's viewer admission, from CI's configuration: Free's ledger, or Paid's none. */
export function logViewerAdmissionFor(
  env: object,
  db: D1Database,
  metrics: Metrics,
  log: Logger,
): LogViewerAdmission {
  const allowance = ciAllowance(env);
  if (!allowance) return admitEveryViewer;
  const maxJobMinutes = ciMaxJobMinutes(env);
  const maxActiveMs =
    maxJobMinutes === null ? LOG_VIEWER_POLICY.lifeMs : maxJobMinutes * 60_000 + LOG_LATE_MS;
  return freeViewerAdmission(
    db,
    { allowance, fleetCap: ciFleetCap(env), maxActiveMs },
    metrics,
    log,
  );
}
