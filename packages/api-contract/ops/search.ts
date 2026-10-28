import { z } from "zod";
import { defineOperation, INSTANCE_ADMIN } from "../src/op.js";

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
