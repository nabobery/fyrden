// Reading a job's log by the page: from a row, the last rows or a cursor,
// as rows and as text, from the stored chunks only, within a page's bounds,
// while the job runs and after; what is refused, and what a Free deployment's
// day allows.
import { env } from "cloudflare:workers";
import { LOG_ROW_TOO_LARGE, type StoredLogLine } from "@fyrden/domain/ci";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { CI_LOG_READS_DAILY, ciVariableOverrides } from "../src/ci/budget.js";
import { chargeLogReads } from "../src/ci/log-reads.js";
import {
  LOG_PAGE_POLICY,
  type LogPageQuery,
  type LogPosition,
  logPageHooks,
} from "../src/do/run/log-pages.js";
import { LOG_LATE_MS } from "../src/do/run/logs.js";
import { api, json, user } from "./helpers/api.js";
import { fetchTask, orgRepo, registerRunner } from "./helpers/runners.js";
import { inRun, job, jobNamed, started, workflow } from "./helpers/runs.js";

const KIB = 1024;

afterEach(() => {
  for (const key of Object.keys(logPageHooks))
    delete logPageHooks[key as keyof typeof logPageHooks];
  for (const key of Object.keys(ciVariableOverrides))
    delete ciVariableOverrides[key as keyof typeof ciVariableOverrides];
});

type Row = StoredLogLine & { o?: number; end?: boolean };
interface Page {
  rows: Row[];
  state: string;
  end: number;
  next_cursor: string | null;
  code?: string;
  retry_at?: number;
}

const row = (i: number, c: string, t: number | null = null): StoredLogLine => ({ i, t, c });

async function running(task = true) {
  const f = await orgRepo();
  const runId = await started(f, workflow(job("a")));
  if (task) {
    const runner = await registerRunner(f.org.login, f.owner);
    if (!(await fetchTask(runner, 0)).task) throw new Error("no task");
  }
  const { jobId } = await jobNamed(runId, "a");
  return { f, runId, jobId, path: `${f.path}/actions/runs/${runId}/jobs/${jobId}/logs` };
}
type Job = Awaited<ReturnType<typeof running>>;

