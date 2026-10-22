// Issue, label and milestone webhooks, and the pull request metadata
// actions: GitHub's event names and actions, and the bodies made from what
// an event without a capture recorded when the change was made (a later
// change shows nowhere): what events recorded before captures still get.
import type { DomainEvent } from "@fyrden/domain";
import { describe, expect, it } from "vitest";
import { bodyOf } from "../src/webhooks/sink.js";
import { api } from "./helpers/api.js";
import { webhookTest } from "./helpers/webhooks.js";

const t = webhookTest();

type Body = Record<string, unknown>;

/** The webhook bodies of the outbox's events (pings aside), in order, and their events. */
async function made() {
  const events = (await t.outbox()).filter(
    (e) => e.webhooks && e.type !== "webhook.ping",
  ) as DomainEvent[];
  return events.map((e) => ({ event: e, body: bodyOf(e) as Body }));
}

/** Fails with the answer when a call does not succeed. */
async function ok(res: Promise<Response>): Promise<void> {
  const answer = await res;
  if (answer.status >= 300) throw new Error(`${answer.status}: ${await answer.text()}`);
}

const names = (bodies: { body: Body }[]) =>
  bodies.map(({ body }) => `${body.event}.${body.action}`);

describe("issue webhooks", () => {
  it("tell of an issue's life with GitHub's actions, each as the change left it", async () => {
    await t.createHook({ events: ["issues"] });
    const at = t.path;
    await ok(api("POST", `${at}/labels`, t.owner.token, { name: "triage", color: "d73a4a" }));
    await ok(api("POST", `${at}/milestones`, t.owner.token, { title: "v1" }));
    await ok(api("POST", `${at}/issues`, t.owner.token, { title: "Broken", body: "It fails." }));
    await ok(api("PATCH", `${at}/issues/1`, t.owner.token, { title: "Broken badly" }));
    await ok(api("POST", `${at}/issues/1/labels`, t.owner.token, { labels: ["triage"] }));
    await ok(
      api("POST", `${at}/issues/1/assignees`, t.owner.token, { assignees: [t.owner.handle] }),
    );
    await ok(api("PATCH", `${at}/issues/1`, t.owner.token, { milestone: 1 }));
    await ok(api("PATCH", `${at}/issues/1`, t.owner.token, { milestone: null }));
    await ok(api("DELETE", `${at}/issues/1/labels/triage`, t.owner.token));
    await ok(
      api("DELETE", `${at}/issues/1/assignees`, t.owner.token, { assignees: [t.owner.handle] }),
    );
    await ok(api("PUT", `${at}/issues/1/lock`, t.owner.token, { lock_reason: "resolved" }));
    await ok(api("DELETE", `${at}/issues/1/lock`, t.owner.token));
    await ok(api("PATCH", `${at}/issues/1`, t.owner.token, { state: "closed" }));
    await ok(api("PATCH", `${at}/issues/1`, t.owner.token, { state: "open" }));
    await ok(api("DELETE", `${at}/issues/1`, t.owner.token));

    const bodies = await made();
    expect(names(bodies)).toEqual([
      "issues.opened",
      "issues.edited",
      "issues.labeled",
      "issues.assigned",
      "issues.milestoned",
      "issues.demilestoned",
      "issues.unlabeled",
      "issues.unassigned",
      "issues.locked",
      "issues.unlocked",
      "issues.closed",
      "issues.reopened",
      "issues.deleted",
    ]);
    const [opened, edited, labeled, assigned, milestoned, demilestoned, , , locked, , closed] =
      bodies.map((b) => b.body);
    expect(opened).toMatchObject({
      number: 1,
      repository: { id: t.repo.id },
      sender: { id: t.owner.principalId },
      issue: {
        number: 1,
        title: "Broken",
        body: "It fails.",
        state: "open",
        locked: false,
        labels: [],
        assignees: [],
        milestone: null,
        user: { id: t.owner.principalId },
      },
    });
    expect(((opened as Body).issue as { created_at?: string }).created_at).toMatch(
      /^\d{4}-\d\d-\d\dT/,
    );
    expect(edited).toMatchObject({
      issue: { title: "Broken badly" },
      changes: { title: { from: "Broken" } },
    });
    // The label added, and the issue holding it.
    expect(labeled).toMatchObject({ label: { name: "triage", color: "d73a4a" } });
    const label = labeled?.label as { id: number };
    expect(labeled?.issue).toMatchObject({ labels: [{ id: label.id }] });
    expect(assigned).toMatchObject({
      assignee: { id: t.owner.principalId },
      issue: { assignees: [{ id: t.owner.principalId }] },
    });
    expect(milestoned).toMatchObject({
      milestone: { number: 1, title: "v1" },
      issue: { milestone: { number: 1 } },
    });
    // The milestone it left, though the issue has none now.
    expect(demilestoned).toMatchObject({
      milestone: { number: 1, title: "v1" },
      issue: { milestone: null },
    });
    expect(locked).toMatchObject({ issue: { locked: true, active_lock_reason: "resolved" } });
    expect(closed).toMatchObject({ issue: { state: "closed", state_reason: "completed" } });
    // Deleted: what its event recorded.
    expect(bodies.at(-1)?.body).toMatchObject({
      action: "deleted",
      issue: { number: 1, title: "Broken badly" },
    });
  });

  it("tell of labels and milestones, and route each family to the hooks taking it", async () => {
    const labels = (await t.createHook({ events: ["label"] })).body;
    const milestones = (await t.createHook({ events: ["milestone"] })).body;
    const everything = (await t.createHook({ events: ["*"] })).body;
    const at = t.path;
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
    await ok(api("PATCH", `${at}/milestones/1`, t.owner.token, { state: "open" }));
    await ok(api("DELETE", `${at}/milestones/1`, t.owner.token));

    const bodies = await made();
    expect(names(bodies)).toEqual([
      "label.created",
      "label.edited",
      "label.deleted",
      "milestone.created",
      "milestone.edited",
      "milestone.closed",
      "milestone.opened",
      "milestone.deleted",
    ]);
    // Each family to the hooks taking it, `*` taking all.
    for (const { event, body } of bodies) {
      const hooks = (event.webhooks?.hooks ?? []).map((h) => h.id).sort((a, b) => a - b);
      const family = body.event === "label" ? labels.id : milestones.id;
      expect(hooks).toEqual([family, everything.id].sort((a, b) => a - b));
    }
    const [created, renamed, deleted, made_, edited] = bodies.map((b) => b.body);
    expect(created).toMatchObject({
      label: { name: "triage", color: "d73a4a", description: "Something is wrong", default: false },
    });
    expect(renamed).toMatchObject({
      label: { name: "defect" },
      changes: { name: { from: "triage" } },
    });
    expect(deleted).toMatchObject({ label: { name: "defect", color: "d73a4a" } });
    expect(made_).toMatchObject({
      milestone: { number: 1, title: "v1", state: "open", due_on: new Date(due).toISOString() },
    });
    // Times as ISO 8601, as everywhere in deliveries.
    expect(edited).toMatchObject({ changes: { due_on: { from: new Date(due).toISOString() } } });
    expect(bodies.at(-1)?.body).toMatchObject({ milestone: { number: 1, title: "v1" } });
    // A milestone's counts are GitHub's: issues and pull requests together.
    const first = bodies[3]?.event as DomainEvent;
    const counted = {
      ...first,
      entity: {
        ...first.entity,
        row: { ...first.entity?.row, openIssues: 1, openPulls: 2, closedIssues: 3, closedPulls: 4 },
      },
    } as DomainEvent;
    expect(bodyOf(counted)).toMatchObject({ milestone: { open_issues: 3, closed_issues: 7 } });
    // A due date no date can hold (recorded before inputs were bounded) shows as none.
    const beyond = 8_640_000_000_000_001;
    const odd = {
      ...counted,
      entity: { ...counted.entity, row: { ...counted.entity?.row, dueOn: beyond } },
      data: { changes: { due_on: { from: beyond } } },
    } as DomainEvent;
    expect(bodyOf(odd)).toMatchObject({
      milestone: { due_on: null },
      changes: { due_on: { from: null } },
    });
    // And none is taken now.
    expect(
      (await api("POST", `${at}/milestones`, t.owner.token, { title: "far", due_on: beyond }))
        .status,
    ).toBe(422);
  });

  it("let a hook take every event family at once", async () => {
    const all = ["push", "pull_request", "pull_request_review", "pull_request_review_comment"];
    const created = await t.createHook({
      events: [...all, "issue_comment", "issues", "label", "milestone"],
    });
    expect(created.status).toBe(201);
    expect(created.body.events).toHaveLength(8);
  });
});
