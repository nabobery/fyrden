import { PathIndex } from "./path-search.js";

/** The most `repos.paths.list` returns in a page. */
export const PATHS_PER_PAGE = 10_000;

/**
 * The requests a list may make before someone asks for more: about a tenth of a minute's
 * read limit (600), and at most 51,200 R2 reads. A tree of endless empty directories
 * reaches no cap and would go on otherwise. It doesn't promise a list fits: a page also
 * ends at a slice's end or at 1 MiB of JSON, where a control character takes six bytes,
 * so names of them at both caps (200,000 paths, 16 MiB) take about 97 pages, and more
 * where reads cut slices short. Those lists take Continue loading.
 */
export const PATH_REQUEST_BUDGET = 64;

/** How many times a busy answer is asked again before the list is called unavailable. */
const BUSY_TRIES = 3;

/** How long to wait on a 409 `busy`, which comes with no time of its own. */
const BUSY_WAIT_MS = 500;

export interface PathPage {
  readonly state: "complete" | "incomplete" | "unavailable";
  readonly reason: string | null;
  readonly paths: readonly string[];
  readonly unlisted_names: number;
  readonly next_cursor: string | null;
  readonly retry_after_ms: number | null;
}

export interface PathQuery {
  readonly ref?: string;
  readonly cursor?: string;
  readonly per_page: number;
}

/** A page's answer, or the status and `code` of a refusal. Neither, for an answer unread. */
export interface PathReply {
  readonly status: number;
  readonly page?: PathPage;
  readonly code?: string;
}

export type ListStatus =
  | "loading"
  | "waiting"
  /** The dialog closed: nothing is asked until it opens again. */
  | "paused"
  /** The budget is spent: nothing is asked until someone says to go on. */
  | "partial"
  | "complete"
  | "truncated"
  | "unavailable";

/** Why the list stopped: the API's reason, or one of the refusals a page can get instead. */
export type ListReason = string | "not_found" | "empty" | "failed";

export interface PathLoaderOptions {
  readonly ref: string;
  readonly signal: AbortSignal;
  readonly fetchPage: (query: PathQuery, signal: AbortSignal) => Promise<PathReply>;
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly onChange: () => void;
}

/** Loads a list's pages one after another, in memory, for as long as the page lives. */
export class PathLoader {
  readonly index = new PathIndex();
  status: ListStatus = "loading";
  reason: ListReason | null = null;
  unlisted = 0;
  #cursor: string | null = null;
  #startedOver = false;
  #spent = 0;
  /** Whether anyone is waiting for the list: a run that was dropped goes on if so. */
  #wanted = false;
  #running: Promise<void> | null = null;
  #stopping: AbortController | null = null;

