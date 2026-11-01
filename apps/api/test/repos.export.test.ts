// A repository's entities a page at a time, for a read model's reconciliation:
// the repository, its issues and pull requests in number order (deleted issues'
// tombstones with their deletion's position), labels and milestones, each as
// its events carry it, pages bounded by count and bytes, and `stale` once the
// epoch or ownership is no longer the export's.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type DomainEvent,
  IssueRowSchema,
  LabelRowSchema,
  MilestoneRowSchema,
  PullRequestRowSchema,
  RepoRowSchema,
} from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import {
  EXPORT_PAGE,
  type ExportedEntity,
  type ExportKind,
  type ExportPage,
  type ExportPageRequest,
  readExportPage,
} from "../src/do/repo/export.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";

const fx = inject("pushFixtures");

let owner: Who;
let repo: { id: string; name: string };
let path: string;

const stub = () => env.REPO.getByName(repo.id);

/** One export page, as the repository's object answers it. */
const exportPage = async (request: ExportPageRequest) =>
  (await stub().exportPage(request)) as ExportPage | "stale" | null;

beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: stub() },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
  const pushed = await postPush(
    target,
    pushBody(
      [
        { old: ZERO, new: fx.c1, ref: "refs/heads/main" },
        { old: ZERO, new: fx.c2, ref: "refs/heads/feature" },
      ],
      { pack: fx.packC2 },
    ),
  );
  expect(pushed.status).toBe(200);
});

async function made(method: string, route: string, body?: unknown): Promise<number> {
  const res = await json<{ number?: number; id?: number }>(
    api(method, `${path}${route}`, owner.token, body),
  );
  expect(res.status).toBeLessThan(300);
  return res.body.number ?? res.body.id ?? 0;
}

/** Every page of a kind, `limit` at a time. */
async function walk(kind: ExportKind, limit: number): Promise<ExportPage[]> {
  const pages: ExportPage[] = [];
  let after = 0;
  for (;;) {
    const page = await exportPage({ kind, after, limit });
    if (!page || page === "stale") throw new Error(`no page: ${page}`);
    pages.push(page);
    if (page.next === null) return pages;
    after = page.next;
  }
}

