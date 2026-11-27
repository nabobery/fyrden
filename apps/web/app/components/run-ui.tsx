import { useRouteLoaderData } from "react-router";
import type { SessionUser } from "../lib/api.server.js";
import { when, who } from "../lib/pulls.js";
import { runWords } from "../lib/runs.js";

export function RunState({ status, conclusion }: { status: string; conclusion: string | null }) {
  const state = runWords(status, conclusion);
  return (
    <span className={`badge run-${state.tone}`}>
      <span aria-hidden="true">{state.mark}</span> {state.words}
    </span>
  );
}

export function useViewer(): string | null {
  const data = useRouteLoaderData("root") as { user: SessionUser | null } | undefined;
  return data?.user?.id ?? null;
}

export function Who({ id }: { id: string }) {
  return <>{who(id, useViewer())}</>;
}

export function At({ ms }: { ms: number }) {
  return <time dateTime={new Date(ms).toISOString()}>{when(ms)}</time>;
}

export function duration(from: number | null, to: number | null): string | null {
  if (from === null || to === null || to < from) return null;
  const s = Math.round((to - from) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
