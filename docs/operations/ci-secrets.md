# Operating CI secrets

Actions secrets (repository and organization secrets that workflows read as
`secrets.NAME`) are stored encrypted in each account's Durable Object. They
are protected by one Worker secret on `fyrden-api`, `CI_SECRETS_KEY`
(32 random bytes, base64). `fyrden deploy` creates it the first time and
never shows it (Cloudflare never shows a secret's value either);
`fyrden doctor` warns when it is missing.

## What the key protects

There are three layers of keys:

- **The master key**, `CI_SECRETS_KEY`. It never encrypts a secret itself.
  Two keys are derived from it: one that encrypts account data keys, and
  one that encrypts the masks Fyrden keeps while a job runs, so that a
  delivered secret is replaced by `***` in its logs.
- **One data key per account**, made at random when the account's first
  secret is written. It is stored encrypted under the master key. A data
  key belongs to a *generation*: a new generation gets a new data key.
- **Keys derived from the data key**: the key each secret's value is
  encrypted with, and a public key for each repository and for the
  organization. Clients such as `gh secret set` fetch that public key
  (`GET …/actions/secrets/public-key`) and encrypt a value for it before
  sending it, so the value never travels as plain text. These keys are
  derived again whenever they are needed and are never stored.

Each encrypted value is bound to its account, scope (repository or
organization), name and generation, so a copied ciphertext does not open
anywhere else.

## Setting the key

`fyrden deploy` makes the key when `fyrden-api` has none and keeps it on
every later deploy. To set it by hand, make one with
`openssl rand -base64 32` and set it with
`wrangler secret put CI_SECRETS_KEY`. Keep a copy somewhere safe: without
it, stored secrets cannot be opened.

## Rotating the key

Rotating the master key encrypts each account's data key again under the
new master key. The secrets themselves are not encrypted again, and no one
needs to set their secrets again.

1. Make a new key and keep it: `openssl rand -base64 32`.
2. Add the new key to `CI_SECRETS_KEYS_RETIRED` (base64 keys, one per
   line; keep any lines already there). A key is identified by its bytes,
   so once every object has this version, each one can open what the new
   key will encrypt, while nothing is encrypted with it yet. Wait until the
   version with it serves all traffic, plus 5 minutes: a Durable Object
   that is busy at a deployment keeps running its old code for up to that
   long (Cloudflare's default code update delay, which Fyrden does not
   change; verified:
   [Durable Objects code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/)).
   Without this step, an account object could encrypt a data key under the
   new key while a run object still on the old version, which cannot open
   it, delivers that account's secrets, and the job would fail with
   `secrets_unavailable`.
3. Set the same new key as `CI_SECRETS_KEY_NEXT` on `fyrden-api`
   (`wrangler secret put CI_SECRETS_KEY_NEXT`). From then on new data keys
   are encrypted with it, and `CI_SECRETS_KEY` still opens the others. The
   key is in both `CI_SECRETS_KEYS_RETIRED` and `CI_SECRETS_KEY_NEXT` now,
   which works: it opens once and encrypts as `_NEXT`.
4. Encrypt every data key again with it: call
   `POST /api/admin/ci/secrets/rewrap` as an instance administrator,
   starting with no `cursor` and passing the `next_cursor` it answers as
   `cursor`, until `next_cursor` is null. That is one sweep over every
   account. Add up `remaining` and `unreadable` over **all** the sweep's
   calls: a call's counts are only for the 25 accounts it visited, so a
   last call with `remaining` 0 says nothing about earlier ones. Repeat
   whole sweeps until one adds up to `remaining` 0. An account object
   still running a version from before `CI_SECRETS_KEY_NEXT` was set (a
   busy Durable Object keeps its old code for a while after a deployment)
   wraps nothing and counts all its data keys as `remaining`. `remaining` counts
   data keys still under another key that open (one
   changed by a concurrent write is tried again three times, then left for
   the next sweep). `unreadable` counts data keys whose master key is
   already gone (see below); check that total too before retiring a key. The call answers 503
   `ci_key_unavailable` while the key is missing or misconfigured. A secret
   write also encrypts its account's data key again. An object still on the
   old code that has no data key yet counts nothing, and can make its first
   one under the old key after its page has passed. So the sweep that
   counts is one started after the cutoff of step 5 (the version that set
   `CI_SECRETS_KEY_NEXT` serving all traffic, plus 5 minutes), while the old
   key still opens: run a whole sweep then, and go on only if it adds up to
   `remaining` 0.
5. If you kept the old key's value, add it to `CI_SECRETS_KEYS_RETIRED`
   (base64 keys, one per line) **before** the next step, and keep it there
   for at least 30 days. Jobs that were already running when you set
   `CI_SECRETS_KEY_NEXT` keep their log masks encrypted under the old key
   until their logs close, so the old key must stay readable. If you don't
   have the old key's value, wait instead. Take as the cutoff the moment
   the version that set `CI_SECRETS_KEY_NEXT` serves all traffic plus
   5 minutes: a busy Durable Object can still assign jobs under the old key
   for up to that long, the code update delay of step 2. Then wait until
   every job assigned before the cutoff has finished, and
   10 more minutes, the time a finished job's runner may still upload its
   log.
6. Set the same new key as `CI_SECRETS_KEY`, then delete
   `CI_SECRETS_KEY_NEXT` (`wrangler secret delete CI_SECRETS_KEY_NEXT`).
   You may then remove the new key's line from `CI_SECRETS_KEYS_RETIRED`:
   as `CI_SECRETS_KEY` it opens and encrypts. Leave the old key's line.

Keys in `CI_SECRETS_KEYS_RETIRED` only open, never encrypt. Keep the old
key for at least 30 days because Durable Object point-in-time recovery can
restore an account's storage as it was up to 30 days ago (verified:
[SQLite storage API, PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)),
and a restored data key is still encrypted under the old master key.
A key `fyrden deploy` made was never shown, so its value cannot be kept
this way: an account restored to a point before such a rotation is in the
situation of [a lost key](#restoring-after-a-lost-key) until its secrets
are set again. To keep that option, make each new key yourself (step 1) and
store a copy.

Never remove a retired key while any data key still uses it. The rewrap
call's `remaining` count says how many still do; remove the key only after
a pass reports `remaining` 0 and `unreadable` 0, and after the 30 days. The
one exception is the line of a key that is also `CI_SECRETS_KEY` (step 6):
it still opens as the current key. A generation retired by
[a replacement](#a-compromised-account-data-key) holds no key any more and
is counted in neither total. An account object still running a version from
before replacement existed counts a retired generation as `unreadable`, so
only a sweep started after such a version has left (the 5 minutes of step 2)
shows a clean total.

If `CI_SECRETS_KEY` or `CI_SECRETS_KEY_NEXT` is set but is not a 32-byte
base64 key (for example an empty `CI_SECRETS_KEY_NEXT`, or a value that is
not text), Fyrden encrypts nothing until it is fixed: secret writes fail,
while secrets already stored still open with the keys that are readable.
`CI_SECRETS_KEYS_RETIRED` must be text with one key per line; a line that
is not a key, or a value that is not text, is ignored. The rewrap call's
`unreadable` count shows any data key whose master key is no longer
readable.

## Restoring after a lost key

There is no other copy of `CI_SECRETS_KEY`. If the key that encrypted one
of an account's data keys is lost (deleted, or replaced without the
rotation above), the secrets of that data key's generation cannot be
opened; secrets of the account's other generations are unaffected:

- A job that uses one of them fails with `secrets_unavailable`.
- The rewrap call counts that data key as `unreadable`.
- Those secrets are listed with `unreadable: true`.

To recover, set a new `CI_SECRETS_KEY` if there is none. When the
account's newest generation is the unreadable one, the next request for
the account's public key (which `gh secret set` makes) starts a new
generation with a new data key, under the new master key, and serves its
public key; when the newest generation is still readable, the public key
is that generation's. Set each affected secret again (or delete it); until then it
stays `unreadable`. Nothing else about the account changes.

If the old key turns up, put it in `CI_SECRETS_KEYS_RETIRED`: every secret
of the old generation that was not set again opens again, because each
secret records the generation it belongs to. A generation retired by
[a replacement](#a-compromised-account-data-key) is the exception: its data
key was erased, so no key reopens it.

## A compromised account data key

Rotating the master key does not help when an account's data key may have
been exposed: rewrapping encrypts the same data key again, and the keys
derived from it stay the same. The account needs a new data key
generation, and every one of its secrets set again with a **new** value.

**First, decide what leaked.** Replacing an account's data key is enough
only when the account's stored data leaked without the master key, and the
deployment itself was not compromised. If the master key leaked too (for
example, a copy of the account's Durable Object storage together with
`CI_SECRETS_KEY`), or the deployment or a runner host was compromised,
contain that access first and [rotate the master key](#rotating-the-key):
the new generation is wrapped under the current master key, so whoever holds
that key could open the new values as well. Then assess the other accounts,
and replace each exposed account's data key as below.

To replace an account's data key (instance administrators):

1. Read its status:
   `GET /api/admin/accounts/{account}/ci/data-key`. It answers the
   account's id (`account_id`), its newest generation (`generation`), how
   many secrets it holds and how many do not open (`unreadable_secrets`),
   with the first 100 of those by scope (`org` or a repository id) and
   name. A suspended account is found.
2. Replace it:
   `POST /api/admin/accounts/{account}/ci/data-key/replace` with
   `{"account_id": "<account_id>", "generation": <generation>}`. It makes a
   new generation and retires the one named and every older one: their
   wrapped data keys are erased. This cannot be undone, except by restoring
   the account's storage to before it. From then on:
   - the old secrets are listed with `unreadable: true` and are never sent
     to a job; a job that uses one fails with `secrets_unavailable` until it
     is set again;
   - a value sealed for the old public key is refused (`bad_key_id`); `gh`
     reads the new public key on its next `gh secret set`;
   - variables are not changed.

   A job whose secrets were read before the replacement got the old values,
   which is one reason the credentials must change (step 4).
   - 409 `generation_changed`: the named generation is not the newest (for
     example a lost key made a new one meanwhile). Read the status again and
     replace the newest; that retires the older ones too, so the exposed one
     cannot reopen if its master key comes back. Any secret set under the
     newer generation in between must be set again too.
   - 409 `account_changed`: the handle now belongs to another account. Find
     the account again; do not replace that one.
   - 409 `idempotent_outcome_unknown`: send the same body again with a new
     `Idempotency-Key` (or none). Naming a generation already replaced
     answers that replacement again and changes nothing, so a retry is safe.
   - 503 `ci_key_unavailable`: the CI master key is missing or misconfigured;
     fix it and send the request again.
3. Read the status again: `generation` must now be greater than the one you
   replaced.
4. For each secret: revoke the exposed credential where it was issued, make
   a new one, and set the **new** value (`gh secret set`). Setting the old
   value again only makes it readable, it does not make it safe; and
   revoking it at its provider after setting it again leaves Fyrden with a
   dead credential.
5. Done when the status shows a generation past the one replaced, every
   exposed credential is revoked and replaced, and `unreadable_secrets` is 0
   (or the remaining secrets are deleted).

To see which jobs were given which secrets, read the delivery audit. Each
assignment that delivers secrets writes one `ci.secrets.deliver` row to the
directory's `audit_log`, in the same batch that records the task, before
the runner gets anything: its `target_id` is the account id and its
`details` name the repository, run, job and task, and each secret's scope
(`org` or a repository id), name and data key generation, never a value.

```sh
npx wrangler d1 execute fyrden-directory --remote --command \
  "SELECT at, details FROM audit_log WHERE action = 'ci.secrets.deliver' AND target_id = '<account_id>' ORDER BY seq"
```

Rows are archived to R2 and leave D1 7 days after archiving: older ones
are in the `fyrden-assets` bucket under `audit/instance/<yyyy>/<mm>/<dd>/directory-…`
(one NDJSON row per line), not under the account's own audit prefix. A row
says a job **may** have received a secret (an assignment recorded and then
refused still has one). A secret with no row was still exposed to whoever
holds the old data key: change every credential of a replaced generation,
not only the delivered ones.

What the replacement does not remove:

- Point-in-time recovery can restore the account's storage as it was up to
  30 days before, retired data key included. After any such restore,
  replace again with a new `Idempotency-Key` (or none), and check with the
  status call: an answer from before the restore proves nothing about the
  restored storage, and repeating the same request with the same token and
  key replays its saved answer, replacing nothing, until the key expires
  (24 hours after the original request started).
- Each old secret's ciphertext stays stored until the secret is set again or
  deleted. Whoever already holds the old data key can still open a copy of
  it; only changing the credential protects it.
- Variables are stored as plain text: a leak of the account's storage
  exposed them too. Change any that matter.
