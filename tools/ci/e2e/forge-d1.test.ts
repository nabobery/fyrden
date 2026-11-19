import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { queryDirectory, startForge } from "./forge.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

it("reads and writes the live forge's D1 without starting another runtime", async () => {
  const forge = await startForge("d1", {
    primary: join(import.meta.dirname, "fixtures/run-seam/wrangler.jsonc"),
  });
  try {
    vi.mocked(spawn).mockClear();
    expect(
      (await queryDirectory(forge, "SELECT id FROM principals WHERE id = ?", [forge.admin.id]))
        .results,
    ).toEqual([{ id: forge.admin.id }]);
    const table = `fixture_${randomBytes(8).toString("hex")}`;
    await queryDirectory(forge, `CREATE TABLE ${table} (value TEXT NOT NULL)`);
    const value = "a 'quoted' value; DROP TABLE principals; --";
    expect((await queryDirectory(forge, `INSERT INTO ${table} VALUES (?)`, [value])).changes).toBe(
      1,
    );
    expect((await queryDirectory(forge, `SELECT value FROM ${table}`)).results).toEqual([
      { value },
    ]);
    expect(
      (await queryDirectory(forge, `UPDATE ${table} SET value = ?`, ["updated"])).changes,
    ).toBe(1);
    expect((await queryDirectory(forge, `SELECT value FROM ${table}`)).results).toEqual([
      { value: "updated" },
    ]);
    expect(
      (await queryDirectory(forge, "SELECT id FROM principals WHERE id = ?", [forge.admin.id]))
        .results,
    ).toEqual([{ id: forge.admin.id }]);
    await expect(queryDirectory(forge, `SELECT * FROM missing_${table}`)).rejects.toThrow(
      "run-seam directory query status",
    );
    expect(vi.mocked(spawn).mock.calls.length).toBe(0);
  } finally {
    await forge.stop();
  }
});
