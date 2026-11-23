// CI runs started from pushes: the trigger inbox is written with the push,
// and the trigger job (run explicitly here) reads the workflow files at the
// pushed commit, matches each one's `on:` against the push, and starts one
// run per matching workflow, exactly once per event and workflow. Workflows
// that fail to plan give a failed run and one named check.
import { env } from "cloudflare:workers";
import { checkText } from "@fyrden/domain";
import { type Oid, oidFromHex, PackError } from "@fyrden/git-core";
import { uniqueId } from "@fyrden/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import {
  CI_TRIGGERS_JOB,
  EXHAUSTED_RETRY_MS,
  MAX_EVENT_ATTEMPTS,
  TRIGGER_WORK,
} from "../src/do/repo/ci-triggers.js";
import { ReadsMemoryBusy, UnreadableObjectError } from "../src/do/repo/held-reads.js";
import { workflowFileCheckName } from "../src/do/run/plan-check.js";
import { api, json, user } from "./helpers/api.js";
import {
  type CiRepo,
  ciRepo,
  commit,
  countingDirectory,
  countingRuns,
  type EventRow,
  eventRunsOf,
  eventsOf,
  githubOf,
  pushRefs,
  runTriggers,
  setVar,
  switchCi,
  switchRepoCi,
  viewOf,
  workflowFile,
} from "./helpers/ci-triggers.js";
import { commit as buildCommit, packOf } from "./helpers/pack-build.js";
import { ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";
import {
  advance,
  at,
  drain,
  jobsOf,
  runStub,
  specFor,
  started,
  T0,
  workflow,
} from "./helpers/runs.js";
import { logs } from "./setup/log-capture.js";

const CI = ".github/workflows/ci.yml";

beforeAll(() => switchCi(true));
afterAll(() => switchCi(false));

/** The runs the repository allocated, oldest event first. */
const runIds = async (f: CiRepo) => (await eventRunsOf(f.stub)).map((r) => r.run_id);

/** SHA-256 of `text` as 64 hex digits. */
async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The repository's check summaries on `sha`, by name. */
const checksOn = async (f: CiRepo, sha: string) =>
  new Map(
    (await inRepo(f.stub, (r: RepoDO) => r.checks.summariesOn(sha))).map((row) => [row.name, row]),
  );

/** Each run's due jobs run at a fixed clock, then a minute on, so its checks reach the repository. */
async function settle(runIds: readonly string[]) {
  for (const id of runIds) {
    await at(id, T0);
    await drain(id);
    await advance(id, 60_000);
  }
}

describe("push triggers", () => {
  it("cost one tree read for a push to a repository without workflows: no run object, no directory query", async () => {
    const f = await ciRepo({ "a.txt": "one\n" });
    // The push wrote its inbox row, the default branch's schedule refresh after it, and the job,
    // in its own transaction.
    const recorded = await inRepo(f.stub, (r: RepoDO) => ({
      events: r.git.context.storage.sql.exec("SELECT 1 FROM ci_events").toArray().length,
      job: r.git.jobs.get(CI_TRIGGERS_JOB)?.state,
    }));
    expect(recorded).toEqual({ events: 2, job: "queued" });
    const spent = await inRepo(f.stub, async (r: RepoDO) => {
      const count = { runs: 0, d1: 0 };
      r.ciTriggers.bindings = {
        RUN: countingRuns(count),
        DIRECTORY: countingDirectory(count),
        ORG: env.ORG,
      };
      const before = { ...r.ciTriggers.work };
      const ran = await r.git.jobs.runJob(
        CI_TRIGGERS_JOB,
        r.ciTriggers.handler(),
        r.git.memory,
        r.git.context.now() + 60_000,
      );
      return {
        state: ran.state,
        ...count,
        trees: r.ciTriggers.work.trees - before.trees,
        blobs: r.ciTriggers.work.blobs - before.blobs,
      };
    });
    // The refresh reads the listing the push read.
    expect(spent).toEqual({ state: "done", runs: 0, d1: 0, trees: 1, blobs: 0 });
    expect(await eventsOf(f.stub, { refreshes: true })).toMatchObject([
      { kind: "push", state: "done", outcome: null },
      { kind: "schedule_refresh", state: "done", outcome: null },
    ]);
    expect(await eventRunsOf(f.stub)).toEqual([]);
  });

  it("start one run per matching workflow with the github context the runner reads", async () => {
    const f = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
    expect((await runTriggers(f.stub)).state).toBe("done");
    const [first] = await eventRunsOf(f.stub);
    if (!first) throw new Error("no run");
    expect(first).toMatchObject({ trigger_kind: "push", workflow_path: CI, run_number: 1 });
    const view = await viewOf(first.run_id);
    const full = `${f.owner.handle}/${f.repo.name}`;
    expect(view).toMatchObject({
      event: "push",
      ref: "refs/heads/main",
      workflowPath: CI,
      actor: f.owner.principalId,
      trust: "trusted",
      fork: false,
      conclusion: null,
    });
    const github = await githubOf(first.run_id);
    expect(github).toMatchObject({
      event_name: "push",
      ref: "refs/heads/main",
      ref_name: "main",
      ref_type: "branch",
      sha: view.sha,
      head_ref: "",
      base_ref: "",
      repository: full,
      repository_id: f.repo.id,
      repository_owner: f.owner.handle,
      repository_owner_id: f.owner.principalId,
      actor: f.owner.handle,
      actor_id: f.owner.principalId,
      workflow: "ci",
      workflow_ref: `${full}/${CI}@refs/heads/main`,
      workflow_sha: view.sha,
      run_id: first.run_id,
      run_number: "1",
      server_url: "https://fyrden.test",
      retention_days: "90",
    });
    expect(github.event).toMatchObject({
      ref: "refs/heads/main",
      before: ZERO,
      after: view.sha,
      created: true,
      deleted: false,
      head_commit: { id: view.sha, message: "first" },
      repository: { full_name: full, default_branch: "main" },
      sender: { login: f.owner.handle, id: f.owner.principalId },
    });
    // The next push numbers its run after the first.
    const next = await commit(f, "main", { "a.txt": "two\n" });
    await runTriggers(f.stub);
    const runs = await eventRunsOf(f.stub);
    expect(runs.map((r) => r.run_number)).toEqual([1, 2]);
    const second = await githubOf(runs[1]?.run_id ?? "");
    expect(second).toMatchObject({ sha: next, run_number: "2" });
    expect(second.event).toMatchObject({ before: view.sha, after: next, created: false });
  });

  it("apply branches-ignore, tags and paths filters", async () => {
    const f = await ciRepo({
      ".github/workflows/branches.yml": workflowFile("{ push: { branches-ignore: ['skip/**'] } }"),
      ".github/workflows/tags.yml": workflowFile("{ push: { tags: ['v*'] } }", "tags"),
      ".github/workflows/paths.yml": workflowFile("{ push: { paths: ['src/**'] } }", "paths"),
    });
    await runTriggers(f.stub);
    // A new branch counts a paths filter as matched; a branch push skips a tags-only workflow.
    const firstPaths = (await eventRunsOf(f.stub)).map((r) => r.workflow_path).sort();
    expect(firstPaths).toEqual([".github/workflows/branches.yml", ".github/workflows/paths.yml"]);
    const main = await commit(f, "main", { "docs/a.md": "docs\n" });
    expect(await pushRefs(f, [{ old: ZERO, new: main, ref: "refs/heads/skip/x" }])).toContain(
      "ok refs/heads/skip/x",
    );
    await commit(f, "main", { "src/a.ts": "code\n" });
    expect(await pushRefs(f, [{ old: ZERO, new: main, ref: "refs/tags/v1" }])).toContain(
      "ok refs/tags/v1",
    );
    expect(await pushRefs(f, [{ old: ZERO, new: main, ref: "refs/tags/x1" }])).toContain(
      "ok refs/tags/x1",
    );
    await runTriggers(f.stub);
    const events = await eventsOf(f.stub);
    const byEvent = new Map<number, string[]>();
    for (const run of await eventRunsOf(f.stub))
      byEvent.set(run.event_id, [...(byEvent.get(run.event_id) ?? []), run.workflow_path]);
    const pathsOf = (key: RegExp) => {
      const event = events.find((e) => key.test(e.key));
      return (byEvent.get(event?.id ?? -1) ?? []).sort();
    };
    expect(events.map((e) => e.state)).toEqual(events.map(() => "done"));
    const [, docs, , code] = events;
    // docs only: the paths filter does not match.
    expect((byEvent.get(docs?.id ?? -1) ?? []).sort()).toEqual([".github/workflows/branches.yml"]);
    // The ignored branch: only the paths filter, matched as the push created the branch.
    expect(pathsOf(/:refs\/heads\/skip\/x$/)).toEqual([".github/workflows/paths.yml"]);
    expect((byEvent.get(code?.id ?? -1) ?? []).sort()).toEqual([
      ".github/workflows/branches.yml",
      ".github/workflows/paths.yml",
    ]);
    // A tag push: tags filters only, and paths are not evaluated for tags.
    expect(pathsOf(/:refs\/tags\/v1$/)).toEqual([
      ".github/workflows/paths.yml",
      ".github/workflows/tags.yml",
    ]);
    expect(pathsOf(/:refs\/tags\/x1$/)).toEqual([".github/workflows/paths.yml"]);
  });

  it("run for a merge, and never for a branch deletion", async () => {
    const f = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
    const main = (await eventsOf(f.stub)).length;
    const base = await commit(f, "main", { "a.txt": "two\n" });
    expect(await pushRefs(f, [{ old: ZERO, new: base, ref: "refs/heads/feature" }])).toContain(
      "ok refs/heads/feature",
    );
    await commit(f, "feature", { "b.txt": "b\n" });
    const opened = await json<{ number: number }>(
      api("POST", `${f.path}/pulls`, f.owner.token, { title: "x", head: "feature", base: "main" }),
    );
    expect(opened.status).toBe(201);
    const merged = await json<{ sha: string }>(
      api("PUT", `${f.path}/pulls/${opened.body.number}/merge`, f.owner.token),
    );
    expect(merged.status).toBe(200);
    const tip = await tipOf(f, "feature");
    expect(await pushRefs(f, [{ old: tip, new: ZERO, ref: "refs/heads/feature" }])).toContain(
      "ok refs/heads/feature",
    );
    await runTriggers(f.stub);
    const pushes = (await eventsOf(f.stub)).filter((e) => e.kind === "push").slice(main);
    // main, feature created, feature commit, the merge; the deletion recorded nothing.
    expect(pushes.map((e) => JSON.parse(e.facts).ref)).toEqual([
      "refs/heads/main",
      "refs/heads/feature",
      "refs/heads/feature",
      "refs/heads/main",
    ]);
    const mergeRun = (await eventRunsOf(f.stub)).find((r) => r.event_id === pushes[3]?.id);
    expect(mergeRun).toBeDefined();
    expect((await viewOf(mergeRun?.run_id ?? "")).sha).toBe(merged.body.sha);
  });

  it("skip a push whose pushed commit says so: no run, no check", async () => {
    const f = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
    await runTriggers(f.stub);
    const before = await runIds(f);
    const messages = [
      "change [skip ci]",
      "[ci skip] change",
      "change [no ci]",
      "[skip actions]",
      "x [actions skip]",
      "change\n\nskip-checks: true",
      "change\n\nSigned-off-by: a <a@b>\nskip-checks:true\n",
    ];
    const skipped: string[] = [];
    for (const message of messages)
      skipped.push(await commit(f, "main", { "a.txt": `${message}\n` }, message));
    const kept = await commit(f, "main", { "a.txt": "last\n" }, "skip-checks: true\n\nnot last");
    await runTriggers(f.stub);
    const after = await eventRunsOf(f.stub);
    expect(after).toHaveLength(before.length + 1);
    const runs = await Promise.all(after.map((r) => viewOf(r.run_id)));
    expect(runs.map((r) => r.sha)).not.toEqual(expect.arrayContaining(skipped));
    expect(runs.at(-1)?.sha).toBe(kept);
    for (const sha of skipped) expect((await checksOn(f, sha)).size).toBe(0);
  });

  it("start nothing for a fork's initialization", async () => {
    const f = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
    const forker = await user();
    expect(
      (
        await api("PUT", `${f.path}/collaborators/${forker.handle}`, f.owner.token, {
          permission: "pull",
        })
      ).status,
    ).toBe(200);
    const forked = await json<{ id: string; name: string }>(
      api("POST", `${f.path}/forks`, forker.token, { name: uniqueId("fork") }),
    );
    expect(forked.status).toBe(201);
    const fork = env.REPO.getByName(forked.body.id);
    expect(await eventsOf(fork)).toEqual([]);
    expect(await inRepo(fork, (r: RepoDO) => r.git.jobs.get(CI_TRIGGERS_JOB))).toBeUndefined();
  });

  it("start one push run for a repository generated from a template", async () => {
    const t = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
    expect((await api("PATCH", t.path, t.owner.token, { is_template: true })).status).toBe(200);
    const made = await json<{ id: string; name: string }>(
      api("POST", `${t.path}/generate`, t.owner.token, { name: uniqueId("gen") }),
    );
    expect(made.status).toBe(201);
    const generated = env.REPO.getByName(made.body.id);
    await runTriggers(generated);
    await runTriggers(generated);
    const runs = await eventRunsOf(generated);
    expect(runs).toHaveLength(1);
    expect(await viewOf(runs[0]?.run_id ?? "")).toMatchObject({
      event: "push",
      ref: "refs/heads/main",
    });
  });

  it("record no tag events for more than three tags in one push, and one refused row past 20 branches", async () => {
    const f = await ciRepo({ [CI]: workflowFile("{ push: { tags: ['*'] } }"), "a.txt": "one\n" });
    await runTriggers(f.stub);
    const sha = await commit(f, "main", { "a.txt": "two\n" });
    const before = (await eventsOf(f.stub)).length;
    const tags = ["t1", "t2", "t3", "t4"].map((t) => ({
      old: ZERO,
      new: sha,
      ref: `refs/tags/${t}`,
    }));
    expect(await pushRefs(f, tags)).toContain("ok refs/tags/t4");
    // The same push may still record its branch.
    expect(
      await pushRefs(f, [...tags.slice(0, 3).map((t) => ({ ...t, ref: `${t.ref}x` }))]),
    ).toContain("ok refs/tags/t3x");
    const branches = Array.from({ length: 21 }, (_, i) => ({
      old: ZERO,
      new: sha,
      ref: `refs/heads/b${i}`,
    }));
    expect(await pushRefs(f, branches)).toContain("ok refs/heads/b20");
    await runTriggers(f.stub);
    const added = (await eventsOf(f.stub)).slice(before);
    const refs = added.map((e) => (e.outcome ? e.outcome : JSON.parse(e.facts).ref));
    // The first push's tags taken back, three tags of the second push, one refused row for the
    // branches.
    expect(refs).toEqual([
      "too_many_tags",
      "refs/tags/t1x",
      "refs/tags/t2x",
      "refs/tags/t3x",
      "too_many_refs",
    ]);
    expect(added.at(-1)).toMatchObject({ state: "done", outcome: "too_many_refs" });
  });

  it("record nothing while CI is off, and start only from later events once on", async () => {
    switchCi(false);
    let f: CiRepo;
    try {
      f = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
      await commit(f, "main", { "a.txt": "two\n" });
      expect(await eventsOf(f.stub)).toEqual([]);
    } finally {
      switchCi(true);
    }
    await switchRepoCi(f.stub, true);
    expect(await runTriggers(f.stub)).toMatchObject({ state: "missing" });
    const sha = await commit(f, "main", { "a.txt": "three\n" });
    await runTriggers(f.stub);
    const runs = await eventRunsOf(f.stub);
    expect(runs).toHaveLength(1);
    expect((await viewOf(runs[0]?.run_id ?? "")).sha).toBe(sha);
  });

  it("reuse the run id after a reset between starting the run and finishing the event", async () => {
    const f = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
    await inRepo(f.stub, (r: RepoDO) => {
      let once = true;
      r.ciTriggers.hooks = {
        afterStart: () => {
          if (!once) return;
          once = false;
          throw new Error("reset");
        },
      };
    });
    expect((await runTriggers(f.stub)).state).toBe("queued");
    const [allocated] = await eventRunsOf(f.stub);
    expect(allocated?.started_at).toBeNull();
    expect((await runTriggers(f.stub)).state).toBe("done");
    const runs = await eventRunsOf(f.stub);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ run_id: allocated?.run_id });
    expect(runs[0]?.started_at).not.toBeNull();
    const id = allocated?.run_id ?? "";
    await at(id, T0);
    await drain(id);
    expect(await jobsOf(id)).toHaveLength(1);
    expect((await viewOf(id)).faults).toEqual([]);
  });

  it("end the invocation once its work is spent, and go on in the next", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= TRIGGER_WORK.blobs; i++)
      files[`.github/workflows/w${i}.yml`] = workflowFile("push", `w${i}`);
    const f = await ciRepo(files);
    const first = await runTriggers(f.stub);
    // The job stops after one slice and stays queued for the next invocation.
    expect(first).toEqual({ slices: 1, state: "queued" });
    const partial = (await eventRunsOf(f.stub)).length;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(TRIGGER_WORK.blobs + 1);
    const spent = await inRepo(f.stub, (r: RepoDO) => ({ ...r.ciTriggers.work }));
    expect(spent.blobs).toBeLessThanOrEqual(TRIGGER_WORK.blobs);
    let rounds = 0;
    let result = await runTriggers(f.stub);
    while (result.state !== "done" && rounds++ < 5) result = await runTriggers(f.stub);
    expect(result.state).toBe("done");
    const runs = await eventRunsOf(f.stub);
    expect(runs).toHaveLength(TRIGGER_WORK.blobs + 1);
    expect(runs.every((r) => r.started_at !== null)).toBe(true);
  });

  it("start nothing new on a duplicate run of the job; retry a failed start without exhausting the job", async () => {
    const f = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
    let failures = 12;
    const clock = { now: Date.now() };
    await inRepo(f.stub, (r: RepoDO) => {
      (r.git.context as { now: () => number }).now = () => clock.now;
      r.ciTriggers.hooks = {
        beforeStart: () => {
          if (failures-- > 0) throw new Error("the run object could not be reached");
        },
      };
    });
    for (let i = 0; i < 12; i++) {
      expect(await runTriggers(f.stub)).toMatchObject({ state: "queued" });
      // Past any retry deadline: the next run of the job tries again.
      clock.now += 60 * 60_000;
      expect(await inRepo(f.stub, (r: RepoDO) => r.git.jobs.get(CI_TRIGGERS_JOB))).toMatchObject({
        state: "queued",
        attempts: 0,
      });
    }
    expect((await runTriggers(f.stub)).state).toBe("done");
    const runs = await eventRunsOf(f.stub);
    expect(runs).toHaveLength(1);
    // Ensured again, the job finds nothing to do.
    await inRepo(f.stub, (r: RepoDO) => r.git.jobs.ensure(CI_TRIGGERS_JOB, CI_TRIGGERS_JOB));
    expect((await runTriggers(f.stub)).state).toBe("done");
    expect(await eventRunsOf(f.stub)).toEqual(runs);
  });
});

