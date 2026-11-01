import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  exportReadModel,
  handshakeReadModel,
  parseReadModelArgs,
} from "../src/commands/read-model.ts";

const URL_ = "https://api.fyrden.test";
let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fyrden-export-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A deployment's API as the export calls it: its pause, manifest, pages and resume. */
function fakeApi(
  options: {
    leasesLive?: number;
    fenceLostAt?: number;
    limitedOnce?: boolean;
    /** The pause's step after the first fails. */
    failPause?: boolean;
    /** Another step's pause stands when this run resumes. */
    newerPause?: boolean;
  } = {},
) {
  const calls: string[] = [];
  let live = options.leasesLive ?? 0;
  let pages = 0;
  let limited = options.limitedOnce ?? false;
  const pageData = [
    { table: "consumer_epochs", rows: [{ source_id: "a", epoch_gen: 1 }], next_cursor: "c1" },
    { table: "consumer_epochs", rows: [{ source_id: "b", epoch_gen: 2 }], next_cursor: "c2" },
    { table: "effects", rows: [{ effect_id: "e1", payload: '{"x":1}' }], next_cursor: null },
  ];
  const fetcher = (async (url: string, init: RequestInit) => {
    const { pathname, searchParams } = new URL(url);
    const body = init.body && init.body !== "{}" ? ` ${init.body}` : "";
    calls.push(`${init.method} ${pathname}${searchParams.size ? `?${searchParams}` : ""}${body}`);
    if (pathname === "/api/admin/read-model/pause" && options.failPause && calls.length > 1)
      return Response.json({ code: "internal_error" }, { status: 500 });
    if (pathname === "/api/admin/read-model/pause") {
      if (live > 0) {
        live--;
        return Response.json({ phase: "pausing", generation: 7, live: 1, until: 2_000 });
      }
      return Response.json({ phase: "paused", generation: 7, live: 0, until: null });
    }
    if (pathname === "/api/admin/read-model/resume")
      return Response.json(
        options.newerPause
          ? { phase: "paused", generation: 8 }
          : { phase: "running", generation: 7 },
      );
    if (pathname === "/api/admin/read-model/export")
      return Response.json({
        generation: 7,
        migrations: ["0001_init.sql"],
        tables: [
          { table: "consumer_epochs", columns: ["source_id", "epoch_gen"] },
          { table: "effects", columns: ["effect_id", "payload"] },
          { table: "webhook_payloads", columns: ["event_key"] },
        ],
        protocol: { read_model_barrier: [{ phase: "paused", generation: 7 }] },
      });
    if (pathname === "/api/admin/read-model/export/pages") {
      if (limited) {
        limited = false;
        return Response.json({ code: "rate_limited" }, { status: 429 });
      }
      if (pages === options.fenceLostAt)
        return Response.json({ code: "export_fence_lost", detail: "moved" }, { status: 409 });
      return Response.json(pageData[pages++]);
    }
    return Response.json({ code: "not_found" }, { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const run = (fetcher: typeof fetch, keepPaused = false) => {
  const slept: number[] = [];
  const lines: string[] = [];
  const done = exportReadModel({
    args: { command: "export", url: URL_, token: "tok", out: join(dir, "export"), keepPaused },
    fetch: fetcher,
    sleep: async (ms) => {
      slept.push(ms);
    },
    now: () => 1_000,
    log: (line) => lines.push(line),
  });
  return { done, slept, lines };
};

describe("fyrden read-model export", () => {
  it("takes the API's URL and a directory to write, the token from the environment", () => {
    const env = { FYRDEN_TOKEN: "t" };
    expect(parseReadModelArgs(["export", "--url", URL_, "--out", "backup"], env)).toEqual({
      command: "export",
      url: URL_,
      token: "t",
      out: "backup",
      keepPaused: false,
    });
    expect(
      parseReadModelArgs(["export", "--url", URL_, "--out", "b", "--keep-paused"], env),
    ).toMatchObject({ keepPaused: true });
    expect(parseReadModelArgs(["export", "--url", URL_], env)).toHaveProperty("error");
    expect(parseReadModelArgs(["import", "--url", URL_, "--out", "b"], env)).toHaveProperty(
      "error",
    );
    expect(parseReadModelArgs(["export", "--url", URL_, "--out", "b"], {})).toHaveProperty("error");
    expect(parseReadModelArgs(["handshake", "--url", URL_], env)).toEqual({
      command: "handshake",
      url: URL_,
      token: "t",
    });
    expect(parseReadModelArgs(["handshake", "--url", URL_, "--out", "b"], env)).toHaveProperty(
      "error",
    );
  });

  it("asks for a handshake of the restore token, and says when it is refused", async () => {
    const seen: string[] = [];
    const answer = (status: number, body: unknown) =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push(`${init?.method} ${String(input)}`);
        return Response.json(body, { status });
      }) as typeof fetch;
    const lines: string[] = [];
    await handshakeReadModel({
      args: { command: "handshake", url: URL_, token: "tok" },
      fetch: answer(200, { restore_token: "matched" }),
      log: (line) => lines.push(line),
    });
    expect(seen).toEqual([`POST ${URL_}/api/admin/read-model/handshake`]);
    expect(lines).toEqual(["ok   read model restore token matched"]);
    await expect(
      handshakeReadModel({
        args: { command: "handshake", url: URL_, token: "tok" },
        fetch: answer(409, { code: "restore_token_mismatch", detail: "restored" }),
        log: () => {},
      }),
    ).rejects.toThrow(/restore_token_mismatch|restored/);
  });

  it("pauses the writers, waits for older leases, writes every table and a manifest of digests, and resumes", async () => {
    const api = fakeApi({ leasesLive: 1 });
    const { done, slept } = run(api.fetcher);
    const result = await done;
    // Waited for the older lease's deadline before the next step.
    expect(slept).toEqual([1_000]);
    expect(api.calls).toEqual([
      "POST /api/admin/read-model/pause",
      "POST /api/admin/read-model/pause",
      "GET /api/admin/read-model/export?generation=7",
      "GET /api/admin/read-model/export/pages?generation=7",
      "GET /api/admin/read-model/export/pages?generation=7&cursor=c1",
      "GET /api/admin/read-model/export/pages?generation=7&cursor=c2",
      'POST /api/admin/read-model/resume {"generation":7}',
    ]);
    const out = join(dir, "export");
    const epochs = await readFile(join(out, "consumer_epochs.jsonl"), "utf8");
    expect(epochs).toBe('{"source_id":"a","epoch_gen":1}\n{"source_id":"b","epoch_gen":2}\n');
    // A table with no rows is a file too, empty.
    expect(await readFile(join(out, "webhook_payloads.jsonl"), "utf8")).toBe("");
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      generation: 7,
      migrations: ["0001_init.sql"],
      files: {
        consumer_epochs: {
          file: "consumer_epochs.jsonl",
          rows: 2,
          sha256: createHash("sha256").update(epochs).digest("hex"),
        },
        effects: { rows: 1 },
        webhook_payloads: { rows: 0 },
      },
    });
    expect(result).toEqual({ generation: 7, rows: 3 });
  });

  it("leaves the writers paused when asked to", async () => {
    const api = fakeApi();
    await run(api.fetcher, true).done;
    expect(api.calls.at(-1)).toBe("GET /api/admin/read-model/export/pages?generation=7&cursor=c2");
  });

  it("waits out a rate limit and goes on", async () => {
    const api = fakeApi({ limitedOnce: true });
    const { done, slept } = run(api.fetcher);
    await done;
    expect(slept).toEqual([30_000]);
    expect(api.calls.filter((c) => c.includes("/pages")).length).toBe(4);
  });

  it("stops when the pause moved under it, and resumes the writers", async () => {
    const api = fakeApi({ fenceLostAt: 1 });
    await expect(run(api.fetcher).done).rejects.toThrow(/409 export_fence_lost/);
    expect(api.calls.at(-1)).toBe('POST /api/admin/read-model/resume {"generation":7}');
  });

  it("resumes the pause it started when a later step of it fails", async () => {
    const api = fakeApi({ leasesLive: 1, failPause: true });
    await expect(run(api.fetcher).done).rejects.toThrow(/500/);
    expect(api.calls.at(-1)).toBe('POST /api/admin/read-model/resume {"generation":7}');
  });

  it("leaves a newer pause standing, and says so", async () => {
    const api = fakeApi({ newerPause: true });
    const { done, lines } = run(api.fetcher);
    await done;
    expect(lines.at(-1)).toBe(
      "left the read model's writers paused at generation 8 (another step's)",
    );
  });

  it("never writes into a directory that exists", async () => {
    const api = fakeApi();
    const slept: number[] = [];
    await expect(
      exportReadModel({
        args: { command: "export", url: URL_, token: "tok", out: dir, keepPaused: false },
        fetch: api.fetcher,
        sleep: async (ms) => {
          slept.push(ms);
        },
        now: () => 1_000,
        log: () => {},
      }),
    ).rejects.toThrow(/exists/);
    expect(api.calls).toEqual([]);
  });
});
