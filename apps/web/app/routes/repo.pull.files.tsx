import {
  Component,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";
import { isShown, shownLines } from "../components/diff/patch.js";
import {
  AppliedSuggestion,
  LineCommentForm,
  type LinePick,
  SentReply,
  ThreadView,
} from "../components/diff/thread.js";
import { WindowVirtualizer } from "../components/diff/window-virtualizer.js";
import { Drafts } from "../components/drafts.js";
import { Pager } from "../components/pager.js";
import { PullHeader } from "../components/pull-header.js";
import { ReviewForm } from "../components/review-form.js";
import { apiGet, assertSameOrigin, readForm } from "../lib/api.server.js";
import { pageLinks } from "../lib/pages.js";
import {
  field,
  OMITTED_REASON,
  type PullFile,
  type PullFilesPage,
  pullPage,
  rawField,
  sameComparison,
  type Thread,
} from "../lib/pulls.js";
import { type ActionResult, loadPull, pullApiOf, send, submitReview } from "../lib/pulls.server.js";
import { filesByPath, loadThreads } from "../lib/review-threads.server.js";
import type { Route } from "./+types/repo.pull.files";
import { FILES_PER_PAGE, type PagePatches } from "./repo.pull.patches.js";

// The renderer is loaded in the browser only, once a file is on screen.
const FileDiffView = lazy(() => import("../components/diff/file-diff.client.js"));

export function meta({ params, loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  const title = loaderData?.pull.title ?? `#${params.number}`;
  return [{ title: `Files · ${title} · ${params.owner}/${params.repo} · Fyrden` }];
}

/** Bytes of a files-page form at most: a comment of 65,536 characters, URL-encoded, and the rest. */
const FILES_FORM_MAX_BYTES = 9 * 65_536 + 16 * 1024;

/** A file as the page lists it: the listing without its patch (the browser loads those). */
export type FileEntry = Omit<PullFile, "patch"> & { hasPatch: boolean };

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const { pull, viewer } = await loadPull(context, request, params);
  const api = pullApiOf(params);
  const cursor = url.searchParams.get("cursor");
  const query = new URLSearchParams({ per_page: String(FILES_PER_PAGE) });
  if (cursor) query.set("cursor", cursor);
  const page = await apiGet<PullFilesPage>(context, request, `${api}/files?${query.toString()}`);
  const { threads, next } = await loadThreads(
    context,
    request,
    api,
    pull,
    filesByPath(page.files),
    url.searchParams.get("comments"),
  );
  return {
    owner: params.owner,
    repo: params.repo,
    pull,
    viewer,
    cursor,
    files: page.files.map(
      ({ patch, ...rest }): FileEntry => ({ ...rest, hasPatch: patch !== undefined }),
    ),
    headSha: page.head_sha,
    mergeBaseSha: page.merge_base_sha,
    truncated: page.truncated,
    pages: pageLinks(url, "cursor", page.next_cursor),
    threads,
    threadPages: pageLinks(url, "comments", next),
    diffStyle:
      url.searchParams.get("style") === "split" ? ("split" as const) : ("unified" as const),
  };
}

/** A positive line number from a form field, or undefined. */
function lineOf(form: FormData, name: string): number | undefined {
  const value = field(form, name);
  return /^[1-9][0-9]{0,8}$/.test(value) ? Number(value) : undefined;
}

export async function action({
  request,
  context,
  params,
}: Route.ActionArgs): Promise<ActionResult> {
  assertSameOrigin(request);
  const form = await readForm(request, FILES_FORM_MAX_BYTES);
  const api = pullApiOf(params);
  const post = (path: string, body: unknown, intent: string, fallback: string) =>
    send(context, request, "POST", `${api}${path}`, body, intent, fallback);
  switch (field(form, "intent")) {
    case "comment": {
      const body = rawField(form, "body");
      const line = lineOf(form, "line");
      const start = lineOf(form, "start_line");
      const side = field(form, "side") === "LEFT" ? "LEFT" : "RIGHT";
      if (!body.trim()) return { error: "Write a comment first." };
      if (line === undefined) return { error: "Name the line to comment on." };
      if (field(form, "start_line") && (start === undefined || start > line))
        return { error: "The first line must be a line number no later than the last." };
      return post(
        "/comments",
        {
          body,
          commit_id: field(form, "commit_id"),
          // The old side of a renamed file is its old path, at the merge base.
          path: (side === "LEFT" && rawField(form, "previous_path")) || rawField(form, "path"),
          line,
          side,
          ...(start !== undefined && start < line && { start_line: start, start_side: side }),
        },
        "comment",
        "The comment was not added.",
      );
    }
    case "reply": {
      const body = rawField(form, "body");
      const to = lineOf(form, "in_reply_to");
      if (!body.trim()) return { error: "Write a reply first." };
      if (to === undefined) return { error: "Unknown conversation." };
      return post("/comments", { body, in_reply_to: to }, "reply", "The reply was not added.");
    }
    case "resolve":
    case "unresolve": {
      const thread = lineOf(form, "thread_id");
      if (thread === undefined) return { error: "Unknown conversation." };
      const resolving = field(form, "intent") === "resolve";
      return send(
        context,
        request,
        resolving ? "PUT" : "DELETE",
        `${api}/threads/${thread}/resolution`,
        undefined,
        resolving ? "resolve" : "unresolve",
        "The conversation was not changed.",
      );
    }
    case "apply": {
      const comment = lineOf(form, "comment_id");
      if (comment === undefined) return { error: "Unknown suggestion." };
      return post(
        "/suggestions/apply",
        { comment_ids: [comment] },
        "apply",
        "The suggestion was not applied.",
      );
    }
    case "review":
      return submitReview(context, request, api, form);
    default:
      return { error: "Unknown action." };
  }
}

/** A page's patches as the browser loads them: by file name, or why they are not shown. */
type Patches =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "stale" }
  | { state: "loaded"; byName: Map<string, string | null> };