describe("workflows that fail to plan", () => {
  it("give a failed run with the named error and one failing check", async () => {
    const source = [
      "name: broken",
      "on: push",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: https://github.com/actions/checkout@v4",
      "",
    ].join("\n");
    const bad = ".github/workflows/bad.yml";
    const f = await ciRepo({ [bad]: source, ".github/workflows/syntax.yml": "on: [push\n" });
    await runTriggers(f.stub);
    const runs = await eventRunsOf(f.stub);
    expect(runs.map((r) => r.workflow_path)).toEqual([bad, ".github/workflows/syntax.yml"]);
    const [badRun, syntaxRun] = await Promise.all(runs.map((r) => viewOf(r.run_id)));
    expect(badRun).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(badRun?.errors[0]).toMatchObject({
      code: expect.any(String),
      feature: expect.any(String),
      path: expect.stringContaining("uses"),
      line: 7,
      column: expect.any(Number),
      message: expect.stringContaining("is not an action reference"),
    });
    expect(syntaxRun).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(syntaxRun?.errors.length).toBeGreaterThan(0);
    await settle(runs.map((r) => r.run_id));
    const checks = await checksOn(f, badRun?.sha ?? "");
    expect([...checks.keys()].sort()).toEqual(
      [
        `workflow file: ${bad} (${await sha256(bad)})`,
        `workflow file: .github/workflows/syntax.yml (${await sha256(".github/workflows/syntax.yml")})`,
      ].sort(),
    );
    for (const check of checks.values())
      expect(check).toMatchObject({ status: "completed", conclusion: "failure" });
  });

  it("keep a plan-failure check and another workflow's job check on one commit, in either flush order", async () => {
    for (const order of ["failed first", "job first"] as const) {
      const f = await ciRepo({
        ".github/workflows/a.yml": "name: build\non: push\njobs: {}\n",
        ".github/workflows/b.yml": workflowFile("push", "b", "build"),
      });
      await runTriggers(f.stub);
      const runs = await eventRunsOf(f.stub);
      const ids = runs.map((r) => r.run_id);
      await settle(order === "failed first" ? ids : [...ids].reverse());
      const sha = (await viewOf(ids[0] ?? "")).sha;
      const names = [...(await checksOn(f, sha)).keys()].sort();
      expect(names).toEqual(
        [
          "build",
          `workflow file: .github/workflows/a.yml (${await sha256(".github/workflows/a.yml")})`,
        ].sort(),
      );
    }
  });

  it("name each failing file's check apart: folded aliases, a long name, a shared hash prefix", async () => {
    const long = `.github/workflows/${"a".repeat(246)}.yml`;
    // The SHA-256 of these two paths shares its first 8 hex digits (81e416cf).
    const pair = [".github/workflows/w1m21.yml", ".github/workflows/w3t9n.yml"];
    expect((await sha256(pair[0] as string)).slice(0, 8)).toBe(
      (await sha256(pair[1] as string)).slice(0, 8),
    );
    const paths = [".github/workflows/ci.yml", ".github/workflows/CI.yml", long, ...pair];
    const f = await ciRepo(Object.fromEntries(paths.map((p) => [p, "on: [push\n"])));
    await runTriggers(f.stub);
    const runs = await eventRunsOf(f.stub);
    expect(runs).toHaveLength(paths.length);
    await settle(runs.map((r) => r.run_id));
    const sha = (await viewOf(runs[0]?.run_id ?? "")).sha;
    const names = [...(await checksOn(f, sha)).keys()];
    expect(names).toHaveLength(paths.length);
    for (const name of names) expect(checkText(name, 255).ok).toBe(true);
    const longName = names.find((n) => n.includes("aaaa")) ?? "";
    expect([...longName]).toHaveLength(255);
    expect(longName.endsWith(` (${await sha256(long)})`)).toBe(true);
    expect(new Set(names.map((n) => n.normalize("NFC").toLowerCase())).size).toBe(paths.length);
  });

  it("replace control characters in a check name and keep it within 255 characters", async () => {
    const path = `.github/workflows/a\u0007b\u0085c\u0000${"é".repeat(300)}.yml`;
    const name = await workflowFileCheckName(path);
    expect(checkText(name, 255).ok).toBe(true);
    expect(name.startsWith("workflow file: .github/workflows/a�b�c�")).toBe(true);
    expect(name.endsWith(` (${await sha256(path)})`)).toBe(true);
    expect([...name]).toHaveLength(255);
  });

  it("fail a job whose check name is reserved for workflow files, publishing no check under it", async () => {
    const f = await ciRepo({ "a.txt": "one\n" });
    const sha = await tipOf(f, "main");
    const source = workflow(
      [
        "  reserved:",
        "    name: 'Workflow File: x'",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo",
      ].join("\n"),
    );
    const fixture = { owner: f.owner, repo: f.repo, path: f.path, sha };
    const runId = await started(fixture, source);
    const [job] = await jobsOf(runId);
    expect(job).toMatchObject({
      conclusion: "failure",
      error: expect.stringContaining("workflow file:"),
    });
    expect(job?.check.code).toBe("reserved_name");
    await drain(runId);
    const names = [...(await checksOn(f, sha)).keys()];
    expect(names.map((n) => n.toLowerCase())).not.toContain("workflow file: x");
    // The spec helper is the same one the run tests use.
    expect(specFor(fixture, source).repoId).toBe(f.repo.id);
    expect(await runStub(runId).get()).toMatchObject({
      status: "completed",
      conclusion: "failure",
    });
  });
});

