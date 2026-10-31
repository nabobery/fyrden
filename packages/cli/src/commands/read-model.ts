import { createHash, type Hash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiError, type ApiTarget, apiTarget, callApi } from "../api.ts";

/*
 * A coherent export of the read model through the deployment's API, as an
 * instance administrator: its writers paused (waiting for older leases to
 * end), every table written in key order a page at a time under the
 * pause's generation, a manifest with each file's rows and digest, and the
 * writers resumed (unless kept paused, for a restore). Available once the
 * deployment has a restore floor (`fyrden deploy` records it). And a
 * handshake of the read model's restore token.
 */

export const READ_MODEL_USAGE = `fyrden read-model export --url <API URL> --out <directory> [--keep-paused]
       fyrden read-model handshake --url <API URL>
       fyrden read-model recover --url <API URL> --id <recovery id>
                                 [--restore-bookmark <bookmark> --undo-bookmark <bookmark>]`;

export interface RecoverArgs extends ApiTarget {
  readonly command: "recover";
  readonly id: string;
  /** The restore its operator made: the bookmark restored to, and the one that undoes it. */
  readonly restore?: { readonly bookmark: string; readonly undoBookmark: string };
}

export interface HandshakeArgs extends ApiTarget {
  readonly command: "handshake";
}

export interface ExportArgs extends ApiTarget {
  readonly command: "export";
  /** A directory that does not exist yet: the export's files. */
  readonly out: string;
  /** Writers left paused once the export is written. */
  readonly keepPaused: boolean;
}

/** `read-model export`'s arguments, or why they are not; the token comes from `FYRDEN_TOKEN`. */
export function parseReadModelArgs(
  args: readonly string[],
  env: Record<string, string | undefined>,
): ExportArgs | HandshakeArgs | RecoverArgs | { error: string } {
  const [sub, ...rest] = args;
  if (sub === "recover") {
    const given = new Map<string, string | undefined>();
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] ?? "";
      if (!["--url", "--id", "--restore-bookmark", "--undo-bookmark"].includes(arg))
        return { error: `unknown argument ${arg}\nusage: ${READ_MODEL_USAGE}` };
      given.set(arg, rest[++i]);
    }
    const id = given.get("--id");
    if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
      return { error: `--id must be 1 to 64 letters, digits, _ or -\nusage: ${READ_MODEL_USAGE}` };
    const [bookmark, undoBookmark] = [
      given.get("--restore-bookmark"),
      given.get("--undo-bookmark"),
    ];
    if (!bookmark !== !undoBookmark)
      return {
        error: `--restore-bookmark and --undo-bookmark go together\nusage: ${READ_MODEL_USAGE}`,
      };
    const target = apiTarget(given.get("--url"), env, READ_MODEL_USAGE);
    if ("error" in target) return target;
    return {
      command: "recover",
      ...target,
      id,
      ...(bookmark && undoBookmark && { restore: { bookmark, undoBookmark } }),
    };
  }
  if (sub === "handshake") {
    let url: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--url") url = rest[++i];
      else return { error: `unknown argument ${rest[i]}\nusage: ${READ_MODEL_USAGE}` };
    }
    const target = apiTarget(url, env, READ_MODEL_USAGE);
    if ("error" in target) return target;
    return { command: "handshake", ...target };
  }
  if (sub !== "export") return { error: `usage: ${READ_MODEL_USAGE}` };
  let url: string | undefined;
  let out: string | undefined;
  let keepPaused = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--keep-paused") keepPaused = true;
    else if (arg === "--url") url = rest[++i];
    else if (arg === "--out") out = rest[++i];
    else return { error: `unknown argument ${arg}\nusage: ${READ_MODEL_USAGE}` };
  }
  if (!out) return { error: `--out must name a directory\nusage: ${READ_MODEL_USAGE}` };
  const target = apiTarget(url, env, READ_MODEL_USAGE);
  if ("error" in target) return target;
  return { command: "export", ...target, out, keepPaused };
}

