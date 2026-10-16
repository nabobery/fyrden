// Feed entries built by hand, as a repository would send them, and a feed
// on a Durable Object's storage, for the activity feed's tests.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FeedEntry, FeedKind, FeedPriority } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import type { UserDO } from "../../src/do/UserDO.js";
import { Feed } from "../../src/do/user/feed.js";

export const DAY = 24 * 60 * 60 * 1000;

export interface EntryInit {
  repoId?: string;
  thread?: number;
  kind?: FeedKind;
  version: number;
  state?: "open" | "resolved";
  priority?: FeedPriority;
  member?: string | null;
  silent?: boolean;
  occurredAt?: number;
  principal?: string;
  action?: string;
  actor?: string;
  actorTrust?: "write" | "read" | "none";
  epochGen?: number;
}

/** One recipient's entry, built by hand as the repository would send it. */
export function entry(init: EntryInit): FeedEntry {
  const thread = init.thread ?? 1;
  const kind = init.kind ?? "activity";
  return {
    eventKey: `rep_test:${init.epochGen ?? 1}:${init.version}`,
    repoId: init.repoId ?? "rep_test",
    occurredAt: init.occurredAt ?? Date.now(),
    actor: init.actor ?? "usr_actor",
    epochGen: init.epochGen ?? 1,
    feed: {
      threadKey: `pull/${thread}`,
      subject: { kind: "pull", number: thread, title: `Pull ${thread}`, version: init.version },
      action: init.action ?? (kind === "activity" ? "comment" : kind),
      actorRoot: "usr_actor",
      actorTrust: init.actorTrust ?? "write",
      member:
        init.member === undefined
          ? kind === "activity"
            ? String(init.version)
            : null
          : init.member,
      excerpt: null,
    },
    recipient: {
      principal: init.principal ?? "usr_reader",
      kind,
      reasons: ["commenter"],
      priority: init.priority ?? "P1",
      state: init.state ?? "open",
      silent: init.silent ?? false,
    },
  };
}

type Storage = DurableObjectState["storage"];

/** The member ids of an item's `members` column. */
export const ids = (members: unknown) =>
  (JSON.parse((members as string | undefined) ?? "[]") as { id: string }[]).map((m) => m.id);

/** A feed on a fresh object's storage, with what the tests read from it. */
export function feedIn(storage: Storage, now: () => number = Date.now) {
  const feed = new Feed(storage.sql, now);
  const apply = (entries: readonly FeedEntry[]) =>
    storage.transactionSync(() => feed.apply(entries));
  const head = () =>
    storage.sql.exec<{ head_seq: number }>("SELECT head_seq FROM feed_meta").one().head_seq;
  const rows = (where = "true") =>
    storage.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT * FROM feed_items WHERE ${where} ORDER BY repo_id, thread_key, kind`,
      )
      .toArray();
  /** The shown items without their sequence numbers (which depend on arrival order). */
  const items = () =>
    rows("feed_seq IS NOT NULL").map(({ feed_seq: _, seq_at: __, ...rest }) => rest);
  /**
   * Every row as it bears on what is shown: an item whole (but its
   * sequence number), a tombstone by what it guards against.
   */
  const state = () =>
    rows().map(({ feed_seq, seq_at: _, ...rest }) =>
      feed_seq === null
        ? { tombstone: [rest.repo_id, rest.thread_key, rest.kind, rest.version, rest.state] }
        : rest,
    );
  const reset = () => {
    storage.sql.exec("DELETE FROM feed_items");
    storage.sql.exec("DELETE FROM feed_evictions");
    storage.sql.exec("UPDATE feed_meta SET head_seq = 0, low_watermark = 0, items = 0");
  };
  return { feed, apply, head, rows, items, state, reset };
}

export const inFeed = <T>(fn: (storage: Storage) => T) =>
  runInDurableObject(env.USER.getByName(uniqueId("usr")), (_: UserDO, state) => fn(state.storage));
