// Branches, tags, commits, the log and comparisons through the REST API,
// checked against what git answers about the same repository (built by
// test/setup/browse-fixtures.ts and pushed here as git would push it).

import { exports } from "cloudflare:workers";
import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { type BrowsePolicy, decoderForLabel, RepoBrowse } from "../src/do/repo/browse.js";
import { BROWSE_LOGS, BROWSE_PAIRS, type OracleCommit } from "./helpers/browse-fixtures.js";
import { ORIGIN } from "./helpers/git-http.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush, pushTarget } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("browseFixtures");

let target: PushTarget;
let pat: string;
let base: string;

async function get<T = Record<string, unknown>>(
  path: string,
  token = pat,
): Promise<{ status: number; body: T }> {
  const res = await exports.default.fetch(`${ORIGIN}/api${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.json<T>() };
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(".000Z", "Z");

/** The commit as the API should show it. */
function expected(c: OracleCommit) {
  return {
    sha: c.sha,
    commit: {
      message: c.message,
      author: { name: c.authorName, email: c.authorEmail, date: iso(c.authorTime) },
      committer: { name: c.committerName, email: c.committerEmail, date: iso(c.committerTime) },
      tree: { sha: c.tree },
    },
    parents: c.parents.map((sha) => ({ sha })),
  };
}

const commitOf = (sha: string) => expected(fx.commits[sha] as OracleCommit);

/** Every item of a paged listing, `perPage` at a time. */
async function allPages(kind: "branches" | "tags", perPage: number): Promise<unknown[]> {
  const items: unknown[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 50; pages++) {
    const query = new URLSearchParams({ per_page: String(perPage) });
    if (cursor) query.set("cursor", cursor);
    const res = await get<Record<string, unknown[]> & { next_cursor: string | null }>(
      `${base}/${kind}?${query}`,
    );
    expect(res.status).toBe(200);
    items.push(...(res.body[kind] as unknown[]));
    cursor = res.body.next_cursor;
    if (!cursor) return items;
  }
  throw new Error("the listing does not end");
}

beforeAll(async () => {
  target = await pushTarget();
  pat = await scopedToken(target.owner.principalId, [], "pat");
  const reply = await postPush(
    target,
    pushBody(
      fx.refs.map((r) => ({ old: ZERO, new: r.oid, ref: r.name })),
      { pack: fx.packHex },
    ),
  );
  expect(reply.status).toBe(200);
  expect(reply.report.filter((line) => line.startsWith("ng"))).toEqual([]);
  base = `/repos/${target.owner.principalId.toLowerCase().replace("_", "-")}/${target.repo.name}`;
});

describe("branches and tags", () => {
  it("lists branches by name with their commits, a page at a time", async () => {
    const heads = fx.refs
      .filter((r) => r.name.startsWith("refs/heads/"))
      .map((r) => ({ name: r.name.slice("refs/heads/".length), commit: { sha: r.oid } }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    expect(await allPages("branches", 1)).toEqual(heads.map((h) => ({ ...h, protected: false })));
    expect(await allPages("branches", 100)).toHaveLength(heads.length);
  });

  it("gets a branch whose name has a slash and non-ASCII letters", async () => {
    const res = await get(`${base}/branches/${encodeURIComponent("feature/ü-slash")}`);
    expect(res.status).toBe(200);
    const res2 = await get(`${base}/branches/feature/${encodeURIComponent("ü-slash")}`);
    expect(res2.body).toEqual({
      name: "feature/ü-slash",
      commit: commitOf(fx.revs["feature/ü-slash"] as string),
      protected: false,
    });
    expect((await get(`${base}/branches/nope`)).status).toBe(404);
  });

  it("lists tags peeled to their commits, leaving out a tag of a tree, a page at a time", async () => {
    const tags = [
      { name: "v1", commit: { sha: fx.revs.v1 } },
      { name: "v1-light", commit: { sha: fx.revs["v1-light"] } },
    ];
    expect(await allPages("tags", 30)).toEqual(tags);
    // "tree-tag" sorts first: the first page of one skips it and still finds v1.
    expect(await allPages("tags", 1)).toEqual(tags);
  });
});

describe("commits", () => {
  it("gets one commit by SHA, branch, tag or full ref name, as git shows it", async () => {
    const main = fx.revs.main as string;
    for (const ref of [main, "main", "refs/heads/main"])
      expect((await get(`${base}/commits/${ref}`)).body).toEqual(commitOf(main));
    expect((await get(`${base}/commits/v1`)).body).toEqual(commitOf(fx.revs.v1 as string));
    // A merge commit lists both parents; a commit with another author keeps both people.
    const merge = Object.values(fx.commits).find((c) => c.parents.length === 2) as OracleCommit;
    expect((await get(`${base}/commits/${merge.sha}`)).body).toEqual(expected(merge));
    expect((await get(`${base}/commits/${"0".repeat(40)}`)).status).toBe(404);
    expect((await get(`${base}/commits/tree-tag`)).status).toBe(404);
    // A branch named like a commit id the repository lacks resolves by name.
    const shaNamed = fx.refs.find((r) => r.name === `refs/heads/${"a".repeat(40)}`)?.oid as string;
    expect((await get(`${base}/commits/${"a".repeat(40)}`)).body).toEqual(commitOf(shaNamed));
  });

  it("decodes ISO-8859 labels as ISO-8859, not as the Windows code pages the web maps them to", () => {
    const c1 = Uint8Array.of(0x41, 0x80, 0x81, 0x91, 0xe9);
    for (const label of ["ISO-8859-1", "csisolatin1", "iso_8859-1:1987", "latin1", "cp819"])
      expect(decoderForLabel(label).decode(c1), label).toBe("A\u0080\u0081\u0091é");
    // ISO-8859-9 differs from Latin-1 above 0x9f only.
    expect(decoderForLabel("iso-8859-9").decode(Uint8Array.of(0x80, 0xfd))).toBe("\u0080ı");
    for (const label of ["windows-1252", "cp1252"])
      expect(decoderForLabel(label).decode(c1), label).toBe("A€\u0081‘é");
    expect(decoderForLabel("no-such-encoding").decode(Uint8Array.of(0xc3, 0xa9))).toBe("é");
  });

  it("decodes a commit in the encoding it declares", async () => {
    const res = await get<{ commit: { message: string; author: { name: string } } }>(
      `${base}/commits/latin1`,
    );
    expect(res.body.commit.author.name).toBe("André");
    expect(res.body.commit.message).toBe("Café\u0080\n");
  });

  it("lists the history of each revision, and of each path, as git log does", async () => {
    for (const rev of BROWSE_LOGS.revs) {
      for (const path of [undefined, ...BROWSE_LOGS.paths]) {
        const key = path ? `${rev} -- ${path}` : rev;
        const shas: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const query = new URLSearchParams({ per_page: "2" });
          if (cursor) query.set("cursor", cursor);
          else query.set("sha", rev);
          if (path) query.set("path", path);
          const res = await get<{ commits: { sha: string }[]; next_cursor: string | null }>(
            `${base}/commits?${query}`,
          );
          expect(res.status, key).toBe(200);
          shas.push(...res.body.commits.map((c) => c.sha));
          cursor = res.body.next_cursor;
          pages++;
        } while (cursor && pages < 50);
        expect(shas, key).toEqual(fx.logs[key]);
      }
    }
  });

  it("lists the default branch without sha, with whole commits", async () => {
    const res = await get<{ commits: unknown[] }>(`${base}/commits?per_page=3`);
    expect(res.body.commits).toEqual((fx.logs.main as string[]).slice(0, 3).map(commitOf));
  });

  it("ends a page when its R2 reads run out, with a cursor that goes on", async () => {
    const browse = (policy: Partial<BrowsePolicy>, cursor?: string[]) =>
      inRepo(target.repo.stub, async ({ git }) => {
        const b = new RepoBrowse({ git, memoryBlocks: createClockBlockCache(), policy });
        try {
          return await b.log({
            ...(cursor ? { cursor } : { ref: "main" }),
            path: "README.md",
            limit: 100,
          });
        } finally {
          b.close();
        }
      });
    // No reads allowed: one commit examined (the tip, which leaves README.md alone), then the page ends.
    const first = await browse({ walkReads: 0 });
    expect(first).toMatchObject({ ok: true, value: { commits: [] } });
    const next = first.ok ? [...first.value.next] : [];
    expect(next).toHaveLength(1);
    // Going on from there, with reads to spare, finds the rest.
    const rest = await browse({}, next);
    expect(rest.ok && rest.value.commits.map((c) => c.sha)).toEqual(fx.logs["main -- README.md"]);
  });

  it("never makes more storage reads than allowed: a shorter page that resumes, or a refusal", async () => {
    // main pushed a commit at a time, so its commits are in as many packs.
    const stepped = await pushTarget();
    let previous = ZERO;
    for (const step of fx.mainSteps) {
      const reply = await postPush(
        stepped,
        pushBody([{ old: previous, new: step.commit, ref: "refs/heads/main" }], {
          pack: step.packHex,
        }),
      );
      expect(reply.report.filter((line) => line.startsWith("ng"))).toEqual([]);
      previous = step.commit;
    }
    const page = (maxReads: number, cursor?: string[]) =>
      inRepo(stepped.repo.stub, async ({ git }) => {
        const b = new RepoBrowse({
          git,
          memoryBlocks: createClockBlockCache(),
          // Pack blocks from R2 only, so showing commits costs reads too.
          policy: { maxReads, cacheCalls: 0 },
        });
        try {
          return await b.log({ ...(cursor ? { cursor } : { ref: "main" }), limit: 100 });
        } finally {
          b.close();
        }
      });
    const whole = fx.logs.main as string[];
    const outcomes = new Set<string>();
    for (let maxReads = 0; maxReads <= 60; maxReads++) {
      const first = await page(maxReads);
      if (!first.ok) {
        expect(first.code).toBe("too_expensive");
        outcomes.add("refused");
        continue;
      }
      const shown = first.value.commits.map((c) => c.sha);
      expect(shown).toEqual(whole.slice(0, shown.length));
      const rest = first.value.next.length > 0 ? await page(1_000, [...first.value.next]) : null;
      const after = rest?.ok ? rest.value.commits.map((c) => c.sha) : [];
      expect([...shown, ...after], `maxReads ${maxReads}`).toEqual(whole);
      outcomes.add(shown.length < whole.length ? "partial" : "whole");
    }
    // The range of budgets covers a refusal, a short page and a whole one.
    expect([...outcomes].sort()).toEqual(["partial", "refused", "whole"]);
  });

  it("answers a request that runs out of reads or room, instead of failing", async () => {
    const run = <T>(policy: Partial<BrowsePolicy>, use: (b: RepoBrowse) => Promise<T>) =>
      inRepo(target.repo.stub, async ({ git }) => {
        const b = new RepoBrowse({ git, memoryBlocks: createClockBlockCache(), policy });
        try {
          return await use(b);
        } finally {
          b.close();
        }
      });
    const noReads = { maxReads: 0, cacheCalls: 0 };
    // Peeling an annotated tag needs reads, even before anything is shown.
    expect(await run(noReads, (b) => b.commit("v1"))).toMatchObject({ code: "too_expensive" });
    expect(await run(noReads, (b) => b.tags("", 10))).toMatchObject({ code: "too_expensive" });
    expect(await run(noReads, (b) => b.compare("v1", "main"))).toMatchObject({
      code: "too_expensive",
    });
    // Commit text past the response budget: a single commit fails, a page ends early.
    expect(await run({ maxResponseBytes: 10 }, (b) => b.commit("main"))).toMatchObject({
      code: "too_large",
    });
    const page = await run({ maxResponseBytes: 2_000 }, (b) => b.log({ ref: "main", limit: 100 }));
    const shown = page.ok ? page.value.commits.map((c) => c.sha) : [];
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan((fx.logs.main as string[]).length);
    const rest = await run({}, (b) =>
      b.log({ cursor: page.ok ? [...page.value.next] : [], limit: 100 }),
    );
    expect([...shown, ...(rest.ok ? rest.value.commits.map((c) => c.sha) : [])]).toEqual(
      fx.logs.main,
    );
  });

  it("refuses a cursor it did not make and a path that names nothing", async () => {
    expect((await get(`${base}/commits?cursor=AAAA`)).body).toMatchObject({
      code: "invalid_cursor",
    });
    expect((await get(`${base}/commits?path=a//b`)).body).toMatchObject({
      code: "invalid_path",
    });
    expect((await get(`${base}/commits?sha=nope`)).status).toBe(404);
  });
});

