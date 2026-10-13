import { exports } from "cloudflare:workers";
import { AUTHENTICATED, type OperationDef, registry } from "@fyrden/api-contract";
import { permissionDef } from "@fyrden/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { createRepo, type TestRepo } from "./helpers/git-http.js";
import { principalWithToken, scopedToken } from "./helpers/principals.js";

// The executor checks only the scopes of a repository permission; the
// handler must check the repository itself, with the permission the
// operation declares. Every repository operation in the registry is run
// here, so a new one that skips or weakens the check fails this test.

const ORIGIN = "https://fyrden.test";
const UPLOAD_ID = "0".repeat(26);
const SHA = "a".repeat(40);

/**
 * For each repository operation: an input beyond the path, and what the
 * owner gets once authorization has passed (a fake upload id and a source
 * URL refused without a DNS lookup fail after the check, with their own
 * code). A new operation needs an entry.
 */
const CASES: Record<
  string,
  { input: Record<string, unknown>; expected: Outcome; ownRepo?: boolean }
> = {
  "repos.get": { input: {}, expected: { status: 200 } },
  "repos.update": { input: { description: "checked" }, expected: { status: 200 } },
  // Deletes a repository of its own, not the one the other cases use.
  "repos.delete": { input: {}, expected: { status: 200 }, ownRepo: true },
  "uploads.create": {
    input: { size: 32, ref_updates: [{ ref: "refs/heads/main", old: null, new: SHA }] },
    expected: { status: 201 },
  },
  "uploads.get": { input: {}, expected: { status: 404, code: "upload_not_found" } },
  "uploads.complete": { input: {}, expected: { status: 404, code: "upload_not_found" } },
  "uploads.abort": { input: {}, expected: { status: 404, code: "upload_not_found" } },
  "imports.create": {
    input: { url: "https://127.0.0.1/r.git" },
    expected: { status: 422, code: "url_refused" },
  },
  "imports.get": { input: {}, expected: { status: 404, code: "import_not_found" } },
};

type Outcome = { status: number; code?: string };

// Operations on one repository (a list checks each repository it returns).
const repoOps = registry.filter(
  (op) =>
    op.permission !== AUTHENTICATED &&
    permissionDef(op.permission).resource === "repo" &&
    op.path.includes("{repo}"),
);

let owner: { principalId: string; token: string };
let handle: string;
let repo: TestRepo;

beforeAll(async () => {
  owner = await principalWithToken("user", "pat");
  handle = owner.principalId.toLowerCase().replace("_", "-");
  repo = await createRepo(owner.principalId);
});

function call(op: OperationDef, token: string, name = repo.name) {
  const path = op.path
    .replace("{owner}", handle)
    .replace("{repo}", name)
    .replace("{upload_id}", UPLOAD_ID);
  const input = CASES[op.id]?.input ?? {};
  const get = op.method === "GET";
  return exports.default.fetch(`${ORIGIN}/api${path}`, {
    method: op.method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(!get && { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }),
    },
    ...(!get && { body: JSON.stringify(input) }),
  });
}

async function outcome(res: Response): Promise<Outcome> {
  if (res.ok) return { status: res.status };
  return { status: res.status, code: (await res.json<{ code: string }>()).code };
}

describe("repository operations", () => {
  it("have an input here for each of them", () => {
    expect(repoOps.map((op) => op.id).sort()).toEqual(Object.keys(CASES).sort());
  });

  it.each(repoOps.map((op) => [op.id, op] as const))(
    "%s answers a principal without access as if the repository did not exist",
    async (_, op) => {
      const stranger = await principalWithToken("user", "pat");
      expect(await outcome(await call(op, stranger.token))).toEqual({
        status: 404,
        code: "repo_not_found",
      });
    },
  );

  it.each(repoOps.map((op) => [op.id, op] as const))(
    "%s needs no more than the permission it declares",
    async (_, op) => {
      const token = await scopedToken(owner.principalId, [op.permission]);
      const name = CASES[op.id]?.ownRepo ? (await createRepo(owner.principalId)).name : repo.name;
      expect(await outcome(await call(op, token, name))).toEqual(CASES[op.id]?.expected);
    },
  );
});
