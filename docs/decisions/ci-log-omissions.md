# Omit job log rows too large for any request

The runner protocol plan's D10 said an UpdateLog ack covers only rows that are
stored. That left one case stuck for good. Both supported runners (gitea/runner
v6.0.0 and v5.4.1) send each printed line as one row with no length limit
(read in `act/common/line_writer.go` and `internal/pkg/report/reporter.go` at
both tags). The API reads at most 4 MiB of a request body. A row that does not
fit in that read, even as the first row of a request, can never be stored, so
the ack never passes it. Every later row stays unacked, the runner resends all
of them on each call, and the task's log loses its tail.

This changes the contract. An ack of N now means each position below N holds
either its stored row or a stored omission record. The one exception is
unchanged: v5.4.1's final sentinel (one empty row in a whole final call,
`isFinalSentinel`) is acked and never stored, so its position has no line. The
record is written the
same way as a chunk of rows: its own R2 object under a key no other write uses,
then the manifest row, the ack and the omission count in one SQLite transaction
with the same compare-and-set and erasure check. A store that loses deletes
only its own object. The busy guard and the memory pool admission still run
before the body is decoded.

## When a row is omitted

Only on positive evidence from the decoder (`oversizedFirstRow` in
`apps/api/src/runner/proto/messages.ts`). All of these must hold:

- the body was cut by the read;
- the cut falls inside the bytes of the request's first row, after its tag and
  length were read;
- only task ids (field 1) and indexes (field 2) come before that row;
- the shortest request that carries the row from that index is longer than the
  bytes read.

The shortest request is computed from the values, not from the bytes sent:
the task id and index read last (protobuf's rule for a repeated scalar), each
once with a one-byte tag and its shortest varint, left out when 0, then the
row's one-byte tag, its shortest length varint and its declared length
(`shortestFirstRowRequest`). The comparison with the actual position of the
cut is not enough on its own. A reader takes repeated fields, padded varints
and an index of 0 written out as the same request in more bytes, so a row that
fits a canonical request of 4 MiB could be cut inside its bytes. Such a request
is held, never omitted. The computation is a fixed number of steps; nothing is
allocated from the declared length.

The API accepts the evidence only from a prefix of the full 4 MiB, and
`decideLogFlush` omits only when the request starts at the stored ack and
decoded no row. So no request from that index, however it is framed, brings
the row within the 4 MiB the API reads.

The row's own encoding is taken as sent: its declared length counts every byte
of it, whatever its fields are. A task id or index written again after the cut
cannot be seen; the decoder uses the values read before the row, as it does for
rows of any cut body.

A cut body with no decoded row is not enough. A valid request can carry a large
unknown field before a small first row, and its cut looks the same. So can a
cut in the row's tag or length. Those are held as before. A row cut only
because rows before it filled the read is not omitted either: the request
stores its complete new rows at once, and the cut row comes first in the next
call, where it fits or is proven too large. A request below the ack (a resend
after a lost answer) is held at the ack.

The cut row is never decoded. The record keeps the row's declared size from its
framing, not its content or time, so invalid UTF-8 inside an omitted row is not
refused. A complete row that is malformed still makes the whole request
`invalid_argument`.

## The stored shape

Each NDJSON line of a chunk is a `StoredLogLine` (`packages/domain/src/ci/runner.ts`):

- a row: `{"i":<position>,"t":<unix ms or null>,"c":<content>}`
- an omission: `{"i":<position>,"omitted":"row_too_large","bytes":<declared size>}`

An omission has no `c`. A reader that only knows rows fails on it rather than
showing a placeholder as if the job printed it. `isLogOmission` tells the two
apart.

`ci_logs.omitted_rows` counts omissions and never goes down. A log with one is
never `complete`: a final call sets it `incomplete`, a late or repeated final
call leaves it so, and `markLogComplete` is not called. A table check
(`state <> 'complete' OR omitted_rows = 0`) holds that too. The job's result
does not change. RunDO schema v4 is new in this change set and not on `main`,
so it is amended in place along with its frozen fixture.

## What PR 80 (live logs) has to do

PR 80's reader parses every line as `{i, t, c}` and its masking carries state
from one row into the next (`mask_carry`, `ci_log_masks`). On top of this:

- Render an omission as a visible gap with its position and size, and keep the
  job's log shown as incomplete.
- Treat an omission as a masking boundary that is safe for a secret split
  across it. The omitted row's text is never stored, but the row after it can
  begin with the end of a secret that began inside the omitted row, which the
  masker never saw. Resetting the carry to empty at the gap is not safe by
  itself. Mask the start of the next row conservatively and test that case.
- Accept lines without `c` wherever stored lines are read.

## Limits that remain

A body over the Cloudflare plan's request limit (100 MB on Free and Pro,
verified: https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits)
is refused with 413 before the Worker runs. A row that large is never acked,
and the runner keeps resending it until its final flush gives up (10 attempts,
read in both runners' source). The task result is still reported.

Measured locally on 2026-11-17 with `wrangler dev` and both pinned runners
(`tools/ci/runner/runner.test.ts`): a job printing a 5 MiB line and then more
lines succeeds, the runner receives the ack past the omitted row while the API
reads only the first 4 MiB of that request, its next call starts there, and
the lines after it are stored. Locally the request passes through a test
Worker and a service binding, which may read the runner's body ahead of the
API (how far was not measured), so this is not evidence of how Cloudflare's
edge treats the unread rest. The test derives the stored positions from the
runner's actual final call: either final form may follow the gap, and the
sentinel's position is acked without a line. Whether the runner receives that early
answer through Cloudflare's edge has not been measured. It must be checked in
the deployed runner run (SP9b) before runners are turned on.
