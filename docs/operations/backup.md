# Backing up the read model

`fyrden-org`, the org read model, holds what Fyrden derives from the
repositories (search's projections, the effects journal, webhook deliveries
and their payloads' records, failed events). Two ways keep a copy of it:

- **D1 Time Travel**, Cloudflare's own: the database at any minute of the
  last 30 days (Workers Paid; 7 days on Free), restored in place with
  `npx wrangler d1 time-travel restore fyrden-org --bookmark=<bookmark>`
  ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), read 2026-10-31).
  A restore puts back every table as it was, the protocol's own included.
- **A coherent export**, Fyrden's: every table of the read model, each
  row once, in key order, while its writers are paused, written to files
  you keep. Search's full-text indexes are not in it (they are derived from
  the projections, which are). `wrangler d1 export` cannot export
  `fyrden-org` from migration 0019 on: it holds those indexes as virtual
  tables ([D1 docs](https://developers.cloudflare.com/d1/best-practices/import-export-data/#known-limitations)).

## The restore floor

Writes to the read model are refused unless they go through its executor
from org migration 0018 on. `fyrden deploy` records the database's bookmark
once it has seen that in force (the restore floor,
`read_model_barriers.read_model_protocol_since` in `fyrden-directory`):
from that point on, every write went through the executor, so a pause can
wait for every writer. A deploy interrupted before it records the floor
records a later one the next time; an earlier one is never guessed.

Restoring `fyrden-org` to a bookmark from before the floor is not
supported: it brings back a database whose writes outside the executor were
only counted, under a protocol older than the code's (Time Travel restores
in place only; it cannot copy a point in time into a new database yet).

`GET /api/admin/search/status` shows the floor (`protocol.restore_floor`)
and whether an export can be made (`export.available`, with
`no_restore_floor` until the floor is recorded).

## The restore token

The read model holds a token the directory records
(`read_model_barriers.token_completed`), so a read model restored behind
the directory's back, to before the last handshake, is told apart from the
one it knew. Start it once the floor is recorded, and replace it whenever
you like (each handshake makes an earlier restore detectable):

```sh
FYRDEN_TOKEN=<an instance administrator's token> \
  node packages/cli/src/index.ts read-model handshake \
  --url https://fyrden-api.<account>.workers.dev
```

A handshake records its intent in the directory, writes the next token in
the read model (only over the one it holds) and records it completed; one
interrupted is finished by the next. The status shows where it stands
(`protocol.restore_token`): `uninitialized` until the first, `matched`,
`intent` while one is under way, or `mismatch` when the read model holds a
token the directory does not know, which a handshake then refuses (409
`restore_token_mismatch`): recover the read model before anything writes
it again. It is best effort: a restore to after the last handshake keeps
its token, and goes unseen.

## Exporting

As an instance administrator, with the API's URL (its workers.dev URL or
custom domain):

```sh
FYRDEN_TOKEN=<an instance administrator's token> \
  node packages/cli/src/index.ts read-model export \
  --url https://fyrden-api.<account>.workers.dev --out backups/2026-10-31
```

The command:

1. Pauses the read model's writers (`POST /api/admin/read-model/pause`, step
   by step): the barrier moves to the next generation, so no lease is taken
   and no batch of an older generation is admitted, and the pause is done
   once no older lease is live (a lease lasts at most 15 minutes; the
   command waits up to 16). Work that would write meanwhile is refused, and
   retried by its queue or its next run.
2. Writes the manifest (`GET /api/admin/read-model/export`): the
   migrations, each table's columns in order, the protocol tables' state.
3. Writes each table as `<table>.jsonl`, a JSON object a row, from pages of
   200 rows or 2 MiB (`GET /api/admin/read-model/export/pages`), every page
   read under the pause's generation: if the barrier moves (someone resumes
   the writers), the next page is refused and the export stops; run it again
   into a new directory.
4. Writes `manifest.json`: the manifest, when it was taken, and each file's
   rows and SHA-256.
5. Resumes the writers, unless `--keep-paused` (for a restore that follows;
   resume them with `POST /api/admin/read-model/resume`). It resumes only its
   own pause (`{ "generation": … }`), whether the export finished or failed:
   a newer pause someone else made stands, and the command says so.

The directory must not exist yet. The export reads the whole database, a
row at a time as D1 counts reads, within the API's read rate limit (a page
refused for it is asked again after 30 seconds).

Pausing and resuming work while the deployment's read model maintenance is
on (`fyrden deploy --read-model-maintenance on`), which holds every other
write back.

Restoring from an export (importing it into a database) is not built yet:
keep the files, and use Time Travel to restore.

## Recovering after a restore

Restoring `fyrden-org` with Time Travel rolls back everything in it,
including what must not go back: effects already delivered, webhook
deliveries and their attempts, the sources' fences and the spending of
search's and the discretionary allowances. A recovery keeps those across
the restore, and readies search for what it brings back. With an instance
administrator's token, against the API:

1. Pause the writers (`POST /api/admin/read-model/pause` until `paused`),
   and start a recovery with an id of your choosing, never used before:
   `POST /api/admin/read-model/recovery` with `{ "recovery_id": … }`. The
   barrier moves to the next generation and to `recovering`: nothing
   resumes the writers until the recovery does.
2. Step it (`POST /api/admin/read-model/recovery/step` with
   `{ "recovery_id": … }`) until its stage is `awaiting_restore`: its
   operational rows are preserved a page at a time, each digested into
   `fyrden-assets` under `read-model-recovery/<recovery>/`, then sealed.
3. Restore the read model to the bookmark you chose (one from after the
   restore floor), keep the bookmark that undoes it, and apply the
   migrations the restored database lacks.
4. Report the restore: a step with `{ "recovery_id": …, "restore":
   { "bookmark": …, "undo_bookmark": … } }`. The restored read model's
   barrier is brought to the recovery's generation, paused.
5. Step it on until `complete`: the operational rows are made exactly as
   preserved (`importing`), search is readied (`fencing`: every restored
   repository hidden until a reconciliation of it ends, those the directory
   no longer has active tombstoned and their search rows purged later,
   every active repository asked a reconciliation), and the writers resume
   (`resuming`: the restore token taken over from the restored database and
   replaced, the recovery's charges added to search's recovery spending).

A step whose answer was lost is taken again safely; `GET
/api/admin/read-model/recovery` and `GET /api/admin/search/status`
(`recovery`) say where it stands. A preserved page that no longer matches
its digest, or a table whose columns changed since it was preserved (a
migration that altered it), is refused (409 `preservation_mismatch`): such a
restore cannot be recovered in place.
