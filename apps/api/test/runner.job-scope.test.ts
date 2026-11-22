// The scope of the job token a task carries, computed when the run assigns
// the task: the job's `permissions:` replace the workflow's, which replace
// the default (contents read); an untrusted run gets read at most, and
// Fyrden issues nothing past git read. A job whose permissions grant none
// of that gets no token at all: an empty scope list would mean the
// principal's full rights.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { approvalBinding } from "../src/ci/approval.js";
import type { RunSpec } from "../src/do/run/spec.js";
import { decodeTask } from "./helpers/runner-proto.js";
import { jobTokensOf, orgRepo, registerRunner } from "./helpers/runners.js";
import { drain, type Fixture, job, jobNamed, runStub, specFor, started } from "./helpers/runs.js";

type OrgFixture = Fixture & { org: { id: string; login: string } };

const source = (workflowLines: string[], jobLines: string[]) =>
  ["name: ci", "on: push", ...workflowLines, "jobs:", job("a", jobLines)].join("\n");

/**
 * Starts the run of `spec` (approved first when it waits for an
 * approval) and has it assign job `a` as an offer made by hand: the run
 * mints the token whatever the dispatch index would offer.
 */
async function assigned(f: OrgFixture, spec: RunSpec) {
  const runId = await started(f, spec.workflow.source, spec);
  const binding = await approvalBinding(spec);
  if (binding !== null) {
    expect(await runStub(runId).approve(binding, f.owner.principalId)).toEqual({ ok: true });
    await drain(runId);
  }
  const { jobId } = await jobNamed(runId, "a");
  const runner = await registerRunner(f.org.login, f.owner);
  const offer = await env.DIRECTORY.prepare(
    `INSERT INTO ci_tasks (run_id, job_id, runner_id, offered_version, created_at)
     VALUES (?, ?, ?, 0, ?) RETURNING id`,
  )
    .bind(runId, jobId, runner.id, Date.now())
    .first<{ id: number }>();
  const wireId = offer?.id ?? 0;
  const answer = await runStub(runId).assignTask(wireId, jobId, runner.id, f.org.id);
  if (!("task" in answer)) throw new Error(`refused: ${answer.refused}`);
  return { task: decodeTask(answer.task), tokens: await jobTokensOf(wireId) };
}

const scopesOf = (tokens: { scopes: string }[]) => tokens.map((t) => JSON.parse(t.scopes));

describe("a job token's scope", () => {
  it("is the default, contents read, when nothing is declared", async () => {
    const f = await orgRepo();
    const { tokens } = await assigned(f, specFor(f, source([], [])));
    expect(scopesOf(tokens)).toEqual([["contents:read", "metadata:read"]]);
  });

  // Not a fork: a fork job is never assigned (runner-eligibility.test.ts).
  it("is read only for an approved untrusted run asking for write-all", async () => {
    const f = await orgRepo();
    const spec = specFor(f, source(["permissions: write-all"], ["permissions: write-all"]), {
      event: "pull_request",
      ref: "refs/pull/1/head",
      github: { event_name: "pull_request", workflow: "ci" },
      trust: "untrusted",
      fork: false,
      approval: { workflowBlob: "c".repeat(40), action: "opened" },
    });
    const { tokens } = await assigned(f, spec);
    expect(scopesOf(tokens)).toEqual([["contents:read", "metadata:read"]]);
  });

  it("follows the job's own permissions over the workflow's", async () => {
    const f = await orgRepo();
    const { tokens } = await assigned(
      f,
      specFor(f, source(["permissions: write-all"], ["permissions:", "  contents: read"])),
    );
    expect(scopesOf(tokens)).toEqual([["contents:read", "metadata:read"]]);
  });

  for (const [name, workflowLines, jobLines] of [
    ["permissions: {} on the job", ["permissions: write-all"], ["permissions: {}"]],
    ["permissions: {} on the workflow", ["permissions: {}"], []],
    ["a job granted only scopes Fyrden does not issue", [], ["permissions:", "  issues: write"]],
  ] as const)
    it(`is no token at all for ${name}: the job cannot read the repository`, async () => {
      const f = await orgRepo();
      const { task, tokens } = await assigned(
        f,
        specFor(f, source([...workflowLines], [...jobLines])),
      );
      expect(tokens).toEqual([]);
      expect(task.context?.token).toBe("");
      expect(task.secrets.get("GITHUB_TOKEN")).toBe("");
      expect(task.secrets.get("GITEA_TOKEN")).toBe("");
    });
});
