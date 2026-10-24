// What a page of the issue listing costs and answers: each kind and state
// is an index range, a continuation's boundary split in two so a page never
// walks rows sharing its sort key, whatever the repository holds. Every
// combination of the listing's filters, first page and continuation, is
// checked against the order worked out here, and its cost asserted as rows
// read, never as time.
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import {
  FILTER_RANGE_READS,
  type SubjectBoundary,
  type SubjectFilter,
  type SubjectKind,
  type SubjectQuery,
} from "../src/do/repo/issues.js";
import { HEAD_MOVED } from "../src/do/repo/pulls.js";
import { inRepo } from "./helpers/repo-git.js";

/** Subjects of each kind the repository holds. */
const N = 3_000;
const AT = 1_700_000_000_000;
const SHA = "0".repeat(40);

type Held = { kind: SubjectKind; number: number; state: string; updatedAt: number };

/**
 * A repository object holding `N` issues (odd numbers, every other closed)
 * and `N` pull requests (even numbers, open, closed or merged), all updated
 * at `AT` (`tied`), or in groups of ten timestamps whose order differs from
 * the numbers'. Returns what it holds.
 */
async function holding(tied: boolean): Promise<{ stub: DurableObjectStub<RepoDO>; held: Held[] }> {
  const stub = env.REPO.getByName(uniqueId("rep"));
  const at = (n: number) => (tied ? AT : AT + ((n * 7919) % 10));
  const held: Held[] = [];
  for (let i = 1; i <= N; i++) {
    held.push({
      kind: "issue",
      number: 2 * i - 1,
      state: i % 2 ? "open" : "closed",
      updatedAt: at(2 * i - 1),
    });
    const state = ["merged", "open", "closed"][i % 3] as string;
    held.push({ kind: "pull", number: 2 * i, state, updatedAt: at(2 * i) });
  }
  await inRepo(stub, (r: RepoDO) => {
    const sql = r.git.context.storage.sql;
    for (const h of held)
      if (h.kind === "issue")
        sql.exec(
          `INSERT INTO issues (number, title, state, author_id, author_root, created_at, updated_at,
             closed_at, state_reason)
           VALUES (?1, 'issue', ?2, 'usr_a', 'usr_a', ?3, ?3,
             CASE WHEN ?2 = 'closed' THEN ?3 END, CASE WHEN ?2 = 'closed' THEN 'completed' END)`,
          h.number,
          h.state,
          h.updatedAt,
        );
      else
        sql.exec(
          `INSERT INTO pull_requests (number, title, state, draft, author_id, author_root, base_ref,
             base_sha, head_ref, head_sha, created_at, updated_at)
           VALUES (?, 'pull', ?, 0, 'usr_a', 'usr_a', 'main', ?, ?, ?, ?, ?)`,
          h.number,
          h.state,
          SHA,
          `b${h.number}`,
          SHA,
          h.updatedAt,
          h.updatedAt,
        );
  });
  return { stub, held };
}

/** The listing's page for `query`, with the rows its queries read. */
function listed(stub: DurableObjectStub<RepoDO>, query: SubjectQuery) {
  return inRepo(stub, (r: RepoDO) => {
    const sql = r.git.context.storage.sql;
    const exec = sql.exec.bind(sql);
    const cursors: { rowsRead: number }[] = [];
    sql.exec = ((query: string, ...bindings: unknown[]) => {
      const cursor = exec(query, ...bindings);
      cursors.push(cursor);
      return cursor;
    }) as typeof sql.exec;
    try {
      const page = r.issues.list(query).subjects;
      return {
        numbers: page.map((s) => (s.kind === "issue" ? s.issue.number : s.pull.number)),
        rowsRead: cursors.reduce((sum, c) => sum + c.rowsRead, 0),
      };
    } finally {
      sql.exec = exec;
    }
  });
}

/** What the page should be, worked out from what the repository holds. */
function expected(held: readonly Held[], query: SubjectQuery): number[] {
  const states = (kind: SubjectKind) =>
    query.state === "all"
      ? null
      : query.state === "closed" && kind === "pull"
        ? ["closed", "merged"]
        : [query.state];
  const key = (h: Held) => (query.sort === "created" ? h.number : h.updatedAt);
  const sign = query.direction === "desc" ? -1 : 1;
  const order = (a: { key: number; number: number }, b: { key: number; number: number }) =>
    sign * (a.key - b.key || a.number - b.number);
  return held
    .filter((h) => query.kinds.includes(h.kind) && (states(h.kind)?.includes(h.state) ?? true))
    .map((h) => ({ key: key(h), number: h.number }))
    .filter((h) => query.after === null || order(h, query.after) > 0)
    .sort(order)
    .slice(0, query.limit)
    .map((h) => h.number);
}