describe("review regressions", () => {
  it("start nothing from an event queued before CI was switched off, and replay nothing once on", async () => {
    const f = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
    expect(await eventsOf(f.stub)).toMatchObject([{ state: "pending" }]);
    await switchRepoCi(f.stub, false);
    try {
      await inRepo(f.stub, (r: RepoDO) => r.alarm());
      expect(await inRepo(f.stub, (r: RepoDO) => r.git.jobs.get(CI_TRIGGERS_JOB))).toMatchObject({
        state: "done",
      });
      expect(await eventRunsOf(f.stub)).toEqual([]);
      expect(await eventsOf(f.stub)).toMatchObject([{ state: "done", outcome: "ci_off" }]);
    } finally {
      await switchRepoCi(f.stub, true);
    }
    const sha = await commit(f, "main", { "a.txt": "two\n" });
    await runTriggers(f.stub);
    const runs = await eventRunsOf(f.stub);
    expect(runs).toHaveLength(1);
    expect((await viewOf(runs[0]?.run_id ?? "")).sha).toBe(sha);
  });

  it("close an event recorded before the CI cutoff unread, though no object saw CI off", async () => {
    const f = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
    const [queued] = await eventsOf(f.stub, { refreshes: true });
    // CI was switched off and on again after the push, with nothing running in between; whoever
    // switched it on set the cutoff to then.
    await setVar(f.stub, "FYRDEN_CI_SINCE", String((queued?.created_at ?? 0) + 1));
    try {
      await runTriggers(f.stub);
      expect(await eventsOf(f.stub, { refreshes: true })).toMatchObject([
        { kind: "push", state: "done", outcome: "ci_off" },
        { kind: "schedule_refresh", state: "done", outcome: "ci_off" },
      ]);
      expect(await eventRunsOf(f.stub)).toEqual([]);
      // An event recorded after the cutoff runs.
      const sha = await commit(f, "main", { "a.txt": "two\n" });
      await runTriggers(f.stub);
      const runs = await eventRunsOf(f.stub);
      expect(runs).toHaveLength(1);
      expect((await viewOf(runs[0]?.run_id ?? "")).sha).toBe(sha);
    } finally {
      await setVar(f.stub, "FYRDEN_CI_SINCE", undefined);
    }
  });

  it.each([
    ["4 minutes", 4 * 60_000, "ci_off"],
    ["6 minutes", 6 * 60_000, null],
  ])(
    "take a cutoff %s ahead of the clock for the inbox as the schedules do",
    async (_, lead, outcome) => {
      const f = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
      const [queued] = await eventsOf(f.stub);
      const now = (queued?.created_at ?? 0) + 10_000;
      await inRepo(f.stub, (r: RepoDO) => {
        (r.git.context as { now: () => number }).now = () => now;
      });
      // Within 5 minutes ahead it applies (the event waits closed); further ahead it is ignored.
      await setVar(f.stub, "FYRDEN_CI_SINCE", String(now + lead));
      try {
        await runTriggers(f.stub);
        expect(await eventsOf(f.stub)).toMatchObject([{ kind: "push", state: "done", outcome }]);
        expect(await eventRunsOf(f.stub)).toHaveLength(outcome ? 0 : 1);
      } finally {
        await setVar(f.stub, "FYRDEN_CI_SINCE", undefined);
      }
    },
  );

  it("finish a push whose commit time no date can hold, and the push after it", async () => {
    const f = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
    await runTriggers(f.stub);
    const tip = await tipOf(f, "main");
    const read = await json<{ commit: { tree: { sha: string } } }>(
      api("GET", `${f.path}/commits/${tip}`, f.owner.token),
    );
    expect(read.status).toBe(200);
    const far = await builtCommit(read.body.commit.tree.sha, tip, 8_640_000_000_001, "far");
    const report = await pushRefs(
      f,
      [{ old: tip, new: hex(far.oid), ref: "refs/heads/main" }],
      hex(await packOf([far])),
    );
    expect(report).toContain("ok refs/heads/main");
    const next = await commit(f, "main", { "a.txt": "two\n" });
    await runTriggers(f.stub);
    const events = (await eventsOf(f.stub)).slice(1);
    expect(events.map((e) => e.state)).toEqual(["done", "done"]);
    const runs = (await eventRunsOf(f.stub)).slice(1);
    const views = await Promise.all(runs.map((r) => viewOf(r.run_id)));
    expect(views.map((v) => v.sha)).toEqual([hex(far.oid), next]);
    const github = await githubOf(runs[0]?.run_id ?? "");
    expect((github.event as { head_commit: { timestamp: string } }).head_commit.timestamp).toBe(
      "+275760-09-13T00:00:00.000Z",
    );
  });

  it("retry a failed start only at its deadline, though new events arrive meanwhile", async () => {
    const f = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
    const clock = { now: Date.now() };
    const attempts: string[] = [];
    await inRepo(f.stub, (r: RepoDO) => {
      (r.git.context as { now: () => number }).now = () => clock.now;
      let failing = true;
      r.ciTriggers.hooks = {
        beforeStart: (runId) => {
          attempts.push(runId);
          if (failing) {
            failing = false;
            throw new Error("the run object could not be reached");
          }
        },
      };
    });
    await runTriggers(f.stub);
    const [first] = await eventRunsOf(f.stub);
    expect(first?.started_at).toBeNull();
    // A newer event during the backoff starts at once; the failed one waits for its deadline.
    await commit(f, "main", { "a.txt": "two\n" });
    await runTriggers(f.stub);
    const during = await eventRunsOf(f.stub);
    expect(attempts.filter((id) => id === first?.run_id)).toHaveLength(1);
    expect(during.find((r) => r.run_id === first?.run_id)?.started_at).toBeNull();
    expect(during.filter((r) => r.started_at !== null)).toHaveLength(1);
    clock.now += 60 * 60_000;
    await runTriggers(f.stub);
    expect(attempts.filter((id) => id === first?.run_id)).toHaveLength(2);
    expect((await eventRunsOf(f.stub)).every((r) => r.started_at !== null)).toBe(true);
  });

  it("count a discovery refusal's outcome once", async () => {
    const f = await ciRepo({ ".github/workflows": "not a directory\n" });
    const counted = await inRepo(f.stub, async (r: RepoDO) => {
      const metrics = r.git.context.metrics as { count: (...args: unknown[]) => void };
      const original = metrics.count;
      const seen: unknown[] = [];
      metrics.count = (...args: unknown[]) => {
        if (args[0] === "ci.trigger_outcome") seen.push(args[1]);
        return original.apply(metrics, args);
      };
      try {
        await r.git.jobs.runJob(
          CI_TRIGGERS_JOB,
          r.ciTriggers.handler(),
          r.git.memory,
          r.git.context.now() + 60_000,
        );
      } finally {
        metrics.count = original;
      }
      return seen;
    });
    expect(counted).toEqual([{ outcome: "not_a_directory" }]);
    expect(await eventsOf(f.stub)).toMatchObject([{ state: "done", outcome: "not_a_directory" }]);
  });
});