describe("compare", () => {
  it("counts ahead and behind and finds the merge base, as git does", async () => {
    for (const [a, b] of BROWSE_PAIRS) {
      const res = await get<{
        status: string;
        ahead_by: number;
        behind_by: number;
        merge_base_commit: { sha: string } | null;
        base_commit: { sha: string };
        commits: { sha: string }[];
      }>(`${base}/compare/${encodeURIComponent(a)}...${encodeURIComponent(b)}`);
      expect(res.status).toBe(200);
      const ahead = fx.counts[`${a}..${b}`] as number;
      const behind = fx.counts[`${b}..${a}`] ?? 0;
      expect(res.body.ahead_by, `${a}...${b}`).toBe(ahead);
      expect(res.body.merge_base_commit?.sha).toBe(fx.mergeBases[`${a} ${b}`]);
      expect(res.body.base_commit.sha).toBe(fx.revs[a]);
      expect(res.body.commits).toHaveLength(ahead);
      if (a === b) expect(res.body.status).toBe("identical");
      else expect(res.body.behind_by).toBe(behind);
    }
    // feature/ü-slash...main: main has the merge and later commits; feature is behind only.
    const feature = await get<{ status: string; commits: { sha: string }[] }>(
      `${base}/compare/${encodeURIComponent("feature/ü-slash")}...main`,
    );
    expect(feature.body.status).toBe("ahead");
    // Oldest first.
    expect(feature.body.commits.map((c) => c.sha)).toEqual(
      (fx.logs.main as string[])
        .filter((sha) => !(fx.logs["feature/ü-slash"] as string[]).includes(sha))
        .reverse(),
    );
    expect((await get(`${base}/compare/main`)).body).toMatchObject({ code: "invalid_basehead" });
  });
});