async function stored(
  t: Job,
  chunks: readonly (readonly StoredLogLine[])[],
  log: { closed?: "complete" | "incomplete" } = {},
) {
  const puts = chunks.map((lines, k) => ({
    key: `runs/${t.runId}/pages/${k}.ndjson`,
    bytes: new TextEncoder().encode(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`),
    start: lines[0]?.i ?? 0,
    end: (lines.at(-1)?.i ?? -1) + 1,
  }));
  for (const put of puts) await env.CI.put(put.key, put.bytes);
  await inRun(t.runId, (run) => {
    run.engine.exec(
      `INSERT INTO ci_logs (task, ack_index, state, finalized, updated_at) VALUES (1, ?1, ?2, ?3, 0)
       ON CONFLICT (task) DO UPDATE SET ack_index = ?1, state = ?2, finalized = ?3`,
      puts.at(-1)?.end ?? 0,
      log.closed ?? "streaming",
      log.closed ? 1 : 0,
    );
    for (const { start, end, bytes, key } of puts)
      run.engine.exec(
        "INSERT OR REPLACE INTO ci_log_chunks (task, start_index, end_index, bytes, r2_key, created_at) VALUES (1, ?, ?, ?, ?, 0)",
        start,
        end,
        bytes.length,
        key,
      );
  });
}

const read = (t: Job, query = "", token = t.f.owner.token) =>
  json<Page>(api("GET", `${t.path}/rows${query}`, token));

async function page(t: Job, query = ""): Promise<Page> {
  const answer = await read(t, query);
  expect(answer.status, JSON.stringify(answer.body).slice(0, 300)).toBe(200);
  return answer.body;
}

async function pages(t: Job, query = ""): Promise<Page[]> {
  const found: Page[] = [];
  let cursor: string | null = null;
  do {
    const q: string =
      cursor === null ? query : `${query || "?"}&cursor=${cursor}`.replace("?&", "?");
    const next: Page = await page(t, q);
    if (next.rows.length === 0) break;
    found.push(next);
    cursor = next.next_cursor;
  } while (cursor !== null && found.length < 500);
  return found;
}

function joined(rows: readonly Row[]): StoredLogLine[] {
  const lines: StoredLogLine[] = [];
  let open = false;
  for (const { o, end, ...line } of rows) {
    if (o === undefined || o === 0) {
      expect(open).toBe(false);
      lines.push({ ...line });
    } else {
      const last = lines.at(-1) as { i: number; c: string };
      expect([open, last.i, last.c.length]).toEqual([true, line.i, o]);
      last.c += (line as { c: string }).c;
    }
    open = o !== undefined && !end;
  }
  expect(open).toBe(false);
  return lines;
}

const rowsSize = (rows: readonly Row[]) => new TextEncoder().encode(JSON.stringify(rows)).length;

describe("a page of a job's log", () => {
  it("starts at the first row, at a row, at the last rows and where a page ended", async () => {
    const t = await running();
    const lines = Array.from({ length: 40 }, (_, i) => row(i, `line ${i}`, 1_700_000_000_000 + i));
    await stored(t, [lines.slice(0, 15), lines.slice(15, 16), lines.slice(16)], {
      closed: "complete",
    });
    expect(await page(t)).toEqual({ rows: lines, state: "complete", end: 40, next_cursor: null });
    expect((await page(t, "?from=15")).rows).toEqual(lines.slice(15));
    expect((await page(t, "?from=39")).rows).toEqual(lines.slice(39));
    expect((await page(t, "?tail=3")).rows).toEqual(lines.slice(37));
    expect((await page(t, "?tail=25")).rows).toEqual(lines.slice(15));
    expect((await page(t, "?tail=10000")).rows).toEqual(lines);
    const past = await page(t, "?from=400");
    expect(past).toEqual({ rows: [], state: "complete", end: 40, next_cursor: null });
    const all = await pages(t, "?max_bytes=1024");
    expect(all.length).toBeGreaterThan(1);
    expect(all.flatMap((p) => p.rows)).toEqual(lines);
    for (const p of all) expect(rowsSize(p.rows)).toBeLessThanOrEqual(1024 + 2);
  });

  it("follows a running job: a cursor that answers nothing new, then what was stored", async () => {
    const t = await running();
    expect(await page(t)).toMatchObject({ rows: [], state: "streaming", end: 0 });
    const lines = Array.from({ length: 4 }, (_, i) => row(i, `line ${i}`));
    await stored(t, [lines.slice(0, 2)]);
    const first = await page(t);
    expect(first.rows).toEqual(lines.slice(0, 2));
    expect(first.next_cursor).not.toBeNull();
    const none = await page(t, `?cursor=${first.next_cursor}`);
    expect(none).toEqual({ ...first, rows: [] });
    const tail = await page(t, "?tail=1");
    expect(tail.rows).toEqual([lines[1]]);
    await stored(t, [lines.slice(0, 2), lines.slice(2)], { closed: "incomplete" });
    for (const cursor of [none.next_cursor, tail.next_cursor])
      expect(await page(t, `?cursor=${cursor}`)).toEqual({
        rows: lines.slice(2),
        state: "incomplete",
        end: 4,
        next_cursor: null,
      });
  });

  it("of a job with no task is none, and its cursor goes on at the log it gets", async () => {
    const t = await running(false);
    const none = await page(t);
    expect(none).toMatchObject({ rows: [], state: "none", end: 0 });
    expect(none.next_cursor).not.toBeNull();
    expect(await page(t, `?cursor=${none.next_cursor}`)).toEqual(none);
    const runner = await registerRunner(t.f.org.login, t.f.owner);
    if (!(await fetchTask(runner, 0)).task) throw new Error("no task");
    await stored(t, [[row(0, "first")]]);
    expect((await page(t, `?cursor=${none.next_cursor}`)).rows).toEqual([row(0, "first")]);
  });

  it("stays open in a finished job's late window, and ends after it", async () => {
    const t = await running();
    await stored(t, [[row(0, "x")]]);
    const ended = (ms: number) =>
      inRun(t.runId, (run) =>
        run.engine.exec(
          "UPDATE ci_logs SET state = 'incomplete', ended_at = ? WHERE task = 1",
          run.context.now() - ms,
        ),
      );
    await ended(LOG_LATE_MS / 2);
    expect((await page(t)).next_cursor).not.toBeNull();
    await ended(LOG_LATE_MS + 60_000);
    expect((await page(t)).next_cursor).toBeNull();
  });

  it("cuts only a row too long for a page, never inside a pair, and joins to the same text", async () => {
    const t = await running();
    const long = `${"a".repeat(8190)}${"😀".repeat(400)}\u0000\u0001${"é".repeat(3000)}\ud800"\\`;
    const lines = [
      row(0, "before"),
      row(1, long, 5),
      { i: 2, omitted: LOG_ROW_TOO_LARGE, bytes: 9_000_000 } as const,
      row(3, "x".repeat(900)),
      row(4, "x".repeat(900)),
    ];
    await stored(t, [lines.slice(0, 2), lines.slice(2)], { closed: "incomplete" });
    const all = await pages(t, "?max_bytes=1024");
    expect(joined(all.flatMap((p) => p.rows))).toEqual(lines);
    for (const p of all) {
      expect(rowsSize(p.rows)).toBeLessThanOrEqual(1024 + 2);
      for (const r of p.rows) {
        if ("omitted" in r) continue;
        if (r.o === undefined) expect(r.i).not.toBe(1);
        else {
          expect(r.i).toBe(1);
          expect(/^[\udc00-\udfff]/.test(r.c)).toBe(false);
          if (!r.end) expect(/[\ud800-\udbff]$/.test(r.c)).toBe(false);
        }
      }
    }
  });

  it("answers the last rows that fit, and the end of a last row too long", async () => {
    const t = await running();
    const long = `${"a".repeat(20_000)}${"😀".repeat(500)}`;
    const lines = [row(0, "first"), row(1, long), row(2, "x".repeat(500)), row(3, "y".repeat(500))];
    await stored(t, [lines.slice(0, 2), lines.slice(2)], { closed: "complete" });
    expect((await page(t, "?tail=4&max_bytes=1024")).rows).toEqual([lines[3]]);
    expect((await page(t, "?tail=4&max_bytes=1200")).rows).toEqual(lines.slice(2));
    // A long row that is not the last is left out, whole, however much room is left.
    const longest = await page(t, "?tail=4&max_bytes=2000");
    expect(longest.rows).toEqual(lines.slice(2));
    const u = await running();
    await stored(u, [lines.slice(0, 2)], { closed: "complete" });
    const cut = await page(u, "?tail=2&max_bytes=1024");
    expect(cut.rows).toHaveLength(1);
    const [only] = cut.rows as [Row & { c: string }];
    expect(only).toMatchObject({ i: 1, end: true });
    expect(only.o).toBe(long.length - only.c.length);
    expect(long.endsWith(only.c)).toBe(true);
    expect(only.c.startsWith("😀")).toBe(true);
    expect(rowsSize(cut.rows)).toBeLessThanOrEqual(1024 + 2);
    expect(cut.next_cursor).toBeNull();
  });

  it("answers any log whole, whatever its rows, chunks and page sizes", async () => {
    const t = await running();
    const text = fc.oneof(
      fc.string({ unit: "binary", maxLength: 40 }),
      fc
        .tuple(fc.constantFrom("a", '"', "\u0001", "é", "€", "😀", "\udc00"), fc.nat(2500))
        .map(([c, n]) => c.repeat(n)),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(text, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 1024, max: 4096 }),
        async (chunks, maxBytes) => {
          let i = 0;
          const lines = chunks.map((texts) => texts.map((c) => row(i++, c)));
          await inRun(t.runId, (run) => run.engine.exec("DELETE FROM ci_log_chunks"));
          await stored(t, lines, { closed: "complete" });
          // Asked of the run itself: more pages than a token may ask for in a minute.
          const ask = async (query: Omit<LogPageQuery, "maxBytes">) => {
            const answer = await inRun(t.runId, (run) =>
              run.readLog(t.f.repo.id, t.jobId, { ...query, maxBytes }),
            );
            if (!answer.ok) throw new Error(answer.code);
            expect(rowsSize(answer.rows)).toBeLessThanOrEqual(maxBytes + 2);
            return answer;
          };
          const rows: Row[] = [];
          let next: LogPosition | null = { task: 0, row: 0, offset: 0 };
          while (next !== null) {
            const answer: Awaited<ReturnType<typeof ask>> = await ask({ cursor: next });
            expect(answer.rows.length).toBeGreaterThan(0);
            expect(answer.next).not.toEqual(next);
            rows.push(...answer.rows);
            next = answer.next;
          }
          expect(joined(rows)).toEqual(lines.flat());
          const tail = await ask({ tail: i });
          expect(tail.rows.at(-1)?.i).toBe(i - 1);
          expect(tail.next).toBeNull();
        },
      ),
      { numRuns: 25 },
    );
  });

  it("reads no more chunks than a page's bounds, and only what it needs", async () => {
    const t = await running();
    const lines = Array.from({ length: 60 }, (_, i) => row(i, `line ${i}`));
    await stored(
      t,
      lines.map((l) => [l]),
      { closed: "complete" },
    );
    let gets = 0;
    logPageHooks.beforeChunkGet = () => {
      gets++;
    };
    const first = await page(t, "?max_bytes=524288");
    expect(first.rows).toHaveLength(LOG_PAGE_POLICY.chunks);
    expect(gets).toBe(LOG_PAGE_POLICY.chunks);
    expect((await page(t, `?cursor=${first.next_cursor}`)).rows).toEqual(lines.slice(32));
    gets = 0;
    expect((await page(t, "?tail=2")).rows).toEqual(lines.slice(58));
    expect(gets).toBe(2);
    gets = 0;
    expect((await page(t, "?tail=10000")).rows).toEqual(lines.slice(28));
    expect(gets).toBe(LOG_PAGE_POLICY.chunks);
    gets = 0;
    await page(t, "?from=60");
    expect(gets).toBe(0);
  });

  it("starts no chunk past 2 MiB read", async () => {
    const t = await running();
    const big = "z".repeat(900 * KIB);
    await stored(
      t,
      [0, 1, 2, 3].map((i) => [row(i, big)]),
      { closed: "complete" },
    );
    let gets = 0;
    logPageHooks.beforeChunkGet = () => {
      gets++;
    };
    await page(t, "?tail=4&max_bytes=524288");
    expect(gets).toBe(1);
    gets = 0;
    const u = await running();
    const lines = [0, 1, 2].map((i) => row(i, big)).concat(row(3, "last"), row(4, "next"));
    await stored(u, [lines.slice(0, 4), lines.slice(4)], { closed: "complete" });
    const first = await page(u, "?from=3");
    expect([first.rows, gets]).toEqual([[lines[3]], 1]);
    expect((await page(u, `?cursor=${first.next_cursor}`)).rows).toEqual([lines[4]]);
  });
});

