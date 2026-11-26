import { expect } from "vitest";
import { api, json } from "./api.js";
import type { Fixture } from "./runs.js";
import type { WebhookTest } from "./webhooks.js";

export async function ciFixture(t: WebhookTest): Promise<Fixture> {
  const made = await json<{ commit: { sha: string } }>(
    api("POST", `${t.path}/file-commits`, t.owner.token, {
      branch: "main",
      message: "one",
      changes: [{ path: "a.txt", content: "one\n" }],
    }),
  );
  expect(made.status).toBe(201);
  return { owner: t.owner, repo: t.repo, path: t.path, sha: made.body.commit.sha };
}

export async function checkRunsOf(f: Fixture) {
  const listed = await json<{ check_runs: { name: string; updated_at: number }[] }>(
    api("GET", `${f.path}/commits/${f.sha}/check-runs`, f.owner.token),
  );
  expect(listed.status).toBe(200);
  return listed.body.check_runs;
}
