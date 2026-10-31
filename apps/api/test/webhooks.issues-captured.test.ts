// Issue, label and milestone webhooks made from their events' captures:
// each body is the entity as the API shows it, as of the event (a later
// change shows nowhere, however late the body is made), what the change
// touched in full, users with their logins, times as ISO 8601, and long
// text exactly.
import { Sha1 } from "@fyrden/git-core";
import { describe, expect, it, vi } from "vitest";
import { api } from "./helpers/api.js";
import { webhookTest } from "./helpers/webhooks.js";

const t = webhookTest();

type Body = Record<string, unknown>;

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

/** Fails with the answer when a call does not succeed. */
async function ok(res: Promise<Response>): Promise<void> {
  const answer = await res;
  if (answer.status >= 300) throw new Error(`${answer.status}: ${await answer.text()}`);
}

describe("issue webhooks made from captures", () => {
  it("show the issue as the API does, as of each event, what each change touched in full", async () => {
    await t.createHook({ events: ["issues"] });
    const at = t.path;
    const me = { id: t.owner.principalId, login: t.owner.handle };
    await ok(api("POST", `${at}/labels`, t.owner.token, { name: "triage", color: "d73a4a" }));
    await ok(api("POST", `${at}/milestones`, t.owner.token, { title: "v1" }));
    const long = `${"Steps:\n".repeat(400)}"quoted" \\ \u2028`;
    await ok(api("POST", `${at}/issues`, t.owner.token, { title: "Broken", body: long }));
    await ok(
      api("PATCH", `${at}/issues/1`, t.owner.token, { title: "Broken badly", body: "Short." }),
    );
    await ok(api("POST", `${at}/issues/1/labels`, t.owner.token, { labels: ["triage"] }));
    await ok(
      api("POST", `${at}/issues/1/assignees`, t.owner.token, { assignees: [t.owner.handle] }),
    );
    await ok(api("PATCH", `${at}/issues/1`, t.owner.token, { milestone: 1 }));
    await ok(api("PATCH", `${at}/issues/1`, t.owner.token, { milestone: null }));
    await ok(api("PATCH", `${at}/issues/1`, t.owner.token, { state: "closed" }));
    await ok(api("DELETE", `${at}/issues/1`, t.owner.token));
    // Changed after every event above, before any body is made: no body shows it.
    await ok(api("PATCH", `${at}/labels/triage`, t.owner.token, { new_name: "renamed" }));

    const [opened, edited, labeled, assigned, milestoned, demilestoned, closed, deleted] =
      await t.bodies(await t.routed());

    expect(opened).toMatchObject({
      fyrden_payload: 1,
      event: "issues",
      action: "opened",
      issue: {
        number: 1,
        title: "Broken",
        body: long,
        state: "open",
        user: me,
        labels: [],
        assignee: null,
        assignees: [],
        milestone: null,
        reactions: { total_count: 0 },
        closed_by: null,
      },
      repository: { id: t.repo.id, name: t.repo.name, owner: me, private: true },
      sender: { ...me, act_chain: [] },
      at: expect.stringMatching(ISO),
      position: { epoch: expect.any(Number), sequence: expect.any(Number) },
    });
    expect((opened?.issue as Body | undefined)?.created_at).toMatch(ISO);
    expect(edited).toMatchObject({
      issue: { title: "Broken badly", body: "Short." },
      changes: { title: { from: "Broken" }, body: { from: long } },
    });
    const triage = { name: "triage", color: "d73a4a", description: null, default: false };
    expect(labeled).toMatchObject({ label: triage, issue: { labels: [triage] } });
    expect(assigned).toMatchObject({
      assignee: me,
      issue: { assignee: me, assignees: [me], labels: [triage] },
    });
    const v1 = { number: 1, title: "v1", state: "open", creator: me, open_issues: 1 };
    expect(milestoned).toMatchObject({ milestone: v1, issue: { milestone: v1 } });
    // The milestone it left, though the issue has none now.
    expect(demilestoned).toMatchObject({
      milestone: { number: 1, title: "v1", open_issues: 0 },
      issue: { milestone: null },
    });
    expect(closed).toMatchObject({
      issue: { state: "closed", state_reason: "completed", closed_by: me },
    });
    expect((closed?.issue as Body | undefined)?.closed_at).toMatch(ISO);
    // Deleted: the issue as it was, with what it carried.
    expect(deleted).toMatchObject({
      action: "deleted",
      issue: { number: 1, title: "Broken badly", labels: [triage], assignees: [me] },
    });
  });

  it("tell of labels and milestones in full, as they were, times as ISO 8601", async () => {
    await t.createHook({ events: ["label", "milestone"] });
    const at = t.path;
    const me = { id: t.owner.principalId, login: t.owner.handle };
    await ok(
      api("POST", `${at}/labels`, t.owner.token, {
        name: "triage",
        color: "d73a4a",
        description: "Something is wrong",
      }),
    );
    await ok(api("PATCH", `${at}/labels/triage`, t.owner.token, { new_name: "defect" }));
    await ok(api("DELETE", `${at}/labels/defect`, t.owner.token));
    const due = Date.UTC(2027, 0, 31);
    await ok(api("POST", `${at}/milestones`, t.owner.token, { title: "v1", due_on: due }));
    await ok(api("PATCH", `${at}/milestones/1`, t.owner.token, { due_on: due + 86_400_000 }));
    await ok(api("PATCH", `${at}/milestones/1`, t.owner.token, { state: "closed" }));
    await ok(api("DELETE", `${at}/milestones/1`, t.owner.token));

    const [created, renamed, deleted, made, edited, closed, gone] = await t.bodies(
      await t.routed(),
    );
    const label = { name: "triage", color: "d73a4a", description: "Something is wrong" };
    expect(created).toMatchObject({ event: "label", action: "created", label });
    expect(renamed).toMatchObject({
      label: { ...label, name: "defect" },
      changes: { name: { from: "triage" } },
    });
    expect(deleted).toMatchObject({ action: "deleted", label: { ...label, name: "defect" } });
    expect(made).toMatchObject({
      event: "milestone",
      action: "created",
      milestone: { number: 1, title: "v1", due_on: new Date(due).toISOString(), creator: me },
    });
    expect(edited).toMatchObject({
      milestone: { due_on: new Date(due + 86_400_000).toISOString() },
      changes: { due_on: { from: new Date(due).toISOString() } },
    });
    expect(closed).toMatchObject({ action: "closed", milestone: { state: "closed" } });
    expect((closed?.milestone as Body | undefined)?.closed_at).toMatch(ISO);
    expect(gone).toMatchObject({
      action: "deleted",
      milestone: { number: 1, title: "v1", state: "closed", creator: me },
    });
  });

  it("hash a long text once per change, however many of its events name it, and no longer", async () => {
    await t.createHook({ events: ["issues"] });
    const at = t.path;
    for (const name of ["a", "b", "c"])
      await ok(api("POST", `${at}/labels`, t.owner.token, { name, color: "ffffff" }));
    const body = "long ".repeat(400);
    await ok(api("POST", `${at}/issues`, t.owner.token, { title: "Hashed", body }));
    const bodyBytes = new TextEncoder().encode(JSON.stringify(body)).length;
    const update = vi.spyOn(Sha1.prototype, "update");
    const hashedNow = () => {
      const sum = update.mock.calls.reduce((n, [bytes]) => n + bytes.length, 0);
      update.mockClear();
      return sum;
    };
    try {
      // Two labels in one change: two events, the body hashed once.
      await ok(api("POST", `${at}/issues/1/labels`, t.owner.token, { labels: ["a", "b"] }));
      expect(hashedNow()).toBe(bodyBytes);
      // The next change hashes it again: nothing is kept past a change.
      await ok(api("POST", `${at}/issues/1/labels`, t.owner.token, { labels: ["c"] }));
      expect(hashedNow()).toBe(bodyBytes);
    } finally {
      update.mockRestore();
    }
  });

  it("are captured only for events a hook takes", async () => {
    await t.createHook({ events: ["label"] });
    await ok(api("POST", `${t.path}/issues`, t.owner.token, { title: "Unwatched" }));
    await ok(api("POST", `${t.path}/labels`, t.owner.token, { name: "x", color: "ffffff" }));
    const events = (await t.outbox()).filter((e) => e.type !== "webhook.ping");
    const opened = events.find((e) => e.type === "issue.opened");
    // Not the repository's default labels, made before the hook.
    const created = events.findLast((e) => e.type === "label.created");
    expect(opened?.webhooks).toBeUndefined();
    expect(opened?.data?.webhook).toBeUndefined();
    expect(created?.data?.webhook).toMatchObject({ v: 1 });
  });
});