describe("a job log page is refused", () => {
  it("for a cursor of another task, past the end or past its row, and for two starts", async () => {
    const t = await running();
    await stored(t, [[row(0, "abc"), row(1, "def")]], { closed: "complete" });
    const cursor = (text: string) => btoa(`${t.runId}:${t.jobId}:${text}`).replaceAll("=", "");
    for (const text of ["2:0:0", "1:3:0", "1:2:1", "1:0:3", "1:0:99", "0:1:0", "0:0:1", "x", "1:0"])
      expect(await read(t, `?cursor=${cursor(text)}`), text).toMatchObject({
        status: 422,
        body: { code: "invalid_cursor" },
      });
    // Another run's, at a task and a row this log has too, and another job's.
    const other = await running();
    await stored(other, [[row(0, "abc"), row(1, "def")]]);
    const unassigned = await running(false);
    for (const foreign of [await page(other), await page(unassigned)])
      expect(await read(t, `?cursor=${foreign.next_cursor}`)).toMatchObject({
        status: 422,
        body: { code: "invalid_cursor" },
      });
    const job2 = btoa(`${t.runId}:${t.jobId + 1}:1:0:0`).replaceAll("=", "");
    expect((await read(t, `?cursor=${job2}`)).status).toBe(422);
    const text = await json(api("GET", `${t.path}?cursor=${job2}`, t.f.owner.token));
    expect(text).toMatchObject({ status: 422, body: { code: "invalid_cursor" } });
    expect((await page(t, `?cursor=${cursor("1:0:1")}`)).rows[0]).toMatchObject({ c: "bc", o: 1 });
    for (const q of ["?from=0&tail=1", `?tail=1&cursor=${cursor("1:0:0")}`, "?from=0&cursor=x"])
      expect((await read(t, q)).status, q).toBe(422);
    for (const q of ["?max_bytes=1023", "?max_bytes=524289", "?tail=0", "?tail=10001", "?from=-1"])
      expect((await read(t, q)).status, q).toBe(422);
  });

  it("to one who cannot read the repository's runs, and for what is not there", async () => {
    const t = await running();
    await stored(t, [[row(0, "x")]]);
    const stranger = await user();
    const other = await running();
    expect(await read(t, "", stranger.token)).toMatchObject({
      status: 404,
      body: { code: "repo_not_found" },
    });
    expect(
      await json(
        api("GET", `${other.f.path}/actions/runs/${t.runId}/jobs/1/logs/rows`, other.f.owner.token),
      ),
    ).toMatchObject({ status: 404, body: { code: "run_not_found" } });
    expect(
      await json(
        api("GET", `${t.f.path}/actions/runs/${t.runId}/jobs/99/logs/rows`, t.f.owner.token),
      ),
    ).toMatchObject({ status: 404, body: { code: "job_not_found" } });
  });

  it("for a log stored before masking, whose chunks are never read", async () => {
    const t = await running();
    await stored(t, [[row(0, "unmasked")]], { closed: "complete" });
    await inRun(t.runId, (run) => run.engine.exec("UPDATE ci_logs SET unmasked = 1"));
    let gets = 0;
    logPageHooks.beforeChunkGet = () => {
      gets++;
    };
    for (const q of ["", "?tail=1", "?from=0"])
      expect(await read(t, q)).toMatchObject({ status: 410, body: { code: "log_unavailable" } });
    expect((await api("GET", t.path, t.f.owner.token)).status).toBe(410);
    expect(gets).toBe(0);
  });

  it("when a chunk is missing or is not its manifest's, after the whole rows before it", async () => {
    const t = await running();
    const lines = [row(0, "a"), row(1, "b"), row(2, "c")];
    await stored(
      t,
      lines.map((l) => [l]),
      { closed: "complete" },
    );
    await env.CI.put(`runs/${t.runId}/pages/1.ndjson`, `${JSON.stringify(row(7, "b"))}\n`);
    const first = await page(t);
    expect(first.rows).toEqual([lines[0]]);
    const refusal = { status: 503, body: { code: "log_unreadable" } };
    expect(await read(t, `?cursor=${first.next_cursor}`)).toMatchObject(refusal);
    expect(await read(t, "?tail=3")).toMatchObject(refusal);
    // Shorter than its manifest says.
    const u = await running();
    await stored(u, [lines.slice(0, 2), lines.slice(2)], { closed: "complete" });
    await env.CI.put(`runs/${u.runId}/pages/0.ndjson`, `${JSON.stringify(lines[0])}\n`);
    const short = await page(u);
    expect(short.rows).toEqual([lines[0]]);
    expect(await read(u, `?cursor=${short.next_cursor}`)).toMatchObject(refusal);
    // An extra row in the last chunk, after the one it holds.
    const w = await running();
    await stored(w, [lines.slice(0, 1)], { closed: "complete" });
    const extra = `${JSON.stringify(lines[0])}\n${JSON.stringify(lines[1])}\n`;
    await env.CI.put(`runs/${w.runId}/pages/0.ndjson`, extra);
    await inRun(w.runId, (run) =>
      run.engine.exec("UPDATE ci_log_chunks SET bytes = ?", new TextEncoder().encode(extra).length),
    );
    expect(await read(w)).toMatchObject(refusal);
    await env.CI.delete(`runs/${t.runId}/pages/1.ndjson`);
    expect(await read(t, "?from=1")).toMatchObject(refusal);
    await inRun(t.runId, (run) =>
      run.engine.exec("DELETE FROM ci_log_chunks WHERE start_index = 1"),
    );
    expect(await read(t, "?from=1")).toMatchObject(refusal);
    expect((await page(t, "?from=2")).rows).toEqual([lines[2]]);
    // The last rows up to the hole are there; past it, a hole is never skipped over.
    expect((await page(t, "?tail=1")).rows).toEqual([lines[2]]);
    expect(await read(t, "?tail=2")).toMatchObject(refusal);
    expect(await read(t, "?tail=3")).toMatchObject(refusal);
    const v = await running();
    await stored(v, [lines.slice(1)], { closed: "complete" });
    expect((await page(v, "?tail=2")).rows).toEqual(lines.slice(1));
    expect(await read(v, "?tail=3")).toMatchObject(refusal);
  });

  it("once the run was erased while it read", async () => {
    const t = await running();
    await stored(t, [[row(0, "gone")]], { closed: "complete" });
    logPageHooks.afterChunkGet = () =>
      inRun(t.runId, (run) =>
        run.engine.exec("INSERT INTO run_erasure (id, erased_at) VALUES (1, 0)"),
      );
    expect(await read(t)).toMatchObject({ status: 404, body: { code: "run_not_found" } });
  });

  it("while an upload needs its memory: the rows it has, or busy", async () => {
    const t = await running();
    await stored(t, [[row(0, "a")], [row(1, "b")]], { closed: "complete" });
    const abortAt = (chunk: string) => {
      logPageHooks.afterChunkGet = async (key) => {
        if (key.endsWith(`/${chunk}.ndjson`))
          await inRun(t.runId, (run) => {
            void run.storedLogs.abortReads();
          });
      };
    };
    abortAt("1");
    const first = await page(t);
    expect(first.rows).toEqual([row(0, "a")]);
    const busy = { status: 503, body: { code: "log_busy" } };
    expect(await read(t, "?tail=2")).toMatchObject(busy);
    abortAt("0");
    expect(await read(t)).toMatchObject(busy);
    delete logPageHooks.afterChunkGet;
    expect((await page(t, `?cursor=${first.next_cursor}`)).rows).toEqual([row(1, "b")]);
    // Nothing is left held by the reads that were cut short.
    expect(await inRun(t.runId, (run) => run.storedLogs.abortReads())).toBe(false);
  });
});

