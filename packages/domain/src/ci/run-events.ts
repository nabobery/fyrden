import { type RunPhase, runStateSeq } from "./run-summary.js";

export type RunAction = "requested" | "in_progress" | "completed";

export interface RunMove {
  readonly attempt: number;
  readonly action: RunAction;
}

/**
 * What a run's report tells after `told` (a `runStateSeq`, 0 for nothing):
 * the ends of `earlier` attempts not told yet, then the reported attempt's
 * state. `told` in the answer never goes back.
 */
export function runMoves(
  told: number,
  report: { readonly attempt: number; readonly phase: RunPhase },
  earlier: readonly number[],
): { readonly told: number; readonly moves: readonly RunMove[] } {
  const moves: RunMove[] = [];
  let at = told;
  const tell = (attempt: number, phase: RunPhase) => {
    const seq = runStateSeq(attempt, phase);
    if (seq <= at) return;
    if (at === 0) moves.push({ attempt, action: "requested" });
    if (phase === "in_progress" || phase === "completed") moves.push({ attempt, action: phase });
    at = seq;
  };
  for (const attempt of earlier.toSorted((a, b) => a - b)) tell(attempt, "completed");
  tell(report.attempt, report.phase);
  return { told: at, moves };
}
