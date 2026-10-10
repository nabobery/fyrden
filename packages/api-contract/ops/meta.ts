import { PRINCIPAL_TYPES } from "@fyrden/domain";
import { z } from "zod";
import { AUTHENTICATED, defineOperation } from "../src/op.js";

export const Whoami = z.object({
  id: z.string().describe("Principal id (usr_, org_, agt_ or ins_ prefix)."),
  type: z.enum(PRINCIPAL_TYPES),
  handle: z.string().nullable(),
  is_instance_admin: z.boolean(),
  token: z.object({
    id: z.string(),
    type: z.string(),
    scopes: z.array(z.string()),
    expires_at: z.number().int().describe("Unix time in milliseconds."),
  }),
});

export const whoami = defineOperation({
  id: "meta.whoami",
  method: "GET",
  path: "/user",
  summary: "Get the authenticated principal",
  description: "Returns the principal and token that authenticated this request.",
  input: z.object({}),
  output: Whoami,
  permission: AUTHENTICATED,
  principals: PRINCIPAL_TYPES,
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "whoami",
    title: "Who am I",
    description: "Return the user, agent or installation this connection is authenticated as.",
    readOnly: true,
  },
});