  constructor(private readonly options: PathLoaderOptions) {
    options.signal.addEventListener("abort", () => this.#stopping?.abort(), { once: true });
  }

  /** Runs until the list ends or can't be had; a call while it runs joins that run. */
  run(): Promise<void> {
    this.#wanted = true;
    this.#running ??= this.#drive().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /** Someone asked: goes on from where the list stopped, with a whole budget. */
  retry(): Promise<void> {
    if (this.#running) return this.#running;
    this.#spent = 0;
    this.status = "loading";
    this.reason = null;
    this.options.onChange();
    return this.run();
  }

  /** Drops the request under way and asks for no more. */
  pause(): void {
    this.#wanted = false;
    this.#stopping?.abort();
  }

  /**
   * Goes on after `pause`, with what is left of the budget, even if what `pause` dropped
   * hasn't ended yet.
   */
  resume(): Promise<void> {
    this.#wanted = true;
    if (this.#running) return this.#running;
    if (this.status !== "paused") return Promise.resolve();
    this.status = "loading";
    this.options.onChange();
    return this.run();
  }

  async #drive(): Promise<void> {
    for (;;) {
      await this.#load();
      if (this.status !== "paused" || !this.#wanted) return;
      this.status = "loading";
      this.options.onChange();
    }
  }

  async #load(): Promise<void> {
    const { signal: gone, onChange } = this.options;
    if (gone.aborted) return;
    const stopping = new AbortController();
    this.#stopping = stopping;
    const { signal } = stopping;
    const stopped = () => {
      if (!gone.aborted) this.#stop("paused", null);
    };
    let busy = 0;
    for (;;) {
      if (signal.aborted) return stopped();
      if (this.#spent >= PATH_REQUEST_BUDGET) return this.#stop("partial", null);
      this.#spent++;
      const reply = await this.#fetch(signal);
      if (signal.aborted) return stopped();
      const { page } = reply;
      const wait = page?.reason === "busy" ? (page.retry_after_ms ?? BUSY_WAIT_MS) : BUSY_WAIT_MS;
      if (page?.reason === "busy" || reply.code === "busy") {
        if (busy++ >= BUSY_TRIES) return this.#stop("unavailable", "busy");
        this.status = "waiting";
        onChange();
        await this.options.wait(wait, signal);
        if (signal.aborted) return stopped();
        this.status = "loading";
        continue;
      }
      if (!page) {
        // A cursor whose commit is gone (a restore): the whole list again, once.
        if (reply.code === "ref_not_found" && this.#cursor !== null && !this.#startedOver) {
          this.#startedOver = true;
          this.#cursor = null;
          this.index.clear();
          this.unlisted = 0;
          onChange();
          continue;
        }
        return this.#stop("unavailable", refusal(reply, this.#cursor));
      }
      if (page.state === "unavailable")
        return this.#stop("unavailable", page.reason ?? "unreadable");
      busy = 0;
      this.index.add(page.paths);
      this.unlisted += page.unlisted_names;
      if (page.next_cursor !== null) {
        this.#cursor = page.next_cursor;
        onChange();
        continue;
      }
      if (page.state === "complete") return this.#stop("complete", null);
      return this.#stop("truncated", page.reason);
    }
  }

  async #fetch(signal: AbortSignal): Promise<PathReply> {
    const query: PathQuery =
      this.#cursor === null
        ? { ref: this.options.ref, per_page: PATHS_PER_PAGE }
        : { cursor: this.#cursor, per_page: PATHS_PER_PAGE };
    try {
      return await this.options.fetchPage(query, signal);
    } catch {
      return { status: 0 };
    }
  }

  #stop(status: ListStatus, reason: ListReason | null): void {
    this.status = status;
    this.reason = reason;
    this.options.onChange();
  }
}

function refusal(reply: PathReply, cursor: string | null): ListReason {
  if (reply.code === "ref_not_found" && cursor === null) return "not_found";
  if (reply.code === "repo_empty") return "empty";
  return "failed";
}

/** Waits `ms`, or until `signal` says to stop. */
export function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal.aborted) return done();
    const timer = setTimeout(done, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });
}

/**
 * Whether a key belongs to an input method's composition, which it may be ending or
 * choosing a candidate in. Safari's Enter that ends one no longer says it is composing,
 * but keeps the 229 every browser gives such a key.
 */
export function isComposingKey(event: {
  readonly isComposing: boolean;
  readonly keyCode: number;
}): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** Reads a route's answer: a page, or the `code` of a refusal; neither for one it can't read. */
export async function readPathReply(response: Response): Promise<PathReply> {
  const { status } = response;
  try {
    const body = (await response.json()) as PathPage & { code?: string };
    if (response.ok) return Array.isArray(body.paths) ? { status, page: body } : { status };
    return typeof body.code === "string" ? { status, code: body.code } : { status };
  } catch {
    return { status };
  }
}

const number = (n: number) => n.toLocaleString("en");

/** What stopped a truncated list, after "Showing the first N files". */
const STOPPED: Readonly<Record<string, string>> = {
  too_many_paths: "; this repository has more.",
  too_many_bytes: ": this repository's paths are too long to list them all.",
  tree_too_large: ": a folder here is too large to read.",
  too_deep: ": a folder here is nested too deeply to read.",
  path_too_long: ": a path here is too long to read.",
  malformed_tree: ": a folder in this commit is damaged, its entries out of order or repeated.",
  too_much_work: ": a folder here takes too much work to read.",
};

/** What is said of a list that stopped for good, or for now. */
const UNAVAILABLE: Readonly<Record<string, string>> = {
  busy: "The file list isn't available right now: the repository is busy.",
  unreadable: "The file list isn't available right now: some files can't be read at the moment.",
  failed: "The file list isn't available right now.",
};

