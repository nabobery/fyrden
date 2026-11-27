import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LiveLog, type LiveSocket, type Ticket } from "../lib/live-log.js";
import { LogReader, readRanges } from "../lib/log-reader.js";
import { type LogSpan, SpanCache } from "../lib/log-spans.js";
import { LogStore, type StoredRow } from "../lib/log-store.js";
import {
  type Anchor,
  anchorAt,
  anchoredTop,
  autoOpen,
  flatLayout,
  flatOfKey,
  type ItemKey,
  keyOf,
  reconcileOpen,
  rowRanges,
  type StepState,
  scrollGeometry,
  segmentsOf,
  visibleWindow,
} from "../lib/log-window.js";
import { type Job, jobPath, jobRawPath, logRefusalWords, runsApi } from "../lib/runs.js";
import { RunState, useViewer } from "./run-ui.js";

const OVERSCAN = 30;
const SETTLE_MS = 150;
const ANNOUNCE_MS = 10_000;
const TAIL_ROWS = 200;

type Props = { owner: string; repo: string; runId: string; job: Job };

function socketAt(url: string): LiveSocket {
  const ws = new WebSocket(url);
  const socket: LiveSocket = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (text) => ws.send(text),
    close: () => ws.close(),
  };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = (event) => socket.onmessage?.({ data: event.data });
  ws.onclose = (event) => socket.onclose?.({ code: event.code });
  ws.onerror = () => socket.onerror?.();
  return socket;
}

function lineHash(): number | null {
  const match = /^#L([1-9][0-9]{0,9})$/.exec(typeof location === "undefined" ? "" : location.hash);
  return match ? Number(match[1]) - 1 : null;
}

function Row({
  i,
  row,
  spans,
  notStored,
  raw,
}: {
  i: number;
  row: StoredRow | undefined;
  spans: (c: string) => LogSpan[];
  notStored: boolean;
  raw: string;
}) {
  const number = notStored ? (
    <span className="log-no">{i + 1}</span>
  ) : (
    <a className="log-no" href={`#L${i + 1}`} aria-label={`Line ${i + 1}`}>
      {i + 1}
    </a>
  );
  if (row === undefined)
    return (
      <>
        {number}
        <span className="muted">…</span>
      </>
    );
  if (row.kind === "omitted")
    return (
      <>
        {number}
        <span className="muted">[row omitted: {row.bytes} bytes]</span>
      </>
    );
  const cut = (row.kind === "whole" || row.kind === "prefix") && row.cut;
  return (
    <>
      {number}
      {row.kind === "suffix" && <span className="muted">… </span>}
      {spans(row.c).map((s, k) =>
        s.className ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: spans of one row never move.
          <span key={k} className={s.className}>
            {s.text}
          </span>
        ) : (
          s.text
        ),
      )}
      {(cut || (row.kind === "prefix" && !row.c)) && (
        <span className="muted">
          {" "}
          … <a href={raw}>rest in the raw text</a>
        </span>
      )}
      {row.kind === "suffix" && (
        <span className="muted">
          {" "}
          <a href={raw}>whole line in the raw text</a>
        </span>
      )}
      {notStored && <span className="muted"> (shown live, not stored)</span>}
    </>
  );
}

