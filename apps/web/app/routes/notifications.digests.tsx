import { Link, redirect } from "react-router";
import { DegradedNote, InboxNav } from "../components/inbox-nav.js";
import { Pager } from "../components/pager.js";
import { apiCall, bodyOf, signedInUser, signInUrl } from "../lib/api.server.js";
import { digestPage, digestTitle, windowLabel } from "../lib/digests.js";
import { pageLinks } from "../lib/pages.js";
import { problemCode } from "../lib/pulls.js";
import { useLiveHints } from "../lib/use-live.js";
import type { Route } from "./+types/notifications.digests";

/*
 * The digests of watched repositories: for watchers past a repository's
 * first 100, its activity of one kind in a 15-minute window comes as one
 * digest item of the feed. Listed as the feed keeps them, oldest change
 * first, and paged forward by its cursor (`since`); each opens its page.
 */

export function meta(): Route.MetaDescriptors {
  return [{ title: "Digests · Fyrden" }];
}

interface DigestItem {
  item_key: string;
  repo: { id: string; full_name: string };
  subject: { kind: "issue" | "pull" };
  digest?: { starts_at: number; ends_at: number; url: string };
}

interface Page {
  items: DigestItem[];
  next_cursor: string;
  coverage: "full" | "partial";
  delivery: "complete" | "degraded";
}

const PER_PAGE = 50;

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const since = url.searchParams.get("since");
  const query = new URLSearchParams({ kind: "digest", limit: String(PER_PAGE) });
  if (since) query.set("since", since);
  const [viewer, answer] = await Promise.all([
    signedInUser(context, request),
    apiCall<Page>(context, request, "GET", `/feed?${query}`),
  ]);
  if (!viewer) throw redirect(signInUrl(request));
  // A cursor lasts a day: past it, or one the API cannot read (a link cut short), start over
  // and say so. Only a cursor's: a first page's refusal is shown, not followed into a loop.
  const unusable =
    answer.status === 410 ||
    answer.status === 400 ||
    (answer.status === 422 && problemCode(answer.body) === "invalid_cursor");
  if (since && unusable) throw redirect("/notifications/digests?expired=1");
  const page = bodyOf(answer, request);
  // The note on starting over is for this page only, not the ones it links to.
  const here = new URL(url);
  here.searchParams.delete("expired");
  return {
    digests: page.items.flatMap((d) =>
      d.digest
        ? [
            {
              key: d.item_key,
              repo: d.repo.full_name,
              subject: d.subject.kind,
              window: windowLabel(d.digest.starts_at, d.digest.ends_at),
              page: digestPage(d.digest.url),
            },
          ]
        : [],
    ),
    degraded: page.delivery === "degraded",
    partial: page.coverage === "partial",
    expired: url.searchParams.get("expired") === "1",
    pages: pageLinks(here, "since", page.next_cursor),
  };
}

export default function Digests({ loaderData }: Route.ComponentProps) {
  const { digests, degraded, partial, expired, pages } = loaderData;
  useLiveHints(() => true);
  return (
    <main>
      <h1>Inbox</h1>
      <InboxNav current="digests" />
      <p className="muted">
        Activity in repositories you watch: past a repository's first 100 watchers, its activity
        comes gathered every 15 minutes. Oldest first; later pages are newer.
      </p>
      {expired && (
        <p role="status">
          That page could not be read any more, so this starts from the beginning again.
        </p>
      )}
      {degraded && <DegradedNote />}
      {partial && (
        <p className="muted" role="note">
          Some repositories are left out of these pages: they follow at most 1,000 repositories'
          issues or pull requests.
        </p>
      )}
      {digests.length === 0 ? (
        <p>Nothing here.</p>
      ) : (
        <ul className="pull-list" aria-label="Digests">
          {digests.map((d) => {
            const what = digestTitle(d.subject, d.repo);
            return (
              <li key={d.key}>
                <p>{d.page ? <Link to={d.page}>{what}</Link> : what}</p>
                <p className="muted">{d.window}</p>
              </li>
            );
          })}
        </ul>
      )}
      <Pager links={pages} label="Digests" />
    </main>
  );
}