const KINDS: readonly (readonly SubjectKind[])[] = [["issue", "pull"], ["issue"], ["pull"]];
const LIMIT = 31;

describe("the issue listing", () => {
  it.each([true, false])(
    "answers every combination in order, a page reading a few pages of rows (tied: %s)",
    async (tied) => {
      const { stub, held } = await holding(tied);
      // An anchor in the middle: deep in the tie, or inside a timestamp group.
      const middle = held.find((h) => h.number === N) as Held;
      for (const kinds of KINDS)
        for (const state of ["open", "closed", "all"] as const)
          for (const sort of ["created", "updated"] as const)
            for (const direction of ["asc", "desc"] as const)
              for (const after of [
                null,
                {
                  key: sort === "created" ? middle.number : middle.updatedAt,
                  number: middle.number,
                },
              ]) {
                const query: SubjectQuery = { kinds, state, sort, direction, after, limit: LIMIT };
                const page = await listed(stub, query);
                const label = JSON.stringify(query);
                expect(page.numbers, label).toEqual(expected(held, query));
                // At most five ranges (issues: two states; pull requests: three), each split in
                // two, each taking a page and one more (to know whether more follow); the page's
                // rows read back, and its labels, assignees and reaction counts sought by number:
                // never the 2N held.
                expect(page.rowsRead, label).toBeLessThanOrEqual(
                  5 * 2 * (LIMIT + 1) + 4 * (LIMIT + 1),
                );
              }
    },
  );

  it("reads every listing range from an index, without a temporary sort", async () => {
    const { stub } = await holding(true);
    const plans = await inRepo(stub, (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      const explain = (query: string, ...bindings: unknown[]) =>
        sql
          .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...bindings)
          .toArray()
          .map((row) => row.detail)
          .join("; ");
      return [
        explain(
          "SELECT number, updated_at AS key FROM issues WHERE state = ? AND updated_at = ? AND number < ? ORDER BY number DESC LIMIT ?",
          "open",
          AT,
          5,
          31,
        ),
        explain(
          "SELECT number, updated_at AS key FROM pull_requests WHERE state = ? AND updated_at < ? ORDER BY updated_at DESC, number DESC LIMIT ?",
          "merged",
          AT,
          31,
        ),
        explain(
          "SELECT number, number AS key FROM pull_requests WHERE state = ? AND number < ? ORDER BY number DESC LIMIT ?",
          "closed",
          5,
          31,
        ),
      ];
    });
    for (const plan of plans) {
      expect(plan).toMatch(/USING (COVERING )?INDEX/);
      expect(plan).not.toMatch(/TEMP B-TREE/);
    }
  });

  it("costs a moved pull request head one row written more for the listing's index", async () => {
    const written = await inRepo(env.REPO.getByName(uniqueId("rep")), (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      sql.exec(
        `INSERT INTO pull_requests (number, title, state, draft, author_id, author_root, base_ref,
           base_sha, head_ref, head_sha, created_at, updated_at)
         VALUES (1, 'pull', 'open', 0, 'usr_a', 'usr_a', 'main', ?1, 'b', ?1, 1, 1)`,
        SHA,
      );
      const move = (at: number) => {
        const cursor = sql.exec(HEAD_MOVED, "1".repeat(40), "usr_a", null, at, at, 1);
        cursor.toArray();
        return cursor.rowsWritten;
      };
      const withIndex = move(2);
      sql.exec("DROP INDEX pull_requests_updated");
      return { withIndex, without: move(3) };
    });
    // Measured in workerd: the index's entry moving counts one row written (Durable Object
    // storage bills index rows as rows written:
    // https://developers.cloudflare.com/durable-objects/platform/pricing/).
    expect(written.withIndex - written.without).toBe(1);
  });
});

/** What each held subject carries, by number: chosen so filters cut the listing unevenly. */
const labelsOf = (n: number) => [
  ...(n % 3 === 0 ? [1] : []),
  ...(n % 5 === 0 ? [2] : []),
  // Rare: one subject in the whole repository.
  ...(n === N + 1 ? [3] : []),
];
const assigneeOf = (n: number) => (n % 7 === 0 ? "usr_x" : null);
const milestoneOf = (n: number) => (n % 4 === 0 ? 1 : null);
const authorOf = (n: number) => (n % 11 === 0 ? "usr_b" : "usr_a");

