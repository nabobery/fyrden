import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Page, expect as see } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventually } from "./forge.js";
import {
  fetchTask,
  finishTask,
  type PlayedRunner,
  registerRunner,
  sendLog,
} from "./runner-play.js";
import { accessible as axe, startWebStack, visit, type WebStack } from "./web-stack.js";

const run = promisify(execFile);
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

async function startRun(
  path = ".github/workflows/ci.yml",
  source = WORKFLOW,
  at = sha,
  context: Record<string, string> = {},
): Promise<string> {
  const started = await seam<{ runId: string; answer: { ok: boolean } }>("/start", {
    repoId,
    sha: at,
    ref: "refs/heads/main",
    event: "push",
    actor,
    workflow: { path, source },
    github: { ref: "refs/heads/main", event_name: "push", ...context },
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

let runner: PlayedRunner | undefined;

const logRows = (n: number, from = 0) => {
  const at = { seconds: Math.floor(Date.now() / 1000), nanos: 0 };
  return Array.from({ length: n }, (_, k) => ({
    time: at,
    content: from + k === 7 ? `token=${CANARY}` : `line ${from + k + 1} ${"=".repeat(50)}`,
  }));
};

const ESC = "\u001b";
const colour = (k: number, text: string) => `${ESC}[3${k % 8}m${text}${ESC}[0m`;

const denseRows = (n: number) =>
  logRows(n).map((row, k) => {
    if (k === 7) return { ...row, content: colour(k, row.content) };
    const many =
      k % 100 === 0 ? Array.from({ length: 250 }, (_, j) => colour(k + j, "#")).join("") : "";
    return {
      ...row,
      content: `${ESC}[1m${colour(k, `line ${k + 1}`)} ${colour(k + 3, "=".repeat(50))}${many}`,
    };
  });

const LONG_TASKS = `
  if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
    window.__fyrdenLongTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__fyrdenLongTasks.push(entry.duration);
    }).observe({ type: "longtask", buffered: true });
  }
`;

async function longTasks(action: string, run: () => Promise<void>, sinceLoad = false) {
  const taken = "window.__fyrdenLongTasks?.splice(0) ?? null";
  if (!sinceLoad) await page.evaluate(taken);
  await run();
  const tasks = (await page.evaluate(taken)) as number[] | null;
  if (process.env.FYRDEN_BENCH !== "1") return;
  if (tasks === null) {
    console.log(`log viewer long tasks, ${action}: not observed in this browser`);
    return;
  }
  const total = tasks.reduce((a, b) => a + b, 0);
  console.log(
    `log viewer long tasks, ${action}: ${tasks.length}, ${Math.round(total)} ms in all, longest ${Math.round(Math.max(0, ...tasks))} ms`,
  );
}

const step = (stage: number, result: number, logIndex: number, logLength: number) => {
  const at = { seconds: Math.floor(Date.now() / 1000), nanos: 0 };
  return {
    id: 0,
    result,
    startedAt: at,
    stoppedAt: at,
    logIndex,
    logLength,
    name: "",
    stage,
    number: 0,
  };
};

async function takenRun(): Promise<{ runId: string; jobId: number; taskId: number }> {
  const runId = await startRun(".github/workflows/print.yml", PRINT);
  runner ??= await registerRunner(stack.origin, stack.token, org);
  const task = await fetchTask(stack.origin, runner);
  const jobId = (
    await rest<{ jobs: Job[] }>("GET", `/repos/${org}/${name}/actions/runs/${runId}/jobs`)
  ).jobs[0]?.id as number;
  return { runId, jobId, taskId: task.id };
}

async function runWithLog(
  rows: number,
  result = 1,
  content: (n: number) => ReturnType<typeof logRows> = logRows,
): Promise<{ runId: string; jobId: number }> {
  const { runId, jobId, taskId } = await takenRun();
  const played = runner as PlayedRunner;
  await sendLog(stack.origin, played, taskId, [
    {
      time: { seconds: Math.floor(Date.now() / 1000), nanos: 0 },
      content: `::add-mask::${CANARY}`,
    },
    ...content(rows),
  ]);
  await finishTask(stack.origin, played, taskId, result, [
    step(1, 1, 0, 1),
    step(4, result, 1, rows),
  ]);
  await finished(runId);
  return { runId, jobId };
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
  ({ runId: logged, jobId: loggedJob } = await runWithLog(LOG_ROWS));
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
    await page.getByLabel("Commit").fill("nope");
    await page.getByRole("button", { name: "Filter" }).click();
    await see(page.getByLabel("Commit")).toHaveValue("nope");
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
        "    needs: build_and_publish_release_packages_to_registry",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo a",
      ].join("\n"),
      sha,
      { workflow: name_ },
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

describe("the log viewer", () => {
  const BIG = 100_000;
  let big = { runId: "", jobId: 0 };
  const viewer = () => page.locator(".log-viewer");
  const drawn = async () => Number(await viewer().getAttribute("data-rows-drawn"));
  const parsed = async () => Number(await viewer().getAttribute("data-rows-parsed"));
  const region = () => page.getByRole("region", { name: /^Log of / });

  beforeAll(async () => {
    await page.addInitScript(LONG_TASKS);
    big = await runWithLog(BIG, 2, denseRows);
  }, 600_000);

  it("opens a 100,000-line coloured log at its failed step, drawing only what is in view", async () => {
    await longTasks(
      "open",
      async () => {
        await visit(page, `${runs()}/runs/${big.runId}/job/${big.jobId}`);
        await see(region()).toContainText("line 1 ===");
      },
      true,
    );
    const log = region();
    await see(log).toContainText("token=***");
    await see(log).not.toContainText(CANARY);
    await see(log.locator("[class^='a-f']").first()).toBeVisible();
    expect(await drawn()).toBeLessThanOrEqual(150);
    expect(await parsed()).toBeLessThanOrEqual(150);
    await accessible("log viewer");
  });

  it("goes to the end by keyboard and reads only the rows it shows", async () => {
    await visit(page, `${runs()}/runs/${big.runId}/job/${big.jobId}`);
    const log = region();
    await see(log).toContainText("line 1 ===");
    await log.focus();
    await longTasks("end", async () => {
      await page.keyboard.press("End");
      await see(log).toContainText(`line ${BIG} ===`, { timeout: 30_000 });
    });
    expect(await drawn()).toBeLessThanOrEqual(150);
    expect(await parsed()).toBeLessThanOrEqual(400);
  });

  it("scrolls by wheel, drawing and parsing a bounded number of rows", async () => {
    await visit(page, `${runs()}/runs/${big.runId}/job/${big.jobId}`);
    const log = region();
    await see(log).toContainText("line 1 ===");
    await log.hover();
    const wheels = 20;
    await longTasks("scroll", async () => {
      for (let k = 0; k < wheels; k++) await page.mouse.wheel(0, 4_000);
      await see(log).not.toContainText("line 1 ===", { timeout: 30_000 });
      await see(log.locator(".log-line > .muted").filter({ hasText: /^…$/ })).toHaveCount(0, {
        timeout: 30_000,
      });
    });
    expect(await drawn()).toBeLessThanOrEqual(150);
    expect(await parsed()).toBeLessThanOrEqual((wheels + 1) * 150);
  });

  it("opens a line from its link", async () => {
    await visit(page, `${runs()}/runs/${big.runId}/job/${big.jobId}`);
    await see(region()).toContainText("line 1 ===");
    await longTasks("step jump", async () => {
      await page.evaluate("location.hash = '#L50002'");
      await see(page.locator("#L50002")).toBeInViewport({ timeout: 30_000 });
    });
    await see(page.locator("#L50002")).toContainText("line 50001 ===");
  });

  it("opens a line in a folded step that succeeded, from its link at load", async () => {
    await visit(page, `${runs()}/runs/${logged}/job/${loggedJob}#L2000`);
    const line = page.locator("#L2000");
    await see(line).toBeInViewport({ timeout: 30_000 });
    await see(line).toContainText("line 1999 ===");
  });

  it("says when a line's link is past the log's end, and stays where it is", async () => {
    await visit(page, `${runs()}/runs/${logged}/job/${loggedJob}#L2000`);
    await see(page.locator("#L2000")).toBeVisible({ timeout: 30_000 });
    const before = await region().evaluate((box) => box.scrollTop);
    await page.evaluate("location.hash = '#L99999'");
    await see(page.getByRole("status").filter({ hasText: "Line 99999" })).toHaveText(
      `Line 99999 is past the end of this log (${LOG_ROWS + 1} lines).`,
    );
    expect(await region().evaluate((box) => box.scrollTop)).toBe(before);
    await see(page.locator("#L2000")).toBeVisible();
  });

  it("keeps a focused line while scrolling, and gives focus to its step when folded", async () => {
    await visit(page, `${runs()}/runs/${logged}/job/${loggedJob}`);
    const header = page.locator(".log-step button", { hasText: "print.sh" });
    await header.click();
    await see(header).toHaveAttribute("aria-expanded", "true");
    const link = page.getByRole("link", { name: "Line 5", exact: true });
    await link.focus();
    await region().evaluate((box) => {
      box.scrollTop = box.scrollHeight;
    });
    await see(region()).toContainText(`line ${LOG_ROWS} ===`);
    await see(link).toBeFocused();
    await region().evaluate((box) => {
      box.scrollTop = 0;
    });
    await header.dispatchEvent("click");
    await see(header).toHaveAttribute("aria-expanded", "false");
    await see(header).toBeFocused();
  });

  it("keeps the line at the top in place when a step above it folds", async () => {
    await visit(page, `${runs()}/runs/${logged}/job/${loggedJob}`);
    const headers = page.locator(".log-step button");
    await headers.nth(1).click();
    await headers.nth(0).click();
    await see(headers.nth(0)).toHaveAttribute("aria-expanded", "true");
    await see(headers.nth(0)).toBeFocused();
    await region().evaluate((box) => {
      box.scrollTop = 1_000 * 20;
    });
    const line = page.locator("#L1005");
    await see(line).toBeVisible();
    const before = (await line.boundingBox())?.y;
    await page.keyboard.press("Enter");
    await see(page.locator(".log-step button").first()).toHaveAttribute("aria-expanded", "false");
    await see(line).toBeVisible();
    expect((await line.boundingBox())?.y).toBe(before);
  });

  it("follows a running job's log live, then ends with it", async () => {
    const live = await takenRun();
    const played = runner as PlayedRunner;
    await sendLog(stack.origin, played, live.taskId, logRows(100), 0, false);
    let release: () => void = () => undefined;
    const released = new Promise<void>((done) => {
      release = done;
    });
    let held = false;
    await page.route("**/logs/rows?*", async (route) => {
      if (!held) {
        held = true;
        await released;
      }
      await route.continue();
    });
    const asked = page.waitForRequest((request) => request.url().includes("/logs/rows?"));
    await page.goto(`${runs()}/runs/${live.runId}/job/${live.jobId}`);
    await asked;
    await page.evaluate("location.hash = '#L4'");
    release();
    const log = page.getByRole("region", { name: /^Log of / });
    await see(log).toHaveAccessibleName(/: 100 lines$/);
    await see(page.locator("#L4")).toBeInViewport();
    await page.unroute("**/logs/rows?*");
    await sendLog(stack.origin, played, live.taskId, logRows(50, 100), 100, false);
    await see(log).toHaveAccessibleName(/: 150 lines$/, { timeout: 30_000 });
    await see(page.getByRole("button", { name: "Jump to latest" })).toBeVisible({
      timeout: 30_000,
    });
    await see(page.locator("#L4")).toBeInViewport();
    await page.getByRole("button", { name: "Jump to latest" }).click();
    await see(log).toContainText("line 150 ===", { timeout: 30_000 });
    await sendLog(stack.origin, played, live.taskId, logRows(50, 150), 150);
    await see(log).toContainText("line 200 ===", { timeout: 30_000 });
    await finishTask(stack.origin, played, live.taskId, 1, [step(4, 1, 0, 200)]);
    await see(page.getByRole("button", { name: "Load new rows" })).toHaveCount(0, {
      timeout: 30_000,
    });
    await accessible("log viewer, live");
  });

  it("fits a phone's width", async () => {
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await visit(page, `${runs()}/runs/${big.runId}/job/${big.jobId}`);
      await see(page.getByRole("region", { name: /^Log of / })).toContainText("line 1 ===");
      expect(await page.locator("html").evaluate((html) => html.scrollWidth), `${width}px`).toBe(
        width,
      );
    }
    await page.setViewportSize({ width: 1280, height: 800 });
  });
});

async function branchFromMain(branch: string): Promise<void> {
  const { token } = await rest<{ token: string }>("POST", "/user/git-tokens", {});
  const home = await mkdtemp(join(stack.scratch, "git-"));
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
  };
  const remote = `http://x-access-token:${token}@127.0.0.1:${stack.port}/${org}/${name}.git`;
  const work = join(home, "work");
  await run("git", ["clone", "-q", "--depth", "1", remote, work], { env });
  await run("git", ["push", "-q", "origin", `HEAD:refs/heads/${branch}`], { env, cwd: work });
}

async function signedInAs(login: string): Promise<Page> {
  const user = await rest<{ id: string }>("POST", "/admin/users", { handle: login });
  const made = await rest<{ token: string }>("POST", `/admin/users/${user.id}/tokens`, {
    type: "pat",
    scopes: [],
    expires_in_days: 1,
  });
  const context = await page.context().browser()?.newContext();
  if (!context) throw new Error("no browser");
  const other = await context.newPage();
  await other.goto(`${stack.origin}/auth/sign-in?return_to=%2F`);
  await other.getByLabel(/personal access token/i).fill(made.token);
  await other.getByRole("button", { name: "Sign in with the token" }).click();
  await other.getByRole("button", { name: "Not now" }).click();
  await see(other).toHaveURL(`${stack.origin}/`);
  return other;
}

describe("re-run, cancel and their refusals", () => {
  it("re-runs a finished run as a new attempt", async () => {
    const runId = await startRun();
    await runJob(runId, "build", "success");
    await runJob(runId, "test", "success");
    await finished(runId);
    await visit(page, `${runs()}/runs/${runId}`);
    await accessible("run page with actions");
    await page.getByRole("button", { name: "Re-run all jobs" }).click();
    await see(page.getByRole("status").filter({ hasText: "Re-run started" })).toBeVisible();
    await see(page.getByLabel("Attempt")).toHaveValue("2");
  });

  it("cancels a running run after asking, and says so", async () => {
    const runId = await startRun();
    await visit(page, `${runs()}/runs/${runId}`);
    const cancel = page.getByRole("button", { name: "Cancel run" });
    await cancel.focus();
    const key = page.locator('input[name="key"]').first();
    const before = await key.inputValue();
    await see(key).not.toHaveValue(before, { timeout: 30_000 });
    await see(cancel).toBeFocused();
    await cancel.click();
    const dialog = page.getByRole("dialog", { name: "Cancel this run?" });
    await see(dialog).toBeVisible();
    await see(dialog.getByRole("button", { name: "Keep it running" })).toBeFocused();
    await accessible("cancel confirmation");
    await dialog.getByRole("button", { name: "Keep it running" }).click();
    await see(dialog).toBeHidden();
    await see(cancel).toBeFocused();
    await cancel.click();
    await dialog.getByRole("button", { name: "Yes, cancel the run" }).click();
    await see(dialog).toBeHidden();
    await see(page.getByRole("status").filter({ hasText: "Cancel requested" })).toBeVisible();
    await eventually("the run cancelled", async () => {
      const run = await rest<{ status: string; conclusion: string | null }>(
        "GET",
        `/repos/${org}/${name}/actions/runs/${runId}`,
      );
      return run.conclusion === "cancelled" ? run : undefined;
    });
  });

  it("asks before cancelling without JavaScript too", async () => {
    const runId = await startRun();
    const context = await page
      .context()
      .browser()
      ?.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
    if (!context) throw new Error("no browser");
    const plain = await context.newPage();
    await plain.goto(`${runs()}/runs/${runId}`);
    await plain.getByRole("button", { name: "Cancel run" }).click();
    await see(plain.getByRole("alert")).toContainText("Cancel this run?");
    await plain.getByRole("button", { name: "Yes, cancel the run" }).click();
    await see(plain.getByRole("status").filter({ hasText: "Cancel requested" })).toBeVisible();
    await context.close();
  });

  it("refuses a cancel confirmed without JavaScript once a newer attempt started", async () => {
    const runId = await startRun();
    const context = await page
      .context()
      .browser()
      ?.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
    if (!context) throw new Error("no browser");
    const plain = await context.newPage();
    await plain.goto(`${runs()}/runs/${runId}`);
    await rest("POST", `/repos/${org}/${name}/actions/runs/${runId}/cancel`, { attempt: 1 });
    await finished(runId);
    await rest("POST", `/repos/${org}/${name}/actions/runs/${runId}/rerun`, {});
    await plain.getByRole("button", { name: "Cancel run" }).click();
    await see(plain.getByRole("alert")).toContainText("Cancel this run?");
    await plain.getByRole("button", { name: "Yes, cancel the run" }).click();
    await see(plain.getByRole("alert")).toContainText("newer attempt");
    const run = await rest<{ run_attempt: number; status: string }>(
      "GET",
      `/repos/${org}/${name}/actions/runs/${runId}`,
    );
    expect(run.run_attempt).toBe(2);
    expect(run.status).not.toBe("completed");
    await context.close();
  });

  it("names a refusal: a re-run drawn for an attempt that is no longer current", async () => {
    const runId = await startRun();
    await runJob(runId, "build", "success");
    await runJob(runId, "test", "success");
    await finished(runId);
    await visit(page, `${runs()}/runs/${runId}`);
    await rest("POST", `/repos/${org}/${name}/actions/runs/${runId}/rerun`, {});
    await page.getByRole("button", { name: "Re-run all jobs" }).click();
    await see(page.getByRole("alert")).toContainText("newer attempt");
    await accessible("a refused re-run");
    await runJob(runId, "build", "success");
    await runJob(runId, "test", "success");
    await finished(runId);
    await visit(page, `${runs()}/runs/${runId}?attempt=2`);
    await rest("POST", `/repos/${org}/${name}/actions/runs/${runId}/rerun`, {});
    await page.getByRole("button", { name: "Re-run all jobs" }).click();
    await see(page.getByRole("alert")).toContainText("newer attempt");
    await see(page.getByRole("status").filter({ hasText: "Attempt 2 of 3" })).toBeVisible();
  });

  it("offers a reader nothing, and the API refuses a reader's forged form", async () => {
    const runId = await startRun();
    const reader = await signedInAs("reader-of-runs");
    expect((await reader.goto(`${runs()}/runs/${runId}`))?.status()).toBe(404);
    await rest("PUT", `/repos/${org}/${name}/collaborators/reader-of-runs`, { permission: "pull" });
    await reader.goto(`${runs()}/runs/${runId}`);
    await see(reader.getByRole("heading", { level: 2 })).toBeVisible();
    await see(reader.getByRole("button", { name: "Cancel run" })).toHaveCount(0);
    const forged = await reader.request.post(`${runs()}/runs/${runId}`, {
      form: { intent: "cancel", key: crypto.randomUUID(), attempt: "1", confirm: "yes" },
      headers: { Origin: stack.origin },
      maxRedirects: 0,
    });
    expect(forged.status()).toBe(200);
    expect(await forged.text()).toContain("permission");
    const run = await rest<{ conclusion: string | null }>(
      "GET",
      `/repos/${org}/${name}/actions/runs/${runId}`,
    );
    expect(run.conclusion).not.toBe("cancelled");
    await reader.context().close();
  });
});

describe("a pull request's checks", () => {
  it("lists the head's check runs, each linked to its job, and sums them up on the conversation", async () => {
    await branchFromMain("topic");
    await rest("PUT", `/repos/${org}/${name}/contents/feature.md`, {
      message: "Add a feature",
      branch: "topic",
      content: Buffer.from("# feature\n").toString("base64"),
    });
    const pull = await rest<{ number: number; head: { sha: string } }>(
      "POST",
      `/repos/${org}/${name}/pulls`,
      {
        title: "A feature",
        head: "topic",
        base: "main",
      },
    );
    const runId = await startRun(".github/workflows/ci.yml", WORKFLOW, pull.head.sha);
    await runJob(runId, "build", "failure");
    await finished(runId);
    await eventually("the head's checks", async () => {
      const checks = await rest<{ check_runs: { name: string }[] }>(
        "GET",
        `/repos/${org}/${name}/commits/${pull.head.sha}/check-runs`,
      );
      return checks.check_runs.length >= 2 ? checks : undefined;
    });
    await visit(page, `${stack.origin}/${org}/${name}/pull/${pull.number}`);
    const box = page
      .getByRole("region", { name: "Checks" })
      .or(page.locator("section").filter({ has: page.getByRole("heading", { name: "Checks" }) }));
    await see(box.first()).toContainText("failing");
    await accessible("pull request with checks");
    await page
      .getByRole("navigation", { name: "Pull request" })
      .getByRole("link", { name: "Checks" })
      .click();
    await see(page.getByRole("heading", { name: "Check runs" })).toBeVisible();
    const build = page.getByRole("link", { name: "build" });
    await see(build).toHaveAttribute("href", new RegExp(`/actions/runs/${runId}/job/\\d+$`));
    await accessible("pull request checks tab");
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await page.locator("html").evaluate((html) => html.scrollWidth), `${width}px`).toBe(
        width,
      );
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await build.click();
    await see(page.getByRole("heading", { name: /build/ })).toBeVisible();
  });
});
