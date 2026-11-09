import { z } from "zod";

/** RFC 9457 problem details, shared by REST errors and MCP tool errors. */
export const Problem = z.object({
  type: z.string().default("about:blank"),
  status: z.number().int(),
  code: z.string().describe("Stable machine-readable error code."),
  detail: z.string(),
  request_id: z.string().optional(),
  missing_permission: z.string().optional(),
  resync: z
    .string()
    .optional()
    .describe("Where to start over when a cursor expired (`cursor_expired`): a REST path."),
  current_version: z
    .number()
    .int()
    .optional()
    .describe(
      "Fyrden: with `stale`, the version it is at now (read it again to see what changed).",
    ),
  retry_after: z
    .number()
    .int()
    .optional()
    .describe(
      "With a 429 or a 503: seconds to wait before trying again (also the `Retry-After` header).",
    ),
  retry_at: z
    .number()
    .int()
    .optional()
    .describe(
      "Fyrden: with a refusal that lasts until a known time (a daily allowance spent): when to try again, Unix time in milliseconds (the next UTC day's start).",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "Fyrden: with a live hints refusal, which check refused it. Diagnostic only: names may change.",
    ),
});

export type Problem = z.infer<typeof Problem>;

export interface ProblemInit {
  status: number;
  code: string;
  detail: string;
  requestId?: string | undefined;
  type?: string;
  missingPermission?: string;
  resync?: string;
  currentVersion?: number;
  retryAfter?: number;
  retryAt?: number;
  reason?: string;
}

/**
 * The one constructor for problem documents. REST and MCP send what it
 * returns unchanged, so a field added here reaches both surfaces.
 */
export function makeProblem(init: ProblemInit): Problem {
  return {
    type: init.type ?? "about:blank",
    status: init.status,
    code: init.code,
    detail: init.detail,
    ...(init.requestId !== undefined && { request_id: init.requestId }),
    ...(init.missingPermission !== undefined && { missing_permission: init.missingPermission }),
    ...(init.resync !== undefined && { resync: init.resync }),
    ...(init.currentVersion !== undefined && { current_version: init.currentVersion }),
    ...(init.retryAfter !== undefined && { retry_after: init.retryAfter }),
    ...(init.retryAt !== undefined && { retry_at: init.retryAt }),
    ...(init.reason !== undefined && { reason: init.reason }),
  };
}
