import { Form, Link, redirect, useActionData, useNavigation } from "react-router";
import { Pager } from "../components/pager.js";
import {
  apiCall,
  apiGet,
  assertSameOrigin,
  readForm,
  signedInUser,
  signInUrl,
} from "../lib/api.server.js";
import { pageLinks, pageQuery } from "../lib/pages.js";
import { OTHER_VIEWER, sameViewer } from "../lib/viewer.server.js";
import type { Route } from "./+types/notifications";

/*
 * The inbox: the signed-in person's notification threads, as GitHub's
 * notifications page shows them (Unread, All, Participating), newest
 * first, paged by the API's cursor. A thread is marked read or done here,
 * or every unread one read. Threads link to their issue or pull request.
 */

export function meta(): Route.MetaDescriptors {
  return [{ title: "Inbox · Fyrden" }];
}

interface Thread {
  id: string;
  repository: { full_name: string; name: string; owner: { login: string } };
  subject: { title: string; url: string; type: "Issue" | "PullRequest" };
  reason: string;
  unread: boolean;
  updated_at: string;
}

interface Page {
  notifications: Thread[];
  next_cursor: string | null;
  delivery: "complete" | "degraded";
}

const TABS = [
  { tab: "unread", label: "Unread", query: "" },
  { tab: "all", label: "All", query: "all=true" },
  { tab: "participating", label: "Participating", query: "participating=true" },
] as const;

type Tab = (typeof TABS)[number]["tab"];

const tabOf = (url: URL): Tab => {
  const asked = url.searchParams.get("tab");
  return asked === "all" || asked === "participating" ? asked : "unread";
};

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const tab = tabOf(url);
  const query = TABS.find((t) => t.tab === tab)?.query ?? "";
  const [viewer, page] = await Promise.all([
    signedInUser(context, request),
    apiGet<Page>(
      context,
      request,
      `/notifications?${[query, pageQuery(url, "cursor", 50)].filter(Boolean).join("&")}`,
    ),
  ]);
  if (!viewer) throw redirect(signInUrl(request));
  return {
    viewer: viewer.id,
    tab,
    threads: page.notifications.map((t) => ({ ...t, page: pageOf(t) })),
    degraded: page.delivery === "degraded",
    pages: pageLinks(url, "cursor", page.next_cursor),
  };
}

/** A thread's issue or pull request page: its number is the last segment of its API URL. */
function pageOf(thread: Thread): string | null {
  const number = /\/(?:issues|pulls)\/([1-9][0-9]{0,15})$/.exec(thread.subject.url)?.[1];
  if (!number) return null;
  const { owner, name } = { owner: thread.repository.owner.login, name: thread.repository.name };
  const repo = `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  return `${repo}/${thread.subject.type === "PullRequest" ? "pull" : "issues"}/${number}`;
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await readForm(request);
  const intent = String(form.get("intent") ?? "");
  if (!(await sameViewer(context, request, form))) return { error: OTHER_VIEWER };
  const id = String(form.get("id") ?? "");
  const thread = `/notifications/threads/${encodeURIComponent(id)}`;
  type Answer = { status: number; body: { detail?: string } | null };
  if (intent === "read") {
    const read = (await apiCall(context, request, "PATCH", thread)) as Answer;
    return read.status === 205 || read.status === 200
      ? { done: "Marked read." }
      : { error: read.body?.detail ?? "It was not marked read." };
  }
  if (intent === "done") {
    const done = (await apiCall(context, request, "DELETE", thread)) as Answer;
    return done.status === 204
      ? { done: "Marked done: it comes back when something new happens." }
      : { error: done.body?.detail ?? "It was not marked done." };
  }
  if (intent === "read-all") {
    const before = String(form.get("before") ?? "");
    const marked = (await apiCall(context, request, "PUT", "/notifications", {
      ...(before && { last_read_at: before }),
    })) as Answer;
    // One request marks up to 500: the page offers to go on from the same time.
    return marked.status === 202 || marked.status === 205
      ? {
          done: "Marked up to 500 threads read. If some are still unread, mark again: it goes on from the same time.",
          before,
        }
      : { error: marked.body?.detail ?? "They were not marked read." };
  }
  return { error: "That is not something this page does." };
}

const REASONS: Record<string, string> = {
  review_requested: "Review requested",
  mention: "Mentioned",
  team_mention: "Team mentioned",
  assign: "Assigned",
  author: "Yours",
  manual: "Subscribed",
  comment: "Commented",
  subscribed: "Watching",
  state_change: "State changed",
};

export default function Inbox({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const { tab, threads, degraded, pages, viewer } = loaderData;
  // Marking again after a partial pass keeps that pass's time, so nothing newer is marked.
  const newest =
    result && "before" in result && result.before ? result.before : threads[0]?.updated_at;
  const viewerField = <input type="hidden" name="viewer" value={viewer} />;
  return (
    <main>
      <h1>Inbox</h1>
      <nav aria-label="Inbox" className="row">
        {TABS.map((t) => (
          <Link
            key={t.tab}
            to={t.tab === "unread" ? "/notifications" : `/notifications?tab=${t.tab}`}
            aria-current={tab === t.tab ? "page" : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {degraded && (
        <p className="muted" role="note">
          Activity in watched repositories may be missing: the deployment's allowance for it ran out
          within the last week.
        </p>
      )}
      {result && "done" in result && <p role="status">{result.done}</p>}
      {result && "error" in result && (
        <p className="error" role="alert">
          {result.error}
        </p>
      )}
      {tab === "unread" && threads.length > 0 && (
        <Form method="post" key={viewer}>
          {viewerField}
          {newest && <input type="hidden" name="before" value={newest} />}
          <button type="submit" name="intent" value="read-all" disabled={busy}>
            Mark all read
          </button>
        </Form>
      )}
      {threads.length === 0 ? (
        <p>Nothing here.</p>
      ) : (
        <ul className="pull-list" aria-label="Notifications">
          {threads.map((t) => (
            <li key={t.id}>
              <p>
                <span className="muted">{t.repository.full_name}</span>{" "}
                {t.unread && <strong>Unread </strong>}
                <span className="muted">
                  {t.subject.type === "PullRequest" ? "Pull request" : "Issue"} ·{" "}
                  {REASONS[t.reason] ?? t.reason} · {t.updated_at.slice(0, 16).replace("T", " ")}{" "}
                  UTC
                </span>
              </p>
              <p>{t.page ? <Link to={t.page}>{t.subject.title}</Link> : t.subject.title}</p>
              <Form method="post" className="inline-form">
                {viewerField}
                <input type="hidden" name="id" value={t.id} />
                {t.unread && (
                  <button
                    type="submit"
                    name="intent"
                    value="read"
                    disabled={busy}
                    aria-label={`Mark read: ${t.subject.title}`}
                  >
                    Mark read
                  </button>
                )}{" "}
                <button
                  type="submit"
                  name="intent"
                  value="done"
                  disabled={busy}
                  aria-label={`Done: ${t.subject.title}`}
                >
                  Done
                </button>
              </Form>
            </li>
          ))}
        </ul>
      )}
      <Pager links={pages} label="Inbox" />
    </main>
  );
}
