import { type Page, expect as see, type WebSocket } from "@playwright/test";
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

interface RouterState {
  navigation: { state: string };
  location: { key: string };
}

async function navigationKey(): Promise<string> {
  return page.evaluate(
    () =>
      (globalThis as unknown as { __reactRouterDataRouter: { state: RouterState } })
        .__reactRouterDataRouter.state.location.key,
  );
}

function navigatedSince(before: string): boolean {
  const { navigation, location } = (
    globalThis as unknown as { __reactRouterDataRouter: { state: RouterState } }
  ).__reactRouterDataRouter.state;
  return navigation.state === "idle" && location.key !== before;
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
    await see(page.getByRole("alert")).toContainText("A full commit SHA");
    await see(page.getByLabel("Commit")).toHaveValue("nope");
  });

  it("clears text typed but not sent, on a list with no filters", async () => {
    await visit(page, runs());
    const clear = page.getByRole("link", { name: "Clear" });
    for (const typed of ["typed", "typed again"]) {
      await page.getByLabel("Branch").fill(typed);
      await clear.focus();
      const before = await navigationKey();
      await page.keyboard.press("Enter");
      await page.waitForFunction(navigatedSince, before);
      await see(page.getByLabel("Branch")).toHaveValue("");
      await see(clear).toBeFocused();
    }
  });

  it("keeps text typed but not sent when Clear opens elsewhere", async () => {
    await visit(page, runs());
    await page.getByLabel("Branch").fill("typed");
    const opened = page.context().waitForEvent("page");
    await page.getByRole("link", { name: "Clear" }).click({ modifiers: ["ControlOrMeta"] });
    await (await opened).close();
    await see(page.getByLabel("Branch")).toHaveValue("typed");
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
  const shownRows = () => region().locator(".log-line[id]:not(:has(> .muted))").count();

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
    expect(await parsed()).toBeGreaterThanOrEqual(await shownRows());
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
    expect(await parsed()).toBeGreaterThanOrEqual(await shownRows());
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
    expect(await parsed()).toBeGreaterThanOrEqual(await shownRows());
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

  it("keeps a line a link opened in view when the router moves the page after it", async () => {
    await page.setViewportSize({ width: 1280, height: 400 });
    try {
      await visit(page, `${runs()}/runs/${logged}/job/${loggedJob}`);
      const header = page.locator(".log-step button", { hasText: "print.sh" });
      await header.click();
      await see(header).toHaveAttribute("aria-expanded", "true");
      await see(region()).toContainText("line 1 ===");
      await page.evaluate("scrollTo(0, 0)");
      expect(await region().evaluate((box) => box.getBoundingClientRect().bottom)).toBeGreaterThan(
        400,
      );
      const commits = (await viewer().getAttribute("data-router-commits")) ?? "";
      await page.evaluate(`
        history.pushState({ usr: null, key: "line-2000", idx: history.state.idx + 1 }, "", "#L2000");
        dispatchEvent(new HashChangeEvent("hashchange"));
        dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
      `);
      await see(viewer()).not.toHaveAttribute("data-router-commits", commits);
      await see(page.locator("#L2000")).toBeInViewport();
      await see(page.locator("#L2000")).toContainText("line 1999 ===");
    } finally {
      await page.setViewportSize({ width: 1280, height: 800 });
    }
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
    await see(region()).toHaveAccessibleName(new RegExp(`: ${LOG_ROWS + 1} lines$`));
    const headers = page.locator(".log-step button");
    await headers.nth(1).click();
    await headers.nth(0).click();
    await see(headers.nth(0)).toHaveAttribute("aria-expanded", "true");
    await see(headers.nth(0)).toBeFocused();
    const [asked, scrolled] = await region().evaluate((box) => {
      const rowPx = box.querySelector("[data-probe]")?.getBoundingClientRect().height ?? 0;
      box.scrollTop = 1_000 * rowPx;
      return [1_000 * rowPx, box.scrollTop];
    });
    expect(Math.abs(scrolled - asked)).toBeLessThan(1);
    const line = page.locator("#L1005");
    await see(line).toBeVisible();
    await see(line).toContainText("line 1004 ===");
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
    const sockets: WebSocket[] = [];
    const closed: Promise<void>[] = [];
    page.on("websocket", (socket) => {
      sockets.push(socket);
      closed.push(new Promise((done) => socket.on("close", () => done())));
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
    expect(sockets.length).toBeGreaterThan(0);
    await Promise.all(closed);
    expect(sockets.every((socket) => socket.isClosed())).toBe(true);
    await see(page.getByRole("button", { name: "Load new rows" })).toHaveCount(0);
    await see(log).toContainText("line 200 ===");
    await accessible("log viewer, live");
  });

  it("stays on a line near the end that a link opened, as new rows arrive", async () => {
    const live = await takenRun();
    const played = runner as PlayedRunner;
    await sendLog(stack.origin, played, live.taskId, logRows(100), 0, false);
    await visit(page, `${runs()}/runs/${live.runId}/job/${live.jobId}`);
    const log = region();
    await see(log).toContainText("line 100 ===", { timeout: 30_000 });
    await see(page.getByRole("button", { name: "Load new rows" })).toHaveCount(0, {
      timeout: 30_000,
    });
    await log.evaluate(
      (box) =>
        new Promise<void>((done) => {
          box.addEventListener("scroll", () => done(), { once: true });
          box.scrollTop = 0;
        }),
    );
    await see(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
    await page.evaluate("location.hash = '#L100'");
    await see(page.locator("#L100")).toBeInViewport();
    await sendLog(stack.origin, played, live.taskId, logRows(50, 100), 100, false);
    await see(log).toHaveAccessibleName(/: 150 lines$/, { timeout: 30_000 });
    await see(page.locator("#L100")).toBeInViewport();
    await see(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
    await finishTask(stack.origin, played, live.taskId, 1, [step(4, 1, 0, 150)]);
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