/** A repository as `holding` makes it, its subjects given labels, assignees, milestones and authors. */
async function holdingSorted(
  tied = false,
): Promise<{ stub: DurableObjectStub<RepoDO>; held: Held[] }> {
  const { stub, held } = await holding(tied);
  await inRepo(stub, (r: RepoDO) => {
    const sql = r.git.context.storage.sql;
    sql.exec(
      `INSERT INTO milestones (number, title, state, creator, created_at, updated_at)
       VALUES (1, 'v1', 'open', 'usr_a', 1, 1)`,
    );
    for (const [id, name] of [
      [1, "bug"],
      [2, "needs,discussion"],
      [3, "rare"],
    ] as const)
      sql.exec(
        "INSERT INTO labels (id, name, color, created_at, updated_at) VALUES (?, ?, 'ffffff', 1, 1)",
        id,
        name,
      );
    for (const h of held) {
      const table = h.kind === "issue" ? "issues" : "pull_requests";
      sql.exec(
        `UPDATE ${table} SET milestone = ?, author_id = ? WHERE number = ?`,
        milestoneOf(h.number),
        authorOf(h.number),
        h.number,
      );
      for (const label of labelsOf(h.number))
        sql.exec("INSERT INTO subject_labels (number, label_id) VALUES (?, ?)", h.number, label);
      const assignee = assigneeOf(h.number);
      if (assignee)
        sql.exec(
          "INSERT INTO subject_assignees (number, principal, root, assigned_at) VALUES (?, ?, ?, 1)",
          h.number,
          assignee,
          assignee,
        );
    }
  });
  return { stub, held };
}

/** Whether held subject `n` matches `filter` (label names as the fixture names them). */
function matches(n: number, filter: SubjectFilter): boolean {
  const names: Record<string, number> = { bug: 1, "needs,discussion": 2, rare: 3 };
  const ids = [
    ...(filter.labelIds ?? []),
    ...(filter.labelNames ?? []).map((name) => names[name] ?? -1),
  ];
  const assignee = assigneeOf(n);
  const milestone = milestoneOf(n);
  return (
    ids.every((id) => labelsOf(n).includes(id)) &&
    (filter.assignee === undefined ||
      (filter.assignee === "none"
        ? assignee === null
        : filter.assignee === "any"
          ? assignee !== null
          : assignee === filter.assignee.principal)) &&
    (filter.milestone === undefined ||
      (filter.milestone === "none"
        ? milestone === null
        : filter.milestone === "any"
          ? milestone !== null
          : milestone === filter.milestone)) &&
    (filter.creator === undefined || authorOf(n) === filter.creator)
  );
}

/** Every page of `query`, followed to the end: the numbers in order, pages taken, most rows one read. */
async function walk(stub: DurableObjectStub<RepoDO>, query: SubjectQuery) {
  const numbers: number[] = [];
  let after: SubjectBoundary | null = null;
  let pages = 0;
  let mostRead = 0;
  do {
    const page = await inRepo(stub, (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      const exec = sql.exec.bind(sql);
      // Every cursor's rows read, once the listing is done with it (iterated or read whole).
      const cursors: { rowsRead: number }[] = [];
      sql.exec = ((q: string, ...bindings: unknown[]) => {
        const cursor = exec(q, ...bindings);
        cursors.push(cursor);
        return cursor;
      }) as typeof sql.exec;
      try {
        const listed = r.issues.list({ ...query, after });
        return {
          numbers: listed.subjects.map((s) =>
            s.kind === "issue" ? s.issue.number : s.pull.number,
          ),
          next: listed.next,
          rowsRead: cursors.reduce((sum, c) => sum + c.rowsRead, 0),
        };
      } finally {
        sql.exec = exec;
      }
    });
    expect(page.numbers.length).toBeLessThanOrEqual(query.limit);
    numbers.push(...page.numbers);
    after = page.next;
    pages++;
    mostRead = Math.max(mostRead, page.rowsRead);
  } while (after !== null && pages < 200);
  return { numbers, pages, mostRead, ended: after === null };
}

/** The page size filtered walks take (the largest the API allows: fewer pages to walk). */
const WALK_LIMIT = 100;