describe("failures while deciding an event", () => {
  /** Freezes the repository's clock; returns a function moving it past any retry deadline. */
  async function frozen(f: CiRepo) {
    const clock = { now: Date.now() };
    await inRepo(f.stub, (r: RepoDO) => {
      (r.git.context as { now: () => number }).now = () => clock.now;
    });
    return () => {
      clock.now += 60 * 60_000;
    };
  }

  it("decide an event normally after more read failures than any limit of attempts", async () => {
    const f = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
    const later = await frozen(f);
    // The push's event alone takes the failures below.
    await inRepo(f.stub, (r: RepoDO) =>
      r.git.context.storage.sql.exec("DELETE FROM ci_events WHERE kind = 'schedule_refresh'"),
    );
    await inRepo(f.stub, (r: RepoDO) => {
      let failures = 8;
      r.ciTriggers.hooks = {
        beforeRead: () => {
          if (failures-- > 0) throw new Error("the object store could not be reached");
        },
      };
    });
    for (let i = 0; i < 8; i++) {
      await runTriggers(f.stub);
      expect(await eventsOf(f.stub)).toMatchObject([{ state: "pending" }]);
      later();
    }
    await runTriggers(f.stub);
    expect(await eventsOf(f.stub)).toMatchObject([{ state: "done", outcome: null }]);
    const runs = await eventRunsOf(f.stub);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.started_at).not.toBeNull();
  });

  /** The push event's row, as the inbox holds it. */
  const pushEvent = async (f: CiRepo) =>
    (await eventsOf(f.stub)).find((e) => e.kind === "push") as EventRow;
  const setAttempts = (f: CiRepo, attempts: number) =>
    inRepo(f.stub, (r: RepoDO) =>
      r.git.context.storage.sql.exec(
        "UPDATE ci_events SET attempts = ? WHERE kind = 'push'",
        attempts,
      ),
    );

  it("give up an event whose reads keep failing temporarily at the attempt cap, as retries_exhausted", async () => {
    const f = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
    const later = await frozen(f);
    await inRepo(f.stub, (r: RepoDO) =>
      r.git.context.storage.sql.exec("DELETE FROM ci_events WHERE kind = 'schedule_refresh'"),
    );
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.hooks = {
        beforeRead: () => {
          throw new Error("the object store could not be reached");
        },
      };
    });
    await runTriggers(f.stub);
    expect(await pushEvent(f)).toMatchObject({ state: "pending", attempts: 1, faults: 0 });
    // Every failure counts one attempt; the ones up to just below the cap are skipped.
    await setAttempts(f, MAX_EVENT_ATTEMPTS - 2);
    later();
    await runTriggers(f.stub);
    expect(await pushEvent(f)).toMatchObject({
      state: "pending",
      attempts: MAX_EVENT_ATTEMPTS - 1,
    });
    later();
    const seen = await inRepo(f.stub, async (r: RepoDO) => {
      const metrics = r.git.context.metrics as { count: (...args: unknown[]) => void };
      const original = metrics.count;
      const outcomes: unknown[] = [];
      metrics.count = (...args: unknown[]) => {
        if (args[0] === "ci.trigger_outcome") outcomes.push(args[1]);
        return original.apply(metrics, args);
      };
      try {
        await r.git.jobs.runJob(
          CI_TRIGGERS_JOB,
          r.ciTriggers.handler(),
          r.git.memory,
          r.git.context.now() + 60_000,
        );
      } finally {
        metrics.count = original;
      }
      return outcomes;
    });
    expect(seen).toEqual([{ outcome: "retries_exhausted" }]);
    expect(await pushEvent(f)).toMatchObject({
      state: "done",
      outcome: "retries_exhausted",
      attempts: MAX_EVENT_ATTEMPTS,
    });
    expect(await eventRunsOf(f.stub)).toEqual([]);
    expect(
      logs.entries().find((e) => e.msg === "a CI trigger event kept failing and was given up"),
    ).toMatchObject({ outcome: "retries_exhausted", attempts: MAX_EVENT_ATTEMPTS });
  });

  it("count no retry while the isolate's memory is busy toward the cap", async () => {
    const f = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
    const later = await frozen(f);
    await setAttempts(f, MAX_EVENT_ATTEMPTS - 1);
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.hooks = {
        beforeRead: () => {
          throw new ReadsMemoryBusy();
        },
      };
    });
    for (let i = 0; i < 3; i++) {
      await runTriggers(f.stub);
      expect(await pushEvent(f)).toMatchObject({
        state: "pending",
        attempts: MAX_EVENT_ATTEMPTS - 1,
      });
      later();
    }
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.hooks = {};
    });
    await runTriggers(f.stub);
    expect(await pushEvent(f)).toMatchObject({ state: "done", outcome: null });
    expect(await eventRunsOf(f.stub)).toHaveLength(1);
  });

  it("complete a run whose create answer was lost, through read failures after it", async () => {
    const f = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
    const later = await frozen(f);
    await inRepo(f.stub, (r: RepoDO) => {
      const real = env.RUN;
      let lost = true;
      // The run object commits the create, and its answer never arrives.
      const runs = {
        getByName: (name: string) => {
          const stub = real.getByName(name);
          return {
            reserve: (spec: Parameters<typeof stub.reserve>[0]) => stub.reserve(spec),
            create: async (spec: Parameters<typeof stub.create>[0]) => {
              const answer = await stub.create(spec);
              if (lost) {
                lost = false;
                throw new Error("the connection to the run object was lost");
              }
              return answer;
            },
          };
        },
      } as unknown as typeof env.RUN;
      r.ciTriggers.bindings = { RUN: runs, DIRECTORY: env.DIRECTORY, ORG: env.ORG };
    });
    await runTriggers(f.stub);
    const [allocated] = await eventRunsOf(f.stub);
    expect(allocated?.started_at).toBeNull();
    expect(await viewOf(allocated?.run_id ?? "")).toMatchObject({ workflowPath: CI });
    await inRepo(f.stub, (r: RepoDO) => {
      let failures = 6;
      r.ciTriggers.hooks = {
        beforeRead: () => {
          if (failures-- > 0) throw new Error("the object store could not be reached");
        },
      };
    });
    for (let i = 0; i < 7; i++) {
      later();
      await runTriggers(f.stub);
    }
    expect(await eventsOf(f.stub)).toMatchObject([{ state: "done", outcome: null }]);
    const runs = await eventRunsOf(f.stub);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ run_id: allocated?.run_id });
    expect(runs[0]?.started_at).not.toBeNull();
  });

  it("keep a refused pass's outcome through a later pass that spans invocations", async () => {
    const files: Record<string, string> = { "a.txt": "one\n" };
    for (let i = 0; i <= TRIGGER_WORK.blobs; i++)
      files[`.github/workflows/t${i}.yml`] = workflowFile("pull_request_target", `t${i}`);
    const f = await ciRepo(files);
    for (let i = 0; i < 6 && (await runTriggers(f.stub)).state !== "done"; i++);
    const main = await tipOf(f, "main");
    expect(await pushRefs(f, [{ old: ZERO, new: main, ref: "refs/heads/feature" }])).toContain(
      "ok refs/heads/feature",
    );
    // The head's `.fyrden/workflows` is a file: its pull_request pass is refused.
    await commit(f, "feature", { ".fyrden/workflows": "not a directory\n" });
    // The branch's own pushes are decided (and refused) first.
    for (let i = 0; i < 6 && (await runTriggers(f.stub)).state !== "done"; i++);
    const opened = await json<{ number: number }>(
      api("POST", `${f.path}/pulls`, f.owner.token, { title: "x", head: "feature", base: "main" }),
    );
    expect(opened.status).toBe(201);
    const counted = await inRepo(f.stub, async (r: RepoDO) => {
      const metrics = r.git.context.metrics as { count: (...args: unknown[]) => void };
      const original = metrics.count;
      const seen: unknown[] = [];
      metrics.count = (...args: unknown[]) => {
        if (args[0] === "ci.trigger_outcome") seen.push(args[1]);
        return original.apply(metrics, args);
      };
      let slices = 0;
      try {
        for (let i = 0; i < 8; i++) {
          const ran = await r.git.jobs.runJob(
            CI_TRIGGERS_JOB,
            r.ciTriggers.handler(),
            r.git.memory,
            r.git.context.now() + 60_000,
          );
          slices += ran.slices;
          if (ran.state === "done") break;
        }
      } finally {
        metrics.count = original;
      }
      return { seen, slices };
    });
    expect(counted.slices).toBeGreaterThan(1);
    const pull = (await eventsOf(f.stub)).filter((e) => e.kind === "pull_request");
    expect(pull).toMatchObject([{ state: "done", outcome: "not_a_directory" }]);
    expect(counted.seen).toEqual([{ outcome: "not_a_directory" }]);
    const targets = (await eventRunsOf(f.stub)).filter((r) => r.event_id === pull[0]?.id);
    expect(targets).toHaveLength(TRIGGER_WORK.blobs + 1);
  });
});

