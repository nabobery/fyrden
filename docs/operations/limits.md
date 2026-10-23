# Limits

What a Fyrden deployment accepts and serves for git, why, and which limits an
operator can change. Engine metrics are described in [metrics.md](metrics.md).

Every number on this page is one of three kinds:

- **Platform limit:** set by Cloudflare. Linked to Cloudflare's documentation;
  it can change without a Fyrden release.
- **Measured:** observed by the Fyrden project on a real deployment, with the
  date and plan. Paid-plan measurements have not been made yet unless stated.
- **Default:** a Fyrden setting chosen as a starting point. Defaults may change
  in later releases as they are tuned under load. Those with a variable can be
  set per deployment (see [Configuration variables](#configuration-variables)).

## Push

### Request body limit

Cloudflare refuses a request whose body is larger than the zone plan allows,
before the Worker runs, with its own HTTP 413 page. Fyrden cannot change that
answer or show a better message.

| Cloudflare plan of the hostname | Request body limit |
|---|---|
| Free, Pro (and `*.workers.dev`) | 100 MB ([platform limit](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits)). **Measured** on 2026-10-10 on Workers Free, `workers.dev`: exactly 104,857,600 bytes (100 MiB) accepted, 104,857,601 refused, both with and without `Content-Length` |
| Business | 200 MB ([platform limit](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits)); not measured |
| Enterprise | Up to 5 GB, set on the zone ([platform limit](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits)); not measured |

A push is one request, so a stock `git push` whose request is larger than the
limit fails with an HTTP 413 error. No refs change and nothing is stored,
because Fyrden never saw the request.

Use `fyrden push` instead of `git push` for large pushes:

- `fyrden push <remote> <refspec...>` builds the pack git would send, checks its
  size first and, when it fits, runs `git push`. When it does not fit, it stops
  and names the limit and `fyrden push --chunked`.
- `fyrden push --chunked <remote> <refspec...>` uploads the pack in parts
  through an upload session (each part one request under the limit, retried on
  failure), then completes the session, which checks and commits it exactly as
  a push.
- Both forms talk to the remote's push URL (`remote.<name>.pushurl`, else its
  `url`), as `git push` does; a remote with several push URLs is refused, so
  name the URL instead. The token is `FYRDEN_TOKEN`, else the password in
  the push URL, else what git's credential helpers have for it. A token the
  CLI holds reaches its own `git` calls through a helper set for that one
  call, never in a URL or on the command line.
- The CLI assumes 104,857,600 bytes. On a Business or Enterprise zone, pass
  `--body-limit <bytes>` or set `FYRDEN_PUSH_BODY_LIMIT`, and raise
  `GIT_PUSH_MAX_BODY_BYTES` on the server to match.

The server's own check, `GIT_PUSH_MAX_BODY_BYTES` (default 104,857,600), refuses
a larger push with a git error message rather than a 413, for bodies the edge
let through.

How a push body is stored is the same on every plan: the Worker writes the
request body to R2 with one upload, and the repository's Durable Object reads,
checks and indexes it from there. An uncompressed body with a
`Content-Length` (what git sends behind Cloudflare's edge) is streamed to R2
as it arrives: the Worker runs no code per chunk. Two kinds of body are read
into the Worker's memory first, since their length is known only at the end:

- **Compressed bodies** (`Content-Encoding: gzip`; JGit and EGit compress
  every push, git never does). The Worker inflates the body and holds the
  inflated bytes, inside an isolate's 128 MB of memory
  ([platform limit](https://developers.cloudflare.com/workers/platform/limits/#memory)),
  so their limit is lower: `GIT_PUSH_MAX_GZIP_BODY_BYTES`, default 33,554,432
  (32 MiB) of inflated bytes, or `GIT_PUSH_MAX_BODY_BYTES` if that is smaller.
  A larger compressed push is refused with a git error message naming the
  limit. Push it uncompressed (with git) or with `fyrden push --chunked`.
- **Bodies without a `Content-Length`** (chunked transfer encoding). The edge
  supplies the length on a deployment (**measured** on 2026-10-10 on Workers
  Free), so this happens only without it, as under `wrangler dev`.

### Objects and packs

| Limit | Value | Kind |
|---|---|---|
| Largest object, delta base or delta result | 32 MiB | Product limit (not configurable) |
| Objects in one pack | 1,000,000 | Default (not configurable yet) |
| Longest delta chain in a pushed pack | 50, git's own `pack.depth` default | Default (not configurable yet). A client that raised `pack.depth` can be refused |
| Ref updates in one push request | 10,000 | Default |
| Push options in one push | 100 | Default |

### Pack count

Every push adds a pack, and every fetch consults every live pack, so a
repository may hold at most `GIT_PACK_CAP` of its own live packs (default 16,
minimum 2). A push that would go over merges the smallest packs into one as it
commits, within a budget of `GIT_TAIL_MERGE_MAX_BYTES` (default 64 MiB) and
`GIT_TAIL_MERGE_MAX_OBJECTS` (default 500,000). When no merge within budget
makes room (for example while clones are reading the packs it would merge),
each ref gets "try the push again later" and a background merge is
scheduled; the retried push succeeds.

### Borrowed packs

A repository of a fork network also reads packs it borrows from other
members (no byte is copied): a fork its parent's, a pull request's base its
head's. Its view holds at most 32 packs, its own and borrowed, so it may
borrow at most 32 less `GIT_PACK_CAP` (16 by default). Past that, a
background job merges its oldest borrowed packs into one, at most 16 packs
and 500,000 objects (the rewrite budget) a run. Importing a pull request's
head from a fork, or the base tip into a fork's head branch, adds its packs
only when such merges (the one under way first) bring the view within the
cap even were no object shared between merged packs (a merged pack's size
is known once written). When even packs sharing every object they could
would not fit, it is refused: opening the pull request, or the write to the
head branch, answers 422 `view_full`, and a later revision of an open pull
request's head is not imported (the pull request keeps its last one). In
between (only shared objects would make room), the merge job is asked for
and the import waits for the real sizes: 409 `busy` (try again), or the
revision is imported once the merges are done; it is refused when the
merges leave nothing more to tell. A pack already merged counts as nothing
new: a later import naming it again reads it through the merged pack, and
borrows it again only once the merged pack has left the view (dropped by
the repository's collection). Each merged pack remembers at most the 256
packs most recently merged into it (merging it again moves them to the new
one, so a merge moves at most 256 for each pack it takes); an older one is
borrowed again when an import names it. A view over its cap all the same
(the budget lowered since) leaves the merge job failing, tried again in
case a collection drops packs.

A repository gives up its claim on a pack of the network as its retire job
drops the pack's row. The network is told at the end of that pass, at most
100 releases a pass and one call per network; a release it could not be
told is kept and told again on a pass 10 minutes later. A release removes
only a claim no newer than the repository knew of when it gave the pack
up, so one that lands late or twice never undoes a pull request's import
that claimed the pack again since, even one made after the network's object
was restored to an earlier point in time (claims are ordered by the
object's clock as well as by what it stored). An import whose repository gave up any
claim between sharing its packs and adopting them shares them again first;
more than 3 times within one request, it answers 409 `busy`. A repository
restored to an earlier point in time claims again every pack its restored
registry holds: taking its new restore generation (at once when the
restore asks for it, otherwise with its first write) queues a job that
does so on the object's next alarm, a network at a time, asking a network
it cannot reach again after 30 seconds, doubling to an hour. No release it
recorded after the restore point removes those claims. Until the job has
run, a restored row whose claim such a release removed has none: the
network keeps the pack's bytes for 30 days after condemning it (which came
after the restore point), and deletes them only if the job has still not
run by then. Likewise a release recorded before a member says its view
holds a pack (to a collection, or refusing a deletion) leaves the claim
the network makes again for it.

### Push policy

- **Ref names** follow git's own rules (`git check-ref-format`), must start
  with `refs/`, must be valid UTF-8, and are at most 1,024 bytes. git itself
  accepts any bytes in ref names; Fyrden refuses names that are not UTF-8 with
  "ref name must be valid UTF-8", because every other surface (REST, MCP,
  webhooks, the web UI) is JSON.
- **A ref named twice** in one push is refused.
- **Hidden refs:** `refs/pull/` is managed by Fyrden; pushes cannot create,
  update or delete refs there.
- **The default branch** cannot be deleted by a push.
- **Branches** (`refs/heads/...`) must point to commits.
- **Object checks** are git's `fsck` checks with git's own severities, on
  every pushed object, for `git push`, `fyrden push --chunked` and imports
  alike. Anything `git fsck` reports as an error refuses the push, and so do
  the warnings that protect people who clone the repository: `.git` in a tree
  (including NTFS and HFS+ look-alikes), `.` or `..` entries, names
  containing `/`, empty names, and entries naming the null object id. The
  `.gitmodules` and `.gitattributes` errors refuse too (a symlinked
  `.gitmodules`, unsafe submodule names, paths and URLs, oversized
  `.gitattributes`). Other warnings and info-level findings are accepted and
  shown to the client as warnings: zero-padded tree modes, unusual file
  modes, very long names, a NUL byte in a commit message, tags without a
  tagger or with an unusual name. Many long-lived repositories have these in
  their history; GitLab, for example, turns off the zero-padded mode check
  on push for that reason
  ([Gitaly consistency checks](https://docs.gitlab.com/administration/gitaly/consistency_checks/)).
  git's own `receive.fsckObjects` is stricter (it refuses every warning
  unless `receive.fsck.<id>` relaxes it), and stock git checks nothing on
  receive by default.
- **SHA-1 collision attacks** are detected (SHA-1DC, as in git and on
  GitHub); a colliding object refuses the push.
- **Connectivity:** every object a new ref needs must be in the push or
  already in the repository, with the right type.
- **Shallow pushes** (from a shallow clone, when the push depends on the
  shallow boundary) are refused as a whole.
- **Atomic pushes** (`git push --atomic`) apply every ref or none. Without
  `--atomic`, each ref succeeds or fails on its own.
- **Compare-and-swap:** a ref whose current value is not the one the client
  expected (for example `--force-with-lease`) fails with git's reason.

## Fetch and clone

- **Protocol v2 only** for fetch and clone (git 2.26 or later, the default
  since 2.26). A protocol v0 or v1 fetch gets an error naming protocol v2.
  Pushes use git's receive-pack, as protocol v2 defines no push.
- **Shallow clones and fetches:** `--depth`, `--shallow-since`,
  `--shallow-exclude` and `--deepen` are supported.
- **Thin packs** are sent to clients that ask for them on incremental fetches.
- **Not supported:** partial clone (`--filter`), `wait-for-done`,
  `server-option`, `object-info`, `bundle-uri` and packfile URIs. Dumb HTTP is
  not served.
- **Request size:** a fetch request (the wants and haves) may be at most
  16 MiB after decompression, with at most 100,000 wants and 100,000 haves.

### Free and Paid serving

The deployment's plan is the `FYRDEN_PLAN` variable that
`fyrden deploy --plan free|paid` sets.

| | Free (or unset) | Paid |
|---|---|---|
| Response framing | The repository's Durable Object writes a side-band framed copy of the pack set to R2 once; the Worker then streams it with native pipes | The Worker frames the pack while it streams it |
| Why | A Free Worker gets about 10 ms of CPU per request ([platform limit](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)). **Measured** on Workers Free (2026-10-10): native pipes cost 1 to 4 ms of CPU for 100 MiB to 1 GiB, while framing in Worker code costs 240 to 353 ms per 100 MiB, and a framed 1 GiB clone was stopped for CPU after 632 MB with the response already started | Framing measured at about 2.4 to 3.7 ms of CPU per MiB (Free account, 2026-10-10), well within Paid's 30 s default |

On both plans, a clone that cannot be served from the stored packs as they are
(the packs hold objects the refs no longer reach, for example) gets a pack
regenerated by the Durable Object and stored in R2 before the Worker streams
it.

### Subrequest budgets

Each Worker request and each Durable Object invocation has a budget of calls
([platform limit](https://developers.cloudflare.com/workers/platform/limits/#subrequests)):

| Budget | Free | Paid |
|---|---|---|
| Calls to internal services: R2, D1, Durable Objects | 1,000 per invocation. **Measured** (2026-10-10): R2 binding calls, D1 queries and Durable Object calls share these 1,000, from a Worker and from a Durable Object | 10,000 by default (platform limit; not measured) |
| Outbound `fetch` and Cache API calls | 50 per invocation. **Measured** (2026-10-10): the Cache API and `fetch` share these 50 | 10,000 for `fetch`; 1,000 Cache API calls per request (platform limits; not measured) |

**Measured** (2026-10-10): every request into a Durable Object starts with a
fresh budget, so the repository object's work does not use the Worker's.

What this means for clones:

- Pack bytes are read from R2 in large ranges (whole packs when serving them
  as they are), so a clone makes few R2 calls. Counted in local integration
  tests (2026-10-11), cloning a one-pack repository took: on Free, 1 R2 read in
  the Worker and 3 R2 calls in the Durable Object the first time, then 1 and 1;
  on Paid, 1 and 1; a regenerated pack on Free, 1 and 4 plus 2 Cache API calls.
- A repository may have at most 16 own live packs (the pack-count cap), which
  bounds the R2 calls of a clone served as stored.
- The Durable Object caches pack blocks in the Cache API for reads that need
  random access. It stops calling the Cache API once the invocation (a
  request or an alarm, with every indexing phase or job it runs) has made 40
  external calls (default), Cache API and outbound `fetch` together, under
  Free's 50. A Cache API call that fails is treated as a miss.
- Background jobs start no new slice once the invocation has made 800 calls to
  R2, D1 and Durable Objects (Proposed), under Free's 1,000; the alarm
  continues them in a new invocation.
- A cold clone of a 1 GB repository has not been measured yet on Paid.

### Durable Object CPU

A Durable Object gets 30 s of CPU per request and per alarm by default
([platform limit](https://developers.cloudflare.com/durable-objects/platform/limits/)).
**Measured** on Workers Free (2026-10-10): an alarm that used 27.0 s of CPU
completed, one at 32.5 s was reset and retried. A reset loses the writes of
that invocation, so Fyrden's long work is sliced and saves its place:

- Push indexing runs for up to `GIT_PUSH_INDEX_BUDGET_MS` (default 10 s) in
  each request, then continues in the object's alarm. The Worker waits (no
  CPU) and keeps the client's connection alive.
- Repack and garbage collection slices stop after 20 s, 200,000 objects,
  256 MiB written or 500 R2 calls (defaults), whichever comes first.
- The five-minute maintenance cron (archiving the directory's audit log,
  expiring repositories, advancing deletions and transfers, reaping keys)
  runs in a Durable Object of its own, which the cron trigger calls: a
  cron trigger gets 10 ms of CPU on Workers Free
  ([platform limit](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)),
  and the run took 14 to 80 ms (measured on Free, 2026-10-22). A run asked
  for while one is under way joins it.

Not measured yet: the CPU needed to parse the largest packs, as the first
parsing pass of one pack runs in one invocation.

Each Durable Object has 128 MB of memory
([platform limit](https://developers.cloudflare.com/workers/platform/limits/#memory));
Fyrden's git operations in one repository share a 72 MiB pool (default) and
wait for room rather than exceed it. A fetch plan and a push's indexing
phase first wait for their share, holding nothing (25 MiB plus the packs'
indexes, up to the whole pool, and 33 MiB, with the default limits), then
reserve from it: a reservation that fits what is left of their share is
granted at once. What they need past it (tables that grow with the
repository, the objects a push resolves) comes from the pool ahead of work
not yet started, and can wait for other work, so concurrent ones that both
need more than their share can still wait on each other. In a small
repository two shares of either kind fit in the pool at once; the rest wait
their turn. A wait past 60 s fails: a fetch then answers that the repository
is busy and to try again. Besides the pool, a repository keeps pack blocks
(16 MiB) and pack indexes (8 MiB) in memory between requests, so finding an
object in a pack it read recently reads nothing from R2; an index over 2 MiB
(a pack of about 75,000 objects) is read by ranges instead. Index reads in
flight count against the 8 MiB too: when they fill it, further index reads
wait for them to finish.

## Chunked upload sessions

The `uploads.*` operations (and `fyrden push --chunked`) take a pack in parts:

| Limit | Value | Variable |
|---|---|---|
| Part size (every part but the last) | 16 MiB (default; at least 5 MiB, and below the request body limit) | `GIT_UPLOAD_PART_BYTES` |
| Parts per session | 10,000 ([R2 platform limit](https://developers.cloudflare.com/r2/objects/upload-objects/)) | |
| Largest pack per session | 8 GiB (default) | `GIT_UPLOAD_MAX_BYTES` |
| Ref updates per session | 1 to 1,000 | |
| How long one `complete` call waits for indexing before answering `indexing` | 20 s (default); call again | `GIT_UPLOAD_COMPLETE_WAIT_MS` |
| Session lifetime | An upload not committed within 24 hours (default) is removed with its parts | |

Only the token that started a session can complete it, and the push is
re-authorized when it commits. A part can be uploaded again; the last upload
wins. One request at a time uploads a given part: another upload of the same
part meanwhile is refused with `part_in_progress` (HTTP 409, `Retry-After`),
and `complete` waits (`parts_in_progress`) until no part is being uploaded. A
request that stalls for 10 minutes (default) loses the part to the next
upload; its own late answer is then refused (`part_superseded`) and the part
must be uploaded again. `fyrden push --chunked` retries both.

## Server-side import

An import copies a repository from another git server into an empty Fyrden
repository:

- The source URL must be `https://`, at most 2,048 characters, without
  credentials, query or fragment. Its host must resolve to public addresses
  only (checked on every request; redirects are refused), and must not be the
  deployment itself.
- **Own hosts:** the deployment's own hostnames are refused, so an import
  cannot loop back through Fyrden. They are the host the request arrived on;
  on `workers.dev`, both Fyrden Workers on the same account subdomain; and any
  extra hostnames in `FYRDEN_OWN_HOSTS` (comma separated). Set it to every
  custom domain routed to either Worker.
- The source must speak git protocol v2.
- Only `refs/heads/*` and `refs/tags/*` are imported, at most 10,000 refs.
  Refs whose names are invalid or not UTF-8 are skipped and listed in the
  import's report.
- At most `GIT_IMPORT_MAX_BYTES` (default 4 GiB) and `GIT_IMPORT_MAX_MS`
  (default 10 minutes) of fetching per import.
- **A slow source is stopped early.** The fetch runs in the repository's
  Durable Object, which stays active, and is billed for its duration, while
  it waits on the source ([platform pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/):
  pending I/O keeps an object in memory, and it incurs duration charges
  during that time), so a
  source that stalls or trickles does not hold it for the
  whole 10 minutes (Proposed defaults, checked every 5 seconds):

  | Limit | Default | Variable |
  |---|---|---|
  | Connecting (name lookups included) and listing the branches and tags | 30 s | `GIT_IMPORT_DISCOVERY_MS` |
  | Nothing received while the pack streams (keepalives and progress messages count) | 60 s (git's upload-pack sends a keepalive every 5 s by default while it prepares the pack) | `GIT_IMPORT_IDLE_MS` |
  | Pack throughput, over every minute after the first two (pack data only: progress messages and keepalives do not count) | at least 16 KiB/s (a 4 GiB import needs about 7 MiB/s to finish in time) | `GIT_IMPORT_MIN_BYTES_PER_SECOND` |

  A pack of B bytes therefore holds the object for at most about
  3 minutes + B / 16 KiB/s, and never past `GIT_IMPORT_MAX_MS` (storing the
  pack included). A source stopped this way fails the import at once,
  without a retry, with the error `the source took too long: ...` naming the
  limit, even when the rest of the pack arrived while it was being stored;
  whatever was stored is removed. Once the fetch is over, stopped or not,
  any response the source left open is cancelled. The transfer stays in the
  Durable Object because a Free Worker serving a request gets about 10 ms
  of CPU per invocation (a queue consumer gets 30 s by default, on Free as
  on Paid: [Queues limits](https://developers.cloudflare.com/queues/platform/limits/);
  moving the transfer to one has not been examined): the pack
  arrives in side-band frames that Worker code must take apart, and framing
  in Worker code was measured at 2.4 to 3.7 ms of CPU per MiB (see Free and
  Paid serving; taking frames apart is assumed to cost about as much,
  unverified).
- The imported pack is checked like any push.

## Maintenance and retention

Repack, garbage collection and cleanup run in each repository's Durable Object
alarm. These periods are defaults and are not configurable in this version:

| What | When it is deleted |
|---|---|
| Packs replaced by a repack or collection | 30 days after they were replaced, and never while a clone that started before still reads them |
| Unreachable objects (moved to a garbage pack by collection; a pull request's recorded base, `base.sha`, counts as reachable) | Condemned 1 day after the garbage pack was last touched, then deleted after the 30-day retention |
| Reflog entries | After 90 days, by a pass that commits schedule (at most daily). Objects reachable only from the reflog are kept until then |
| Uncommitted uploads and their stored bytes | 24 hours after the upload started |
| Stored fetch responses (regenerated or framed packs) | 1 hour after the last clone that read them |
| Outputs of an interrupted repack | 24 hours |
| An event's stored data (a change too large for one queue message keeps its data in the repository, for consumers to fetch) | 7 days after the event was sent; never while it waits to be sent |

A repack that replaces packs a clone is reading waits up to 1 hour for that
clone before it switches; the old packs stay readable either way.

A fork network (a repository and its forks) is also collected as a whole,
daily while it has more than one member, in the network's own Durable Object
alarm. Each member reports which of the network's shared packs it still
reads; a shared pack none reads is deleted once every member has
acknowledged it and the 30-day retention has passed. Files under the
network's pack prefix older than 1 day that no member's registry names are
deleted: the members are asked a page of 100 files at a time, and no more
once every file of the page is accounted for. Each slice of this work makes
at most 100 calls to members, R2 and D1 (Proposed) and saves its place, and
an alarm starts no slice past 800 calls, so a network with many members is
collected over as many alarms as it needs. A collection due while a fork is
being created waits for it: it runs as soon as the fork is published or
abandoned, and a fork still unfinished after 1 hour is taken as abandoned
and removed. While a collection asks the members what they read, creating
a fork, detaching, and a pull request from a fork wait for it up to 10
seconds, then answer `network_busy` (retry later); a collection that fails
for good stops holding them up and runs again a day later.

## Repository deletion

`DELETE /repos/{owner}/{repo}` and the bulk `POST /user/repos/delete` start a
deletion that finishes in the background:

| What | Value |
|---|---|
| Names in one bulk delete | 1 to 100 |
| Deletions one request finishes itself | The one it deletes; 3 for a bulk delete |
| The rest | Advanced by the cron every 5 minutes, 10 per run, oldest first; one that is waiting goes to the back |
| Pushes, ref and setting changes | Refused as soon as the deletion starts |
| Found or read under any name | Not after about 30 seconds (an isolate that resolved it before may serve it until then) |
| The name | Taken until the deletion is `deleted`; free afterwards. The id is never reused |
| Audit records | Archived to R2 before anything is erased; an R2 outage makes the deletion wait |
| A clone or fork in progress | The erase waits for its read lease: 10 minutes, renewed while it reads |
| A push admitted before the deletion | The erase waits up to 15 minutes for it to store its body; a body stored later is deleted by the push itself |
| Forks | Keep the packs they borrowed; the network deletes a pack once no member claims it |
| Webhook deliveries, their attempts and bodies, the bodies' payload records, and queued effects | Deleted before the repository's storage, up to 5 pages a call (500 effects, 200 deliveries or payload records, or 1,000 bodies a page); none are made once the deletion's tombstone is in the read model. A webhook effect of the repository that was claimed (its deliveries being made, or made) holds the cleanups until 15 minutes after it ended, a queue consumer invocation's wall-time limit ([platform limit](https://developers.cloudflare.com/queues/platform/limits/)), so no invocation that claimed it is still storing a body when the bodies are deleted; its pending webhook effects are ended first, 500 a page (`effects.invalidated`), and one claimed at the time is waited for until it ends. A repository whose webhooks made no deliveries in the 15 minutes before its deletion does not wait (all Proposed) |
| Incomplete multipart uploads of interrupted maintenance | Left to R2, which aborts them after 7 days |

A deletion that keeps failing shows `attempts` and `last_error` in the
directory's `repo_deletions` row.

## Browsing history

Branches, tags, commits, comparisons and files (`/repos/{owner}/{repo}/branches`,
`/tags`, `/commits`, `/compare/{base}...{head}`, `/contents`, `/readme`,
`/git/trees`, `/raw`) start from a branch, a tag or a full commit SHA of the
repository itself; a commit that only another repository of the same fork
network has is not found.

| What | Value |
|---|---|
| Page size | 1 to 100, default 30 |
| Commits one history page examines | 2,000, and about 400 R2 reads for the walk; with `path`, a page can hold fewer commits than asked (even none) and still have a next one |
| R2 reads one browse request makes | 800 at most (Free allows 1,000 calls per invocation); a history page then ends early, anything else answers `too_expensive` |
| Commit text in one answer | 8 MiB; a history page then ends early, anything else answers `too_large` |
| History order | Newest first by corrected commit date, then commit id: what `git log` shows, unless commit dates go backwards or are equal |
| Tags | A tag of a tree or blob is not listed; a page can be short (even empty) and still have a next one |
| Branches waiting in a history cursor | 256; a wider history answers `history_too_wide` |
| Commits a comparison counts on each side | 10,000; more answers `comparison_too_large` |
| Commits a comparison lists | The newest 100, oldest first |
| Commit text | Decoded as the commit's `encoding` header says (UTF-8 without one, or for an encoding the runtime does not know) |
| Directory entries per page (`/contents`) | 1 to 1,000, default 1,000 |
| File content in a JSON answer | 1 MiB; a larger file has `encoding: none` and is read through its `download_url` |
| Raw file (`/raw/{path}`) | 24 MiB; larger answers `too_large` (clone the repository instead) |
| Recursive tree listing (`/git/trees/{ref}?recursive=1`) | 10,000 entries; more, more trees than one request may read, or directories nested so that their trees together pass 32 MiB, is `truncated` |
| `/git/trees/{tree_sha}` | Takes a branch, a tag or a commit SHA; a bare tree SHA is not found |
| Names that are not valid UTF-8 | Shown with replacement characters; such a file cannot be asked for by path (clone the repository) |
| A directory page's cursor | Valid for that version of the directory; after the branch moves it answers `cursor_stale` |

## Archives

`GET /repos/{owner}/{repo}/tarball[/{ref}]` and `/zipball[/{ref}]` serve a
commit's files under `<owner>-<repo>-<short id>/`; `GET
/repos/{owner}/{repo}/archives/{format}` (REST and MCP) prepares one and
links it. The repository's object builds an archive in slices into R2 and
keeps it a week.

| What | Value |
|---|---|
| File content in one archive | 1 GiB; more fails with `archive_failed` (clone instead) |
| One file | 24 MiB; a symbolic link's target, 64 KiB |
| Zip entries | 65,535 (no ZIP64); use tar.gz past that |
| Directory depth | A path's directories, with their names, fit in 1 MiB of build state (about 2,500 levels of 255-byte names); deeper fails with `archive_failed` |
| Building | 8 MiB encoded or 5,000 entries per slice (a file that would take a slice past 8 MiB starts the next, alone if it is larger), at most 300 slices (a commit with very many small files fails: clone it); a file of 1 MiB or more has its bytes reserved while it is compressed, and waits for them; a request builds for up to 5 seconds, then answers 202 with `Retry-After: 5` until it is ready |
| Bookkeeping | A zip's central directory records wait for its last slice in rows of up to 1 MiB of them (about one a slice), written once and deleted with the last slice: rows written grow with slices, not files (they count toward Workers Free's 100,000 a day) |
| Kept | 7 days, then deleted when the repository next builds one (not while a download that started in the last hour may still read it); deleted with the repository |
| Dates | tar holds dates up to 2242, zip 1980 to 2107; later or earlier commit dates are written as the nearest one |
| Zip names | Flagged UTF-8 when they are; other bytes are written as they are, without the flag (as git does) |
| tar.gz | Several gzip members (any gzip reader reads them as one stream; a file of 1 MiB or more is one of its own); pax headers for long names; the commit id in a pax global header, as `git archive` writes |
| Downloads | `ETag` per commit and format; a matching `If-None-Match` answers 304 without reading the archive (raw files likewise, by blob) |

## File writes

`PUT`/`DELETE /repos/{owner}/{repo}/contents/{path}` and
`POST /repos/{owner}/{repo}/file-commits` make one commit on a branch. The
repository's object builds it and commits it through the push path: the pack
is checked like a pushed one, the token is checked again just before the
branch moves, and the branch moves only from the head the commit was built on.

| What | Value |
|---|---|
| Files one write changes | 1 to 100 |
| Content one write carries | 4 MiB (all files together), checked before it is decoded |
| Commit message | 64 KiB |
| Branch | Must exist; an empty repository takes a first commit on its default branch |
| Identity | Committer: the platform, `Fyrden <noreply@host>` (it signs). Author: the agent acting, else the caller, as `<handle> <id@users.noreply.host>`; `author` may name someone else. An agent acting for a user (a delegated token) adds `Co-authored-by: <user>` to the message, unless it already names the user; an agent with its own token acts for no one and adds none. Trailers are not authenticated: the audit log records who acted for whom. Repositories generated from a template take the same identity |
| Branch moved meanwhile | 409 `head_moved`; read again and retry |
| File changed meanwhile (`sha` given) | 409 `sha_mismatch` |
| Token revoked during the write | 403 `token_revoked`; nothing is committed |
| Indexing wait | 4 steps of up to 5 seconds; a busier repository answers 409 `busy` |
| Directories a write reads | About 300 R2 reads' worth; deeper writes answer `too_expensive` |
| A directory a write changes | 1 MiB as a tree object (about 25,000 entries), 4 MiB of trees in all; larger answers `too_expensive` (push instead); memory for them is reserved, or the write answers `busy` |
| Request body (REST and MCP) | 8 MiB; larger answers 413 `body_too_large` before it is read |
| Retrying a write | Send an `Idempotency-Key` (see [Idempotent requests](#idempotent-requests)): a retry gets the first answer and makes no second commit |
| Signature | Signed with the platform key (see [Commit signing](#commit-signing)) |

## Repository expiry

A repository may carry `expires_at` (Unix milliseconds), set when it is
created (also by fork or generation) or by an update, and cleared with
`null`. The cron, every 5 minutes, marks expired repositories for deletion
and advances their deletions in the same run; they go through the ordinary
deletion, audited as `repo.expire` with no actor.

| What | Value |
|---|---|
| Earliest | Any time in the future; a past time answers 422 `invalid_expiry` |
| Latest | One year ahead |
| Repositories marked per cron run | 50; the rest in later runs |
| Deletions advanced per cron run | 10 (as for any deletion) |

## Quotas

Each account (a user or an organization) has two limits, set per account by
an instance administrator (`PUT /admin/accounts/{account}/quota`) or else the
instance defaults below; `GET /user/quota` and `GET /orgs/{org}/quota` show
them and their use.

| What | Value |
|---|---|
| Active repositories | 1,000 by default (`QUOTA_MAX_REPOS`). Create, organization create, fork and generate past it answer 403 `quota_exceeded`; the check holds against concurrent creates. Repositories being deleted do not count |
| Storage | 1 GiB by default (`QUOTA_MAX_STORAGE_BYTES`): the bytes the account's repositories' pushes stored, as received (pack and commands). Forks count nothing until pushed to; repacking does not change it; a deleted repository's bytes are free once its deletion finishes |
| Before a push is stored | Its `Content-Length` is reserved, or, without one, as much as is free (up to the body limit); a push larger than the reservation is refused with a message git shows. A chunked upload reserves its declared size |
| At the commit | The push's stored bytes are held for it; one that does not fit (the limit was lowered, or a write the repository makes itself: file writes, imports, generation) is refused, every ref `ng`, nothing changed. Once committed, the bytes become the repository's usage |
| A push that commits nothing | What it reserved or held is free again |
| Holds | A reservation lasts the push's longest wait plus 15 minutes (a chunked upload's session plus an hour), a commit's hold 30 minutes; a lapsed one counts nothing. A commit's confirmation is owed by its repository until the account takes it (counted once): one that fails is told again every minute, for up to six days (then given up, uncounted: the account remembers the ones it took for seven) |
| Forks | A fork that loses the last slot to a concurrent create is deleted again |
| An agent's repositories | Besides the account's quota, an agent acting for a user may have created at most 100 active repositories (`QUOTA_AGENT_MAX_REPOS`); past it, 403 `quota_exceeded`, held against concurrent creates |

## Repository transfer

`POST /repos/{owner}/{repo}/transfer` moves a repository to the caller or to
an organization it may create repositories in. It runs as a resumable job:
the repository stops taking changes, the directory moves its owner and name,
the old account hands over its collaborators and storage, and the
repository's object takes its new owner. The request usually sees it land;
the cron finishes any it does not.

| What | Value |
|---|---|
| Moves with it | History, refs, rulesets, stars, forks' parent link, collaborators, storage usage |
| Stays behind | The old organization's team grants, and its teams' review requests (their members' items settled by a job) |
| The old path | Redirects to the new one (for the API, clone, fetch and push), until the old account uses the name again |
| While it moves | Pushes, file writes, renames, settings, rulesets and deletion are refused (409 `repo_transferring`, or "being transferred" to git); reads go on |
| Refused | 409 `name_taken`, 403 `quota_exceeded` (repositories or storage), 422 `same_owner`, 409 `transfer_in_progress` (another transfer or a deletion is under way, or the owner changed since the request was authorized), 409 `repo_generating` (still being generated from a template), 422 `too_many_collaborators` (the new account's members and the repository's collaborators would exceed one access list's 10,000 entries); a refused transfer leaves the repository as it was |
| Storage of an upload committing as it moves | Not counted (its confirmation reaches the old account, which no longer counts the repository) |
| Admission checks | The new account's repository count is enforced when the directory moves the repository. Just before the move, the new account makes room for it, held until the transfer lands or is called off: its storage (and, charged to each, the uploads whose confirmations it still owes, until the new account takes them) and its collaborators, counted against later membership changes. Concurrent transfers and members added meanwhile cannot take the account past either limit |
| One runner at a time | A runner holds a transfer for 60 seconds; one that dies frees it after that |
| Caches | Other Workers may resolve the old path to the old owner for up to 30 seconds; access is decided by the repository, which knows its owner, and changes authorized for the old owner are refused |
| Read model | Events from before the transfer are refused once it lands (a new owner generation) |
| Restore | A repository object restored from before a transfer or rename takes, with its new epoch, the owner and name the directory names now, in an owner generation no older than the read model's; if the directory has a transfer under way, the object rejoins it, frozen, and the transfer lands it. An account object (an organization's or a user's) restored from before a user deletion retired its principals forgets them again on its own, once it takes its new epoch: its alarm reads the lifecycle of the principals it holds, a page at a time, and removes the memberships, team memberships and collaborator grants of those being deleted or deleted, keeping an organization's last owner (an administrator hands it over). One restored from before its deletion (under way or finished) is frozen again and answers as deleted, and its deletion starts over from the beginning, once a restore, every step and cleanup run again (an earlier run's late progress is ignored). An object takes its epoch before any call or alarm does any work, once an instance: while the directory cannot be read, its first calls fail and its alarm waits a minute (Proposed) and tries again |
| Transfers one cron run finishes | 10 |

## Agents and delegation

Agents are principals owned by a user or an organization (`POST /agents`).
An agent acts with its own tokens (`POST /agents/{agent}/tokens`) and its
own collaborator roles, or for a user under a delegation grant
(`POST /grants`): it exchanges its own token for a delegated one at
`POST /oauth/token` (RFC 8693 token exchange, `grant_id` names the grant).
A delegated token's principal is the user; its act chain names the agents
acting, the current one first, and audit rows carry it.

| What | Value |
|---|---|
| An agent's rights | Its own (or the user's, under a grant), capped by its owner's: an organization's agent reaches only the organization's repositories |
| A grant | Scopes (at least one), optionally repositories, an expiry of up to 365 days; never wider, nor longer-lived, than the token making it |
| Passing down | An agent holding a user's grant may pass a narrower one (scopes, repositories, expiry) to another agent of its owner; one hop at most (depth 2) |
| Delegated token | Type `oat`, up to 1 hour, and never past any grant of its chain or the agent's own token; scopes and repositories within the grant and the agent's token; for the REST API unless `resource` asks for the MCP server |
| Revocation | Revoking a grant revokes the grants passed down from it; tokens under them, an agent's token its owner revokes (`DELETE /agents/{agent}/tokens/{token_id}`; `GET /agents/{agent}/tokens` lists them) with the delegated tokens exchanged for it and the git tokens minted from those, and an agent's tokens once it (or its owner) is disabled, stop at once for writes and within 30 seconds for reads |
| Suspension | `PUT /users/{username}/suspended` (an optional `reason`, at most 200 characters) and `DELETE` the same, as GitHub Enterprise's (204, no body); instance administrators only, never yourself, never the last active administrator (decided in the change's own statement, so two administrators suspending each other leave one). A suspended user cannot sign in; their sessions, OAuth access and refresh tokens, unanswered authorization requests and unused codes are revoked for good; their personal access tokens, git tokens and delegations, and those of the agents they own, stop (at once for writes, within 30 seconds for reads) and work again once unsuspended. A sign-in, a consent, a passkey registration, or the making of a token, agent, delegation grant or signing key that the user's own request began before the suspension grants nothing, even once the user is unsuspended (an agent's request made with its own token, which the suspension keeps, may land once its owner is unsuspended, as one made then could). No grant of the suspended user's is passed down while they are suspended. A suspended reviewer's approvals stay listed but stop counting toward a merge at once, and count again once unsuspended. Other work already authorized may finish (a push holds its authorization for up to a minute). Their repositories stay available to their collaborators. Each suspension and unsuspension is recorded with its generation (`principal_lifecycle`) and audited (`user.suspend`, `user.unsuspend`) |
| Owner handoff | `PUT /admin/organizations/{org}/owners/{username}` (instance administrators; 204, no body), as GitHub Enterprise's `ghe-org-admin-promote`: makes a user an owner of an organization, a member or not, whatever its owners say (for one whose owners can no longer act). Making an owner an owner changes nothing. Never a user who is suspended or being deleted (refused 404 `user_not_found`); a deletion that begins after that check is refused again in the organization's object, a suspension is not. Audited `org.owner_handoff` |
| User deletion | `DELETE /admin/users/{username}` (instance administrators; never yourself, nor the last active administrator; MCP `delete_user`), as GitHub Enterprise's, with the user's repositories: answered 202 with where the deletion is (`state`, `step`, `blocked`), where GitHub Enterprise answers 204 and works at once. Asked again it answers the same, by the released handle while it is held and by the user's id at any time (a deleted user's handle is their id). At once, in one transaction: the user and the agents they own can no longer authenticate or issue anything (writes refused at once, reads within the token cache's 30 seconds); every credential of theirs is revoked or removed (tokens of every type, sessions, OAuth refresh tokens, unanswered authorization requests and codes, passkeys, signing keys, grants from or to them); their handles are released and held for 90 days (no user, organization or agent takes one until then, whatever its case); an isolate that cached a resolution of their repositories may serve it for up to 30 seconds. Then a job (its state in the directory, advanced by a Durable Object's alarm a bounded slice at a time; Proposed shares: 50 repositories, 50 account calls of 100 principals and 500 rows each, 500 stars, 25 feeds a run): their repositories go to repository deletion (one being transferred away waits for its transfer); every account recorded before the deletion began removes their memberships, team memberships and collaborator grants (an organization they solely own blocks the job, `blocked: sole_owner:<organization id>`, until an administrator makes someone its owner with `PUT /admin/organizations/{org}/owners/{username}`, which, like any promotion to owner, sets it going again at once, unless a run already under way saves its wait after that: it then tries again within the hour); their stars go; their feeds are retired; and once no repository is theirs but those whose deletion is done (one reopened by a restore holds it back), they are `deleted` (`step: done`). What they made in others' repositories stays (comments, reviews, commits, review requests, assignments), shown as `ghost`; a review request of theirs gives up its place once a new request would pass the 15. A failed run backs off from a minute to an hour; a cron trigger of its own (`4-59/5 * * * *`) re-arms a due job whose alarm was lost, one a run, in turn. `GET /healthz` reports `checks.deletions` as not ok, without failing the health check, while a job is blocked, one's last run failed, or one has been due and not run for an hour (Proposed). Audited `user.delete` and `user.deleted` |
| Delegated tokens may not | Make or revoke grants, mint tokens (but a git token for themselves), change who has access (collaborators, team repositories), call user-only operations (transfer, stars), or manage signing keys (they would be the user's) |
| Repositories an agent creates | Acting for a user under a grant with `repos:create` (create and fork): the user's, within every acting agent's owner's rights; each expires after 7 days (`AGENT_REPO_TTL_DAYS`) unless `expires_at` says when (at most a year: an agent may move it, only the user may clear it), and counts against the agent's own limit (see Quotas). An agent's own token, or a token limited to repositories (by its grant or the agent's token; it could not reach the new one), creates none |
| An agent's own token | Never wider than the token that minted it (scopes and repositories) |
| Token endpoint | Bodies up to 16 KiB; rate limited per client address |
| Rulesets | Rules for `agent` actors apply to an agent acting for a user |
| Git tokens for the caller | `POST /user/git-tokens` (MCP `create_git_token`): a `git` token for stock git, as the caller (a user, an agent, or an agent acting under a grant, keeping that grant and chain: revoking the grant stops it); `contents:write`, or `contents:read`, within the caller's scopes; 1 hour at most (`expires_in_minutes`), never past the caller's token. The only token minted over MCP |
| Not yet | Grants from organizations |

## OAuth authorization server

Fyrden is its own authorization server (OAuth 2.1, public clients with
PKCE), for MCP clients and other tools acting for a signed-in user.
Discovery: `/.well-known/oauth-authorization-server` (RFC 8414) and
`/.well-known/oauth-protected-resource/{mcp,api}` (RFC 9728), which a 401
from `/mcp` or `/api` names in its `WWW-Authenticate`.

| What | Value |
|---|---|
| Clients | Public only (`token_endpoint_auth_method: none`): known by a client ID metadata document (an `https` `client_id` URL with a path, fetched through the outbound URL policy, at most 5 KiB, naming itself, kept a day, a week if it cannot be fetched again), or registered at `POST /oauth/register` (RFC 7591); redirect URIs `https`, loopback `http`, or a private-use scheme, matched exactly (loopback with any port) |
| DPoP (RFC 9449) | A token request with a proof (ES256 or EdDSA) gets tokens bound to its key (`token_type: DPoP`), taken only with `Authorization: DPoP` and a fresh proof by that key (60 seconds either way; each proof once); `dpop_jkt` at authorization binds the code; a bound refresh family needs proofs by its key |
| Organization policy | `PATCH /orgs/{org}` `require_dpop`: the organization's agents' API tokens are taken only DPoP-bound (at once for writes, within 30 seconds for reads, like a revocation), and token exchange for them needs a proof (git tokens only where git itself uses them, since git cannot send a proof: smart HTTP and the chunked upload session `fyrden push --chunked` drives, `/api/repos/{owner}/{repo}/uploads`; elsewhere at the REST API, and at MCP, they are refused like any other) |
| Authorization | `GET /oauth/authorize`: code flow only, PKCE `S256` required, `resource` required (`{origin}/mcp` or `{origin}/api`), scopes are Fyrden permissions; the signed-in user consents on a Fyrden page; the answer must come from Fyrden's own origin |
| Codes | Single use, 60 seconds; redeemed again, the tokens they issued are revoked |
| Access tokens | Type `oat`, 1 hour (never past their family's end), accepted only at their resource (RFC 8707) |
| Refresh tokens | 30 days, single use, within a family of at most 90 days (then the user consents again): each use issues the next; a used one coming back revokes its whole family (refresh and access tokens); of concurrent uses exactly one wins |
| Revocation | `POST /oauth/revoke` (RFC 7009): a refresh token revokes its family, an access token itself |
| Requests | Bodies up to 16 KiB; token, registration and revocation rate limited per client address; authorization requests rate limited per user, with at most 20 waiting for an answer |
| Registrations | At most 1,000 an hour for the whole deployment; one never used within a day, or unused for 90 days, is pruned |
| Pruning | Expired access tokens, refresh tokens, sessions and answered or abandoned requests go a day after they expire (their audit rows stay) |
| Sessions | A `__Host-fyrden_session` cookie (HttpOnly, Secure, SameSite=Lax), 30 days |

## Signing in

Humans sign in at `/auth/sign-in` (a page on the API's origin; the
authorization endpoint links to it), with a passkey or with a personal
access token that has the user's full rights (no scopes, no repository
limits), which is how the first passkey is added.

| What | Value |
|---|---|
| Passkeys | WebAuthn, attestation `none`, discoverable credentials, user verification required; ES256, EdDSA or RS256 keys; at most 20 per user; a signature counter that does not move forward is refused |
| Challenges | Single use, 5 minutes |
| Requests | Every change (sign in, sign out, add or remove a passkey) only from this origin's own pages (`Origin`); sign-in attempts rate limited per client address |
| Audit | `session.start` (with how), `passkey.add`, `passkey.remove` |

## MCP server

`/mcp` serves MCP over stateless Streamable HTTP (protocol revision
2026-07-28): a tool per API operation (but those returning a credential, other
than a short-lived git token), and repository files as resources
(`fyrden://repos/{owner}/{repo}/files/{+path}` on the default branch,
`fyrden://repos/{owner}/{repo}/refs/{ref}/files/{+path}` at a branch, tag or
commit, a branch's slashes as `%2F`; not listed, a client names the file it
wants). Each request builds its own
server; each tool's JSON Schema is converted once per Worker isolate and
shared after that.

| What | Value |
|---|---|
| Tools | 77; `tools/list` answers about 161 KB |
| Browser requests | Only from the deployment's own hosts (`Origin`, against DNS rebinding): on `workers.dev`, both Fyrden Workers on the request's account subdomain; the hosts in `FYRDEN_OWN_HOSTS`; loopback. Native clients send no `Origin` |
| Request body | 8 MiB, as REST |
| CPU per request | **Measured** on Workers Free (2026-10-14, `wrangler tail`): `tools/list` 5 ms on a warm isolate with 63 tools (45 to 160 ms before tool schemas were converted once per isolate); `whoami` 32 ms and `resources/read` 16 ms (measured before that change) |
| First request on a new isolate | **Measured** on Workers Free (2026-10-14): 60 to 190 ms of CPU for `tools/list`, paid once per isolate: loading the Worker's code, the MCP SDK building its protocol schemas on first use, and converting every tool's schema. New isolates are most common right after a deploy and when traffic grows |

On Free, whose nominal CPU limit is 10 ms per request
([platform limit](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)),
those first requests completed in the measurement, but they run well past the
nominal limit, so a burst of new MCP clients just after a deploy is the
likeliest place for a Free deployment to hit it (the request then fails with
error 1102). Paid's default is 30 s. Not measured yet: the same on Paid,
and how often Free actually enforces the limit for these requests.

## Web UI

`fyrden-web` is the one origin people use: it serves its pages, and hands
the API's paths (`/api`, `/mcp`, `/oauth`, `/auth`, `/.well-known`, `/v0`
and git's) to `fyrden-api` over the service binding unchanged, so the
session cookie, OAuth and git all work on it. Its server calls the API as
the signed-in user: the session cookie with an `X-Fyrden-Session: 1`
header, which no other site's page can send (the API grants no CORS).

| What | Value |
|---|---|
| Pages | Sign in, repositories (list, create), files (browse, view, edit, add, delete), README (GitHub-flavored Markdown with Mermaid diagrams), commits with their verification, clone URL, archives, repository settings, tokens, agents and delegation grants; pull requests (list, open, conversation, files with diff comments and suggestions, reviews, the merge box, update branch, the conflict editor) |
| Markdown | Rendered in the browser after the page loads, never on the server (Workers Free's CPU per request): the server sends the source, shown as plain text until then and without JavaScript. A page sends at most 512 KiB of Markdown source (the files page) or 256 KiB each of comments and reviews (a conversation), then links to the rest |
| Forms | Taken only from the web origin's own pages (`Origin`) |
| Markdown | Raw HTML escaped, unsafe link protocols dropped; Mermaid drawn in the browser in strict mode |
| Content Security Policy | Scripts only from the origin, plus React Router's inline scripts with a new nonce per response; styles may be inline (Mermaid); images, fonts and everything else only from the origin (and `data:`); no plugins, `<base>`, foreign form targets or framing. A README's images from other sites are not shown: with no image proxy, they would tell their author who viewed a private repository |
| Raw files | Served as downloads (`application/octet-stream`, `nosniff`, a sandboxing CSP), never rendered on the origin |
| Caching | Pages, the data they navigate with, and downloads are `private, no-store` |
| Names | A file, branch or repository name is read from the URL as written (a literal `%2F` stays in the name); a page whose path ends in `.data` opens with a trailing slash (React Router takes that suffix for its own data requests) |
| A session's credential | The user's full rights, rechecked on the primary each request; tokens and grants made from a session may last their full allowed time |
| Custom domains | List them in `FYRDEN_OWN_HOSTS` (MCP takes browser requests only from the deployment's own hosts) |

## Templates

`POST /repos/{template_owner}/{template_repo}/generate` makes a repository
whose first commit holds the template's default-branch tree. The template's
object reads the tree; the new repository's object commits it through the
push path, as a file write.

| What | Value |
|---|---|
| Trees and files copied | 2,000 at most |
| Their bytes | 8 MiB at most (they cross between two objects and are packed); larger answers 422 `template_too_large` |
| Storage reads | The browse budget (800 R2 reads); more answers 422 `too_expensive` |
| History | None: one commit on `main`, `Initial commit`, by the caller |
| Token | Needs `contents:write` too, without a repository list |
| A failure | The new repository's object settles it: if its first commit was made (the answer was lost), the repository is kept; otherwise its commit is refused from then on and the repository is deleted, its name free once the deletion finishes |
| A request that never finished | The cron settles the generation the same way once it is 15 minutes overdue; while the generation is pending, the repository takes no write |

## Stars

A star is one directory row per user and repository. Starring needs
`starring:write` and `metadata:read` on the repository; `GET /user/starred`
needs `starring:read`. A repository's `stargazers_count` counts stars of
enabled users. Deleting a repository deletes its stars. A listing leaves out
repositories the caller can no longer read, so a page can be short.

## Commit signing

Commits Fyrden makes itself (file writes, generated repositories) are signed
with the platform's Ed25519 key as SSH signatures (`gpg.format = ssh`), so
`git verify-commit` checks them against the published key. Every commit in
the API carries GitHub's `verification` object.

| What | Value |
|---|---|
| The key | The Worker secret `SIGNING_KEY`: a 32-byte Ed25519 seed, base64. `fyrden deploy` makes one when the Worker has none and never shows it |
| Published at | `GET /api/meta/signing-keys` (any token; the `list_signing_keys` MCP tool): each key's `key_id` (the SHA-256 fingerprint ssh-keygen shows), its public key line, and whether it is current |
| Rotation | Set a new `SIGNING_KEY` and list the old public key line in `SIGNING_KEYS_RETIRED` (one per line), so commits it signed still verify |
| Verified | A valid signature by the platform's key, current or retired; or by a key a user (or an agent, with its own token) added (`POST /user/ssh_signing_keys`) on a commit whose committer email is that principal's no-reply address, `<user or agent id>@users.noreply.<host>` (else `bad_email`) |
| Users' and agents' signing keys | Ed25519 only; 100 per user or agent (an agent adds its own with its own token); a key belongs to one of them (`key_in_use`); deleting one unverifies what it signed, and so does disabling its user, its agent or the agent's owner |
| Not verified | `unsigned`, `unknown_key` (valid, by a key Fyrden does not know), `invalid` (the commit or signature was changed), `malformed_signature`, `unknown_signature_type` (OpenPGP, or a key type other than Ed25519) |
| Without `SIGNING_KEY` | Fyrden's commits are unsigned |
| A malformed `SIGNING_KEY` | Writes it would sign are refused (logged); reading and verifying go on, with the keys that can be read |
| Signatures read | 64 KiB at most; a longer `gpgsig` is `malformed_signature`, not shown |

## Rulesets

Repository rulesets (`/repos/{owner}/{repo}/rulesets`, GitHub's shape) hold
rules on the branches or tags whose full names match: `creation`, `update`,
`deletion`, `non_fast_forward`, `required_signatures`, `pull_request` (no
direct change at all; changes come through pull requests), and Fyrden's
`require_up_to_date` (a pull request merged into the branch must already
contain its latest commit; GitHub ties this to required status checks, which
Fyrden does not have yet). Bypass is by repository role; Fyrden's
`actor_types` limits a ruleset to principal types (`["agent"]` with
`pull_request`: agents must use pull requests).

| What | Value |
|---|---|
| Rulesets per repository | 50 |
| Checked before anything is stored | `creation`, `update`, `deletion`, `pull_request`: a push whose every command is refused is answered before its body reaches R2 (repositories with such a ruleset read the push's command section first, up to 1 MiB; of a gzip body, its first 64 KiB, inflated to at most 1 MiB; a command section past either bound is checked at the commit only; others stream it to R2 untouched); an upload session or a file write a rule refuses answers 409 `ruleset_violation`; an import a rule refuses fails after listing the source's refs, before fetching |
| Checked at the commit | Every rule, with the rulesets current then (a change of the rulesets, the default branch or the pusher's role in between refuses the push; push again): force pushes against the commit graph, signatures of every new commit (reachable from the new tip, not from that ref's old one; ancestors from other branches included) |
| Required signatures | Branch rulesets only. Each new commit verified as the API shows it (platform key, or a user's key on that user's commits); at most 1,000 new commits per ref update (and 20,000 commits walked to find them), more is refused (push in parts); commits are read from the repository's packs and the push's own, once a push however many refs share them, within 800 R2 reads for the whole push (a commit not read by then is refused as `unreadable`) |
| Default branch | `~DEFAULT_BRANCH` names the current default branch and, for an import, the one it sets |
| Refusal text | 2,000 bytes at most per ref |
| Refusals | `ng <ref> <reason> (ruleset "<name>")`; an atomic push fails as a whole |
| `evaluate` | Does not block; what it would have refused at a push's commit point (its signatures too) is listed at `GET /repos/{owner}/{repo}/rulesets/rule-suites` (MCP `list_rule_suites`): one suite per ref update one of them objected to, the newest 1,000 kept, nothing for an update they all let through |
| Actor types | Each principal type at most once |
| `pull_request` parameters | GitHub's: `required_approving_review_count` 0-10, `dismiss_stale_reviews_on_push`, `require_last_push_approval`, `required_review_thread_resolution`, `allowed_merge_methods` (`merge`, `squash`, `rebase`; each once); `require_code_owner_review` must be false and `required_reviewers` empty (code owners and required team reviews come later); any other parameter is refused, never stored unenforced. Fyrden's `allow_agent_approvals` (default false): reviews submitted by agents count, a person's own agents as that person. A rule stored without parameters reads as all defaults (no requirement beyond the pull request) |
| Approvals | One vote per person (an agent acting for a person, or a person's own agent, is that person); the author's never counts; only people with write access or above count, checked when merging; a person's latest review that is not a comment and not dismissed stands; an eligible request for changes blocks until that person approves or it is dismissed |

## Pull requests

Pull requests between branches of one repository
(`/repos/{owner}/{repo}/pulls`, GitHub's shape; MCP `create_pull_request`,
`list_pull_requests`, `get_pull_request`, `update_pull_request`,
`merge_pull_request`). The head may be a branch of a fork in the same network (`owner:branch`).

| What | Value |
|---|---|
| Title | 1-256 characters |
| Body | 65,536 characters at most |
| Numbers | Per repository, from 1, in order; shared with issues once they exist |
| Heads in forks | `head` is `owner:branch`: a branch of that owner's repository in the base's fork network, which the caller must be able to read. With `head_repo` the repository is named exactly, whatever else the owner has. Without it, the owner's first 10 active repositories in the network by name are looked at and only those the caller reads count: one is taken, two or more answer 422 `head_repo_required`, none 422 `head_not_found`. A repository the caller cannot read is never named or counted in an answer, but it takes one of those 10 places, so two inferences remain: a caller answered `head_not_found` for a repository it reads learns that at least 10 of the owner's repositories sort before it, and a second readable repository past the first 10 goes unnoticed (the one readable among them is taken). Name the repository with `head_repo` to avoid both. Its revision is imported before the pull request opens (no pack byte copied: the fork's packs are borrowed, recorded by the network; its commits the base lacks are copied, 50,000 at most, else 422 `too_expensive`; 422 `view_full` when the base cannot borrow more packs, see Borrowed packs). Each later push to that branch is told to the base and imported in the background, in order (a late notice of an earlier revision is ignored); a deleted branch shows `head_ref_deleted`, the pull request staying at its last revision. Closed or merged, the branch is no longer followed; reopened, it is again. A fork restored from a backup that predates a pull request's following asks every other repository of its network, in the background once it takes its new restore generation, to follow its branches again; the pull request then takes the branch as it is. Only the pull request's revisions become readable through the base (`refs/pull/<number>/head`): nothing else of the fork is served. The pull request's author must still read the fork for revisions to be imported |
| Writing a head branch in a fork | Updating the branch, resolving conflicts and applying suggestions build the commit in the base and hand it to the fork, which commits it through its own push path (its rulesets apply; the branch moves only from the head the base last imported, else 409 `head_moved`). The caller needs write access to the base, and write access to the fork or the pull request's `maintainer_can_modify`: set by its author only (when opening it or later), meaningful only for a head in a fork (always `false` otherwise), and honored only while the author still writes the fork and is not disabled (an agent author: nor its owner) (403 `maintainer_edits_off` otherwise). The base checks its side (the pull request still open between the same branches, the base tip unchanged, the caller's token and access) right before the handoff; the fork checks the consent and the author's access again in its commit. A close, retarget or withdrawn consent landing during that handoff does not stop a write already handed over; later ones are refused. A merge into the head first brings the base tip's history into the fork (its packs borrowed, as a fork pull request's import does; 50,000 commits at most, else 422 `too_expensive`); a handoff that takes longer than a minute is refused and can be tried again. The new head reaches the pull request as any push to the fork does |
| Opening | Anyone who reads the repository (`pull_requests:write`). Refused when the head has no commits the base lacks (decided within 30,000 commits walked; past that the head is taken to have some), when head and base are the same branch, and when a pull request between the two branches is already open |
| `refs/pull/<number>/head` | Created at the head when the pull request opens; while it is open, moves with the head branch in the same ref transaction (pushes, atomic or not, and file writes); fetchable, never pushable |
| Head branch deleted | The pull request keeps its last head (`head_ref_deleted: true`) and stays open; it cannot be reopened until the branch exists again, and follows the branch again once it does |
| Changes | The author (anyone acting as the same person, such as its agents within their own roles) edits, retargets, drafts, closes and reopens its own pull request with any role that reads; on someone else's, triage closes and reopens, write does the rest. A patch applies as a whole or not at all |
| Reopening | Needs the head branch and the base branch (unless the same patch retargets onto an existing one); moves `refs/pull/<number>/head` to the head branch's tip |
| Rulesets | Do not apply to opening or retargeting a pull request (the pull request ref is the server's, not a branch) |
| Reviews | Anyone who reads the repository may approve, request changes or comment on an open pull request (MCP `submit_review`); the author may only comment. Each review names the head commit it reviewed (`commit_id`, a head the pull request has had) and counts for that commit only. Body 65,536 characters at most, needed to request changes or comment. Whether a review counts toward a merge is decided when merging (see Rulesets) |
| Dismissing a review | Write access, with a reason of 1-1,024 characters; only a standing approval or request for changes; the review is kept, shown as `DISMISSED` with who and why |
| Requested reviewers | Users and agents who can read the repository (an agent as its owner allows), never the author, and teams of the repository's organization (`team_reviewers`, by slug; GET answers them in `teams` as `{ id, slug, name }`, as they were when asked: Fyrden shows no other team fields, and pull request output lists neither reviewers nor teams, as before). The author or triage and above asks; at most 15 at once, a team counting as one; a request ends when that reviewer submits a review. A team asks each member it has when asked (at most 2,000, 10,000 across a pull request's teams; Proposed), the author aside, and keeps them: one of those members reviewing (by themselves or through their agent) ends the team's request, someone who joined the team later does not (Fyrden's rule; GitHub does not say when it reads membership). The members are read from the organization last, with the access the request is decided by: when the repository decided by an older ACL, it takes the newer and tries again, twice at most, then answers 409 `team_audience_unavailable`. Refusals: 422 `team_not_found` (not one of the organization's teams that read the repository, answered alike whether the team exists or not; a user's repository has no teams), `team_too_large`, `too_many_reviewers`; nothing is kept. Asking a team again changes nothing. Withdrawing takes `team_reviewers` alone too (GitHub needs `reviewers`). A team's request stays through a close and asks its members again when reopened; a merge stops keeping its members (it stays listed). A transfer drops the old organization's team requests at once (not listed, counted or completed, from when the transfer starts); a job then settles their members' items. When the organization is found restored (a newer restore generation, from any answer or notice), a job checks the requested teams against it, from the start each time a newer one is seen, and settles the requests of teams it no longer has. Ending a request (withdrawn, completed, merged, dropped) settles the `review_requested` items of those it asked whom no other request still asks, in entries the event carries, delivered whoever owns the repository by then and whether or not they still read it (feeds check access when read). A request of a user or agent being deleted stays listed (as history) until a new request would pass the 15: then it gives up its place, audited (`pull_request.prune_review_requests`) but with no event and no webhook; a suspended reviewer keeps theirs |
| Code owners | Fyrden's `GET …/pulls/{n}/code-owners` (MCP `get_pull_request_code_owners`; needs `contents:read` too): who owns what an open pull request changes, under its base branch's CODEOWNERS (GitHub's locations, `.github/`, the root, `docs/`, the first holding something: a regular file there is it; a symlink, submodule or directory is passed over, Fyrden's choice, GitHub documents none), for every path the three-dot diff changes (merge base to head; a rename as its two sides; binaries, symlinks, submodules and mode changes included; with no merge base, every path of the head). Each path is matched by its bytes: one that is not UTF-8 is never matched (`unmatchable_paths`, the first one's bytes in base64). Worked out in the background for the pull request's current base branch, base tip and head (a draft's once read), and shown only for those: `pending` until then and after any of them moves. States: `complete` (the deciding rules, each with its owners as written, how many paths and the first; `errors` counts the file's invalid lines), `none` (no file), `too_large` (final for the pair, with `reason`: `file` (3,000,000 bytes or more: GitHub does not load it either; Fyrden does not fall back to a later location), `tree` (a tree over 1 MiB), `depth` (over 64 directories), `scan`, `work`, `stuck`, `path`, `merge_base`), `unreadable` (tried again at `retry_at`, from a minute doubling to an hour). A closed pull request answers 422 `pull_not_open`; a page's cursor is bound to its result (422 `invalid_cursor` once another is shown). Bounds (Proposed): a slice makes at most 150 storage reads (index and pack-range reads: a cached object costs none, one stored as a delta may cost several), reads 1.5 MiB of trees (1 MiB a tree), 200,000 entries, lists 8,192 changes and spends 1,000,000 matcher steps (a change is matched as it is found: the slice stops before the first its steps cannot decide, reading no tree past it); a slice's reads build at most 64 MiB (objects inflated, delta programs and what deltas build, a chain's intermediate objects included); a heavy slice (a file of 64 KiB or more parsed, more than 64 trees read, 1,000 changes matched or 100,000 matcher steps spent, its steps or reads spent, or no progress made) ends its alarm's invocation, the next running in another (Workers' clock does not move while code runs without I/O, so a run's time budget cannot bound its CPU; measured on Free: the largest file and 20,000 changed paths, run back to back in one invocation, passed the 30-second CPU limit and reset the repository's object); an evaluation at most 20,000 trees, 2,000,000 entries, 200,000 changed paths, 50,000,000 steps, 400 slices, and three slices in a row without progress. Results are kept per rule (at most 1,000 rows), reused across base moves that change neither the merge base nor the file, and pruned once nothing points at them; a restore checks open ready pull requests again, 100 a slice. Costs (measured): about 21 rows written for a typical pull request (11 of its own tables with their indexes, 10 of the job queue's), about 6 more a slice; the worst case, 400 slices and 1,000 rules, is about 3,400 rows (Free's 100,000 a day: about 29 such evaluations an account). Repositories are not coordinated: each runs one slice at a time; once the day's writes are spent every write fails, and each job is tried again when its lease ends (a minute), writing nothing, until they reset (00:00 UTC). It never fails for good |
| Files (`/pulls/{number}/files`, MCP `list_pull_request_files`) | Compared from the merge base of the base branch's tip (the recorded base once the branch is gone) and the head, to the head (three dots, as GitHub's); a closed or merged pull request from the base branch's tip it closed at or was merged onto (`base.sha`), whatever the branch does after, until it is reopened; in path order; at most 3,000 files (`truncated` says when more changed), worked out from at most 1,500 trees of 1 MiB each (about 37,000 entries) and 24 MiB in all, the memory each tree and its entries may take held while the listing is worked out (more, or more than the repository's memory has free, answers 422 `too_expensive`); renames with unchanged content found across the whole listing (past 6,000 changed paths, the listing is truncated and shows no renames, only removals and additions). The files changed between two commits, once worked out, are kept in the repository for every later page and listing of that comparison, which read only their own files (the latest 256 comparisons, 8 MiB in all, the oldest dropped first; one over 1 MiB as stored is worked out again each time). A page reads its files' objects up to 6 files at once, and over a request's last 200 R2 reads one file at a time, in order, so that files read ahead leave the earlier ones the reads they need. This is close to, not exactly, reading one file at a time: a file read ahead just before that point can still spend reads an earlier file needed (one whose objects take more than the remaining reads, such as a long delta chain), and that earlier file then answers `patch_omitted: "budget"`; its patch can be read on its own. Memory is held in file order: a file that finds too little free (it holds at most 2 MiB, its two sides) waits until the files before it are done and tries once more, so a file read ahead never takes memory an earlier one needed. A page holds up to `per_page` files (1-100, default 30) and closes early at 1 MiB of patch text. A file's patch is left out, with `patch_omitted` saying why, for a binary file (a NUL in its first 8,000 bytes), a side over 1 MiB or 100,000 lines, a patch over 64 KiB, a submodule, or a page out of R2 reads (800 a request). The line diff is a shortest one up to a cost bound, past which it is right but `approximate`; hunks have three lines of context and no function names. A listing's later pages keep its comparison (`merge_base_sha`, `head_sha`): the cursor names a listing the repository recorded, kept 24 hours (past that, start again) |
| Commits (`/pulls/{number}/commits`) | The head's commits the base branch lacks (a closed or merged pull request's base as files are), oldest first, at most 250; later pages keep the base and head the listing started on, as file listings do |
| Merging (`PUT /pulls/{number}/merge`, MCP `merge_pull_request`) | Write access (`contents:write`), on an open pull request that is not a draft and whose head the base branch does not contain yet. `merge` makes a merge commit of the base branch's tip and the head (message `Merge pull request #<number> from <owner>/<branch>`, then the title); `squash` one commit on the base tip with the merged changes, by the pull request's author (message `<title> (#<number>)`, then the body); `commit_title` and `commit_message` replace the defaults (not used by `rebase`). The server is the committer and signs with the platform key; the merger (for a squash, the author) is the author, and a person an agent acts for is named in a `Co-authored-by` trailer. With `sha`, refused (409 `head_moved`) unless the head is that commit |
| Merge refusals | 405 `merge_conflict` names up to 10 conflicting paths and their kind (`content`, `add/add`, `modify/delete`, `file/directory`, `mode`, `symlink`, `submodule`, `binary`, `too/large`); renames are not followed (a file renamed on one side and changed on the other conflicts), and a history whose merge bases conflict among themselves needs a merge by hand. The base branch's rulesets judge the merge with the pull request's reviews and last push and whether the head contains the base tip: 405 `merge_refused` with the reason. An approval given before the pull request was last retargeted no longer counts (it stays listed; a request for changes still stands), and only an approval of the head itself approves the last push. While the merge is made, a change to the pull request (a push to its head, even one that ends where it began; its base; draft; closing), to its reviews, or to which reviewers have write access answers 409 `pull_changed`, and a move of the base branch 405 `base_moved`: review it and merge again. In an organization's repository, every merge (merge, squash and rebase, a rebase the alarm finishes included) whose rules count approvals (some required, or one after the last push) has the organization's object confirm, as the commit's last step before its refs move, the roles of the reviewers whose approvals count (and of their agents' owners): one call reading them all at once, at the organization's current ACL version and restore generation. The repository's own ACL snapshot may be up to 60 seconds old; this read is not. The rules are judged again with the roles confirmed, so an approval whose write access was removed since (a team membership or grant, a collaborator, an organization role) no longer counts, and the merge is refused (405 `merge_refused`, the rule's reason) only when the approvals left do not suffice; access removed after that read is ordered after the merge. 409 `authorization_unavailable` when the organization's object cannot answer, its answer is older than one the repository has seen, or the repository changes hands meanwhile: merge again. 422 `too_many_reviewers` past 512 reviewers with write access (Proposed). A user's repository (no teams) asks nothing; nor does a merge whose rules count no approval (none required, a bypass, a ruleset only evaluated) |
| Rebase merges (`merge_method: rebase`) | Replays the pull request's commits (those of its head the base tip does not reach), oldest first, onto the base tip, then moves the base branch to the last; at most 250 (more answers 422 `too_expensive`); a pull request with a merge commit among them is refused (405 `not_mergeable`). Each new commit keeps its author line, `encoding` and message byte for byte; the server is the committer (one time for the whole rebase) and signs each with the platform key (without a key, 422 `signing_unavailable`); other headers (the original signatures) are dropped. Empty commits as `git rebase`: one empty from the start is kept, one whose changes the base already has is dropped (all dropped: 405 `not_mergeable`). Unlike `git rebase`, commits are not matched to the base's by patch: a commit the base has and then changed further is a conflict (405 `merge_conflict`, naming the commit), as is a rename in the base of a file the pull request edits. Approvals and rules are judged on the pull request's head before the rebase, as for the other methods. A rebase runs as a background job a request starts and drives as far as it may (about 400 internal calls, 15 seconds); unfinished, it answers 409 `merge_in_progress` (its idempotency key is released) and goes on: the same request sent again answers 200 with the merge once it is done, or its refusal (once: a request after that starts a new rebase). Each step reads 120 R2 objects at most (a commit needing more alone: 422 `too_expensive`); the new objects, kept in the repository object until the end, are bounded at 4 MiB and 2,000 objects, 1 MiB each; at most 3 rebases run at once in a repository (more answers 409 `busy`); one still running after an hour is given up. The pull request or its reviews changing, or the base branch moving, fail it as for the other methods; a change of the platform key starts it again. While it runs, a merge or squash of the same pull request answers 409 `merge_in_progress` |
| Conflicts (`GET /pulls/{number}/conflicts`, MCP `get_conflicts`) | Fyrden: anyone who reads the repository, for an open pull request (a head in a fork is read as the base last imported it). The conflicts of merging the base branch's tip into the head, within the merge budgets: each conflicted file and its kind; files whose lines conflict in text (`content`, `add_add`; UTF-8, 1 MiB a side at most) are editable and come with git's conflict markers, the head's side first, up to 50 files and 4 MiB in all (past 4 MiB, 422 `too_expensive`). `conflict_snapshot` names the base tip and head they were read at |
| Resolving conflicts (`POST /pulls/{number}/conflicts`, MCP `resolve_conflicts`) | Write access (`contents:write`). The resolved content of every editable conflicted file (at most 50, 1 MiB each); the base tip is merged into the head as one merge commit (parents: the head, then the base tip; message `Merge branch '<base>' into <head>` unless given) made and signed by the server, by the caller (an agent's with its `Co-authored-by`), on the head branch from the head only; the head branch's rulesets apply. Refused when either branch moved since the snapshot (409 `head_moved`, `base_moved`, also when the base moves while the commit is made), when any conflict is of another kind (422 `not_editable`: merge locally), when an editable file is missing (422 `unresolved`) or a given file has no conflict (422 `not_conflicted`). Contents still holding conflict markers are accepted and named in `markers` |
| Updating the branch (`PUT /pulls/{number}/update-branch`, MCP `update_pull_request_branch`) | Write access. The same merge when nothing conflicts, done before the answer (GitHub's 202, with the merge commit's `sha`); refused when it conflicts (422 `merge_conflict`), when the head already contains the base tip (422 `up_to_date`) or when `expected_head_sha` is not the head (409 `head_moved`). A head in a fork: see Writing a head branch in a fork |
| Merge budget | Proposed: 300 R2 reads (as a file write: the commit is indexed in the same request), 1,500 trees of 1 MiB at most (about 37,000 entries), 24 MiB of trees and files read in all, 300 files merged line by line (each side 1 MiB at most; a larger file changed on both sides conflicts as `too/large`), 4 MiB of new objects, paths of 4,096 bytes at most in the directories both sides changed (a directory only one side changed is taken whole), 1,000 conflicts with 1 MiB of paths in all, merge bases found within 30,000 commits; more answers 422 `too_expensive` (merge locally and push) |
| Mergeability (`mergeable`, `mergeable_state`, `mergeable_reason`) | Worked out in the background for an open pull request's current base tip and head, after each change of either (a push to either branch, opening, reopening, retargeting); until then, and once closed, `mergeable` is null and `mergeable_state` `unknown`. `mergeable_reason` (Fyrden's) says why `mergeable` is null while open: `pending`, `too_expensive` or `unreadable`; null once known and once closed. `clean` means no conflicts only: rulesets are checked when merging. A pull request waits in one queue per repository (a move of a base branch queues all its open pull requests in one statement, a row each, in the push's transaction), longest waiting first, one merge each alarm slice (several slices an invocation, within its 1,000 calls); a newer change replaces its request and keeps its place. Each is worked out within the merge budgets but 150 R2 reads; past them (`too_expensive`; the merge itself may still succeed), or when an object cannot be read (`unreadable`), it waits in the queue to be worked out again 10 minutes later, the delay doubling with each such result for the same pair up to 6 hours (Proposed), and at once when the base tip or head moves. A result kept under budgets that have changed since (each result records their version) is worked out again as soon as the pull request is asked for. A pull request whose head moved while it was worked out waits behind the others. Changes of state are announced as `pull_request.mergeability` events naming up to 10 conflicting paths (none for a result worked out again to the same state). Asking for a pull request whose mergeability is neither known nor waiting queues it |
| Last push | The opening, each push to the head branch while open, or a reopening that takes a head pushed while it was closed (the reopener's). `require_last_push_approval` needs an approval after it from someone other than that pusher |
| Diff comments (`/pulls/{number}/comments`, MCP `comment_on_diff`, `list_review_comments`) | Anyone who reads the repository comments on lines of a file (`line`, and `start_line` for a range on the same side) at a head the pull request has had (`commit_id`; an earlier head force-pushed away can be commented on only while the repository still stores it, else 422 `commit_unavailable`): `RIGHT` that commit's file, `LEFT` the file at the merge base of the base branch's tip (a closed or merged pull request's recorded base) and that commit; the file must exist (1 MiB at most) and have the lines. Whether they are part of the diff is not checked (GitHub checks). Each such comment starts a thread; `in_reply_to` replies in a comment's thread. Once the head moves, the comment is `outdated` (`line` null; `original_line` kept), and a `LEFT` one also once the base branch moves the merge base of an open pull request (the head unchanged; a closed or merged one keeps the comparison it had then): comments are not moved to the new comparison. Comments in a review (`comments` of a review) come later. Body 1-65,536 characters; the author edits and deletes its own, write access and above anyone's; a thread goes with its last comment |
| Suggestions (`POST /pulls/{number}/suggestions/apply`, MCP `apply_suggestions`) | Write access (`contents:write`) on an open pull request. Applies up to 50 diff comments' suggestions (one ```` ```suggestion ```` block each, its lines replacing those commented on; an empty block removes them) as one commit on the head branch, made and signed by the server (message `Apply suggestions from code review` unless given), the one applying them as author and the suggestions' authors as `Co-authored-by`. Each comment must be on the head side at the current head, on a regular file of 1 MiB at most, the changed files 4 MiB in all; suggestions to one file must not overlap. Only the plain form is read, so the lines applied are the lines shown: every fence starts its line (none in a list item or quote), other fenced blocks are skipped as CommonMark closes them, and a comment with an HTML block, a link reference definition (the web renderer drops line breaks from code after one), a byte order mark, a bare carriage return, NUL or another fence whose language may read as `suggestion` holds none. Checked against the web app's renderer by a differential test. Refused (409 `pull_changed`) when the pull request closes or merges, or an applied comment is edited, while the commit is made. The branch's rulesets apply and it moves only from that head (409 `head_moved`); applied threads are resolved (for a head in a fork, once the fork committed, while the comments are unchanged; see Writing a head branch in a fork) |
| Review threads (`/pulls/{number}/threads`, MCP `resolve_thread`) | Resolved or unresolved by the pull request's author or write access and above; `required_review_thread_resolution` in a ruleset refuses a merge while any is unresolved, outdated ones included |
| Conversation comments | `/issues/{number}/comments` on issues and pull requests (MCP `add_issue_comment`, `list_comments`, `update_comment`, `delete_comment`; the tool was `comment_on_pull_request`). Anyone who reads the repository comments, on open or closed ones, with the permission of what the comment is on (`issues:*` or `pull_requests:*`; a token without it gets 404 for that issue or pull request and its comments); the author of a comment edits and deletes its own, write access and above anyone's; while the conversation is locked, only write access and above. Body 1-65,536 characters. A deletion removes the comment. Webhooks (`issue_comment`) carry `issue` (number, title, state; `pull_request` for a pull request) as it was when the comment changed |

## Issues

Issues (`/repos/{owner}/{repo}/issues`) share one number sequence with pull requests: no number names two of them, and a deleted issue's number is never used again.

| What | Value |
|---|---|
| Opening (`POST /issues`, MCP `create_issue`) | Anyone who reads the repository (`issues:write`). Title 1-256 characters, body up to 65,536. Giving it `labels`, `assignees` or a `milestone` takes triage (refused without it; GitHub drops them) |
| Listing (`GET /issues`, MCP `list_issues`) | Issues and pull requests (marked with `pull_request`), as GitHub's; `type=issues` or `pulls` (Gitea's) narrows it. Each kind only for a caller that reads it: issues with `issues:read`, pull requests with `pull_requests:read` (the other kind is left out without a trace); neither answers 403 `missing_permission`. `state` open (default), closed (merged pull requests included) or all; `sort` created (by number) or updated; `direction`; 1-100 a page. The cursor is bound to the repository and the filters (another answers 422 `invalid_cursor`); a page reads a few pages of rows at most, whatever the repository holds (at most 438 rows for a page of 30, measured over 6,000 subjects sharing one timestamp; each listed item's labels, assignees and reaction counts besides). Sorted by update, an item changed between pages may move. The index behind it costs each change of a pull request (a push to its head included) one more row written (measured) |
| Reading one (`GET /issues/{number}`, MCP `get_issue`) | An issue, or a pull request by its number (marked), for a caller that reads that kind; else 404 `issue_not_found`. `id` is the number. `duplicate_of` shows only when the caller reads its target's kind and the target still exists |
| Changing (`PATCH /issues/{number}`, MCP `update_issue`) | The author edits, closes and reopens its own issue; on anyone else's, triage closes and reopens, write edits. All of a patch applies or none. `state_reason`: `completed` (the default close), `not_planned`, `duplicate` (with `duplicate_of`, an issue or pull request of the repository the caller reads, not the issue itself; takes triage, the author's own issue included), `reopened` (set by reopening). As GitHub's, a reason alone changes nothing unless the state changes, except moving a closed issue to or from `duplicate`; reopening clears the duplicate target and who closed it. `labels`, `assignees` and `milestone` replace what it has and take triage, the author's own issue included. A pull request's number takes only those three (with `pull_requests:write`; anything else answers 422 `pull_request_fields`): its title, body and state change through `/pulls/{number}` |
| Locking (`PUT`/`DELETE /issues/{number}/lock`, MCP `lock_conversation`, `unlock_conversation`) | Write access, on issues and pull requests (with that kind's write permission); `lock_reason` off-topic, too heated, resolved or spam. While locked, only write access and above comment, edit or delete comments, and review pull requests (diff comments included). Answers the lock (GitHub answers 204) |
| Deleting (`DELETE /issues/{number}`, MCP `delete_issue`) | Admin. The issue and its comments go for good, a tombstone (number, version, when, by whom; no text) stays; activity feeds stop showing its items when read (and forget them) |
| References (`GET /issues/{number}/references`, Fyrden's; MCP `list_issue_references`) | `#12` and `owner/repo#12` in the text a reader sees (outside code) of an issue's or pull request's body and of conversation comments, at most 50 a text; a number that is no issue or pull request, or the text's own, is not one. Written with the text (replaced on edit, removed with it). One into another repository reaches it by an effect, applied in the order the source changed (a repository name not resolved when the text is written is not recorded); its listing there shows it only to a caller who reads the source's repository and kind, and leaves out one whose repository is gone: a page holds only what the caller sees, passing over what it may not see a repository and kind at a time, and checks at most 10 other repositories (past them it ends early, with a continuation). Cursors are sealed by the repository, one length whatever they hold (one altered, or for another issue, answers 422 `invalid_cursor`). Titles are not kept; no webhook names another repository |
| Closing keywords | `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved` (any case, an optional colon) before a reference in a pull request's description: when it merges into its repository's default branch, the issues named are closed (`completed`, by the merger), the description read as it is then; a repository it names by name is the one that name named when the description was written. Titles and comments close nothing. Here, in the merge's transaction; in another repository, by an effect checked there when it applies: the merger's token must still hold (`issues:write`, its repository restrictions, a live grant and agents' ceilings) with triage there, else nothing closes and the refusal is audited there (`issue.close_refused`), for good: the repository keeps what came of each close it was asked, so a repeat (a lost acknowledgement) changes nothing; one decided before the repository was transferred is decided again. A transfer of the source repository loses none of its references or closes |
| Activity feeds | Threads `issue/{number}`: the mentioned hear of an issue's opening and of new mentions in its body and comments; its participants (author, commenters, the mentioned, assignees) of its comments, closing and reopening. Feed items show only to a token that reads their kind |

## Labels, milestones and assignees

Issues and pull requests alike: GitHub's paths, through the issue endpoints for a pull request's number too. Reading labels and milestones takes `issues:read` or `pull_requests:read`; managing them takes write access and `issues:write` or `pull_requests:write`; changing what an issue or pull request carries takes triage and the write permission of its kind (a token without it gets 404 for that number). A locked conversation does not stop any of them.

| What | Value |
|---|---|
| Labels (`/labels`, MCP `list_labels`, `create_label`, ...) | A name of 1-50 characters, not `.` or `..`, unique ignoring the case of ASCII letters (as GitHub's, for those; a `/` in a name is escaped in paths), a color of six hex digits (kept lower-case), a description up to 100 characters. At most 1,000 a repository (422 `too_many_labels`). A rename keeps the label on what carries it; a deletion takes it off everything at once (references go when that issue's labels next change) |
| Default labels (`/orgs/{org}/default-labels`, Fyrden's) | What an organization's new repositories start with: at most 100, names unique ignoring case; GitHub's nine until its owners set them (members read them). A user's repositories start with GitHub's nine. `POST /repos/{owner}/{repo}/labels/defaults` copies the account's set into a repository, keeping the names it has |
| On an issue or pull request (`/issues/{number}/labels`, MCP `add_issue_labels`, `set_issue_labels`, `remove_issue_label`, `clear_issue_labels`) | At most 100 (422 `too_many_labels`); names the repository does not have are refused (422 `label_not_found`; GitHub creates them), and removing one it does not have answers 404. Each label added or taken off is an event (`labeled`, `unlabeled`) |
| Assignees (`/issues/{number}/assignees`, MCP `add_assignees`, `remove_assignees`) | Users and agents who can read the repository (an agent capped by its owner's access), by handle; at most 10 (422 `too_many_assignees`); others answer 422 `assignee_no_access`. An assignee hears of it in its activity feed (`assigned`, settled when unassigned or the issue or pull request closes, again when reopened) |
| Milestones (`/milestones`, MCP `list_milestones`, `create_milestone`, ...) | Title 1-256 characters, unique; description up to 65,536; `due_on` in Unix milliseconds (GitHub's is ISO 8601). Listed by due date, then number; one without a due date counts as due after every date (last ascending, first descending); `sort=completeness` is not offered; 1-100 a page. `open_issues` and `closed_issues` count the open and the closed (merged included) issues and pull requests in it as they stand, kept with every change of state, each kind only for a caller that reads it. A deletion takes it off everything at once |
| Reactions (`/issues/{number}/reactions`, `/issues/comments/{id}/reactions`, `/pulls/comments/{id}/reactions`, MCP `add_issue_reaction`, ...) | GitHub's eight contents (`+1`, `-1`, `laugh`, `confused`, `heart`, `hooray`, `rocket`, `eyes`), one per principal, content and target: posting one it has answers it again (201; GitHub answers 200). Anyone who reads the repository reacts, with the permission of the kind it is on (diff comments: `pull_requests:*`); while the conversation is locked, write access and above. Taken back by whoever made it only (another's answers 404 `reaction_not_found`). Issues, pull requests, conversation and diff comments answer `reactions` counts as they stand; a target's deletion takes its reactions with it. Each change is an event (`reaction.created`, `reaction.deleted`) with the target's counts; no webhook (GitHub has none) |


## Webhooks

Repository webhooks (`/repos/{owner}/{repo}/hooks`), for administrators
(`repository_hooks:read` and `:write`). Operating them (the key their
secrets are sealed with, its rotation and restore) is in
[webhooks.md](webhooks.md).

| What | Value |
|---|---|
| Hooks | 20 per repository; repository hooks only |
| Who | Repository administrators. Every hook operation (listing, reading, creating, changing, deleting, pinging, rotating secrets, reading deliveries, redelivering; REST and MCP) also needs `issues:read` and `pull_requests:read`, each checked on its own against the caller's scopes, grant and agent ceilings, since a hook sends issue and pull request contents out and its deliveries keep them; the hook permissions imply neither. Without them: 403 `forbidden`. Hooks made earlier keep delivering |
| Events | `ping` (on creation and `POST …/pings`), `push` (one delivery per push event, listing its ref updates: up to 500 an event, as many as fit in 128 KiB as stored; `refs_count` counts them all and `refs_truncated` says when some are left out). With an `action` each, and `number` (the pull request's): `pull_request` (`opened`, `edited` with `changes`, `closed` (merged or not: `pull_request.merged`), `reopened`, `synchronize`, `ready_for_review`, `converted_to_draft`, `review_requested` and `review_request_removed` with `requested_reviewer`, or `requested_team` for a team, and no `pull_request`), `pull_request_review` (`submitted`, `dismissed`), `pull_request_review_comment` and `issue_comment` (`created`, `edited` with `changes`, `deleted` with the comment's `id` only), and Fyrden's `head_ref_deleted` and `head_ref_restored` on `pull_request` (the head branch gone, or back). A dismissed review's `state` is `DISMISSED`. `pull_request` also has `labeled`, `unlabeled`, `assigned`, `unassigned`, `milestoned`, `demilestoned`, `locked` and `unlocked`, and its `pull_request` carries `labels`, `assignees`, `milestone`, `locked` and `active_lock_reason`. `issues` (`opened`, `edited` with `changes`, `deleted`, `closed`, `reopened`, `assigned`, `unassigned`, `labeled`, `unlabeled`, `locked`, `unlocked`, `milestoned`, `demilestoned`) carries `issue`; `label` (`created`, `edited` with `changes`, `deleted`) carries `label`; `milestone` (`created`, `edited` with `changes`, `opened`, `closed`, `deleted`) carries `milestone` (its `open_issues` and `closed_issues` count issues and pull requests together, as GitHub's). A metadata action also carries what it changed: `label` (id, name, color), `assignee` or `milestone` (number, title), the one removed too. The pull request, issue, review, comment, label or milestone is as the change left it, in the REST API's field names; nothing is looked up when sending. Deviations from GitHub, for now: users are `{id}`; an issue's or pull request's `labels` are `{id}` and its `milestone` `{number}` (their names as the change left them are not kept with it); `issue_comment`'s `issue` has its number, title and state, not its body; a deleted issue carries its number and title, a deleted label its id, name, color and description, a deleted milestone its number, title and state; GitHub's `transferred`, `pinned`, `unpinned`, `typed`, `untyped` and label `archived` are not sent (Fyrden has none of them); times are ISO 8601 |
| Redelivery | `POST …/hooks/{id}/deliveries/{delivery_id}/attempts` (administrators): a `done` or `failed` delivery, while its body is kept (30 days), sent once more with its original body and `webhook-id`, signed with the hook's current secrets at a fresh timestamp. One attempt, not retried; refused while pending, or while a 410 from its receiver is turning the hook off (409), for a cancelled or dropped delivery, once its body is gone, once it has made 50 attempts (its automatic ones included) or for an inactive hook (422), and while the hook has 1,000 deliveries waiting (409). A claim of an earlier attempt still running records nothing for it |
| URL | https, or http for a public repository only; never this deployment's hosts or a private, loopback or link-local address; checked when set and again on every attempt; redirects are refused, not followed. A host whose name changes between the check and the connection is not caught (no DNS rebinding protection is claimed) |
| Signing | Standard Webhooks v1: `webhook-id` (the delivery's id, the same on every attempt), `webhook-timestamp`, `webhook-signature` (HMAC-SHA256 with the hook's secret; both secrets for a week after a rotation, or until the previous one is dropped). The secret (`whsec_…`) is made by the server and shown once (REST only, never over MCP) |
| Payload | Every body says `event` (and `action`), `repository` as it was when the event happened, `sender`, `at` and `position`; deliveries are unordered: `position` (epoch and sequence) orders them. Issue, pull request, review, review comment, conversation comment, label and milestone events (`fyrden_payload: 1`): the entity as the REST API shows it, as of the event (an issue or pull request with its labels, assignees, milestone and reactions, a pull request's with its `number` alongside; a review or review comment with its pull request, a review comment `outdated` as the API answered the change (a deletion's judged without the merge base, as the API judges one it cannot work out), a dismissal's `by` as a user; a comment with its reactions and what it is on, an issue or a pull request as the issue endpoints show one; a label, milestone or comment as it was, once deleted), a synchronize's head `before` and `after`, a review request's `requested_reviewer` (a team's: `requested_team`, `{ id, slug, name }` as asked, and no `requested_reviewer`), what a metadata action touched in full (the label, assignee or milestone, its counts as the change left them), and an edit's `changes`; users as `{ id, login }`, the login read when the body is made (usually seconds after the event; `ghost` for an account being deleted, deleted or unknown); times as ISO 8601. Text of 1 KiB or more (as JSON) is kept once by the repository until a day past the event's deadline and read back into the body; the body is made once, within 7 days of its event (later, the event's webhooks are not made, `expired`), stored before any delivery, and sent unchanged on every attempt and redelivery; up to 25 MiB (larger: not made) (all Proposed). Pushes and pings: Fyrden's own shape (event fields), at most 192 KiB as the server stores it (escaped twice: about 90 KiB of plain JSON; larger: `dropped`) |
| Capturing bodies | Only events that go to a hook are captured, in the change's own transaction: the capture travels in the event (up to 64 KiB inline; longer text kept apart, an issue at every field's limit stays within it), and each text of 1 KiB or more is a row in the repository object, written once however many of a change's events name it and rewritten only to keep it longer. A change hashes such a text once while its cache holds it (an estimated 4 MiB budget, not measured heap, dropped when the change ends; past it, a text is hashed again). Making the body reads the texts in one call to the repository object, the logins in one directory query per 90 users, and stores the body once; the event's deliveries reserve these calls. An invocation making a body holds it with its signing copies and requests, estimated at most 4 times the body (a body at Fyrden's field limits is under 2 MiB; not yet measured on Workers). Fan-out: replacing an issue's 100 labels with 100 others makes 200 events; with 20 hooks, 4,000 deliveries, of which 400 first attempts are made by the effects queue and 3,600 are a webhooks queue message each, about 10,800 queue operations, more than Free's 10,000 a day (they are then late, not lost: see Making deliveries) (all Proposed) |
| Attempts | Each attempt has 10 seconds (lookup, request, the first 4 KiB of the answer). 2xx: done. 408, 429, 5xx, a timeout or an unreachable host: tried again with exponential backoff and jitter from 1 minute up to 6 hours, `Retry-After` honoured up to 1 hour; 8 attempts in all. 410 Gone: failed, and the hook turned off (`disabled_reason`) unless it changed meanwhile. Other 4xx and refused URLs: failed. A deleted or inactive hook: the delivery is cancelled. A private repository's event never goes over http |
| Waiting deliveries | 1,000 per hook; more are `dropped` (visible in the delivery list). This is not a daily capacity: on Workers Free each attempt costs about three queue operations (of 10,000 a day), a few D1 queries and an R2 read |
| Making deliveries | An event's deliveries (one per hook it goes to, made together) are one effect in the effects journal. The events consumer journals it with the event and sends its id to the `fyrden-effects-webhooks` queue (one message for each sink's effects of a consumer invocation, at most 2 webhook effects a message); that queue's consumer makes the deliveries, one message an invocation, and itself makes the first attempt of up to 2 of each event's deliveries (all Proposed); the others' first attempts, and every retry, go through the webhooks queue (see Attempts). An invocation makes at most 32 effects' deliveries, reading at most 1 MiB of their payloads (an event's payload holds its body, up to 192 KiB: 5 of the largest, its first whatever its size), within 900 calls at 7 an event and 7 a first attempt, and starts none after 60 seconds (all Proposed); what it leaves goes back to the queue at once. A first attempt is claimed with the others of its event in one batch (and never once the repository's tombstone is in), its hook read after its claim (one call for the event's first attempts), and it posts the body the effect just stored rather than reading it back; an event's first attempts run side by side, each seen through before a failure of any is reported. A first attempt that cannot be made then (its record not written) is queued instead. The bounds are for wall time and for what waits behind an invocation, not for a CPU limit: a queue consumer gets 30 s of CPU by default on Free as on Paid ([Queues limits](https://developers.cloudflare.com/queues/platform/limits/), read 2026-10-21; Free's 10 ms applies to requests and cron triggers: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)). Measured on Free: making 20 events' deliveries in one invocation took 42 to 86 ms of CPU (2026-10-17, `wrangler tail`), about 2 to 4 ms an event, and events consumer invocations of 136 ms were not stopped (2026-10-21); a message names 2 so that messages run side by side. Messages are taken side by side (Queues runs up to 250 consumer invocations at once, scaling with the backlog: [platform limit](https://developers.cloudflare.com/queues/platform/limits/)). A failed attempt to make them backs off (30 s, doubling to an hour, 20 attempts, each claim counting as one) and is sent again as a message delayed until it is due; the journal, not the message, decides. A message lost, never sent (the consumer stopped between journaling and sending) or whose invocation died leaves its effects overdue: a minute after they were journaled when never sent, 10 minutes past their due time once sent, at their claim's end (5 minutes) when claimed; the effects cron (every 5 minutes) sends their messages again, 100 a run, the longest overdue first (all Proposed). Those an invocation made but had not marked done are made again with the same ids, as after any lost acknowledgement. An effect whose source repository was deleted, restored to an earlier state or transferred since it was journaled is ended without its deliveries (`effects.invalidated`). Failures to send, claim or deliver are logged and counted (`effects.dispatch`, `effects.consume`, `effects.recover`; see metrics.md); `GET /healthz` reports `checks.effects` as not ok, without failing the health check, once the oldest pending effect is 15 minutes overdue, or while an effect failed for good (not ended because its source went) in the last hour (both Proposed), with only that age (`overdueS`) and that flag (`failed`). On Workers Free each queue message costs about 3 of the 10,000 queue operations a day ([pricing](https://developers.cloudflare.com/queues/platform/pricing/)): an event with webhooks costs its events message, a share of a webhook effects message, and one message per retry and per first attempt past its first 2 deliveries (an estimate: the deployed figures are in the Free run's record). What happens to sends once the day's operations are spent is not documented by Cloudflare; whatever it is, a refused send leaves the effect journaled and overdue, the effects cron sends it again every 5 minutes, and `checks.effects` reports it late, so deliveries resume, late, once sends are accepted again (a refused send spends no attempt; a delayed message is sent at most 12 hours ahead, within Free's 24-hour message retention: [platform limit](https://developers.cloudflare.com/queues/platform/limits/)) |
| Repairing effects | An effect that failed for good (its attempts spent, for instance while a feed or a repository object could not answer for hours) stays failed: nothing retries it. While what it delivers can still matter (within 7 days of its change, Proposed: feeds drop older entries on arrival), an operator reopens it with `fyrden effects repair --sink feed\|webhooks\|references --since <date>`, which counts them, and with `--yes` reopens up to 1,000 a run (the oldest first; run again for more), keeping their ids and what they carry (their attempts count again from one, so one ever claimed still counts as claimed when its repository is deleted); the effects cron sends them with the other overdue effects, 100 a run every 5 minutes, the longest overdue first (1,000 take at least 50 minutes, so a page near its deadline may still expire), and their claims check their sources again, so one whose repository was deleted or restored since is ended, not delivered, as is a feed or webhook effect whose repository was transferred (references stand across transfers). A webhook effect reopened makes its event's deliveries again only where they are missing or still waiting: deliveries that failed on their own are not reopened (send them again with `POST /repos/{owner}/{repo}/hooks/{hook_id}/deliveries/{delivery_id}/attempts`), and one whose body was never stored (`payload_missing`) cannot be sent again. Effects ended on purpose are never reopened: those whose source moved on (`invalidated:`), a feed page past its deadline (`expired:`) or gone (`page missing:`), or one of a sink the deployment no longer has. Past 7 days nothing is repairable; the effect stays failed, and its recipients' feeds go without it |
| Delivery log | Deliveries, their attempts (URL, status, duration, 4 KiB of the answer, no request header values; 50 at most a delivery) and their bodies are kept 30 days, then deleted (bodies first) by the cron. Proposed capacity: each run of the effects cron (every 5 minutes) deletes up to 1,000 expired deliveries with their attempts, each event's together (they share its body, deleted with the last of them), in three D1 queries and one bulk R2 delete of their bodies (a dropped delivery's body was never stored and costs none): 288,000 a day. That is more than Workers Free lets a deployment make: every delivery writes at least its own D1 row, and D1 on Free writes 100,000 rows a day ([verified](https://developers.cloudflare.com/d1/platform/pricing/)), however fast deliveries are made (a unit test keeps the two in step). A deployment making more than 288,000 a day (Workers Paid) keeps a backlog of expired deliveries, worked off at that rate. A delivery's details list its attempts newest first, 30 a page (`per_page` up to 100, `cursor` for older ones) |
| Loss boundary | Events reach deliveries through the events queue: an outage of its consumer longer than the queue keeps messages (24 hours on Free) loses those events before any delivery exists |

## Activity feed

Each user and agent has an activity feed of the pull requests that need it
or that it takes part in: `GET /feed`, `GET /feed/sync` and
`POST /feed/ack` (MCP tools `get_feed`, `sync_feed`, `ack_feed_item`), for
any user or agent token or a signed-in session, without a permission of
their own.

| What | Value |
|---|---|
| Whose feed | The token's principal's: an agent's own token reads the agent's feed; a delegated token, whichever agent of its chain holds it, reads the user's; a session reads its user's. Acknowledgements are the feed's, shared by everyone who reads it |
| Read-time checks | Every list, sync and acknowledgement checks each repository of its items again: the repository must exist and the caller must have `pull_requests:read` there now, within its token's scopes and repositories (a delegated token's grant) and its agents' owners' rights, all in one call to the repository's object, which also gives what the page's members say. Items it fails are left out without saying how many: cursors only ever name items the caller was shown (or where it started), so an answer, its cursors and its ETag change only when what the caller may see does. One answer checks at most 100 repositories and reads at most 1,000 items (Proposed); past that, or when a check cannot be made, it ends at the last item shown and never moves past an item not checked. When a check finds for certain that the feed's owner itself cannot read a repository (it is gone from the directory or its object, or its owner is disabled; or the owner's own access, with its agents' owners' rights for an agent, says so by the account's ACL snapshot the repository decided with, pulled at most 60 seconds before), the feed forgets that repository's items as losing access does (see Lost access), whichever token read it: up to when that snapshot was pulled (or the repository was found gone), as a notice of that ACL version would, so never past a newer version's notice, and activity of access given back since that time stays. A token's own limits (scopes, repositories) or a delegated token's grant forget nothing, and a check that cannot be sure (the repository has no usable snapshot, as when the account's object fails to answer, or a transfer is moving it, its collaborators let go by the old account before the new one takes them) counts as a check not made: it ends the answer there and forgets nothing. So however many such items come first, a later answer gets past them (one more answer per 100 such repositories or 1,000 such items), and a cursor never names one. Such an answer looks like one that found nothing new: `poll_after_ms` is 0 only after a full page. What a caller can still tell: items it may see can come an answer or more later than without the others, and sequence numbers in cursors of items shown count every change of the feed. A sync whose checks run out on such repositories answers `complete: false` once, its cursor then the feed's start, while their items are forgotten; the next sync answers `complete: true` with the same items and a cursor after the greatest of them. A known limit: a delegated token whose acting agents' owners cannot read more than a budget of repositories its user reads (so nothing is forgotten) stays behind their items until retention or the cap removes them. An acknowledgement of an item the caller may not see is 404 |
| Items | One per repository, thread and kind (`review_requested`, `changes_requested`, `approved`, `merge_conflict`, `mention`, `activity`), updated in place. A change applies only from a newer version of the thread (ordered by the repository's restore generation, then the thread's version: a restored repository's versions start again, and are newer than any from before; a delivery from before the restore arriving late changes nothing; an `activity` item keeps only the newest generation's members), so duplicate and reordered deliveries leave the same item. An entry that only resolves an item the feed has not shown shows nothing: it is kept as an unseen tombstone (not listed, synced or counted in the cap), so an older entry that opens the item later shows it with the newer state rather than reopening it. An `activity` item gathers the ids of its comments and reviews: the greatest 100, `members_truncated` once any was dropped. An `activity` item displays its greatest member (ordered by id, longer ids greater) and that member's author and the author's access, whatever order its comments arrive in. Items hold ids, not text: the excerpt is read from the repository when the item is read, with the same call that checks access (at most 100 members a call), so an edit shows at once and a deleted comment shows none. A change made by the owner itself (`silent`) still updates its item, reopening it included, without a notification |
| Mentions | `@handle` of an active user or agent who reads the repository, in a pull request's description, a comment, a review or a review comment (an edit tells only the handles it adds); 50 a text at most. Read as the page shows the text (GitHub-flavored Markdown): not in code, link targets, images or footnotes. Only a text's first 16,384 characters are read, and a text that would be costly to parse (more than 256 emphasis delimiters, 256 opening brackets, or 128 quote and list markers) mentions no one |
| Order and cursors | Every change of an item, an acknowledgement included, takes the feed's next sequence number, so following `next_cursor` never skips a change, however late it arrives; a changed item comes again. Cursors are opaque (`base64url` of a version, the feed's epoch and a sequence number, and the count of quiet answers, see Polling). The epoch includes the restore generation the directory keeps for the feed (`source_epochs`, key `feed:<principal id>`): a restore of the feed's object allocates the next one there, as for a repository's, so cursors made before it expire. A feed object reads the directory once an instance, before its first call or alarm does anything (that generation, and whether its principal is being deleted, whose feed it then retires): a cold feed's first delivery makes one more D1 query, and while the directory cannot be read, deliveries to cold feeds fail and are retried as any failed delivery is, and a retention alarm waits a minute (Proposed) and tries again. A cursor the API hands out is never below the low watermark: retention deletes the feed's oldest changes first, so nothing anyone may see is before it (the watermark itself is the feed's, not the caller's). `poll_after_ms`: 0 after a full page, else see Polling |
| Polling | `poll_after_ms` is 30 seconds after an answer that showed something, or a sync, and doubles with each answer in a row that showed nothing, up to 30 minutes (both Proposed): 60 seconds, 2, 4, 8 and 16 minutes, then 30. The count travels in the cursor (`q`, at most 6), so nothing is stored per poll, and at the ceiling a quiet feed's answer, cursor and ETag stay the same (304 with `If-None-Match`). It counts only what the caller sees: an answer that showed nothing is quiet whatever it did not show, one that stopped short on items the caller may not see included. Each poll is a request to the feed's Durable Object; a quiet poll is only that one (no repository is checked). Workers Free allows 100,000 Durable Object requests a day, each RPC call to a stub one (verified, <https://developers.cloudflare.com/durable-objects/platform/pricing/>, 2026-10-16). At a fixed 30 seconds a client makes 2,880 polls a day, so 35 clients polling all day would exceed it. With the backoff (arithmetic, not measured) an idle client makes 6 polls in the 31.5 minutes after the last answer that showed something, then at most 48 a day: about 53, so 1,000 idle clients make about 53,000 requests a day, roughly half of Free's allowance, before deliveries, acknowledgements, repository checks and alarms; feed reads alone would take all of it at about 2,000 idle clients. A feed that changes between every poll keeps its client at 30 seconds: the cost follows activity. A client may poll later than `poll_after_ms`, never sooner |
| ETag | `GET /feed` carries an ETag of its answer (which holds only what the caller may see); a request with a matching `If-None-Match` gets 304. `Cache-Control: private, no-cache` |
| Retention | 7 days from an item's or tombstone's last change, and 5,000 items a feed (the ones changed longest ago go first), both Proposed; entries for events older than 7 days are dropped on arrival. An item the cap deletes leaves a fence at the version it was at (kept until its last event is 7 days old), so a late or repeated delivery of that version or an older one does not bring it back, reopened or without its acknowledgement; a newer version shows it again as a new item. A feed keeps at most 1,000 such fences (Proposed), those of the oldest events going first: beyond 1,000 cap evictions within the 7 days, a very late duplicate delivery of an item evicted longer ago can show that item again, obsolete (never a new delivery lost). A cursor from before what retention deleted, from another epoch or past the feed's head is refused with 410 `cursor_expired` and `resync: /api/feed/sync` |
| Lost access | When a principal loses read access to repositories (removed as a collaborator, from an organization or from a team, or a team's grant removed), the account tells with an event, and the principal's feed deletes those repositories' items last changed up to then, and takes the comments and reviews made up to then out of the items that changed since (each member keeps when it was made), whichever arrives first, the notice or the newer activity. A mark per repository drops older entries arriving later (kept 7 days). It records the account and its restore generation and ACL version: a later notice of the same account counts only when newer by those, or of the same version with a later time (a read's check counts from when its snapshot was pulled, which can be before the change that version made), and one of another account (the repository was transferred) when its time is later. A member's removal names, in events of at most 100 repositories, every repository the organization holds when it is removed, but those the member is a collaborator of and those the organization released before the removal: read from the directory just before the change, in one read, its own and those a transfer is moving away and the organization has not let go of yet. Delivery purges exactly those, however they move meanwhile. One transferred away after the removal is named all the same (the member lost it anyway). One released between the read and the removal is not: its release's own notice, which named the member with an earlier time, purges it. One that arrives between the read and the removal (created, or transferred in) is not named either: the member's feed forgets it when next read, finding the member cannot read it; if the member can read it again by then, its older items stay, which shows the member nothing it may not read. Public repositories are left out of every purge: anyone still reads them. Access given back brings new items, never the old ones. Cursors are not expired by it: the read-time checks already left those items out. A read that finds the owner cannot read a repository forgets it the same way (see Read-time checks): its mark is the ACL version it was decided by, judged against the account's notices as theirs are; one found gone has a mark of no account, judged by time |
| Sync | Open P0 items, then P1 items changed in the last 7 days, newest first: 500 at most (Proposed), and the cursor to follow from (after the greatest item shown). `complete` is false when more were left out or not every repository could be checked; the cursor is then the feed's start (never below the low watermark) |
| Acknowledgement | `{item_key, epoch, version}`, the item's version as it shows it (ordered by epoch, then version): a version the item does not have yet is refused (409 `version_ahead`); an older one than already acknowledged changes nothing |
| Participants | A thread keeps up to 1,000 participants (Proposed): its author, commenters, the mentioned and assignees, the first to join kept. A join past the cap, by one not already participating, is refused and counted (`feed.participants_overflow`, and per thread in the repository object); the mentioned, assigned and asked to review are told of what names them whatever the cap |
| Audience pages | An event carries up to 100 recipients (things to act on first, then participants in the order they joined). The repository keeps the rest, in the change's transaction, as up to 128 pages of up to 100 entries and 64 KiB each (enough for a pull request's requested teams' 10,000 members, a thread's 1,000 participants, the 50 an event may mention and those it names directly), and the event names them with their sizes and a delivery deadline: 7 days after the change, when feeds stop taking its entries. Each page is a feed effect of its own (a call to read it, then one per recipient), read only while the event is still the repository's (not once it is deleted, restored to an earlier state or transferred: such a page's effect ends `invalidated`), and as the event names it; a page past the deadline, or gone, ends its effect failed for good. Pages are deleted a day after the deadline. Recipients past 128 pages are counted, not kept (`feed.audience_dropped`); the bounds above keep every event within them. A version from before pages delivers only the recipients an event carries: once events with pages are made, it is no version to go back to |
| Settlements | An event ending review requests (withdrawn, completed by a review, a merge, or a job's settling of requests a transfer, restore or vanished team left) carries the entries settling them in its data: blocks of up to 100 recipients holding all they deliver (stored with the event when large: 2,000 recipients, about 312 KB, travel that way). Each block is a feed effect of its own that stands across a transfer of the repository (another owner's ordinary effects are dropped), so an item someone could still read never stays open once its request ended; a restore drops them like any effect, leaving the restored state's own settling (the job above) or the feed's retention. A block reads no page: nothing is kept for it once the event is written |
| Delivery | What an event means for feeds travels with it (its carried recipients, and its pages' manifest) and is journaled as one effect per event and page, not one row per recipient. Delivering a batch of them calls each recipient's feed once with all its entries, up to 32 calls under way at once (Proposed); an effect naming a recipient whose call failed is retried, the others are done, and each failed effect keeps its own error. A revocation becomes effects of at most 100 principals each, so no effect makes more than 101 calls (a page of further recipients makes one more, to read it). The events consumer delivers up to 8 feed effects an invocation itself, to at most 50 recipients in all and never a page of further recipients (all Proposed: a feed call takes about 30 ms of wall time on Free, measured 2026-10-21, and other sources' events wait behind them), after sending the rest, and the other sinks' effects, to their queues (`fyrden-effects-feed`: up to 8 effects a message, each page of further recipients a message of its own, up to 4 messages an invocation so an event's pages share its calls; see Making deliveries under webhooks for the bounds, retries and recovery they share). An invocation keeps to 900 calls to Durable Objects, D1, R2 and queues (Proposed, of the 1,000 Free allows): it keeps 6 for sending its messages' effects, each message first sets aside what applying it costs (its lookup, its batch, reading its stored events), and inline deliveries take only what is left once the later messages' share is kept (6 calls, then one per recipient); the rest go to the queue. Counted in local integration tests (2026-10-20), with the recipients' share raised to the invocation's calls, as those tests do to bound calls alone: five messages of fifty stored events, two of each for 100 recipients, make 250 payload reads, 600 feed calls (six effects inline, four sent) and 13 D1 queries. Without stored events, a consumer invocation of five messages of three feed events for 100 recipients makes 13 D1 queries (a lookup and a batch per message, marking the seven effects it sent, a claim and a mark for the eight it delivered) and 100 feed calls of 8 entries; the feed queue's consumer then delivers the seven in 2 D1 queries and 100 calls. Entries reach feeds within the consumer's invocation, or within seconds through the feed's queue |
| Free capacity | On Workers Free a deployment's Durable Objects write at most 100,000 rows a day (UTC; [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)); past that every statement that writes fails until midnight UTC, and changes (comments, pushes, merges) fail with them. Feeds are the largest share: delivering an entry writes 4 rows in its recipient's feed (local count, 2026-10-21), so a comment telling a thread's 350 participants writes about 1,400 rows in feeds (and 18 in its repository), and 100,000 rows are about 25,000 feed entries a day for everything else too. An acceptance run on Free (2026-10-21) spent the day's rows creating and deleting repositories, granting 700 collaborators and fanning comments out to 350 recipients. A Durable Object that wakes with nothing to migrate only reads, so reads that write nothing keep working once the day's rows are spent; these do write and fail until midnight UTC: clone and fetch (each takes read leases on the packs it serves), authorization once a repository's ACL snapshot is due for a refresh (minutes), feed reads that find items of deleted repositories or issues to forget, and a pull request's files on first view (their list is kept). Paid has no daily cap (rows written are billed) |
| Cursors and hidden items | A known limit: a cursor can move without anything the caller may see changing. When retention deletes items the caller cannot see, the low watermark passes them, and the cursors (and so the ETag) the caller gets move up to it |
| Late purges of large items | A known limit: a purge arriving after an activity item has collected more than 100 members can leave it with fewer than a purge arriving first would, since the item keeps only its greatest 100 and those made before the purge then leave it |

## Idempotent requests

A REST write (any method but GET) sent with an `Idempotency-Key` header runs
once per token and key; it is optional, as on GitHub. MCP tool calls take no
key. The key is checked after the token (revocation included), the rate
limit, the token's scopes and the input; a replay returns the answer the
same token already got, without checking its access to the repository
again.

| What | Value |
|---|---|
| Key | 1-255 printable ASCII characters (else 422 `invalid_idempotency_key`), per token |
| Kept | 24 hours, then forgotten (the cron deletes expired keys) |
| A retry of the same request | The first answer again, with `Idempotent-Replayed: true`; nothing runs twice |
| The same key, another request | 422 `idempotency_key_reused` (another operation, or another input) |
| While the first still runs | 409 `idempotency_key_in_use` with `Retry-After: 5` |
| When the first may or may not have taken effect | 409 `idempotent_outcome_unknown`: it failed unexpectedly, or was still marked running after 10 minutes. Check, then use a new key |
| Answers not kept | 401, 403, 408, 429, `busy`, `network_busy` (whatever the request began was undone: a retry runs again), and an upload's completion while it is still indexing |
| Answers with a secret (minting a token) | Not kept: a retry answers 409 `secret_already_disclosed` naming the token made |
| Largest answer kept | 256 KiB; a larger one answers a retry 409 `idempotent_replay_unavailable` |

## Configuration variables

Set these as Worker variables of `fyrden-api`: add a `"vars"` object to
`apps/api/wrangler.jsonc` before `fyrden deploy` (variables set only in the
Cloudflare dashboard are replaced by the next deploy unless `keep_vars` is set,
see [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)).
A value that is missing, not a whole number, or below the minimum is ignored
and the default applies.

| Variable | Default | Minimum | What it controls |
|---|---|---|---|
| `FYRDEN_PLAN` | unset (Free) | | `paid` selects Paid serving; anything else is Free. `fyrden deploy --plan` sets it |
| `FYRDEN_OWN_HOSTS` | unset | | Extra hostnames of this deployment (comma separated), refused as import sources |
| `GIT_PUSH_MAX_BODY_BYTES` | 104,857,600 | 0 | Largest push request the Worker accepts |
| `GIT_PUSH_MAX_GZIP_BODY_BYTES` | 33,554,432 (32 MiB) | 0 | Largest inflated size of a compressed push request |
| `GIT_PUSH_INDEX_BUDGET_MS` | 10,000 | 0 | Indexing time per request before the alarm takes over |
| `GIT_PUSH_POLL_MS` | 1,000 | 0 | First wait before the Worker asks whether indexing is done |
| `GIT_PUSH_MAX_POLL_MS` | 5,000 | 0 | Longest wait between two such calls |
| `GIT_PUSH_MAX_WAIT_MS` | 900,000 (15 min) | 0 | Longest the Worker waits for indexing before giving up |
| `GIT_PACK_CAP` | 16 | 2 | Most own live packs per repository |
| `GIT_TAIL_MERGE_MAX_BYTES` | 67,108,864 (64 MiB) | 1 | Most bytes one merge at push time copies |
| `GIT_TAIL_MERGE_MAX_OBJECTS` | 500,000 | 1 | Most objects one merge at push time copies |
| `GIT_UPLOAD_PART_BYTES` | 16,777,216 (16 MiB) | 5,242,880 | Part size of upload sessions |
| `GIT_UPLOAD_MAX_BYTES` | 8,589,934,592 (8 GiB) | 32 | Largest pack per upload session |
| `GIT_UPLOAD_COMPLETE_WAIT_MS` | 20,000 | 0 | How long one `complete` call waits |
| `GIT_IMPORT_MAX_BYTES` | 4,294,967,296 (4 GiB) | 32 | Largest pack an import fetches |
| `GIT_IMPORT_MAX_MS` | 600,000 (10 min) | 1,000 | Longest an import's fetch may take |
| `GIT_IMPORT_DISCOVERY_MS` | 30,000 | 1,000 | Longest an import's source may take to list its branches and tags |
| `GIT_IMPORT_IDLE_MS` | 60,000 | 1,000 | Longest an import's source may send nothing while the pack streams |
| `GIT_IMPORT_MIN_BYTES_PER_SECOND` | 16,384 (16 KiB/s) | 0 | Least an import's pack must bring per second, over every minute after its first two; 0 for no floor |
| `QUOTA_MAX_REPOS` | 1,000 | 0 | Active repositories an account may have, unless an administrator set its own |
| `QUOTA_MAX_STORAGE_BYTES` | 1,073,741,824 (1 GiB) | 0 | Bytes an account's pushes may store, unless an administrator set its own |
| `QUOTA_AGENT_MAX_REPOS` | 100 | 0 | Active repositories one agent may have created acting for users |
| `AGENT_REPO_TTL_DAYS` | 7 | 1 | Days until a repository an agent creates expires, unless it gives an expiry |

`fyrden-api` also needs the secret `BOOTSTRAP_SECRET`, which `fyrden deploy`
sets. The `fyrden` CLI reads `FYRDEN_TOKEN` (the token for `fyrden push`),
`FYRDEN_PUSH_BODY_LIMIT` (its body limit) and `FYRDEN_GIT_BINARY` (the `git`
to run) from its own environment.

## Not supported

- Git LFS.
- SHA-256 repositories (`object-format=sha256`); repositories use SHA-1.
- Protocol v0 and v1 for fetch and clone, and the dumb HTTP protocol.
- Server-side hooks (`pre-receive`, `update`, `post-receive`).
- Partial clone (`--filter`) and the other fetch features listed above.
- SSH; git is served over HTTPS.
