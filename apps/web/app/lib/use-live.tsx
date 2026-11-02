import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useNavigation, useRevalidator } from "react-router";
import { LiveClient, type LiveStream, type LiveTicket } from "./live.js";
import { LiveHub, type LiveStatus } from "./live-hub.js";
import { readPause, writePause } from "./live-pause.js";

const OFF_KEY = "fyrden.live.off";
/** How long asking for a ticket may take. */
const TICKET_MS = 10_000;

const HubContext = createContext<LiveHub | null>(null);

/**
 * The tab's live hints for `viewer`, kept across its pages (the root
 * layout holds it): nothing for a signed-out page, and a new one when
 * another viewer signs in.
 */
export function LiveHints({ viewer, children }: { viewer: string | null; children: ReactNode }) {
  const revalidator = useRevalidator();
  const navigation = useNavigation();
  const latest = useRef({ revalidator, idle: navigation.state === "idle" });
  latest.current = { revalidator, idle: navigation.state === "idle" };
  const [hub, setHub] = useState<LiveHub | null>(null);

  useEffect(() => {
    if (!viewer || typeof WebSocket === "undefined") return;
    const made = new LiveHub({
      client: ({ changed, stopped, paused, temporary }) =>
        new LiveClient({
          ticket: async (): Promise<LiveTicket> => {
            const res = await fetch("/notifications/live-ticket", {
              method: "POST",
              body: new URLSearchParams({ viewer }),
              credentials: "same-origin",
              signal: AbortSignal.timeout(TICKET_MS),
            });
            return res.ok ? ((await res.json()) as LiveTicket) : { kind: "retry" };
          },
          open: (url, events) => {
            const ws = new WebSocket(url);
            ws.onopen = () => events.open();
            ws.onmessage = (event) => {
              if (typeof event.data === "string") events.message(event.data);
            };
            ws.onclose = (event) => events.close(event.code);
            return ws;
          },
          changed,
          stopped,
          paused,
          temporary,
          now: () => Date.now(),
          random: () => Math.random(),
          setTimer: (fn, ms) => setTimeout(fn, ms),
          clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        }),
      hidden: () => document.hidden,
      idle: () => latest.current.idle,
      revalidate: () => latest.current.revalidator.revalidate(),
      offSince: () => {
        try {
          return Number(sessionStorage.getItem(OFF_KEY) ?? 0);
        } catch {
          return 0;
        }
      },
      markOff: (at) => {
        try {
          sessionStorage.setItem(OFF_KEY, String(at));
        } catch {
          // Asked again on the next page that listens.
        }
      },
      pausedUntil: () => readPause(viewer, Date.now()),
      markPaused: (pause) => writePause(viewer, pause),
      now: () => Date.now(),
      random: () => Math.random(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    const visibility = () => made.visibility();
    document.addEventListener("visibilitychange", visibility);
    setHub(made);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      made.dispose();
      setHub(null);
    };
  }, [viewer]);

  // A read held for a navigation goes once it finishes.
  useEffect(() => {
    if (navigation.state === "idle") hub?.settled();
  }, [hub, navigation.state]);

  return <HubContext.Provider value={hub}>{children}</HubContext.Provider>;
}

const LIVE: LiveStatus = { kind: "live" };

/**
 * Reads the page again when a stream it shows (`wants`) changed, and once
 * on every (re)connect and renewal of the tab's socket. Unsent text is
 * kept across it. Returns what to tell the viewer (`LiveNote` shows it).
 */
export function useLiveHints(wants: (stream: LiveStream) => boolean): LiveStatus {
  const hub = useContext(HubContext);
  const current = useRef(wants);
  current.current = wants;
  useEffect(() => hub?.listen(current), [hub]);
  const watch = useCallback((changed: () => void) => hub?.watch(changed) ?? (() => {}), [hub]);
  return useSyncExternalStore(
    watch,
    () => hub?.status() ?? LIVE,
    () => LIVE,
  );
}

/** Says why live updates are not coming, while they are not: nothing otherwise. */
export function LiveNote({ status }: { status: LiveStatus }) {
  if (status.kind === "paused") {
    const until = new Date(status.retryAt);
    return (
      <p className="muted" role="status">
        Live updates are paused until{" "}
        <time dateTime={until.toISOString()}>
          {until.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
        </time>
        . You can still refresh this page.
      </p>
    );
  }
  if (status.kind === "temporary")
    return (
      <p className="muted" role="status">
        Live updates are temporarily unavailable. Retrying.
      </p>
    );
  return null;
}
