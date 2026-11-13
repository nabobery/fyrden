// Required status checks: a ruleset rule naming checks a commit must pass
// before a protected ref may point at it, judged at every commit point from
// the check summaries of the commit that counts (the new tip; a merge's
// pull request head), and judged again in the commit's transaction.
import { env } from "cloudflare:workers";
import { FYRDEN_CI_SOURCE } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { CHECKS_CHANGED } from "../src/git/push/repo-push.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { type PushCommand, pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

let owner: Who;
let repo: { id: string; name: string };
let path: string;

const stub = () => env.REPO.getByName(repo.id);
const actor = (who: Who) => ({ principal: who.principalId, actChain: [], via: "api" as const });

/** Posts a status on `sha` as `who` (a writer). */
async function status(
  sha: string,
  state: "pending" | "success" | "failure" | "error",
  context = "ci/build",
  who = owner,
) {
  const made = await stub().createStatus(
    sha,
    { state, context, description: null, targetUrl: null },
    actor(who),
  );
  expect(made).toMatchObject({ ok: true });
}

/** Runs one check of Fyrden's own runs on `sha` to `conclusion`. */
async function ciCheck(
  sha: string,
  name: string,
  conclusion: "success" | "skipped" | "neutral" | "failure" | null,
) {
  const [started] = await stub().startCheckAttempts(sha, [{ name, startKey: uniqueId("k") }]);
  if (!started?.ok) throw new Error("check not started");
  if (conclusion === null) return started.attempt;
  const [done] = await stub().recordCheckUpdates([
    { sha, name, attempt: started.attempt, status: "completed", conclusion },
  ]);
  expect(done).toBe("applied");
  return started.attempt;
}

