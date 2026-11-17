import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newUlid } from "@fyrden/adapters-cloudflare/git";
import { applyDoMigrations, dumpSchema } from "@fyrden/adapters-cloudflare/migrations";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { concurrencySchema } from "../src/do/schema/concurrency.js";
import v0 from "./fixtures/do-schemas/ConcurrencyDO/v0.sql?raw";
import v1 from "./fixtures/do-schemas/ConcurrencyDO/v1.sql?raw";

const versions: Record<number, string> = { 0: v0, 1: v1 };

describe("ConcurrencyDO schema", () => {
  it("preserves an active grant across coordinator eviction", async () => {
    const stub = env.CONCURRENCY.getByName(uniqueId("concurrency"));
    const first = {
      group: "deploy",
      runId: newUlid(),
      ownerKey: "a1",
      cancelInProgress: false,
      holdMs: 60_000,
    };
    const receipt = (await stub.acquire([first]))[0];
    expect(receipt?.outcome).toBe("owner");
    await evictDurableObject(stub);
    const next = (await stub.acquire([{ ...first, runId: newUlid() }]))[0];
    expect(next?.outcome).toBe("pending");
    expect((await stub.status([first]))[0]).toMatchObject({
      outcome: "owner",
      generation: receipt?.generation,
    });
  });

  it("matches the committed expected schema", async () => {
    const stub = env.CONCURRENCY.getByName(uniqueId("concurrency"));
    const schema = await runInDurableObject(stub, (_, state) => dumpSchema(state.storage));
    await expect(schema).toMatchFileSnapshot("./fixtures/do-schemas/ConcurrencyDO/expected.sql");
  });

  it("has a frozen fixture of the latest version", () => {
    expect(Math.max(...Object.keys(versions).map(Number))).toBe(concurrencySchema.length);
  });

  for (const [version, sql] of Object.entries(versions)) {
    it(`migrates from v${version} to the latest schema`, async () => {
      const stub = env.CONCURRENCY.getByName(uniqueId("concurrency"));
      const [fromFixture, fresh] = await runInDurableObject(stub, async (_, state) => {
        const fresh = dumpSchema(state.storage);
        await state.storage.deleteAll();
        if (sql.trim()) state.storage.sql.exec(sql);
        state.storage.sql.exec(
          "CREATE TABLE _fyrden_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
        );
        state.storage.sql.exec("INSERT INTO _fyrden_schema_version VALUES (1, ?)", Number(version));
        applyDoMigrations(state.storage, concurrencySchema);
        return [dumpSchema(state.storage), fresh];
      });
      expect(fromFixture).toBe(fresh);
    });
  }

  it("preserves its deletion fence across eviction and delayed calls", async () => {
    const stub = env.CONCURRENCY.getByName(uniqueId("concurrency"));
    const request = {
      group: "deploy",
      runId: newUlid(),
      ownerKey: "a1",
      cancelInProgress: false,
      holdMs: 60_000,
    };
    expect((await stub.acquire([request]))[0]?.outcome).toBe("owner");
    await stub.erase();
    await stub.erase();
    await evictDurableObject(stub);
    const errors = await runInDurableObject(stub, async (coordinator) => {
      const errors: string[] = [];
      for (const call of [
        () => coordinator.acquire([request]),
        () => coordinator.status([request]),
        () => coordinator.renew(request.runId, [{ ...request, generation: 1 }]),
        () => coordinator.release([request]),
      ]) {
        try {
          await call();
          errors.push("accepted");
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return errors;
    });
    expect(errors).toHaveLength(4);
    expect(errors.every((error) => error.startsWith("repo_not_found:"))).toBe(true);
    await runInDurableObject(stub, async (coordinator, state) => {
      await coordinator.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
      for (const table of [
        "concurrency_groups",
        "concurrency_receipts",
        "concurrency_signals",
        "concurrency_leases",
        "jobs",
      ])
        expect(state.storage.sql.exec(`SELECT * FROM ${table}`).toArray()).toEqual([]);
    });
  });
});