describe("commit context", () => {
  it("never shows a fork's commit through its parent, though they share packs", async () => {
    const forkName = uniqueId("fork");
    const forked = await exports.default.fetch(`${ORIGIN}/api${base}/forks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ name: forkName }),
    });
    expect(forked.status).toBe(201);
    const forkPath = base.replace(target.repo.name, forkName);
    const reply = await postPush(
      { ...target, path: `${forkPath.slice("/repos".length)}.git` },
      pushBody([{ old: ZERO, new: fx.siblingCommit, ref: "refs/heads/sibling" }], {
        pack: fx.siblingPackHex,
      }),
    );
    expect(reply.report.filter((line) => line.startsWith("ng"))).toEqual([]);
    expect((await get(`${forkPath}/commits/${fx.siblingCommit}`)).status).toBe(200);
    expect((await get(`${base}/commits/${fx.siblingCommit}`)).status).toBe(404);
    expect((await get(`${base}/commits?sha=${fx.siblingCommit}`)).status).toBe(404);
    expect((await get(`${base}/compare/main...${fx.siblingCommit}`)).status).toBe(404);
  });

  it("is not readable without read access", async () => {
    const stranger = await scopedToken((await pushTarget()).owner.principalId, [], "pat");
    expect((await get(`${base}/commits`, stranger)).status).toBe(404);
    expect((await get(`${base}/branches`, stranger)).status).toBe(404);
  });
});
