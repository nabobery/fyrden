import type { Output, searchIssues, searchRepositories } from "@fyrden/api-contract";
import { SHOWN_HANDLE } from "../accounts/handles.js";
import type { OpContext } from "../ops/execute.js";
import { defaultBranchOf, type RepoEntry } from "../repos/directory.js";
import { type InteractiveReservation, readOnDay } from "./interactive.js";
import { type DocMatch, fenced, type RepoMatch } from "./query.js";
import { DOC_KIND, DOC_STATE } from "./statements.js";
import { SOURCE_VISIBLE } from "./visibility.js";

/*
 * A search's page of matches as its results: each issue's or pull
 * request's row, labels and milestone as the read model has them (live and
 * fenced, read again: one gone since it matched is left out), its people's
 * handles now (one directory query a page; `ghost` for one deleted), its
 * repository's identity as the directory has it now.
 */

type SearchIssue = Output<typeof searchIssues>["items"][number];
type SearchRepository = Output<typeof searchRepositories>["items"][number];

interface DocRow {
  doc_id: number;
  repo_id: string;
  number: number;
  kind: number;
  state: number;
  state_reason: string | null;
  draft: number;
  locked: number;
  lock_reason: string | null;
  author_id: string | null;
  assignees: string;
  labels: string;
  milestone: number | null;
  title: string;
  body: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  merged_at: number | null;
}

/** Handles of principals `ids` now: `ghost` for one being deleted or deleted, its id for one unknown. */
async function handlesOf(
  ctx: Pick<OpContext, "env" | "metrics">,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  ctx.metrics.count("d1.query", { db: "directory", op: "search_people" });
  const { results } = await ctx.env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT p.id, ${SHOWN_HANDLE} AS handle FROM principals p
       WHERE p.id IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(ids))
    .all<{ id: string; handle: string }>();
  return new Map(results.map((r) => [r.id, r.handle]));
}

const repositoryRef = (entry: RepoEntry) => ({
  id: entry.id,
  owner: { login: entry.ownerHandle },
  name: entry.name,
  full_name: `${entry.ownerHandle}/${entry.name}`,
});

