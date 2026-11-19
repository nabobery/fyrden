// Fork jobs, run trust, first-time contributor approval, the approval
// binding and the token scope a job gets.
import { describe, expect, it } from "vitest";
import type { RepoRole } from "../../src/authz/roles.js";
import {
  type ApprovalBinding,
  approvalBindingText,
  effectiveScope,
  isForkJob,
  needsApproval,
  runTrust,
} from "../../src/ci/trust.js";
import type { PermissionScope, Permissions, Trigger } from "../../src/ci/workflow-schema.js";

const at = { line: 1, column: 1 };
const KINDS: readonly Trigger["event"][] = [
  "push",
  "pull_request",
  "pull_request_target",
  "schedule",
  "workflow_dispatch",
];

describe("isForkJob", () => {
  it.each([
    ["repo_a", null, false],
    ["repo_a", "repo_a", false],
    ["repo_a", "repo_b", true],
  ] as const)("base %s, head %s -> %s", (base, head, fork) => {
    expect(isForkJob(base, head)).toBe(fork);
  });
});

describe("runTrust", () => {
  it("distrusts only a pull_request from a fork", () => {
    for (const kind of KINDS) {
      expect(runTrust(kind, false)).toBe("trusted");
      expect(runTrust(kind, true)).toBe(kind === "pull_request" ? "untrusted" : "trusted");
    }
  });

  it("trusts a pull_request_target from a fork, which is still a fork job", () => {
    expect(runTrust("pull_request_target", isForkJob("repo_a", "repo_b"))).toBe("trusted");
  });
});

describe("needsApproval", () => {
  const writer = { role: "write" as RepoRole, hasMergedPull: false };
  const stranger = { role: null, hasMergedPull: false };
  const reader = { role: "read" as RepoRole, hasMergedPull: false };
  const contributor = { role: null, hasMergedPull: true };

  it.each([
    ["pull_request", true, stranger, stranger, true],
    ["pull_request_target", true, stranger, stranger, true],
    ["pull_request", false, stranger, stranger, false],
    ["pull_request_target", false, stranger, stranger, false],
    ["push", true, stranger, stranger, false],
    ["schedule", true, stranger, stranger, false],
    ["workflow_dispatch", true, stranger, stranger, false],
    ["pull_request", true, writer, writer, false],
    ["pull_request", true, contributor, contributor, false],
    ["pull_request", true, reader, reader, true],
    ["pull_request", true, { role: "triage", hasMergedPull: false }, writer, true],
    ["pull_request", true, { role: "admin", hasMergedPull: false }, writer, false],
    // A trusted author whose pull request a stranger pushed to.
    ["pull_request", true, writer, stranger, true],
    ["pull_request_target", true, contributor, reader, true],
    // A stranger's pull request updated by a writer still needs approval.
    ["pull_request", true, stranger, writer, true],
  ] as const)("%s fork=%s author=%j actor=%j -> %s", (kind, fork, author, actor, needed) => {
    expect(needsApproval({ kind, fork, author, actor })).toBe(needed);
  });
});

describe("approvalBindingText", () => {
  const base: ApprovalBinding = {
    runId: "01JRUN",
    workflowPath: ".github/workflows/ci.yml",
    workflowBlob: "f".repeat(40),
    checkoutSha: "c".repeat(40),
    event: "pull_request",
    action: "synchronize",
    kind: "pull_request",
    trust: "untrusted",
    fork: true,
  };

  it("is the same text for the same binding", () => {
    expect(approvalBindingText({ ...base })).toBe(approvalBindingText(base));
  });

  it.each([
    ["runId", "01JRUN2"],
    ["workflowPath", ".github/workflows/other.yml"],
    ["workflowBlob", "e".repeat(40)],
    ["checkoutSha", "d".repeat(40)],
    ["event", "pull_request_target"],
    ["action", "opened"],
    ["kind", "pull_request_target"],
    ["trust", "trusted"],
    ["fork", false],
  ] as const)("changes when %s changes", (field, value) => {
    expect(approvalBindingText({ ...base, [field]: value })).not.toBe(approvalBindingText(base));
  });

  it("cannot be confused across field boundaries", () => {
    const pairs: [ApprovalBinding, ApprovalBinding][] = [
      [
        { ...base, runId: "a", workflowPath: "b,c" },
        { ...base, runId: "a,b", workflowPath: "c" },
      ],
      [
        { ...base, event: "push", action: "" },
        { ...base, event: "", action: "push" },
      ],
      [
        { ...base, workflowPath: 'x","y' },
        { ...base, workflowPath: "x", workflowBlob: `y","${base.workflowBlob}` },
      ],
      [
        { ...base, action: "a\u0000b" },
        { ...base, action: "a", checkoutSha: "b" },
      ],
    ];
    for (const [a, b] of pairs) expect(approvalBindingText(a)).not.toBe(approvalBindingText(b));
  });

  it("fixes the attempt at 1", () => {
    expect(JSON.parse(approvalBindingText(base))).toContain(1);
  });
});

describe("effectiveScope", () => {
  const scopes = (...list: [PermissionScope, "read" | "write"][]): Permissions => ({
    kind: "scopes",
    scopes: list.map(([scope, access]) => ({ scope, access, at })),
    at,
  });
  const all = (access: "read" | "write"): Permissions => ({ kind: "all", access, at });
  const READ = ["contents:read", "metadata:read"];

  it.each([
    ["nothing declared", undefined, undefined, "trusted", READ],
    ["nothing declared, untrusted", undefined, undefined, "untrusted", READ],
    ["permissions {}", scopes(), undefined, "trusted", []],
    ["job permissions {}", all("write"), scopes(), "trusted", []],
    ["contents: read", scopes(["contents", "read"]), undefined, "trusted", READ],
    [
      "contents: write, capped to what Fyrden issues",
      scopes(["contents", "write"]),
      undefined,
      "trusted",
      READ,
    ],
    [
      "only scopes Fyrden cannot issue",
      scopes(["issues", "write"], ["checks", "read"]),
      undefined,
      "trusted",
      [],
    ],
    ["read-all", all("read"), undefined, "trusted", READ],
    ["write-all", all("write"), undefined, "trusted", READ],
    ["write-all on an untrusted run", all("write"), undefined, "untrusted", READ],
    [
      "job permissions replace the workflow's",
      scopes(["contents", "read"]),
      scopes(["issues", "write"]),
      "trusted",
      [],
    ],
    [
      "job permissions replace the default",
      undefined,
      scopes(["contents", "read"]),
      "trusted",
      READ,
    ],
    ["job read-all over workflow {}", scopes(), all("read"), "untrusted", READ],
  ] as const)("%s", (_name, workflowPermissions, jobPermissions, trust, expected) => {
    expect(effectiveScope({ workflowPermissions, jobPermissions, trust })).toStrictEqual(expected);
  });
});
