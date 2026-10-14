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

Not measured yet: the CPU needed to parse the largest packs, as the first
parsing pass of one pack runs in one invocation.

Each Durable Object has 128 MB of memory
([platform limit](https://developers.cloudflare.com/workers/platform/limits/#memory));
Fyrden's git operations in one repository share a 72 MiB pool (default) and
wait for room rather than exceed it.

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
- The imported pack is checked like any push.

## Maintenance and retention

Repack, garbage collection and cleanup run in each repository's Durable Object
alarm. These periods are defaults and are not configurable in this version:

| What | When it is deleted |
|---|---|
| Packs replaced by a repack or collection | 30 days after they were replaced, and never while a clone that started before still reads them |
| Unreachable objects (moved to a garbage pack by collection) | Condemned 1 day after the garbage pack was last touched, then deleted after the 30-day retention |
| Reflog entries | After 90 days, by a pass that commits schedule (at most daily). Objects reachable only from the reflog are kept until then |
| Uncommitted uploads and their stored bytes | 24 hours after the upload started |
| Stored fetch responses (regenerated or framed packs) | 1 hour after the last clone that read them |
| Outputs of an interrupted repack | 24 hours |
| An event's stored data (a change too large for one queue message keeps its data in the repository, for consumers to fetch) | 7 days after the event was sent; never while it waits to be sent |

A repack that replaces packs a clone is reading waits up to 1 hour for that
clone before it switches; the old packs stay readable either way.

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
| One file | 24 MiB |
| Zip entries | 65,535 (no ZIP64); use tar.gz past that |
| Directory depth | A path's directories, with their names, fit in 1 MiB of build state (about 2,500 levels of 255-byte names); deeper fails with `archive_failed` |
| Building | 8 MiB encoded or 5,000 entries per slice, at most 300 slices (a commit with very many small files fails: clone it); a request builds for up to 5 seconds, then answers 202 with `Retry-After: 5` until it is ready |
| Kept | 7 days, then deleted when the repository next builds one (not while a download that started in the last hour may still read it); deleted with the repository |
| Dates | tar holds dates up to 2242, zip 1980 to 2107; later or earlier commit dates are written as the nearest one |
| Zip names | Flagged UTF-8 when they are; other bytes are written as they are, without the flag (as git does) |
| tar.gz | Several gzip members (any gzip reader reads them as one stream); pax headers for long names; the commit id in a pax global header, as `git archive` writes |

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
| Committer | The caller, as `<handle> <id@users.noreply.host>`; `author` may name someone else |
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
| Holds | A reservation lasts the push's longest wait plus 15 minutes (a chunked upload's session plus an hour), a commit's hold 30 minutes; a lapsed one counts nothing. A commit whose confirmation is lost goes uncounted rather than counted twice |
| Forks | A fork that loses the last slot to a concurrent create is deleted again |

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
| Stays behind | The old organization's team grants |
| The old path | Redirects to the new one (for the API, clone, fetch and push), until the old account uses the name again |
| While it moves | Pushes, file writes, renames, settings, rulesets and deletion are refused (409 `repo_transferring`, or "being transferred" to git); reads go on |
| Refused | 409 `name_taken`, 403 `quota_exceeded` (repositories or storage), 422 `same_owner`, 409 `transfer_in_progress` (another transfer or a deletion is under way, or the owner changed since the request was authorized), 409 `repo_generating` (still being generated from a template), 422 `too_many_collaborators` (the new account's members and the repository's collaborators would exceed one access list's 10,000 entries); a refused transfer leaves the repository as it was |
| Storage of an upload committing as it moves | Not counted (its confirmation reaches the old account, which no longer counts the repository) |
| Admission checks | The new account's repository count is enforced when the directory moves the repository; its storage quota and access-list size are checked when the transfer starts and before it moves, not reserved: concurrent transfers (or members added meanwhile) can take an account past them, as an upload in flight can |
| One runner at a time | A runner holds a transfer for 60 seconds; one that dies frees it after that |
| Caches | Other Workers may resolve the old path to the old owner for up to 30 seconds; access is decided by the repository, which knows its owner, and changes authorized for the old owner are refused |
| Read model | Events from before the transfer are refused once it lands (a new owner generation) |
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
| Revocation | Revoking a grant revokes the grants passed down from it; tokens under them, an agent's token its owner revokes (`DELETE /agents/{agent}/tokens/{token_id}`; `GET /agents/{agent}/tokens` lists them), and an agent's tokens once it (or its owner) is disabled, stop at once for writes and within 30 seconds for reads |
| Delegated tokens may not | Make or revoke grants, mint tokens, change who has access (collaborators, team repositories), or call user-only operations (create repositories, transfer, stars, signing keys) |
| An agent's own token | Never wider than the token that minted it (scopes and repositories) |
| Token endpoint | Bodies up to 16 KiB; rate limited per client address |
| Rulesets | Rules for `agent` actors apply to an agent acting for a user |
| Not yet | Grants from organizations, and git tokens under a grant |

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
| Organization policy | `PATCH /orgs/{org}` `require_dpop`: the organization's agents' API tokens are taken only DPoP-bound (at once for writes, within 30 seconds for reads, like a revocation), and token exchange for them needs a proof (git tokens only where git itself uses them, since git cannot send a proof; at the REST API or MCP they are refused like any other) |
| Authorization | `GET /oauth/authorize`: code flow only, PKCE `S256` required, `resource` required (`{origin}/mcp` or `{origin}/api`), scopes are Fyrden permissions; the signed-in user consents on a Fyrden page; the answer must come from Fyrden's own origin |
| Codes | Single use, 60 seconds; redeemed again, the tokens they issued are revoked |
| Access tokens | Type `oat`, 1 hour, accepted only at their resource (RFC 8707) |
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
2026-07-28): a tool per API operation, and repository files as resources
(`fyrden://repos/{owner}/{repo}/files/{+path}`). Each request builds its own
server; each tool's JSON Schema is converted once per Worker isolate and
shared after that.

| What | Value |
|---|---|
| Tools | 63; `tools/list` answers about 136 KB |
| Browser requests | Only from the deployment's own hosts (`Origin`, against DNS rebinding): on `workers.dev`, both Fyrden Workers on the request's account subdomain; the hosts in `FYRDEN_OWN_HOSTS`; loopback. Native clients send no `Origin` |
| Request body | 8 MiB, as REST |
| CPU per request | **Measured** on Workers Free (2026-10-14, `wrangler tail`): `tools/list` 5 ms on a warm isolate (45 to 160 ms before tool schemas were converted once per isolate); `whoami` 32 ms and `resources/read` 16 ms (measured before that change) |
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
| Pages | Sign in, repositories (list, create), files (browse, view, edit, add, delete), README (GitHub-flavored Markdown with Mermaid diagrams), commits with their verification, clone URL, archives, repository settings, tokens, agents and delegation grants |
| Forms | Taken only from the web origin's own pages (`Origin`) |
| Markdown | Raw HTML escaped, unsafe link protocols dropped; Mermaid drawn in the browser in strict mode |
| Content Security Policy | Scripts only from the origin, plus React Router's inline scripts with a new nonce per response; styles may be inline (Mermaid); images, fonts and everything else only from the origin (and `data:`); no plugins, `<base>`, foreign form targets or framing. A README's images from other sites are not shown: with no image proxy, they would tell their author who viewed a private repository |
| Raw files | Served as downloads (`application/octet-stream`, `nosniff`, a sandboxing CSP), never rendered on the origin |
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
| Verified | A valid signature by the platform's key, current or retired; or by a key a user added (`POST /user/ssh_signing_keys`) on a commit whose committer email is that user's no-reply address, `<user id>@users.noreply.<host>` (else `bad_email`) |
| Users' signing keys | Ed25519 only; 100 per user; a key belongs to one user (`key_in_use`); deleting one unverifies what it signed |
| Not verified | `unsigned`, `unknown_key` (valid, by a key Fyrden does not know), `invalid` (the commit or signature was changed), `malformed_signature`, `unknown_signature_type` (OpenPGP, or a key type other than Ed25519) |
| Without `SIGNING_KEY` | Fyrden's commits are unsigned |
| A malformed `SIGNING_KEY` | Writes it would sign are refused (logged); reading and verifying go on, with the keys that can be read |
| Signatures read | 64 KiB at most; a longer `gpgsig` is `malformed_signature`, not shown |

## Rulesets

Repository rulesets (`/repos/{owner}/{repo}/rulesets`, GitHub's shape) hold
rules on the branches or tags whose full names match: `creation`, `update`,
`deletion`, `non_fast_forward`, `required_signatures`, `pull_request` (no
direct change at all; changes come through pull requests). Bypass is by
repository role; Fyrden's `actor_types` limits a ruleset to principal types
(`["agent"]` with `pull_request`: agents must use pull requests).

| What | Value |
|---|---|
| Rulesets per repository | 50 |
| Checked before anything is stored | `creation`, `update`, `deletion`, `pull_request`: a push whose every command is refused is answered before its body reaches R2 (repositories with such a ruleset read the push's command section first, up to 1 MiB; of a gzip body, its first 64 KiB, inflated to at most 1 MiB; a command section past either bound is checked at the commit only; others stream it to R2 untouched); an upload session or a file write a rule refuses answers 409 `ruleset_violation`; an import a rule refuses fails after listing the source's refs, before fetching |
| Checked at the commit | Every rule, with the rulesets current then (a change of the rulesets, the default branch or the pusher's role in between refuses the push; push again): force pushes against the commit graph, signatures of every new commit (reachable from the new tip, not from that ref's old one; ancestors from other branches included) |
| Required signatures | Branch rulesets only. Each new commit verified as the API shows it (platform key, or a user's key on that user's commits); at most 1,000 new commits per ref update (and 20,000 commits walked to find them), more is refused (push in parts); commits are read from the repository's packs and the push's own, once a push however many refs share them, within 800 R2 reads for the whole push (a commit not read by then is refused as `unreadable`) |
| Default branch | `~DEFAULT_BRANCH` names the current default branch and, for an import, the one it sets |
| Refusal text | 2,000 bytes at most per ref |
| Refusals | `ng <ref> <reason> (ruleset "<name>")`; an atomic push fails as a whole |
| `evaluate` | Reported to nobody yet; does not block |

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
| `QUOTA_MAX_REPOS` | 1,000 | 0 | Active repositories an account may have, unless an administrator set its own |
| `QUOTA_MAX_STORAGE_BYTES` | 1,073,741,824 (1 GiB) | 0 | Bytes an account's pushes may store, unless an administrator set its own |

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
