// Finding the CODEOWNERS file one tree at a time: three trees near the
// largest read (the root, `.github/`, `docs/`) are each held only while
// read, so the file under `docs/` is found, and its absence answered, with
// an object's whole memory pool and nothing else holding it.
import { createDoMemoryBudget } from "@fyrden/adapters-cloudflare/git";
import { MAX_CODEOWNERS_BYTES } from "@fyrden/domain";
import { encodeTree, type Oid, oidFromHex, oidToHex, type TreeEntry } from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import type { RepoBrowse } from "../src/do/repo/browse.js";
import { locateCodeOwners } from "../src/do/repo/code-owners.js";
import { CODEOWNERS_ERRORS_POLICY, codeOwnersErrors } from "../src/do/repo/code-owners-errors.js";

const encoder = new TextEncoder();
let next = 1;
const freshOid = (): Oid => oidFromHex((next++).toString(16).padStart(40, "0"));

/** A tree of about `bytes`, with `named` entries besides its filler. */
function tree(bytes: number, named: TreeEntry[]): Uint8Array {
  const entries = [...named];
  // An entry of a five-character name: `100644 fNNNNN\0` and 20 bytes of id, 34 bytes.
  for (let i = 0; entries.length * 34 < bytes - 34; i++)
    entries.push({
      mode: 0o100644,
      name: encoder.encode(`f${String(i).padStart(5, "0")}`),
      oid: freshOid(),
    });
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  return encodeTree(entries);
}

function reader(objects: Map<string, { type: "tree" | "blob"; bytes: Uint8Array }>) {
  return {
    readHeader: async (oid: Uint8Array) => {
      const object = objects.get(oidToHex(oid as Oid));
      return object && { type: object.type, size: object.bytes.length };
    },
    readObject: async (oid: Uint8Array) => objects.get(oidToHex(oid as Oid)),
  };
}

const MIB = 1024 * 1024;

describe("locating CODEOWNERS", () => {
  for (const present of [true, false])
    it(`${present ? "finds the file under docs/" : "answers none"} past three near-largest trees, with the pool otherwise idle`, async () => {
      const objects = new Map<string, { type: "tree" | "blob"; bytes: Uint8Array }>();
      const put = (type: "tree" | "blob", bytes: Uint8Array): Oid => {
        const oid = freshOid();
        objects.set(oidToHex(oid), { type, bytes });
        return oid;
      };
      const file = put("blob", encoder.encode("* @someone\n"));
      const docs = put(
        "tree",
        tree(
          MIB - 1024,
          present ? [{ mode: 0o100644, name: encoder.encode("CODEOWNERS"), oid: file }] : [],
        ),
      );
      const github = put("tree", tree(MIB - 1024, []));
      const root = put(
        "tree",
        tree(MIB - 1024, [
          { mode: 0o40000, name: encoder.encode(".github"), oid: github },
          { mode: 0o40000, name: encoder.encode("docs"), oid: docs },
        ]),
      );
      const located = await locateCodeOwners(reader(objects), createDoMemoryBudget(), root, {
        maxTreeBytes: MIB,
        maxReadBytes: 4 * MIB,
      });
      expect(located && { path: located.path, blob: oidToHex(located.blob) }).toEqual(
        present ? { path: "docs/CODEOWNERS", blob: oidToHex(file) } : null,
      );
    });

  it("parses the largest accepted file found past three near-largest trees, with the pool otherwise idle", async () => {
    const objects = new Map<string, { type: "tree" | "blob"; bytes: Uint8Array }>();
    const put = (type: "tree" | "blob", bytes: Uint8Array): Oid => {
      const oid = freshOid();
      objects.set(oidToHex(oid), { type, bytes });
      return oid;
    };
    // 2,999,999 bytes: invalid lines up to the parser's 1,000 rule lines, comments after.
    const head = Array.from({ length: 1_001 }, (_, i) => `/p${i}/ bad`).join("\n");
    const body = `${head}\n${"#".repeat(MAX_CODEOWNERS_BYTES - 3 - head.length)}\n`;
    const bytes = encoder.encode(body);
    expect(bytes.length).toBe(MAX_CODEOWNERS_BYTES - 1);
    const file = put("blob", bytes);
    const docs = put(
      "tree",
      tree(MIB - 1024, [{ mode: 0o100644, name: encoder.encode("CODEOWNERS"), oid: file }]),
    );
    const github = put("tree", tree(MIB - 1024, []));
    const root = put(
      "tree",
      tree(MIB - 1024, [
        { mode: 0o40000, name: encoder.encode(".github"), oid: github },
        { mode: 0o40000, name: encoder.encode("docs"), oid: docs },
      ]),
    );
    const memory = createDoMemoryBudget();
    // What is held when the body is read: the parse's reservation, taken before it.
    let heldAtBody = 0;
    const plain = reader(objects);
    const watching = {
      ...plain,
      readObject: async (oid: Uint8Array) => {
        if (oidToHex(oid as Oid) === oidToHex(file)) heldAtBody = memory.stats().reservedBytes;
        return plain.readObject(oid);
      },
    };
    const browse = {
      resolveTree: async () => ({ ok: true, value: { commit: freshOid(), tree: root } }),
      reader: async () => watching,
    } as unknown as RepoBrowse;
    const answer = await codeOwnersErrors(browse, memory, undefined, CODEOWNERS_ERRORS_POLICY);
    // The body and its parse were held together while the answer was built, then let go.
    expect(memory.stats().peakBytes).toBeGreaterThanOrEqual(
      bytes.length * (CODEOWNERS_ERRORS_POLICY.fileMemoryPerByte + 1),
    );
    expect(heldAtBody).toBeGreaterThanOrEqual(
      bytes.length * (CODEOWNERS_ERRORS_POLICY.fileMemoryPerByte + 1),
    );
    expect(memory.stats().reservedBytes).toBe(0);
    expect(answer.ok && answer.value.errors.length).toBe(1_001);
    expect(answer.ok && answer.value.errors.at(-1)?.kind).toBe("Too many rules");
    expect(answer.ok && answer.value.errors[0]?.path).toBe("docs/CODEOWNERS");
  });
});