export function LogViewer({ owner, repo, runId, job }: Props) {
  const viewer = useViewer();
  const store = useMemo(() => new LogStore(), []);
  const spans = useMemo(() => new SpanCache(), []);
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const api = `/api${runsApi(owner, repo)}/runs/${encodeURIComponent(runId)}/jobs/${job.id}/logs/rows`;
  const reader = useMemo(
    () =>
      new LogReader({
        store,
        fetchPage: async (query) => {
          const res = await fetch(`${api}?${query}`, {
            headers: { "X-Fyrden-Session": "1", Accept: "application/json" },
            credentials: "same-origin",
          });
          const text = await res.text();
          return {
            status: res.status,
            body: text ? (JSON.parse(text) as unknown) : null,
            retryAfter: res.headers.get("Retry-After"),
          };
        },
      }),
    [store, api],
  );
  const scroller = useRef<HTMLElement>(null);
  const [rowPx, setRowPx] = useState(20);
  const [viewport, setViewport] = useState(600);
  const [top, setTop] = useState(0);
  const [following, setFollowing] = useState(false);
  const [live, setLive] = useState<LiveLog | null>(null);
  const [announce, setAnnounce] = useState("");
  const [lineNote, setLineNote] = useState("");
  const steps = useMemo(
    () =>
      job.steps
        .filter((s) => s.log !== null)
        .map((s) => ({ number: s.number, from: s.log?.from ?? 0, rows: s.log?.rows ?? 0 })),
    [job.steps],
  );
  const stepStates = useMemo<StepState[]>(
    () =>
      job.steps.map((s) => ({
        number: s.number,
        status: s.status,
        conclusion: s.conclusion,
        logged: s.log !== null,
      })),
    [job.steps],
  );
  const touched = useRef(new Set<number>());
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set(autoOpen(stepStates)));
  const [reconciled, setReconciled] = useState(stepStates);
  if (reconciled !== stepStates) {
    setReconciled(stepStates);
    setOpen((o) => reconcileOpen(o, touched.current, stepStates));
  }
  const [focused, setFocused] = useState<ItemKey | null>(null);

  const segments = segmentsOf(steps, store.length);
  const layout = flatLayout(segments, open);
  const geometry = scrollGeometry(layout.count, rowPx, viewport);
  const logicalTop = geometry.logicalTop(top);
  const view = visibleWindow(logicalTop, viewport, rowPx, layout.count, OVERSCAN);
  const ranges = rowRanges(layout, view.first, view.last);

  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const probe = box.querySelector<HTMLElement>("[data-probe]");
    const measured = probe?.getBoundingClientRect().height;
    if (measured && measured > 0) setRowPx(measured);
    const observer = new ResizeObserver(() => setViewport(box.clientHeight || 600));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const target = useRef<number | null>(null);
  const jumped = useRef(false);
  const jumpTo = useCallback(
    (row: number) => {
      jumped.current = true;
      target.current = row;
      setLineNote("");
      setFollowing(false);
      store.focus([...store.focused(), [row, row + 1]]);
      void reader.want(row, row + 1)?.then(bump);
      bump();
    },
    [reader, bump, store],
  );
  useEffect(() => {
    const onHash = () => {
      const asked = lineHash();
      if (asked !== null) jumpTo(asked);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, [jumpTo]);
  useEffect(() => {
    const row = target.current;
    const box = scroller.current;
    if (row === null || !box || !reader.answered) return;
    if (row >= store.length) {
      target.current = null;
      setLineNote(`Line ${row + 1} is past the end of this log (${store.length} lines).`);
      return;
    }
    const step = layout.stepOf(row);
    if (step !== null && !open.has(step)) {
      setOpen((o) => new Set(o).add(step));
      return;
    }
    if (store.row(row) === undefined) {
      if (store.closed && row >= store.durable) target.current = null;
      else void reader.want(row, row + 1)?.then(bump);
      return;
    }
    const flat = layout.flatOf(row);
    if (flat === null) return;
    target.current = null;
    box.scrollTop = geometry.physicalTop(Math.max(0, flat * rowPx - viewport / 3));
    box.scrollIntoView({ block: "nearest" });
  });

  const opening = useRef<{ growing: boolean; asked: number | null } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per job, at the first view.
  useEffect(() => {
    const asked = lineHash();
    const growing = job.status !== "completed" || job.log_complete === null;
    opening.current = { growing, asked };
    if (asked !== null) {
      jumpTo(asked);
      return;
    }
    const failed = job.steps.find((s) => s.conclusion === "failure" && s.log);
    if (!growing && failed?.log) target.current = failed.log.from;
    const first = growing
      ? reader.tail(TAIL_ROWS)
      : failed?.log
        ? reader.want(failed.log.from, failed.log.from + 1)
        : reader.want(0, 1);
    void first?.then(bump);
  }, [job.id]);

  const liveRef = useRef<LiveLog | null>(null);
  useEffect(() => {
    const start = opening.current;
    if (liveRef.current || !start || !reader.answered || store.closed || !viewer) return;
    const made = new LiveLog({
      store,
      ticket: async (from): Promise<Ticket> => {
        const res = await fetch(`${jobPath(owner, repo, runId, job.id)}/live`, {
          method: "POST",
          body: new URLSearchParams({ viewer, from: String(from) }),
          credentials: "same-origin",
        });
        return res.ok ? ((await res.json()) as Ticket) : { refused: `status_${res.status}` };
      },
      connect: socketAt,
      onChange: bump,
    });
    liveRef.current = made;
    setLive(made);
    if (start.growing && start.asked === null && !jumped.current) setFollowing(true);
    void made.start(store.durable);
  });
  useEffect(() => () => liveRef.current?.stop(), []);

  useEffect(() => {
    store.follow(following);
    store.focus(
      target.current === null ? ranges : [...ranges, [target.current, target.current + 1]],
    );
  });

  const lengthRef = useRef(store.length);
  useEffect(() => {
    const grown = store.length - lengthRef.current;
    lengthRef.current = store.length;
    const box = scroller.current;
    if (following && box) box.scrollTop = box.scrollHeight;
    if (grown > 0 && following) setAnnounce((a) => (a ? a : `${grown} new lines`));
  });
  useEffect(() => {
    if (!announce) return;
    const timer = setTimeout(() => setAnnounce(""), ANNOUNCE_MS);
    return () => clearTimeout(timer);
  }, [announce]);

  const wake = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wakeIn = useCallback(
    (ms: number) => {
      clearTimeout(wake.current);
      wake.current = setTimeout(bump, ms);
    },
    [bump],
  );
  useEffect(() => () => clearTimeout(wake.current), []);

  const rangesKey = ranges.map(([a, b]) => `${a}-${b}`).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the view's rows, not live data, restart the wait.
  useEffect(() => {
    return readRanges(reader, () => store.focused(), bump, SETTLE_MS);
  }, [rangesKey, reader, bump, store]);

  useEffect(() => {
    const wait = reader.retryAfterMs();
    if (wait === null) return;
    const timer = setTimeout(() => {
      const read = reader.retry();
      if (read) void read.then(bump);
      else wakeIn(Math.max(reader.waitMs(), SETTLE_MS));
    }, wait);
    return () => clearTimeout(timer);
  });

  const anchor = useRef<Anchor | null>(null);
  useLayoutEffect(() => {
    const box = scroller.current;
    const wanted = anchoredTop(layout, anchor.current, rowPx);
    if (box && !following && target.current === null && wanted !== null) {
      if (Math.abs(wanted - logicalTop) >= 1) {
        box.scrollTop = geometry.physicalTop(Math.max(0, wanted));
        setTop(box.scrollTop);
        anchor.current = anchorAt(layout, geometry.logicalTop(box.scrollTop), rowPx);
        return;
      }
    }
    anchor.current = anchorAt(layout, logicalTop, rowPx);
  });

  const refocus = useRef<ItemKey | null>(null);
  useLayoutEffect(() => {
    const key = refocus.current;
    if (key === null) return;
    refocus.current = null;
    scroller.current?.querySelector<HTMLElement>(`[data-key="${key}"] button`)?.focus();
  });

  const onScroll = () => {
    const box = scroller.current;
    if (!box) return;
    anchor.current = anchorAt(layout, geometry.logicalTop(box.scrollTop), rowPx);
    setTop(box.scrollTop);
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - rowPx;
    if (following !== atBottom) setFollowing(atBottom && live !== null && !store.closed);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (geometry.spacerPx === layout.count * rowPx) return;
    const box = scroller.current;
    if (!box) return;
    const page = Math.max(1, Math.floor(viewport / rowPx) - 1) * rowPx;
    const moves: Record<string, number> = {
      PageDown: page,
      PageUp: -page,
      ArrowDown: rowPx,
      ArrowUp: -rowPx,
    };
    let logical: number | null = null;
    if (event.key in moves) logical = logicalTop + (moves[event.key] as number);
    if (event.key === "Home") logical = 0;
    if (event.key === "End") logical = layout.count * rowPx;
    if (logical === null) return;
    event.preventDefault();
    box.scrollTop = geometry.physicalTop(
      Math.max(0, Math.min(logical, layout.count * rowPx - viewport)),
    );
  };

  const toggle = (step: number) => {
    touched.current.add(step);
    const holder = focused?.startsWith("r") ? layout.stepOf(Number(focused.slice(1))) : null;
    if (open.has(step) && holder === step) {
      refocus.current = `h${step}`;
      setFocused(`h${step}`);
    }
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(step)) next.add(step);
      return next;
    });
  };

  const drawn: number[] = [];
  for (let f = view.first; f < view.last; f++) drawn.push(f);
  const focusedFlat = focused === null ? null : flatOfKey(layout, focused);
  if (focusedFlat !== null && (focusedFlat < view.first || focusedFlat >= view.last))
    drawn.push(focusedFlat);
  const raw = jobRawPath(owner, repo, runId, job.id);
  const placed = (flat: number) => top + (flat * rowPx - logicalTop);
  const refusal = reader.refusal;

  return (
    <div className="log-viewer" data-rows-parsed={spans.parsed} data-rows-drawn={drawn.length}>
      <div className="row log-tools">
        {live !== null &&
          live.state !== "live" &&
          live.state !== "ended" &&
          live.state !== "connecting" && (
            <span className="muted">
              Live updates stopped
              {live.reason?.startsWith("log_viewers") ? " for today on this deployment" : ""}.{" "}
              <button type="button" onClick={() => void live.resume()}>
                Resume
              </button>
            </span>
          )}
        {!store.closed && (live === null || live.state !== "live") && (
          <button
            type="button"
            onClick={() => {
              void reader.more()?.then(bump);
              bump();
            }}
          >
            Load new rows
          </button>
        )}
        {!following && live?.state === "live" && (
          <button
            type="button"
            onClick={() => {
              setFollowing(true);
              const box = scroller.current;
              if (box) box.scrollTop = box.scrollHeight;
            }}
          >
            Jump to latest
          </button>
        )}
        <a href={raw}>Raw text (one page)</a>
      </div>
      {refusal && (
        <p className="error" role="alert">
          {logRefusalWords(refusal.status, refusal.code, refusal.retryAt)}{" "}
          {reader.retryAfterMs() === null && (
            <button
              type="button"
              onClick={() => {
                const read = reader.tryAgain();
                if (read) void read.then(bump);
                else bump();
                bump();
              }}
            >
              Try again
            </button>
          )}
        </p>
      )}
      {reader.moreWaiting && (
        <p className="muted" role="status">
          New rows load once the viewer may read again.
        </p>
      )}
      {lineNote && (
        <p className="muted" role="status">
          {lineNote}
        </p>
      )}
      <p className="visually-hidden" role="status">
        {announce}
      </p>
      <section
        className="log-scroller"
        ref={scroller}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        aria-label={`Log of ${job.name}: ${store.length} lines`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus, so the keyboard can scroll the log.
        tabIndex={0}
      >
        <div className="log-spacer" style={{ height: geometry.spacerPx }}>
          <span className="log-line log-probe" data-probe aria-hidden="true">
            0
          </span>
          {drawn.map((flat) => {
            const item = layout.at(flat);
            if (!item) return null;
            const key = keyOf(item);
            const style = { top: placed(flat), height: rowPx };
            const keep = {
              "data-key": key,
              onFocus: () => setFocused(key),
              onBlur: () => setFocused((f) => (f === key ? null : f)),
            };
            if (item.kind === "header") {
              const step = job.steps.find((s) => s.number === item.step);
              if (!step) return null;
              const isOpen = open.has(step.number);
              return (
                <div key={key} className="log-line log-step" style={style} {...keep}>
                  <button type="button" aria-expanded={isOpen} onClick={() => toggle(step.number)}>
                    <span aria-hidden="true">{isOpen ? "▾" : "▸"}</span> {step.name}
                  </button>{" "}
                  <RunState status={step.status} conclusion={step.conclusion} />
                </div>
              );
            }
            const notStored = store.notStored(item.row);
            return (
              <div
                key={key}
                className="log-line"
                id={notStored ? undefined : `L${item.row + 1}`}
                style={style}
                {...keep}
              >
                <Row
                  i={item.row}
                  row={store.row(item.row)}
                  spans={(c) => spans.get(item.row, c)}
                  notStored={notStored}
                  raw={raw}
                />
              </div>
            );
          })}
        </div>
      </section>
      {store.length === 0 && store.closed && <p className="muted">No lines.</p>}
    </div>
  );
}
