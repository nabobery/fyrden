import type { RefActor, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  decideMetadataAction,
  LABEL_ENTITY,
  type LabelSpec,
  labelNameKey,
  MAX_ASSIGNEES,
  MAX_REPO_LABELS,
  MAX_SUBJECT_LABELS,
  MILESTONE_ENTITY,
  type MilestoneState,
  type RepoRole,
} from "@fyrden/domain";
import type { RepoEvents } from "./events.js";
import type { PullCaller } from "./pulls.js";
import { NO_REACTIONS, type ReactionCounts } from "./reactions.js";

/*
 * A repository's labels and milestones, and the labels, assignees and
 * milestone of its issues and pull requests (kept by number: both kinds
 * share one sequence). Label ids and milestone numbers come from counters
 * in `repo_meta` and are never reused, so deleting one is one row: what
 * pointed at it stays and reads as nothing (a subject's references to
 * deleted labels go when its labels next change). Milestone counts are
 * kept by triggers on `issues` and `pull_requests` (schema v34).
 */

export type SubjectKind = "issue" | "pull";

export interface LabelRecord {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string | null;
  readonly isDefault: boolean;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MilestoneRecord {
  readonly number: number;
  readonly title: string;
  readonly description: string | null;
  readonly state: MilestoneState;
  readonly dueOn: number | null;
  readonly closedAt: number | null;
  readonly openIssues: number;
  readonly closedIssues: number;
  readonly openPulls: number;
  readonly closedPulls: number;
  readonly creator: string;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** What an issue or pull request is sorted by, as it stands. */
export interface SubjectMeta {
  /** By name, ignoring case. */
  readonly labels: readonly LabelRecord[];
  /** Principal ids, ascending. */
  readonly assignees: readonly string[];
  readonly milestone: MilestoneRecord | null;
  /** Its reactions counted by content, as they stand. */
  readonly reactions: ReactionCounts;
}

/** An issue or pull request whose labels, assignees and milestone are read: its number, and its milestone as recorded. */
export interface MetaSubject {
  readonly number: number;
  readonly milestone: number | null;
}

/** What a snapshot of an issue or pull request carries of it. */
export interface SnapshotMeta {
  readonly labels: number[];
  readonly assignees: string[];
  readonly milestone: number | null;
}

/** A principal to assign: its root identity and its role now (null: no access). */
export interface Assignee {
  readonly id: string;
  readonly root: string;
  readonly role: RepoRole | null;
}

/** A change of an issue's or pull request's labels, assignees or milestone; one left out stays. */
export interface MetaPatch {
  /** Label names (ignoring case): all of them, ones to add, or ones to take off. */
  readonly labels?:
    | { readonly set: readonly string[] }
    | { readonly add: readonly string[] }
    | { readonly remove: readonly string[] };
  readonly assignees?:
    | { readonly set: readonly Assignee[] }
    | { readonly add: readonly Assignee[] }
    | { readonly remove: readonly string[] };
  /** A milestone's number, or null for none. */
  readonly milestone?: number | null;
}

/** A change as asked for: assignees by principal id, their access worked out by the object. */
export interface MetaInput {
  readonly labels?: MetaPatch["labels"];
  readonly assignees?:
    | { readonly set: readonly string[] }
    | { readonly add: readonly string[] }
    | { readonly remove: readonly string[] };
  readonly milestone?: number | null;
}

export type MetaFailure =
  | "not_found"
  | "forbidden"
  | "label_not_found"
  | "too_many_labels"
  | "assignee_no_access"
  | "too_many_assignees"
  | "milestone_not_found";

/** One event a change of a subject emits, as `<kind's prefix>.<event>`. */
export interface SubjectEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/** A checked change, applied (all of it) by `apply` in the caller's transaction. */
export interface MetaPlan {
  readonly kind: SubjectKind;
  /** Writes it; `emit` false for a subject being created (its opening event carries it all). */
  apply(emit: boolean): void;
  /** Whether it changes anything. */
  readonly changes: boolean;
}

export type LabelFailure = "label_not_found" | "label_exists" | "too_many_labels" | "forbidden";
export type MilestoneFailure = "milestone_not_found" | "milestone_exists" | "forbidden";

/** A milestone listing's page: a state, an order by due date (none last), where to start after. */
export interface MilestoneQuery {
  readonly state: MilestoneState | "all";
  readonly direction: "asc" | "desc";
  readonly after: { readonly key: number; readonly number: number } | null;
  readonly limit: number;
}

/** What a milestone without a due date sorts as: after every date. */
export const NO_DUE_DATE = Number.MAX_SAFE_INTEGER;

type LabelRow = {
  id: number;
  name: string;
  color: string;
  description: string | null;
  is_default: number;
  version: number;
  created_at: number;
  updated_at: number;
};

type MilestoneRow = {
  number: number;
  title: string;
  description: string | null;
  state: MilestoneState;
  due_on: number | null;
  closed_at: number | null;
  open_issues: number;
  closed_issues: number;
  open_pulls: number;
  closed_pulls: number;
  creator: string;
  version: number;
  created_at: number;
  updated_at: number;
};

const PREFIX: Record<SubjectKind, string> = { issue: "issue", pull: "pull_request" };

export class RepoSubjectMeta {
  constructor(
    private readonly deps: {
      readonly git: RepoGitStorage;
      readonly events: RepoEvents;
      readonly repoId: () => string;
      /** Whether `number` is an issue or a pull request now; undefined for neither. */
      readonly kindOf: (number: number) => SubjectKind | undefined;
      /** Reactions to issues and pull requests, counted for each answered. */
      readonly reactionsOf: (numbers: readonly number[]) => Map<number, ReactionCounts>;
      /**
       * In the change's transaction: bumps the subject's version and update
       * time, and emits each event with its snapshot as it now stands.
       */
      readonly touch: (
        kind: SubjectKind,
        number: number,
        events: readonly SubjectEvent[],
        actor: RefActor,
      ) => void;
    },
  ) {}

  // --- Labels -------------------------------------------------------------

  /** A page of the repository's labels by name (ignoring case), after `after`. */
  labels(after: string | null, limit: number): LabelRecord[] {
    return (
      after === null
        ? this.#exec<LabelRow>("SELECT * FROM labels ORDER BY name COLLATE NOCASE LIMIT ?", limit)
        : this.#exec<LabelRow>(
            "SELECT * FROM labels WHERE name > ? COLLATE NOCASE ORDER BY name COLLATE NOCASE LIMIT ?",
            after,
            limit,
          )
    ).map(labelRecord);
  }

  /** The label named `name` (ignoring case). */
  label(name: string): LabelRecord | undefined {
    const [row] = this.#exec<LabelRow>("SELECT * FROM labels WHERE name = ? COLLATE NOCASE", name);
    return row && labelRecord(row);
  }

  /** Creates a label (write). */
  createLabel(
    spec: LabelSpec,
    caller: PullCaller,
  ): { ok: true; label: LabelRecord } | { ok: false; code: LabelFailure } {
    if (!decideMetadataAction("manage_labels", caller.role).ok)
      return { ok: false, code: "forbidden" };
    if (this.label(spec.name)) return { ok: false, code: "label_exists" };
    if (this.#labelCount() >= MAX_REPO_LABELS) return { ok: false, code: "too_many_labels" };
    const label = this.#storage().transactionSync(() => {
      const created = this.#insertLabel(spec, false);
      this.#emitLabel("created", created, caller.actor);
      this.deps.events.auditChange("label.create", caller.actor, { label: created.name });
      return created;
    });
    return { ok: true, label };
  }

