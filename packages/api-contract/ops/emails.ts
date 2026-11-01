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
  deliverable: z
    .boolean()
    .describe(
      "False while the email provider suppresses the mailbox (it bounced, or its owner marked Fyrden's mail as spam): nothing is sent to it until the suppression is removed at the provider. Not a promise of delivery. A Fyrden extension.",
    ),
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
  description: `Adds notification addresses (at most ${MAX_ADDRESSES} in all; 422 \`too_many_emails\`), each sent a link to confirm it (good for a day). One already yours is kept as it is. A user is sent at most 5 confirmation emails an hour and a mailbox at most 3 a day, whoever asks (429 \`confirmation_rate_limited\`, nothing added). A mailbox the email provider suppresses: 422 \`email_undeliverable\`, nothing added. An address is added even when its confirmation could not be sent now; asking for a new link says why. While the deployment sends no email: 503 \`email_unavailable\`. Web sessions only.`,
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
    "Sends a new link to confirm an unverified address of yours (earlier links stop working), under the same limits as adding one. 404 `email_not_found` for an address not yours, removed or already verified; 422 `email_undeliverable` for a mailbox the email provider suppresses; 503 `email_unavailable` with `Retry-After` when it could not be sent now (the deployment's allowance or the provider's rate limit spent; the new link stays the current one). Web sessions only. A Fyrden extension.",
  input: z.object({ email: Address }),
  output: NoContent,
  permission: "emails:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 204,
  mcp: false,
});

export const NotificationSettings = z.object({
  email: z.object({
    direct: z
      .boolean()
      .describe(
        "What asks something of you: review requests (yours or your team's), assignments, mentions, your own issues and pull requests closed, reopened, merged or in conflict. On unless set.",
      ),
    participating: z
      .boolean()
      .describe("Activity on threads you take part in or subscribed to. Off unless set."),
    watching: z
      .boolean()
      .describe("Activity in repositories you watch. Off unless set. Saved, but not sent yet."),
  }),
});

export const getNotificationSettings = defineOperation({
  id: "users.notification_settings.get",
  method: "GET",
  path: "/user/notification-settings",
  summary: "Get your notification settings",
  description:
    "Which notification email Fyrden sends you, by category (Fyrden's defaults until you set them). Web sessions only (any other credential: 403). A Fyrden extension.",
  input: z.object({}),
  output: NotificationSettings,
  permission: "emails:read",
  principals: ["user"],
  rateLimit: "read",
  idempotency: "none",
  mcp: false,
});

export const setNotificationSettings = defineOperation({
  id: "users.notification_settings.put",
  method: "PUT",
  path: "/user/notification-settings",
  summary: "Set your notification settings",
  description:
    "Sets the categories given (the others keep theirs); the last write wins. Web sessions only. A Fyrden extension.",
  input: z.object({
    email: z
      .object({
        direct: z.boolean().optional(),
        participating: z.boolean().optional(),
        watching: z.boolean().optional(),
      })
      .strict(),
  }),
  output: NotificationSettings,
  permission: "emails:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: false,
});
