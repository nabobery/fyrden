// Fails when a commit in a range lacks a Developer Certificate of Origin
// sign-off from its author. CI runs it on every pull request:
//   node tools/ci/src/check-dco.ts <base-sha>..<head-sha>
// Merge commits are checked too: a merge can carry its own changes (conflict
// resolutions). Bring a branch up to date by rebasing instead of merging.
import { execFileSync } from "node:child_process";

export interface Commit {
  sha: string;
  authorName: string;
  authorEmail: string;
  parents: number;
  message: string;
}

const FIELD = "\x1f";
const RECORD = "\x1e";

export function readCommits(range: string, cwd = process.cwd()): Commit[] {
  const out = execFileSync(
    "git",
    ["log", `--format=%H${FIELD}%an${FIELD}%ae${FIELD}%P${FIELD}%B${RECORD}`, range],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return out
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [sha = "", authorName = "", authorEmail = "", parents = "", message = ""] =
        record.split(FIELD);
      return {
        sha,
        authorName,
        authorEmail,
        parents: parents.split(" ").filter(Boolean).length,
        message,
      };
    });
}

/** True when the message has `Signed-off-by: <name> <email>` with the author's email. */
export function isSignedOffByAuthor(commit: Commit): boolean {
  const email = commit.authorEmail.toLowerCase();
  return commit.message
    .split("\n")
    .map((line) => /^Signed-off-by:\s*.+\s<([^>]+)>\s*$/i.exec(line.trim()))
    .some((match) => match?.[1]?.toLowerCase() === email);
}

export function unsignedCommits(commits: Commit[]): Commit[] {
  return commits.filter((c) => !isSignedOffByAuthor(c));
}

if (import.meta.main) {
  const range = process.argv[2];
  if (!range) {
    console.error("usage: check-dco.ts <base>..<head>");
    process.exit(2);
  }
  const missing = unsignedCommits(readCommits(range));
  for (const c of missing) {
    console.error(
      `${c.sha.slice(0, 12)} by ${c.authorName} <${c.authorEmail}> has no matching Signed-off-by line`,
    );
  }
  if (missing.length > 0) {
    console.error("\nSign off each commit with `git commit -s` (see CONTRIBUTING.md).");
    process.exit(1);
  }
  console.log("DCO: every commit is signed off by its author.");
}
