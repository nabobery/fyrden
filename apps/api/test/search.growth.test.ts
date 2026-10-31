// What search's projections really cost, measured against what is reserved
// for them, through the path the events consumer writes them by (their
// batch's growth admitted, every group checking its receipt): the
// database's growth a batch makes (the larger of its size after, as D1
// reports it, against the one before, and of the bytes it added to the
// index and the projections' text, which free pages reused cannot hide)
// within the growth it reserves (`growthOf`), and each entity's rows
// written and read within its reservation (`STATEMENT_ROWS`,
// `STATEMENT_READS`). Over a matrix of text (short, repetitive, every term
// distinct up to a body's length, the longest a body may be in ASCII, in
// characters of three bytes and of four, combining marks; the longest
// title and a hundred labels) and of history (insert, replace, delete, a
// deletion's new row, batches of ten, small edits after an index of many
// large documents). The maxima are pinned: limits.md states them.

import { env } from "cloudflare:workers";
import {
  createIdFactory,
  type EntitySnapshot,
  type IssueRow,
  secureRandomBytes,
} from "@fyrden/domain";
import { describe, expect, it } from "vitest";
import { DEFAULT_ORG_SHARD } from "../src/events/read-model.js";
import { epochStatement } from "../src/queues/events-consumer.js";
import { READ_MODEL_ADMISSION, withReadModel } from "../src/read-model/executor.js";
import {
  ADMIT_STATEMENTS,
  admitStatements,
  growthOf,
  STATEMENT_READS,
  STATEMENT_ROWS,
} from "../src/search/admission.js";
import { docStatements, type SearchPosition } from "../src/search/statements.js";

const newId = createIdFactory(Date.now, secureRandomBytes);

/** The longest body and title an issue may have (UTF-16 code units). */
const BODY = 65_536;
const TITLE = 256;

/** Distinct short terms, up to `length` characters of them. */
const dense = (seed: number, length: number) => {
  const terms: string[] = [];
  let size = 0;
  for (let i = 0; size < length; i++) {
    const term = `${seed.toString(36)}${i.toString(36)}`;
    terms.push(term);
    size += term.length + 1;
  }
  return terms.join(" ").slice(0, length);
};

const TEXTS: Record<string, (seed: number) => string> = {
  short: (seed) => `Something is broken ${seed}.`,
  repetitive: () => "word ".repeat(BODY / 5),
  distinct: (seed) => dense(seed, BODY),
  ascii: (seed) => `${seed} ${"a".repeat(BODY - 8)}`,
  bmp: (seed) => `${seed} ${"界".repeat(BODY - 8)}`,
  astral: (seed) => `${seed} ${"😀".repeat((BODY - 8) / 2)}`,
  combining: (seed) => `${seed} ${"é".repeat((BODY - 8) / 2)}`,
};

const issue = (number: number, body: string, title = `Issue ${number}`): IssueRow => ({
  number,
  title,
  body,
  state: "open",
  stateReason: null,
  duplicateOf: null,
  locked: false,
  lockReason: null,
  authorId: "agt_author",
  authorRoot: "usr_author",
  closedAt: null,
  closedBy: null,
  createdAt: 1,
  updatedAt: 2,
  assignees: [],
  labels: [],
  milestone: null,
});

/** The longest title, of distinct terms, and a hundred labels. */
const widest = (number: number, body: string): IssueRow => ({
  ...issue(number, body, dense(number + 1_000, TITLE)),
  labels: Array.from({ length: 100 }, (_, i) => 1_000_000 + i),
});

interface Measured {
  /** The growth the batch made (bytes), and what it reserved for it. */
  grew: number;
  reserved: number;
  /** Rows written and read an entity, its batch's admission and growth's reservation less. */
  rows: number;
  reads: number;
}

const SEEN: Measured[] = [];

/** The bytes the index and the projections' text hold. */
const held = (db: D1Database) =>
  db
    .prepare(
      `SELECT (SELECT coalesce(sum(length(block)), 0) FROM search_fts_data)
         + (SELECT coalesce(sum(length(sz)), 0) FROM search_fts_docsize)
         + (SELECT coalesce(sum(length(CAST(title AS BLOB)) + length(CAST(body AS BLOB))), 0)
            FROM search_docs) AS bytes`,
    )
    .first<{ bytes: number }>()
    .then((r) => r?.bytes ?? 0);

/**
 * Writes `entities` (issues of the source at `version`; a null row a
 * deletion) in one batch of the executor's, as the consumer projects them:
 * their growth admitted, each group checking its receipt. What it grew and
 * cost.
 */