/** What a command that drives the API step by step needs. */
interface Driving {
  readonly args: ApiTarget;
  readonly fetch: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

export interface ExportDeps extends Driving {
  readonly args: ExportArgs;
  readonly fetch: typeof fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

interface Progress {
  readonly phase: string;
  readonly generation: number;
  readonly live: number;
  readonly until: number | null;
}

interface Manifest {
  readonly generation: number;
  readonly tables: readonly { readonly table: string; readonly columns: readonly string[] }[];
}

interface Page {
  readonly table: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly next_cursor: string | null;
}

/** How long a pause waits for older leases at most (a lease lasts 15 minutes). */
const PAUSE_WAIT_MS = 16 * 60 * 1000;
/** A look at a pause's progress at least this often. */
const PAUSE_POLL_MS = 15_000;
/** A rate-limited page is asked again after this, this many times at most. */
const RATE_LIMIT_WAIT_MS = 30_000;
const RATE_LIMIT_TRIES = 10;

/** Exports the read model into `args.out`; the pause's generation and the rows written. */
export async function exportReadModel(
  deps: ExportDeps,
): Promise<{ generation: number; rows: number }> {
  const { args, log } = deps;
  // Refused if it exists: an export never mixes with another's files.
  await mkdir(args.out).catch((error: unknown) => {
    throw new Error(`${args.out} exists already: name a new directory (${String(error)})`);
  });
  // The pause's generation once a step names one: what the cleanup resumes (that pause only).
  const pause: { generation?: number } = {};
  try {
    const generation = await paused(deps, pause);
    log(`paused the read model's writers at generation ${generation}`);
    const manifest = await callApi<Manifest & Record<string, unknown>>(
      deps.fetch,
      args,
      "GET",
      `/admin/read-model/export?generation=${generation}`,
    );
    const files = new Map<string, { file: string; rows: number; hash: Hash }>();
    for (const { table } of manifest.tables) {
      const file = `${table}.jsonl`;
      await writeFile(join(args.out, file), "");
      files.set(table, { file, rows: 0, hash: createHash("sha256") });
    }
    let cursor: string | null = null;
    let rows = 0;
    do {
      const query: string = `generation=${generation}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page: Page = await limited(deps, () =>
        callApi<Page>(deps.fetch, args, "GET", `/admin/read-model/export/pages?${query}`),
      );
      const file = files.get(page.table);
      if (!file) throw new Error(`the export gave a page of ${page.table}, not in its manifest`);
      const text = page.rows.map((row) => `${JSON.stringify(row)}\n`).join("");
      await appendFile(join(args.out, file.file), text);
      file.hash.update(text);
      file.rows += page.rows.length;
      rows += page.rows.length;
      cursor = page.next_cursor;
    } while (cursor);
    await writeFile(
      join(args.out, "manifest.json"),
      `${JSON.stringify(
        {
          ...manifest,
          exported_at: new Date(deps.now()).toISOString(),
          files: Object.fromEntries(
            [...files].map(([table, f]) => [
              table,
              { file: f.file, rows: f.rows, sha256: f.hash.digest("hex") },
            ]),
          ),
        },
        null,
        2,
      )}\n`,
    );
    log(`exported ${rows} row(s) of ${files.size} table(s) to ${args.out}`);
    return { generation, rows };
  } finally {
    await resumed(deps, pause.generation);
  }
}

/**
 * Resumes the pause at `generation` (unless kept paused); a newer pause, or
 * one this run never started, is left as it is.
 */
async function resumed(deps: ExportDeps, generation: number | undefined): Promise<void> {
  const { args, log } = deps;
  if (generation === undefined) return;
  if (args.keepPaused) {
    log(`the read model's writers stay paused at generation ${generation}: resume them when done`);
    return;
  }
  try {
    const barrier = await callApi<{ phase: string; generation: number }>(
      deps.fetch,
      args,
      "POST",
      "/admin/read-model/resume",
      { generation },
    );
    log(
      barrier.phase === "running"
        ? "resumed the read model's writers"
        : `left the read model's writers ${barrier.phase} at generation ${barrier.generation} (another step's)`,
    );
  } catch (error) {
    // What failed before stays the error; this one is said.
    log(`WARN the read model's writers could not be resumed (${String(error)}): resume them`);
  }
}

/**
 * Pauses the writers, step by step until no older lease is live; the
 * generation, kept in `pause` from the first step that names it.
 */
async function paused(deps: Driving, pause: { generation?: number }): Promise<number> {
  const deadline = deps.now() + PAUSE_WAIT_MS;
  for (;;) {
    const progress = await limited(deps, () =>
      callApi<Progress>(deps.fetch, deps.args, "POST", "/admin/read-model/pause"),
    );
    if (progress.phase === "paused" || progress.phase === "pausing")
      pause.generation = progress.generation;
    if (progress.phase === "paused") return progress.generation;
    if (progress.phase !== "pausing")
      throw new Error(
        `the read model's writers are ${progress.phase} (resumed meanwhile?): run again`,
      );
    if (deps.now() >= deadline)
      throw new Error(`${progress.live} older lease(s) still live past the pause's wait`);
    deps.log(`waiting for ${progress.live} older lease(s) to end`);
    const until = progress.until ?? deps.now();
    await deps.sleep(Math.min(Math.max(until - deps.now(), 1_000), PAUSE_POLL_MS));
  }
}

/** `call`, asked again after a wait while the API rate limits it. */
async function limited<T>(deps: Driving, call: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 429 || tries >= RATE_LIMIT_TRIES)
        throw error;
      await deps.sleep(RATE_LIMIT_WAIT_MS);
    }
  }
}