const ruleset = (rules: unknown[], over: Record<string, unknown> = {}) =>
  json<{
    id: number;
    name: string;
    code?: string;
    detail?: string;
    rules: { type: string; parameters?: Record<string, unknown> }[];
  }>(
    api("POST", `${path}/rulesets`, owner.token, {
      name: uniqueId("main"),
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH", "refs/heads/release/*"] } },
      rules,
      ...over,
    }),
  );

const requireChecks = async (
  parameters: Record<string, unknown> = {},
  over: Record<string, unknown> = {},
) => {
  const made = await ruleset(
    [
      {
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "ci/build" }], ...parameters },
      },
    ],
    over,
  );
  expect(made.status).toBe(201);
  return made.body;
};

async function target(): Promise<PushTarget> {
  return {
    repo: { id: repo.id, name: repo.name, stub: stub() },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
}

/** Pushes `commands` with objects already stored (or `pack`); the report as one text. */
async function push(commands: PushCommand[], options: { pack?: string; atomic?: boolean } = {}) {
  const caps = ["report-status-v2", "side-band-64k", "quiet", "object-format=sha1"];
  const pushed = await postPush(
    await target(),
    pushBody(commands, {
      pack: options.pack ?? fx.packEmpty,
      caps: options.atomic ? [...caps, "atomic"] : caps,
    }),
  );
  return { report: pushed.report.join("") };
}

/** A status written straight into the summaries, from inside the repository object. */
const postIn = (r: RepoDO, state: "pending" | "failure", who = owner) =>
  r.checks.createStatus(
    fx.c3,
    { state, context: "ci/build", description: null, targetUrl: null },
    { actor: actor(who), root: who.principalId, role: "write" },
  );

/** Runs `action` once, between the commit point's check and the commit's transaction. */
const betweenCheckAndCommit = (action: (r: RepoDO) => void) =>
  inRepo(stub(), (r: RepoDO) => {
    r.pushRuleHooks = {
      afterChecked: async () => {
        r.pushRuleHooks = {};
        action(r);
      },
    };
  });

beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  // main at c2; c3 (a child of c2) stored on a topic branch, which no ruleset covers.
  const first = await push([{ old: ZERO, new: fx.c2, ref: "refs/heads/main" }], {
    pack: fx.packC2,
  });
  expect(first.report).toContain("ok refs/heads/main\n");
  const topic = await push([{ old: ZERO, new: fx.c3, ref: "refs/heads/topic" }], {
    pack: fx.packC3ThinOnC2,
  });
  expect(topic.report).toContain("ok refs/heads/topic\n");
});

describe("the required_status_checks rule", () => {
  it("is strict and enforced on creation unless set otherwise, and reads back as made", async () => {
    const made = await requireChecks();
    expect(made.rules).toEqual([
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [{ context: "ci/build" }],
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
        },
      },
    ]);
    const read = await json<{ rules: unknown[] }>(
      api("GET", `${path}/rulesets/${made.id}`, owner.token),
    );
    expect(read.body.rules).toEqual(made.rules);
    const loose = await requireChecks({
      required_status_checks: [{ context: "lint", integration_id: FYRDEN_CI_SOURCE }],
      strict_required_status_checks_policy: false,
    });
    expect(loose.rules[0]?.parameters).toEqual({
      required_status_checks: [{ context: "lint", integration_id: "ci" }],
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: false,
    });
  });

  it("refuses checks it could not enforce, and parameters of another rule", async () => {
    const refused = async (rule: Record<string, unknown>, over: Record<string, unknown> = {}) =>
      expect((await ruleset([rule], over)).body).toMatchObject({ code: "invalid_input" });
    const rule = (checks: unknown, extra: Record<string, unknown> = {}) => ({
      type: "required_status_checks",
      parameters: { required_status_checks: checks, ...extra },
    });
    await refused({ type: "required_status_checks" });
    await refused(rule([]));
    await refused(rule(Array.from({ length: 51 }, (_, i) => ({ context: `job ${i}` }))));
    await refused(rule([{ context: "Build" }, { context: "build" }]));
    await refused(rule([{ context: "" }]));
    await refused(rule([{ context: "a\u0007b" }]));
    await refused(rule([{ context: "x".repeat(256) }]));
    // GitHub's integer app ids name no Fyrden publisher.
    await refused(rule([{ context: "build", integration_id: 15368 }]));
    await refused(rule([{ context: "build", integration_id: "someone" }]));
    await refused(rule([{ context: "build" }], { required_approving_review_count: 1 }));
    await refused(rule([{ context: "build" }]), { target: "tag" });
    await refused({ type: "deletion", parameters: { required_status_checks: [] } });
    // The same context from two named sources is two requirements.
    const two = await ruleset([
      rule([
        { context: "build", integration_id: owner.principalId },
        { context: "build", integration_id: FYRDEN_CI_SOURCE },
      ]),
    ]);
    expect(two.status).toBe(201);
  });
});

