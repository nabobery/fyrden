import { z } from "zod";
import { defineOperation, NoContent } from "../src/op.js";

/*
 * A user's notification addresses: GitHub's `/user/emails` shapes, managed
 * from a web session only (account security: no token, OAuth client or
 * agent manages them; an unrestricted personal access token is the user's
 * full authority and can start a session). Deviations from GitHub: no
 * pagination; `visibility` is always null; `primary` is the address
 * notifications go to (the earliest verified); an address is verified on
 * one account at a time, decided when it is confirmed.
 */

const MAX_ADDRESSES = 10;

export const UserEmail = z.object({
  email: z.string(),
  primary: z
    .boolean()
    .describe("The address notifications go to: the earliest one verified (Fyrden's meaning)."),
  verified: z.boolean(),
  visibility: z.null().describe("Always null: Fyrden shows no address publicly."),
});

const Address = z.string().min(3).max(254);

export const listUserEmails = defineOperation({
  id: "users.emails.list",
  method: "GET",
  path: "/user/emails",
  summary: "List your email addresses",
  description: `Your notification addresses (at most ${MAX_ADDRESSES}), verified or not. Web sessions only (any other credential: 403).`,
  input: z.object({}),
  output: z.array(UserEmail),
  permission: "emails:read",
  principals: ["user"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

export const addUserEmails = defineOperation({
  id: "users.emails.add",
  method: "POST",
  path: "/user/emails",
  summary: "Add email addresses",
  description: `Adds notification addresses (at most ${MAX_ADDRESSES} in all; 422 \`too_many_emails\`), each sent a link to confirm it (good for a day). One already yours is kept as it is. A user is sent at most 5 confirmation emails an hour and a mailbox at most 3 a day, whoever asks (429 \`confirmation_rate_limited\`, nothing added). While the deployment sends no email: 503 \`email_unavailable\`. Web sessions only.`,
  input: z.object({ emails: z.array(Address).min(1).max(MAX_ADDRESSES) }),
  output: z.array(UserEmail),
  permission: "emails:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: false,
});

export const deleteUserEmails = defineOperation({
  id: "users.emails.delete",
  method: "DELETE",
  path: "/user/emails",
  summary: "Remove email addresses",
  description:
    "Removes notification addresses of yours (one not yours, or already removed, changes nothing); their confirmation links stop working. Web sessions only.",
  input: z.object({ emails: z.array(Address).min(1).max(MAX_ADDRESSES) }),
  output: NoContent,
  permission: "emails:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 204,
  mcp: false,
});

export const confirmUserEmail = defineOperation({
  id: "users.emails.confirm",
  method: "POST",
  path: "/user/emails/confirm",
  summary: "Confirm an email address",
  description:
    "Confirms one of your addresses with the token its link carried (once, within a day, by the account that added it). 404 `confirmation_not_found` for a token unknown, used, expired, of another account or of an address removed; 409 `email_taken` when another account has confirmed the mailbox first (the token is used up). Web sessions only. A Fyrden extension.",
  input: z.object({ token: z.string().min(1).max(100) }),
  output: UserEmail,
  permission: "emails:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: false,
});

export const requestUserEmailConfirmation = defineOperation({
  id: "users.emails.confirmation",
  method: "POST",
  path: "/user/emails/confirmation",
  summary: "Send a new confirmation link",
  description:
    "Sends a new link to confirm an unverified address of yours (earlier links stop working), under the same limits as adding one. 404 `email_not_found` for an address not yours, removed or already verified. Web sessions only. A Fyrden extension.",
  input: z.object({ email: Address }),
  output: NoContent,
  permission: "emails:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 204,
  mcp: false,
});
