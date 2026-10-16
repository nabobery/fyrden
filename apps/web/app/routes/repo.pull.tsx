import { Form, useActionData, useNavigation } from "react-router";
import { Markdown } from "../components/markdown.js";
import { MergeBox } from "../components/merge-box.js";
import { Pager } from "../components/pager.js";
import { PullHeader } from "../components/pull-header.js";
import { inOrder, Timeline, type TimelineItem } from "../components/pull-timeline.js";
import { ReviewForm } from "../components/review-form.js";
import { apiCall, assertSameOrigin, bodyOf, readForm } from "../lib/api.server.js";
import { renderMarkdown } from "../lib/markdown.js";
import { type ListedRuleset, mergeRules } from "../lib/merge.server.js";
import { pageLinks, pageQuery } from "../lib/pages.js";
import {
  field,
  type IssueComment,
  pullNumber,
  pullPage,
  type Review,
  rawField,
  repoApiPath,
} from "../lib/pulls.js";
import {
  loadPull,
  type MergeResult,
  mergePull,
  pullApiOf,
  send,
  submitReview,
} from "../lib/pulls.server.js";
import type { Repo } from "../lib/types.js";
import type { Route } from "./+types/repo.pull";

export function meta({ params, loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  const title = loaderData?.pull.title ?? `#${params.number}`;
  return [
    {
      title: `${title} · Pull request #${params.number} · ${params.owner}/${params.repo} · Fyrden`,
    },
  ];
}

/**
 * Comments, and reviews, a conversation page shows at a time: a body of
 * 65,536 characters can render to about four times that in HTML, which the
 * page then holds twice (its markup and its data), so pages stay small.
 */
const CONVERSATION_PAGE = 25;

/** Bytes of a conversation form at most: a body of 65,536 characters, URL-encoded, and the rest. */
const PULL_FORM_MAX_BYTES = 9 * 65_536 + 16 * 1024;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const { number, pull, viewer } = await loadPull(context, request, params);
  const api = pullApiOf(params);
  const repoApi = repoApiPath(params.owner, params.repo);
  const open = pull.state === "open";
  const [comments, reviews, repo, rulesets] = await Promise.all([
    apiCall<{ comments: IssueComment[]; next_cursor: string | null }>(
      context,
      request,
      "GET",
      `${repoApi}/issues/${number}/comments?${pageQuery(url, "comments", CONVERSATION_PAGE)}`,
    ),
    apiCall<{ reviews: Review[]; next_cursor: string | null }>(
      context,
      request,
      "GET",
      `${api}/reviews?${pageQuery(url, "reviews", CONVERSATION_PAGE)}`,
    ),
    // For the merge box only: what the base branch's rulesets ask of a merge.
    open ? apiCall<Repo>(context, request, "GET", repoApi) : null,
    open
      ? apiCall<{ rulesets: ListedRuleset[] }>(context, request, "GET", `${repoApi}/rulesets`)
      : null,
  ]);
  const rules =
    repo?.status === 200 && rulesets?.status === 200
      ? mergeRules(rulesets.body.rulesets, pull.base.ref, repo.body.default_branch)
      : null;
  const commentPage = bodyOf(comments, request);
  const reviewPage = bodyOf(reviews, request);
  const items: TimelineItem[] = [
    ...commentPage.comments.map(
      (c): TimelineItem => ({
        kind: "comment",
        id: c.id,
        at: c.created_at,
        author: c.user.id,
        agents: c.performed_via_agents,
        html: renderMarkdown(c.body),
        edited: c.updated_at > c.created_at,
      }),
    ),
    ...reviewPage.reviews.map(
      (r): TimelineItem => ({
        kind: "review",
        id: r.id,
        at: r.submitted_at,
        author: r.user.id,
        agents: r.performed_via_agents,
        state: r.state,
        commit: r.commit_id,
        html: r.body ? renderMarkdown(r.body) : null,
        dismissal: r.dismissal,
      }),
    ),
  ];
  if (pull.merged && pull.merged_at !== null)
    items.push({
      kind: "merged",
      at: pull.merged_at,
      by: pull.merged_by?.id ?? null,
      commit: pull.merge_commit_sha,
    });
  else if (pull.state === "closed" && pull.closed_at !== null)
    items.push({ kind: "closed", at: pull.closed_at, by: null, commit: null });
  return {
    owner: params.owner,
    repo: params.repo,
    pull,
    viewer,
    bodyHtml: pull.body ? renderMarkdown(pull.body) : null,
    timeline: inOrder(items),
    commentPages: pageLinks(url, "comments", commentPage.next_cursor),
    reviewPages: pageLinks(url, "reviews", reviewPage.next_cursor),
    rules,
  };
}