describe("a direct push", () => {
  it("is refused while the new commit's required check is missing, pending or failing", async () => {
    await requireChecks();
    const tryMain = () => push([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }]);
    expect((await tryMain()).report).toMatch(
      /ng refs\/heads\/main required status check "ci\/build" is expected \(ruleset "main-[^"]+"\)\n/,
    );
    await status(fx.c3, "pending");
    expect((await tryMain()).report).toContain('required status check "ci/build" is pending');
    await status(fx.c3, "failure");
    expect((await tryMain()).report).toContain('required status check "ci/build" is failing');
    await status(fx.c3, "success");
    expect((await tryMain()).report).toContain("ok refs/heads/main\n");
  });

  it("promotes a stored commit whose checks passed, to a branch it creates too", async () => {
    await requireChecks();
    expect((await push([{ old: ZERO, new: fx.c3, ref: "refs/heads/release/1" }])).report).toContain(
      'ng refs/heads/release/1 required status check "ci/build" is expected',
    );
    await status(fx.c3, "success");
    expect((await push([{ old: ZERO, new: fx.c3, ref: "refs/heads/release/1" }])).report).toContain(
      "ok refs/heads/release/1\n",
    );
  });

  it("creates a branch without the checks only when the rule says so", async () => {
    await requireChecks({ do_not_enforce_on_create: true });
    expect((await push([{ old: ZERO, new: fx.c3, ref: "refs/heads/release/1" }])).report).toContain(
      "ok refs/heads/release/1\n",
    );
  });

  it("is not a matter for deleting a protected branch", async () => {
    await status(fx.c3, "success");
    expect((await push([{ old: ZERO, new: fx.c3, ref: "refs/heads/release/1" }])).report).toContain(
      "ok refs/heads/release/1\n",
    );
    await requireChecks();
    expect((await push([{ old: fx.c3, new: ZERO, ref: "refs/heads/release/1" }])).report).toContain(
      "ok refs/heads/release/1\n",
    );
  });

  it("judges each ref of a push by its own commit; atomically, one refused fails all", async () => {
    await requireChecks();
    await status(fx.c2, "success");
    const commands = [
      { old: fx.c2, new: fx.c3, ref: "refs/heads/main" },
      { old: ZERO, new: fx.c2, ref: "refs/heads/release/1" },
    ];
    const atomic = await push(commands, { atomic: true });
    expect(atomic.report).toContain(
      'ng refs/heads/main required status check "ci/build" is expected',
    );
    expect(atomic.report).not.toContain("ok refs/heads/release/1");
    const separate = await push(commands);
    expect(separate.report).toContain("ng refs/heads/main");
    expect(separate.report).toContain("ok refs/heads/release/1\n");
  });

  it("counts only the expected source: a same-name status from another neither passes nor blocks", async () => {
    const ci = await user();
    expect(
      (await api("PUT", `${path}/collaborators/${ci.handle}`, owner.token, { permission: "push" }))
        .status,
    ).toBe(200);
    await requireChecks({
      required_status_checks: [{ context: "ci/build", integration_id: ci.principalId }],
    });
    const tryMain = () => push([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }]);
    await status(fx.c3, "success", "ci/build", owner);
    expect((await tryMain()).report).toContain('required status check "ci/build" is expected');
    await status(fx.c3, "success", "ci/build", ci);
    await status(fx.c3, "failure", "ci/build", owner);
    expect((await tryMain()).report).toContain("ok refs/heads/main\n");
  });

  it("passes on skipped and neutral checks of Fyrden's runs", async () => {
    await requireChecks({
      required_status_checks: [
        { context: "lint", integration_id: FYRDEN_CI_SOURCE },
        { context: "docs", integration_id: FYRDEN_CI_SOURCE },
      ],
    });
    await ciCheck(fx.c3, "lint", "skipped");
    await ciCheck(fx.c3, "docs", "neutral");
    expect((await push([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }])).report).toContain(
      "ok refs/heads/main\n",
    );
  });

  it("reads each commit's checks once at the check, whatever refs share it", async () => {
    await requireChecks();
    // Another ruleset asks the same check under another spelling, and one more, on releases.
    expect(
      (
        await ruleset(
          [
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [{ context: "CI/Build" }, { context: "lint" }],
              },
            },
          ],
          { conditions: { ref_name: { include: ["refs/heads/release/*"] } } },
        )
      ).status,
    ).toBe(201);
    await status(fx.c3, "success");
    await status(fx.c3, "success", "lint");
    let reads = 0;
    await inRepo(stub(), (r: RepoDO) => {
      const read = r.checks.summariesFor.bind(r.checks);
      r.checks.summariesFor = (sha, names) => {
        reads++;
        return read(sha, names);
      };
    });
    await betweenCheckAndCommit(() => {
      expect(reads).toBe(1);
    });
    const pushed = await push(
      [
        { old: fx.c2, new: fx.c3, ref: "refs/heads/main" },
        { old: ZERO, new: fx.c3, ref: "refs/heads/release/1" },
      ],
      { atomic: true },
    );
    expect(pushed.report).toContain("ok refs/heads/main\n");
  });
});

