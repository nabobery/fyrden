// Form posts are read only up to a bound, counted as the bytes arrive (a
// body may say any Content-Length, or none); the file editor takes the
// session first and refuses content past the API's limit before encoding it.

import { describe, expect, it } from "vitest";
import { readForm } from "../app/lib/api.server.js";
import { action as indexAction } from "../app/routes/_index.js";
import { action } from "../app/routes/repo.edit.js";
import { action as issueAction } from "../app/routes/repo.issue.js";
import { action as issuesAction } from "../app/routes/repo.issues.js";
import { action as pullConflictsAction } from "../app/routes/repo.pull.conflicts.js";
import { action as pullFilesAction } from "../app/routes/repo.pull.files.js";
import { action as pullAction } from "../app/routes/repo.pull.js";
import { action as pullsAction } from "../app/routes/repo.pulls.js";
import { action as settingsAction } from "../app/routes/repo.settings.js";
import { action as agentsAction } from "../app/routes/settings.agents.js";
import { action as tokensAction } from "../app/routes/settings.tokens.js";
import { fakeApi, formPost, json, ORIGIN } from "./helpers/context.js";

const streamed = (bytes: number) =>
  new Request(`${ORIGIN}/x`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new ReadableStream({
      start(controller) {
        for (let sent = 0; sent < bytes; sent += 1024)
          controller.enqueue(new Uint8Array(1024).fill(97));
        controller.close();
      },
    }),
    // @ts-expect-error Node needs it for a streamed body.
    duplex: "half",
  });

const status = (error: unknown) => (error as { init?: { status?: number } }).init?.status;

describe("a form post", () => {
  it("is read when it is within its bound", async () => {
    const form = await readForm(formPost("/x", { a: "1", b: "two" }));
    expect(form.get("b")).toBe("two");
  });

  it("is refused past its bound, whatever its length says", async () => {
    const said = new Request(`${ORIGIN}/x`, {
      method: "POST",
      headers: {
        "Content-Length": String(1 << 20),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "a=1",
    });
    expect(status(await readForm(said, 1024).catch((e: unknown) => e))).toBe(413);
    expect(status(await readForm(streamed(64 * 1024), 1024).catch((e: unknown) => e))).toBe(413);
  });
});

describe("the file editor", () => {
  it("takes the session before reading the form", async () => {
    const { context, calls } = fakeApi(() => json(null, 401));
    const outcome = await action({
      request: formPost("/ada/demo/edit/main/a.txt", { content: "x" }),
      context,
      params: { owner: "ada", repo: "demo", ref: "main", "*": "a.txt" },
    } as never).catch((e: unknown) => e);
    expect((outcome as Response).status).toBe(302);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/auth/session"]);
  });

  it("refuses content past the API's limit without sending it", async () => {
    const { context, calls } = fakeApi(() => json({ user: { id: "usr_1", handle: "ada" } }));
    const outcome = await action({
      request: formPost("/ada/demo/edit/main/a.txt", { content: "x".repeat(4 * 1024 * 1024 + 1) }),
      context,
      params: { owner: "ada", repo: "demo", ref: "main", "*": "a.txt" },
    } as never);
    expect(outcome).toEqual({ error: "The file is larger than 4 MiB; push it with git instead." });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/auth/session"]);
  });
});

describe("every form action", () => {
  it("refuses a post from another origin before it reads the form or calls the API", async () => {
    const actions = [
      ["_index", indexAction],
      ["repo.edit", action],
      ["repo.issue", issueAction],
      ["repo.issues", issuesAction],
      ["repo.pull", pullAction],
      ["repo.pull.conflicts", pullConflictsAction],
      ["repo.pull.files", pullFilesAction],
      ["repo.pulls", pullsAction],
      ["repo.settings", settingsAction],
      ["settings.agents", agentsAction],
      ["settings.tokens", tokensAction],
    ] as const;
    for (const [name, act] of actions) {
      const { context, calls } = fakeApi(() => json({}));
      const request = new Request(`${ORIGIN}/x`, {
        method: "POST",
        headers: { Origin: "https://evil.example", Cookie: "fyrden_session=s" },
        body: new URLSearchParams({ intent: "delete", confirm: "demo" }),
      });
      const outcome = await (act as (args: never) => Promise<unknown>)({
        request,
        context,
        params: { owner: "ada", repo: "demo", ref: "main", "*": "a.txt", number: "1" },
      } as never).catch((e: unknown) => e);
      expect(status(outcome), name).toBe(403);
      expect(calls, name).toEqual([]);
      expect(request.bodyUsed, name).toBe(false);
    }
  });
});
