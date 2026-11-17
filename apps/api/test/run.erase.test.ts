import { env } from "cloudflare:workers";
import { newUlid, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { expect, it } from "vitest";
import { ERASE_R2_CALLS, eraseRepository } from "../src/do/repo/erase.js";
import { inRepo } from "./helpers/repo-git.js";
import { repoWithCommit } from "./helpers/runs.js";

it("bounds run-erasure reads to one slice and resumes through the remaining runs", async () => {
  const f = await repoWithCommit();
  const total = 4 * ERASE_R2_CALLS + 1;
  const result = await inRepo(env.REPO.getByName(f.repo.id), async (repo) => {
    const storage = repo.git.context.storage;
    storage.transactionSync(() => {
      for (let i = 0; i < total; i++)
        storage.sql.exec(
          "INSERT INTO ci_runs (run_id, sha, workflow_path, created_at) VALUES (?, ?, ?, ?)",
          newUlid(),
          f.sha,
          ".github/workflows/ci.yml",
          repo.git.context.now(),
        );
    });
    let read = 0;
    const sql = new Proxy(storage.sql, {
      get(target, prop) {
        if (prop !== "exec") return Reflect.get(target, prop);
        return (query: string, ...bindings: SqlStorageValue[]) => {
          const cursor = target.exec(query, ...bindings);
          const rows = cursor.toArray();
          read += cursor.rowsRead;
          return Object.assign(rows[Symbol.iterator](), {
            toArray: () => rows,
            one: () => rows[0],
          });
        };
      },
    });
    const git = new RepoGitStorage({
      storage: new Proxy(storage, {
        get(target, prop) {
          if (prop === "sql") return sql;
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
      bucket: repo.git.bucket,
      now: repo.git.context.now,
    });
    const erased: string[] = [];
    const runNamespace = {
      getByName: (id: string) => ({ erase: async () => void erased.push(id) }),
    } as unknown as Env["RUN"];
    const countedEnv = new Proxy(env, {
      get(target, prop) {
        return prop === "RUN" ? runNamespace : Reflect.get(target, prop);
      },
    });
    let outcome = await eraseRepository(git, countedEnv, f.repo.id, undefined);
    const first = { outcome, read, erased: erased.length };
    for (let i = 0; i < 5 && outcome === "partial"; i++)
      outcome = await eraseRepository(git, countedEnv, f.repo.id, undefined);
    return {
      first,
      outcome,
      erased: erased.length,
      distinct: new Set(erased).size,
      remaining: storage.sql.exec("SELECT run_id FROM ci_runs").toArray().length,
    };
  });
  expect(result.first.outcome).toBe("partial");
  expect(result.first.erased).toBeGreaterThan(0);
  expect(result.first.erased).toBeLessThanOrEqual(ERASE_R2_CALLS);
  expect(result.first.read).toBeLessThanOrEqual(2 * ERASE_R2_CALLS + 30);
  expect(result).toMatchObject({ outcome: "erased", erased: total, distinct: total, remaining: 0 });
});