describe("a check changing between the check and the commit", () => {
  it("does not refuse a creation its rule exempts", async () => {
    await requireChecks({ do_not_enforce_on_create: true });
    await betweenCheckAndCommit((r) => {
      postIn(r, "failure");
    });
    expect((await push([{ old: ZERO, new: fx.c3, ref: "refs/heads/release/1" }])).report).toContain(
      "ok refs/heads/release/1\n",
    );
  });

  it("refuses the push when a new attempt starts, and judges a retry afresh", async () => {
    await requireChecks({
      required_status_checks: [{ context: "test", integration_id: FYRDEN_CI_SOURCE }],
    });
    await ciCheck(fx.c3, "test", "success");
    await betweenCheckAndCommit((r) => {
      r.checks.startCheckAttempts(fx.c3, [{ name: "test", startKey: uniqueId("rerun") }]);
    });
    const raced = await push([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }]);
    expect(raced.report).toContain(`ng refs/heads/main ${CHECKS_CHANGED}`);
    const retried = await push([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }]);
    expect(retried.report).toContain('required status check "test" is pending');
  });

  it("refuses only the update whose checks moved in a push of several refs", async () => {
    await requireChecks();
    await status(fx.c3, "success");
    await betweenCheckAndCommit((r) => {
      postIn(r, "pending");
    });
    const pushed = await push([
      { old: fx.c2, new: fx.c3, ref: "refs/heads/main" },
      { old: ZERO, new: fx.c3, ref: "refs/heads/side" },
    ]);
    expect(pushed.report).toContain(`ng refs/heads/main ${CHECKS_CHANGED}`);
    expect(pushed.report).toContain("ok refs/heads/side\n");
  });

  it("ignores a publisher the requirement does not count", async () => {
    const ci = await user();
    await api("PUT", `${path}/collaborators/${ci.handle}`, owner.token, { permission: "push" });
    await requireChecks({
      required_status_checks: [{ context: "ci/build", integration_id: ci.principalId }],
    });
    await status(fx.c3, "success", "ci/build", ci);
    await betweenCheckAndCommit((r) => {
      postIn(r, "failure");
    });
    expect((await push([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }])).report).toContain(
      "ok refs/heads/main\n",
    );
  });

  it("never refuses for an evaluate ruleset, which records what it would have refused", async () => {
    await requireChecks({}, { enforcement: "evaluate" });
    await betweenCheckAndCommit((r) => {
      postIn(r, "failure");
    });
    expect((await push([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }])).report).toContain(
      "ok refs/heads/main\n",
    );
    const suites = await json<{ rule_suites: { result: string; rule_evaluations: unknown[] }[] }>(
      api("GET", `${path}/rulesets/rule-suites`, owner.token),
    );
    expect(JSON.stringify(suites.body)).toContain("required_status_checks");
  });
});

describe("a merge", () => {
  type Merged = { sha?: string; code?: string; detail?: string; message?: string };
  let head: string;
  const merge = (method = "merge") =>
    json<Merged>(api("PUT", `${path}/pulls/1/merge`, owner.token, { merge_method: method }));

  beforeEach(async () => {
    // A feature branch from main's c2, so main moving to c3 leaves it behind.
    expect((await push([{ old: ZERO, new: fx.c2, ref: "refs/heads/feature" }])).report).toContain(
      "ok refs/heads/feature\n",
    );
    const made = await json<{ commit: { sha: string } }>(
      api("POST", `${path}/file-commits`, owner.token, {
        branch: "feature",
        message: "change",
        changes: [{ path: "new.txt", content: "new\n" }],
      }),
    );
    expect(made.status).toBe(201);
    head = made.body.commit.sha;
    const pull = await api("POST", `${path}/pulls`, owner.token, {
      title: "Change",
      head: "feature",
      base: "main",
    });
    expect(pull.status).toBe(201);
  });

  it("is refused while the head's required check is missing, and allowed once it passed", async () => {
    await requireChecks();
    const refused = await merge();
    expect(refused).toMatchObject({ status: 405, body: { code: "merge_refused" } });
    expect(JSON.stringify(refused.body)).toContain(
      'required status check \\"ci/build\\" is expected',
    );
    await status(head, "success");
    expect(await merge()).toMatchObject({ status: 200 });
  });

  it("judges the head, not the merge commit it makes, and asks it up to date when strict", async () => {
    await requireChecks();
    await status(head, "success");
    // main moves past the pull request's base.
    const moved = await push([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }]);
    expect(moved.report).toContain(
      'ng refs/heads/main required status check "ci/build" is expected',
    );
    await status(fx.c3, "success");
    expect((await push([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }])).report).toContain(
      "ok refs/heads/main\n",
    );
    const stale = await merge();
    expect(stale).toMatchObject({ status: 405, body: { code: "merge_refused" } });
    expect(JSON.stringify(stale.body)).toContain("must include the latest commit");
  });

  it("refuses a stale rebase merge before its replay starts, with require_up_to_date beside it", async () => {
    const made = await ruleset([
      {
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "ci/build" }] },
      },
      { type: "require_up_to_date" },
    ]);
    expect(made.status).toBe(201);
    await status(head, "success");
    await status(fx.c3, "success");
    expect((await push([{ old: fx.c2, new: fx.c3, ref: "refs/heads/main" }])).report).toContain(
      "ok refs/heads/main\n",
    );
    const refused = await merge("rebase");
    expect(refused).toMatchObject({ status: 405, body: { code: "merge_refused" } });
    expect(JSON.stringify(refused.body)).toContain("must include the latest commit");
    const sagas = await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql.exec("SELECT count(*) AS n FROM merge_sagas").one(),
    );
    expect(sagas).toEqual({ n: 0 });
  });

  it("refuses a rebase merge before its replay starts", async () => {
    await requireChecks();
    const refused = await merge("rebase");
    expect(refused).toMatchObject({ status: 405, body: { code: "merge_refused" } });
    const sagas = await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql.exec("SELECT count(*) AS n FROM merge_sagas").one(),
    );
    expect(sagas).toEqual({ n: 0 });
  });
});

