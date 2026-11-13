import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Link, useFetcher, useRevalidator } from "react-router";
import {
  METHOD_LABEL,
  type MergeMethod,
  type MergeRules,
  type RequiredChecks as RequiredChecksView,
} from "../lib/merge.js";
import type { PullRequest } from "../lib/pulls.js";

/** A merge's answer: done, still rebasing in the background, or refused (with the reason). */
export type MergeAnswer = { ok?: string; pending?: boolean; error?: string } | undefined;

/** Time between asks while a rebase goes on in the background (milliseconds). */
const REBASE_RECHECK_MS = 3000;
/** Time between looks while mergeability is worked out (milliseconds), and looks at most. */
const MERGEABILITY_RECHECK_MS = 5000;
const MERGEABILITY_LOOKS = 12;

/** What the rulesets ask, in words. */
function requirements(rules: MergeRules): string[] {
  const out: string[] = [];
  if (rules.approvals > 0)
    out.push(`${rules.approvals} approving review${rules.approvals === 1 ? "" : "s"} of the head`);
  if (rules.lastPushApproval) out.push("an approval after the last push, by someone else");
  if (rules.threadsResolved) out.push("every review thread resolved");
  if (rules.upToDate) out.push("the head up to date with the base branch");
  if (rules.signatures) out.push("signed commits");
  return out;
}

/** A required check's state in words, with a mark that is not its only signal. */
const CHECK_STATE = {
  passed: { words: "Passed", mark: "✓" },
  pending: { words: "Pending", mark: "●" },
  failing: { words: "Failing", mark: "✗" },
  expected: { words: "Expected", mark: "○" },
} as const;

/**
 * The status checks the base branch's rulesets require and where each
 * stands on the head (the merge decides: a role that bypasses a ruleset
 * may merge anyway); null when they could not be read.
 */
