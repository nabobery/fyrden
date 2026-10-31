// Issues in activity feeds: what issue events mean for feeds (threads
// `issue/<n>`), each kind of thread shown only to a token that may read that
// kind, and a deleted issue's items never shown again, however late an
// entry of it arrives.
import { env } from "cloudflare:workers";
import type { DomainEvent, FeedBlock } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { type EntryInit, entry, FROM_START } from "./helpers/feed.js";
import { scopedToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

let owner: Who;
let reader: Who;
let repo: { id: string; name: string };
let path: string;

const stub = () => env.REPO.getByName(repo.id);

/** The feed blocks of the outbox's events, with their event types. */
const blocks = async () =>
  (
    await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
        .toArray()
        .map((row) => JSON.parse(row.event) as DomainEvent),
    )
  )
    .filter((e) => e.feed)
    .map((e) => ({ type: e.type, ...(e.feed as FeedBlock) }));

async function deliver(principal: string, init: EntryInit) {
  await env.USER.getByName(principal).applyFeed([entry({ repoId: repo.id, ...init, principal })]);
}

/** What the principal's feed holds, by thread, whoever may read it. */
async function stored(principal: string): Promise<string[]> {
  const page = await env.USER.getByName(principal).listStreams(FROM_START, 5_000, {});
  if (page.expired) throw new Error("expired");
  return page.items.map((i) => i.threadKey).sort();
}

type FeedOut = { items: { thread_key: string; subject: { kind: string; number: number } }[] };
const feed = async (token: string) =>
  (await json<FeedOut>(api("GET", "/feed", token))).body.items.map((i) => i.thread_key).sort();

beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  reader = await user();
  expect(
    (
      await api("PUT", `${path}/collaborators/${reader.handle}`, owner.token, {
        permission: "pull",
      })
    ).status,
  ).toBe(200);
});

describe("issue events in feeds", () => {
  it("tell the mentioned of an issue, and its participants of its activity", async () => {
    const opened = await json<{ number: number }>(
      api("POST", `${path}/issues`, owner.token, {
        title: "Crash",
        body: `@${reader.handle} can you look?`,
      }),
    );
    const n = opened.body.number;
    await api("POST", `${path}/issues/${n}/comments`, reader.token, { body: "On it." });
    await api("PATCH", `${path}/issues/${n}`, owner.token, { title: "Crash on start" });
    await api("PATCH", `${path}/issues/${n}`, owner.token, { state: "closed" });
    const found = await blocks();
    expect(found.map((b) => [b.type, b.threadKey, b.subject.kind, b.action])).toEqual([
      ["issue.opened", `issue/${n}`, "issue", "opened"],
      ["issue_comment.created", `issue/${n}`, "issue", "comment"],
      ["issue.closed", `issue/${n}`, "issue", "closed"],
    ]);
    const [openedBlock, commented, closed] = found;
    expect(openedBlock?.audience).toEqual([
      expect.objectContaining({ principal: reader.principalId, kind: "mention" }),
    ]);
    // The author hears of the comment; the commenter of the close.
    expect(commented?.audience.map((a) => a.principal)).toEqual([owner.principalId]);
    expect(closed?.audience.map((a) => a.principal)).toEqual([reader.principalId]);
    expect(closed?.subject.title).toBe("Crash on start");
  });
});