  /**
   * Copies labels in (a new repository's defaults, or defaults asked for):
   * ones whose names are taken are left as they are, and the repository's
   * cap is kept. Each emits its creation; audited once when `caller` asked.
   * Answers the labels added.
   */
  copyLabels(specs: readonly LabelSpec[], actor: RefActor | null): LabelRecord[] {
    return this.#storage().transactionSync(() => {
      const added: LabelRecord[] = [];
      let count = this.#labelCount();
      for (const spec of specs) {
        if (count >= MAX_REPO_LABELS) break;
        if (this.label(spec.name)) continue;
        const created = this.#insertLabel(spec, true);
        this.#emitLabel("created", created, actor);
        added.push(created);
        count++;
      }
      if (actor && added.length > 0)
        this.deps.events.auditChange("label.copy_defaults", actor, {
          labels: added.map((l) => l.name),
        });
      return added;
    });
  }

  /** Renames or recolors a label, or changes its description (write). */
  updateLabel(
    name: string,
    patch: {
      readonly name?: string;
      readonly color?: string;
      readonly description?: string | null;
    },
    caller: PullCaller,
  ): { ok: true; label: LabelRecord } | { ok: false; code: LabelFailure } {
    if (!decideMetadataAction("manage_labels", caller.role).ok)
      return { ok: false, code: "forbidden" };
    const current = this.label(name);
    if (!current) return { ok: false, code: "label_not_found" };
    const next = {
      name: patch.name ?? current.name,
      color: (patch.color ?? current.color).toLowerCase(),
      description: patch.description === undefined ? current.description : patch.description,
    };
    // Another label by that name (as storage compares names), not this one renamed in case.
    const taken = this.label(next.name);
    if (taken && taken.id !== current.id) return { ok: false, code: "label_exists" };
    if (
      next.name === current.name &&
      next.color === current.color &&
      next.description === current.description
    )
      return { ok: true, label: current };
    const label = this.#storage().transactionSync(() => {
      const [row] = this.#exec<LabelRow>(
        `UPDATE labels SET name = ?, color = ?, description = ?, version = version + 1,
           updated_at = ? WHERE id = ? RETURNING *`,
        next.name,
        next.color,
        next.description,
        this.#now(),
        current.id,
      );
      const updated = labelRecord(row as LabelRow);
      this.#emitLabel("edited", updated, caller.actor, {
        changes: {
          ...(next.name !== current.name && { name: { from: current.name } }),
          ...(next.color !== current.color && { color: { from: current.color } }),
          ...(next.description !== current.description && {
            description: { from: current.description },
          }),
        },
      });
      this.deps.events.auditChange("label.edit", caller.actor, { label: updated.name });
      return updated;
    });
    return { ok: true, label };
  }

  /** Deletes a label (write); issues and pull requests carrying it no longer do. */
  deleteLabel(name: string, caller: PullCaller): { ok: true } | { ok: false; code: LabelFailure } {
    if (!decideMetadataAction("manage_labels", caller.role).ok)
      return { ok: false, code: "forbidden" };
    const current = this.label(name);
    if (!current) return { ok: false, code: "label_not_found" };
    this.#storage().transactionSync(() => {
      this.#exec("DELETE FROM labels WHERE id = ?", current.id);
      this.#emitLabel(
        "deleted",
        { ...current, version: current.version + 1 },
        caller.actor,
        null,
        true,
      );
      this.deps.events.auditChange("label.delete", caller.actor, { label: current.name });
    });
    return { ok: true };
  }

  // --- Milestones ---------------------------------------------------------

  /**
   * A page of milestones by due date (none last), then number: each state
   * is an index range, a continuation's boundary split in two (as the
   * issue listing), merged here.
   */
  milestones(query: MilestoneQuery): MilestoneRecord[] {
    const desc = query.direction === "desc";
    const cmp = desc ? "<" : ">";
    const order = desc ? "DESC" : "ASC";
    const key = `ifnull(due_on, ${NO_DUE_DATE})`;
    const found: MilestoneRow[] = [];
    for (const state of query.state === "all" ? (["open", "closed"] as const) : [query.state]) {
      const select = `SELECT * FROM milestones WHERE state = ?`;
      const { after } = query;
      const ranges: [string, ...unknown[]][] =
        after === null
          ? [[`${select} ORDER BY ${key} ${order}, number ${order} LIMIT ?`, state]]
          : [
              [
                `${select} AND ${key} = ? AND number ${cmp} ? ORDER BY number ${order} LIMIT ?`,
                state,
                after.key,
                after.number,
              ],
              [
                `${select} AND ${key} ${cmp} ? ORDER BY ${key} ${order}, number ${order} LIMIT ?`,
                state,
                after.key,
              ],
            ];
      for (const [sql, ...bindings] of ranges)
        found.push(...this.#exec<MilestoneRow>(sql, ...bindings, query.limit));
    }
    const sortKey = (m: MilestoneRow) => m.due_on ?? NO_DUE_DATE;
    found.sort((a, b) => {
      const by = sortKey(a) - sortKey(b) || a.number - b.number;
      return desc ? -by : by;
    });
    return found.slice(0, query.limit).map(milestoneRecord);
  }

  milestone(number: number): MilestoneRecord | undefined {
    const [row] = this.#exec<MilestoneRow>("SELECT * FROM milestones WHERE number = ?", number);
    return row && milestoneRecord(row);
  }

  /** Creates a milestone (write); its number from the repository's milestone counter. */
  createMilestone(
    input: {
      readonly title: string;
      readonly description: string | null;
      readonly state: MilestoneState;
      readonly dueOn: number | null;
    },
    caller: PullCaller,
  ): { ok: true; milestone: MilestoneRecord } | { ok: false; code: MilestoneFailure } {
    if (!decideMetadataAction("manage_milestones", caller.role).ok)
      return { ok: false, code: "forbidden" };
    if (this.#titleTaken(input.title)) return { ok: false, code: "milestone_exists" };
    const milestone = this.#storage().transactionSync(() => {
      const now = this.#now();
      const number = this.#exec<{ next_milestone: number }>(
        "UPDATE repo_meta SET next_milestone = next_milestone + 1 WHERE id = 1 RETURNING next_milestone - 1 AS next_milestone",
      )[0]?.next_milestone as number;
      const [row] = this.#exec<MilestoneRow>(
        `INSERT INTO milestones (number, title, description, state, due_on, closed_at, creator,
           created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        number,
        input.title,
        input.description,
        input.state,
        input.dueOn,
        input.state === "closed" ? now : null,
        caller.actor.principal,
        now,
        now,
      );
      const created = milestoneRecord(row as MilestoneRow);
      this.#emitMilestone("created", created, caller.actor);
      this.deps.events.auditChange("milestone.create", caller.actor, { milestone: number });
      return created;
    });
    return { ok: true, milestone };
  }

  /** Changes a milestone (write): its title, description, due date or state. */
  updateMilestone(
    number: number,
    patch: {
      readonly title?: string;
      readonly description?: string | null;
      readonly state?: MilestoneState;
      readonly dueOn?: number | null;
    },
    caller: PullCaller,
  ): { ok: true; milestone: MilestoneRecord } | { ok: false; code: MilestoneFailure } {
    if (!decideMetadataAction("manage_milestones", caller.role).ok)
      return { ok: false, code: "forbidden" };
    const current = this.milestone(number);
    if (!current) return { ok: false, code: "milestone_not_found" };
    const next = {
      title: patch.title ?? current.title,
      description: patch.description === undefined ? current.description : patch.description,
      state: patch.state ?? current.state,
      dueOn: patch.dueOn === undefined ? current.dueOn : patch.dueOn,
    };
    if (next.title !== current.title && this.#titleTaken(next.title))
      return { ok: false, code: "milestone_exists" };
    const edited =
      next.title !== current.title ||
      next.description !== current.description ||
      next.dueOn !== current.dueOn;
    const stateChanged = next.state !== current.state;
    if (!edited && !stateChanged) return { ok: true, milestone: current };
    const milestone = this.#storage().transactionSync(() => {
      const now = this.#now();
      const [row] = this.#exec<MilestoneRow>(
        `UPDATE milestones SET title = ?, description = ?, due_on = ?, state = ?,
           closed_at = CASE WHEN ?4 = 'closed' THEN ifnull(closed_at, ?5) END,
           version = version + 1, updated_at = ?5 WHERE number = ?6 RETURNING *`,
        next.title,
        next.description,
        next.dueOn,
        next.state,
        now,
        number,
      );
      const updated = milestoneRecord(row as MilestoneRow);
      if (edited)
        this.#emitMilestone("edited", updated, caller.actor, {
          changes: {
            ...(next.title !== current.title && { title: { from: current.title } }),
            ...(next.description !== current.description && {
              description: { from: current.description },
            }),
            ...(next.dueOn !== current.dueOn && { due_on: { from: current.dueOn } }),
          },
        });
      if (stateChanged)
        this.#emitMilestone(next.state === "closed" ? "closed" : "opened", updated, caller.actor);
      this.deps.events.auditChange("milestone.edit", caller.actor, { milestone: number });
      return updated;
    });
    return { ok: true, milestone };
  }

  /** Deletes a milestone (write); issues and pull requests in it are in none from then on. */
  deleteMilestone(
    number: number,
    caller: PullCaller,
  ): { ok: true } | { ok: false; code: MilestoneFailure } {
    if (!decideMetadataAction("manage_milestones", caller.role).ok)
      return { ok: false, code: "forbidden" };
    const current = this.milestone(number);
    if (!current) return { ok: false, code: "milestone_not_found" };
    this.#storage().transactionSync(() => {
      this.#exec("DELETE FROM milestones WHERE number = ?", number);
      this.#emitMilestone(
        "deleted",
        { ...current, version: current.version + 1 },
        caller.actor,
        null,
        true,
      );
      this.deps.events.auditChange("milestone.delete", caller.actor, { milestone: number });
    });
    return { ok: true };
  }

  // --- Issues and pull requests -------------------------------------------

  /** What `number` is sorted by (labels, assignees, milestone), as it stands; nothing for none. */
  of(number: number, withReactions = true): SubjectMeta {
    const [recorded] = this.#exec<{ milestone: number | null }>(
      `SELECT milestone FROM issues WHERE number = ?1
       UNION ALL SELECT milestone FROM pull_requests WHERE number = ?1`,
      number,
    );
    return this.ofMany([{ number, milestone: recorded?.milestone ?? null }], withReactions).get(
      number,
    ) as SubjectMeta;
  }

  /**
   * `of` for subjects whose rows were read already (their milestones as
   * recorded): their labels and assignees in one query, their milestones
   * in another.
   */
  ofMany(subjects: readonly MetaSubject[], withReactions = true): Map<number, SubjectMeta> {
    const labels = new Map<number, LabelRecord[]>();
    const assignees = new Map<number, string[]>();
    if (subjects.length > 0)
      for (const row of this.#exec<LabelRow & { number: number; principal: string | null }>(
        `SELECT s.number, NULL AS principal, l.* FROM subject_labels s
           JOIN labels l ON l.id = s.label_id
           WHERE s.number IN (SELECT value FROM json_each(?1))
         UNION ALL
         SELECT number, principal, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
           FROM subject_assignees WHERE number IN (SELECT value FROM json_each(?1))`,
        JSON.stringify(subjects.map((s) => s.number)),
      ))
        if (row.principal === null)
          labels.set(row.number, [...(labels.get(row.number) ?? []), labelRecord(row)]);
        else assignees.set(row.number, [...(assignees.get(row.number) ?? []), row.principal]);
    const wanted = [
      ...new Set(subjects.flatMap((s) => (s.milestone === null ? [] : [s.milestone]))),
    ];
    const milestones = new Map(
      (wanted.length === 0
        ? []
        : this.#exec<MilestoneRow>(
            "SELECT * FROM milestones WHERE number IN (SELECT value FROM json_each(?))",
            JSON.stringify(wanted),
          )
      ).map((row) => [row.number, milestoneRecord(row)]),
    );
    // Snapshots and planned changes leave the counts out (not read at all).
    const reactions = withReactions
      ? this.deps.reactionsOf(subjects.map((s) => s.number))
      : new Map<number, ReactionCounts>();
    return new Map(
      subjects.map((s) => [
        s.number,
        {
          reactions: reactions.get(s.number) ?? NO_REACTIONS,
          labels: (labels.get(s.number) ?? []).sort(byName),
          assignees: (assignees.get(s.number) ?? []).sort(),
          milestone: (s.milestone !== null && milestones.get(s.milestone)) || null,
        },
      ]),
    );
  }

  /** What a snapshot of `number` carries of it, as it stands. */
  snapshot(number: number): SnapshotMeta {
    const meta = this.of(number, false);
    return {
      labels: meta.labels.map((l) => l.id).sort((a, b) => a - b),
      assignees: [...meta.assignees],
      milestone: meta.milestone?.number ?? null,
    };
  }

  /**
   * Checks a change of `number`'s labels, assignees or milestone for the
   * caller (triage, the author too; a kind the caller may act on), all of
   * it before anything is written: unknown labels, assignees without access
   * and caps refuse it whole.
   */
  plan(
    number: number,
    patch: MetaPatch,
    caller: PullCaller,
    kinds: readonly SubjectKind[],
  ): { ok: true; plan: MetaPlan } | { ok: false; code: MetaFailure } {
    const kind = this.deps.kindOf(number);
    if (!kind || !kinds.includes(kind)) return { ok: false, code: "not_found" };
    return this.#planFor(kind, number, patch, caller);
  }

  /**
   * `plan` for an issue being opened, whose number is taken in its
   * transaction: checked here (it starts with nothing), and planned again
   * for its number there, with nothing changed in between.
   */
  planNew(
    patch: MetaPatch,
    caller: PullCaller,
  ): { ok: true; plan: (number: number) => MetaPlan } | { ok: false; code: MetaFailure } {
    // No subject is numbered 0: it has nothing yet, as the new one.
    const checked = this.#planFor("issue", 0, patch, caller);
    if (!checked.ok) return checked;
    return {
      ok: true,
      plan: (number) => {
        const planned = this.#planFor("issue", number, patch, caller);
        if (!planned.ok) throw new Error(`a new issue's change was refused: ${planned.code}`);
        return planned.plan;
      },
    };
  }

  /** In a subject's deletion: its labels and assignees go with it. */
  forget(number: number): void {
    this.#exec("DELETE FROM subject_labels WHERE number = ?", number);
    this.#exec("DELETE FROM subject_assignees WHERE number = ?", number);
  }

  #planFor(
    kind: SubjectKind,
    number: number,
    patch: MetaPatch,
    caller: PullCaller,
  ): { ok: true; plan: MetaPlan } | { ok: false; code: MetaFailure } {
    const current = this.of(number, false);
    const writes: (() => void)[] = [];
    const events: SubjectEvent[] = [];

    if (patch.labels) {
      if (!decideMetadataAction("label", caller.role).ok) return { ok: false, code: "forbidden" };
      const named = (names: readonly string[]) => {
        const found: LabelRecord[] = [];
        for (const name of names) {
          const label = this.label(name);
          if (!label) return undefined;
          if (!found.some((l) => l.id === label.id)) found.push(label);
        }
        return found;
      };
      const op = patch.labels;
      const given = named("set" in op ? op.set : "add" in op ? op.add : op.remove);
      if (!given) return { ok: false, code: "label_not_found" };
      const has = new Set(current.labels.map((l) => l.id));
      const giv = new Set(given.map((l) => l.id));
      const added = "remove" in op ? [] : given.filter((l) => !has.has(l.id));
      const removed =
        "remove" in op
          ? given.filter((l) => has.has(l.id))
          : "set" in op
            ? current.labels.filter((l) => !giv.has(l.id))
            : [];
      if (current.labels.length + added.length - removed.length > MAX_SUBJECT_LABELS)
        return { ok: false, code: "too_many_labels" };
      if (added.length > 0 || removed.length > 0)
        writes.push(() => {
          // References to deleted labels go when the subject's labels change.
          this.#exec(
            "DELETE FROM subject_labels WHERE number = ? AND label_id NOT IN (SELECT id FROM labels)",
            number,
          );
          for (const label of removed)
            this.#exec(
              "DELETE FROM subject_labels WHERE number = ? AND label_id = ?",
              number,
              label.id,
            );
          for (const label of added)
            this.#exec(
              "INSERT INTO subject_labels (number, label_id) VALUES (?, ?)",
              number,
              label.id,
            );
          this.deps.events.auditChange(`${PREFIX[kind]}.labels`, caller.actor, {
            number,
            ...(added.length > 0 && { added: added.map((l) => l.name) }),
            ...(removed.length > 0 && { removed: removed.map((l) => l.name) }),
          });
        });
      for (const label of added)
        events.push({ event: "labeled", data: { label: labelRef(label) } });
      for (const label of removed)
        events.push({ event: "unlabeled", data: { label: labelRef(label) } });
    }

    if (patch.assignees) {
      if (!decideMetadataAction("assign", caller.role).ok) return { ok: false, code: "forbidden" };
      const op = patch.assignees;
      const has = new Set(current.assignees);
      let added: Assignee[] = [];
      let removed: string[] = [];
      if ("remove" in op) removed = [...new Set(op.remove)].filter((id) => has.has(id));
      else {
        const given = [...new Map(("add" in op ? op.add : op.set).map((a) => [a.id, a])).values()];
        if (given.some((a) => a.role === null)) return { ok: false, code: "assignee_no_access" };
        added = given.filter((a) => !has.has(a.id));
        if ("set" in op) {
          const kept = new Set(given.map((a) => a.id));
          removed = current.assignees.filter((id) => !kept.has(id));
        }
      }
      if (current.assignees.length + added.length - removed.length > MAX_ASSIGNEES)
        return { ok: false, code: "too_many_assignees" };
      if (added.length > 0 || removed.length > 0) {
        const roots = new Map(
          this.#exec<{ principal: string; root: string }>(
            "SELECT principal, root FROM subject_assignees WHERE number = ?",
            number,
          ).map((r) => [r.principal, r.root]),
        );
        writes.push(() => {
          const now = this.#now();
          for (const id of removed)
            this.#exec(
              "DELETE FROM subject_assignees WHERE number = ? AND principal = ?",
              number,
              id,
            );
          for (const a of added)
            this.#exec(
              "INSERT INTO subject_assignees (number, principal, root, assigned_at) VALUES (?, ?, ?, ?)",
              number,
              a.id,
              a.root,
              now,
            );
          this.deps.events.auditChange(`${PREFIX[kind]}.assignees`, caller.actor, {
            number,
            ...(added.length > 0 && { added: added.map((a) => a.id) }),
            ...(removed.length > 0 && { removed }),
          });
        });
        for (const a of added)
          events.push({ event: "assigned", data: { assignee: a.id, assignee_root: a.root } });
        for (const id of removed)
          events.push({
            event: "unassigned",
            data: { assignee: id, assignee_root: roots.get(id) ?? id },
          });
      }
    }

    if (patch.milestone !== undefined) {
      if (!decideMetadataAction("set_milestone", caller.role).ok)
        return { ok: false, code: "forbidden" };
      const target = patch.milestone === null ? null : this.milestone(patch.milestone);
      if (target === undefined) return { ok: false, code: "milestone_not_found" };
      const from = current.milestone;
      if ((from?.number ?? null) !== (target?.number ?? null)) {
        writes.push(() => {
          this.#exec(
            `UPDATE ${kind === "issue" ? "issues" : "pull_requests"} SET milestone = ? WHERE number = ?`,
            target?.number ?? null,
            number,
          );
          this.deps.events.auditChange(`${PREFIX[kind]}.milestone`, caller.actor, {
            number,
            milestone: target?.number ?? null,
          });
        });
        if (from) events.push({ event: "demilestoned", data: { milestone: milestoneRef(from) } });
        if (target) events.push({ event: "milestoned", data: { milestone: milestoneRef(target) } });
      }
    }

    return {
      ok: true,
      plan: {
        kind,
        changes: writes.length > 0,
        apply: (emit) => {
          for (const write of writes) write();
          if (emit && events.length > 0) this.deps.touch(kind, number, events, caller.actor);
        },
      },
    };
  }

  #insertLabel(spec: LabelSpec, isDefault: boolean): LabelRecord {
    const now = this.#now();
    const id = this.#exec<{ id: number }>(
      "UPDATE repo_meta SET next_label_id = next_label_id + 1 WHERE id = 1 RETURNING next_label_id - 1 AS id",
    )[0]?.id as number;
    const [row] = this.#exec<LabelRow>(
      `INSERT INTO labels (id, name, color, description, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      id,
      spec.name,
      spec.color.toLowerCase(),
      spec.description,
      isDefault ? 1 : 0,
      now,
      now,
    );
    return labelRecord(row as LabelRow);
  }

  #labelCount(): number {
    return this.#exec<{ n: number }>("SELECT count(*) AS n FROM labels")[0]?.n ?? 0;
  }

  #titleTaken(title: string): boolean {
    return this.#exec("SELECT 1 FROM milestones WHERE title = ?", title).length > 0;
  }

  #emitLabel(
    event: string,
    label: LabelRecord,
    actor: RefActor | null,
    data: Record<string, unknown> | null = null,
    deleted = false,
  ): void {
    const { version, ...row } = label;
    this.deps.events.emitEntity(
      `label.${event}`,
      actor,
      { type: LABEL_ENTITY, id: `${this.deps.repoId()}#labels/${label.id}`, version, row },
      data,
      deleted,
    );
  }

  #emitMilestone(
    event: string,
    milestone: MilestoneRecord,
    actor: RefActor | null,
    data: Record<string, unknown> | null = null,
    deleted = false,
  ): void {
    const { version, ...row } = milestone;
    this.deps.events.emitEntity(
      `milestone.${event}`,
      actor,
      {
        type: MILESTONE_ENTITY,
        id: `${this.deps.repoId()}#milestones/${milestone.number}`,
        version,
        row,
      },
      data,
      deleted,
    );
  }

  #storage() {
    return this.deps.git.context.storage;
  }

  #now() {
    return this.deps.git.context.now();
  }

  #exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    const cursor = this.#storage().sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    if (cursor.rowsWritten > 0)
      this.deps.git.context.metrics.count(
        "do.rows_written",
        { class: this.deps.git.context.doClass, op: "subject_meta.write" },
        cursor.rowsWritten,
      );
    return rows;
  }
}

/** Labels in name order, ignoring case. */
function byName(a: LabelRecord, b: LabelRecord): number {
  const [x, y] = [labelNameKey(a.name), labelNameKey(b.name)];
  return x < y ? -1 : x > y ? 1 : 0;
}

/** What an event names of a label. */
const labelRef = (label: LabelRecord) => ({ id: label.id, name: label.name, color: label.color });
/** What an event names of a milestone. */
const milestoneRef = (milestone: MilestoneRecord) => ({
  number: milestone.number,
  title: milestone.title,
});

function labelRecord(row: LabelRow): LabelRecord {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    description: row.description,
    isDefault: row.is_default === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function milestoneRecord(row: MilestoneRow): MilestoneRecord {
  return {
    number: row.number,
    title: row.title,
    description: row.description,
    state: row.state,
    dueOn: row.due_on,
    closedAt: row.closed_at,
    openIssues: row.open_issues,
    closedIssues: row.closed_issues,
    openPulls: row.open_pulls,
    closedPulls: row.closed_pulls,
    creator: row.creator,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
