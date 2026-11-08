// Blame through the repository object: a run initialized, walked in slices,
// checkpointed, and delivered in pages a continuation names, or as a window.
// What it says of each line is what git blame says, or a stated refusal.

import { describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import type { BlameAnswer, BlameRequest, BlameResult } from "../src/do/repo/blame.js";
import { encodeBlameToken, pathDigest } from "../src/do/repo/blame-token.js";
import { createRepo } from "./helpers/git-http.js";
import { principalWithToken } from "./helpers/principals.js";
import { postPush, pushTarget } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("blameFixtures");
type Stub = DurableObjectStub<RepoDO>;
type Range = BlameAnswer["ranges"][number];

async function pushedRepo(): Promise<{ stub: Stub; repoId: string }> {
  const target = await pushTarget();
  const reply = await postPush(
    target,
    pushBody([{ old: ZERO, new: fx.tip, ref: "refs/heads/main" }], { pack: fx.pack }),
  );
  expect(reply.report).toContain("ok refs/heads/main\n");
  return { stub: target.repo.stub, repoId: target.repo.id };
}

const pushed = async (): Promise<Stub> => (await pushedRepo()).stub;

const ask = (stub: Stub, request: BlameRequest) =>
  stub.blame(request) as unknown as Promise<BlameResult>;

async function answered(stub: Stub, request: BlameRequest): Promise<BlameAnswer> {
  const result = await ask(stub, request);
  if (!result.ok) throw new Error(`${result.failure.status} ${result.failure.code}`);
  return result.value;
}

async function failure(stub: Stub, request: BlameRequest) {
  const result = await ask(stub, request);
  return result.ok ? "answered" : { status: result.failure.status, code: result.failure.code };
}

/** Every page of a whole-file blame, following continuations until there are none. */
async function wholeFile(stub: Stub, path: string, perPage?: number): Promise<BlameAnswer[]> {
  const pages: BlameAnswer[] = [];
  let continuation: string | undefined;
  for (let guard = 0; guard < 200; guard++) {
    const page = await answered(stub, {
      path,
      ...(continuation && { continuation }),
      ...(perPage && { perPage }),
    });
    pages.push(page);
    if (page.next_continuation === null) return pages;
    continuation = page.next_continuation;
  }
  throw new Error("no end");
}

type Line =
  | { commit: string; line: number; summary: string; name: string; email: string; date: string }
  | { unresolved: string };

/** Each line of the file, from the ranges and facts of every page. */
function lines(pages: BlameAnswer[]): Line[] {
  const total = pages.at(-1)?.lines ?? 0;
  const out: Line[] = new Array(total);
  for (const page of pages)
    for (const range of page.ranges)
      for (let k = 0; k < range.line_count; k++) {
        if ("unresolved" in range) {
          out[range.start_line - 1 + k] = { unresolved: range.unresolved };
          continue;
        }
        const fact = page.commits[range.commit];
        if (!fact) throw new Error(`no facts for ${range.commit}`);
        out[range.start_line - 1 + k] = {
          commit: range.commit,
          line: range.source_start_line + k,
          summary: fact.summary,
          name: fact.author.name,
          email: fact.author.email,
          date: fact.author.date,
        };
      }
  return out;
}

const fromGit = (path: string): Line[] =>
  (fx.blames[path] ?? []).map((g) => ({
    commit: g.commit,
    line: g.line,
    summary: g.summary,
    name: g.name,
    email: g.email,
    date: `${g.time} ${g.tz}`,
  }));

describe("blame through the repository object", () => {
  it("blames a file to the end through continuations, as git does", async () => {
    const stub = await pushed();
    const pages = await wholeFile(stub, "f.txt");
    expect(lines(pages)).toEqual(fromGit("f.txt"));
    const last = pages.at(-1) as BlameAnswer;
    expect(last).toMatchObject({
      commit: fx.tip,
      path: "f.txt",
      blob: fx.blobs["f.txt"],
      state: "complete",
      lines: 6,
      resolved_lines: 6,
      unresolved_lines: 0,
      pending_lines: 0,
      next_continuation: null,
    });
  });

  it("pages through a run's ranges, each page from where the last left off", async () => {
    const stub = await pushed();
    const all = await wholeFile(stub, "f.txt");
    const ranges = all.flatMap((p) => p.ranges);
    const pages = await wholeFile(stub, "f.txt", 1);
    expect(pages.map((p) => p.ranges.length)).toEqual(ranges.map(() => 1));
    expect(pages.flatMap((p) => p.ranges)).toEqual(ranges);
    expect(lines(pages)).toEqual(fromGit("f.txt"));
  });

  it("states each refused line's reason, and counts it", async () => {
    const stub = await pushed();
    const octo = await wholeFile(stub, "o16.txt");
    expect(lines(octo)).toEqual([{ unresolved: "too_many_parents" }]);
    expect(octo.at(-1)).toMatchObject({ resolved_lines: 0, unresolved_lines: 1, pending_lines: 0 });
    const big = await wholeFile(stub, "big.txt");
    expect(lines(big)).toEqual([fromGit("big.txt")[0], { unresolved: "commit_info_too_large" }]);
  });

  it("gives a late viewer everything settled so far, from the start", async () => {
    const stub = await pushed();
    const first = await wholeFile(stub, "f.txt");
    const again = await answered(stub, { path: "f.txt" });
    expect(again.ranges).toEqual(first.flatMap((p) => p.ranges));
  });

  it("gives a window's ranges in line order, clipped to it, with no continuation", async () => {
    const stub = await pushed();
    await wholeFile(stub, "f.txt");
    const window = await answered(stub, { path: "f.txt", lineStart: 2, lineEnd: 4 });
    expect(window.next_continuation).toBeNull();
    const covered = window.ranges.flatMap((r: Range) =>
      Array.from({ length: r.line_count }, (_, k) => r.start_line + k),
    );
    expect(covered).toEqual([2, 3, 4]);
    expect(window.ranges.map((r: Range) => r.start_line)).toEqual(
      [...window.ranges.map((r: Range) => r.start_line)].sort((a, b) => a - b),
    );
    const whole = lines(await wholeFile(stub, "f.txt"));
    expect(lines([{ ...window, lines: 6 }]).slice(1, 4)).toEqual(whole.slice(1, 4));
  });

  it("refuses what it can't blame, with the error table's codes", async () => {
    const stub = await pushed();
    for (const [request, expected] of [
      [{ path: "nope.txt" }, { status: 404, code: "path_not_found" }],
      [{ path: "dir" }, { status: 404, code: "path_not_found" }],
      [{ path: "module" }, { status: 404, code: "path_not_found" }],
      [
        { path: "f.txt", ref: "no-such-branch" },
        { status: 404, code: "ref_not_found" },
      ],
      [{ path: "" }, { status: 422, code: "invalid_path" }],
      [{ path: "/f.txt" }, { status: 422, code: "invalid_path" }],
      [{ path: "a//b" }, { status: 422, code: "invalid_path" }],
      [{ path: "a/../f.txt" }, { status: 422, code: "invalid_path" }],
      [
        { path: "f.txt", continuation: "nope" },
        { status: 422, code: "invalid_continuation" },
      ],
    ] as [BlameRequest, unknown][])
      expect([request, await failure(stub, request)]).toEqual([request, expected]);
    const owner = await principalWithToken("user", "git");
    const empty = await createRepo(owner.principalId);
    expect(await failure(empty.stub, { path: "f.txt" })).toEqual({
      status: 409,
      code: "repo_empty",
    });
  });

  it("checks a continuation against the run it names", async () => {
    const { stub, repoId } = await pushedRepo();
    await wholeFile(stub, "f.txt");
    const row = await inRepo(stub, (repo) =>
      repo.git.context.storage.sql
        .exec<{ run_id: string; epoch_gen: number }>(
          "SELECT run_id, epoch_gen FROM blame_runs WHERE path = 'f.txt'",
        )
        .one(),
    );
    const fields = {
      v: 1 as const,
      repo: repoId,
      epoch: row.epoch_gen,
      commit: fx.tip,
      path: await pathDigest("f.txt"),
      engine: 1,
      run: row.run_id,
      offset: 0,
    };
    const valid = await answered(stub, { path: "f.txt", continuation: encodeBlameToken(fields) });
    expect(lines([valid])).toEqual(fromGit("f.txt"));
    for (const [change, expected] of [
      [{ path: await pathDigest("link") }, { status: 422, code: "invalid_continuation" }],
      [{ repo: "rep_01HZZZZZZZZZZZZZZZZZZZZZZZ" }, { status: 422, code: "invalid_continuation" }],
      [{ commit: "c".repeat(40) }, { status: 422, code: "invalid_continuation" }],
      [{ engine: 2 }, { status: 422, code: "invalid_continuation" }],
      [{ epoch: row.epoch_gen + 1 }, { status: 409, code: "blame_restarted" }],
      [{ run: "01J9ABCDEFGHJKMNPQRSTVWXYZ" }, { status: 409, code: "blame_restarted" }],
    ] as [Partial<typeof fields>, unknown][]) {
      const continuation = encodeBlameToken({ ...fields, ...change });
      expect([change, await failure(stub, { path: "f.txt", continuation })]).toEqual([
        change,
        expected,
      ]);
    }
    expect(
      await failure(stub, {
        path: "f.txt",
        continuation: encodeBlameToken(fields),
        lineStart: 1,
        lineEnd: 2,
      }),
    ).toEqual({ status: 422, code: "invalid_continuation" });
  });
});
