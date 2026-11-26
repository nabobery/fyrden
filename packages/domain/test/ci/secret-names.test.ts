import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ciName,
  ciValueBytes,
  MAX_CI_VALUE_BYTES,
  MAX_ORG_SECRETS,
  MAX_ORG_VARIABLES,
  MAX_REPO_SECRETS,
  MAX_REPO_VARIABLES,
} from "../../src/ci/secret-names.js";

describe("ciName", () => {
  it("refuses names GitHub refuses", () => {
    for (const name of [
      "",
      " A",
      "A ",
      "1KEY",
      "9",
      "a-b",
      "A.B",
      "É",
      "A\u0000",
      "GITHUB_TOKEN",
      "github_x",
      "GitHub_",
      "GITHUB_",
    ]) {
      expect(ciName("secret", name), JSON.stringify(name)).toBeUndefined();
      expect(ciName("variable", name), JSON.stringify(name)).toBeUndefined();
    }
  });

  it("accepts the others, uppercased", () => {
    expect(ciName("secret", "_A")).toBe("_A");
    expect(ciName("secret", "a1")).toBe("A1");
    expect(ciName("variable", "my_Var_2")).toBe("MY_VAR_2");
    expect(ciName("secret", "_")).toBe("_");
    expect(ciName("secret", "GITHUB")).toBe("GITHUB");
    expect(ciName("secret", "XGITHUB_A")).toBe("XGITHUB_A");
  });

  it("refuses GITEA_TOKEN, in any case, for secrets only", () => {
    expect(ciName("secret", "GITEA_TOKEN")).toBeUndefined();
    expect(ciName("secret", "gitea_token")).toBeUndefined();
    expect(ciName("variable", "gitea_token")).toBe("GITEA_TOKEN");
    expect(ciName("secret", "GITEA_TOKEN_2")).toBe("GITEA_TOKEN_2");
  });

  it("answers a name it accepts as itself, uppercased, and only names of the allowed shape", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 12 }),
        fc.constantFrom("secret", "variable"),
        (n, kind) => {
          const stored = ciName(kind as "secret" | "variable", n);
          if (stored === undefined) return;
          expect(stored).toBe(n.toUpperCase());
          expect(stored).toMatch(/^[A-Z_][A-Z0-9_]*$/);
          expect(stored.startsWith("GITHUB_")).toBe(false);
          expect(ciName(kind as "secret" | "variable", stored)).toBe(stored);
        },
      ),
    );
  });
});

describe("limits", () => {
  it("are GitHub's: 48 KiB a value, 1,000 an organization, 100 secrets and 500 variables a repository", () => {
    expect(MAX_CI_VALUE_BYTES).toBe(49_152);
    expect(MAX_ORG_SECRETS).toBe(1_000);
    expect(MAX_REPO_SECRETS).toBe(100);
    expect(MAX_ORG_VARIABLES).toBe(1_000);
    expect(MAX_REPO_VARIABLES).toBe(500);
  });

  it("measure a value in UTF-8 bytes", () => {
    expect(ciValueBytes("")).toBe(0);
    expect(ciValueBytes("abc")).toBe(3);
    expect(ciValueBytes("é")).toBe(2);
    expect(ciValueBytes("﻿a")).toBe(4);
    expect(ciValueBytes("😀")).toBe(4);
  });
});
