import { type Page, expect as see } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventually } from "./forge.js";
import { fetchTask, finishTask, registerRunner, sendLog } from "./runner-play.js";
import { accessible as axe, startWebStack, visit, type WebStack } from "./web-stack.js";

let stack: WebStack;
let page: Page;
const handle = "runner-of-runs";
const org = "acme";
const name = "runs";
const CANARY = "canary-secret-8c1d";
const LONG_STEP = "S".repeat(200);
const LOG_ROWS = 2_500;
let repoId = "";
let sha = "";
let actor = "";
const accessible = (what: string) => axe(page, what);
const runs = () => `${stack.origin}/${org}/${name}/actions`;

const WORKFLOW = [
  "name: ci",
  "on: push",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo build",
  `      - name: ${LONG_STEP}`,
  "        run: echo long",
  "  test:",
  "    needs: build",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo test",
].join("\n");

async function rest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${stack.origin}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${stack.token}`,
      ...(body !== undefined && {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  expect(res.status, `${method} ${path}: ${text}`).toBeLessThan(300);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function seam<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${stack.origin}/__runs${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
}

async function startRun(path = ".github/workflows/ci.yml", source = WORKFLOW): Promise<string> {
  const started = await seam<{ runId: string; answer: { ok: boolean } }>("/start", {
    repoId,
    sha,
    ref: "refs/heads/main",
    event: "push",
    actor,
    workflow: { path, source },
    github: { ref: "refs/heads/main", event_name: "push" },
  });
  expect(started.answer.ok).toBe(true);
  return started.runId;
}

interface Job {
  readonly id: number;
  readonly name: string;
  readonly status: string;
}

type StepReport = readonly [
  stage: number,
  number: number,
  result: number,
  startedAt: number,
  stoppedAt: number,
  firstRow: number,
  rows: number,
];

async function runJob(
  runId: string,
  job: string,
  result: "success" | "failure",
  steps: readonly StepReport[] = [],
) {
  const queued = await eventually(`job ${job} queued`, async () =>
    (
      await rest<{ jobs: Job[] }>("GET", `/repos/${org}/${name}/actions/runs/${runId}/jobs`)
    ).jobs.find((j) => j.name === job && j.status === "queued"),
  );
  const assigned = await eventually(`job ${job} assigned`, async () => {
    const answer = await seam<{ ok: boolean; task: unknown; code?: string }>(`/${runId}/assign`, {
      jobId: queued.id,
      key: `k-${runId}-${job}-${queued.id}`,
    });
    return answer.ok || answer.code !== "not_queued" ? answer : undefined;
  });
  expect(assigned.ok).toBe(true);
  if (steps.length > 0)
    expect(
      (
        await seam<{ ok: boolean }>(`/${runId}/update`, {
          task: assigned.task,
          steps: JSON.stringify(steps),
        })
      ).ok,
    ).toBe(true);
  const done = await seam<{ ok: boolean }>(`/${runId}/complete`, { task: assigned.task, result });
  expect(done.ok).toBe(true);
}

async function finished(runId: string) {
  return eventually(`run ${runId} listed as completed`, async () => {
    const page = await rest<{ workflow_runs: { id: string; status: string }[] }>(
      "GET",
      `/repos/${org}/${name}/actions/runs`,
    );
    return page.workflow_runs.find((r) => r.id === runId && r.status === "completed");
  });
}

let passed = "";
let failed = "";
let logged = "";
let loggedJob = 0;

const PRINT = [
  "name: print",
  "on: push",
  "jobs:",
  "  print:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: ./print.sh",
].join("\n");

async function runWithLog(): Promise<void> {
  logged = await startRun(".github/workflows/print.yml", PRINT);
  const runner = await registerRunner(stack.origin, stack.token, org);
  const task = await fetchTask(stack.origin, runner);
  const at = { seconds: Math.floor(Date.now() / 1000), nanos: 0 };
  const rows = [
    { time: at, content: `::add-mask::${CANARY}` },
    ...Array.from({ length: LOG_ROWS }, (_, i) => ({
      time: at,
      content: i === 7 ? `token=${CANARY}` : `line ${i + 1} ${"=".repeat(50)}`,
    })),
  ];
  await sendLog(stack.origin, runner, task.id, rows);
  const step = (stage: number, logIndex: number, logLength: number) => ({
    id: 0,
    result: 1,
    startedAt: at,
    stoppedAt: at,
    logIndex,
    logLength,
    name: "",
    stage,
    number: 0,
  });
  await finishTask(stack.origin, runner, task.id, 1, [step(1, 0, 1), step(4, 1, LOG_ROWS)]);
  await finished(logged);
  loggedJob = (
    await rest<{ jobs: Job[] }>("GET", `/repos/${org}/${name}/actions/runs/${logged}/jobs`)
  ).jobs[0]?.id as number;
}

beforeAll(async () => {
  stack = await startWebStack(handle, {
    runSeam: true,
    vars: { FYRDEN_CI_MAX_JOB_MINUTES: "10", FYRDEN_CI_RUNNERS: "on", FYRDEN_CI_FLEET: "2" },
  });
  page = stack.page;
  await rest("POST", "/admin/organizations", { login: org, admin: handle });
  await rest("POST", `/orgs/${org}/repos`, { name });
  const put = await rest<{ commit: { sha: string } }>(
    "PUT",
    `/repos/${org}/${name}/contents/README.md`,
    { message: "Start the runs", content: Buffer.from("# runs\n").toString("base64") },
  );
  sha = put.commit.sha;
  repoId = (await rest<{ id: string }>("GET", `/repos/${org}/${name}`)).id;
  actor = (await rest<{ id: string }>("GET", "/user")).id;
  passed = await startRun();
  const t = Date.now();
  await runJob(passed, "build", "success", [
    [1, 0, 1, t, t + 1_000, 0, 2],
    [4, 0, 1, t + 1_000, t + 3_000, 2, 5],
    [4, 1, 1, t + 3_000, t + 3_500, 7, 0],
    [7, 0, 1, t + 3_000, t + 4_000, 7, 1],
  ]);
  await runJob(passed, "test", "success");
  failed = await startRun(".github/workflows/lint.yml", WORKFLOW.replace("name: ci", "name: lint"));
  await runJob(failed, "build", "failure");
  await Promise.all([finished(passed), finished(failed)]);
  await runWithLog();
}, 300_000);

afterAll(async () => {
  await stack?.stop();
});

describe("the runs list", () => {
  it("lists the repository's runs with their states, and passes axe", async () => {
    await visit(page, runs());
    await see(page.getByRole("link", { name: "Actions" })).toHaveAttribute("aria-current", "page");
    const list = page.getByRole("list").filter({ has: page.locator(".run-row") });
    await see(list.locator(".run-row")).toHaveCount(3);
    await see(page.locator(".run-row").filter({ hasText: "lint" })).toContainText("Failed");
    await see(page.locator(".run-row").filter({ hasText: "ci.yml" })).toContainText("Succeeded");
    await accessible("runs list");
  });

  it("filters by status through its form, and keeps the filter in the address", async () => {
    await visit(page, runs());
    await page.getByLabel("Status").selectOption("failure");
    await page.getByRole("button", { name: "Filter" }).click();
    await see(page).toHaveURL(/status=failure/);
    await see(page.locator(".run-row")).toHaveCount(1);
    await see(page.locator(".run-row")).toContainText("lint");
    await accessible("runs list, filtered");
  });

  it("clears its form when the filters are cleared", async () => {
    await visit(page, `${runs()}?status=failure`);
    await see(page.getByLabel("Status")).toHaveValue("failure");
    await page.getByRole("link", { name: "Clear" }).click();
    await see(page).toHaveURL(runs());
    await see(page.getByLabel("Status")).toHaveValue("");
    await see(page.locator(".run-row")).toHaveCount(3);
  });

  it("clears a value it refused", async () => {
    await visit(page, runs());
    await page.getByLabel("Commit").fill("nope");
    await page.getByRole("button", { name: "Filter" }).click();
    await see(page.getByRole("alert")).toContainText("A full commit SHA");
    await page.getByRole("link", { name: "Clear" }).click();
    await see(page).toHaveURL(runs());
    await see(page.getByLabel("Commit")).toHaveValue("");
  });

  it("names a filter it cannot send", async () => {
    await visit(page, `${runs()}?sha=nope`);
    await see(page.getByRole("alert")).toContainText("A full commit SHA");
    await accessible("runs list, a refused filter");
  });

  it("lists one workflow's runs from the sidebar", async () => {
    await visit(page, runs());
    await page.locator(".run-workflows").getByRole("link", { name: /lint/ }).click();
    await see(page).toHaveURL(`${runs()}/workflows/lint.yml`);
    await see(page.getByRole("heading", { name: /^Runs of .*lint/ })).toBeVisible();
    await see(page.locator(".run-row")).toHaveCount(1);
    await accessible("a workflow's runs");
  });

  it("fits a phone's width", async () => {
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await visit(page, runs());
      expect(await page.locator("html").evaluate((html) => html.scrollWidth), `${width}px`).toBe(
        width,
      );
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  it("works without JavaScript", async () => {
    const context = await page
      .context()
      .browser()
      ?.newContext({
        javaScriptEnabled: false,
        storageState: await page.context().storageState(),
      });
    if (!context) throw new Error("no browser");
    const plain = await context.newPage();
    await plain.goto(`${runs()}?status=failure`);
    await see(plain.locator(".run-row")).toHaveCount(1);
    await plain.getByLabel("Status").selectOption("success");
    await plain.getByRole("button", { name: "Filter" }).click();
    await see(plain).toHaveURL(/status=success/);
    await see(plain.locator(".run-row")).toHaveCount(2);
    await context.close();
  });
});

describe("a run and its jobs", () => {
  it("draws the job graph and lists the jobs, and passes axe", async () => {
    await visit(page, `${runs()}/runs/${passed}`);
    await see(page.getByRole("region", { name: /Job graph/ })).toBeVisible();
    await see(page.getByRole("list", { name: "Stage 2" })).toContainText("test");
    await see(page.locator(".graph-edges path")).toHaveCount(1);
    await see(page.locator(".run-jobs")).toContainText("build");
    await accessible("run page");
  });

  it("opens a job from the graph and shows its steps", async () => {
    await visit(page, `${runs()}/runs/${passed}`);
    await page.getByRole("list", { name: "Stage 1" }).getByRole("link", { name: "build" }).click();
    await see(page.getByRole("heading", { name: /build/ })).toBeVisible();
    const steps = page.locator(".run-steps li");
    await see(steps).toHaveCount(4);
    await see(steps.nth(0)).toContainText("Set up job");
    await see(steps.nth(1)).toContainText("echo build");
    await see(steps.nth(1)).toContainText("lines 3 to 7");
    await see(steps.nth(2)).toContainText(LONG_STEP);
    await accessible("job page");
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await page.locator("html").evaluate((html) => html.scrollWidth), `${width}px`).toBe(
        width,
      );
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  it("reads the job's log as text without JavaScript, page by page, masked as stored", async () => {
    const context = await page
      .context()
      .browser()
      ?.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
    if (!context) throw new Error("no browser");
    const plain = await context.newPage();
    const bodies: Promise<string>[] = [];
    plain.on("response", (response) => {
      if (response.status() >= 300 && response.status() < 400) return;
      bodies.push(response.text());
    });
    await plain.goto(`${runs()}/runs/${logged}/job/${loggedJob}`);
    await plain.getByRole("link", { name: "Read the log as text" }).click();
    const log = plain.locator(".log-text pre");
    await see(log).toContainText("line 1 ===");
    await see(log).toContainText("token=***");
    await see(log).not.toContainText(`line ${LOG_ROWS} `);
    await plain.getByRole("link", { name: "Next page" }).click();
    await see(plain).toHaveURL(/cursor=/);
    await see(plain.locator(".log-text pre")).not.toContainText("line 1 ===");
    while (await plain.getByRole("link", { name: "Next page" }).count()) {
      if ((await plain.locator(".log-text pre").textContent())?.includes(`line ${LOG_ROWS} `))
        break;
      await plain.getByRole("link", { name: "Next page" }).click();
    }
    await see(plain.locator(".log-text pre")).toContainText(`line ${LOG_ROWS} `);
    const read = await Promise.all(bodies);
    expect(read.length).toBeGreaterThan(0);
    expect(read.some((b) => b.includes(CANARY))).toBe(false);
    await context.close();
    await visit(page, `${runs()}/runs/${logged}/job/${loggedJob}`);
    await page.getByRole("link", { name: "Read the log as text" }).click();
    await accessible("log as text");
  });

  it("shows a past attempt, and its picker follows the attempt shown", async () => {
    await rest("POST", `/repos/${org}/${name}/actions/runs/${failed}/rerun`, {});
    await runJob(failed, "build", "success");
    await runJob(failed, "test", "success");
    await finished(failed);
    await visit(page, `${runs()}/runs/${failed}?attempt=1`);
    await see(page.getByLabel("Attempt")).toHaveValue("1");
    await see(page.getByRole("status").filter({ hasText: "Attempt 1 of 2" })).toBeVisible();
    await accessible("a past attempt");
    await page.getByRole("link", { name: "View the current attempt" }).click();
    await see(page).toHaveURL(`${runs()}/runs/${failed}`);
    await see(page.getByLabel("Attempt")).toHaveValue("2");
  });

  it("wraps long unbroken names at a phone's width", async () => {
    const name_ = "Build_and_publish_release_packages_to_registry";
    const broken = await startRun(
      ".github/workflows/release_and_publish_packages.yml",
      [
        `name: ${name_}`,
        "on: push",
        "jobs:",
        "  a:",
        "    needs: nope",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo a",
      ].join("\n"),
    );
    await finished(broken);
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 800 });
      for (const path of [`/runs/${broken}`, "/workflows/release_and_publish_packages.yml"]) {
        await visit(page, `${runs()}${path}`);
        expect(
          await page.locator("html").evaluate((html) => html.scrollWidth),
          `${path} at ${width}px`,
        ).toBe(width);
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  it("fits a phone's width", async () => {
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await visit(page, `${runs()}/runs/${passed}`);
      expect(await page.locator("html").evaluate((html) => html.scrollWidth), `${width}px`).toBe(
        width,
      );
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });
});
