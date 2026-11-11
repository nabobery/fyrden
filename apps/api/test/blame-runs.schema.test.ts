// The blame runs table: one row a run, shared by everyone blaming the same
// file at the same commit, pointing at the run's latest checkpoint and
// carrying the attempt mark that survives a slice's death.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";

const row = (overrides: Record<string, unknown> = {}) => ({
  run_id: "01J9ABCDEFGHJKMNPQRSTVWXYZ",
  commit_oid: new Uint8Array(20).fill(1),
  path: "src/a.ts",
  engine_version: 1,
  epoch_gen: 3,
  generation: 0,
  checkpoint_key: null,
  checkpoint_bytes: 0,
  state: "initializing",
  lines: 10,
  settled_ranges: 0,
  unresolved_lines: 0,
  touched_at: 1,
  expires_at: 2,
  ...overrides,
});

/** Inserts each row in a fresh repository object, and answers what each insert did. */
function inserted(rows: Record<string, unknown>[]) {
  return runInDurableObject(env.REPO.getByName(uniqueId("repo")), (_, state) =>
    rows.map((r) => {
      const columns = Object.keys(r);
      try {
        state.storage.sql.exec(
          `INSERT INTO blame_runs (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          ...Object.values(r),
        );
        const [stored] = state.storage.sql
          .exec<{ attempts: number; attempt_generation: number | null }>(
            "SELECT attempts, attempt_generation FROM blame_runs WHERE run_id = ?",
            r.run_id as string,
          )
          .toArray();
        return { ok: true, stored };
      } catch (error) {
        return { ok: false, message: String(error) };
      }
    }),
  );
}

describe("blame_runs", () => {
  it("starts a run with no attempts marked", async () => {
    const [first] = await inserted([row()]);
    expect(first).toEqual({ ok: true, stored: { attempts: 0, attempt_generation: null } });
  });

  it("holds one run for a commit, path, engine version and restore generation", async () => {
    const results = await inserted([
      row(),
      row({ run_id: "01J9ABCDEFGHJKMNPQRSTVWXY0" }),
      row({ run_id: "01J9ABCDEFGHJKMNPQRSTVWXY1", epoch_gen: 4 }),
      row({ run_id: "01J9ABCDEFGHJKMNPQRSTVWXY2", path: "src/b.ts" }),
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, false, true, true]);
    expect(results[1]).toMatchObject({ message: expect.stringContaining("UNIQUE") });
  });

  it("takes the four states a run passes through, and no other", async () => {
    const states = ["initializing", "running", "done", "lost", "other"];
    const results = await inserted(
      states.map((state, k) =>
        row({ state, run_id: `01J9ABCDEFGHJKMNPQRSTVWX${k}0`, path: `p${k}` }),
      ),
    );
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true, false]);
  });
});
