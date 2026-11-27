import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type GraphJob,
  jobPath,
  layers,
  type RunFilters,
  runFilters,
  runFiltersQuery,
  runPath,
  runsApiQuery,
  runsPath,
  runWords,
  workflowRunsPath,
} from "../app/lib/runs.js";

const ID = "01JD0000000000000000000000";

describe("paths", () => {
  it("names each page under the repository's actions", () => {
    expect(runsPath("acme", "web")).toBe("/acme/web/actions");
    expect(workflowRunsPath("acme", "web", "ci.yml")).toBe("/acme/web/actions/workflows/ci.yml");
    expect(runPath("acme", "web", ID)).toBe(`/acme/web/actions/runs/${ID}`);
    expect(runPath("acme", "web", ID, 2)).toBe(`/acme/web/actions/runs/${ID}?attempt=2`);
    expect(jobPath("acme", "web", ID, 7)).toBe(`/acme/web/actions/runs/${ID}/job/7`);
  });

  it("escapes what a segment cannot hold", () => {
    expect(workflowRunsPath("acme", "web", "a b#.yml")).toBe(
      "/acme/web/actions/workflows/a%20b%23.yml",
    );
  });
});

const parse = (query: string) => runFilters(new URL(`https://f.test/a/b/actions?${query}`));

describe("runFilters", () => {
  it("keeps the filters the API takes", () => {
    const { filters, errors } = parse(
      "status=pending&event=push&branch=main&actor=ana&sha=ABCDEF0123456789abcdef0123456789abcdef01",
    );
    expect(errors).toEqual([]);
    expect(filters).toEqual({
      status: "pending",
      event: "push",
      branch: "main",
      actor: "ana",
      sha: "abcdef0123456789abcdef0123456789abcdef01",
    });
  });

  it("drops empty fields and values the page does not offer", () => {
    expect(parse("status=stale&event=&branch=").filters).toEqual({});
  });

  it("names a value it cannot send", () => {
    const { filters, errors } = parse("sha=xyz&actor=a%20b&created_from=2026-13-01");
    expect(filters).toEqual({});
    expect(errors.map((e) => e.field).sort()).toEqual(["actor", "created", "sha"]);
  });

  it("turns the date fields into GitHub's created syntax", () => {
    const both = parse("created_from=2026-11-01&created_to=2026-11-20").filters;
    expect(runsApiQuery(both, null)).toContain("created=2026-11-01..2026-11-20");
    expect(runsApiQuery(parse("created_from=2026-11-01").filters, null)).toContain(
      `created=${encodeURIComponent(">=2026-11-01")}`,
    );
    expect(runsApiQuery(parse("created_to=2026-11-20").filters, null)).toContain(
      `created=${encodeURIComponent("<=2026-11-20")}`,
    );
  });

  it("refuses a range that ends before it starts", () => {
    const { filters, errors } = parse("created_from=2026-11-20&created_to=2026-11-01");
    expect(filters.createdFrom).toBeUndefined();
    expect(errors.map((e) => e.field)).toEqual(["created"]);
  });

  it("round-trips through the page's own links", () => {
    const filter = fc.record(
      {
        status: fc.constantFrom("queued", "success", "action_required"),
        event: fc.constantFrom("push", "pull_request"),
        branch: fc.stringMatching(/^[a-z][a-z0-9/._-]{0,20}$/),
        actor: fc.stringMatching(/^[a-z][a-z0-9]{0,5}(-[a-z0-9]{1,4})?$/),
        createdFrom: fc.constant("2026-01-02"),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(filter, (f) => {
        const back = parse(runFiltersQuery(f as RunFilters).slice(1)).filters;
        expect(back).toEqual(f);
      }),
    );
  });

  it("sends a cursor only with the filters it was read for", () => {
    const q = runsApiQuery({ status: "queued" }, "c1");
    expect(q).toBe("per_page=30&status=queued&cursor=c1");
  });
});

describe("runWords", () => {
  it("words each state with a mark that is not its only signal", () => {
    expect(runWords("completed", "success")).toEqual({
      words: "Succeeded",
      mark: "✓",
      tone: "ok",
    });
    expect(runWords("completed", "failure").tone).toBe("bad");
    expect(runWords("completed", "action_required").words).toBe("Waiting for approval");
    expect(runWords("pending", null).words).toBe("Waiting");
    expect(runWords("in_progress", null).words).toBe("In progress");
    expect(runWords("completed", "timed_out").words).toBe("Timed out");
    expect(runWords("completed", "skipped").words).toBe("Skipped");
    expect(runWords("completed", null).words).toBe("Completed");
  });

  it("words a check allowed to fail, and one that errored, apart from a success", () => {
    expect(runWords("completed", "neutral")).toEqual({ words: "Neutral", mark: "■", tone: "idle" });
    expect(runWords("completed", "error")).toEqual({ words: "Error", mark: "✗", tone: "bad" });
  });
});

const job = (key: string, needs: string[] = []): GraphJob => ({
  key,
  name: key,
  needs,
  status: "pending",
  conclusion: null,
  name_cut: false,
  jobs: [],
});

describe("layers", () => {
  it("puts a job one column after the longest chain it needs", () => {
    const columns = layers([
      job("a"),
      job("b"),
      job("c", ["a"]),
      job("d", ["a", "c"]),
      job("e", ["b"]),
    ]);
    expect(columns.map((c) => c.map((j) => j.key))).toEqual([["a", "b"], ["c", "e"], ["d"]]);
  });

  it("draws nothing for no jobs", () => {
    expect(layers([])).toEqual([]);
  });

  it("falls back to one column for a need it cannot place", () => {
    expect(layers([job("a", ["zz"]), job("b")]).map((c) => c.map((j) => j.key))).toEqual([
      ["a", "b"],
    ]);
    expect(layers([job("a", ["b"]), job("b", ["a"])]).map((c) => c.map((j) => j.key))).toEqual([
      ["a", "b"],
    ]);
  });

  it("places every job after each job it needs", () => {
    const graph = fc
      .integer({ min: 1, max: 40 })
      .chain((n) =>
        fc.tuple(
          ...Array.from({ length: n }, (_, i) =>
            fc.subarray(Array.from({ length: i }, (_, j) => `j${j}`)),
          ),
        ),
      );
    fc.assert(
      fc.property(graph, (needs) => {
        const jobs = needs.map((n, i) => job(`j${i}`, n));
        const column = new Map<string, number>();
        layers(jobs).forEach((c, i) => {
          for (const j of c) column.set(j.key, i);
        });
        expect(column.size).toBe(jobs.length);
        for (const j of jobs)
          for (const need of j.needs)
            expect(column.get(j.key) as number).toBeGreaterThan(column.get(need) as number);
      }),
    );
  });
});
