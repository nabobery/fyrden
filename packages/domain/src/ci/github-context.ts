/*
 * The `github` context of a run, built once when the run is planned from
 * facts the caller already read; the same facts give the same context.
 * `run_attempt` and `triggering_actor` belong to an attempt, so assignment
 * adds them, not this.
 *
 * The pinned runner (gitea/runner v6.0.0) takes this context as given
 * (`act/runner/run_context.go:1686-1695`, read 2026-11-15) and reads it into
 * a struct of string fields that skips a value of another type
 * (`GithubContextFromMap`, gitea.dev/actionslib v1.5.2
 * `pkg/model/github_context.go`), so every field but `event` is a string.
 */

/** The repository a run belongs to. */
export interface ContextRepository {
  readonly id: string;
  readonly name: string;
  readonly owner: { readonly id: string; readonly login: string };
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly htmlUrl: string;
  readonly cloneUrl: string;
}

export interface ContextPerson {
  readonly name: string;
  readonly email: string;
}

/** What happened, per event, with the commit each event checks out. */
export type ContextEvent =
  | {
      readonly kind: "push";
      readonly ref: string;
      readonly before: string;
      /** The pushed tip, which the run checks out. */
      readonly after: string;
      readonly created: boolean;
      readonly headCommit: {
        readonly id: string;
        readonly treeId: string;
        readonly message: string;
        /** ISO 8601, as the commit records it. */
        readonly timestamp: string;
        readonly author: ContextPerson;
        readonly committer: ContextPerson;
      };
      readonly pusher: ContextPerson;
    }
  | {
      readonly kind: "pull_request";
      readonly action: string;
      readonly number: number;
      readonly headSha: string;
      readonly headBranch: string;
      readonly baseBranch: string;
      /** The webhook payload captured with the pull request event. */
      readonly payload: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "pull_request_target";
      readonly action: string;
      readonly number: number;
      readonly headBranch: string;
      readonly baseBranch: string;
      readonly defaultBranchSha: string;
      readonly payload: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "schedule";
      readonly cron: string;
      /** The default branch tip at the tick. */
      readonly sha: string;
    }
  | {
      readonly kind: "workflow_dispatch";
      /** A full ref (`refs/heads/...` or `refs/tags/...`). */
      readonly ref: string;
      readonly sha: string;
      /** `eventInputs` from `validateDispatchInputs`; the typed `inputs` context is separate. */
      readonly inputs: Readonly<Record<string, string>>;
    };

export interface GithubContextInput {
  /** The deployment's origin. */
  readonly serverUrl: string;
  readonly apiUrl: string;
  readonly repository: ContextRepository;
  /** Who caused the event; also the payload's `sender`. */
  readonly actor: { readonly id: string; readonly login: string };
  readonly workflow: { readonly path: string; readonly name?: string };
  readonly runId: string;
  readonly runNumber: number;
  readonly event: ContextEvent;
}

export interface GithubContext {
  readonly event_name: ContextEvent["kind"];
  readonly event: Readonly<Record<string, unknown>>;
  readonly ref: string;
  readonly ref_name: string;
  readonly ref_type: string;
  readonly sha: string;
  readonly head_ref: string;
  readonly base_ref: string;
  readonly repository: string;
  readonly repository_id: string;
  readonly repository_owner: string;
  readonly repository_owner_id: string;
  readonly actor: string;
  readonly actor_id: string;
  readonly workflow: string;
  readonly workflow_ref: string;
  readonly workflow_sha: string;
  readonly run_id: string;
  readonly run_number: string;
  readonly server_url: string;
  readonly api_url: string;
  readonly retention_days: string;
}

/** How long run logs are kept, in days. */
const RETENTION_DAYS = "90";