/** The issues and pull requests `matches` (of `repos`, the scope's), in their order; what it read. */
export async function hydrateIssues(
  ctx: Pick<OpContext, "env" | "metrics">,
  db: D1Database,
  reservation: InteractiveReservation,
  matches: readonly DocMatch[],
  repos: ReadonlyMap<string, RepoEntry>,
): Promise<{ items: SearchIssue[]; reads: number }> {
  if (matches.length === 0) return { items: [], reads: 0 };
  const ids = JSON.stringify(matches.map((m) => m.docId));
  const page = `SELECT d.* FROM search_docs d WHERE d.doc_id IN (SELECT value FROM json_each(?1))
    AND ${fenced("d", "d.repo_id")} AND ${SOURCE_VISIBLE("d.repo_id")}`;
  const [docs, labels, milestones] = await readOnDay(db, reservation, [
    db.prepare(page).bind(ids),
    db
      .prepare(
        `SELECT d.doc_id, sl.label_id, sl.name, sl.color, sl.description
         FROM (${page}) d, json_each(d.labels) l
         JOIN search_labels sl ON sl.repo_id = d.repo_id AND sl.label_id = l.value
         WHERE ${fenced("sl", "d.repo_id")} ORDER BY d.doc_id, l.key`,
      )
      .bind(ids),
    db
      .prepare(
        `SELECT d.doc_id, m.number, m.title, m.state, m.description, m.due_on, m.closed_at
         FROM (${page}) d JOIN search_milestones m
           ON m.repo_id = d.repo_id AND m.number = d.milestone
         WHERE ${fenced("m", "d.repo_id")}`,
      )
      .bind(ids),
  ]);
  const reads = [docs, labels, milestones].reduce((n, r) => n + (r?.meta.rows_read ?? 0), 0);
  const rows = new Map(((docs?.results ?? []) as unknown as DocRow[]).map((r) => [r.doc_id, r]));
  const labelsOf = new Map<number, SearchIssue["labels"]>();
  for (const l of (labels?.results ?? []) as {
    doc_id: number;
    label_id: number;
    name: string;
    color: string;
    description: string | null;
  }[])
    labelsOf.set(l.doc_id, [
      ...(labelsOf.get(l.doc_id) ?? []),
      { id: l.label_id, name: l.name, color: l.color, description: l.description },
    ]);
  const milestoneOf = new Map(
    (
      (milestones?.results ?? []) as {
        doc_id: number;
        number: number;
        title: string;
        state: number;
        description: string | null;
        due_on: number | null;
        closed_at: number | null;
      }[]
    ).map((m) => [
      m.doc_id,
      {
        number: m.number,
        title: m.title,
        state: m.state === 1 ? ("open" as const) : ("closed" as const),
        description: m.description,
        due_on: m.due_on,
        closed_at: m.closed_at,
      },
    ]),
  );
  const people = new Set<string>();
  for (const row of rows.values()) {
    if (row.author_id) people.add(row.author_id);
    for (const id of JSON.parse(row.assignees) as string[]) people.add(id);
  }
  const handles = await handlesOf(ctx, [...people]);
  const person = (id: string) => ({ id, login: handles.get(id) ?? id });
  const items = matches.flatMap((m): SearchIssue[] => {
    const row = rows.get(m.docId);
    const entry = repos.get(m.repoId);
    if (!row || !entry) return [];
    const pull = row.kind === DOC_KIND.pull;
    return [
      {
        id: row.number,
        number: row.number,
        title: row.title,
        body: row.body,
        state: row.state === DOC_STATE.open ? "open" : "closed",
        state_reason: row.state_reason as SearchIssue["state_reason"],
        user: person(row.author_id ?? ""),
        assignees: (JSON.parse(row.assignees) as string[]).map(person),
        labels: labelsOf.get(row.doc_id) ?? [],
        milestone: milestoneOf.get(row.doc_id) ?? null,
        locked: row.locked === 1,
        active_lock_reason: row.lock_reason as SearchIssue["active_lock_reason"],
        created_at: row.created_at,
        updated_at: row.updated_at,
        closed_at: row.closed_at,
        ...(pull && { draft: row.draft === 1, pull_request: { merged_at: row.merged_at } }),
        repository: repositoryRef(entry),
      },
    ];
  });
  return { items, reads };
}

/** The repositories `matches` (of `repos`, the scope's), in their order; what it read. */
export async function hydrateRepositories(
  db: D1Database,
  reservation: InteractiveReservation,
  matches: readonly RepoMatch[],
  repos: ReadonlyMap<string, RepoEntry>,
): Promise<{ items: SearchRepository[]; reads: number }> {
  if (matches.length === 0) return { items: [], reads: 0 };
  const [details] = await readOnDay(db, reservation, [
    db
      .prepare(
        `SELECT r.repo_id, r.description, r.default_branch FROM repos r
         WHERE r.repo_id IN (SELECT value FROM json_each(?1))
           AND ${fenced("r", "r.repo_id")} AND ${SOURCE_VISIBLE("r.repo_id")}`,
      )
      .bind(JSON.stringify(matches.map((m) => m.repoId))),
  ]);
  const rows = new Map(
    (
      (details?.results ?? []) as {
        repo_id: string;
        description: string | null;
        default_branch: string | null;
      }[]
    ).map((r) => [r.repo_id, r]),
  );
  const items = matches.flatMap((m): SearchRepository[] => {
    const row = rows.get(m.repoId);
    const entry = repos.get(m.repoId);
    if (!row || !entry) return [];
    return [
      {
        id: entry.id,
        owner: { id: entry.ownerId, login: entry.ownerHandle },
        name: entry.name,
        full_name: `${entry.ownerHandle}/${entry.name}`,
        visibility: entry.visibility,
        description: row.description,
        default_branch: defaultBranchOf(row.default_branch),
        created_at: entry.createdAt,
      },
    ];
  });
  return { items, reads: details?.meta.rows_read ?? 0 };
}