export async function action({ request, context, params }: Route.ActionArgs): Promise<MergeResult> {
  assertSameOrigin(request);
  const form = await readForm(request, PULL_FORM_MAX_BYTES);
  const api = pullApiOf(params);
  const patch = (body: Record<string, unknown>, intent: string, fallback: string) =>
    send(context, request, "PATCH", api, body, intent, fallback);
  switch (field(form, "intent")) {
    case "comment": {
      const body = rawField(form, "body");
      if (!body.trim()) return { error: "Write a comment first." };
      const issue = `${repoApiPath(params.owner, params.repo)}/issues/${pullNumber(params.number)}`;
      return send(
        context,
        request,
        "POST",
        `${issue}/comments`,
        { body },
        "comment",
        "The comment was not added.",
      );
    }
    case "edit": {
      const body = rawField(form, "body");
      return patch(
        { title: field(form, "title"), body: body.trim() ? body : null },
        "edit",
        "The pull request was not changed.",
      );
    }
    case "close":
      return patch({ state: "closed" }, "close", "The pull request was not closed.");
    case "reopen":
      return patch({ state: "open" }, "reopen", "The pull request was not reopened.");
    case "draft":
      return patch({ draft: true }, "draft", "The pull request was not made a draft.");
    case "ready":
      return patch({ draft: false }, "ready", "The pull request was not marked ready.");
    case "maintainer":
      return patch(
        { maintainer_can_modify: form.get("maintainer_can_modify") === "on" },
        "maintainer",
        "The setting was not saved.",
      );
    case "review":
      return submitReview(context, request, api, form);
    case "merge":
      return mergePull(context, request, api, form);
    case "update-branch": {
      const sha = field(form, "expected_head_sha");
      return send(
        context,
        request,
        "PUT",
        `${api}/update-branch`,
        /^[0-9a-f]{40}$/.test(sha) ? { expected_head_sha: sha } : {},
        "update-branch",
        "The branch was not updated.",
      );
    }
    default:
      return { error: "Unknown action." };
  }
}

const DONE: Record<string, string> = {
  comment: "Comment added.",
  edit: "Saved.",
  close: "Closed.",
  reopen: "Reopened.",
  draft: "Marked as a draft.",
  ready: "Marked ready for review.",
  maintainer: "Saved.",
};

export default function Pull({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const { owner, repo, pull, viewer, bodyHtml, timeline, commentPages, reviewPages, rules } =
    loaderData;
  const isAuthor = viewer !== null && pull.user.id === viewer;
  const open = pull.state === "open";
  return (
    <main>
      <PullHeader owner={owner} repo={repo} pull={pull} viewer={viewer} active="conversation" />
      <section className="panel" aria-labelledby="pull-description">
        <h2 id="pull-description" className="visually-hidden">
          Description
        </h2>
        {bodyHtml ? <Markdown html={bodyHtml} /> : <p className="muted">No description.</p>}
        <details>
          <summary>Edit title and description</summary>
          <Form method="post">
            <input type="hidden" name="intent" value="edit" />
            <label htmlFor="edit-title">Title</label>
            <input
              id="edit-title"
              name="title"
              required
              maxLength={256}
              size={60}
              defaultValue={pull.title}
            />
            <label htmlFor="edit-body">Description (Markdown)</label>
            <textarea id="edit-body" name="body" className="short" defaultValue={pull.body ?? ""} />
            <p>
              <button type="submit" className="primary" disabled={busy}>
                Save
              </button>
            </p>
          </Form>
        </details>
      </section>

      <section aria-labelledby="conversation">
        <h2 id="conversation">Conversation</h2>
        <Timeline items={timeline} viewer={viewer} />
        <Pager links={commentPages} label="Comment" />
        <Pager links={reviewPages} label="Review" />
      </section>

      {open && viewer !== null && <ReviewForm headSha={pull.head.sha} isAuthor={isAuthor} />}
      {open && (
        <MergeBox
          pull={pull}
          rules={rules}
          conflicts={`${pullPage(owner, repo, pull.number)}/conflicts`}
        />
      )}

      <section className="panel" aria-labelledby="pull-state">
        <h2 id="pull-state">State</h2>
        <Form method="post" className="row">
          {open ? (
            <>
              <button type="submit" name="intent" value="close" disabled={busy}>
                Close pull request
              </button>
              {pull.draft ? (
                <button type="submit" name="intent" value="ready" disabled={busy}>
                  Ready for review
                </button>
              ) : (
                <button type="submit" name="intent" value="draft" disabled={busy}>
                  Convert to draft
                </button>
              )}
            </>
          ) : (
            !pull.merged && (
              <button type="submit" name="intent" value="reopen" disabled={busy}>
                Reopen pull request
              </button>
            )
          )}
        </Form>
        {isAuthor && pull.head_repo_id !== null && (
          <Form method="post">
            <input type="hidden" name="intent" value="maintainer" />
            <p>
              <input
                id="maintainer"
                name="maintainer_can_modify"
                type="checkbox"
                defaultChecked={pull.maintainer_can_modify}
                aria-describedby="maintainer-help"
              />{" "}
              <label htmlFor="maintainer" className="inline">
                Allow edits by maintainers
              </label>{" "}
              <button type="submit" disabled={busy}>
                Save
              </button>
            </p>
            <p id="maintainer-help" className="muted">
              Those with write access here may update your fork's head branch, resolve its conflicts
              and apply suggestions to it.
            </p>
          </Form>
        )}
      </section>

      <section className="panel" aria-labelledby="add-comment">
        <h2 id="add-comment">Add a comment</h2>
        <Form method="post" key={timeline.length}>
          <input type="hidden" name="intent" value="comment" />
          <label htmlFor="comment-body">Comment (Markdown)</label>
          <textarea id="comment-body" name="body" className="short" required />
          <p>
            <button type="submit" className="primary" disabled={busy}>
              Comment
            </button>
          </p>
        </Form>
      </section>

      {result?.error && (
        <p className="error" role="alert">
          {result.error}
        </p>
      )}
      {result?.ok && <p role="status">{DONE[result.ok] ?? "Done."}</p>}
    </main>
  );
}
