import { useEffect, useRef } from "react";
import { Form, useActionData, useNavigation } from "react-router";
import { Markdown } from "../components/markdown.js";
import { MergeBox } from "../components/merge-box.js";
import { Pager } from "../components/pager.js";
import { PullHeader } from "../components/pull-header.js";
import { inOrder, Timeline, type TimelineItem } from "../components/pull-timeline.js";
import { Reactions } from "../components/reactions.js";
import { ReviewForm } from "../components/review-form.js";
import { SubjectSidebar } from "../components/subject-sidebar.js";
import { apiCall, assertSameOrigin, bodyOf, readForm } from "../lib/api.server.js";
import {
  type Continuation,
  readContinuation,
  utf8Length,
  within,
  writeContinuation,
} from "../lib/continuation.js";
import { viewerRefusal } from "../lib/edits.server.js";
import { mergeRules, type RulesetsPage } from "../lib/merge.server.js";
import { type PageLinks, pageLinks, positiveId } from "../lib/pages.js";
import {
  field,
  type IssueCommentsPage,
  pullNumber,
  pullPage,
  type ReviewsPage,
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
import { reactionCall } from "../lib/reactions.js";
import { isMetaIntent, META_DONE } from "../lib/subject-meta.js";
import { metaCall } from "../lib/subject-meta.server.js";
import { pageUrl } from "../lib/target.js";
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

/** Comments, and reviews, read from the API at a time: one page of each per navigation. */
const CONVERSATION_PAGE = 25;
/**
 * Markdown source (UTF-8 bytes) one response carries at most, for the
 * comments and for the reviews each (the page renders it in the browser):
 * the rest of an API page follows on the next navigation.
 */
const SOURCE_BUDGET = 256 * 1024;

/** Bytes of a conversation form at most: a body of 65,536 characters, URL-encoded, and the rest. */
const PULL_FORM_MAX_BYTES = 9 * 65_536 + 16 * 1024;

/**
 * `links` of the conversation's comments, from a permalink's page (`url`,
 * null for none): its first page is the conversation's own start.
 */
function fromPermalink(links: PageLinks, url: URL | null): PageLinks {
  if (url === null || links.first) return links;
  const start = withoutPermalink(url);
  start.searchParams.delete("comments");
  return { ...links, first: `${start.pathname}${start.search}` };
}

/** `url` as the page's own, its permalink's `comment` off: pages of comments go on from there. */
function withoutPermalink(url: URL): URL {
  const page = pageUrl(url);
  page.searchParams.delete("comment");
  return page;
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const { number, pull, viewer } = await loadPull(context, request, params);
  const api = pullApiOf(params);
  const repoApi = repoApiPath(params.owner, params.repo);
  const open = pull.state === "open";
  const commentsAt = readContinuation(url.searchParams.get("comments"));
  // A comment's permalink (when no page of comments is named): the page that starts with it.
  const named = commentsAt.cursor !== null || commentsAt.after !== null;
  const linked = named ? null : positiveId(url.searchParams.get("comment"));
  // Comments are in id order: a continuation without the API's cursor resumes after its last
  // comment shown (a permalink's page, or one cut by its source, goes on from where it was).
  const commentsQuery = new URLSearchParams({ per_page: String(CONVERSATION_PAGE) });
  if (commentsAt.cursor) commentsQuery.set("cursor", commentsAt.cursor);
  else if (commentsAt.after !== null) commentsQuery.set("after", String(commentsAt.after));
  else if (linked !== null && linked > 1) commentsQuery.set("after", String(linked - 1));
  const reviewsAt = readContinuation(url.searchParams.get("reviews"));
  const page = (at: Continuation) => {
    const query = new URLSearchParams({ per_page: String(CONVERSATION_PAGE) });
    if (at.cursor) query.set("cursor", at.cursor);
    return query.toString();
  };
  const [comments, reviews, repo, rulesets] = await Promise.all([
    apiCall<IssueCommentsPage>(
      context,
      request,
      "GET",
      `${repoApi}/issues/${number}/comments?${commentsQuery}`,
    ),
    apiCall<ReviewsPage>(context, request, "GET", `${api}/reviews?${page(reviewsAt)}`),
    // The viewer's role (what the sidebar offers, whether a locked conversation takes their
    // reactions) and, for the merge box, the default branch.
    apiCall<Repo>(context, request, "GET", repoApi),
    // For the merge box only: what the base branch's rulesets ask of a merge.
    open ? apiCall<RulesetsPage>(context, request, "GET", `${repoApi}/rulesets`) : null,
  ]);
  const rules =
    repo.status === 200 && rulesets?.status === 200
      ? mergeRules(rulesets.body.rulesets, pull.base.ref, repo.body.default_branch)
      : null;
  const commentPage = bodyOf(comments, request);
  const reviewPage = bodyOf(reviews, request);
  const shownComments = within(
    commentPage.comments,
    commentsAt,
    (c) => utf8Length(c.body),
    SOURCE_BUDGET,
    commentPage.next_cursor,
  );
  const shownReviews = within(
    reviewPage.reviews,
    reviewsAt,
    (r) => utf8Length(r.body ?? ""),
    SOURCE_BUDGET,
    reviewPage.next_cursor,
  );
  const items: TimelineItem[] = [
    ...shownComments.items.map(
      (c): TimelineItem => ({
        kind: "comment",
        id: c.id,
        at: c.created_at,
        author: c.user.id,
        agents: c.performed_via_agents,
        body: c.body,
        edited: c.updated_at > c.created_at,
        reactions: c.reactions,
      }),
    ),
    ...shownReviews.items.map(
      (r): TimelineItem => ({
        kind: "review",
        id: r.id,
        at: r.submitted_at,
        author: r.user.id,
        agents: r.performed_via_agents,
        state: r.state,
        commit: r.commit_id,
        body: r.body,
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
    body: pull.body,
    timeline: inOrder(items),
    commentPages: fromPermalink(
      pageLinks(
        withoutPermalink(url),
        "comments",
        shownComments.next && writeContinuation(shownComments.next),
      ),
      linked === null ? null : url,
    ),
    // The comment a permalink named; `missing` when it is not this one's now (deleted, or another's).
    linked: linked === null ? null : { id: linked, missing: shownComments.items[0]?.id !== linked },
    reviewPages: pageLinks(
      url,
      "reviews",
      shownReviews.next && writeContinuation(shownReviews.next),
    ),
    rules,
    // What the viewer's role allows (none when the repository could not be read).
    permissions: (repo.status === 200 && repo.body.permissions) || null,
  };
}

export async function action({ request, context, params }: Route.ActionArgs): Promise<MergeResult> {
  assertSameOrigin(request);
  const form = await readForm(request, PULL_FORM_MAX_BYTES);
  // The form was made for one viewer: another signed in since (another tab) sends nothing.
  const refused = await viewerRefusal(context, request, form);
  if (refused) return { error: refused };
  const api = pullApiOf(params);
  const patch = (body: Record<string, unknown>, intent: string, fallback: string) =>
    send(context, request, "PATCH", api, body, intent, fallback);
  const intent = field(form, "intent");
  // Labels, assignees, the milestone and the lock, through its number as an issue's are.
  if (isMetaIntent(intent) && intent !== "delete-issue") {
    const call = metaCall(
      intent,
      form,
      `${repoApiPath(params.owner, params.repo)}/issues/${pullNumber(params.number)}`,
    );
    if ("refused" in call) return { error: call.refused };
    return send(
      context,
      request,
      call.method,
      call.path,
      call.body,
      intent,
      "Nothing was changed.",
    );
  }
  switch (intent) {
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
    case "react":
    case "unreact": {
      const call = reactionCall(
        form,
        `${repoApiPath(params.owner, params.repo)}/issues/${pullNumber(params.number)}`,
        repoApiPath(params.owner, params.repo),
      );
      if (!call) return { error: "No such reaction." };
      return send(
        context,
        request,
        call.method,
        call.path,
        call.body,
        field(form, "intent"),
        "The reaction was not changed.",
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
  react: "Reaction added.",
  unreact: "Reaction taken back.",
  ...META_DONE,
};

export default function Pull({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const {
    owner,
    repo,
    pull,
    viewer,
    body,
    timeline,
    commentPages,
    reviewPages,
    rules,
    permissions,
  } = loaderData;
  const push = permissions?.push === true;
  // A locked conversation takes reactions from write access only (the API decides each).
  const react = { canReact: viewer !== null && (!pull.locked || push), busy };
  const isAuthor = viewer !== null && pull.user.id === viewer;
  const open = pull.state === "open";
  const viewerField = <input type="hidden" name="viewer" value={viewer ?? ""} />;
  // A comment being written stays as the page is read again; only its own sending clears it.
  const commentForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (result?.ok === "comment") commentForm.current?.reset();
  }, [result]);
  return (
    // Drawn anew for another viewer (signed in from another tab): what one account wrote in the
    // page's editors is never sent as another's.
    <main key={viewer ?? ""}>
      <PullHeader owner={owner} repo={repo} pull={pull} viewer={viewer} active="conversation" />
      <SubjectSidebar
        owner={owner}
        repo={repo}
        number={pull.number}
        kind="pull"
        labels={pull.labels}
        assignees={pull.assignees}
        milestone={pull.milestone}
        locked={pull.locked}
        lockReason={pull.active_lock_reason}
        roles={{ triage: permissions?.triage === true, push, admin: permissions?.admin === true }}
        viewer={viewer}
        busy={busy}
        hidden={viewerField}
      />
      <section className="panel" aria-labelledby="pull-description">
        <h2 id="pull-description" className="visually-hidden">
          Description
        </h2>
        {body ? <Markdown source={body} /> : <p className="muted">No description.</p>}
        <Reactions rollup={pull.reactions} target="issue" {...react} hidden={viewerField} />
        <details>
          <summary>Edit title and description</summary>
          <Form method="post">
            <input type="hidden" name="intent" value="edit" />
            {viewerField}
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
        {loaderData.linked?.missing && (
          <p className="muted" role="status">
            The comment linked to is not on this pull request now (deleted, or another's): the
            conversation is shown from where it was.
          </p>
        )}
        <Timeline
          items={timeline}
          viewer={viewer}
          react={react}
          linked={loaderData.linked?.id ?? null}
          hidden={viewerField}
        />
        <Pager links={commentPages} label="Comment" />
        <Pager links={reviewPages} label="Review" />
      </section>

      {open && viewer !== null && (
        <ReviewForm headSha={pull.head.sha} isAuthor={isAuthor} hidden={viewerField} />
      )}
      {open && (
        <MergeBox
          pull={pull}
          rules={rules}
          conflicts={`${pullPage(owner, repo, pull.number)}/conflicts`}
          hidden={viewerField}
        />
      )}

      <section className="panel" aria-labelledby="pull-state">
        <h2 id="pull-state">State</h2>
        <Form method="post" className="row">
          {viewerField}
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
            {viewerField}
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
        <Form method="post" ref={commentForm}>
          <input type="hidden" name="intent" value="comment" />
          {viewerField}
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