describe("a job's log as text", () => {
  it("is the rows with their times, joined across pages by Link, under both prefixes", async () => {
    const t = await running();
    const time = Date.UTC(2026, 10, 25, 9, 0, 0, 123);
    const long = "😀é\u001b[31m".repeat(60_000);
    const lines = [
      row(0, "plain \u001b[32mgreen\u001b[0m", time),
      row(1, "no time"),
      row(2, long, time),
      { i: 3, omitted: LOG_ROW_TOO_LARGE, bytes: 12 } as const,
      row(4, ""),
    ];
    await stored(t, [lines.slice(0, 2), lines.slice(2)], { closed: "incomplete" });
    const stamp = "2026-11-25T09:00:00.123Z ";
    const expected = `${stamp}plain \u001b[32mgreen\u001b[0m\nno time\n${stamp}${long}\n[row omitted: 12 bytes]\n\n`;
    let text = "";
    let next: string | undefined = t.path;
    let count = 0;
    while (next !== undefined) {
      const res: Response = await api("GET", next, t.f.owner.token);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
      expect(res.headers.get("X-Fyrden-Log-State")).toBe("incomplete");
      text += await res.text();
      count++;
      const link = /^<https?:\/\/[^/]+\/api(\/[^?>]+\?cursor=[^&>]+)>; rel="next"$/.exec(
        res.headers.get("Link") ?? "",
      );
      expect(res.headers.has("Link")).toBe(link !== null);
      next = link?.[1];
    }
    expect(count).toBeGreaterThan(1);
    expect(text === expected).toBe(true);
    expect((await api("GET", `/v3${t.path}`, t.f.owner.token)).status).toBe(200);
  });

  it("starts at a row or at the last rows, as the rows do", async () => {
    const t = await running();
    await stored(t, [[row(0, "a"), row(1, "b"), row(2, "c")]], { closed: "complete" });
    const text = async (q: string) => (await api("GET", `${t.path}${q}`, t.f.owner.token)).text();
    expect([await text("?from=1"), await text("?tail=1")]).toEqual(["b\nc\n", "c\n"]);
    for (const q of ["?from=1&tail=1", "?tail=0", "?from=-1", "?tail=x"])
      expect((await api("GET", `${t.path}${q}`, t.f.owner.token)).status, q).toBe(422);
  });

  it("of a running job ends at what is stored, with no next page", async () => {
    const t = await running();
    await stored(t, [[row(0, "so far")]]);
    const res = await api("GET", t.path, t.f.owner.token);
    expect([await res.text(), res.headers.get("Link")]).toEqual(["so far\n", null]);
    expect(res.headers.get("X-Fyrden-Log-State")).toBe("streaming");
  });

  it("is refused as the rows are", async () => {
    const t = await running(false);
    const none = await json<{ code: string }>(api("GET", t.path, t.f.owner.token));
    expect(none).toMatchObject({ status: 404, body: { code: "log_not_found" } });
    const stranger = await user();
    expect(await json(api("GET", t.path, stranger.token))).toMatchObject({
      status: 404,
      body: { code: "repo_not_found" },
    });
    const unauthenticated = await api("GET", t.path, "not-a-token");
    for (const prefix of ["", "/v3"])
      for (const [path, token] of [
        [t.path, "not-a-token"],
        [t.path, stranger.token],
        [`${t.path}?cursor=!`, t.f.owner.token],
      ] as const) {
        const res = await api("GET", prefix + path, token);
        expect([res.status >= 400, res.headers.get("Cache-Control")]).toEqual([
          true,
          "private, no-store",
        ]);
      }
    expect(unauthenticated.status).toBe(401);
    expect(await json(api("GET", `${t.path}?cursor=!`, t.f.owner.token))).toMatchObject({
      status: 422,
      body: { code: "invalid_cursor" },
    });
    expect((await api("GET", t.path.replace("/logs", "x/logs"), t.f.owner.token)).status).toBe(422);
  });
});

