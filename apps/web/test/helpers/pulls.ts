// A pull request as fyrden-api answers it, and fyrden-api faked by path.

import { fakeApi, json } from "./context.js";

export const VIEWER = "usr_viewer";

export function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    state: "open",
    merged: false,
    head_repo_id: null,
    mergeable: true,
    mergeable_state: "clean",
    mergeable_reason: null,
    draft: false,
    maintainer_can_modify: false,
    title: "Add a feature",
    body: "Some **words**",
    user: { id: VIEWER },
    performed_via_agents: [],
    head: { ref: "topic", sha: "b".repeat(40) },
    base: { ref: "main", sha: "a".repeat(40) },
    head_ref_deleted: false,
    created_at: Date.parse("2026-10-01T10:00:00Z"),
    updated_at: Date.parse("2026-10-01T10:00:00Z"),
    closed_at: null,
    merged_at: null,
    merge_commit_sha: null,
    merged_by: null,
    ...overrides,
  };
}

export const repo = {
  owner: "ada",
  name: "demo",
  full_name: "ada/demo",
  default_branch: "main",
  description: null,
};

/** fyrden-api faked by path: `routes` maps "METHOD /api/path" (no query) to a reply. */
export function api(routes: Record<string, () => Response>) {
  return fakeApi((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/auth/session") return json({ user: { id: VIEWER, handle: "ada" } });
    const reply = routes[`${request.method} ${url.pathname}`];
    return reply ? reply() : json({ code: "not_found", detail: "Not found" }, 404);
  });
}

export const pathOf = (call: Request | undefined) => {
  const url = new URL(call?.url ?? "");
  return `${call?.method} ${url.pathname}${url.search}`;
};
