import { data, Link } from "react-router";
import { InboxNav } from "../components/inbox-nav.js";
import { apiCall, bodyOf } from "../lib/api.server.js";
import { digestName, digestPath, digestTitle, windowLabel } from "../lib/digests.js";
import type { Route } from "./+types/notifications.digest";

/*
 * One digest: the threads of a watched repository's issues or pull
 * requests that saw activity in its window, as the API decides them now
 * (at most 50, newest first), each linked to its page, with who took part.
 */

export function meta({ loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  return [
    {
      title:
        loaderData?.gone === false ? `Digest of ${loaderData.repo} · Fyrden` : "Digest · Fyrden",
    },
  ];
}

interface Digest {
  repo: { id: string; full_name: string };
  subject: "issue" | "pull";
  starts_at: number;
  ends_at: number;
  threads: {
    number: number;
    title: string;
    actors: string[];
    more_actors: boolean;
  }[];
  complete: boolean;
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const name = digestName(params);
  if (!name) throw data("Not found", { status: 404 });
  const answer = await apiCall<Digest>(
    context,
    request,
    "GET",
    `/feed/digests/${digestPath(name)}`,
  );
  // Not readable now, or no longer shown (its threads gone, the repository restored, too old).
  if (answer.status === 404) return { gone: true as const };
  const digest = bodyOf(answer, request);
  const [owner = "", repo = ""] = digest.repo.full_name.split("/");
  const base = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${
    digest.subject === "pull" ? "pull" : "issues"
  }`;
  return {
    gone: false as const,
    repo: digest.repo.full_name,
    subject: digest.subject,
    window: windowLabel(digest.starts_at, digest.ends_at),
    threads: digest.threads.map((t) => ({
      number: t.number,
      title: t.title,
      page: `${base}/${t.number}`,
      actors: t.actors,
      more: t.more_actors,
    })),
    complete: digest.complete,
  };
}

export default function DigestPage({ loaderData }: Route.ComponentProps) {
  if (loaderData.gone)
    return (
      <main>
        <h1>Digest</h1>
        <InboxNav current="digests" />
        <p>
          This digest no longer shows: its threads are gone, you can no longer read them, or it is
          older than 16 days.
        </p>
      </main>
    );
  const { repo, subject, window, threads, complete } = loaderData;
  return (
    <main>
      <h1>{digestTitle(subject, repo)}</h1>
      <InboxNav current="digests" />
      <p className="muted">{window}</p>
      {threads.length === 0 ? (
        <p>Nothing here you can see now.</p>
      ) : (
        <ul className="pull-list" aria-label="Threads">
          {threads.map((t) => (
            <li key={t.number}>
              <p>
                <Link to={t.page}>{t.title}</Link> <span className="muted">#{t.number}</span>
              </p>
              <p className="muted">
                {t.actors.join(", ")}
                {t.more && " and others"}
              </p>
            </li>
          ))}
        </ul>
      )}
      {!complete && (
        <p className="muted" role="note">
          This digest may be incomplete: some threads or activity of its window may be missing.
        </p>
      )}
    </main>
  );
}