/** The `github` context for a run of `input.workflow` on `input.event`. */
export function githubContext(input: GithubContextInput): GithubContext {
  const { repository: repo, actor, event } = input;
  const fullName = `${repo.owner.login}/${repo.name}`;
  const common = {
    repository: {
      full_name: fullName,
      name: repo.name,
      owner: { login: repo.owner.login },
      default_branch: repo.defaultBranch,
      private: repo.private,
      html_url: repo.htmlUrl,
      clone_url: repo.cloneUrl,
    },
    sender: { login: actor.login, id: actor.id },
  };
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const { ref, sha, headRef, baseRef, payload } = ((): {
    ref: string;
    sha: string;
    headRef: string;
    baseRef: string;
    payload: Record<string, unknown>;
  } => {
    switch (event.kind) {
      case "push":
        return {
          ref: event.ref,
          sha: event.after,
          headRef: "",
          baseRef: "",
          // No `commits` and no `forced`: either costs a walk of the history.
          payload: {
            ref: event.ref,
            before: event.before,
            after: event.after,
            created: event.created,
            deleted: false,
            base_ref: null,
            head_commit: {
              id: event.headCommit.id,
              tree_id: event.headCommit.treeId,
              message: event.headCommit.message,
              timestamp: event.headCommit.timestamp,
              author: person(event.headCommit.author),
              committer: person(event.headCommit.committer),
            },
            pusher: person(event.pusher),
            ...common,
          },
        };
      // Pull requests run on the head commit, on `refs/pull/<n>/head`: Fyrden
      // has no merge ref. `pull_request_target` runs the default branch.
      case "pull_request":
      case "pull_request_target":
        return {
          ref: event.kind === "pull_request" ? `refs/pull/${event.number}/head` : defaultRef,
          sha: event.kind === "pull_request" ? event.headSha : event.defaultBranchSha,
          headRef: event.headBranch,
          baseRef: event.baseBranch,
          payload: { ...event.payload, action: event.action, ...common },
        };
      case "schedule":
        return {
          ref: defaultRef,
          sha: event.sha,
          headRef: "",
          baseRef: "",
          payload: { schedule: event.cron, ...common },
        };
      case "workflow_dispatch":
        return {
          ref: event.ref,
          sha: event.sha,
          headRef: "",
          baseRef: "",
          payload: {
            inputs: { ...event.inputs },
            ref: event.ref,
            workflow: input.workflow.path,
            ...common,
          },
        };
    }
  })();
  return {
    event_name: event.kind,
    event: payload,
    ref,
    ...refNameAndType(ref),
    sha,
    head_ref: headRef,
    base_ref: baseRef,
    repository: fullName,
    repository_id: repo.id,
    repository_owner: repo.owner.login,
    repository_owner_id: repo.owner.id,
    actor: actor.login,
    actor_id: actor.id,
    workflow: input.workflow.name ?? input.workflow.path,
    workflow_ref: `${fullName}/${input.workflow.path}@${ref}`,
    // Every event reads the workflow from the commit it checks out.
    workflow_sha: sha,
    run_id: input.runId,
    run_number: String(input.runNumber),
    server_url: input.serverUrl,
    api_url: input.apiUrl,
    retention_days: RETENTION_DAYS,
  };
}

function person(p: ContextPerson): { name: string; email: string } {
  return { name: p.name, email: p.email };
}

/**
 * `ref_name` and `ref_type`. A pull request ref `refs/pull/12/head` is
 * named `12/head`, as the runner names it (`SetRefTypeAndName`,
 * gitea.dev/actionslib v1.5.2, read 2026-11-15), but typed `branch`:
 * GitHub's `ref_type` is `branch` or `tag` only (verified 2026-11-15,
 * https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context),
 * and the runner keeps a preset context's value as given.
 */
function refNameAndType(ref: string): { ref_name: string; ref_type: string } {
  if (ref.startsWith("refs/tags/")) return { ref_name: ref.slice(10), ref_type: "tag" };
  if (ref.startsWith("refs/heads/")) return { ref_name: ref.slice(11), ref_type: "branch" };
  if (ref.startsWith("refs/pull/")) return { ref_name: ref.slice(10), ref_type: "branch" };
  return { ref_name: "", ref_type: "" };
}