describe("log pages' daily allowance", () => {
  const spend = (db: D1Database, class_b: number) =>
    db
      .prepare(
        `INSERT INTO ci_log_read_days (day, class_b) VALUES (CAST(unixepoch() / 86400 AS INTEGER), ?1)
         ON CONFLICT (day) DO UPDATE SET class_b = ?1`,
      )
      .bind(class_b)
      .run();
  const spent = async () =>
    (
      await env.DIRECTORY.prepare("SELECT sum(class_b) AS n FROM ci_log_read_days").first<{
        n: number;
      }>()
    )?.n;

  it("on Free is charged the chunks a page reads, and nothing when it reads none", async () => {
    const t = await running();
    ciVariableOverrides.FYRDEN_PLAN = "free";
    await stored(
      t,
      [0, 1, 2].map((i) => [row(i, "x")]),
    );
    await spend(env.DIRECTORY, 0);
    const first = await page(t);
    expect(await spent()).toBe(3);
    await page(t, `?cursor=${first.next_cursor}`);
    expect(await spent()).toBe(3);
    await spend(env.DIRECTORY, CI_LOG_READS_DAILY - 2);
    let gets = 0;
    logPageHooks.beforeChunkGet = () => {
      gets++;
    };
    const refused = await read(t);
    expect(refused).toMatchObject({ status: 429, body: { code: "log_reads_spent" } });
    expect((refused.body.retry_at ?? 0) % 86_400_000).toBe(0);
    const text = await json<Page>(api("GET", t.path, t.f.owner.token));
    expect(text).toMatchObject({ status: 429, body: { code: "log_reads_spent" } });
    expect(gets).toBe(0);
    expect(await spent()).toBe(CI_LOG_READS_DAILY - 2);
    expect((await page(t, "?tail=2")).rows).toHaveLength(2);
    expect(await spent()).toBe(CI_LOG_READS_DAILY);
  });

  it("is never passed by charges at the same time", async () => {
    await spend(env.DIRECTORY, CI_LOG_READS_DAILY - 100);
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => chargeLogReads({ FYRDEN_PLAN: "free" }, env.DIRECTORY, 32)),
    );
    expect(answers.filter((a) => a.status === "granted")).toHaveLength(3);
    expect(await spent()).toBe(CI_LOG_READS_DAILY - 4);
  });

  it("is charged the chunks a page can use, and nothing for a page refused as busy", async () => {
    const t = await running();
    ciVariableOverrides.FYRDEN_PLAN = "free";
    const lines = Array.from({ length: 40 }, (_, i) => row(i, `line ${i} ${"x".repeat(200)}`));
    await stored(t, [lines.slice(0, 20), lines.slice(20)], { closed: "complete" });
    await spend(env.DIRECTORY, 0);
    expect((await page(t, "?from=2&max_bytes=1024")).rows).toHaveLength(4);
    expect(await spent()).toBe(1);
    const held = await inRun(t.runId, (run) => {
      const { totalBytes, reservedBytes } = run.memory.stats();
      return run.memory.tryReserve(totalBytes - reservedBytes) !== null;
    });
    expect(held).toBe(true);
    expect(await read(t)).toMatchObject({ status: 503, body: { code: "log_busy" } });
    expect(await spent()).toBe(1);
  });

  it("is not asked on Paid", async () => {
    const t = await running();
    await stored(t, [[row(0, "x")]]);
    await spend(env.DIRECTORY, CI_LOG_READS_DAILY);
    expect((await page(t)).rows).toHaveLength(1);
    expect(await spent()).toBe(CI_LOG_READS_DAILY);
  });
});