describe("a pull request's required checks", () => {
  type Required = {
    head_sha: string;
    strict: boolean;
    blocking: boolean;
    checks: {
      context: string;
      integration_id: string | null;
      state: string;
      rulesets: string[];
      deciding: { kind: string; source: string; state: string; details_url: string | null }[];
    }[];
  };
  let head: string;
  const read = () => json<Required>(api("GET", `${path}/pulls/1/required-checks`, owner.token));

  beforeEach(async () => {
    const made = await json<{ commit: { sha: string } }>(
      api("POST", `${path}/file-commits`, owner.token, {
        branch: "topic",
        message: "change",
        changes: [{ path: "new.txt", content: "new\n" }],
      }),
    );
    head = made.body.commit.sha;
    expect(
      (await api("POST", `${path}/pulls`, owner.token, { title: "T", head: "topic", base: "main" }))
        .status,
    ).toBe(201);
  });

  it("is empty and not blocking when no rule requires any", async () => {
    expect(await read()).toMatchObject({
      status: 200,
      body: { head_sha: head, strict: false, blocking: false, checks: [] },
    });
  });

  it("judges each required check on the head, naming what decided it", async () => {
    const made = await requireChecks({
      required_status_checks: [
        { context: "ci/build" },
        { context: "test", integration_id: FYRDEN_CI_SOURCE },
        { context: "docs" },
      ],
    });
    const posted = await stub().createStatus(
      head,
      {
        state: "success",
        context: "CI/Build",
        description: null,
        targetUrl: "https://ci.example/1",
      },
      actor(owner),
    );
    expect(posted).toMatchObject({ ok: true });
    await ciCheck(head, "test", null);
    expect(await read()).toEqual({
      status: 200,
      body: {
        head_sha: head,
        strict: true,
        blocking: true,
        checks: [
          {
            context: "ci/build",
            integration_id: null,
            state: "passed",
            rulesets: [made.name],
            deciding: [
              {
                kind: "status",
                source: owner.principalId,
                state: "passed",
                details_url: "https://ci.example/1",
              },
            ],
          },
          {
            context: "test",
            integration_id: "ci",
            state: "pending",
            rulesets: [made.name],
            deciding: [{ kind: "check", source: "ci", state: "pending", details_url: null }],
          },
          {
            context: "docs",
            integration_id: null,
            state: "expected",
            rulesets: [made.name],
            deciding: [],
          },
        ],
      },
    });
  });

  it("answers 404 for a pull request the repository does not have", async () => {
    expect(await json(api("GET", `${path}/pulls/9/required-checks`, owner.token))).toMatchObject({
      status: 404,
      body: { code: "pull_not_found" },
    });
  });
});