async function measure(
  repoId: string,
  entities: { number: number; row: IssueRow | null }[],
  version: number,
): Promise<Measured> {
  return withReadModel(env, DEFAULT_ORG_SHARD, async (db, writer) => {
    // The size before: a commit's of its own.
    const before = (await writer.write([db.prepare("SELECT 1")])).usage.bytes;
    const logical = await held(db);
    const position: SearchPosition = { repoId, epochGen: 1, ownerGen: 1, sourceSeq: version };
    const token = crypto.randomUUID();
    const rows = entities.map((e) => e.row as unknown as Record<string, unknown> | null);
    const reserved = growthOf(rows);
    const statements = [
      ...admitStatements(db, token, entities.length * STATEMENT_ROWS, reserved),
      ...entities.flatMap((e) =>
        docStatements(
          db,
          position,
          {
            type: "issue",
            id: `${repoId}#${e.number}`,
            version,
            deleted: e.row === null,
            row: e.row as unknown as Record<string, unknown> | null,
          } satisfies EntitySnapshot,
          { by: "event", admission: { token, removal: e.row === null } },
        ),
      ),
    ];
    const { results, usage } = await writer.write(statements);
    expect(before).toBeDefined();
    expect(usage.bytes).toBeDefined();
    // The groups' own: less the admission's statements, and the executor's opening and closing
    // (counted with the batch's last result).
    const groups = results.slice(ADMIT_STATEMENTS);
    const sum = (key: "rows_written" | "rows_read") =>
      groups.reduce((n, r) => n + (r.meta[key] ?? 0), 0);
    const measured = {
      grew: Math.max((usage.bytes ?? 0) - (before ?? 0), (await held(db)) - logical, 0),
      reserved,
      rows: (sum("rows_written") - READ_MODEL_ADMISSION.rows) / entities.length,
      reads: (sum("rows_read") - READ_MODEL_ADMISSION.reads) / entities.length,
    };
    SEEN.push(measured);
    return measured;
  });
}

async function source(): Promise<string> {
  const repoId = newId("rep");
  await withReadModel(env, DEFAULT_ORG_SHARD, (db) => epochStatement(db, repoId, 1, 0).run());
  return repoId;
}

/** Within what is reserved, and within the maxima limits.md states. */
function within(measured: Measured): void {
  expect(measured.grew).toBeLessThanOrEqual(LIMITS.grew * measured.reserved);
  expect(measured.rows).toBeLessThanOrEqual(LIMITS.rows);
  expect(measured.reads).toBeLessThanOrEqual(LIMITS.reads);
  expect(LIMITS.rows).toBeLessThanOrEqual(STATEMENT_ROWS);
  expect(LIMITS.reads).toBeLessThanOrEqual(STATEMENT_READS);
}

/** What limits.md states as measured: a share of the growth reserved, rows and reads an entity. */
const LIMITS = { grew: 0.75, rows: 12, reads: 40 };

describe("search's projections, measured against their reservations", () => {
  it.each(Object.keys(TEXTS))(
    "an issue of %s text, inserted, replaced, deleted, and a new deletion",
    async (kind) => {
      const text = TEXTS[kind] as (seed: number) => string;
      const repoId = await source();
      within(await measure(repoId, [{ number: 1, row: issue(1, text(1)) }], 1));
      within(await measure(repoId, [{ number: 1, row: issue(1, text(2)) }], 2));
      within(await measure(repoId, [{ number: 1, row: null }], 3));
      // A deletion of one never projected: its own row.
      within(await measure(repoId, [{ number: 2, row: null }], 4));
      within(await measure(repoId, [{ number: 1, row: issue(1, text(5)) }], 5));
    },
  );

  it.each(Object.keys(TEXTS))(
    "a batch of ten issues of %s text, the longest titles and a hundred labels",
    async (kind) => {
      const text = TEXTS[kind] as (seed: number) => string;
      const repoId = await source();
      within(
        await measure(
          repoId,
          Array.from({ length: 10 }, (_, i) => ({ number: i + 1, row: widest(i + 1, text(i)) })),
          1,
        ),
      );
    },
  );

  it("small edits after an index of many large documents, its merges among them", async () => {
    const repoId = await source();
    for (let batch = 0; batch < 4; batch++)
      within(
        await measure(
          repoId,
          Array.from({ length: 5 }, (_, i) => {
            const number = batch * 5 + i + 1;
            return { number, row: issue(number, TEXTS.distinct?.(number) ?? "") };
          }),
          1,
        ),
      );
    for (let version = 2; version <= 61; version++)
      within(
        await measure(
          repoId,
          [{ number: (version % 20) + 1, row: issue((version % 20) + 1, `Edited ${version}`) }],
          version,
        ),
      );
  });
});
