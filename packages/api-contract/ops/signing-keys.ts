import { z } from "zod";
import { defineOperation } from "../src/op.js";

export const SshSigningKey = z.object({
  id: z.string().describe("The key's id (key_ prefix)."),
  title: z.string(),
  key: z.string().describe("The public key line (`ssh-ed25519 AAAA...`), without its comment."),
  fingerprint: z.string().describe("Its SHA-256 fingerprint, as ssh-keygen shows it."),
  created_at: z.number().int().describe("Unix time in milliseconds."),
});

const KeyId = z
  .string()
  .regex(/^key_[0-9A-HJKMNP-TV-Z]{26}$/)
  .describe("The key's id.");

export const listSshSigningKeys = defineOperation({
  id: "users.ssh_signing_keys.list",
  method: "GET",
  path: "/user/ssh_signing_keys",
  summary: "List your SSH signing keys",
  description:
    "The SSH keys the authenticated user (or an agent, with its own token) signs commits with, oldest first.",
  input: z.object({
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(200).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({
    keys: z.array(SshSigningKey),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page; null on the last page."),
  }),
  permission: "ssh_signing_keys:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_ssh_signing_keys",
    title: "List your SSH signing keys",
    description: "List the SSH keys you sign commits with.",
    readOnly: true,
  },
});

export const createSshSigningKey = defineOperation({
  id: "users.ssh_signing_keys.create",
  method: "POST",
  path: "/user/ssh_signing_keys",
  summary: "Add an SSH signing key",
  description:
    "Adds an Ed25519 SSH public key the authenticated user signs commits with (`gpg.format = ssh`). A commit with a valid signature by it is verified when its committer email is the user's no-reply address (`<user id>@users.noreply.<host>`). An agent adds its own with its own token (its commits then use `<agent id>@users.noreply.<host>`); acting for a user under a grant it adds none. A key belongs to one principal: one already added answers 422 `key_in_use`.",
  input: z.object({
    title: z.string().min(1).max(100).describe("A name for the key."),
    key: z
      .string()
      .min(1)
      .max(1024)
      .describe("The public key line (`ssh-ed25519 AAAA... [comment]`)."),
  }),
  output: SshSigningKey,
  permission: "ssh_signing_keys:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "create_ssh_signing_key",
    title: "Add an SSH signing key",
    description: "Add an Ed25519 SSH key you sign commits with.",
    readOnly: false,
  },
});

export const getSshSigningKey = defineOperation({
  id: "users.ssh_signing_keys.get",
  method: "GET",
  path: "/user/ssh_signing_keys/{key_id}",
  summary: "Get an SSH signing key",
  description: "One of the authenticated user's (or agent's) SSH signing keys.",
  input: z.object({ key_id: KeyId }),
  output: SshSigningKey,
  permission: "ssh_signing_keys:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_ssh_signing_key",
    title: "Get an SSH signing key",
    description: "Get one of your SSH signing keys.",
    readOnly: true,
  },
});

export const deleteSshSigningKey = defineOperation({
  id: "users.ssh_signing_keys.delete",
  method: "DELETE",
  path: "/user/ssh_signing_keys/{key_id}",
  summary: "Delete an SSH signing key",
  description:
    "Removes one of the authenticated user's (or agent's) SSH signing keys; commits it signed are no longer verified.",
  input: z.object({ key_id: KeyId }),
  output: z.object({ id: z.string(), state: z.literal("deleted") }),
  permission: "ssh_signing_keys:write",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "delete_ssh_signing_key",
    title: "Delete an SSH signing key",
    description: "Remove one of your SSH signing keys.",
    readOnly: false,
  },
});
