/**
 * A text file's numbered lines. The server draws them as plain anchors, which work with no
 * script at all: the plain view stays until the renderer has drawn the file over it, and
 * stays if it can't. Every link here is a native one: the server picks the block, and a
 * navigation through the router would fire no `hashchange`.
 */
import {
  Component,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import {
  blockLink,
  type LineRange,
  lineLink,
  lineParam,
  rawBytesUrl,
  splitLines,
  type TextFile,
} from "../lib/file-view.js";
import { forgetLineEntry, useLineLinks } from "../lib/use-line-links.js";
import type { FileViewStatus } from "./diff/file-view.client.js";

// The renderer is loaded in the browser only, once the page is hydrated.
const FileView = lazy(() => import("./diff/file-view.client.js"));

/** The lines of one block or file, as the server draws them. */
function PlainLines({ file, selection }: { file: TextFile; selection: LineRange | null }) {
  const lines = splitLines(file.text);
  const digits = String(file.totalLines).length;
  return (
    <pre className="file-lines" style={{ "--file-gutter": `${digits}ch` } as React.CSSProperties}>
      <code>
        {lines.map((text, at) => {
          const number = file.firstLine + at;
          const Line =
            selection && number >= selection.start && number <= selection.end ? "mark" : "span";
          return (
            <Line key={number} className="file-line">
              <a id={`L${number}`} href={lineLink({ start: number, end: number }, file.plain)}>
                {number}
              </a>
              <span>{text}</span>
            </Line>
          );
        })}
      </code>
    </pre>
  );
}

/** Previous and next, when the file is sent a block at a time. They keep the lines selected. */
function Paging({
  file,
  selection,
  label,
}: {
  file: TextFile;
  selection: LineRange | null;
  label: string;
}) {
  const selected = lineParam(selection);
  if (file.whole) return null;
  const last = file.firstLine + splitLines(file.text).length - 1;
  return (
    <nav className="row file-paging" aria-label={label}>
      {file.previous !== null && (
        <a href={blockLink(file.previous, selected, file.plain)}>Previous</a>
      )}
      <span className="muted">
        {`Lines ${file.firstLine.toLocaleString("en")} to ${last.toLocaleString("en")} of ${file.totalLines.toLocaleString("en")}`}
      </span>
      {file.next !== null && <a href={blockLink(file.next, selected, file.plain)}>Next</a>}
    </nav>
  );
}

/**
 * The keyboard route to any line: the renderer's gutter can't take focus. Its action is this
 * path with no fragment: with none, the form would send the page's, and a browser keeps a
 * request's fragment across a redirect that names none, so "nonsense" would stay on the old line.
 */
function GoToLine({ file }: { file: TextFile }) {
  return (
    <form method="get" action="?" className="row file-goto">
      {file.plain && <input type="hidden" name="plain" value="1" />}
      <label htmlFor="file-goto">Go to line</label>
      <input id="file-goto" name="goto" inputMode="numeric" size={8} autoComplete="off" />
      <button type="submit">Go</button>
    </form>
  );
}

/** Leaves the plain view up when the renderer's module won't load or its drawing throws. */
class Fallback extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.onFail();
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function NumberedFile({
  file,
  owner,
  repo,
  gitRef,
  path,
}: {
  file: TextFile;
  owner: string;
  repo: string;
  gitRef: string;
  path: string;
}) {
  const { selection, position, select, routerCommits } = useLineLinks({
    total: file.totalLines,
    plain: file.plain,
    selected: file.selected,
  });
  const [hydrated, setHydrated] = useState(false);
  // What the renderer can draw: the text here, or the whole of it at the commit it came from.
  const drawable = file.whole || file.commit !== null;
  const [status, setStatus] = useState<FileViewStatus>(drawable ? "waiting" : "failed");
  const onFail = useCallback(() => setStatus("failed"), []);
  useEffect(() => setHydrated(true), []);

  // The plain view is what is on the page: an anchor for what a fragment alone can't scroll to.
  useLayoutEffect(() => {
    if (status === "drawn" || position === null || "top" in position) return;
    document.getElementById(`L${position.line}`)?.scrollIntoView();
  }, [position, status]);
  // Left with the plain view and a line out of its block: the URL is canonical by now, and the
  // server picks the block that holds it, whose lines then include it (so this happens once).
  useEffect(() => {
    if (status !== "failed" || position === null || "top" in position) return;
    if (document.getElementById(`L${position.line}`) !== null) return;
    forgetLineEntry();
    window.location.reload();
  }, [position, status]);

  const raw = rawBytesUrl(owner, repo, gitRef, path);
  const showPlain = status !== "drawn";
  return (
    <>
      <GoToLine file={file} />
      {showPlain ? (
        <Paging file={file} selection={selection} label="Pages of this file" />
      ) : (
        // Its height kept, so the rows don't move when the renderer takes over.
        !file.whole && (
          <p className="row file-paging muted">{`${file.totalLines.toLocaleString("en")} lines`}</p>
        )
      )}
      <div
        className="file-view"
        data-router-commits={routerCommits}
        data-drawn={status === "drawn" ? "file" : status === "failed" ? "text" : "waiting"}
      >
        {showPlain && <PlainLines file={file} selection={selection} />}
        {hydrated && status !== "failed" && (
          <Fallback onFail={onFail}>
            <Suspense fallback={null}>
              <FileView
                path={path}
                cacheKey={file.sha}
                text={file.whole ? file.text : null}
                rawUrl={file.commit !== null ? rawBytesUrl(owner, repo, file.commit, path) : null}
                size={file.size}
                totalLines={file.totalLines}
                selection={selection}
                onSelect={select}
                position={position}
                revealed={status === "drawn"}
                onStatus={setStatus}
              />
            </Suspense>
          </Fallback>
        )}
      </div>
      {showPlain && file.cut && (
        <p className="muted">
          This line is cut at 64 KiB. <a href={raw}>Raw</a> has all of it.
        </p>
      )}
      {showPlain && <Paging file={file} selection={selection} label="Pages of this file, again" />}
    </>
  );
}