export interface ListNotice {
  readonly text: string;
  /** The list can go on from here if asked. */
  readonly retry: boolean;
  /** The folders may show what the list doesn't. */
  readonly browse: boolean;
  /** The list is fine, only not whole yet: going on is continuing, not retrying. */
  readonly continues?: true;
}

/** What a person must know about the list beyond its count; null when nothing. */
export function listNotice(
  list: Pick<PathLoader, "status" | "reason" | "unlisted"> & { index: { size: number } },
): ListNotice | null {
  const { status, reason, unlisted } = list;
  if (status === "waiting")
    return { text: "The repository is busy; trying again…", retry: false, browse: false };
  const left =
    unlisted === 0
      ? ""
      : unlisted === 1
        ? "1 file has a name that can't be shown."
        : `${number(unlisted)} files have names that can't be shown.`;
  if (status === "unavailable") {
    if (reason === "not_found")
      return { text: "This branch, tag or commit wasn't found.", retry: false, browse: false };
    if (reason === "empty")
      return { text: "This repository has no files yet.", retry: false, browse: false };
    const said = UNAVAILABLE[reason ?? "failed"] ?? (UNAVAILABLE.failed as string);
    return { text: left ? `${said} ${left}` : said, retry: true, browse: true };
  }
  if (status === "partial") {
    const said = "This list isn't whole yet: this tree takes many requests to read.";
    return { text: left ? `${said} ${left}` : said, retry: true, browse: true, continues: true };
  }
  if (status === "truncated") {
    const size = list.index.size;
    const start = size === 0 ? "No files can be shown" : `Showing the first ${number(size)} files`;
    const why = STOPPED[reason ?? ""] ?? ": the rest of this list can't be read.";
    const said = `${start}${why}`;
    return { text: left ? `${said} ${left}` : said, retry: false, browse: true };
  }
  return left ? { text: left, retry: false, browse: false } : null;
}

export interface CountInput {
  readonly status: ListStatus;
  readonly query: string;
  readonly shown: number;
  /** All that match, or the list's size with nothing typed. */
  readonly total: number;
}

/** The two halves of the count line. */
export interface CountParts {
  /** For the live region, so it mustn't change with every page of a list. */
  readonly live: string;
  /** Shown beside it, and said by no one until someone reads it. */
  readonly quiet: string;
}

/**
 * The line that says how much of the list or its matches is shown. While the list grows the
 * live region says "Loading…" once and the outcome once: a list can take 64 pages and more,
 * and a screen reader would read out a count for each.
 */
export function countParts(input: CountInput): CountParts {
  const { status, query, shown, total } = input;
  if (status !== "loading" && status !== "waiting") return { live: countLine(input), quiet: "" };
  return { live: "Loading…", quiet: progress(query, shown, total) };
}

function progress(query: string, shown: number, total: number): string {
  const first = `showing the first ${number(shown)} of ${number(total)}`;
  if (query.trim() === "") {
    if (total === 0) return "";
    if (shown < total) return `${first} files so far`;
    return total === 1 ? "1 file so far" : `${number(total)} files so far`;
  }
  if (total === 0) return "no files match so far";
  if (shown < total) return `${first} matches so far`;
  return total === 1 ? "1 file matches so far" : `${number(total)} files match so far`;
}

function countLine({ status, query, shown, total }: CountInput): string {
  const unfinished = status === "paused" || status === "partial";
  const soFar = unfinished ? " so far" : "";
  if (query.trim() === "") {
    if (status === "unavailable" && total === 0) return "";
    if (total === 0) return `No files${soFar}`;
    if (shown < total)
      return `Showing the first ${number(shown)} of ${number(total)} files${soFar || ". Type to narrow them."}`;
    return total === 1 ? `1 file${soFar}` : `${number(total)} files${soFar}`;
  }
  if (total === 0) return `No files match${soFar}`;
  if (shown < total) {
    const first = `Showing the first ${number(shown)} of ${number(total)} matches`;
    return unfinished ? `${first} so far` : `${first}. Type more to narrow them.`;
  }
  return total === 1 ? `1 file matches${soFar}` : `${number(total)} files match${soFar}`;
}
