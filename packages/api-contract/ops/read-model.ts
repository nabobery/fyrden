import { z } from "zod";
import { defineOperation, INSTANCE_ADMIN, INSTANCE_READ } from "../src/op.js";

const BarrierPhase = z.enum(["running", "pausing", "paused", "recovering"]);

export const pauseReadModel = defineOperation({
  id: "admin.read_model.pause",
  method: "POST",
  path: "/admin/read-model/pause",
  summary: "Pause the read model's writers",
  description:
    "Fyrden: one step of pausing the org read model's writers: the barrier moves to the next generation (no lease is taken from then on, and no batch of an older generation is admitted), and is `paused` once no lease of an older generation is live (`live` of them, the latest deadline `until`). Call again until `phase` is `paused`; a resume that came between leaves `running`. Allowed while the deployment's read model maintenance holds other writes back. Refused (409 `read_model_recovering`) while the barrier is recovering. Instance administrators only.",
  input: z.object({}),
  output: z.object({
    phase: BarrierPhase,
    generation: z.number().int(),
    live: z.number().int(),
    until: z.number().int().nullable(),
  }),
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  duringMaintenance: true,
  mcp: false,
});

export const resumeReadModel = defineOperation({
  id: "admin.read_model.resume",
  method: "POST",
  path: "/admin/read-model/resume",
  summary: "Resume the read model's writers",
  description:
    "Fyrden: lets the org read model's writers write again, at the latest generation either barrier holds (a generation never goes down); a newer pause that came between stands. With `generation`, only the pause at that generation is resumed (another, newer, stands). Nothing while it runs already or is recovering. Allowed while the deployment's read model maintenance holds other writes back. Instance administrators only.",
  input: z.object({
    generation: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Resume only the pause at this generation (its pause's `generation`)."),
  }),
  output: z.object({ phase: BarrierPhase, generation: z.number().int() }),
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  duringMaintenance: true,
  mcp: false,
});

export const handshakeReadModel = defineOperation({
  id: "admin.read_model.handshake",
  method: "POST",
  path: "/admin/read-model/handshake",
  summary: "Replace the read model's restore token",
  description:
    "Fyrden: replaces the token the org read model holds and the directory records (a handshake), so that a read model restored behind the directory's back, to before the last handshake, is told apart from the one it knew (`admin.search.status` says `protocol.restore_token`: `mismatch`). The first one, after a deploy recorded the restore floor, starts the token; one interrupted is finished by the next. Best effort: a restore to after the last handshake keeps its token. Refused (409 `restore_token_mismatch`) when the read model holds a token the directory does not know, nothing changed: recover the read model before anything writes it again. Allowed while the deployment's read model maintenance holds other writes back. Instance administrators only.",
  input: z.object({}),
  output: z.object({ restore_token: z.literal("matched") }),
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  duringMaintenance: true,
  mcp: false,
});

const Generation = z.coerce
  .number()
  .int()
  .min(1)
  .describe("The generation the read model is paused at (`admin.read_model.pause`).");

export const getReadModelExport = defineOperation({
  id: "admin.read_model.export",
  method: "GET",
  path: "/admin/read-model/export",
  summary: "Get the read model export's manifest",
  description:
    "Fyrden: the manifest of a coherent export of the org read model, paused at `generation`: its migrations, each table's columns in order, the protocol tables' state, and the tables left out (`derived`: the full-text indexes, rebuilt from the exported tables). Refused (409 `no_restore_floor`) until a restore floor is recorded, and (409 `export_fence_lost`) once the read model is no longer paused at `generation`: pause again and start over. Instance administrators only.",
  input: z.object({ generation: Generation }),
  output: z.object({
    generation: z.number().int(),
    derived: z.array(z.string()),
    migrations: z.array(z.string()),
    tables: z.array(z.object({ table: z.string(), columns: z.array(z.string()) })),
    protocol: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
  }),
  permission: INSTANCE_READ,
  principals: ["user"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

export const getReadModelExportPage = defineOperation({
  id: "admin.read_model.export_page",
  method: "GET",
  path: "/admin/read-model/export/pages",
  summary: "Get a page of the read model export",
  description:
    "Fyrden: a page of a coherent export of the org read model, paused at `generation`: rows of one table in key order (200 rows or 2 MiB of JSON at most; one larger row is a page of its own), from `cursor` (the first page without one). Call again with `next_cursor` until it is null; every table follows the one before. Refused as the manifest is. Instance administrators only.",
  input: z.object({
    generation: Generation,
    cursor: z.string().max(4096).optional().describe("A page's `next_cursor`."),
  }),
  output: z.object({
    table: z.string(),
    rows: z.array(z.record(z.string(), z.unknown())),
    next_cursor: z.string().nullable(),
  }),
  permission: INSTANCE_READ,
  principals: ["user"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

const RecoveryStage = z.enum([
  "preserving",
  "awaiting_restore",
  "importing",
  "fencing",
  "resuming",
  "complete",
]);
const Recovery = z.object({
  recovery_id: z.string(),
  generation: z.number().int(),
  stage: RecoveryStage,
});
const RecoveryId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .describe("The recovery's id: 1 to 64 letters, digits, _ or -, never used before.");

export const beginReadModelRecovery = defineOperation({
  id: "admin.read_model.recovery.begin",
  method: "POST",
  path: "/admin/read-model/recovery",
  summary: "Start a recovery of the read model",
  description:
    "Fyrden: starts a recovery of the org read model before restoring it (D1 Time Travel), once its writers are paused (`admin.read_model.pause` until `paused`): at the next generation, the barrier `recovering` (nothing resumes the writers until the recovery does), its operational rows to be preserved first. The one under way, when `recovery_id` is its id. Refused (409 `recovery_refused`) while the writers are not paused, while another recovery is under way, and for an id used before. Drive it with `admin.read_model.recovery.step`. Allowed while the deployment's read model maintenance holds other writes back. Instance administrators only.",
  input: z.object({ recovery_id: RecoveryId }),
  output: Recovery,
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  duringMaintenance: true,
  mcp: false,
});

export const getReadModelRecovery = defineOperation({
  id: "admin.read_model.recovery.get",
  method: "GET",
  path: "/admin/read-model/recovery",
  summary: "Get the read model's recovery",
  description:
    "Fyrden: the org read model's latest recovery (complete or not): its id, generation and stage. 404 when there never was one. Instance administrators only.",
  input: z.object({}),
  output: Recovery,
  permission: INSTANCE_READ,
  principals: ["user"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

export const stepReadModelRecovery = defineOperation({
  id: "admin.read_model.recovery.step",
  method: "POST",
  path: "/admin/read-model/recovery/step",
  summary: "Take a recovery of the read model one step on",
  description:
    "Fyrden: one bounded step of the org read model's recovery `recovery_id`, as its stage says: `preserving` (its operational rows kept, a page a step, until sealed), `awaiting_restore` (restore the read model to the bookmark you chose, apply its missing migrations, then step with `restore`: the bookmark restored to and the one that undoes it), `importing` (the operational rows made exactly as preserved), `fencing` (search readied: restored sources hidden until reconciled, those no longer active tombstoned and purged later, every active repository asked a reconciliation), `resuming` (the restore token replaced, the recovery's charges added to search's recovery spending, the writers running again); then `complete`. Call again until `complete`; a step whose answer was lost is taken again safely. Refused (409 `recovery_refused`) for another recovery's id or once the barrier left its generation, and (409 `preservation_mismatch`) when a preserved page or a table does not match what was recorded. Allowed while the deployment's read model maintenance holds other writes back. Instance administrators only.",
  input: z.object({
    recovery_id: RecoveryId,
    restore: z
      .object({ bookmark: z.string().min(1).max(200), undo_bookmark: z.string().min(1).max(200) })
      .optional(),
  }),
  output: Recovery,
  permission: INSTANCE_ADMIN,
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  duringMaintenance: true,
  mcp: false,
});
