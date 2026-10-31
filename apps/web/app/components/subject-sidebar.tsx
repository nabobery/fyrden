import type { ReactNode } from "react";
import { Form, Link } from "react-router";
import type { Label } from "../lib/labels.js";
import type { Milestone } from "../lib/milestones.js";
import { who } from "../lib/pulls.js";
import { LOCK_REASON_LABEL } from "../lib/subject-meta.js";
import { LabelChip } from "./label-chip.js";

/** What the sidebar may offer: as the viewer's role allows (the API decides each). */
export interface SidebarRoles {
  /** Labels, assignees and the milestone. */
  readonly triage: boolean;
  /** Locking and unlocking. */
  readonly push: boolean;
  /** Deleting an issue. */
  readonly admin: boolean;
}

/**
 * An issue's or pull request's labels, assignees and milestone, its lock,
 * and (an issue's, for admin) its deletion: each a form posting to the
 * page's action, the labels and the milestone chosen on pages of their own.
 */
export function SubjectSidebar({
  owner,
  repo,
  number,
  kind,
  labels,
  assignees,
  milestone,
  locked,
  lockReason,
  roles,
  viewer,
  busy,
  hidden,
}: {
  owner: string;
  repo: string;
  number: number;
  kind: "issue" | "pull";
  labels: readonly Label[];
  assignees: readonly { id: string }[];
  milestone: Pick<Milestone, "number" | "title" | "state"> | null;
  locked: boolean;
  lockReason: string | null;
  roles: SidebarRoles;
  viewer: string | null;
  busy: boolean;
  /** Fields every form carries (the viewer it was drawn for). */
  hidden?: ReactNode;
}) {
  const picker = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`;
  const triage = viewer !== null && roles.triage;
  const button = (intent: string, label: string, fields: ReactNode, name?: string) => (
    <Form method="post" className="inline-form">
      <input type="hidden" name="intent" value={intent} />
      {fields}
      {hidden}
      <button type="submit" disabled={busy} aria-label={name}>
        {label}
      </button>
    </Form>
  );
  return (
    <aside className="panel sidebar" aria-labelledby="sidebar-heading">
      <h2 id="sidebar-heading" className="visually-hidden">
        Details
      </h2>
      <section aria-labelledby="sidebar-labels">
        <h3 id="sidebar-labels">Labels</h3>
        {labels.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <ul className="reactions row" aria-label="Its labels">
            {labels.map((label) => (
              <li key={label.id} className="row">
                <LabelChip label={label} />
                {triage &&
                  button(
                    "label-remove",
                    "Remove",
                    <>
                      <input type="hidden" name="label" value={label.name} />
                      <input type="hidden" name="label_id" value={label.id} />
                    </>,
                    `Remove the label ${label.name}`,
                  )}
              </li>
            ))}
          </ul>
        )}
        {triage && (
          <p>
            <Link to={`${picker}/labels`}>Add labels</Link>
          </p>
        )}
      </section>
      <section aria-labelledby="sidebar-assignees">
        <h3 id="sidebar-assignees">Assignees</h3>
        {assignees.length === 0 ? (
          <p className="muted">No one.</p>
        ) : (
          <ul className="label-list" aria-label="Its assignees">
            {assignees.map((assignee) => (
              <li key={assignee.id} className="row">
                <span>{who(assignee.id, viewer)}</span>
                {triage &&
                  button(
                    "unassign",
                    "Remove",
                    <input type="hidden" name="assignee_id" value={assignee.id} />,
                    `Remove ${who(assignee.id, viewer)} from its assignees`,
                  )}
              </li>
            ))}
          </ul>
        )}
        {triage && (
          <Form method="post" className="row">
            <input type="hidden" name="intent" value="assign" />
            {hidden}
            <label htmlFor="assign-handle" className="inline">
              Assign (a handle)
            </label>
            <input id="assign-handle" name="handle" required size={16} maxLength={40} />
            <button type="submit" disabled={busy}>
              Assign
            </button>
          </Form>
        )}
      </section>
      <section aria-labelledby="sidebar-milestone">
        <h3 id="sidebar-milestone">Milestone</h3>
        {milestone === null ? (
          <p className="muted">None.</p>
        ) : (
          <p className="row">
            <span>
              {milestone.title}
              {milestone.state === "closed" && <span className="muted"> (closed)</span>}
            </span>
            {triage && button("milestone-clear", "Clear", null, "Clear the milestone")}
          </p>
        )}
        {triage && (
          <p>
            <Link to={`${picker}/milestone`}>Choose a milestone</Link>
          </p>
        )}
      </section>
      <section aria-labelledby="sidebar-notifications">
        <h3 id="sidebar-notifications">Notifications</h3>
        <p>
          <Link to={`${picker}/subscription`}>How you hear of it</Link>
        </p>
      </section>
      <section aria-labelledby="sidebar-references">
        <h3 id="sidebar-references">Referenced by</h3>
        <p>
          <Link to={`${picker}/references`}>What refers to it</Link>
        </p>
      </section>
      {viewer !== null && roles.push && (
        <section aria-labelledby="sidebar-lock">
          <h3 id="sidebar-lock">Lock</h3>
          {locked ? (
            <>
              <p className="muted">
                {`Locked${lockReason ? ` as ${LOCK_REASON_LABEL[lockReason as keyof typeof LOCK_REASON_LABEL] ?? lockReason}` : ""}: only write access comments.`}
              </p>
              {button("unlock", "Unlock conversation", null)}
            </>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="lock" />
              {hidden}
              <label htmlFor="lock-reason">Reason (optional)</label>
              <select id="lock-reason" name="lock_reason" defaultValue="">
                <option value="">None given</option>
                {Object.entries(LOCK_REASON_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <p>
                <button type="submit" disabled={busy}>
                  Lock conversation
                </button>
              </p>
            </Form>
          )}
        </section>
      )}
      {kind === "issue" && viewer !== null && roles.admin && (
        <details>
          <summary>Delete issue</summary>
          <p className="muted">
            It goes for good, with its comments; its number is not used again.
          </p>
          {button("delete-issue", `Delete issue #${number}`, null)}
        </details>
      )}
    </aside>
  );
}
