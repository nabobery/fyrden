// `fyrden read-model recover`: drives the read model's recovery from where
// the deployment says it stands: started (the writers paused first) when
// none is under way, stepped until it awaits its restore, where it stops and
// says how to restore; run again with the restore, stepped on until complete.
// It never restores the database itself.

import { describe, expect, it } from "vitest";
import { parseReadModelArgs, recoverReadModel } from "../src/commands/read-model.ts";

const URL_ = "https://api.fyrden.test";

/** A deployment's recovery API, as far as the command sees it. */
function deployment(start?: { id: string; stage: string }) {
  let recovery: { recovery_id: string; generation: number; stage: string } | null = start
    ? { recovery_id: start.id, generation: 7, stage: start.stage }
    : null;
  let preserving = 3;
  let importing = 2;
  const calls: string[] = [];
  let limited = 1;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace(/^\/api/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    // Rate limited once, then answered (a call refused is not counted as made).
    if (path === "/admin/read-model/recovery/step" && limited-- > 0)
      return Response.json({ code: "rate_limited" }, { status: 429 });
    calls.push(`${init?.method ?? "GET"} ${path}${body.restore ? " (restore)" : ""}`);
    if (path === "/admin/read-model/pause")
      return Response.json({ phase: "paused", generation: 6, live: 0, until: null });
    if (path === "/admin/read-model/recovery" && init?.method === "POST") {
      recovery = { recovery_id: body.recovery_id, generation: 7, stage: "preserving" };
      return Response.json(recovery);
    }
    if (path === "/admin/read-model/recovery")
      return recovery
        ? Response.json(recovery)
        : Response.json({ code: "not_found" }, { status: 404 });
    if (path === "/admin/read-model/recovery/step") {
      if (!recovery || body.recovery_id !== recovery.recovery_id)
        return Response.json({ code: "recovery_refused" }, { status: 409 });
      const stage = recovery.stage;
      const next =
        stage === "preserving"
          ? --preserving > 0
            ? "preserving"
            : "awaiting_restore"
          : stage === "awaiting_restore"
            ? body.restore
              ? "importing"
              : "awaiting_restore"
            : stage === "importing"
              ? --importing > 0
                ? "importing"
                : "fencing"
              : stage === "fencing"
                ? "resuming"
                : "complete";
      recovery = { ...recovery, stage: next };
      return Response.json(recovery);
    }
    return Response.json({ code: "not_found" }, { status: 404 });
  }) as typeof fetch;
  return { fetcher, calls, state: () => recovery };
}

const run = (fetcher: typeof fetch, args: Parameters<typeof recoverReadModel>[0]["args"]) => {
  const lines: string[] = [];
  const slept: number[] = [];
  const done = recoverReadModel({
    args,
    fetch: fetcher,
    sleep: async (ms) => {
      slept.push(ms);
    },
    now: () => 0,
    log: (line) => lines.push(line),
  });
  return { done, lines, slept };
};

