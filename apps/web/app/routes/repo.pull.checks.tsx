import { Link } from "react-router";
import { CheckRow, StatusRow } from "../components/pull-checks.js";
import { PullHeader } from "../components/pull-header.js";
import { apiCall } from "../lib/api.server.js";
import type { CheckRunsPage, CombinedStatus } from "../lib/checks.js";
import { optionalRead } from "../lib/checks.server.js";
import type { RequiredChecks } from "../lib/merge.js";
import { pullPage } from "../lib/pulls.js";
import { loadPull, pullApiOf } from "../lib/pulls.server.js";
import type { Route } from "./+types/repo.pull.checks";

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Checks · #${params.number} · ${params.owner}/${params.repo} · Fyrden` }];
}

const PER_PAGE = 100;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const { pull, viewer } = await loadPull(context, request, params);
  const head = pull.head.sha;
  const moved = url.searchParams.has("head") && url.searchParams.get("head") !== head;
  const cursor = (name: string) => (moved ? null : url.searchParams.get(name));
  const repoApi = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
  const paged = (path: string, at: string | null) =>
    `${path}?per_page=${PER_PAGE}${at ? `&cursor=${encodeURIComponent(at)}` : ""}`;
  const checksAt = cursor("checks_cursor");
  const statusesAt = cursor("statuses_cursor");
  const [checks, statuses, required] = await Promise.all([
    optionalRead(() =>
      apiCall<CheckRunsPage>(
        context,
        request,
        "GET",
        paged(`${repoApi}/commits/${head}/check-runs`, checksAt),
      ),
    ),
    optionalRead(() =>
      apiCall<CombinedStatus>(
        context,
        request,
        "GET",
        paged(`${repoApi}/commits/${head}/status`, statusesAt),
      ),
    ),
    pull.state === "open"
      ? optionalRead(() =>
          apiCall<RequiredChecks>(context, request, "GET", `${pullApiOf(params)}/required-checks`),
        )
      : Promise.resolve({ state: "unavailable" as const }),
  ]);
  return {
    owner: params.owner,
    repo: params.repo,
    pull,
    viewer,
    head,
    moved,
    checksAt,
    statusesAt,
    checks,
    statuses,
    required:
      required.state === "read" && required.body.head_sha === head ? required.body.checks : null,
  };
}

export default function PullChecks({ loaderData }: Route.ComponentProps) {
  const {
    owner,
    repo,
    pull,
    viewer,
    head,
    moved,
    checksAt,
    statusesAt,
    checks,
    statuses,
    required,
  } = loaderData;
  const tab = `${pullPage(owner, repo, pull.number)}/checks`;
  const link = (name: string, value: string, other: string, otherValue: string | null) => {
    const query = new URLSearchParams({ head, [name]: value });
    if (otherValue) query.set(other, otherValue);
    return `${tab}?${query}`;
  };
  return (
    <main>
      <PullHeader owner={owner} repo={repo} pull={pull} viewer={viewer} active="checks" />
      {moved && (
        <p role="status" className="panel">
          The head moved since; these are the checks of the new head.
        </p>
      )}
      <p className="muted">
        Checks of <code>{head.slice(0, 7)}</code>, the head.
        {required !== null &&
          required.length > 0 &&
          " Required checks are marked; the merge box says where they stand."}
      </p>
      <section aria-labelledby="ci-checks">
        <h2 id="ci-checks">Check runs</h2>
        {checks.state === "unavailable" ? (
          <p className="muted">The check runs could not be read.</p>
        ) : checks.body.check_runs.length === 0 ? (
          <p className="muted">No check runs.</p>
        ) : (
          // biome-ignore lint/a11y/noRedundantRoles: without markers, WebKit reads a list as a group unless told.
          <ul role="list" className="run-jobs">
            {checks.body.check_runs.map((c) => (
              <CheckRow key={c.name} check={c} owner={owner} repo={repo} required={required} />
            ))}
          </ul>
        )}
        {checks.state === "read" && (checksAt || checks.body.next_cursor) && (
          <nav className="pager" aria-label="Check run pages">
            {checksAt && (
              <Link
                to={`${tab}?${new URLSearchParams({ head, ...(statusesAt && { statuses_cursor: statusesAt }) })}`}
              >
                First check runs
              </Link>
            )}
            {checks.body.next_cursor && (
              <Link
                to={link("checks_cursor", checks.body.next_cursor, "statuses_cursor", statusesAt)}
              >
                More check runs
              </Link>
            )}
          </nav>
        )}
      </section>
      <section aria-labelledby="commit-statuses">
        <h2 id="commit-statuses">Commit statuses</h2>
        {statuses.state === "unavailable" ? (
          <p className="muted">The commit statuses could not be read.</p>
        ) : statuses.body.statuses.length === 0 ? (
          <p className="muted">No commit statuses.</p>
        ) : (
          // biome-ignore lint/a11y/noRedundantRoles: without markers, WebKit reads a list as a group unless told.
          <ul role="list" className="run-jobs">
            {statuses.body.statuses.map((s) => (
              <StatusRow key={s.id} status={s} required={required} />
            ))}
          </ul>
        )}
        {statuses.state === "read" && (statusesAt || statuses.body.next_cursor) && (
          <nav className="pager" aria-label="Commit status pages">
            {statusesAt && (
              <Link
                to={`${tab}?${new URLSearchParams({ head, ...(checksAt && { checks_cursor: checksAt }) })}`}
              >
                First statuses
              </Link>
            )}
            {statuses.body.next_cursor && (
              <Link
                to={link("statuses_cursor", statuses.body.next_cursor, "checks_cursor", checksAt)}
              >
                More statuses
              </Link>
            )}
          </nav>
        )}
      </section>
    </main>
  );
}
