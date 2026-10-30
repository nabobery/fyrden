import { z } from "zod";
import { defineOperation, INSTANCE_ADMIN, INSTANCE_READ } from "../src/op.js";

export const backfillSearch = defineOperation({
  id: "admin.search.backfill",
  method: "POST",
  path: "/admin/search/backfill",
  summary: "Ask search to reconcile every repository",
  description:
    "Fyrden: asks for a reconciliation of every active repository's search projections, a page of repositories at a time (call again with `cursor` until `next_cursor` is null); `requested` counts the repositories newly asked (one already waiting is not asked again). The reconciliations run in the five-minute maintenance within search's daily allowance. Refused (409) while search indexing is off: run it once indexing is on, after which repositories made meanwhile are projected from their events (or reconciled, when published late). Instance administrators only.",
  input: z.object({
    cursor: z.string().max(200).optional(),
  }),
  output: z.object({
    requested: z.number().int(),
    next_cursor: z.string().nullable(),
  }),
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "expensive",
  idempotency: "key",
  mcp: false,
});

export const setSearchIndexing = defineOperation({
  id: "admin.search.indexing",
  method: "PUT",
  path: "/admin/search/indexing",
  summary: "Turn search indexing on or off",
  description:
    "Fyrden: turns the deployment's search indexing on (`enabled: true`: events project issues, pull requests, labels and milestones into search, and the five-minute maintenance repairs them within search's daily allowance) or off (nothing more is projected or repaired, though an event batch or repair run already past its check may finish; what is projected stays). Projections miss what happens while it is off: after turning it on, ask for a backfill (`POST /admin/search/backfill`). Setting the state it is in changes nothing. Instance administrators only.",
  input: z.object({ enabled: z.boolean() }),
  output: z.object({ enabled: z.boolean() }),
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: false,
});

const BarrierPhase = z.enum(["running", "pausing", "paused", "recovering"]);

export const getSearchStatus = defineOperation({
  id: "admin.search.status",
  method: "GET",
  path: "/admin/search/status",
  summary: "Get the read model's and search's state",
  description:
    "Fyrden: the org read model's write protocol and search's state, for operators. `protocol`: the executor version this deployment serves, the version the last deploy verified as serving (0 until one did), the oldest the read model admits, and whether writes outside the executor are only counted (`compatibility`) or refused (`enforced`). `barrier`: the directory's and the read model's barriers (null where a row is missing, and then not `consistent`). `admission`: whether a write is under way, writes made outside the executor (`stray`), and the read model's write sequence. `writers`: leases live and expired, and the earliest deadline. `export`: whether a coherent export of the read model can be made (not before writes outside the executor are refused). `search`: today's spent allowance, the size last observed, whether reconciliations are waiting, and since when the one due next has. Instance administrators only.",
  input: z.object({}),
  output: z.object({
    indexing: z.boolean(),
    protocol: z.object({
      serving_version: z.number().int(),
      deployed_version: z.number().int().nullable(),
      required_version: z.number().int().nullable(),
      mode: z.enum(["compatibility", "enforced"]),
      restore_floor: z.string().nullable(),
    }),
    barrier: z.object({
      directory_phase: BarrierPhase.nullable(),
      directory_generation: z.number().int().nullable(),
      org_phase: BarrierPhase.nullable(),
      org_generation: z.number().int().nullable(),
      consistent: z.boolean(),
    }),
    admission: z.object({
      open: z.boolean().nullable(),
      stray: z.number().int().nullable(),
      sequence: z.number().int().nullable(),
    }),
    writers: z.object({
      live: z.number().int(),
      expired: z.number().int(),
      earliest_deadline: z.number().int().nullable(),
    }),
    export: z.object({
      available: z.boolean(),
      reason: z.enum(["protocol_not_enforced"]).nullable(),
    }),
    search: z.object({
      day: z.number().int(),
      rows: z.number().int(),
      reads: z.number().int(),
      bytes: z.number().int(),
      observed_sequence: z.number().int(),
      repair_pending: z.boolean(),
      next_repair_since: z.number().int().nullable(),
    }),
  }),
  permission: INSTANCE_READ,
  principals: ["user"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});
