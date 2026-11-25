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

## Receiving CI events

`status`, `check_run`, `workflow_run` and `workflow_job` follow commit
statuses and CI runs. Their fields, and GitHub's that are left out, are in
[limits.md](limits.md#webhooks). A receiver:

1. Verifies `webhook-signature` (Standard Webhooks, with the hook's secret)
   over the raw body before it reads it.
2. Drops a `webhook-id` it has seen: retries and redeliveries keep it.
3. Expects any order. `position` (`epoch`, then `sequence`) orders a
   repository's events. The action `completed` is final for its run attempt
   or job: another event of the same one is late. A `status` of `completed`
   is not: a run held for approval shows it in its `requested`, and may go
   on. A re-run is another `run_attempt`.
4. Reads the rest from the API (`GET …/actions/runs/{run_id}`, its `/jobs`,
   `…/commits/{ref}/check-runs`) when it needs every state: in-between
   events may be merged, and on Workers Free a large matrix sends only some.

What identifies one thing happening, across deliveries of it to several
hooks:

| Event | Key |
|---|---|
| `status` | `position.epoch`, `id` |
| `check_run` | `head_sha`, `name`, `attempt`, `action` |
| `workflow_run` | `id`, `run_attempt`, `action` |
| `workflow_job` | `run_id`, `id`, `action` |

Each is sent once. The exception is a repository object restored from a
backup (a new `position.epoch`): what happened since the backup may be sent
again, and a run whose record the restore removed sends nothing until its
weekly check registers it. Take a new epoch as the sign to read the state
again. The promise ends with a run's retention: a run whose reports failed
all that time sends what is owed once more and is then retired, counted in
`ci.run_retired_owed` ([metrics.md](metrics.md)) if that fails too.

A run's own events, the bodies shortened to what differs from other events:

```json
{"event":"workflow_run","action":"completed",
 "workflow_run":{"id":"01J…","run_number":4,"name":"CI","run_attempt":1,
  "head_branch":"main","head_sha":"9f…","event":"push","status":"completed",
  "conclusion":"failure"}}
{"event":"workflow_job","action":"completed",
 "workflow_job":{"id":1,"run_id":"01J…","run_attempt":1,"name":"build",
  "job_key":"build","status":"completed","conclusion":"failure"}}
{"event":"check_run","action":"completed",
 "check_run":{"name":"build","head_sha":"9f…","attempt":1,
  "status":"completed","conclusion":"failure",
  "run":{"id":"01J…","run_attempt":1,"job_id":1}}}
{"event":"status","id":12,"sha":"9f…","context":"ext/build","state":"failure"}
```

Names and titles in them are text that whoever wrote the workflow chose, a
fork's pull request included: never run them, and escape them where shown.
A receiver that posts a status on a `status` event answers itself: skip
events whose `sender` is the receiver's own account. Nothing here starts a
workflow on any of these events.
