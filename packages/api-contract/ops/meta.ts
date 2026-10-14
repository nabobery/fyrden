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

export const listSigningKeys = defineOperation({
  id: "meta.signing_keys.list",
  method: "GET",
  path: "/meta/signing-keys",
  summary: "List the platform's signing keys",
  description:
    "The public keys Fyrden signs the commits it makes with (file writes, generated repositories), as SSH public key lines: the current one, and retired ones commits may still carry. Check such a commit with `git verify-commit` (`gpg.format = ssh`) and these keys in an allowed-signers file.",
  input: z.object({}),
  output: z.object({
    keys: z.array(
      z.object({
        key_id: z.string().describe("The key's SHA-256 fingerprint, as ssh-keygen shows it."),
        key: z.string().describe("The public key line (`ssh-ed25519 AAAA...`)."),
        current: z.boolean().describe("Whether new commits are signed with it."),
      }),
    ),
  }),
  permission: AUTHENTICATED,
  principals: PRINCIPAL_TYPES,
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_signing_keys",
    title: "List the platform's signing keys",
    description: "List the public keys Fyrden signs the commits it makes with.",
    readOnly: true,
  },
});