/** Loads the patches of the page `cursor` names, once the page is in the browser. */
function usePatches(
  page: string,
  cursor: string | null,
  headSha: string,
  mergeBaseSha: string,
): Patches {
  const [patches, setPatches] = useState<Patches>({ state: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setPatches({ state: "loading" });
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    fetch(`${page}/files/patches${query}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok || !res.headers.get("Content-Type")?.includes("application/json"))
          throw new Error(`status ${res.status}`);
        const body = (await res.json()) as PagePatches;
        // The first page follows the branches: a push to either since this page loaded
        // compares other commits, whose changes are not the ones listed.
        if (!sameComparison(body, { headSha, mergeBaseSha })) return setPatches({ state: "stale" });
        setPatches({
          state: "loaded",
          byName: new Map(body.patches.map((p) => [p.filename, p.patch])),
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setPatches({ state: "failed" });
      });
    return () => controller.abort();
  }, [page, cursor, headSha, mergeBaseSha]);
  return patches;
}

/** True once `ref`'s element has come near the screen (and from then on). */
function useNearScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (near || !element) return;
    if (typeof IntersectionObserver === "undefined") return setNear(true);
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, near]);
  return near;
}

/** Shows the changes as text when the renderer fails. */
class RendererBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const STATUS_TEXT: Record<PullFile["status"], string> = {
  added: "added",
  removed: "removed",
  modified: "modified",
  renamed: "renamed",
  changed: "mode changed",
};

/** What a file without hunks shows instead. */
function noHunksText(file: FileEntry): string {
  if (file.patch_omitted) return OMITTED_REASON[file.patch_omitted];
  if (file.status === "renamed") return "Renamed without changes.";
  if (file.status === "changed") return "Only its mode changed.";
  if (file.status === "added") return "An empty file was added.";
  if (file.status === "removed") return "An empty file was removed.";
  return "No changes to show.";
}

function FileSection({
  file,
  index,
  count,
  patches,
  threads,
  viewer,
  headSha,
  mergeBaseSha,
  diffStyle,
}: {
  file: FileEntry;
  index: number;
  count: number;
  patches: Patches;
  threads: Thread[];
  viewer: string | null;
  headSha: string;
  mergeBaseSha: string;
  diffStyle: "unified" | "split";
}) {
  const body = useRef<HTMLElement>(null);
  const near = useNearScreen(body);
  const [pick, setPick] = useState<LinePick | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const onPick = useCallback((p: LinePick) => {
    setPick(p);
    setFormOpen(true);
  }, []);
  const patch = patches.state === "loaded" ? patches.byName.get(file.filename) : undefined;
  const drawn = near && typeof patch === "string" && patch !== "";
  // Threads on lines the hunks show sit under those lines once drawn; the rest are listed.
  const inline = useMemo(() => {
    if (!drawn) return [];
    const shown = shownLines(patch);
    return threads.filter((t) => t.line !== null && isShown(shown, t.side, t.line));
  }, [drawn, patch, threads]);
  const listed = threads.filter((t) => !inline.includes(t));
  const canAct = viewer !== null;
  const headingId = `file-${index}-name`;
  const fallback =
    typeof patch === "string" && patch !== "" ? <pre className="patch-text">{patch}</pre> : null;
  return (
    <section className="file panel" id={`file-${index}`} aria-labelledby={headingId}>
      <header className="file-header">
        <h3 id={headingId} className="file-name">
          {file.previous_filename !== undefined && (
            <>
              <span className="muted">{file.previous_filename}</span> →{" "}
            </>
          )}
          <span>{file.filename}</span>
        </h3>
        <p className="row muted">
          <span className="badge">{STATUS_TEXT[file.status]}</span>
          <span>
            <span className="added">+{file.additions}</span>{" "}
            <span className="removed">−{file.deletions}</span>
          </span>
          {file.approximate && (
            <span title="The comparison stopped early: these are right but may not be the shortest changes.">
              approximate
            </span>
          )}
          <span className="row file-nav">
            {index > 0 && <a href={`#file-${index - 1}`}>Previous file</a>}
            {index < count - 1 && <a href={`#file-${index + 1}`}>Next file</a>}
          </span>
        </p>
      </header>
      {canAct && (
        <LineCommentForm
          path={file.filename}
          previousPath={file.previous_filename}
          headSha={headSha}
          pick={pick}
          open={formOpen}
          onToggle={setFormOpen}
        />
      )}
      <section
        ref={body}
        className="diff-body"
        aria-label={`Changes to ${file.filename}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus, so the keyboard can scroll a wide diff.
        tabIndex={0}
      >
        {!file.hasPatch ? (
          <p className="muted">{noHunksText(file)}</p>
        ) : patches.state === "loading" ? (
          <p className="muted">Loading changes…</p>
        ) : patches.state === "failed" ? (
          <p className="error">The changes could not be loaded; reload the page.</p>
        ) : patches.state === "stale" ? (
          <p className="error">
            The pull request changed since this page was loaded.{" "}
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </p>
        ) : patch === "" || patch === null || patch === undefined ? (
          <p className="muted">{noHunksText(file)}</p>
        ) : drawn ? (
          <RendererBoundary fallback={fallback}>
            <Suspense fallback={<p className="muted">Drawing changes…</p>}>
              <FileDiffView
                path={file.filename}
                previousPath={file.previous_filename}
                status={file.status}
                patch={patch}
                cacheKey={`${mergeBaseSha}..${headSha}:${file.filename}`}
                diffStyle={diffStyle}
                threads={inline}
                viewer={viewer}
                canAct={canAct}
                onPick={onPick}
              />
            </Suspense>
          </RendererBoundary>
        ) : (
          <p className="muted">Changes are drawn when you scroll to them.</p>
        )}
      </section>
      {fallback && (
        <details className="patch-alternative">
          <summary>Changes as plain text</summary>
          {fallback}
        </details>
      )}
      <AppliedSuggestion file={file.filename} />
      {canAct && threads.map((t) => <SentReply key={t.id} thread={t.id} />)}
      {listed.length > 0 && (
        <div className="threads">
          <h4>{drawn ? "Other comments on this file" : "Comments on this file"}</h4>
          {listed.map((t) => (
            <ThreadView key={t.id} thread={t} viewer={viewer} canAct={canAct} />
          ))}
        </div>
      )}
    </section>
  );
}

export default function PullFiles({ loaderData }: Route.ComponentProps) {
  const {
    owner,
    repo,
    pull,
    viewer,
    cursor,
    files,
    headSha,
    mergeBaseSha,
    truncated,
    pages,
    threads,
    threadPages,
    diffStyle,
  } = loaderData;
  const page = pullPage(owner, repo, pull.number);
  const patches = usePatches(page, cursor, headSha, mergeBaseSha);
  const byPath = useMemo(() => {
    const map = new Map<string, Thread[]>();
    for (const t of threads) map.set(t.file, [...(map.get(t.file) ?? []), t]);
    return map;
  }, [threads]);
  const styleLink = (style: "unified" | "split") => {
    const query = new URLSearchParams();
    if (cursor) query.set("cursor", cursor);
    if (style === "split") query.set("style", "split");
    const search = query.toString();
    return search ? `${page}/files?${search}` : `${page}/files`;
  };
  return (
    <main className="wide">
      <PullHeader owner={owner} repo={repo} pull={pull} viewer={viewer} active="files" />
      <div className="row">
        <span>
          Comparing <code>{mergeBaseSha.slice(0, 7)}</code> (merge base) with{" "}
          <code>{headSha.slice(0, 7)}</code> (head)
        </span>
        <nav className="row" aria-label="Layout">
          <Link
            to={styleLink("unified")}
            aria-current={diffStyle === "unified" ? "true" : undefined}
          >
            Unified
          </Link>
          <Link to={styleLink("split")} aria-current={diffStyle === "split" ? "true" : undefined}>
            Split
          </Link>
        </nav>
      </div>
      {truncated && (
        <p className="error" role="note">
          More than 3,000 files changed: only the first 3,000 are listed.
        </p>
      )}
      {headSha !== pull.head.sha && (
        <p className="error" role="note">
          These are the changes of an older head, <code>{headSha.slice(0, 7)}</code>: the pull
          request is now at <code>{pull.head.sha.slice(0, 7)}</code>. Comments and reviews here are
          of the older head. <Link to={`${page}/files`}>See the latest changes</Link>
        </p>
      )}
      {(threadPages.next || threadPages.first) && (
        <p className="muted" role="note">
          Review comments are shown a batch at a time.
        </p>
      )}
      <Pager links={threadPages} label="Review comment" />
      {files.length === 0 ? (
        <p className="muted">No files changed.</p>
      ) : (
        <>
          <nav aria-label="Changed files" className="panel">
            <ol className="file-list">
              {files.map((f, i) => (
                <li key={f.filename}>
                  <a href={`#file-${i}`}>{f.filename}</a>{" "}
                  <span className="muted">
                    {STATUS_TEXT[f.status]} · +{f.additions} −{f.deletions}
                  </span>
                </li>
              ))}
            </ol>
          </nav>
          <Drafts viewer={viewer} page={page}>
            <WindowVirtualizer>
              {files.map((f, i) => (
                <FileSection
                  key={f.filename}
                  file={f}
                  index={i}
                  count={files.length}
                  patches={patches}
                  threads={byPath.get(f.filename) ?? []}
                  viewer={viewer}
                  headSha={headSha}
                  mergeBaseSha={mergeBaseSha}
                  diffStyle={diffStyle}
                />
              ))}
            </WindowVirtualizer>
          </Drafts>
        </>
      )}
      <Pager links={pages} label="Changed files" />
      {pull.state === "open" && viewer !== null && (
        // The review is of the head these changes are of, which may be older than the
        // pull request's (a later page keeps the comparison it started with).
        <ReviewForm headSha={headSha} isAuthor={pull.user.id === viewer} />
      )}
    </main>
  );
}
