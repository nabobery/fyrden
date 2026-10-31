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
    "Fyrden: the manifest of a coherent export of the org read model, paused at `generation`: its migrations, each table's columns in order, and the protocol tables' state. Refused (409 `no_restore_floor`) until a restore floor is recorded, and (409 `export_fence_lost`) once the read model is no longer paused at `generation`: pause again and start over. Instance administrators only.",
  input: z.object({ generation: Generation }),
  output: z.object({
    generation: z.number().int(),
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
