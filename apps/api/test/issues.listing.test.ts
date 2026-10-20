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
import type { SubjectKind, SubjectQuery } from "../src/do/repo/issues.js";
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
    let rowsRead = 0;
    sql.exec = ((query: string, ...bindings: unknown[]) => {
      const cursor = exec(query, ...bindings);
      const toArray = cursor.toArray.bind(cursor);
      cursor.toArray = () => {
        const rows = toArray();
        rowsRead += cursor.rowsRead;
        return rows;
      };
      return cursor;
    }) as typeof sql.exec;
    try {
      const page = r.issues.list(query);
      return {
        numbers: page.map((s) => (s.kind === "issue" ? s.issue.number : s.pull.number)),
        rowsRead,
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
                // two, each taking a page; the page's rows read back, and its labels, assignees
                // and reaction counts sought by number: never the 2N held.
                expect(page.rowsRead, label).toBeLessThanOrEqual(5 * 2 * (LIMIT + 1) + 4 * LIMIT);
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