/**
 * Rows a filtered page of these fixtures reads at most: five ranges, each split in two, each
 * stopping once it has read its budget (the row that crosses it can bring a filter's lookups with
 * it: up to 22 more), and the page's records read back with their few labels and assignees (a
 * page's items cost as an unfiltered page's do, which grows with the labels each carries).
 */
const MOST_FILTERED_READS = 5 * 2 * (FILTER_RANGE_READS + 22) + 4 * (WALK_LIMIT + 1);

describe("the issue listing's filters", () => {
  const FILTERS: [string, SubjectFilter][] = [
    ["a common label by name", { labelNames: ["bug"] }],
    ["a label whose name holds a comma, by id", { labelIds: [2] }],
    ["two labels", { labelIds: [1, 2] }],
    ["a label one subject has", { labelNames: ["rare"] }],
    ["an assignee", { assignee: { principal: "usr_x" } }],
    ["no assignee", { assignee: "none" }],
    ["any assignee", { assignee: "any" }],
    ["a milestone", { milestone: 1 }],
    ["no milestone", { milestone: "none" }],
    [
      "a creator, with a label and any milestone",
      { creator: "usr_b", labelIds: [1], milestone: "any" },
    ],
  ];

  it.each(FILTERS)(
    "walks %s to the end in order, each page reading a bounded number of rows",
    async (_, filter) => {
      for (const tied of [false, true]) {
        const { stub, held } = await holdingSorted(tied);
        for (const kinds of KINDS)
          for (const state of ["open", "closed", "all"] as const)
            for (const sort of ["created", "updated"] as const)
              for (const direction of ["asc", "desc"] as const) {
                const query: SubjectQuery = {
                  kinds,
                  state,
                  sort,
                  direction,
                  after: null,
                  limit: WALK_LIMIT,
                  filter,
                };
                const label = JSON.stringify({ tied, kinds, state, sort, direction, filter });
                const all = expected(held, { ...query, filter: undefined, limit: 2 * N });
                const walked = await walk(stub, query);
                expect(walked.ended, label).toBe(true);
                expect(walked.numbers, label).toEqual(all.filter((n) => matches(n, filter)));
                expect(walked.mostRead, label).toBeLessThanOrEqual(MOST_FILTERED_READS);
              }
      }
    },
    120_000,
  );

  it("reads within its bound when every subject carries all twenty labels a filter names, or all but one", async () => {
    const { stub, held } = await holding(false);
    const ids = Array.from({ length: 20 }, (_, i) => i + 10);
    await inRepo(stub, (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      for (const id of ids)
        sql.exec(
          "INSERT INTO labels (id, name, color, created_at, updated_at) VALUES (?, ?, 'ffffff', 1, 1)",
          id,
          `l${id}`,
        );
      // Odd numbers carry all twenty; even ones all but the last.
      for (const h of held)
        for (const id of h.number % 2 ? ids : ids.slice(0, -1))
          sql.exec("INSERT INTO subject_labels (number, label_id) VALUES (?, ?)", h.number, id);
    });
    for (const kinds of KINDS) {
      const query: SubjectQuery = {
        kinds,
        state: "all",
        sort: "updated",
        direction: "desc",
        after: null,
        limit: WALK_LIMIT,
        filter: { labelIds: ids },
      };
      const walked = await walk(stub, query);
      expect(walked.numbers).toEqual(
        expected(held, { ...query, filter: undefined, limit: 2 * N }).filter((n) => n % 2 === 1),
      );
      expect(walked.mostRead).toBeLessThanOrEqual(MOST_FILTERED_READS);
    }
  });

  it("answers nothing for a label name the repository lacks, reading only the labels", async () => {
    const { stub } = await holdingSorted();
    const walked = await walk(stub, {
      kinds: ["issue", "pull"],
      state: "all",
      sort: "created",
      direction: "desc",
      after: null,
      limit: LIMIT,
      filter: { labelNames: ["bug", "missing"] },
    });
    expect(walked).toMatchObject({ numbers: [], pages: 1, ended: true });
    expect(walked.mostRead).toBeLessThanOrEqual(2);
  });

  it("lists as before with an empty filter", async () => {
    const { stub, held } = await holdingSorted();
    const query: SubjectQuery = {
      kinds: ["issue", "pull"],
      state: "open",
      sort: "updated",
      direction: "asc",
      after: null,
      limit: LIMIT,
      filter: {},
    };
    const page = await listed(stub, query);
    expect(page.numbers).toEqual(expected(held, query));
  });
});
