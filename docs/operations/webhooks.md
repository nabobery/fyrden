# Operating webhooks

Webhook signing secrets are made by the server, shown once, and stored
sealed (AES-256-GCM, bound to the repository, the hook and the key) in the
repository's Durable Object. The key is the Worker secret `WEBHOOKS_KEY`
(32 random bytes, base64). `fyrden deploy` creates it the first time and
never shows it (Cloudflare never shows a secret's value either);
`fyrden doctor` warns when it is missing.

## Rotating the key

The current key's value cannot be read back, so a rotation brings in the
new key beside it, seals every secret with the new one while the old one
still opens them, and only then replaces the old one:

1. Make a new key and keep it: `openssl rand -base64 32`.
2. Set it as `WEBHOOKS_KEY_NEXT` on `fyrden-api`
   (`wrangler secret put WEBHOOKS_KEY_NEXT`). From then on new secrets are
   sealed with it, and `WEBHOOKS_KEY` still opens the others.
3. Seal every secret again with it: call
   `POST /api/admin/webhooks/reseal` as an instance administrator, passing
   the `next_cursor` it answers as `cursor`, until a pass ends with
   `next_cursor` null, `remaining` 0 and `unreadable` 0. (A delivery attempt
   also seals its hook's secrets again as it reads them.)
4. Set the same new key as `WEBHOOKS_KEY`, then delete
   `WEBHOOKS_KEY_NEXT` (`wrangler secret delete WEBHOOKS_KEY_NEXT`).

Rotating the key does not change any hook's signing secret: receivers need
no change. A hook's signing secret is rotated with
`POST /repos/{owner}/{repo}/hooks/{id}/secret` (both secrets sign for a
week, or until `DELETE …/secret/previous`).

`WEBHOOKS_KEYS_RETIRED` (base64 keys, one per line) holds keys that only
open secrets, never seal: for restoring a Durable Object backup taken
under a key you kept.

## Restoring after a lost key

There is no other copy of `WEBHOOKS_KEY`. If it is lost (deleted, or
replaced without the rotation above), the sealed secrets cannot be opened:
deliveries fail with `secret_unavailable`, and the reseal operation counts
them as `unreadable`. Set a new `WEBHOOKS_KEY`, then rotate each affected
hook's secret (`POST …/hooks/{id}/secret`) and give the new secret to its
receiver. Restoring a Durable Object backup needs the key that was current
when the backup was taken (in `WEBHOOKS_KEYS_RETIRED`, if you kept it).
