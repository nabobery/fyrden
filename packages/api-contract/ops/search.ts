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
    "Fyrden: the org read model's write protocol and search's state, for operators. `protocol`: the executor version this deployment serves, the version the last deploy verified as serving (0 until one did), the oldest the read model admits, whether writes outside the executor are only counted (`compatibility`) or refused (`enforced`), the restore floor, and the restore token (`restore_token`: none written yet, `uninitialized`, until the first handshake; `matched`; a handshake under way, `intent`; or `mismatch`, the read model restored or changed since the last handshake, best effort). `barrier`: the directory's and the read model's barriers (null where a row is missing, and then not `consistent`). `admission`: whether a write is under way, writes made outside the executor while they were only counted (`stray`), and the read model's write sequence. `writers`: leases live and expired, and the earliest deadline. `export`: whether a coherent export of the read model can be made (not before a restore floor is recorded: `no_restore_floor`). `recovery`: the latest recovery of the read model (`admin.read_model.recovery.*`), its id, generation and stage, or null when there never was one. `search`: today's spending of its allowance and of the repository index's, with the limits (`limits`: rows and reads a day, the size at which it admits no more growth (the size observed and the growth reserved since, together; removals are still made), the repository index's rows a day and the repositories it holds at most); the size last observed and the growth reserved since; the issues and pull requests counted in the full-text index (`live_docs`) and the repositories (`indexed_repos`); whether a reconciliation is due and since when the one due next has waited; the parked one whose wait ends first (`next_parked`: a pass ended partial, with why, and when it may be tried again); and a repository whose projections and full-text entries are not known whole (`first_uncovered`: each is certified on its own by a whole reconciliation, so none listed does not mean a backfill reached every repository); the read model's recovery generation (`recovery_gen`), a repository hidden since a recovery until its reconciliation (`first_hidden`), and the purge of a tombstoned repository's search rows next (`next_purge`). Instance administrators only.",
  input: z.object({}),
  output: z.object({
    indexing: z.boolean(),
    protocol: z.object({
      serving_version: z.number().int(),
      deployed_version: z.number().int().nullable(),
      required_version: z.number().int().nullable(),
      mode: z.enum(["compatibility", "enforced"]),
      restore_floor: z.string().nullable(),
      restore_token: z.enum(["uninitialized", "matched", "intent", "mismatch"]),
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
      reason: z.enum(["no_restore_floor"]).nullable(),
    }),
    recovery: z
      .object({
        recovery_id: z.string(),
        generation: z.number().int(),
        stage: z.enum([
          "preserving",
          "awaiting_restore",
          "importing",
          "fencing",
          "resuming",
          "complete",
        ]),
      })
      .nullable(),
    search: z.object({
      day: z.number().int(),
      rows: z.number().int(),
      reads: z.number().int(),
      repo_rows: z.number().int(),
      bytes: z.number().int(),
      bytes_reserved: z.number().int(),
      observed_sequence: z.number().int(),
      live_docs: z.number().int(),
      indexed_repos: z.number().int(),
      limits: z.object({
        daily_rows: z.number().int(),
        daily_reads: z.number().int(),
        max_bytes: z.number().int(),
        repository_daily_rows: z.number().int(),
        repository_capacity: z.number().int(),
      }),
      repair_pending: z.boolean(),
      next_repair_since: z.number().int().nullable(),
      next_parked: z
        .object({ repo_id: z.string(), reason: z.string(), retry_at: z.number().int() })
        .nullable(),
      first_uncovered: z.string().nullable(),
      recovery_gen: z.number().int(),
      first_hidden: z.string().nullable(),
      next_purge: z.string().nullable(),
    }),
  }),
  permission: INSTANCE_READ,
  principals: ["user"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

const SearchIndex = z.enum(["documents", "repositories", "both"]);
const IndexResults = z.object({
  indexes: z.array(z.object({ index: z.enum(["documents", "repositories"]), ok: z.boolean() })),
});

export const checkSearchIndex = defineOperation({
  id: "admin.search.check_index",
  method: "POST",
  path: "/admin/search/indexes/check",
  summary: "Check search's full-text indexes against their projections",
  description:
    "Fyrden: checks a full-text index (`documents`: issues' and pull requests' titles and bodies; `repositories`: names and descriptions; `both`, in that order) against the projections it is built from, each on its own: `ok` false when the index is damaged or does not match them, which it also does while some live projections are not in it yet (projected before the index existed, or their growth refused): ask for a backfill (`POST /admin/search/backfill`), or rebuild a small index (`POST /admin/search/indexes/rebuild`). Allowed at the size threshold; charged to search's allowance. Refused (503 `read_model_maintenance`) while the read model is under maintenance. Instance administrators only.",
  input: z.object({ index: SearchIndex }),
  output: IndexResults,
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "expensive",
  idempotency: "key",
  mcp: false,
});

export const rebuildSearchIndex = defineOperation({
  id: "admin.search.rebuild_index",
  method: "POST",
  path: "/admin/search/indexes/rebuild",
  summary: "Rebuild a small full-text index of search's from its projections",
  description:
    "Fyrden: rebuilds a full-text index (`documents`, `repositories`, or `both`, in that order) from the projections it is built from, at once, and marks every live projection indexed: for small deployments only (at most 256 live projections and 1 MiB of their text an index; refused, 409 `index_rebuild_too_large`, past either: ask for a backfill instead, which reconciles each repository within the day's allowance). Refused (409 `index_reconcile_required`) while a live issue or pull request has no repository number yet (its repository's reconciliation gives it one), and (409 `index_rebuild_refused`) when search's allowance or the database's size admits no rebuild. Both indexes are looked at before either is rebuilt; one refused at its rebuild leaves the one before it rebuilt. It repairs the index, not the projections: no repository becomes known whole by it. `ok` is true for each index rebuilt. Refused (503 `read_model_maintenance`) while the read model is under maintenance. Instance administrators only.",
  input: z.object({ index: SearchIndex }),
  output: IndexResults,
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "expensive",
  idempotency: "key",
  mcp: false,
});