describe("issues in a feed when read", () => {
  it("show each kind of thread only to a token that may read that kind", async () => {
    await deliver(reader.principalId, { subject: "issue", thread: 1, version: 1 });
    await deliver(reader.principalId, { subject: "pull", thread: 2, version: 1 });
    const issuesOnly = await scopedToken(reader.principalId, ["issues:read"], "pat");
    const pullsOnly = await scopedToken(reader.principalId, ["pull_requests:read"], "pat");
    expect(await feed(reader.token)).toEqual(["issue/1", "pull/2"]);
    expect(await feed(issuesOnly)).toEqual(["issue/1"]);
    expect(await feed(pullsOnly)).toEqual(["pull/2"]);
    const items = (await json<FeedOut>(api("GET", "/feed", reader.token))).body.items;
    expect(items.find((i) => i.thread_key === "issue/1")?.subject).toMatchObject({
      kind: "issue",
      number: 1,
    });
  });

  it("never show a deleted issue's items, even an entry arriving after the deletion", async () => {
    const { number } = (
      await json<{ number: number }>(api("POST", `${path}/issues`, owner.token, { title: "Spam" }))
    ).body;
    await deliver(reader.principalId, { subject: "issue", thread: number, version: 1 });
    await deliver(reader.principalId, { subject: "pull", thread: 99, version: 1 });
    expect(await feed(reader.token)).toEqual([`issue/${number}`, "pull/99"]);
    expect((await api("DELETE", `${path}/issues/${number}`, owner.token)).status).toBe(200);
    expect(await feed(reader.token)).toEqual(["pull/99"]);
    // The read made the feed forget it.
    expect(await stored(reader.principalId)).toEqual(["pull/99"]);
    // A delayed entry of it (sent before the deletion) shows nothing either.
    await deliver(reader.principalId, {
      subject: "issue",
      thread: number,
      version: 2,
      kind: "mention",
      priority: "P0",
    });
    expect(await feed(reader.token)).toEqual(["pull/99"]);
    expect(await stored(reader.principalId)).toEqual(["pull/99"]);
  });
});

describe("feeds past their budgets", () => {
  /** Issues `numbers` of the repository deleted (their tombstones written outright). */
  async function deleted(numbers: number[]) {
    await inRepo(stub(), (r: RepoDO) => {
      for (const n of numbers)
        r.git.context.storage.sql.exec(
          "INSERT INTO issue_tombstones (number, version, deleted_at) VALUES (?, 2, 1)",
          n,
        );
    });
  }
  const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);
  async function deliverMany(principal: string, inits: EntryInit[]) {
    await env.USER.getByName(principal).applyFeed(
      inits.map((init) => entry({ repoId: repo.id, ...init, principal })),
    );
  }

  it("check every deleted issue's thread, more than a call's worth too", async () => {
    await deleted(range(1, 150));
    await deliverMany(
      reader.principalId,
      range(1, 150).map((thread) => ({ subject: "issue" as const, thread, version: 1 })),
    );
    await deliver(reader.principalId, { subject: "pull", thread: 900, version: 1 });
    expect(await feed(reader.token)).toEqual(["pull/900"]);
    expect(await stored(reader.principalId)).toEqual(["pull/900"]);
  });

  it("check issue threads met on a later read of the feed within one answer", async () => {
    // More deleted issues' items than one read of the feed takes (its pages are 200), so the
    // repository is decided on the first and the rest of its threads come on the second.
    await deleted(range(1, 250));
    await deliverMany(
      reader.principalId,
      range(1, 250).map((thread) => ({ subject: "issue" as const, thread, version: 1 })),
    );
    await deliver(reader.principalId, { subject: "pull", thread: 900, version: 1 });
    expect(await feed(reader.token)).toEqual(["pull/900"]);
    expect(await stored(reader.principalId)).toEqual(["pull/900"]);
  });

  it("leave the kinds a token never reads out before its budgets", async () => {
    // More issue items than an answer reads, then one pull request item.
    await deliverMany(
      reader.principalId,
      range(1, 1_100).map((thread) => ({ subject: "issue" as const, thread, version: 1 })),
    );
    await deliver(reader.principalId, { subject: "pull", thread: 5000, version: 1 });
    const pullsOnly = await scopedToken(reader.principalId, ["pull_requests:read"], "pat");
    expect(await feed(pullsOnly)).toEqual(["pull/5000"]);
    const synced = (
      await json<{ items: { thread_key: string }[]; complete: boolean }>(
        api("GET", "/feed/sync", pullsOnly),
      )
    ).body;
    expect(synced.items.map((i) => i.thread_key)).toEqual(["pull/5000"]);
    expect(synced.complete).toBe(true);
  });
});
