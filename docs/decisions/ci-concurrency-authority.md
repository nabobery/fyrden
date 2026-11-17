# Keep CI concurrency ownership outside repository snapshots

Concurrency ownership lives in one `ConcurrencyDO` per repository, keyed by
repository id. `RepoDO` checks the repository's restore epoch and write gates,
then forwards acquire, status, renewal and release calls. `ConcurrencyDO` keeps
groups, receipts, leases, generations, retryable signals and their alarm jobs
in its own SQLite storage. The pure domain rules remain unchanged.

A repository restore can forget a grant that a `RunDO` still holds. Keeping the
registry in the restored repository would then allow another run into the same
group. A dedicated coordinator preserves the earlier grant across that restore.
Local Workerd tests verify this with modeled repository storage loss and an
epoch change. They also verify grant persistence across coordinator eviction.
These tests do not exercise deployed Cloudflare point-in-time recovery.

Each operation adds one internal RPC from the repository to its coordinator.
Receipts and grants commit together before the coordinator answers. Its alarm
settles expired leases and retries signals independently of repository alarms.
Repository erasure closes the coordinator before erasing runs. A permanent
coordinator tombstone rejects delayed calls after deletion.

Restoring or resetting the coordinator while runs can still execute is not
supported. Its state is operational authority, not part of a repository snapshot.
A future coordinator recovery procedure must fence existing execution before
it can discard grants. Cloudflare exposes storage restoration separately from
normal object eviction, which retains durable storage. See the
[SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

The old repository concurrency tables remain for forward schema compatibility.
They are empty when upgrading from main, where this CI implementation has not
been released. Calls refuse with `ci_concurrency_upgrade_required` if those
tables contain state from an earlier unpublished implementation. That state
must be retired deliberately before using the coordinator. Automatic migration
of active preview grants is not implemented; no grant history is silently
discarded. No production deployment or preview-state deletion is part of this
change.

Run creation first reserves the run id against one repository and spec, then
registers it in that repository, then creates the run. All three steps are
idempotent for the same spec. Erasure checks the reserved repository identity
and retains it with the run tombstone, so a stale association in another
repository cannot delete the owning repository's run.