describe("the evidence seam", () => {
  it("fail the inbox's reads on request, and decide each pending event once per call", async () => {
    const f = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
    // A clock that stands still: no retry falls due again within a call.
    await inRepo(f.stub, (r: RepoDO) => {
      const now = r.git.context.now();
      (r.git.context as { now: () => number }).now = () => now;
    });
    expect(await f.stub.ciTriggerFaults("transient")).toEqual({ ok: true });
    const push = async () => {
      const answer = await f.stub.ciTriggersNow();
      if (!answer.ok) throw new Error(answer.code);
      return answer.events.find((e) => e.kind === "push");
    };
    expect(await push()).toMatchObject({ state: "pending", attempts: 1, faults: 0 });
    expect(await push()).toMatchObject({ state: "pending", attempts: 2, faults: 0 });
    await f.stub.ciTriggerFaults("fault");
    expect(await push()).toMatchObject({ state: "pending", attempts: 3, faults: 1 });
    await f.stub.ciTriggerFaults(null);
    expect(await push()).toMatchObject({ state: "done", outcome: null, attempts: 3 });
    expect(await eventRunsOf(f.stub)).toHaveLength(1);
  });
});

describe("runs allocated before their start is confirmed", () => {
  async function frozen(f: CiRepo) {
    const clock = { now: Date.now() };
    await inRepo(f.stub, (r: RepoDO) => {
      (r.git.context as { now: () => number }).now = () => clock.now;
    });
    return () => {
      clock.now += 60 * 60_000;
    };
  }

  /** A repository whose first push allocated its run, and whose start failed before the create. */
  async function unconfirmed() {
    const f = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
    const later = await frozen(f);
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.hooks = {
        beforeStart: () => {
          throw new Error("the run object could not be reached");
        },
      };
    });
    await runTriggers(f.stub);
    const [allocated] = await eventRunsOf(f.stub);
    expect(allocated?.started_at).toBeNull();
    expect(await runStub(allocated?.run_id ?? "").get()).toBeUndefined();
    return { f, later, runId: allocated?.run_id ?? "" };
  }

  async function confirmed(f: CiRepo, later: () => void, runId: string) {
    for (let i = 0; i < 4; i++) {
      later();
      await runTriggers(f.stub);
    }
    const [run] = await eventRunsOf(f.stub);
    expect(run).toMatchObject({ run_id: runId });
    expect(run?.started_at).not.toBeNull();
    expect(await viewOf(runId)).toMatchObject({ workflowPath: CI, event: "push" });
    expect(await eventsOf(f.stub)).toMatchObject([{ state: "done" }]);
  }

  /** The clock's time now, and the event's retry deadline and attempts. */
  const deadline = (f: CiRepo) =>
    inRepo(f.stub, (r: RepoDO) => ({
      now: r.git.context.now(),
      ...r.git.context.storage.sql
        .exec<{ next_at: number; attempts: number; state: string }>(
          "SELECT next_at, attempts, state FROM ci_events WHERE kind = 'push'",
        )
        .one(),
    }));

  /** Drives an event with an unconfirmed run past the cap; its start keeps failing. */
  async function pastTheCap(f: CiRepo, later: () => void) {
    await inRepo(f.stub, (r: RepoDO) => {
      r.git.context.storage.sql.exec(
        "UPDATE ci_events SET attempts = ? WHERE kind = 'push'",
        MAX_EVENT_ATTEMPTS - 1,
      );
      r.ciTriggers.hooks = {
        beforeStart: () => {
          throw new Error("the run object could not be reached");
        },
      };
    });
    const hours = EXHAUSTED_RETRY_MS / (60 * 60_000);
    for (let attempt = MAX_EVENT_ATTEMPTS; attempt < MAX_EVENT_ATTEMPTS + 2; attempt++) {
      for (let i = 0; i < hours; i++) later();
      await runTriggers(f.stub);
      const at = await deadline(f);
      expect(at).toMatchObject({ state: "pending", attempts: attempt });
      // Never given up while its run may exist: tried again, less often.
      expect(at.next_at - at.now).toBe(EXHAUSTED_RETRY_MS);
    }
    // Not due before then.
    for (let i = 0; i < hours - 1; i++) later();
    await runTriggers(f.stub);
    expect(await deadline(f)).toMatchObject({ attempts: MAX_EVENT_ATTEMPTS + 1 });
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.hooks = {};
    });
  }

  it("keep an event whose run was allocated but never created past the attempt cap, and start it", async () => {
    const { f, later, runId } = await unconfirmed();
    await pastTheCap(f, later);
    await confirmed(f, later, runId);
  });

  it("keep an event whose run's create answer was lost past the attempt cap, and confirm it", async () => {
    const f = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
    const later = await frozen(f);
    await inRepo(f.stub, (r: RepoDO) => {
      const real = env.RUN;
      let lost = true;
      // The run object commits the create, and its answer never arrives.
      const runs = {
        getByName: (name: string) => {
          const stub = real.getByName(name);
          return {
            reserve: (spec: Parameters<typeof stub.reserve>[0]) => stub.reserve(spec),
            create: async (spec: Parameters<typeof stub.create>[0]) => {
              const answer = await stub.create(spec);
              if (lost) {
                lost = false;
                throw new Error("the connection to the run object was lost");
              }
              return answer;
            },
          };
        },
      } as unknown as typeof env.RUN;
      r.ciTriggers.bindings = { RUN: runs, DIRECTORY: env.DIRECTORY, ORG: env.ORG };
    });
    await runTriggers(f.stub);
    const [allocated] = await eventRunsOf(f.stub);
    expect(allocated?.started_at).toBeNull();
    expect(await viewOf(allocated?.run_id ?? "")).toMatchObject({ workflowPath: CI });
    await pastTheCap(f, later);
    await confirmed(f, later, allocated?.run_id ?? "");
  });

  it("confirm the run from what was stored with it once its workflow can no longer be read", async () => {
    const { f, later, runId } = await unconfirmed();
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.hooks = {
        beforeRead: () => {
          throw new UnreadableObjectError();
        },
      };
    });
    await confirmed(f, later, runId);
  });

  it("confirm the run from what was stored with it when no reader opens", async () => {
    const { f, later, runId } = await unconfirmed();
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.hooks = { withoutReader: true };
    });
    await confirmed(f, later, runId);
  });

  it("count a pack that cannot be decoded as a fault, and give the event up at the limit", async () => {
    const f = await ciRepo({ [CI]: workflowFile("push"), "a.txt": "one\n" });
    const later = await frozen(f);
    await inRepo(f.stub, (r: RepoDO) => {
      r.ciTriggers.hooks = {
        beforeRead: () => {
          throw new PackError("bad-zlib", "an entry's zlib stream is corrupt");
        },
      };
    });
    const faults = () =>
      inRepo(
        f.stub,
        (r: RepoDO) =>
          r.git.context.storage.sql
            .exec<{ faults: number }>("SELECT faults FROM ci_events WHERE kind = 'push'")
            .one().faults,
      );
    await runTriggers(f.stub);
    expect(await faults()).toBe(1);
    for (let i = 0; i < 30 && (await eventsOf(f.stub))[0]?.state === "pending"; i++) {
      later();
      await runTriggers(f.stub);
    }
    expect(await eventsOf(f.stub)).toMatchObject([{ state: "done", outcome: "evaluation_failed" }]);
    expect(await faults()).toBeGreaterThanOrEqual(2);
    expect(await eventRunsOf(f.stub)).toEqual([]);
  });
});

/** A commit of `tree` on `parent` made at `at` (seconds). */
function builtCommit(tree: string, parent: string, at: number, message: string) {
  return buildCommit(oidFromHex(tree) as Oid, [oidFromHex(parent) as Oid], at, message);
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A branch's tip as the API reads it. */
async function tipOf(f: CiRepo, branch: string): Promise<string> {
  const read = await json<{ sha: string }>(
    api("GET", `${f.path}/commits/${branch}`, f.owner.token),
  );
  expect(read.status).toBe(200);
  return read.body.sha;
}
