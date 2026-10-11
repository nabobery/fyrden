// Building blocks the ported cases share: a seeded history pushed to both
// Fyrden and the oracle, clone-and-compare, and hand-made protocol requests.
import { expect } from "vitest";
import type { Interop, Remotes } from "../harness.ts";

export interface Seeded {
  /** The working repository the history was made in. */
  readonly work: string;
  readonly remotes: Remotes;
}

/**
 * A history pushed to both remotes: main with four commits (a tag `v1` on
 * the second, a lightweight `light` on the third), and `feature` branching
 * off the second.
 */
export async function seeded(t: Interop, name: string): Promise<Seeded> {
  const remotes = await t.remotes(name);
  const work = `${name}-work`;
  await t.ok(["init", "-q", work]);
  await t.commit(work, { "README.md": "hello\n", "src/a.txt": "a1\n" }, "one");
  await t.commit(work, { "src/a.txt": "a2\n", "src/b.txt": "b1\n" }, "two");
  await t.ok(["tag", "-a", "v1", "-m", "release one"], work);
  await t.ok(["checkout", "-q", "-b", "feature"], work);
  await t.commit(work, { "docs/guide.md": "guide\n" }, "feature");
  await t.ok(["checkout", "-q", "main"], work);
  await t.commit(work, { "src/b.txt": "b2\n", "src/deep/c.txt": "c\n" }, "three");
  await t.ok(["tag", "light"], work);
  await t.commit(work, { "src/a.txt": null, "big.txt": "x".repeat(50_000) }, "four");
  await pushBoth(t, work, remotes, ["refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"]);
  return { work, remotes };
}

/** Pushes the same refspecs to both remotes; both must succeed. */
export async function pushBoth(
  t: Interop,
  work: string,
  remotes: Remotes,
  refspecs: string[],
  flags: string[] = [],
): Promise<void> {
  await t.ok(["push", "-q", ...flags, remotes.fyrden, ...refspecs], work);
  await t.ok(["push", "-q", ...flags, remotes.oracle, ...refspecs], work);
}

/** Runs the same git command against each remote: `args(url, side)`. */
export async function onBoth(
  t: Interop,
  remotes: Remotes,
  args: (url: string, side: "fyrden" | "oracle") => string[],
  cwd?: (side: "fyrden" | "oracle") => string | undefined,
) {
  const fyrden = await t.git(args(remotes.fyrden, "fyrden"), { cwd: cwd?.("fyrden") });
  const oracle = await t.git(args(remotes.oracle, "oracle"), { cwd: cwd?.("oracle") });
  return { fyrden, oracle };
}

/** Clones both remotes with the same flags into `<dir>` and `<dir>-oracle`. */
export async function cloneBoth(
  t: Interop,
  remotes: Remotes,
  dir: string,
  flags: string[] = [],
): Promise<{ fyrden: string; oracle: string }> {
  await t.ok(["clone", "-q", ...flags, remotes.fyrden, dir]);
  await t.ok(["clone", "-q", ...flags, remotes.oracle, `${dir}-oracle`]);
  return { fyrden: dir, oracle: `${dir}-oracle` };
}

/**
 * The repository fetched from Fyrden is complete and consistent (fsck) and
 * holds the same refs, objects and shallow boundary as the one fetched
 * from git's own server.
 */
export async function expectSameRepository(
  t: Interop,
  dirs: { fyrden: string; oracle: string },
): Promise<void> {
  await t.fsck(dirs.fyrden);
  expect(await t.refs(dirs.fyrden)).toEqual(await t.refs(dirs.oracle));
  expect(await t.shallow(dirs.fyrden)).toEqual(await t.shallow(dirs.oracle));
  expect(await t.objects(dirs.fyrden)).toEqual(await t.objects(dirs.oracle));
}

/** Both remotes list the same refs. */
export async function expectSameRefs(t: Interop, remotes: Remotes): Promise<void> {
  expect(await t.lsRemote(remotes.fyrden)).toEqual(await t.lsRemote(remotes.oracle));
}

/** Lines of `git push --porcelain` output without the `To <url>` line. */
export function porcelain(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.length > 0 && !line.startsWith("To "));
}

const encoder = new TextEncoder();

/** A pkt-line: four hex digits of length, then the payload. */
export function pkt(payload: string): string {
  return `${(encoder.encode(payload).length + 4).toString(16).padStart(4, "0")}${payload}`;
}
export const FLUSH = "0000";
export const DELIM = "0001";

/** POSTs a hand-made protocol v2 request to a Fyrden repository's upload-pack. */
export async function postUploadPack(t: Interop, name: string, body: string): Promise<string> {
  const basic = Buffer.from(`x-access-token:${t.token}`).toString("base64");
  const res = await fetch(t.server.repoUrl(t.repoName(name)).concat("/git-upload-pack"), {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-git-upload-pack-request",
      Accept: "application/x-git-upload-pack-result",
      "Git-Protocol": "version=2",
    },
    body,
  });
  return `${res.status} ${await res.text()}`;
}

/**
 * The requests wrangler dev's access log recorded for a repository since
 * `from` (an offset into the server output), as "METHOD /path status" with
 * the path relative to the repository (wrangler logs it without the query).
 */
export function requestsTo(t: Interop, name: string, from: number): string[] {
  const path = `/${t.server.handle}/${t.repoName(name)}.git`;
  return t.server
    .output()
    .slice(from)
    .split("\n")
    .flatMap((line) => {
      const [, method, url, status] =
        /^\[wrangler:info\] (GET|POST) (\S+) (\d{3})/.exec(line) ?? [];
      return url?.startsWith(`${path}/`) ? [`${method} ${url.slice(path.length)} ${status}`] : [];
    });
}

/**
 * The requests to repository `name` logged since `from`, once `expected`
 * holds for them, or as they stand after `timeoutMs`: wrangler dev logs each
 * request after its response, asynchronously, so they may not all be there
 * when git exits. A timeout leaves the assertion that follows to fail.
 */
export async function loggedRequests(
  t: Interop,
  name: string,
  from: number,
  expected: (seen: string[]) => boolean,
  timeoutMs = 10_000,
): Promise<string[]> {
  await t.server.waitForOutput(() => expected(requestsTo(t, name, from)), timeoutMs);
  return requestsTo(t, name, from);
}