const keys = (pages: ExportPage[]) =>
  pages.map((p) => p.entities.map((e) => e.id.split(/[#/]/).at(-1)));

describe("a repository's export", () => {
  it("answers its entities as their events carry them, in key order", async () => {
    const one = await made("POST", "/issues", { title: "One", body: "First" });
    const two = await made("POST", "/pulls", { title: "Two", head: "feature", base: "main" });
    const three = await made("POST", "/issues", { title: "Three" });
    const milestone = await made("POST", "/milestones", { title: "v1" });
    await made("POST", `/issues/${one}/labels`, { labels: ["bug"] });
    await made("PATCH", `/issues/${one}`, { milestone });
    expect([one, two, three]).toEqual([1, 2, 3]);

    const [first] = await walk("repo", 1);
    expect(first?.sourceId).toBe(repo.id);
    expect(first?.entities).toHaveLength(1);
    expect(first?.entities[0]).toMatchObject({ type: "repo", id: repo.id, deleted: false });
    RepoRowSchema.parse(first?.entities[0]?.row);

    const subjects = (await walk("subjects", EXPORT_PAGE.entities)).flatMap((p) => p.entities);
    expect(subjects.map((e) => [e.type, e.id])).toEqual([
      ["issue", `${repo.id}#1`],
      ["pull_request", `${repo.id}#2`],
      ["issue", `${repo.id}#3`],
    ]);
    const issue = IssueRowSchema.parse(subjects[0]?.row);
    expect(issue).toMatchObject({ number: 1, title: "One", body: "First", milestone });
    expect(issue.labels).toHaveLength(1);
    PullRequestRowSchema.parse(subjects[1]?.row);

    const labels = (await walk("labels", EXPORT_PAGE.entities)).flatMap((p) => p.entities);
    expect(labels.length).toBe(9);
    for (const label of labels) LabelRowSchema.parse(label.row);
    expect(labels.map((l) => Number(l.id.split("/").at(-1)))).toEqual(
      [...labels.map((l) => Number(l.id.split("/").at(-1)))].sort((a, b) => a - b),
    );
    const milestones = (await walk("milestones", EXPORT_PAGE.entities)).flatMap((p) => p.entities);
    expect(milestones.map((m) => m.id)).toEqual([`${repo.id}#milestones/${milestone}`]);
    expect(MilestoneRowSchema.parse(milestones[0]?.row)).toMatchObject({
      title: "v1",
      openIssues: 1,
    });

    // Each is what the entity's latest event carried; a milestone's counts as they stand now
    // (an issue joining it changes them without a milestone event).
    const events = await runInDurableObject(stub(), (_: RepoDO, state) =>
      state.storage.sql
        .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
        .toArray()
        .map((r) => JSON.parse(r.event) as DomainEvent),
    );
    const latest = new Map(
      events.flatMap((e) => (e.entity ? [[e.entity.id, e.entity] as const] : [])),
    );
    for (const exported of [...subjects, ...labels, ...milestones]) {
      const carried = latest.get(exported.id);
      expect(carried, exported.id).toBeDefined();
      const counted = ["openIssues", "closedIssues", "openPulls", "closedPulls"];
      const uncounted = (row: Record<string, unknown> | null | undefined) =>
        row && Object.fromEntries(Object.entries(row).filter(([k]) => !counted.includes(k)));
      expect({ version: exported.version, row: uncounted(exported.row) }).toEqual({
        version: carried?.version,
        row: uncounted(carried?.row),
      });
    }

    // The versions are the entities' own: an issue's grows with each change.
    expect(subjects[0]?.version).toBeGreaterThan(subjects[2]?.version ?? 0);
  });

  it("answers a deleted issue's tombstone with where its deletion is", async () => {
    await made("POST", "/issues", { title: "Doomed" });
    const before = await exportPage({ kind: "repo", after: 0, limit: 1 });
    expect((await api("DELETE", `${path}/issues/1`, owner.token)).status).toBeLessThan(300);
    const after = await exportPage({ kind: "subjects", after: 0, limit: 10 });
    if (!before || before === "stale" || !after || after === "stale") throw new Error("no page");
    expect(after.entities).toEqual([
      {
        type: "issue",
        id: `${repo.id}#1`,
        version: 2,
        deleted: true,
        row: null,
        deletedAt: { epochGen: after.epochGen, sourceSeq: after.watermark },
      },
    ]);
    expect(after.watermark).toBeGreaterThan(before.watermark);
    // One deleted before positions were recorded carries none.
    await runInDurableObject(stub(), (_: RepoDO, state) => {
      state.storage.sql.exec(
        "INSERT INTO issue_tombstones (number, version, deleted_at) VALUES (7, 3, 0)",
      );
    });
    const old = await exportPage({ kind: "subjects", after: 1, limit: 10 });
    if (!old || old === "stale") throw new Error("no page");
    expect(old.entities).toEqual([
      { type: "issue", id: `${repo.id}#7`, version: 3, deleted: true, row: null, deletedAt: null },
    ]);
  });

  it("goes a page at a time, each after the last key, and ends with an empty page when the last was full", async () => {
    await made("POST", "/issues", { title: "One" });
    await made("POST", "/pulls", { title: "Two", head: "feature", base: "main" });
    await made("POST", "/issues", { title: "Three" });
    expect(keys(await walk("subjects", 1))).toEqual([["1"], ["2"], ["3"], []]);
    expect(keys(await walk("subjects", 2))).toEqual([["1", "2"], ["3"]]);
    expect(keys(await walk("labels", 4)).map((page) => page.length)).toEqual([4, 4, 1]);
  });

  it("answers an empty kind with an empty last page", async () => {
    expect(keys(await walk("subjects", 10))).toEqual([[]]);
    expect(keys(await walk("milestones", 10))).toEqual([[]]);
  });

  it("answers stale under another epoch or ownership than the export's", async () => {
    const first = await exportPage({ kind: "repo", after: 0, limit: 1 });
    if (!first || first === "stale") throw new Error("no page");
    const { epochGen, ownerGen } = first;
    expect(
      await exportPage({
        kind: "subjects",
        after: 0,
        limit: 1,
        expected: { epochGen, ownerGen },
      }),
    ).not.toBe("stale");
    expect(
      await exportPage({
        kind: "subjects",
        after: 0,
        limit: 1,
        expected: { epochGen: epochGen + 1, ownerGen },
      }),
    ).toBe("stale");
    expect(
      await exportPage({
        kind: "labels",
        after: 0,
        limit: 1,
        expected: { epochGen, ownerGen: ownerGen + 1 },
      }),
    ).toBe("stale");
  });
});

describe("an export page's bytes", () => {
  const big = (n: number): ExportedEntity => ({
    type: "issue",
    id: `rep_x#${n}`,
    version: 1,
    deleted: false,
    // About 0.8 MiB of JSON each: two fit a page, three do not.
    row: { number: n, body: "é".repeat(400_000) },
  });
  let loaded: number[] = [];
  const sources = (entities: ExportedEntity[]) => ({
    position: () => ({
      sourceId: "rep_x",
      epochGen: 1,
      ownerGen: 1,
      watermark: 9,
      repo: { type: "repo", id: "rep_x", version: 1, deleted: false, row: {} },
    }),
    entries: (_kind: string, after: number, limit: number) =>
      entities
        .map((entity) => ({ key: Number(entity.id.split("#")[1]), entity }))
        .filter(({ key }) => key > after)
        .slice(0, limit)
        .map(({ key, entity }) => ({
          key,
          load: () => {
            loaded.push(key);
            return entity;
          },
        })),
  });

  it("stop at 2 MiB, the next page resuming after the last entity sent", () => {
    const all = [big(1), big(2), big(3), big(4), big(5)];
    loaded = [];
    const first = readExportPage(sources(all), { kind: "subjects", after: 0, limit: 200 });
    if (!first || first === "stale") throw new Error("no page");
    expect(first.entities.map((e) => e.id)).toEqual(["rep_x#1", "rep_x#2"]);
    expect(first.next).toBe(2);
    // Only what the page could hold is read whole: the two sent, and the one that did not fit.
    expect(loaded).toEqual([1, 2, 3]);
    const second = readExportPage(sources(all), { kind: "subjects", after: 2, limit: 200 });
    if (!second || second === "stale") throw new Error("no page");
    expect(second.entities.map((e) => e.id)).toEqual(["rep_x#3", "rep_x#4"]);
  });

  it("count the page's whole JSON, not only its entities'", () => {
    // Entities whose own JSON sums to exactly 2 MiB: with the page around them, one too many.
    const page = (n: number, size: number): ExportedEntity => {
      const bare = {
        type: "issue",
        id: `rep_x#${n}`,
        version: 1,
        deleted: false,
        row: { body: "" },
      };
      return { ...bare, row: { body: "x".repeat(size - JSON.stringify(bare).length) } };
    };
    const each = EXPORT_PAGE.bytes / 32;
    const all = Array.from({ length: 32 }, (_, i) => page(i + 1, each));
    expect(all.reduce((sum, e) => sum + JSON.stringify(e).length, 0)).toBe(EXPORT_PAGE.bytes);
    const read = readExportPage(sources(all), { kind: "subjects", after: 0, limit: 200 });
    if (!read || read === "stale") throw new Error("no page");
    expect(read.entities).toHaveLength(31);
    expect(new TextEncoder().encode(JSON.stringify(read)).length).toBeLessThanOrEqual(
      EXPORT_PAGE.bytes,
    );
  });

  it("are asked for within bounds", () => {
    const from = sources([big(1)]);
    expect(() => readExportPage(from, { kind: "subjects", after: 0, limit: 0 })).toThrow(/limit/);
    expect(() =>
      readExportPage(from, { kind: "subjects", after: 0, limit: EXPORT_PAGE.entities + 1 }),
    ).toThrow(/limit/);
    expect(() => readExportPage(from, { kind: "subjects", after: -1, limit: 1 })).toThrow(/after/);
    expect(() =>
      readExportPage(from, { kind: "issues" as ExportKind, after: 0, limit: 1 }),
    ).toThrow(/kind/);
  });

  it("always hold one entity, however large", () => {
    const huge: ExportedEntity = {
      ...big(1),
      row: { number: 1, body: "x".repeat(3 * 1024 * 1024) },
    };
    const page = readExportPage(sources([huge, big(2)]), {
      kind: "subjects",
      after: 0,
      limit: 200,
    });
    if (!page || page === "stale") throw new Error("no page");
    expect(page.entities.map((e) => e.id)).toEqual(["rep_x#1"]);
    expect(page.next).toBe(1);
  });
});