function RequiredChecks({ checks }: { checks: RequiredChecksView | null | undefined }) {
  const id = useId();
  if (checks === undefined) return null;
  if (checks === null)
    return (
      <p className="muted">
        The required checks of this head could not be read; reload the page, or let the merge check
        them.
      </p>
    );
  if (checks.checks.length === 0) return null;
  const waiting = checks.checks.filter((c) => c.state !== "passed").length;
  return (
    <div className="required-checks">
      <h3 id={`${id}-title`}>Required checks</h3>
      {waiting > 0 ? (
        <p className="error">
          {waiting} required check{waiting === 1 ? " has" : "s have"} not passed. Merging needs them
          to pass, or permission to bypass the ruleset.
        </p>
      ) : (
        <p className="ok-text">All required checks passed.</p>
      )}
      {/* biome-ignore lint/a11y/noRedundantRoles: without markers, WebKit reads a list as a group unless told. */}
      <ul role="list" aria-labelledby={`${id}-title`}>
        {checks.checks.map((check) => {
          const state = CHECK_STATE[check.state];
          const links = check.deciding.filter((d) => d.details_url !== null);
          return (
            <li key={`${check.context}\u0000${check.integration_id ?? ""}`}>
              <span className={`badge check-${check.state}`}>
                <span aria-hidden="true">{state.mark}</span> {state.words}
              </span>{" "}
              <code>{check.context}</code>
              {check.integration_id !== null && (
                <>
                  {" "}
                  from <code>{check.integration_id}</code>
                </>
              )}
              {links.map((d) => (
                <span key={`${d.kind}\u0000${d.source}`}>
                  {" "}
                  <a href={d.details_url ?? undefined} rel="noreferrer nofollow">
                    Details
                    <span className="visually-hidden">
                      {" "}
                      of {check.context} ({d.kind === "check" ? "check" : "status"} from {d.source})
                    </span>
                  </a>
                </span>
              ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The pull request's mergeability, in words, and what to do about it. */
function Mergeability({ pull, conflicts }: { pull: PullRequest; conflicts: string }) {
  const revalidator = useRevalidator();
  const looks = useRef(0);
  const reason = pull.mergeable_reason;
  // Past the budget or unreadable: worked out again only minutes later.
  const deferred = reason === "too_expensive" || reason === "unreadable";
  const working = pull.mergeable_state === "unknown" && !deferred;
  // Worked out in the background after each push: look again for a while.
  useEffect(() => {
    if (!working || looks.current >= MERGEABILITY_LOOKS) return;
    const timer = setTimeout(() => {
      looks.current++;
      void revalidator.revalidate();
    }, MERGEABILITY_RECHECK_MS);
    return () => clearTimeout(timer);
  }, [working, revalidator]);
  // Reloading shows the latest result; a deferred check is not started again by it.
  const checkAgain = (
    <button
      type="button"
      onClick={() => void revalidator.revalidate()}
      disabled={revalidator.state !== "idle"}
    >
      {deferred ? "Refresh" : "Check again"}
    </button>
  );
  switch (pull.mergeable_state) {
    case "clean":
      return <p className="ok-text">No conflicts with the base branch.</p>;
    case "dirty":
      return (
        <p className="error">
          This branch has conflicts with the base branch.{" "}
          <Link to={conflicts}>Resolve conflicts</Link>
        </p>
      );
    case "draft":
      return <p className="muted">This pull request is a draft: mark it ready to merge it.</p>;
    default:
      if (reason === "too_expensive")
        return (
          <p className="muted">
            Checking whether it merges cleanly went past its budget; it will be checked again later,
            and merging may still succeed. If this persists, merge it locally. {checkAgain}
          </p>
        );
      if (reason === "unreadable")
        return (
          <p className="error">
            Could not check whether it merges cleanly: an object it needs could not be read. It will
            be checked again later. {checkAgain}
          </p>
        );
      return <p className="muted">Checking whether it merges cleanly… {checkAgain}</p>;
  }
}

/**
 * Merging an open pull request: the method (those the base branch's
 * rulesets allow), its commit message, and its state; a long rebase is
 * asked again until it finishes. Also brings the head up to date with the
 * base branch.
 */
export function MergeBox({
  pull,
  rules,
  requiredChecks,
  conflicts,
  hidden,
  canAct = true,
}: {
  pull: PullRequest;
  rules: MergeRules | null;
  /** Where the required checks stand on the head; null when they could not be read. */
  requiredChecks?: RequiredChecksView | null;
  conflicts: string;
  /** Fields its forms send besides their own (the viewer they were made for). */
  hidden?: ReactNode;
  /**
   * Whether its forms are offered (a viewer known to be signed in): what
   * stands in the way of a merge is shown either way.
   */
  canAct?: boolean;
}) {
  const id = useId();
  const merge = useFetcher<MergeAnswer>();
  const update = useFetcher<MergeAnswer>();
  const sent = useRef<FormData | null>(null);
  const [stopped, setStopped] = useState(false);
  const [asks, setAsks] = useState(0);
  const methods = rules?.methods ?? (["merge", "squash", "rebase"] as MergeMethod[]);
  const [method, setMethod] = useState<MergeMethod | undefined>(methods[0]);
  const pending = merge.state === "idle" && merge.data?.pending === true;
  const updating = update.state !== "idle";
  const submit = merge.submit;
  // A rebase still going on in the background: ask again until it answers.
  useEffect(() => {
    if (!pending || stopped || !sent.current) return;
    const form = sent.current;
    const timer = setTimeout(() => {
      setAsks((n) => n + 1);
      void submit(form, { method: "post" });
    }, REBASE_RECHECK_MS);
    return () => clearTimeout(timer);
  }, [pending, stopped, submit]);
  const draft = pull.draft;
  const blocked = draft || methods.length === 0 || method === undefined;
  const asked = rules ? requirements(rules) : [];
  return (
    <section className="panel merge-box" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Merge</h2>
      <Mergeability pull={pull} conflicts={conflicts} />
      {rules && rules.rulesets.length > 0 && (
        <div>
          <p>
            Rulesets on <code>{pull.base.ref}</code> ({rules.rulesets.join(", ")})
            {asked.length > 0 ? " ask for:" : " apply."}
          </p>
          {asked.length > 0 && (
            <ul>
              {asked.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <RequiredChecks checks={requiredChecks} />
      {rules === null && (
        <p className="muted">
          The base branch's rulesets could not be read; every method is offered.
        </p>
      )}
      {!canAct ? (
        <p className="muted">
          Merging and updating the branch need you signed in: reload the page.
        </p>
      ) : methods.length === 0 ? (
        <p className="error">The rulesets on the base branch allow no merge method in common.</p>
      ) : (
        <merge.Form
          method="post"
          onSubmit={(e) => {
            sent.current = new FormData(e.currentTarget);
            setStopped(false);
            setAsks(0);
          }}
        >
          <input type="hidden" name="intent" value="merge" />
          <input type="hidden" name="sha" value={pull.head.sha} />
          {hidden}
          <fieldset>
            <legend>Merge method</legend>
            {methods.map((m) => (
              <p key={m}>
                <input
                  id={`${id}-${m}`}
                  type="radio"
                  name="merge_method"
                  value={m}
                  checked={method === m}
                  onChange={() => setMethod(m)}
                />{" "}
                <label htmlFor={`${id}-${m}`} className="inline">
                  {METHOD_LABEL[m]}
                </label>
              </p>
            ))}
          </fieldset>
          {method !== "rebase" && (
            <>
              <label htmlFor={`${id}-title-input`}>Commit title (optional)</label>
              <input id={`${id}-title-input`} name="commit_title" maxLength={1024} size={60} />
              <label htmlFor={`${id}-message`}>Commit message (optional)</label>
              <textarea id={`${id}-message`} name="commit_message" className="short" />
            </>
          )}
          <p className="row">
            <button
              type="submit"
              className="primary"
              disabled={blocked || updating || merge.state !== "idle" || (pending && !stopped)}
              aria-describedby={draft ? `${id}-draft` : undefined}
            >
              Merge pull request
            </button>
            {draft && (
              <span id={`${id}-draft`} className="muted">
                A draft cannot be merged.
              </span>
            )}
          </p>
        </merge.Form>
      )}
      <div aria-live="polite">
        {(merge.state !== "idle" || pending) && !stopped && (
          <p role="status">
            {pending
              ? `Rebasing the commits onto the base branch; asked ${asks + 1} time${asks === 0 ? "" : "s"}…`
              : "Merging…"}
          </p>
        )}
      </div>
      {pending && !stopped && (
        <button type="button" onClick={() => setStopped(true)}>
          Stop checking
        </button>
      )}
      {pending && stopped && (
        <p>
          The rebase goes on in the background.{" "}
          <button
            type="button"
            onClick={() => {
              setStopped(false);
              if (sent.current) void merge.submit(sent.current, { method: "post" });
            }}
          >
            Check again
          </button>
        </p>
      )}
      {merge.data?.error && merge.state === "idle" && (
        <p className="error" role="alert">
          {merge.data.error}
        </p>
      )}
      {canAct && (
        <update.Form method="post" className="row">
          <input type="hidden" name="intent" value="update-branch" />
          <input type="hidden" name="expected_head_sha" value={pull.head.sha} />
          {hidden}
          <button type="submit" disabled={updating}>
            Update branch
          </button>
          <span className="muted">Merge the base branch's latest commit into this one.</span>
        </update.Form>
      )}
      {update.data?.error && (
        <p className="error" role="alert">
          {update.data.error}
        </p>
      )}
      {!updating && update.data?.ok && (
        <p role="status">The branch is up to date with the base branch.</p>
      )}
    </section>
  );
}
