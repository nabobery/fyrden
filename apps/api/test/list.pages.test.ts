// Lists whose items carry bodies or descriptions end a page once its items
// pass 1 MiB of JSON (always one item), so an answer stays bounded however
// large each item is; walking the cursors still gives every item once, in
// order. The id-ordered streams also resume after an id given directly.

import { env } from "cloudflare:workers";
import { MAX_PAGE_BYTES } from "@fyrden/api-contract";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { pageOf } from "../src/ops/pages.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { inRepo } from "./helpers/repo-git.js";

/** A body of 65,536 characters each escaped in JSON as six bytes: about 384 KiB of JSON. */
const HEAVY = "\u0001".repeat(65_536);

let owner: Who;
let path: string;
let repoId: string;

beforeEach(async () => {
  owner = await user();
  const made = await json<{ id: string; name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
  );
  path = `/repos/${owner.handle}/${made.body.name}`;
  repoId = made.body.id;
});

/** Every page of `list` (a path taking `per_page`), followed to the end: each page's items and bytes. */
async function walk<T>(
  list: string,
  field: string,
  perPage = 30,
): Promise<{ pages: T[][]; bytes: number[] }> {
  const pages: T[][] = [];
  const bytes: number[] = [];
  let cursor: string | null = null;
  do {
    const sep = list.includes("?") ? "&" : "?";
    const res = await api(
      "GET",
      `${list}${sep}per_page=${perPage}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      owner.token,
    );
    const text = await res.text();
    expect(res.status, text.slice(0, 200)).toBe(200);
    const body = JSON.parse(text) as Record<string, unknown> & { next_cursor: string | null };
    const items = body[field] as T[];
    pages.push(items);
    bytes.push(new TextEncoder().encode(JSON.stringify(items)).length);
    cursor = body.next_cursor;
  } while (cursor !== null && pages.length < 50);
  expect(cursor).toBeNull();
  return { pages, bytes };
}

describe("lists of large items", () => {
  it("end a page of comments at 1 MiB, and resume after an id given directly", async () => {
    const issue = await json<{ number: number }>(
      api("POST", `${path}/issues`, owner.token, { title: "Long talk" }),
    );
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const made = await json<{ id: number }>(
        api("POST", `${path}/issues/${issue.body.number}/comments`, owner.token, { body: HEAVY }),
      );
      expect(made.status).toBe(201);
      ids.push(made.body.id);
    }
    const list = `${path}/issues/${issue.body.number}/comments`;
    const { pages, bytes } = await walk<{ id: number }>(list, "comments");
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(pages.flat().map((c) => c.id)).toEqual(ids);
    for (const b of bytes) expect(b).toBeLessThanOrEqual(MAX_PAGE_BYTES);
    const after = await json<{ comments: { id: number }[] }>(
      api("GET", `${list}?after=${ids[1]}`, owner.token),
    );
    expect(after.body.comments.map((c) => c.id)).toEqual(ids.slice(2, 4));
    const both = await api("GET", `${list}?after=${ids[1]}&cursor=x`, owner.token);
    expect(both.status).toBe(422);
  });

  it("end a page of issues and of milestones at 1 MiB", async () => {
    const numbers: number[] = [];
    for (let i = 0; i < 3; i++)
      numbers.push(
        (
          await json<{ number: number }>(
            api("POST", `${path}/issues`, owner.token, { title: `Long ${i}`, body: HEAVY }),
          )
        ).body.number,
      );
    const issues = await walk<{ number: number }>(
      `${path}/issues?type=issues&direction=asc`,
      "issues",
    );
    expect(issues.pages.map((p) => p.length)).toEqual([2, 1]);
    expect(issues.pages.flat().map((i) => i.number)).toEqual(numbers);
    for (let i = 0; i < 3; i++)
      expect(
        (
          await api("POST", `${path}/milestones`, owner.token, {
            title: `v${i}`,
            description: "\u0001".repeat(65_536),
          })
        ).status,
      ).toBe(201);
    const milestones = await walk<{ title: string }>(`${path}/milestones`, "milestones");
    expect(milestones.pages.map((p) => p.length)).toEqual([2, 1]);
    expect(
      milestones.pages
        .flat()
        .map((m) => m.title)
        .sort(),
    ).toEqual(["v0", "v1", "v2"]);
  });
});

/** Writes rows into the repository's object as its own code would have (fixtures past the API's reach). */
const seed = (fill: (sql: SqlStorage) => void) =>
  inRepo(env.REPO.getByName(repoId), (r: RepoDO) => fill(r.git.context.storage.sql));
const SHA = "0".repeat(40);

/** Pull requests numbered `numbers`, each with a heavy body, as opened ones are stored. */
const pullsNumbered = (numbers: readonly number[]) =>
  seed((sql) => {
    for (const n of numbers)
      sql.exec(
        `INSERT INTO pull_requests (number, title, body, state, draft, author_id, author_root,
           base_ref, base_sha, head_ref, head_sha, created_at, updated_at)
         VALUES (?1, 'pull', ?2, 'open', 0, ?3, ?3, 'main', ?4, ?5, ?4, ?1, ?1)`,
        n,
        HEAVY,
        owner.principalId,
        SHA,
        `b${n}`,
      );
    sql.exec("UPDATE repo_meta SET next_number = ? WHERE id = 1", Math.max(...numbers) + 1);
  });

describe("every list the web reads, cut by its bytes", () => {
  it("walks issues sorted by update both ways, and a filtered listing, in order", async () => {
    const numbers: number[] = [];
    for (let i = 0; i < 5; i++)
      numbers.push(
        (
          await json<{ number: number }>(
            api("POST", `${path}/issues`, owner.token, {
              title: `Long ${i}`,
              body: HEAVY,
              ...(i % 2 === 0 && { labels: ["bug"] }),
            }),
          )
        ).body.number,
      );
    // Touched out of order, so update order differs from creation order.
    for (const n of [numbers[3], numbers[0], numbers[4]])
      await api("PATCH", `${path}/issues/${n}`, owner.token, { title: `touched ${n}` });
    // The order, read one item a page (never cut by its bytes).
    const order = async (query: string) =>
      (
        await walk<{ number: number }>(`${path}/issues?type=issues&state=all&${query}`, "issues", 1)
      ).pages
        .flat()
        .map((i) => i.number);
    for (const query of [
      "sort=updated&direction=asc",
      "sort=updated&direction=desc",
      "labels=bug&direction=asc",
    ]) {
      // The order with the bodies cut short by an edit is the order to walk (bytes aside).
      const walked = await walk<{ number: number }>(
        `${path}/issues?type=issues&state=all&${query}`,
        "issues",
      );
      for (const b of walked.bytes) expect(b, query).toBeLessThanOrEqual(MAX_PAGE_BYTES);
      expect(
        walked.pages.every((p) => p.length <= 2),
        query,
      ).toBe(true);
      expect(
        walked.pages.flat().map((i) => i.number),
        query,
      ).toEqual(await order(query));
    }
  });

  it("walks a filtered listing whose scan stops short and whose matches are cut by their bytes", async () => {
    // 1,500 issues, few carrying the label: heavy ones at the top and one far down, so a page's
    // scan stops at its read budget (a frontier) while its matches pass 1 MiB.
    const heavy = new Set([1500, 1499, 1498, 10]);
    await seed((sql) => {
      const [label] = sql
        .exec<{ id: number }>("SELECT id FROM labels WHERE name = 'bug'")
        .toArray();
      for (let n = 1; n <= 1500; n++) {
        sql.exec(
          `INSERT INTO issues (number, title, body, state, author_id, author_root, created_at, updated_at)
           VALUES (?1, 'issue', ?2, 'open', ?3, ?3, ?1, ?1)`,
          n,
          heavy.has(n) ? HEAVY : null,
          owner.principalId,
        );
        if (heavy.has(n))
          sql.exec("INSERT INTO subject_labels (number, label_id) VALUES (?, ?)", n, label?.id);
      }
      sql.exec("UPDATE repo_meta SET next_number = 1501 WHERE id = 1");
    });
    const walked = await walk<{ number: number }>(
      `${path}/issues?type=issues&labels=bug`,
      "issues",
    );
    expect(walked.pages.flat().map((i) => i.number)).toEqual([1500, 1499, 1498, 10]);
    expect(walked.pages[0]).toHaveLength(2);
    // Some pages end at the scan's budget with nothing (a cursor to go on).
    expect(walked.pages.some((p) => p.length === 0)).toBe(true);
    for (const b of walked.bytes) expect(b).toBeLessThanOrEqual(MAX_PAGE_BYTES);
  });

  it("walks milestones of mixed due dates in their order", async () => {
    for (const [title, due] of [
      ["a", 3],
      ["b", null],
      ["c", 1],
      ["d", 2],
    ] as const)
      expect(
        (
          await api("POST", `${path}/milestones`, owner.token, {
            title,
            description: HEAVY,
            ...(due !== null && { due_on: Date.UTC(2030, 0, due) }),
          })
        ).status,
      ).toBe(201);
    const walked = await walk<{ title: string }>(`${path}/milestones`, "milestones");
    expect(walked.pages.map((p) => p.length)).toEqual([2, 2]);
    // By due date, one without a date last.
    expect(walked.pages.flat().map((m) => m.title)).toEqual(["c", "d", "a", "b"]);
    for (const b of walked.bytes) expect(b).toBeLessThanOrEqual(MAX_PAGE_BYTES);
  });

  it("walks pull requests and their reviews, a review stream resumed by id as its cursor would", async () => {
    await pullsNumbered([1, 2, 3, 4, 5]);
    const pulls = await walk<{ number: number }>(`${path}/pulls?state=open`, "pull_requests");
    expect(pulls.pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(pulls.pages.flat().map((p) => p.number)).toEqual([5, 4, 3, 2, 1]);
    for (const b of pulls.bytes) expect(b).toBeLessThanOrEqual(MAX_PAGE_BYTES);
    await seed((sql) => {
      for (let id = 1; id <= 5; id++)
        sql.exec(
          `INSERT INTO reviews (review_id, pr_number, reviewer_id, reviewer_root, by_agent, state,
             commit_sha, body, submitted_at) VALUES (?, 1, 'usr_r', 'usr_r', 0, 'COMMENTED', ?, ?, ?)`,
          id,
          SHA,
          HEAVY,
          id,
        );
    });
    const reviews = await walk<{ id: number }>(`${path}/pulls/1/reviews`, "reviews");
    expect(reviews.pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(reviews.pages.flat().map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    for (const b of reviews.bytes) expect(b).toBeLessThanOrEqual(MAX_PAGE_BYTES);
    const after = await json<{ reviews: { id: number }[]; next_cursor: string | null }>(
      api("GET", `${path}/pulls/1/reviews?after=2`, owner.token),
    );
    expect(after.body.reviews.map((r) => r.id)).toEqual([3, 4]);
    expect((await api("GET", `${path}/pulls/1/reviews?after=2&cursor=x`, owner.token)).status).toBe(
      422,
    );
    // Diff comments of the same pull request, a thread each.
    await seed((sql) => {
      for (let id = 1; id <= 5; id++) {
        sql.exec(
          `INSERT INTO review_threads (thread_id, pr_number, commit_sha, path, side, line)
           VALUES (?, 1, ?, 'a.txt', 'RIGHT', 1)`,
          id,
          SHA,
        );
        sql.exec(
          `INSERT INTO review_comments (comment_id, pr_number, thread_id, author_id, author_root,
             body, created_at, updated_at) VALUES (?1, 1, ?1, 'usr_r', 'usr_r', ?2, ?1, ?1)`,
          id,
          HEAVY,
        );
      }
    });
    const lines = await walk<{ id: number }>(`${path}/pulls/1/comments`, "comments");
    expect(lines.pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(lines.pages.flat().map((c) => c.id)).toEqual([1, 2, 3, 4, 5]);
    for (const b of lines.bytes) expect(b).toBeLessThanOrEqual(MAX_PAGE_BYTES);
    const resumed = await json<{ comments: { id: number }[] }>(
      api("GET", `${path}/pulls/1/comments?after=3`, owner.token),
    );
    expect(resumed.body.comments.map((c) => c.id)).toEqual([4, 5]);
  });
});

describe("a page by its bytes", () => {
  const out = (n: number) => ({ text: "x".repeat(n) });
  /** The bytes of the JSON array of `items`: brackets, each item, a comma between two. */
  const size = (items: readonly number[]) => JSON.stringify(items.map(out)).length;
  it("keeps items while their array fits, always the first, and says whether more were read", () => {
    expect(pageOf([10, 10, 10], 30, out, 50)).toMatchObject({ last: 10, more: true });
    expect(pageOf([10, 10, 10], 30, out, 50).shown).toHaveLength(2);
    expect(pageOf([100, 1], 30, out, 50)).toMatchObject({
      shown: [out(100)],
      last: 100,
      more: true,
    });
    // Exactly fitting, and one byte over.
    expect(pageOf([10, 10], 30, out, size([10, 10]))).toMatchObject({ last: 10, more: false });
    expect(pageOf([10, 10], 30, out, size([10, 10]) - 1).shown).toHaveLength(1);
    expect(pageOf([1, 1, 1], 2, out, 1_000)).toMatchObject({ last: 1, more: true });
    expect(pageOf([], 2, out, 1_000)).toEqual({ shown: [], last: undefined, more: false });
  });
});
