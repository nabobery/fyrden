import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitVersion } from "../../testing/git-cli.js";
import { exhaustivePairs, NAMED_CASES, seededPairs } from "./align-cases.js";
import { type Changed, diffChanged, pooled, removeDir, tempDir } from "./align-oracle.js";

/*
 * Writes `vectors/` from the pinned oracle. It runs only when asked:
 *
 *   FYRDEN_BLAME_VECTORS=write FYRDEN_GIT_BINARY=<git 2.53.0> \
 *     npx vitest run test/blame/align-vectors.generate.test.ts
 */

const HERE = join(import.meta.dirname, "vectors");

const hunkLine = (changed: Changed) => `${changed.old.join(",")}|${changed.new.join(",")}`;

describe.skipIf(process.env.FYRDEN_BLAME_VECTORS !== "write")(
  "writing the alignment vectors",
  () => {
    it("from git 2.53.0", async () => {
      expect(await gitVersion()).toBe("2.53.0");
      const dir = await tempDir();
      try {
        const named = await pooled(NAMED_CASES, 6, async (c, k) => {
          const changed = await diffChanged(dir, `n${k}`, c.old, c.new);
          if (c.recorded) expect(changed.new, c.id).toEqual(c.recorded);
          return { id: c.id, old: changed.old, new: changed.new };
        });
        writeFileSync(
          join(HERE, "named.jsonl"),
          `${named.map((v) => JSON.stringify(v)).join("\n")}\n`,
        );

        const seeded = await pooled(seededPairs(20261107, 2000), 6, async (c, k) => {
          const changed = await diffChanged(dir, `s${k}`, c.old, c.new);
          return { id: c.id, old: changed.old, new: changed.new };
        });
        writeFileSync(
          join(HERE, "seeded.jsonl"),
          `${seeded.map((v) => JSON.stringify(v)).join("\n")}\n`,
        );

        const pairs = [...exhaustivePairs()];
        const hash = createHash("sha256");
        const expected = await pooled(pairs, 6, async ([old, new_], k) =>
          hunkLine(await diffChanged(dir, `e${k % 6}-${k}`, old, new_)),
        );
        for (const line of expected) hash.update(`${line}\n`);
        writeFileSync(
          join(HERE, "exhaustive.json"),
          `{ "pairs": ${pairs.length}, "sha256": "${hash.digest("hex")}" }\n`,
        );
      } finally {
        await removeDir(dir);
      }
    }, 600_000);
  },
);