/**
 * `read-model handshake`: replaces the read model's restore token (the first,
 * after `fyrden deploy` recorded the restore floor, starts it). Refused when
 * the read model holds a token the deployment does not know.
 */
export async function handshakeReadModel(deps: {
  readonly args: HandshakeArgs;
  readonly fetch: typeof fetch;
  readonly log: (line: string) => void;
}): Promise<void> {
  await callApi(deps.fetch, deps.args, "POST", "/admin/read-model/handshake");
  deps.log("ok   read model restore token matched");
}

interface Recovery {
  readonly recovery_id: string;
  readonly generation: number;
  readonly stage: string;
}

/** The deployment's Wrangler configuration, from the repository's root (what `fyrden deploy` uses). */
const DEPLOY_CONFIG = "apps/api/wrangler.deploy.jsonc";

/** Steps a recovery takes at most a run (a step is bounded; a large read model takes many). */
const RECOVERY_STEPS = 100_000;

/**
 * `read-model recover`: drives the read model's recovery `args.id` from
 * where the deployment says it stands. Started (the writers paused first)
 * when none is under way; stepped until it awaits its restore, where it
 * stops and says how to restore, unless the restore is given (`--restore-
 * bookmark`, `--undo-bookmark`: it reports it and steps on until complete).
 * It never restores the database itself, nor retries a restore. Run again
 * after an interruption: it goes on from the deployment's state.
 */
export async function recoverReadModel(
  deps: Driving & { readonly args: RecoverArgs },
): Promise<Recovery> {
  const { args, log } = deps;
  const call = <T>(method: "GET" | "POST", path: string, body?: unknown) =>
    limited(deps, () => callApi<T>(deps.fetch, args, method, path, body));
  let state = await call<Recovery>("GET", "/admin/read-model/recovery").catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });
  if (state && state.recovery_id !== args.id && state.stage !== "complete")
    throw new Error(
      `the read model's recovery ${state.recovery_id} is under way (${state.stage}): finish it first`,
    );
  if (!state || state.recovery_id !== args.id) {
    const generation = await paused(deps, {});
    log(`paused the read model's writers at generation ${generation}`);
    state = await call<Recovery>("POST", "/admin/read-model/recovery", { recovery_id: args.id });
    log(`started recovery ${args.id} at generation ${state.generation}`);
  } else if (state.stage === "preserving")
    // Its start asked again: one interrupted is finished (and one finished changes nothing).
    state = await call<Recovery>("POST", "/admin/read-model/recovery", { recovery_id: args.id });
  let reported = false;
  for (let n = 0; n < RECOVERY_STEPS; n++) {
    if (state.stage === "complete") {
      log(`recovery ${args.id} complete: the read model's writers are running again`);
      return state;
    }
    if (state.stage === "awaiting_restore" && !reported) {
      if (!args.restore) {
        log(`recovery ${args.id} awaits its restore. Its operational rows are preserved; now:`);
        log("  1. restore the org read model to the bookmark you chose (after the restore floor):");
        log(
          `       wrangler d1 time-travel restore fyrden-org --bookmark=<bookmark> --config ${DEPLOY_CONFIG}`,
        );
        log("     and keep the bookmark it says undoes it;");
        log("  2. apply the migrations it lacks:");
        log(`       wrangler d1 migrations apply fyrden-org --remote --config ${DEPLOY_CONFIG}`);
        log(
          `  3. run this again with --restore-bookmark <bookmark> --undo-bookmark <undo bookmark>.`,
        );
        return state;
      }
      state = await call<Recovery>("POST", "/admin/read-model/recovery/step", {
        recovery_id: args.id,
        restore: { bookmark: args.restore.bookmark, undo_bookmark: args.restore.undoBookmark },
      });
      reported = true;
      log(`reported the restore to ${args.restore.bookmark}`);
      continue;
    }
    const before = state.stage;
    state = await call<Recovery>("POST", "/admin/read-model/recovery/step", {
      recovery_id: args.id,
    });
    if (state.stage !== before) log(`recovery ${args.id}: ${before} done, ${state.stage}`);
  }
  throw new Error(`recovery ${args.id} took more than ${RECOVERY_STEPS} steps: run again`);
}