describe("read-model recover", () => {
  it("parses its id, and its restore's two bookmarks together", () => {
    const env = { FYRDEN_TOKEN: "t" };
    expect(parseReadModelArgs(["recover", "--url", URL_, "--id", "r1"], env)).toEqual({
      command: "recover",
      url: URL_,
      token: "t",
      id: "r1",
    });
    expect(
      parseReadModelArgs(
        ["recover", "--url", URL_, "--id", "r1", "--restore-bookmark", "b", "--undo-bookmark", "u"],
        env,
      ),
    ).toMatchObject({ restore: { bookmark: "b", undoBookmark: "u" } });
    expect(
      parseReadModelArgs(["recover", "--url", URL_, "--id", "r1", "--restore-bookmark", "b"], env),
    ).toHaveProperty("error");
    expect(parseReadModelArgs(["recover", "--url", URL_, "--id", "../x"], env)).toHaveProperty(
      "error",
    );
    expect(parseReadModelArgs(["recover", "--url", URL_], env)).toHaveProperty("error");
  });

  it("pauses, starts, preserves, and stops at the restore saying how to make it", async () => {
    const api = deployment();
    const { done, lines, slept } = run(api.fetcher, {
      command: "recover",
      url: URL_,
      token: "t",
      id: "r1",
    });
    expect(await done).toMatchObject({ recovery_id: "r1", stage: "awaiting_restore" });
    expect(api.calls.slice(0, 3)).toEqual([
      "GET /admin/read-model/recovery",
      "POST /admin/read-model/pause",
      "POST /admin/read-model/recovery",
    ]);
    expect(lines.join("\n")).toMatch(
      /wrangler d1 time-travel restore fyrden-org --bookmark=<bookmark> --config apps\/api\/wrangler\.deploy\.jsonc/,
    );
    expect(lines.join("\n")).toMatch(
      /wrangler d1 migrations apply fyrden-org --remote --config apps\/api\/wrangler\.deploy\.jsonc/,
    );
    expect(lines.join("\n")).toMatch(/--restore-bookmark <bookmark> --undo-bookmark/);
    // A rate-limited step waited for and asked again.
    expect(slept).toHaveLength(1);
    expect(api.calls.some((c) => c.includes("(restore)"))).toBe(false);
  });

  it("goes on from where the deployment stands: the restore reported once, then stepped to complete", async () => {
    const api = deployment({ id: "r1", stage: "awaiting_restore" });
    const { done, lines } = run(api.fetcher, {
      command: "recover",
      url: URL_,
      token: "t",
      id: "r1",
      restore: { bookmark: "b", undoBookmark: "u" },
    });
    expect(await done).toMatchObject({ stage: "complete" });
    expect(api.calls.filter((c) => c.includes("(restore)"))).toHaveLength(1);
    expect(api.calls).not.toContain("POST /admin/read-model/pause");
    expect(lines.at(-1)).toMatch(/complete/);
  });

  it("asks its start again when run while it is preserving (an interrupted start finished), not pausing", async () => {
    const api = deployment({ id: "r1", stage: "preserving" });
    await run(api.fetcher, { command: "recover", url: URL_, token: "t", id: "r1" }).done;
    expect(api.calls.slice(0, 2)).toEqual([
      "GET /admin/read-model/recovery",
      "POST /admin/read-model/recovery",
    ]);
    expect(api.calls).not.toContain("POST /admin/read-model/pause");
  });

  it("waits out a rate-limited pause", async () => {
    const api = deployment();
    let refused = 1;
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/admin/read-model/pause") && refused-- > 0)
        return Response.json({ code: "rate_limited" }, { status: 429 });
      return api.fetcher(input, init);
    }) as typeof fetch;
    const { done, slept } = run(fetcher, { command: "recover", url: URL_, token: "t", id: "r1" });
    expect(await done).toMatchObject({ stage: "awaiting_restore" });
    expect(slept.length).toBeGreaterThanOrEqual(2);
  });

  it("stops on what the deployment refuses: another error, a refused step, a recovering barrier", async () => {
    const failing = (status: number, code: string, on: string) => {
      const api = deployment({ id: "r1", stage: "importing" });
      return (async (input: string | URL | Request, init?: RequestInit) =>
        String(input).includes(on)
          ? Response.json({ code }, { status })
          : api.fetcher(input, init)) as typeof fetch;
    };
    const args = { command: "recover" as const, url: URL_, token: "t", id: "r1" };
    await expect(run(failing(500, "internal", "/recovery"), args).done).rejects.toThrow();
    await expect(
      run(failing(409, "recovery_refused", "/recovery/step"), args).done,
    ).rejects.toThrow();
    const fresh = deployment();
    const recovering = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith("/pause")
        ? Response.json({ code: "read_model_recovering" }, { status: 409 })
        : fresh.fetcher(input, init)) as typeof fetch;
    await expect(run(recovering, args).done).rejects.toThrow();
  });

  it("refuses while another recovery is under way, and starts a new one after a complete one", async () => {
    const busy = deployment({ id: "other", stage: "importing" });
    await expect(
      run(busy.fetcher, { command: "recover", url: URL_, token: "t", id: "r1" }).done,
    ).rejects.toThrow(/other is under way/);
    const after = deployment({ id: "old", stage: "complete" });
    expect(
      await run(after.fetcher, { command: "recover", url: URL_, token: "t", id: "r2" }).done,
    ).toMatchObject({ recovery_id: "r2", stage: "awaiting_restore" });
  });
});
